// Box-mode chat. When a vault's `.vault-chat/sync.json` names a box, every
// agent turn runs on the box and the box's event log is the conversation
// (src/convlog/protocol.ts). This client writes nothing: it sends intents
// (send / steer / queue / take back / stop / answer / delete) and folds the log
// with the one reducer (src/convlog/reduce.ts), exactly like the popout and the
// phone. What the store shows for a box conversation is a pure projection of
// that fold (src/convlog/view.ts), plus this client's own messages still on
// their way (shown under the id the box will echo back, and confirmed in place).
//
// - The list: GET /api/v2/conversations (rows folded up to `seq`), then every
//   record after it from /poll?after=N, kept current with reduceRow.
// - A conversation: its checkpoint (the box's fold, equal to folding its
//   records) the first time it is opened, then its records from the same poll.
// - Reconnect: /poll?after=<cursor> answers exactly what was missed. Only a
//   cursor from another log (`reset`) starts over.
// - A small cache in localStorage (rows, the recent pictures, the cursor) shows
//   the last state at once and lets a reconnect fetch only the tail.
//
// Never active headless (the server bundles this module and IS the box).
//
// The app log follows one message across laptop → box → pi by the ids the box's
// turn log carries too (server/engine/turnLog.ts): `box.intent` (conv, cmid,
// outcome, ms) when this client sends, `box.turn` (conv, turn: start / end)
// and `box.shown` (conv, cmid, pi's entry id) when the feed brings them back,
// and `box.feed` for the poll itself (connect, drop, reset, resync, cursor).
import { LAPTOP_IDLE_MS, startAttentionBeat, type AttentionBeat } from "./attentionBeat";
import { invoke } from "@tauri-apps/api/core";
import { vlog } from "./debugLog";
import { projectForSend } from "./projects";
import { useStore, type ChatAttachment, type ChatMessage, type FileUpload, type LiveTool, type TodoItem } from "./store";
import { planAfterClear, tasksAfterClear } from "./backgroundTasks";
import { readBoxConfig, boxSyncNow } from "./vaultSync";
import { boxFileChanged } from "./liveReload";
import type { Conversation } from "./conversations";
import type { LogRecord, PollAnswer } from "./convlog/protocol";
import { emptyPicture, emptyRow, foldInto, pendingOf, reduceRow, type Picture, type RowState } from "./convlog/reduce";
import { RETRY_TEXT, afterClear, makeChatView, type ChatView } from "./convlog/view";
import { MAIN_ID } from "./threads";

export const BOX_UNREACHABLE = "Box unreachable";
/** How long a waiting message may be missing from both the log's pending and its transcript before it is called dropped. */
const DROP_GRACE_MS = 3000;
/** No box for this vault: the chat has nothing to run on. */
export const NO_BOX = "Connect your box to chat";

/** Why the box did not answer, in words (the raw error from the request). */
export function unreachableWhy(raw: string, tailscale?: { installed: boolean; connected: boolean } | null): string {
  if (tailscale && tailscale.installed && !tailscale.connected) return "Tailscale is not connected";
  if (/timed? ?out|timeout|deadline/i.test(raw)) return "the box did not answer in time";
  if (/refused|reset|closed|502|503|504/i.test(raw)) return "the box is down or restarting";
  if (/dns|resolve|no route|unreachable|network|connect/i.test(raw)) return "no route to the box (is Tailscale connected?)";
  return raw.slice(0, 160) || "no answer";
}

/** The store's `boxChat`: null until the vault's box is known; `on: false`, no box (the chat says so). */
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
const CACHE_PREFIX = "vault-chat:box-log:";
const CACHE_MAX_PICTURES = 12;
const CACHE_MAX_BYTES = 3_000_000;

function headless(): boolean {
  return !!(globalThis as { __VC_HEADLESS__?: unknown }).__VC_HEADLESS__;
}

export function newClientId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
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
  const r = await invoke<HttpResult>("box_get_json", { url: `${link.url}${vaultPath(link, path)}`, token: link.token, timeoutMs });
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

async function httpPost(link: Link, path: string, payload: Record<string, unknown>): Promise<{ ok: boolean; error?: string; data?: Record<string, unknown>; network?: boolean }> {
  let r: HttpResult;
  try {
    r = await invoke<HttpResult>("box_post_json", { url: `${link.url}${vaultPath(link, path)}`, body: JSON.stringify(payload), token: link.token });
  } catch (e) {
    return { ok: false, network: true, error: String((e as Error)?.message ?? e) };
  }
  let d: Record<string, unknown> = {};
  try {
    d = JSON.parse(r.body) as Record<string, unknown>;
  } catch {
    /* non-JSON body */
  }
  if (r.status < 200 || r.status >= 300 || d.error || d.ok === false) {
    return { ok: false, error: String(d.error || `HTTP ${r.status}${r.body ? `: ${r.body.slice(0, 200)}` : ""}`), data: d };
  }
  return { ok: true, data: d };
}

/** A side request on this vault's box (src/complete.ts; server/engine/pi/side.ts): POST /api/v1/side starts it,
 *  then long polls follow pi's text until it is done (`onText`: the text so far). Aborting stops it on the box.
 *  Throws with the reason when there is no box or it does not answer. */
export async function boxSide(
  req: Record<string, unknown>,
  o: { onText?: (text: string) => void; signal?: AbortSignal } = {},
): Promise<{ text: string; side: string }> {
  const link = await boxLinkFor(useStore.getState().vaultPath);
  if (!link) throw new Error(`${NO_BOX}.`);
  const unreachable = (raw: string) => new Error(`${BOX_UNREACHABLE}: ${unreachableWhy(raw)}.`);
  const r = await httpPost(link, "/api/v1/side", req);
  if (!r.ok) throw r.network ? unreachable(r.error ?? "") : new Error(`The box could not answer: ${r.error}`);
  const id = String(r.data?.id ?? "");
  let v = Number(r.data?.v ?? 0);
  const stop = () => void httpPost(link, `/api/v1/side/${encodeURIComponent(id)}/stop`, {});
  o.signal?.addEventListener("abort", stop, { once: true });
  try {
    for (;;) {
      let s: { text?: string; v?: number; done?: boolean; error?: string | null };
      try {
        s = await httpGet(link, `/api/v1/side/${encodeURIComponent(id)}?after=${v}&wait=20000`, 35_000);
      } catch (e) {
        const status = (e as { status?: number }).status;
        throw status ? new Error(`The box could not answer: ${(e as Error).message}`) : unreachable(String((e as Error)?.message ?? e));
      }
      v = Number(s.v ?? v);
      const text = String(s.text ?? "");
      if (!o.signal?.aborted) o.onText?.(text);
      if (s.done) {
        if (s.error && !o.signal?.aborted) throw new Error(`The box could not answer: ${s.error}`);
        return { text, side: id };
      }
    }
  } finally {
    o.signal?.removeEventListener("abort", stop);
  }
}

/** A GET to the box (projects, notifications). Throws on failure. */
export function boxGet(link: Link, path: string, timeoutMs = 15_000): Promise<any> {
  return httpGet(link, path, timeoutMs);
}

/** A POST to the box (projects, notifications). Never throws. */
export function boxPost(link: Link, path: string, payload: Record<string, unknown>) {
  return httpPost(link, path, payload);
}

// ---------- this client's own messages on their way ----------

/** A message this client sent that the log does not hold yet (or that the box refused). */
type Outgoing = {
  id: string;
  text: string;
  role?: "user" | "assistant";
  attachments?: ChatAttachment[];
  /** Not delivered: why, and the log's message it followed (it stays there). */
  failed?: string;
  after?: string | null;
  /** A voice line (it starts no turn). */
  line?: boolean;
  /** Sent while a turn ran (pi's steer): waiting for the agent's next step until the log has it. */
  steer?: boolean;
  /** The log held it as pending (so its going away without delivery means it was dropped: a Stop). */
  seen?: boolean;
  /** "Send now" asked: the step is being cut and it starts the next turn. */
  now?: boolean;
};
/** A line only this client shows (the box was unreachable): it stays where it was said, after the log's messages it followed. */
type Notice = { id: string; text: string; after: string | null };

// ---------- the cache ----------

type CacheFile = { epoch: string; cursor: number; rows: RowState[]; pictures: Picture[] };

function cacheKey(vault: string): string {
  return CACHE_PREFIX + vault;
}

export function readBoxCache(vault: string): CacheFile | null {
  try {
    const raw = localStorage.getItem(cacheKey(vault));
    if (!raw) return null;
    const v = JSON.parse(raw) as CacheFile;
    return v && typeof v.epoch === "string" && Array.isArray(v.rows) && Array.isArray(v.pictures) ? v : null;
  } catch {
    return null;
  }
}

type Deletable = RowState & { deleted?: boolean };

// ---------- the session ----------

class BoxChatSession {
  stopped = false;
  /** The log this client follows, and the last record of it applied. */
  private epoch: string | null = null;
  private cursor: number | null = null;
  private rows = new Map<string, RowState>();
  private pics = new Map<string, Picture>();
  /** Conversations being fetched: the records that arrive meanwhile wait here. */
  private loading = new Map<string, LogRecord[]>();
  private views = new Map<string, (p: Picture) => ChatView>();
  private outgoing = new Map<string, Outgoing[]>();
  private notices = new Map<string, Notice[]>();
  private unsub: (() => void) | null = null;
  private wake: (() => void) | null = null;
  private cacheTimer: ReturnType<typeof setTimeout> | null = null;
  /** The poll is down since (ms), false when up, null before the first answer. */
  private down: number | false | null = null;
  /** The ids this client sent (a delivered steer or queued message drops its chip). */
  private sent = new Set<string>();
  /** Clear on this surface (src/viewClear.ts): each conversation shows only what came after this device's own Clear. */
  private clearedAt: Record<string, string> = {};
  /** Says to the box whether Carl is looking at the laptop (server/pushGate.ts: the phone stays quiet while he is). */
  private beat: AttentionBeat | null = null;

  constructor(
    readonly vault: string,
    readonly link: Link,
  ) {}

  start(): void {
    this.clearedAt = readCleared(this.vault);
    this.applyCache();
    let lastActive = useStore.getState().activeConversationId;
    this.unsub = useStore.subscribe((s) => {
      if (s.activeConversationId !== lastActive) {
        lastActive = s.activeConversationId;
        if (lastActive) this.open(lastActive);
        this.beat?.poke();
      }
    });
    if (lastActive) this.open(lastActive);
    void this.loop();
    try {
      this.beat = startAttentionBeat({
        device: "laptop",
        idleMs: LAPTOP_IDLE_MS,
        convId: () => useStore.getState().activeConversationId,
        post: (b) => httpPost(this.link, "/api/v1/attention", b),
      });
    } catch {
      /* no window here (tests): nothing to say */
    }
  }

  stop(): void {
    this.stopped = true;
    this.beat?.stop();
    this.beat = null;
    this.unsub?.();
    if (this.cacheTimer) clearTimeout(this.cacheTimer);
    this.wake?.();
  }

  private live(): boolean {
    return !this.stopped && useStore.getState().vaultPath === this.vault;
  }

  isKnown(id: string): boolean {
    return this.rows.has(id);
  }

  row(id: string): RowState | undefined {
    return this.rows.get(id);
  }

  picture(id: string): Picture | undefined {
    return this.pics.get(id);
  }

  private setReach(reachable: boolean, reason = ""): void {
    const cur = useStore.getState().boxChat;
    if (cur && cur.on && cur.reachable === reachable && cur.reason === reason) return;
    useStore.getState().setBoxChat({ on: true, reachable, reason });
  }

  /** Reconnect now (a send while marked unreachable, or tests). */
  kick(): void {
    this.wake?.();
  }

  private async loop(): Promise<void> {
    let backoff = 1000;
    while (this.live()) {
      try {
        if (this.cursor === null) await this.resync();
        if (!this.live()) return;
        const r = (await httpGet(this.link, `/poll?after=${this.cursor}${this.epoch ? `&epoch=${encodeURIComponent(this.epoch)}` : ""}&client=laptop`, POLL_TIMEOUT_MS)) as PollAnswer & { epoch?: string };
        if (!this.live()) return;
        if (this.down !== false) vlog("box.feed", { state: "connected", cursor: this.cursor, epoch: this.epoch, ...(this.down ? { downMs: Date.now() - this.down } : {}) });
        this.down = false;
        this.setReach(true);
        backoff = 1000;
        if (r.reset || (r.epoch && this.epoch && r.epoch !== this.epoch)) {
          // Another log than the cursor's (the box's log was reset): start over from it.
          vlog("box.feed", { state: "reset", cursor: this.cursor, epoch: this.epoch, boxEpoch: r.epoch ?? null });
          this.cursor = null;
          continue;
        }
        this.apply(Array.isArray(r.events) ? r.events : []);
        if (Number.isFinite(r.next)) this.cursor = Math.max(this.cursor ?? 0, r.next);
      } catch (e) {
        if (!this.live()) return;
        if (!this.down) {
          this.down = Date.now();
          vlog("box.feed", { state: "dropped", cursor: this.cursor, error: String((e as Error)?.message ?? e).slice(0, 200) });
        }
        this.setReach(false, String((e as Error)?.message ?? e));
        // The cursor stays: when the box answers again, /poll gives exactly what was missed.
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

  /** The list from the box (rows folded up to `seq`); the open conversations again from their checkpoints. */
  private async resync(): Promise<void> {
    const r = await httpGet(this.link, "/api/v2/conversations", 20_000);
    if (!this.live()) return;
    this.setReach(true);
    this.epoch = String(r.epoch ?? "");
    this.rows = new Map((Array.isArray(r.rows) ? r.rows : []).map((x: RowState) => [x.id, x]));
    this.cursor = Number(r.seq) || 0;
    vlog("box.feed", { state: "resync", cursor: this.cursor, epoch: this.epoch, rows: this.rows.size });
    // Pictures from another log (or an older cursor) are not this one's: fetched again.
    const reload = [...this.pics.keys()];
    this.pics.clear();
    this.projectAll();
    const active = useStore.getState().activeConversationId;
    await Promise.all([...new Set([...reload, ...(active ? [active] : [])])].filter((id) => this.rows.has(id)).map((id) => this.load(id)));
  }

  /** Open a conversation: its picture from the box (a checkpoint), unless it is here already. */
  open(id: string): void {
    if (this.pics.has(id) || this.loading.has(id) || !this.rows.has(id) || this.cursor === null) {
      this.project(new Set([id]));
      return;
    }
    void this.load(id);
  }

  private async load(id: string): Promise<void> {
    if (this.loading.has(id)) return;
    this.loading.set(id, []);
    try {
      const r = await httpGet(this.link, `/api/v2/conversations/${encodeURIComponent(id)}/checkpoint`, 20_000);
      if (!this.live() || !r?.picture) return;
      // What arrived while it loaded (the reducer skips what the checkpoint already holds).
      this.pics.set(id, foldInto(r.picture as Picture, this.loading.get(id) ?? []));
    } catch (e) {
      if ((e as { status?: number }).status !== 404) console.warn("[box-chat] open failed:", e);
    } finally {
      this.loading.delete(id);
    }
    this.project(new Set([id]));
  }

  /** Records from /poll: the rows, the open pictures, the signals. */
  apply(records: LogRecord[]): void {
    const touched = new Set<string>();
    const byConv = new Map<string, LogRecord[]>();
    for (const r of records) {
      if (r.conv === null) {
        this.signal(r.type === "signal" ? r.signal : {});
        continue;
      }
      logRecord(r);
      let row = this.rows.get(r.conv);
      // A conversation born while this client follows the log: every record of it comes here,
      // so its picture folds from nothing (no fetch).
      if (!row) this.pics.set(r.conv, emptyPicture(r.conv));
      // An older conversation's placeholder row gives way to its records.
      if (!row || row.legacy) row = emptyRow(r.conv);
      this.rows.set(r.conv, reduceRow(row, r));
      touched.add(r.conv);
      const buf = this.loading.get(r.conv);
      if (buf) buf.push(r);
      else if (this.pics.has(r.conv)) {
        const list = byConv.get(r.conv) ?? [];
        list.push(r);
        byConv.set(r.conv, list);
      }
    }
    for (const [id, rs] of byConv) this.pics.set(id, foldInto(this.pics.get(id)!, rs));
    // The open conversation (or one with this client's messages on their way) is never shown without its picture.
    const active = useStore.getState().activeConversationId;
    for (const id of touched) if (!this.pics.has(id) && !this.loading.has(id) && (id === active || this.outgoing.has(id))) void this.load(id);
    if (touched.size) this.project(touched);
  }

  private signal(e: Record<string, unknown>): void {
    switch (e.type) {
      case "file_changed":
        // The agent on the box just wrote this file: a pane showing it shows the box's bytes now.
        if (typeof e.path === "string") boxFileChanged({ vault: this.vault, rel: e.path, fetch: (rel) => fetchBoxFile(this.link, rel) });
        return;
      case "inbox":
        // Something landed in the board inbox: a live voice session mentions it at its next pause.
        if (typeof e.say === "string" && e.say) void import("./voice-elevenlabs").then((v) => v.announceAtNextPause(e.say as string)).catch(() => {});
        return;
      case "show": {
        // pi's Show: open it here (the file tree's way, scrolled to its target) and tell the box what happened.
        const id = typeof e.id === "string" ? e.id : "";
        if (e.to !== "laptop" || !id) return;
        const link = this.link;
        void import("./showOnLaptop")
          .then((m) => m.showOnLaptop(e as unknown as import("./showOnLaptop").ShowSignal, { sync: () => boxSyncNow(this.vault, { pull: true }), boxFile: (rel) => fetchBoxFile(link, rel) }))
          .then((ack) => httpPost(link, `/api/v1/show/${encodeURIComponent(id)}/ack`, ack))
          .catch((err) => console.warn("[box-chat] show failed:", err));
        return;
      }
      case "follow": {
        // Carl asked to work in another thread (the agent's OpenProject, server/projectRoutes.ts): this screen follows.
        if (typeof e.convId !== "string" || !e.convId) return;
        const to = e.convId;
        const title = typeof e.title === "string" && e.title ? e.title : undefined;
        if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") window.dispatchEvent(new CustomEvent("vc-projects-changed"));
        if (useStore.getState().voiceMode) void import("./voice-elevenlabs").then((v) => v.voiceFollow(to)).catch(() => {});
        if (useStore.getState().activeConversationId !== to) void import("./projects").then((m) => m.openThread(to, title)).catch((err) => console.warn("[box-chat] follow failed:", err));
        return;
      }
      case "project": {
        // Carl renamed or deleted a project (here or on another surface): the list re-reads; a screen on a
        // deleted project's thread lands on Main (the row going away does it too, if this signal was missed).
        if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") window.dispatchEvent(new CustomEvent("vc-projects-changed"));
        if (e.deleted && typeof e.convId === "string") this.leaveDeleted(e.convId);
        return;
      }
      case "vault_changed":
        // The agent on the box edited files and published them: fetch and merge them now.
        void boxSyncNow(this.vault, { pull: true });
        return;
      default:
        return;
    }
  }

  // ---------- the projection: the fold → the store ----------

  private viewOf(id: string): (p: Picture) => ChatView {
    let v = this.views.get(id);
    if (!v) this.views.set(id, (v = makeChatView()));
    return v;
  }

  private projectAll(): void {
    this.project(new Set([...this.rows.keys(), ...useStore.getState().conversations.map((c) => c.id)]));
  }

  /** What the store shows for these conversations: their rows and pictures, plus this client's own messages on their way. */
  project(ids: Set<string>): void {
    if (!this.live()) return;
    useStore.setState((s) => {
      const index = new Map(s.conversations.map((c, i) => [c.id, i]));
      let conversations: Conversation[] | null = null;
      const put = (c: Conversation) => {
        conversations ??= s.conversations.slice();
        const i = index.get(c.id);
        if (i === undefined) {
          index.set(c.id, conversations.length);
          conversations.push(c);
        } else conversations[i] = c;
      };
      const patch: Record<string, unknown> = {};
      let runtime: Record<string, NonNullable<(typeof s.convRuntime)[string]>> | null = null;
      for (const id of ids) {
        const row = this.rows.get(id) as Deletable | undefined;
        const i = index.get(id);
        const prev = i === undefined ? undefined : s.conversations[i];
        if (!row) {
          // Not on the box (yet): a new local chat, or this client's message creating it.
          if (!prev || (!this.outgoing.has(id) && !this.notices.has(id))) continue;
          const messages = this.overlay(id, prev.messages.filter((m) => !m.boxPending && !m.boxLocal));
          const running = (this.outgoing.get(id) ?? []).some((o) => !o.failed && !o.line);
          put({ ...prev, messages, status: running ? "running" : "idle" });
          if (s.activeConversationId === id) Object.assign(patch, { messages, busy: running });
          continue;
        }
        if (row.deleted) {
          // Gone (a project Carl deleted): the list is rebuilt without it, even when nothing else changed.
          if (prev) conversations ??= s.conversations.slice();
          continue;
        }
        const p = this.pics.get(id);
        const view = p ? this.viewOf(id)(p) : null;
        // What this surface cleared is not shown here (the conversation, and every other surface, still has it).
        const base = afterClear((view?.messages ?? prev?.messages.filter((m) => !m.boxPending && !m.boxLocal) ?? []) as ChatMessage[], this.clearedAt[id]);
        const messages = this.overlay(id, base, view?.pending ?? (p ? pendingOf(p) : []), !!(view ? view.running : row.running));
        // Sending: running as far as this client knows, until the log says so.
        const sending = (this.outgoing.get(id) ?? []).some((o) => !o.failed && (o.role ?? "user") === "user" && !o.line && (!o.steer || !!o.now));
        const running = (view ? view.running : row.running && !row.asking) || sending;
        const ask = p?.meta.asking ?? (row.asking && prev?.pendingAsk ? prev.pendingAsk : undefined);
        const next = {
          ...(prev ?? { unread: false }),
          id,
          title: row.title,
          source: row.source as Conversation["source"],
          createdAt: row.createdAt,
          lastActivityAt: row.lastActivityAt,
          messages,
          status: running ? "running" : "idle",
          runStartedAt: running ? (view?.startedAt ?? prev?.runStartedAt ?? Date.now()) : undefined,
          project: row.project,
          kind: row.kind,
          clearing: row.clearing,
          state: row.state as Conversation["state"],
          working: row.working,
          nextWakeAt: row.nextWakeAt,
          costUsd: row.costUsd,
          queued: (view?.pending ?? []).map((x) => ({ id: x.id, text: x.text, kind: x.kind })),
          pendingAsk: ask ? { question: ask.question ?? "", options: ask.options ?? [], at: ask.at } : undefined,
          ...(p
            ? { ...this.afterClearFields(id, view?.todos ?? undefined, (p.meta.subagents ?? []) as Conversation["subagents"], base), contextWindow: view?.window ?? prev?.contextWindow, threadId: p.meta.threadId }
            : {}),
        } as Conversation;
        if (prev && s.activeConversationId !== id && next.lastActivityAt > prev.lastActivityAt && messages.length > prev.messages.length) next.unread = true;
        put(next);
        if (s.activeConversationId === id) {
          const live = view?.live;
          Object.assign(patch, {
            messages,
            busy: running,
            busyStartedAt: running ? (next.runStartedAt ?? Date.now()) : null,
            streamingText: live?.text ?? "",
            streamingReasoning: live?.reasoning ?? "",
            liveTools: (live?.tools ?? []) as LiveTool[],
            ...(view?.context ? { lastContext: view.context } : {}),
          });
        }
        // A background run's live view (the chats list's dot, a switch back to it).
        if (view && running && s.activeConversationId !== id) {
          runtime ??= { ...s.convRuntime };
          runtime[id] = { streamingText: view.live.text, streamingReasoning: view.live.reasoning, liveTools: view.live.tools as LiveTool[], ...(view.startedAt ? { startedAt: view.startedAt } : {}), ...(view.context ? { lastContext: view.context } : {}), ...(view.window ? { contextWindow: view.window } : {}) };
        } else if (id in (runtime ?? s.convRuntime)) {
          runtime ??= { ...s.convRuntime };
          delete runtime[id];
        }
      }
      if (runtime) patch.convRuntime = runtime;
      if (conversations) {
        const gone = new Set([...this.rows.values()].filter((r) => (r as Deletable).deleted).map((r) => r.id));
        if (s.activeConversationId && gone.has(s.activeConversationId)) queueMicrotask(() => this.leaveDeleted(s.activeConversationId!));
        patch.conversations = (conversations as Conversation[]).filter((c) => !gone.has(c.id)).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
      }
      return Object.keys(patch).length ? patch : {};
    });
    this.scheduleCache();
  }

  /** The open thread was deleted (a project Carl deleted): this screen, and a voice call on it, go to Main. */
  private leaveDeleted(id: string): void {
    const still = () => useStore.getState().activeConversationId === id;
    if (!still()) return;
    if (useStore.getState().voiceMode) void import("./voice-elevenlabs").then((v) => v.voiceFollow(MAIN_ID)).catch(() => {});
    // Checked again once the module is in: the signal and the row both call this, and he may have opened
    // another thread meanwhile — a late move to Main must never take him from it.
    void import("./projects")
      .then((m) => still() && m.openThread(MAIN_ID))
      .catch((err) => console.warn("[box-chat] to Main failed:", err));
  }

  /**
   * The log's messages, then this client's own still on their way (by id: one the log holds is the log's).
   * A message sent while the agent works shows at once as sent, marked `waiting` until pi takes it at the
   * agent's next step (the log's `pending`); one another surface sent shows the same way. Delivered, it is
   * the log's message where pi put it.
   */
  private overlay(id: string, base: ChatMessage[], pending: { id: string; text: string }[] = [], running = false): ChatMessage[] {
    const out = this.outgoing.get(id) ?? [];
    const notes = this.notices.get(id) ?? [];
    if (!out.length && !notes.length && !pending.length) return base;
    const have = new Set(base.map((m) => m.mid));
    const still = out.filter((o) => !have.has(o.id));
    if (still.length !== out.length) {
      if (still.length) this.outgoing.set(id, still);
      else this.outgoing.delete(id);
    }
    const waitingIds = new Set(pending.map((x) => x.id));
    for (const o of still) {
      if (!o.steer || o.failed) continue;
      if (waitingIds.has(o.id)) o.seen = true;
      // Held as pending, then gone without being delivered, with nothing running: a Stop dropped it (pi's queue is
      // cleared). Said on it after a moment (the delivered message may still be on its way in the feed).
      else if (o.seen && !o.now && !running) this.checkDropped(id, o.id);
    }
    const mineIds = new Set(still.map((o) => o.id));
    const others = pending.filter((x) => !have.has(x.id) && !mineIds.has(x.id));
    if (!still.length && !notes.length && !others.length) return base;
    // What never reached the box (a notice, a message not delivered) stays after the log's message
    // it followed (by id); this client's messages on their way come last.
    const anchored = new Map<string | null, ChatMessage[]>();
    const anchor = (after: string | null | undefined, ms: ChatMessage[]) => anchored.set(after ?? null, [...(anchored.get(after ?? null) ?? []), ...ms]);
    for (const n of notes) anchor(n.after, [{ role: "assistant", system: true, boxLocal: true, content: n.text, mid: n.id }]);
    const mine: ChatMessage[] = [];
    for (const o of still) {
      const waiting = !!o.steer && !o.failed && !o.now;
      const msg: ChatMessage = { role: o.role ?? "user", content: o.text, mid: o.id, ...(o.failed ? { boxLocal: true } : { boxPending: true }), ...(waiting ? { waiting: true } : {}), ...(o.attachments?.length ? { attachments: o.attachments } : {}) };
      if (o.failed) anchor(o.after, [msg, { role: "assistant", system: true, boxLocal: true, content: o.failed, mid: `${o.id}:failed` }]);
      else mine.push(msg);
    }
    for (const x of others) mine.push({ role: "user", content: x.text, mid: x.id, boxPending: true, waiting: true });
    if (!anchored.size) return [...base, ...mine];
    const out2: ChatMessage[] = [...(anchored.get(null) ?? [])];
    const placed = new Set<string | null>([null]);
    for (const m of base) {
      out2.push(m);
      if (m.mid && anchored.has(m.mid)) {
        placed.add(m.mid);
        out2.push(...anchored.get(m.mid)!);
      }
    }
    for (const [k, ms] of anchored) if (!placed.has(k)) out2.push(...ms);
    return [...out2, ...mine];
  }

  private dropChecks = new Set<string>();
  /** A waiting message that left the log's pending without being delivered: still not there after a moment, it is said. */
  private checkDropped(convId: string, id: string): void {
    if (this.dropChecks.has(id)) return;
    this.dropChecks.add(id);
    setTimeout(() => {
      this.dropChecks.delete(id);
      const o = (this.outgoing.get(convId) ?? []).find((x) => x.id === id);
      if (!o || o.failed || o.now) return;
      const p = this.pics.get(convId);
      if (p && (p.items.some((x) => x.id === id) || pendingOf(p).some((x) => x.id === id) || p.meta.running)) return;
      this.failOutgoing(convId, id, "Not delivered: the turn was stopped before the agent read it.");
    }, DROP_GRACE_MS);
  }

  /** A waiting message's state: "Send now" asked (it starts the next turn), or taken back (gone). */
  markNow(convId: string, id: string): void {
    const o = (this.outgoing.get(convId) ?? []).find((x) => x.id === id);
    if (o) o.now = true;
    this.project(new Set([convId]));
  }

  dropOutgoing(convId: string, id: string): Outgoing | null {
    const all = this.outgoing.get(convId) ?? [];
    const o = all.find((x) => x.id === id) ?? null;
    if (o) this.outgoing.set(convId, all.filter((x) => x !== o));
    this.project(new Set([convId]));
    return o;
  }

  /** This client's message, shown at once under the id the box will echo. */
  addOutgoing(convId: string, o: Outgoing): void {
    this.outgoing.set(convId, [...(this.outgoing.get(convId) ?? []), o]);
    this.sent.add(o.id);
    this.project(new Set([convId]));
  }

  failOutgoing(convId: string, id: string, why: string): void {
    const after = this.lastLogged(convId);
    this.outgoing.set(convId, (this.outgoing.get(convId) ?? []).map((o) => (o.id === id ? { ...o, failed: why, after } : o)));
    this.project(new Set([convId]));
  }

  /** The plan and the background tasks this surface shows: after its Clear, a plan written since and the tasks
   *  started since or still running (backgroundTasks.ts); everything when it never cleared. */
  private afterClearFields(id: string, todos: TodoItem[] | undefined, subagents: Conversation["subagents"], after: ChatMessage[]): Pick<Conversation, "todos" | "subagents"> {
    if (!this.clearedAt[id]) return { todos, subagents };
    return { todos: planAfterClear(todos, after), subagents: tasksAfterClear(subagents ?? [], after) };
  }

  /** Clear on this surface: everything shown so far goes from this device's view (nothing changes on the box). */
  clearHere(convId: string): void {
    const shown = useStore.getState().conversations.find((c) => c.id === convId)?.messages.filter((m) => !m.boxPending && !m.boxLocal) ?? [];
    const last = shown[shown.length - 1]?.mid;
    this.notices.delete(convId);
    if (!last) return;
    this.clearedAt = { ...this.clearedAt, [convId]: last };
    saveCleared(this.vault, this.clearedAt);
    this.project(new Set([convId]));
  }

  /** The id of the log's last message shown for a conversation (where a local line is anchored). */
  private lastLogged(convId: string): string | null {
    const shown = useStore.getState().conversations.find((c) => c.id === convId)?.messages.filter((m) => !m.boxLocal && !m.boxPending) ?? [];
    return shown[shown.length - 1]?.mid ?? null;
  }

  notice(convId: string, text: string): void {
    this.notices.set(convId, [...(this.notices.get(convId) ?? []), { id: newClientId(), text, after: this.lastLogged(convId) }]);
    this.project(new Set([convId]));
  }

  /** A local chat moved to another id (a voice session's conversation the box created). */
  rekey(from: string, to: string): void {
    const o = this.outgoing.get(from);
    if (o) {
      this.outgoing.delete(from);
      this.outgoing.set(to, [...(this.outgoing.get(to) ?? []), ...o]);
    }
    this.project(new Set([to]));
  }

  // ---------- the cache ----------

  private applyCache(): void {
    const c = readBoxCache(this.vault);
    if (!c) return;
    this.epoch = c.epoch;
    this.cursor = c.cursor;
    this.rows = new Map(c.rows.map((r) => [r.id, r]));
    for (const p of c.pictures) this.pics.set(p.id, p);
    this.projectAll();
  }

  private scheduleCache(): void {
    if (this.cacheTimer) return;
    this.cacheTimer = setTimeout(() => {
      this.cacheTimer = null;
      this.writeCache();
    }, 1500);
  }

  private writeCache(): void {
    try {
      // The cursor is exact for every row and picture kept: each holds every record up to it.
      if (!this.epoch || this.cursor === null || this.loading.size) return;
      const active = useStore.getState().activeConversationId;
      const pics = [...this.pics.values()]
        .sort((a, b) => Number(b.id === active) - Number(a.id === active) || (this.rows.get(b.id)?.lastActivityAt ?? 0) - (this.rows.get(a.id)?.lastActivityAt ?? 0))
        .slice(0, CACHE_MAX_PICTURES);
      const file: CacheFile = { epoch: this.epoch, cursor: this.cursor, rows: [...this.rows.values()], pictures: pics };
      let body = JSON.stringify(file);
      while (body.length > CACHE_MAX_BYTES && file.pictures.length > 1) {
        file.pictures.pop();
        body = JSON.stringify(file);
      }
      localStorage.setItem(cacheKey(this.vault), body);
    } catch {
      /* best effort: quota or no storage */
    }
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
    if (useStore.getState().vaultPath !== vault) return false;
    if (!link) {
      useStore.getState().setBoxChat(NO_BOX_STATE);
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
  useStore.getState().setBoxChat(NO_BOX_STATE);
}

const NO_BOX_STATE: BoxChatState = { on: false, reachable: null, reason: "" };

/** Is the open vault's chat on the box right now? */
export function boxChatOn(): boolean {
  const s = useStore.getState();
  return !!session && !session.stopped && session.vault === s.vaultPath && !!s.boxChat?.on;
}

/** For tests: the live session. */
export function _boxChatSession(): BoxChatSession | null {
  return session;
}

/** Vault-absolute laptop paths mean nothing on the box: make them relative. */
function relativize(text: string, vault: string): string {
  const v = vault.replace(/\\/g, "/").replace(/\/+$/, "");
  return v ? text.split(v + "/").join("") : text;
}

/** Pasted / captured images as the box's intents take them. */
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

/** One intent to the box (POST /api/v2/intent), in the app log under the ids the box logs it with. */
async function intent(sess: BoxChatSession, body: Record<string, unknown>) {
  const t0 = Date.now();
  const r = await httpPost(sess.link, "/api/v2/intent", { ...body, client: "laptop" });
  const d = r.data ?? {};
  vlog("box.intent", {
    type: body.type,
    conv: body.convId ?? d.convId ?? null,
    cmid: body.clientId ?? body.id ?? null,
    ok: r.ok,
    ms: Date.now() - t0,
    ...(r.ok ? { outcome: ["steered", "queued", "answered", "duplicate", "unqueued"].filter((k) => d[k]).join(",") || "ok" } : { error: r.error, network: !!r.network }),
  });
  return r;
}

/** A record from the box's feed, in the app log when it says something about a turn or a message of Carl's. */
function logRecord(r: LogRecord): void {
  try {
    if (r.type === "meta" && "running" in r.patch) {
      const run = r.patch.running as { turn?: string; kind?: string } | null;
      vlog("box.turn", run ? { conv: r.conv, turn: run.turn, kind: run.kind, state: "start", seq: r.seq } : { conv: r.conv, state: "end", to: r.patch.state ?? null, seq: r.seq });
    } else if (r.type === "entry" && r.clientId) {
      vlog("box.shown", { conv: r.conv, cmid: r.clientId, entry: r.entry?.id ?? null, via: r.via ?? null, seq: r.seq });
    }
  } catch {
    /* logging never breaks the feed */
  }
}

/**
 * Send one chat turn to the box. Returns false when this isn't box mode (the
 * caller then runs its own path). While a turn runs it goes into it (pi's steer,
 * at the agent's next step — or at the turn's end if no step comes), shown at
 * once as sent; an open question takes it as the answer. `uploads`: files from
 * outside the vault — their bytes go to the box first (boxUploadFile), and the
 * message names them by their path there.
 */
export async function boxSend(opts: { text: string; contextPreamble?: string; attachments?: ChatAttachment[]; uploads?: FileUpload[]; convId?: string | null }): Promise<boolean> {
  if (!boxChatOn() || !session) return false;
  const sess = session;
  const s = useStore.getState();
  const vault = s.vaultPath!;
  const trimmed = opts.text.trim();
  // No conversation named: Main, the default everywhere.
  const convId = opts.convId ?? s.activeConversationId ?? MAIN_ID;
  const images = boxImages(opts.attachments);
  const uploads = opts.uploads ?? [];
  if (!trimmed && !images.length && !uploads.length) return true;
  const shown = trimmed || (uploads.length ? uploads.map((u) => u.name).join(", ") : "(image)");
  const clientId = newClientId();
  if (s.boxChat?.reachable === false) {
    // Kept on screen as Carl's, marked as not sent (never dropped).
    sess.kick();
    sess.addOutgoing(convId, { id: clientId, text: shown, attachments: opts.attachments });
    sess.failOutgoing(convId, clientId, `⚠️ ${BOX_UNREACHABLE}. The message was NOT sent.`);
    return true;
  }
  const row = sess.row(convId);
  const conv = s.conversations.find((c) => c.id === convId);
  const kind: "answer" | "steer" | "send" = row?.asking ? "answer" : row?.running || conv?.status === "running" ? "steer" : "send";
  // Shown at once, under the id the box echoes back; a message into a running turn waits for the agent's next step.
  sess.addOutgoing(convId, { id: clientId, text: shown, attachments: opts.attachments, ...(kind === "steer" ? { steer: true } : {}) });
  const refused = (r: { network?: boolean; error?: string }, what: string) =>
    r.network ? `⚠️ ${BOX_UNREACHABLE}: ${r.error}. The ${what} was NOT delivered.` : `⚠️ The box refused the ${what}: ${r.error}`;
  // Attached files go up first (never a path on this laptop in the prompt: the box cannot open it).
  const files: string[] = [];
  for (const u of uploads) {
    const up = await boxUploadFile(u.name, fromBase64(u.dataBase64));
    if (!up.ok) {
      sess.failOutgoing(convId, clientId, `⚠️ ${u.name} did not reach the box: ${up.error} The message was NOT sent.`);
      return true;
    }
    files.push(up.path);
  }
  const ctx = (opts.contextPreamble ?? "").trim();
  const base: Record<string, unknown> = {
    convId,
    clientId,
    text: relativize(trimmed, vault),
    ...(images.length ? { images } : {}),
    ...(files.length ? { files } : {}),
    ...(ctx ? { context: relativize(ctx, vault) } : {}),
  };
  if (kind === "send" && conv?.project && !row) base.project = projectForSend(conv.project);
  const r = await intent(sess, { ...base, type: kind });
  if (!r.ok) {
    sess.failOutgoing(convId, clientId, refused(r, kind === "answer" ? "answer" : "message"));
    if (r.network) sess.kick();
  }
  return true;
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64.replace(/^data:[^,]*,/, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Take a waiting message back from the box before pi delivers it. */
export async function boxUnqueue(convId: string, id: string): Promise<boolean> {
  if (!boxChatOn() || !session) return false;
  const r = await intent(session, { type: "unqueue", convId, id });
  if (r.ok) session.dropOutgoing(convId, id);
  return r.ok;
}

/**
 * "Send now" on a waiting message (Claude Code's interrupt-and-send): the box cuts the agent's
 * current step and the message starts the next turn at once. False: it was already taken.
 */
export async function boxSendNow(convId: string, id: string): Promise<boolean> {
  if (!boxChatOn() || !session) return false;
  const sess = session;
  sess.markNow(convId, id);
  const r = await intent(sess, { type: "now", convId, id });
  if (!r.ok && r.network) sess.kick();
  return r.ok;
}

/** The biggest file an attachment may be (server/attachments.ts ATTACH_MAX_BYTES). */
export const ATTACH_MAX_BYTES = 25 * 1024 * 1024;

/**
 * A file from outside the vault, uploaded to the box with the message (Claude Code reads an attached
 * file itself; the box cannot open a path on this laptop). Saved in the vault's hidden attachments
 * area; returns its path there, or why not.
 */
export async function boxUploadFile(name: string, bytes: Uint8Array): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  if (!boxChatOn() || !session) return { ok: false, error: "no box connected" };
  if (bytes.length > ATTACH_MAX_BYTES) return { ok: false, error: tooBig(name, bytes.length) };
  const t0 = Date.now();
  const r = await httpPost(session.link, "/api/v2/attachment", { name, dataBase64: toBase64(bytes) });
  vlog("box.attach", { name: name.slice(0, 80), bytes: bytes.length, ok: r.ok, ms: Date.now() - t0, ...(r.ok ? {} : { error: r.error }) });
  if (!r.ok || typeof r.data?.path !== "string") return { ok: false, error: r.error ?? "the box did not take it" };
  return { ok: true, path: r.data.path };
}

export function tooBig(name: string, size: number): string {
  return `${name} is ${(size / (1024 * 1024)).toFixed(1)} MB; an attachment can be at most ${ATTACH_MAX_BYTES / (1024 * 1024)} MB.`;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Stop the box's turn on this conversation. False = not box mode. */
export async function boxStop(convId: string | null): Promise<boolean> {
  if (!boxChatOn() || !session) return false;
  if (!convId) return true;
  const sess = session;
  const r = await intent(sess, { type: "stop", convId });
  if (!r.ok) {
    sess.notice(convId, `⚠️ Couldn't stop it on the box: ${r.error}`);
    if (r.network) sess.kick();
  }
  return true;
}

/** Try again on a turn that ended on a failed request: a new turn that continues (a quiet "↻ Trying again" line). */
export async function boxRetry(conv: string | null): Promise<boolean> {
  if (!boxChatOn() || !session) return false;
  const sess = session;
  const convId = conv ?? MAIN_ID;
  const r = await intent(sess, { type: "send", convId, clientId: newClientId(), text: RETRY_TEXT, via: "retry" });
  if (!r.ok) {
    sess.notice(convId, `⚠️ Couldn't try again: ${r.error}`);
    if (r.network) sess.kick();
  }
  return true;
}

/** Answer a question the box's agent asked (AskUser). False = not box mode. */
export async function boxAnswer(convId: string, text: string): Promise<boolean> {
  if (!boxChatOn() || !session) return false;
  const sess = session;
  const clientId = newClientId();
  sess.addOutgoing(convId, { id: clientId, text });
  const r = await intent(sess, { type: "answer", convId, clientId, text });
  if (!r.ok) sess.failOutgoing(convId, clientId, `⚠️ Couldn't send the answer to the box: ${r.error}`);
  return true;
}

/**
 * Lines brought into the open chat as they are (a Ctrl+K exchange, a note
 * opened for discussion): the box writes them (an intent), this client shows
 * them at once under the same ids. False = not box mode.
 */
export async function boxLines(lines: { role: "user" | "assistant"; text: string; hidden?: boolean; attachments?: ChatAttachment[] }[]): Promise<boolean> {
  if (!boxChatOn() || !session) return false;
  const sess = session;
  const s = useStore.getState();
  const convId = s.activeConversationId ?? MAIN_ID;
  const clientId = newClientId();
  lines.forEach((l, i) => {
    if (!l.hidden) sess.addOutgoing(convId, { id: `${clientId}:${i}`, text: l.text, role: l.role, line: true, attachments: l.attachments });
  });
  const r = await intent(sess, {
    type: "lines",
    convId,
    clientId,
    lines: lines.map((l) => ({ role: l.role, text: l.text, ...(l.hidden ? { hidden: true } : {}), ...(l.attachments?.length ? { images: l.attachments.map((a) => a.imageDataUrl).filter(Boolean) } : {}) })),
  });
  if (!r.ok) {
    lines.forEach((l, i) => {
      if (!l.hidden) sess.failOutgoing(convId, `${clientId}:${i}`, `⚠️ ${r.network ? BOX_UNREACHABLE : "The box refused it"}: ${r.error}. Not saved in the chat.`);
    });
  }
  return true;
}

/**
 * Clear (Carl, 2026-10-23: "the visual clearing should be surface by surface so a phone clear doesn't affect a
 * laptop"): this device's view of the thread goes blank, with no divider and nothing to scroll back into; the
 * conversation itself, its context and every other surface are untouched (auto-compaction and /compact keep the
 * context small). Kept on this device across restarts. False = not box mode.
 */
export function boxClear(convId: string): boolean {
  if (!boxChatOn() || !session) return false;
  session.clearHere(convId);
  return true;
}

/** /compact [focus]: pi compacts the conversation's context now (server/engine/engine.ts compact). A refusal is said in the thread. */
export async function boxCompact(convId: string, focus: string): Promise<boolean> {
  if (!boxChatOn() || !session) return false;
  const sess = session;
  const r = await intent(sess, { type: "compact", convId, ...(focus.trim() ? { focus: focus.trim() } : {}) });
  if (!r.ok) {
    sess.notice(convId, `⚠️ ${r.network ? BOX_UNREACHABLE : "Not compacted"}: ${r.error}`);
    if (r.network) sess.kick();
  } else if (r.data?.compacted === false) sess.notice(convId, "Nothing to compact yet.");
  return true;
}

const CLEARED_PREFIX = "vault-chat:cleared:";
function readCleared(vault: string): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(CLEARED_PREFIX + vault) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}
function saveCleared(vault: string, v: Record<string, string>): void {
  try {
    localStorage.setItem(CLEARED_PREFIX + vault, JSON.stringify(v));
  } catch {
    /* no storage: this session only */
  }
}


/** Delete a conversation on the box (a record in its log; every client drops it). False = not box mode. */
export async function boxDelete(convId: string): Promise<boolean> {
  if (!boxChatOn() || !session) return false;
  if (!session.isKnown(convId)) return true;
  const r = await intent(session, { type: "delete", convId });
  return r.ok;
}

/** Steer or stop one running subagent of a box conversation. Returns an error
 *  line, or null on success (also null when this isn't box mode: nothing to do). */
export async function boxSubagent(convId: string, sid: string, op: "steer" | "stop", text?: string): Promise<string | null> {
  if (!boxChatOn() || !session) return "Subagents run on the box — it isn't connected.";
  const r = await httpPost(session.link, `/api/v1/conversations/${encodeURIComponent(convId)}/subagents/${encodeURIComponent(sid)}/${op}`, op === "steer" ? { text: text ?? "" } : {});
  if (!r.ok) return r.error ?? "the box refused";
  return null;
}

/** A voice line, shown at once on this client and written by the box under the same id (server/voice.ts). */
export function boxOutgoingLine(convId: string, id: string, text: string, role: "user" | "assistant" = "user"): void {
  session?.addOutgoing(convId, { id, text, role, line: true });
}

/** The box's id for a local chat (a voice session's conversation it just created). */
export function boxRekey(from: string, to: string): void {
  session?.rekey(from, to);
}
