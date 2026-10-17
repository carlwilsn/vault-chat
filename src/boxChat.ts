// [phase 2] Box-mode chat. When a vault's `.vault-chat/sync.json` names a box,
// EVERY agent turn runs on the box: this machine never calls a model for chat.
//
// - Sending → the box's `/message` (the phone's payload plus the conversation
//   id; no id = the box creates the conversation and returns `convId`).
//   Stop → `/kill`. A reply to a conversation waiting on Carl → `/answer`.
// - The list and the messages come from the box (`/conversations`,
//   `/conversation`), kept live through `/poll` (the phone's event ring:
//   `status`, `runtime`, `message`, `title`). They render with the existing
//   ChatPane components — the message format is unchanged.
// - The laptop never writes conversation files in box mode (lib.rs); the git
//   sync still merges the box's files in, and those are the offline history,
//   together with a small localStorage snapshot of what the box served last.
// - Box unreachable → `boxChat.reachable === false`; the composer is disabled
//   with BOX_UNREACHABLE. Notes and editing are untouched.
//
// Never active headless (the server bundles this module and IS the box).
import { invoke } from "@tauri-apps/api/core";
import { projectForSend } from "./projects";
import { useStore, type ChatMessage, type ChatAttachment, type LiveTool } from "./store";
import { Ids, isLocalOnly, isNewerCopy, msgKey, overlayWindow, settles } from "./msgOrder";
import { addPending, patchPending, removePending, type PendingKind } from "./pendingInput";
import { readBoxConfig, boxSyncNow } from "./vaultSync";
import { boxFileChanged } from "./liveReload";
import type { Conversation } from "./conversations";
import { applyStream, type StreamState } from "./streamWire";
import { lastReportedContext } from "./chatContext";

export const BOX_UNREACHABLE = "Box unreachable — agent runs on the box";

export type BoxChatState = {
  on: boolean;
  /** null = not known yet (first contact pending). */
  reachable: boolean | null;
  reason: string;
};

/** `vault`: this vault's name on the box (sync.json); every request carries it, so the box runs it in that vault's own engine. */
export type Link = { url: string; token: string | null; vault?: string | null };
type HttpResult = { status: number; body: string };

const POLL_TIMEOUT_MS = 35_000;
const LIST_REFRESH_MS = 60_000;
const DETAIL_N = 200;
const CACHE_PREFIX = "vault-chat:box-chat-cache:";
const CACHE_MAX_CONVS = 30;
const CACHE_MAX_BYTES = 3_000_000;
/** A reply shown from a live event that the box's copy never settles goes after this, once the turn is over. */
const REPLY_HOLD_MS = 30_000;

function headless(): boolean {
  return !!(globalThis as { __VC_HEADLESS__?: unknown }).__VC_HEADLESS__;
}

function newClientMsgId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `box_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** The box this vault's chat runs on, or null (not box mode / headless). */
export async function boxLinkFor(vault: string | null): Promise<Link | null> {
  if (!vault || headless()) return null;
  const cfg = await readBoxConfig(vault);
  if (!cfg?.box) return null;
  return { url: cfg.box.replace(/\/+$/, ""), token: useStore.getState().boxToken || null, vault: cfg.vault || null };
}

/** `path` scoped to the link's vault (`?vault=`). A box from before vaults ignores it. */
export function vaultPath(link: Link, path: string): string {
  if (!link.vault) return path;
  return `${path}${path.includes("?") ? "&" : "?"}vault=${encodeURIComponent(link.vault)}`;
}

async function httpGet(link: Link, path: string, timeoutMs = 20_000): Promise<any> {
  const r = await invoke<HttpResult>("box_get_json", {
    url: `${link.url}${vaultPath(link, path)}`,
    token: link.token,
    timeoutMs,
  });
  if (r.status < 200 || r.status >= 300) {
    const e = new Error(`HTTP ${r.status}${r.body ? `: ${r.body.slice(0, 200)}` : ""}`);
    (e as Error & { status?: number }).status = r.status;
    throw e;
  }
  return JSON.parse(r.body || "{}");
}

/** A vault file's current bytes on the box (GET /api/v1/vault/file), or null. */
export async function fetchBoxFile(link: Link, rel: string): Promise<Uint8Array | null> {
  const r = await httpGet(link, `/api/v1/vault/file?path=${encodeURIComponent(rel)}`, 10_000);
  if (typeof r?.base64 !== "string") return null;
  const bin = atob(r.base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function httpPost(
  link: Link,
  path: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string; data?: Record<string, unknown>; network?: boolean }> {
  let r: HttpResult;
  try {
    r = await invoke<HttpResult>("box_post_json", {
      url: `${link.url}${vaultPath(link, path)}`,
      body: JSON.stringify(payload),
      token: link.token,
    });
  } catch (e) {
    return { ok: false, network: true, error: String((e as Error)?.message ?? e) };
  }
  let d: Record<string, unknown> = {};
  try {
    d = JSON.parse(r.body) as Record<string, unknown>;
  } catch {
    /* non-JSON body */
  }
  if (r.status < 200 || r.status >= 300 || d.error) {
    return { ok: false, error: String(d.error || `HTTP ${r.status}${r.body ? `: ${r.body.slice(0, 200)}` : ""}`) };
  }
  return { ok: true, data: d };
}

/** A GET to the box (projects, notifications). Throws on failure. */
export function boxGet(link: Link, path: string, timeoutMs = 15_000): Promise<any> {
  return httpGet(link, path, timeoutMs);
}

/** A POST to the box (projects, notifications). Never throws. */
export function boxPost(link: Link, path: string, payload: Record<string, unknown>) {
  return httpPost(link, path, payload);
}

// ---------- the box's shapes → the store's ----------

type BoxRow = {
  id: string;
  title?: string;
  lastActivityAt?: number;
  source?: string;
  msgCount?: number;
  missionState?: string;
  project?: string;
  state?: Conversation["state"];
  nextWakeAt?: number;
  costUsd?: number;
  working?: boolean;
};

// The ongoing-work and project fields a list row carries (server/phoneData.ts).
const ROW_META = ["project", "state", "nextWakeAt", "costUsd", "working"] as const;
function rowMeta(row: BoxRow): Partial<Conversation> {
  const out: Record<string, unknown> = {};
  for (const k of ROW_META) if (row[k] !== undefined && row[k] !== null && row[k] !== "") out[k] = row[k];
  return out as Partial<Conversation>;
}

type BoxDetail = {
  id: string;
  title?: string;
  source?: string;
  status?: string;
  runStartedAt?: number | null;
  /** Set by a server that honours `full=1`: `messages` are the stored
   *  ChatMessage objects (hidden ones included) and `meta` the meta line. */
  full?: boolean;
  meta?: Record<string, unknown>;
  messages?: any[];
};

/** One phone-shaped message (`/conversation` without `full`) → a ChatMessage.
 *  Lossy (tool calls carry names only) — marked `boxPartial` so the git-synced
 *  full copy replaces it as soon as it lands. */
export function fromPhoneMessage(m: any): ChatMessage {
  const out: ChatMessage = {
    role: m?.role === "user" ? "user" : "assistant",
    content: typeof m?.content === "string" ? m.content : "",
    boxPartial: true,
  };
  if (m?.system === true) out.system = true;
  if (Array.isArray(m?.tools) && m.tools.length) {
    out.toolCalls = m.tools
      .filter((t: unknown) => typeof t === "string")
      .map((name: string, i: number) => ({ id: `box-${i}`, name, input: {} }));
  }
  if (m?.timeline) out.timeline = m.timeline;
  if (m?.direct === true) out.direct = true;
  if (m?.decision === true) out.decision = true;
  if (Array.isArray(m?.askOptions) && m.askOptions.length) out.askOptions = m.askOptions;
  return out;
}

const keyOf = msgKey;

/** What a merge found: `stale` = the box's snapshot is older than what is shown
 *  (its newer messages were kept); `unsettled` = replies shown before the box's
 *  copy that it does not have yet. */
export type MergeInfo = { stale?: boolean; unsettled?: number };

/** Merge the box's view of a conversation into the local copy. Nothing shown
 *  disappears (src/msgOrder.ts):
 *  - `full`: the box's window (its last ≤200 messages) over the local copy —
 *    older history stays, and a snapshot older than what is shown keeps the
 *    newer messages.
 *  - phone shape (the last ≤200 visible messages): keep the local full-fidelity
 *    prefix up to the last message both sides share, then the box's newer tail.
 *  Replies shown before the box's copy landed (a live `message` event, a steer)
 *  give their place to that copy, and stay at the end until it lands (or, with
 *  `keepReply` false, are let go). Local notices stay after the message they
 *  followed. Optimistic local user messages the box has not recorded yet are kept. */
export function mergeBoxMessages(
  local: ChatMessage[],
  d: BoxDetail,
  pending: string[] = [],
  info: MergeInfo = {},
  keepReply: (m: ChatMessage) => boolean = () => true,
): ChatMessage[] {
  const boxMsgs = Array.isArray(d.messages) ? d.messages : [];
  let merged: ChatMessage[];
  if (d.full) {
    const o = overlayWindow(local, boxMsgs as ChatMessage[], DETAIL_N);
    merged = o.messages;
    info.stale = o.stale;
  } else {
    const B = boxMsgs.map(fromPhoneMessage);
    const visIdx: number[] = [];
    local.forEach((m, i) => {
      if (!m.hidden && !isLocalOnly(m)) visIdx.push(i);
    });
    const L = visIdx.map((i) => local[i]!);
    const bk = B.map(keyOf);
    const lk = L.map(keyOf);
    const agrees = (i: number, j: number) => {
      for (let t = 0; t < 3; t++) {
        if (i - t < 0 || j - t < 0) return true;
        if (lk[i - t] !== bk[j - t]) return false;
      }
      return true;
    };
    let hit: { i: number; j: number } | null = null;
    outer: for (let i = L.length - 1; i >= 0; i--) {
      for (let j = B.length - 1; j >= 0; j--) {
        if (lk[i] === bk[j] && agrees(i, j)) {
          hit = { i, j };
          break outer;
        }
      }
    }
    if (hit) {
      const keep = local.slice(0, visIdx[hit.i]! + 1).filter((m) => !isLocalOnly(m));
      merged = [...keep, ...B.slice(hit.j + 1)];
    } else if (L.length === 0 || B.length < DETAIL_N) {
      merged = B; // the box's window is the whole visible conversation
    } else {
      merged = [...local.filter((m) => !isLocalOnly(m)), ...B];
    }
  }
  // Replies shown ahead of the box's copy: the copy this snapshot brought takes their place.
  const had = new Ids(local.filter((m) => !isLocalOnly(m)));
  const fresh = merged.filter((m) => !had.has(m));
  const used = new Set<ChatMessage>();
  const kept = new Set<ChatMessage>();
  for (const p of local) {
    if (!p.boxPending || p.role === "user") continue;
    const hit = fresh.find((b) => !used.has(b) && settles(p, b));
    if (hit) {
      used.add(hit);
      continue;
    }
    if (p.mid && merged.some((b) => b.mid === p.mid)) continue;
    if (keepReply(p)) kept.add(p);
  }
  info.unsettled = kept.size;
  // Those still waiting, and local notices (a refused or unsent turn), stay
  // where they were: after the message they followed (and after the box's
  // copies of the replies that were shown before them).
  for (let i = 0; i < local.length; i++) {
    const n = local[i]!;
    if (!n.boxLocal && !kept.has(n)) continue;
    let anchor: ChatMessage | undefined;
    for (let j = i - 1; j >= 0; j--) {
      if (!isLocalOnly(local[j]!)) {
        anchor = local[j];
        break;
      }
    }
    let at = merged.length;
    if (!anchor) at = 0;
    else {
      const k = keyOf(anchor);
      for (let j = merged.length - 1; j >= 0; j--) {
        const b = merged[j]!;
        if (anchor.mid && b.mid ? b.mid === anchor.mid : keyOf(b) === k) {
          at = j + 1;
          break;
        }
      }
    }
    while (at < merged.length && (merged[at]!.boxLocal || kept.has(merged[at]!) || used.has(merged[at]!))) at++;
    merged = [...merged.slice(0, at), n, ...merged.slice(at)];
  }
  // Optimistic user turns the box has not appended yet stay at the end.
  if (pending.length) {
    const lastUsers = merged.filter((m) => m.role === "user").slice(-pending.length - 2).map((m) => m.content);
    for (const p of pending) {
      if (!lastUsers.includes(p)) merged = [...merged, { role: "user", content: p, boxPending: true }];
    }
  }
  return merged;
}

function sameMessages(a: ChatMessage[], b: ChatMessage[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (
      x.role !== y.role ||
      x.content !== y.content ||
      !!x.hidden !== !!y.hidden ||
      !!x.system !== !!y.system ||
      !!x.boxPartial !== !!y.boxPartial ||
      !!x.boxPending !== !!y.boxPending ||
      !!x.boxLocal !== !!y.boxLocal ||
      x.mid !== y.mid ||
      (x.toolCalls?.length ?? 0) !== (y.toolCalls?.length ?? 0)
    )
      return false;
  }
  return true;
}

// Meta fields a `full` detail may carry onto the in-memory conversation.
const META_KEYS = [
  "title",
  "source",
  "role",
  "mission",
  "missionState",
  "costUsd",
  "costMissingCalls",
  "threadId",
  "project",
  "working",
  "nextWakeAt",
  "state",
  "verdict",
  "todos",
  "subagents",
  "pendingAsk",
  "queued",
  "askOf",
  "askNotifId",
  "askDecided",
  "askDecidedAt",
  "lastActivityAt",
  "createdAt",
] as const;

const KEEP_IF_ABSENT = new Set<string>(["title", "source", "role", "lastActivityAt", "createdAt"]);

// ---------- offline snapshot ----------

type CacheFile = { at: number; conversations: Conversation[] };

function cacheKey(vault: string): string {
  return CACHE_PREFIX + vault;
}

export function readBoxCache(vault: string): CacheFile | null {
  try {
    const raw = localStorage.getItem(cacheKey(vault));
    if (!raw) return null;
    const v = JSON.parse(raw) as CacheFile;
    return Array.isArray(v?.conversations) ? v : null;
  } catch {
    return null;
  }
}

function writeBoxCache(vault: string): void {
  try {
    const s = useStore.getState();
    if (s.vaultPath !== vault) return;
    const convs = s.conversations
      .slice()
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      .slice(0, CACHE_MAX_CONVS)
      .map((c) => ({
        ...c,
        status: "idle" as const,
        messages: (c.id === s.activeConversationId ? s.messages : c.messages)
          .filter((m) => !isLocalOnly(m))
          .slice(-DETAIL_N),
      }));
    let body = JSON.stringify({ at: Date.now(), conversations: convs });
    while (body.length > CACHE_MAX_BYTES && convs.length > 1) {
      convs.pop();
      body = JSON.stringify({ at: Date.now(), conversations: convs });
    }
    localStorage.setItem(cacheKey(vault), body);
  } catch {
    /* best-effort: quota or no storage */
  }
}

// ---------- the session ----------

class BoxChatSession {
  stopped = false;
  private cursor: number | null = null;
  /** The box process the cursor belongs to (/poll's `boot`); a new one = it restarted. */
  private boot: string | null = null;
  /** Set when the stream broke (unreachable, a restart, a sequence reset): the next head resyncs whole. */
  private stale = false;
  /** Per conversation: the newest detail request; an older answer landing later is dropped. */
  private detailGen = new Map<string, number>();
  private detailRetries = new Map<string, number>();
  private known = new Set<string>();
  private pending = new Map<string, string[]>();
  private detailTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastList = 0;
  private cacheTimer: ReturnType<typeof setTimeout> | null = null;
  private unsub: (() => void) | null = null;
  private wake: (() => void) | null = null;
  /** The live reply per conversation, rebuilt whole from the stream events. */
  private streams = new Map<string, StreamState>();
  /** Per conversation: running or not, as the box's events (in order, newest
   *  last) said. A /conversation answer's `status` is read from the box's
   *  file, which says "idle" through most of a run: the events win while the
   *  stream is unbroken; after a resync the details (and /status) decide. */
  private evRun = new Map<string, boolean>();
  /** When each reply shown ahead of the box's copy was placed (msgOrder.ts). */
  private placed = new WeakMap<ChatMessage, number>();
  /** Re-reads asked for because a snapshot was older than the screen (bounded). */
  private rechecks = new Map<string, number>();

  constructor(
    readonly vault: string,
    readonly link: Link,
  ) {}

  start(): void {
    this.applyCache();
    let lastActive = useStore.getState().activeConversationId;
    this.unsub = useStore.subscribe((s) => {
      if (s.activeConversationId !== lastActive) {
        lastActive = s.activeConversationId;
        if (lastActive && this.known.has(lastActive)) this.scheduleDetail(lastActive, 0);
      }
    });
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.unsub?.();
    for (const t of this.detailTimers.values()) clearTimeout(t);
    if (this.cacheTimer) clearTimeout(this.cacheTimer);
    this.wake?.();
  }

  private live(): boolean {
    return !this.stopped && useStore.getState().vaultPath === this.vault;
  }

  isKnown(id: string): boolean {
    return this.known.has(id);
  }

  markKnown(id: string): void {
    this.known.add(id);
  }

  private setReach(reachable: boolean, reason = ""): void {
    const cur = useStore.getState().boxChat;
    if (cur && cur.on && cur.reachable === reachable && cur.reason === reason) return;
    useStore.getState().setBoxChat({ on: true, reachable, reason });
  }

  private async loop(): Promise<void> {
    let backoff = 1000;
    while (this.live()) {
      try {
        if (this.cursor === null) {
          const head = await httpGet(this.link, "/poll?after=latest", 15_000);
          this.cursor = Number(head?.next) || 0;
          if (typeof head?.boot === "string") this.boot = head.boot;
          const whole = this.stale;
          this.stale = false;
          await this.syncAll(whole);
          this.setReach(true);
          backoff = 1000;
        }
        if (Date.now() - this.lastList > LIST_REFRESH_MS) {
          await this.syncList();
          // The safety net under the events: a thread this laptop still shows
          // running is asked about (/status) and re-read from the box, so a
          // missed end can't freeze it.
          const here = this.runningHere();
          if (here.length) {
            const runs = await this.boxRuns();
            for (const id of here) {
              if (runs && !runs.has(id)) this.evRun.set(id, false);
              this.scheduleDetail(id, 0);
            }
          }
        }
        const r = await httpGet(this.link, `/poll?after=${this.cursor}`, POLL_TIMEOUT_MS);
        if (!this.live()) return;
        this.setReach(true);
        backoff = 1000;
        const next = Number(r?.next);
        // Another box process than the cursor's (it restarted between two
        // polls), or a sequence that went backwards (the ring lost its state):
        // the events in between are gone — resync everything, these included.
        const restarted = typeof r?.boot === "string" && this.boot !== null && r.boot !== this.boot;
        if (restarted || (Number.isFinite(next) && next < (this.cursor ?? 0))) {
          this.cursor = null;
          this.stale = true;
          continue;
        }
        const events: any[] = Array.isArray(r?.events) ? r.events : [];
        for (const ev of events) this.onEvent(ev);
        if (Number.isFinite(next)) this.cursor = next;
      } catch (e) {
        if (!this.live()) return;
        this.setReach(false, String((e as Error)?.message ?? e));
        this.cursor = null;
        // Whatever happened on the box meanwhile reached no event here.
        this.stale = true;
        await new Promise<void>((res) => {
          const t = setTimeout(res, backoff);
          this.wake = () => {
            clearTimeout(t);
            res();
          };
        });
        this.wake = null;
        backoff = Math.min(backoff * 2, 15_000);
      }
    }
  }

  /** Reconnect now (a send while marked unreachable, or tests). */
  kick(): void {
    this.wake?.();
  }

  /** Conversations this laptop shows as running (or with live state left over). */
  private runningHere(): string[] {
    const s = useStore.getState();
    const ids = new Set<string>();
    for (const c of s.conversations) if (c.status === "running" && this.known.has(c.id)) ids.add(c.id);
    for (const id of Object.keys(s.convRuntime)) if (this.known.has(id)) ids.add(id);
    if (s.busy && s.activeConversationId && this.known.has(s.activeConversationId)) ids.add(s.activeConversationId);
    return [...ids];
  }

  /** `whole`: the stream broke (the box restarted, was unreachable, or its
   *  sequence reset). The live state this laptop holds came from a stream that
   *  is gone: drop it, and re-read every conversation it showed running. */
  private async syncAll(whole = false): Promise<void> {
    const reread = new Set<string>(whole ? this.runningHere() : []);
    if (whole) this.clearLive();
    await this.syncList();
    const runs = await this.boxRuns();
    if (runs) {
      for (const id of runs) {
        reread.add(id);
        if (whole) this.evRun.set(id, true);
      }
      // What the box runs now is the truth after a break: the rest is over.
      if (whole) for (const id of reread) if (!runs.has(id)) this.evRun.set(id, false);
    }
    const active = useStore.getState().activeConversationId;
    if (active && this.known.has(active)) reread.add(active);
    for (const id of reread) this.scheduleDetail(id, 0);
  }

  /** The conversations the box runs a turn in now (/status), or null when it can't say. */
  private async boxRuns(): Promise<Set<string> | null> {
    try {
      const st = await httpGet(this.link, "/status", 10_000);
      if (!Array.isArray(st?.runs)) return null;
      return new Set(st.runs.map((r: any) => r?.convId).filter((x: unknown): x is string => typeof x === "string"));
    } catch {
      return null; // /status is optional for the chat
    }
  }

  /** The stream broke: forget what it said (the reply's pieces, who runs).
   *  What it showed stays on screen until the details re-read next carry the
   *  truth (status, plan, messages) and replace it in one update — a resync
   *  never blanks a reply. */
  private clearLive(): void {
    this.streams.clear();
    this.evRun.clear();
  }

  /** Running, by the events when the stream has been unbroken, else by the detail. */
  private runningNow(id: string, d: BoxDetail): boolean {
    const ev = this.evRun.get(id);
    return ev ?? d.status === "running";
  }

  /** The live reply (streamed so far) of `id` as `s` shows it. */
  private shownStream(s: ReturnType<typeof useStore.getState>, id: string): string {
    return ((s.activeConversationId === id ? s.streamingText : s.convRuntime[id]?.streamingText) ?? "").replace(/^…/, "").trim();
  }

  /** A reply shown before the box's copy lands (msgOrder.ts). */
  private placeholder(m: ChatMessage): ChatMessage {
    const p: ChatMessage = { ...m, boxPending: true };
    delete p.boxPartial;
    this.placed.set(p, Date.now());
    return p;
  }

  /**
   * The live reply becomes a message in the same store update that empties
   * the stream — no frame shows neither, and none shows both.
   * `landed`: the message the box just stored (its live `message` event);
   * without it, the streamed text is kept as a reply until the box's copy lands
   * (unless the list already has it).
   */
  private handOver(s: ReturnType<typeof useStore.getState>, id: string, landed?: ChatMessage, turnOver = false): Record<string, unknown> {
    const isActive = s.activeConversationId === id;
    const conv = s.conversations.find((c) => c.id === id);
    let msgs = isActive ? s.messages : conv?.messages ?? [];
    const shown = this.shownStream(s, id);
    const before = msgs;
    if (landed) {
      let m = landed;
      // A live event carries the text capped; the stream had all of it.
      if (shown.length > (m.content ?? "").length && shown.startsWith(m.content ?? "")) m = { ...m, content: shown };
      const there = m.mid ? msgs.find((x) => x.mid === m.mid) : undefined;
      if (!there) {
        // A steer closed this reply already: that one becomes it, in place.
        let i = -1;
        for (let j = msgs.length - 1; j >= Math.max(0, msgs.length - 6); j--) {
          const x = msgs[j]!;
          if (x.boxPending && x.role === "assistant" && settles({ ...x, mid: undefined }, { ...m, mid: undefined })) {
            i = j;
            break;
          }
        }
        const last = [...msgs].reverse().find((x) => !x.hidden && !isLocalOnly(x));
        if (i >= 0) msgs = msgs.map((x, j) => (j === i ? this.placeholder({ ...x, ...m }) : x));
        else if (!(!m.mid && last && last.role === m.role && keyOf(last) === keyOf(m))) msgs = [...msgs, this.placeholder(m)];
      }
    } else if (shown) {
      // This turn's messages (after Carl's last): is the streamed text one of them already?
      let from = msgs.length;
      while (from > 0 && msgs[from - 1]!.role !== "user") from--;
      const tail = msgs.slice(from);
      const probe: ChatMessage = { role: "assistant", content: shown };
      // A turn that is over and that the box's copy answers: its record is the box's.
      const answered = turnOver && tail.some((x) => x.role === "assistant" && !isLocalOnly(x) && !x.system);
      if (!answered && !tail.some((x) => x.role === "assistant" && settles(probe, { ...x, mid: undefined }))) msgs = [...msgs, this.placeholder(probe)];
    }
    const patch: Record<string, unknown> = {};
    if (isActive) {
      if (msgs !== before) patch.messages = msgs;
      if (s.streamingText || s.streamingReasoning || s.liveTools.length) {
        patch.streamingText = "";
        patch.streamingReasoning = "";
        patch.liveTools = [];
      }
    } else {
      if (msgs !== before && conv) patch.conversations = s.conversations.map((c) => (c.id === id ? { ...c, messages: msgs } : c));
      const rt = s.convRuntime[id];
      if (rt && (rt.streamingText || rt.streamingReasoning || rt.liveTools?.length)) {
        patch.convRuntime = { ...s.convRuntime, [id]: { ...rt, streamingText: "", streamingReasoning: "", liveTools: [] } };
      }
    }
    return patch;
  }

  async syncList(): Promise<void> {
    this.lastList = Date.now();
    const r = await httpGet(this.link, "/conversations", 15_000);
    if (!this.live()) return;
    const rows: BoxRow[] = Array.isArray(r?.conversations) ? r.conversations : [];
    const s = useStore.getState();
    const byId = new Map(s.conversations.map((c) => [c.id, c]));
    const added: Conversation[] = [];
    const metaPatches = new Map<string, Partial<Conversation>>();
    let fetches = 0;
    for (const row of rows) {
      if (!row || typeof row.id !== "string") continue;
      this.known.add(row.id);
      const local = byId.get(row.id);
      if (!local) {
        added.push({
          id: row.id,
          title: row.title || "New chat",
          messages: [],
          status: "idle",
          createdAt: row.lastActivityAt ?? Date.now(),
          lastActivityAt: row.lastActivityAt ?? Date.now(),
          source: (row.source as Conversation["source"]) || "manual",
          unread: false,
          ...rowMeta(row),
        });
        if (fetches++ < 20) this.scheduleDetail(row.id, 0);
        continue;
      }
      const meta = rowMeta(row);
      if (ROW_META.some((k) => meta[k] !== undefined && meta[k] !== local[k])) metaPatches.set(row.id, meta);
      const msgs = local.id === s.activeConversationId ? s.messages : local.messages;
      if (
        (row.msgCount ?? 0) > msgs.length ||
        (row.lastActivityAt ?? 0) > local.lastActivityAt ||
        (row.title && row.title !== local.title)
      ) {
        this.scheduleDetail(row.id, 0);
      }
    }
    if (metaPatches.size) {
      useStore.setState((st) => ({
        conversations: st.conversations.map((c) => (metaPatches.has(c.id) ? { ...c, ...metaPatches.get(c.id) } : c)),
      }));
    }
    if (added.length) {
      useStore.setState((st) => {
        const have = new Set(st.conversations.map((c) => c.id));
        const fresh = added.filter((c) => !have.has(c.id));
        if (!fresh.length) return {};
        return {
          conversations: [...st.conversations, ...fresh].sort((a, b) => b.lastActivityAt - a.lastActivityAt),
        };
      });
      this.scheduleCache();
    }
  }

  scheduleDetail(id: string, ms = 250): void {
    if (this.detailTimers.has(id)) return;
    this.detailTimers.set(
      id,
      setTimeout(() => {
        this.detailTimers.delete(id);
        void this.fetchDetail(id).then(
          () => this.detailRetries.delete(id),
          () => {
            // A failed re-read would leave the thread as it last was (a box
            // just back from a restart answers slowly): try again, a few times.
            const n = (this.detailRetries.get(id) ?? 0) + 1;
            if (n > 4 || !this.live()) return void this.detailRetries.delete(id);
            this.detailRetries.set(id, n);
            this.scheduleDetail(id, 1000 * 2 ** n);
          },
        );
      }, ms),
    );
  }

  async fetchDetail(id: string): Promise<void> {
    // Answers can land out of order (a slow one asked before the turn ended
    // lands after the fresh one): only the newest request's answer applies.
    const gen = (this.detailGen.get(id) ?? 0) + 1;
    this.detailGen.set(id, gen);
    let d: BoxDetail;
    try {
      d = await httpGet(this.link, `/conversation?id=${encodeURIComponent(id)}&n=${DETAIL_N}&full=1`, 15_000);
    } catch (e) {
      if ((e as { status?: number }).status === 404) return; // not on the box (yet)
      if (this.detailGen.get(id) !== gen) return; // a newer request owns it
      throw e;
    }
    if (this.detailGen.get(id) !== gen) return;
    if (!this.live() || !d || typeof d !== "object") return;
    this.known.add(id);
    this.applyDetail(id, d);
  }

  applyDetail(id: string, d: BoxDetail): void {
    const pend = this.pending.get(id) ?? [];
    const running = this.runningNow(id, d);
    const now = Date.now();
    // A reply shown ahead of the box's copy waits for it — through the turn,
    // and a while after (a slow write); one the box never stored then goes.
    const keepReply = (m: ChatMessage) => running || now - (this.placed.get(m) ?? now) < REPLY_HOLD_MS;
    const info: MergeInfo = {};
    useStore.setState((s) => {
      const idx = s.conversations.findIndex((c) => c.id === id);
      const base: Conversation =
        idx >= 0
          ? s.conversations[idx]!
          : {
              id,
              title: d.title || "New chat",
              messages: [],
              status: "idle",
              createdAt: Date.now(),
              lastActivityAt: Date.now(),
              source: (d.source as Conversation["source"]) || "manual",
              unread: false,
            };
      const isActive = s.activeConversationId === id;
      const localMsgs = isActive ? s.messages : base.messages;
      let messages = mergeBoxMessages(localMsgs, d, pend, info, keepReply);
      if (sameMessages(messages, localMsgs)) messages = localMsgs;
      // Settle the optimistic turns the box now has.
      const stillPending = messages.filter((m) => m.boxPending && m.role === "user").map((m) => m.content);
      if (stillPending.length !== pend.length) {
        if (stillPending.length) this.pending.set(id, stillPending);
        else this.pending.delete(id);
      }
      // Status: the box is the truth (its events, else this answer). An
      // optimistic send keeps "running" until the box has its user turn.
      const wantRunning = running || stillPending.length > 0;
      // Over: the live reply hands over to the messages in this same update.
      let rtPatch: Record<string, unknown> = {};
      if (!wantRunning) {
        const view = isActive ? { ...s, messages } : { ...s, conversations: s.conversations.map((c, i) => (i === idx ? { ...c, messages } : c)) };
        rtPatch = this.handOver(view as typeof s, id, undefined, true);
        if (isActive && rtPatch.messages) messages = rtPatch.messages as ChatMessage[];
        if (!isActive && rtPatch.conversations) messages = (rtPatch.conversations as Conversation[])[idx]!.messages;
      }
      const next: Conversation = { ...base, messages };
      // The dial reads the box model's window (the latest turn's usage.window).
      for (let i = messages.length - 1; i >= 0; i--) {
        const w = messages[i]!.usage?.window;
        if (typeof w === "number" && w > 0) {
          next.contextWindow = w;
          break;
        }
      }
      if (d.title && d.title !== base.title) next.title = d.title;
      if (d.full && d.meta && !info.stale) {
        for (const k of META_KEYS) {
          if (k in d.meta) (next as Record<string, unknown>)[k] = d.meta[k];
          // The box's meta is the truth: a field it no longer has (a wake that
          // fired, an answered ask) is gone here too.
          else if (!KEEP_IF_ABSENT.has(k)) delete (next as Record<string, unknown>)[k];
        }
      }
      if (messages !== localMsgs && messages.length > localMsgs.length) {
        next.lastActivityAt = Math.max(base.lastActivityAt, Number(d.meta?.lastActivityAt) || Date.now());
        if (!isActive && base.source !== "worker" && base.source !== "mission") next.unread = true;
      }
      next.status = wantRunning ? "running" : "idle";
      next.runStartedAt = wantRunning ? (d.runStartedAt ?? base.runStartedAt ?? Date.now()) : undefined;
      const conversations =
        idx >= 0
          ? s.conversations.map((c, i) => (i === idx ? next : c))
          : [...s.conversations, next].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
      const patch: Record<string, unknown> = { conversations };
      if (isActive) {
        if (messages !== s.messages) patch.messages = messages;
        if (s.busy !== wantRunning) patch.busy = wantRunning;
        if (wantRunning && !s.busyStartedAt) patch.busyStartedAt = next.runStartedAt ?? Date.now();
        if (!wantRunning) {
          patch.busyStartedAt = null;
          if ("streamingText" in rtPatch) Object.assign(patch, { streamingText: "", streamingReasoning: "", liveTools: [] });
          const ctx = lastReportedContext(messages);
          if (ctx > 0 && ctx !== s.lastContext) patch.lastContext = ctx;
        }
      }
      if (!wantRunning && id in s.convRuntime) {
        const rt = { ...s.convRuntime };
        delete rt[id];
        patch.convRuntime = rt;
      }
      return patch;
    });
    // An answer older than the screen (the box stored the newest reply after
    // reading its file for this one): ask again, a few times.
    if (info.stale || info.unsettled) {
      const n = (this.rechecks.get(id) ?? 0) + 1;
      if (n <= 8) {
        this.rechecks.set(id, n);
        this.scheduleDetail(id, 400 * n);
      }
    } else this.rechecks.delete(id);
    this.scheduleCache();
  }

  onEvent(ev: any): void {
    let e = ev;
    if (typeof ev === "string") {
      try {
        e = JSON.parse(ev);
      } catch {
        return;
      }
    }
    if (!e || typeof e !== "object") return;
    const id = typeof e.convId === "string" ? e.convId : "";
    switch (e.type) {
      case "file_changed":
        // The agent on the box (any turn: text, voice, phone, background) just
        // wrote this file: a pane showing it shows the box's bytes now. Display
        // only — the sync brings the commit behind it (vault_changed).
        if (typeof e.path === "string") boxFileChanged({ vault: this.vault, rel: e.path, fetch: (rel) => fetchBoxFile(this.link, rel) });
        return;
      case "inbox":
        // Something landed in the board inbox (or a make failed): a live voice
        // session mentions it in one short line at its next pause.
        if (typeof e.say === "string" && e.say) void import("./voice-elevenlabs").then((v) => v.announceAtNextPause(e.say)).catch(() => {});
        return;
      case "vault_changed":
        // The agent on the box edited files and published them: fetch + merge
        // them now (the gate's rules as ever); the merge reloads open panes.
        void boxSyncNow(this.vault, { pull: true });
        return;
      case "status": {
        if (!id) return;
        const running = e.status === "running";
        this.evRun.set(id, running);
        if (!running) this.streams.delete(id);
        this.setStatus(id, running);
        this.scheduleDetail(id, running ? 250 : 0);
        return;
      }
      case "runtime": {
        if (!id) return;
        this.evRun.set(id, true);
        this.setLive(id, e);
        this.setRuntime(id, this.notLanded(id, this.streamText(id, e)), String(e.tool ?? ""), e.steps, Number(e.startedAt) || undefined, typeof e.reasoning === "string" ? e.reasoning : undefined, typeof e.toolArg === "string" ? e.toolArg : undefined);
        return;
      }
      case "message": {
        if (!id) return;
        // A finalized assistant message replaces the live stream — shown from
        // the event at once, in the same update that empties the stream; the
        // box's full copy (the detail) then replaces it in place.
        if (e.role === "assistant") {
          this.streams.delete(id);
          const m: ChatMessage = { ...fromPhoneMessage(e), ...(typeof e.mid === "string" && e.mid ? { mid: e.mid } : {}) };
          this.landed.set(id, (m.content ?? "").trim());
          useStore.setState((s) => this.handOver(s, id, m));
        }
        this.scheduleDetail(id, 150);
        return;
      }
      case "meta": {
        // State, wake, cost, verdict, to-dos or subagents changed: re-read.
        if (id) this.scheduleDetail(id, 0);
        return;
      }
      case "title": {
        if (!id || typeof e.title !== "string") return;
        useStore.setState((s) => ({
          conversations: s.conversations.map((c) => (c.id === id ? { ...c, title: e.title } : c)),
        }));
        return;
      }
      case "chat": {
        // ENGINE's start/stream/end kinds, if the ring carries them.
        if (!id) return;
        if (e.phase === "start") {
          this.streams.delete(id);
          this.evRun.set(id, true);
          this.setStatus(id, true);
        } else if (e.phase === "stream" || e.phase === "delta") {
          this.evRun.set(id, true);
          this.setRuntime(id, this.notLanded(id, this.streamText(id, e)), String(e.tool ?? ""), undefined, undefined);
        } else if (e.phase === "end") {
          this.evRun.set(id, false);
          this.setStatus(id, false);
        }
        this.scheduleDetail(id, 150);
        return;
      }
      default:
        if (id) this.scheduleDetail(id, 500);
    }
  }

  /** The text of the reply that just landed per conversation: a live event
   *  still carrying it (the box's run state lags its store by a beat) does not
   *  show it a second time below its message. */
  private landed = new Map<string, string>();
  private notLanded(id: string, text: string): string {
    const l = this.landed.get(id);
    if (l === undefined) return text;
    const shown = text.replace(/^…/, "").trim();
    if (shown && (l === shown || l.endsWith(shown) || (shown.length > 40 && l.includes(shown.slice(-200))))) return "";
    if (shown) this.landed.delete(id);
    return text;
  }

  /** The whole live text after one stream event (src/streamWire.ts). */
  private streamText(id: string, e: any): string {
    // A box from before the pieces: its `text` is all there is.
    if (typeof e.offset !== "number") return String(e.text ?? "");
    const next = applyStream(this.streams.get(id), e);
    this.streams.set(id, next);
    return next.whole || !next.text ? next.text : `…${next.text}`;
  }

  /** The live context size and the box model's window, for the dial. */
  private setLive(id: string, e: any): void {
    const ctx = Number(e.context);
    const win = Number(e.window);
    const s = useStore.getState();
    if (ctx > 0 && s.activeConversationId === id && s.lastContext !== ctx) s.setLastContext(ctx);
    if (win > 0) {
      const c = s.conversations.find((x) => x.id === id);
      if (c && c.contextWindow !== win) {
        useStore.setState((st) => ({ conversations: st.conversations.map((x) => (x.id === id ? { ...x, contextWindow: win } : x)) }));
      }
    }
  }

  private setStatus(id: string, running: boolean): void {
    const hasPending = (this.pending.get(id)?.length ?? 0) > 0;
    const want = running || hasPending;
    useStore.setState((s) => {
      const c = s.conversations.find((x) => x.id === id);
      if (!c) return {};
      const patch: Record<string, unknown> = {};
      if ((c.status === "running") !== want) {
        patch.conversations = s.conversations.map((x) =>
          x.id === id
            ? { ...x, status: want ? "running" : "idle", runStartedAt: want ? (x.runStartedAt ?? Date.now()) : undefined }
            : x,
        );
      }
      if (s.activeConversationId === id && s.busy !== want) {
        patch.busy = want;
        patch.busyStartedAt = want ? (c.runStartedAt ?? Date.now()) : null;
      }
      // Over: what streamed hands over to the messages in this same update.
      if (!want) {
        const h = this.handOver(s, id, undefined, true);
        if (h.conversations && patch.conversations) {
          const msgs = (h.conversations as Conversation[]).find((x) => x.id === id)!.messages;
          patch.conversations = (patch.conversations as Conversation[]).map((x) => (x.id === id ? { ...x, messages: msgs } : x));
          delete h.conversations;
        }
        Object.assign(patch, h);
      }
      return patch;
    });
  }

  private setRuntime(
    id: string,
    text: string,
    tool: string,
    steps: unknown,
    startedAt: number | undefined,
    reasoning?: string,
    toolArg?: string,
  ): void {
    // toolArg: the call's path/command (src/convDiff.ts), shown beside the name ("Write dog.svg").
    const liveTools: LiveTool[] = tool ? [{ id: `box-live-${tool}`, name: tool, input: toolArg ? { path: toolArg } : {} }] : [];
    const s = useStore.getState();
    if (!s.conversations.some((c) => c.id === id && c.status === "running")) this.setStatus(id, true);
    if (s.activeConversationId === id) {
      useStore.setState({
        streamingText: text,
        ...(reasoning !== undefined ? { streamingReasoning: reasoning } : {}),
        liveTools,
        busy: true,
        ...(s.busyStartedAt ? {} : { busyStartedAt: startedAt ?? Date.now() }),
      });
    } else {
      s.setConvRuntime(id, {
        ...(s.convRuntime[id] ?? { streamingReasoning: "" }),
        streamingText: text,
        streamingReasoning: reasoning ?? s.convRuntime[id]?.streamingReasoning ?? "",
        liveTools,
        liveSteps: Array.isArray(steps) ? (steps as { thought: string; action: string }[]) : undefined,
        startedAt: startedAt ?? s.convRuntime[id]?.startedAt ?? Date.now(),
      });
    }
  }

  /** A steer was taken: the streamed reply-so-far becomes a (local, until the
   *  box's copy lands) message, and the live stream starts over after it. */
  closeLiveReply(id: string): void {
    this.streams.delete(id);
    const s = useStore.getState();
    this.landed.set(id, this.shownStream(s, id));
    useStore.setState((st) => this.handOver(st, id));
  }

  /** The box accepted a turn for `id`: it runs until its events say otherwise. */
  ranTurn(id: string): void {
    this.evRun.set(id, true);
  }

  addPending(id: string, text: string): void {
    this.pending.set(id, [...(this.pending.get(id) ?? []), text]);
  }

  dropPending(id: string, text: string): void {
    const p = (this.pending.get(id) ?? []).filter((x) => x !== text);
    if (p.length) this.pending.set(id, p);
    else this.pending.delete(id);
  }

  rekeyPending(from: string, to: string): void {
    const p = this.pending.get(from);
    if (p) {
      this.pending.delete(from);
      this.pending.set(to, p);
    }
  }

  private applyCache(): void {
    const cache = readBoxCache(this.vault);
    if (!cache) return;
    useStore.setState((s) => {
      if (s.vaultPath !== this.vault) return {};
      const byId = new Map(s.conversations.map((c) => [c.id, c]));
      let changed = false;
      const conversations = s.conversations.map((c) => {
        const hit = cache.conversations.find((x) => x.id === c.id);
        if (!hit || !isNewerCopy(c.messages, hit.messages)) return c;
        changed = true;
        return { ...c, title: hit.title || c.title, messages: hit.messages };
      });
      for (const c of cache.conversations) {
        if (!byId.has(c.id)) {
          conversations.push({ ...c, status: "idle" });
          changed = true;
        }
      }
      if (!changed) return {};
      conversations.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
      const active = conversations.find((c) => c.id === s.activeConversationId);
      return { conversations, ...(active && !s.busy ? { messages: active.messages } : {}) };
    });
    for (const c of cache.conversations) this.known.add(c.id);
  }

  private scheduleCache(): void {
    if (this.cacheTimer) return;
    this.cacheTimer = setTimeout(() => {
      this.cacheTimer = null;
      writeBoxCache(this.vault);
    }, 1500);
  }
}

let session: BoxChatSession | null = null;

/** Start (or keep) the box chat for the open vault. No-op outside box mode. */
let starting: { vault: string; p: Promise<boolean> } | null = null;
export function startBoxChat(vault: string): Promise<boolean> {
  if (session && !session.stopped && session.vault === vault) return Promise.resolve(true);
  if (starting && starting.vault === vault) return starting.p;
  const p = (async () => {
    session?.stop();
    session = null;
    const link = await boxLinkFor(vault);
    if (!link || useStore.getState().vaultPath !== vault) {
      if (useStore.getState().boxChat) useStore.getState().setBoxChat(null);
      return false;
    }
    session = new BoxChatSession(vault, link);
    const cur = useStore.getState().boxChat;
    if (!cur?.on) useStore.getState().setBoxChat({ on: true, reachable: null, reason: "" });
    session.start();
    return true;
  })();
  starting = { vault, p };
  void p.finally(() => {
    if (starting?.p === p) starting = null;
  });
  return p;
}

export function stopBoxChat(): void {
  session?.stop();
  session = null;
  if (useStore.getState().boxChat) useStore.getState().setBoxChat(null);
}

/** Is the open vault's chat on the box right now? */
export function boxChatOn(): boolean {
  const s = useStore.getState();
  return !!session && !session.stopped && session.vault === s.vaultPath && !!s.boxChat?.on;
}

/** For tests: the live session. */
export function _boxChatSession(): BoxChatSession | null {
  return session;
}

function appendTo(id: string, m: ChatMessage): void {
  const s = useStore.getState();
  if (s.activeConversationId === id) s.appendMessage(m);
  else s.appendMessageToConversation(id, m);
}

/** Vault-absolute laptop paths mean nothing on the box: make them relative. */
function relativize(text: string, vault: string): string {
  const v = vault.replace(/\\/g, "/").replace(/\/+$/, "");
  return v ? text.split(v + "/").join("") : text;
}

/** Waiting on Carl: the box's `state`, or a mission's AWAITING_USER. */
function waitingOnUser(c: Conversation | undefined): boolean {
  if (!c) return false;
  return c.state === "waiting_user" || (c.source === "mission" && c.missionState === "AWAITING_USER");
}

/** Send one chat turn to the box. Returns false when this isn't box mode
 *  (the caller then runs its own path). */
export async function boxSend(opts: {
  text: string;
  contextPreamble?: string;
  attachments?: ChatAttachment[];
  convId?: string | null;
  /** Sent while a turn runs (pendingInput.ts): steer it, or queue after it. */
  mode?: PendingKind;
}): Promise<boolean> {
  if (!boxChatOn() || !session) return false;
  const sess = session;
  const s = useStore.getState();
  const vault = s.vaultPath!;
  const trimmed = opts.text.trim();
  let convId = opts.convId ?? s.activeConversationId;
  if (!convId) convId = s.newConversation();
  // Images go along as {name, mime, dataBase64}; the box saves them under
  // .vault-chat/captures/ and, when its model can't see, runs the turn on its
  // vision model (server/engine/engine.ts).
  const images = boxImages(opts.attachments);
  if (!trimmed && !images.length) return true;
  // What the box shows for the turn: its text, or "(image)" for an image alone.
  const shown = trimmed || "(image)";
  if (s.boxChat?.reachable === false) {
    sess.kick();
    appendTo(convId, {
      role: "assistant",
      system: true,
      boxLocal: true,
      content: `⚠️ ${BOX_UNREACHABLE}. The message was NOT sent.`,
    });
    return true;
  }
  const conv = s.conversations.find((c) => c.id === convId);
  // A conversation the box knows: anything it listed, or any with messages
  // (those files came from the box through git). A fresh local "New chat" is
  // created on the box by omitting the id.
  const knownToBox = sess.isKnown(convId) || (conv?.messages.some((m) => !isLocalOnly(m)) ?? false);
  const answer = knownToBox && waitingOnUser(conv);
  // Into a running turn: a chip until the box has it (pendingInput.ts).
  const midTurn = !!opts.mode && knownToBox && !answer && conv?.status === "running";
  const ctx = (opts.contextPreamble ?? "").trim();
  if (midTurn && opts.mode === "queue") {
    // Held by the box's engine until the turn ends (its `queued` lists it).
    const chip = addPending({ convId, kind: "queue", text: shown, sending: true });
    const rq = await sess_post(sess, "/message", {
      convId,
      text: relativize(trimmed, vault),
      clientMsgId: newClientMsgId(),
      queue: true,
      ...(images.length ? { images } : {}),
      ...(ctx ? { context: relativize(ctx, vault) } : {}),
    });
    if (!rq.ok) {
      removePending(chip.id);
      appendTo(convId, { role: "assistant", system: true, boxLocal: true, content: `⚠️ The box refused the message: ${rq.error}` });
      if (rq.network) sess.kick();
      return true;
    }
    if (rq.data?.queued && typeof rq.data.qid === "string") {
      // The conversation's `queued` takes over once the box's detail lands.
      patchPending(chip.id, { sending: false, qid: rq.data.qid });
      setTimeout(() => removePending(chip.id), 8_000);
    } else removePending(chip.id); // the turn had just ended: it ran as a message
    sess.scheduleDetail(convId, 300);
    return true;
  }
  const steerChip = midTurn ? addPending({ convId, kind: "steer", text: shown, sending: true }) : null;

  // Optimistic: the user's turn shows at once and the thread reads running.
  const optimistic = () => {
    sess.addPending(convId!, shown);
    appendTo(convId!, { role: "user", content: shown, boxPending: true, ...(opts.attachments?.length ? { attachments: opts.attachments } : {}) });
  };
  if (!steerChip) {
    // A plain send into a running turn steers it too: same placement.
    if (knownToBox && !answer && conv?.status === "running") sess.closeLiveReply(convId);
    optimistic();
  }
  useStore.getState().setConversationStatus(convId, "running");
  if (useStore.getState().activeConversationId === convId) {
    const cur = useStore.getState();
    if (!cur.busy) {
      cur.setBusy(true);
      cur.setBusyStartedAt(Date.now());
      cur.resetStreaming();
    }
  }

  const payload: Record<string, unknown> = {
    text: relativize(trimmed, vault),
    clientMsgId: newClientMsgId(),
    ...(images.length ? { images } : {}),
  };
  if (knownToBox) payload.convId = convId;
  if (ctx) payload.context = relativize(ctx, vault);
  if (conv?.project) payload.project = knownToBox ? conv.project : projectForSend(conv.project);
  const r = await sess_post(sess, answer ? "/answer" : "/message", payload);
  if (steerChip) {
    // The box has it (it steers the turn at its next step): the chip becomes the message.
    removePending(steerChip.id);
    if (r.ok) {
      // As on the laptop: the reply so far closes as its own message (the box
      // stores it so too), and Carl's lands after it — not above the live turn.
      sess.closeLiveReply(convId);
      optimistic();
    }
  }

  if (!r.ok) {
    sess.dropPending(convId, shown);
    useStore.setState((st) => {
      const strip = (ms: ChatMessage[]) => {
        // Kept where it was, as this laptop's own (never on the box).
        const i = ms.map((m) => !!m.boxPending && m.role === "user" && m.content === shown).lastIndexOf(true);
        return i < 0 ? ms : [...ms.slice(0, i), { ...ms[i]!, boxPending: undefined, boxLocal: true }, ...ms.slice(i + 1)];
      };
      return {
        conversations: st.conversations.map((c) => (c.id === convId ? { ...c, messages: strip(c.messages) } : c)),
        ...(st.activeConversationId === convId ? { messages: strip(st.messages) } : {}),
      };
    });
    appendTo(convId, {
      role: "assistant",
      system: true,
      boxLocal: true,
      content: r.network
        ? `⚠️ ${BOX_UNREACHABLE}: ${r.error}. The message was NOT delivered.`
        : `⚠️ The box refused the message: ${r.error}`,
    });
    useStore.getState().setConversationStatus(convId, "idle");
    if (useStore.getState().activeConversationId === convId) {
      useStore.getState().setBusy(false);
      useStore.getState().setBusyStartedAt(null);
    }
    if (r.network) sess.kick();
    return true;
  }
  const boxId = typeof r.data?.convId === "string" && r.data.convId ? r.data.convId : convId;
  if (boxId !== convId) {
    sess.rekeyPending(convId, boxId);
    useStore.getState().rekeyConversation(convId, boxId);
  }
  sess.markKnown(boxId);
  // The box took it: a turn runs (its events say when it ends).
  sess.ranTurn(boxId);
  sess.scheduleDetail(boxId, 400);
  return true;
}

/** Pasted / captured images as the box's /message takes them. */
export function boxImages(atts: ChatAttachment[] | undefined): { name?: string; mime: string; dataBase64: string }[] {
  const out: { name?: string; mime: string; dataBase64: string }[] = [];
  for (const a of atts ?? []) {
    const m = /^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/s.exec(a.imageDataUrl ?? "");
    if (!m || !m[2]) continue;
    const name = a.capturedFilePath?.split("/").pop() ?? a.sourcePath?.split("/").pop();
    out.push({ ...(name ? { name } : {}), mime: m[1] || "image/png", dataBase64: m[2] });
  }
  return out.slice(0, 8);
}

function sess_post(sess: BoxChatSession, path: string, payload: Record<string, unknown>) {
  return httpPost(sess.link, path, payload);
}

/** Take a queued message back from the box before its turn comes. */
export async function boxUnqueue(convId: string, qid: string): Promise<boolean> {
  if (!boxChatOn() || !session) return false;
  const r = await httpPost(session.link, "/message", { convId, unqueue: qid });
  if (!r.ok || r.data?.ok === false) return false;
  useStore.setState((st) => ({
    conversations: st.conversations.map((c) => (c.id === convId ? { ...c, queued: (c.queued ?? []).filter((q) => q.id !== qid) } : c)),
  }));
  session?.scheduleDetail(convId, 300);
  return true;
}

/** Stop the box's turn on this conversation. False = not box mode. */
export async function boxStop(convId: string | null): Promise<boolean> {
  if (!boxChatOn() || !session) return false;
  if (!convId) return true;
  const sess = session;
  const r = await httpPost(sess.link, "/kill", { convId });
  if (!r.ok) {
    appendTo(convId, {
      role: "assistant",
      system: true,
      boxLocal: true,
      content: `⚠️ Couldn't stop it on the box: ${r.error}`,
    });
    if (r.network) sess.kick();
    return true;
  }
  // The box's real end arrives as a status event; re-read in case it is
  // already over.
  sess.scheduleDetail(convId, 300);
  setTimeout(() => sess.scheduleDetail(convId, 0), 3000);
  return true;
}

/** Answer a question the box's agent asked (AskUser). False = not box mode. */
export async function boxAnswer(convId: string, text: string): Promise<boolean> {
  if (!boxChatOn() || !session) return false;
  const sess = session;
  const r = await httpPost(sess.link, "/answer", { convId, text, clientMsgId: newClientMsgId() });
  if (!r.ok) {
    appendTo(convId, { role: "assistant", system: true, boxLocal: true, content: `⚠️ Couldn't send the answer to the box: ${r.error}` });
    return true;
  }
  sess.ranTurn(convId);
  sess.scheduleDetail(convId, 300);
  return true;
}

/** Steer or stop one running subagent of a box conversation. Returns an error
 *  line, or null on success (also null when this isn't box mode: nothing to do). */
export async function boxSubagent(convId: string, sid: string, op: "steer" | "stop", text?: string): Promise<string | null> {
  if (!boxChatOn() || !session) return "Subagents run on the box — it isn't connected.";
  const sess = session;
  const r = await httpPost(sess.link, `/api/v1/conversations/${encodeURIComponent(convId)}/subagents/${encodeURIComponent(sid)}/${op}`, op === "steer" ? { text: text ?? "" } : {});
  if (!r.ok) return r.error ?? "the box refused";
  sess.scheduleDetail(convId, 300);
  return null;
}
