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
import { invoke } from "@tauri-apps/api/core";
import { projectForSend } from "./projects";
import { useStore, type ChatAttachment, type ChatMessage, type LiveTool } from "./store";
import { addPending, removePending, pendingFor } from "./pendingInput";
import { readBoxConfig, boxSyncNow } from "./vaultSync";
import { boxFileChanged } from "./liveReload";
import type { Conversation } from "./conversations";
import type { LogRecord, PollAnswer } from "./convlog/protocol";
import { emptyPicture, emptyRow, foldInto, reduceRow, type Picture, type RowState } from "./convlog/reduce";
import { makeChatView, type ChatView } from "./convlog/view";

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
  /** The ids this client sent (a delivered steer or queued message drops its chip). */
  private sent = new Set<string>();

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
        if (lastActive) this.open(lastActive);
      }
    });
    if (lastActive) this.open(lastActive);
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
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
        const r = (await httpGet(this.link, `/poll?after=${this.cursor}${this.epoch ? `&epoch=${encodeURIComponent(this.epoch)}` : ""}`, POLL_TIMEOUT_MS)) as PollAnswer & { epoch?: string };
        if (!this.live()) return;
        this.setReach(true);
        backoff = 1000;
        if (r.reset || (r.epoch && this.epoch && r.epoch !== this.epoch)) {
          // Another log than the cursor's (the box's log was reset): start over from it.
          this.cursor = null;
          continue;
        }
        this.apply(Array.isArray(r.events) ? r.events : []);
        if (Number.isFinite(r.next)) this.cursor = Math.max(this.cursor ?? 0, r.next);
      } catch (e) {
        if (!this.live()) return;
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
      let row = this.rows.get(r.conv);
      // A conversation born while this client follows the log: every record of it comes here,
      // so its picture folds from nothing (no fetch).
      if (!row && r.type === "conv.created") this.pics.set(r.conv, emptyPicture(r.conv));
      // An older conversation's placeholder row gives way to its records.
      if (!row || row.legacy) row = emptyRow(r.conv);
      let next = reduceRow(row, r);
      if (r.type === "conv.updated" && r.patch && "deleted" in r.patch) next = { ...next, deleted: !!r.patch.deleted } as Deletable;
      this.rows.set(r.conv, next);
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
    // A steer or queued message the log now holds (pending, or delivered): its chip is the log's.
    for (const id of ids) {
      const p = this.pics.get(id);
      for (const chip of pendingFor(id)) {
        if (!chip.qid || !this.sent.has(chip.qid)) continue;
        if (p && (p.pending.some((x) => x.id === chip.qid) || p.items.some((x) => x.id === chip.qid))) removePending(chip.id);
      }
    }
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
        if (row.deleted) continue;
        const p = this.pics.get(id);
        const view = p ? this.viewOf(id)(p) : null;
        const base = (view?.messages ?? prev?.messages.filter((m) => !m.boxPending && !m.boxLocal) ?? []) as ChatMessage[];
        const messages = this.overlay(id, base);
        // Sending: running as far as this client knows, until the log says so.
        const sending = (this.outgoing.get(id) ?? []).some((o) => !o.failed && (o.role ?? "user") === "user" && !o.line);
        const running = (view ? view.running : row.running && !row.asking) || sending;
        const ask = p ? [...p.items].reverse().find((x) => x.kind === "ask" && x.status === "pending") : undefined;
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
          state: row.state as Conversation["state"],
          working: row.working,
          nextWakeAt: row.nextWakeAt,
          costUsd: row.costUsd,
          queued: (view?.pending ?? []).map((x) => ({ id: x.id, text: x.text, kind: x.kind })),
          pendingAsk: ask ? { question: ask.question ?? "", options: ask.options ?? [], at: ask.at } : undefined,
          ...(p
            ? { todos: view?.todos ?? undefined, subagents: (p.meta.subagents ?? []) as Conversation["subagents"], contextWindow: view?.window ?? prev?.contextWindow, threadId: p.meta.threadId }
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
        patch.conversations = (conversations as Conversation[]).filter((c) => !gone.has(c.id)).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
      }
      return Object.keys(patch).length ? patch : {};
    });
    this.scheduleCache();
  }

  /** The log's messages, then this client's own still on their way (by id: one the log holds is the log's). */
  private overlay(id: string, base: ChatMessage[]): ChatMessage[] {
    const out = this.outgoing.get(id) ?? [];
    const notes = this.notices.get(id) ?? [];
    if (!out.length && !notes.length) return base;
    const have = new Set(base.map((m) => m.mid));
    const still = out.filter((o) => !have.has(o.id));
    if (still.length !== out.length) {
      if (still.length) this.outgoing.set(id, still);
      else this.outgoing.delete(id);
    }
    if (!still.length && !notes.length) return base;
    // What never reached the box (a notice, a message not delivered) stays after the log's message
    // it followed (by id); this client's messages on their way come last.
    const anchored = new Map<string | null, ChatMessage[]>();
    const anchor = (after: string | null | undefined, ms: ChatMessage[]) => anchored.set(after ?? null, [...(anchored.get(after ?? null) ?? []), ...ms]);
    for (const n of notes) anchor(n.after, [{ role: "assistant", system: true, boxLocal: true, content: n.text, mid: n.id }]);
    const mine: ChatMessage[] = [];
    for (const o of still) {
      const msg: ChatMessage = { role: o.role ?? "user", content: o.text, mid: o.id, ...(o.failed ? { boxLocal: true } : { boxPending: true }), ...(o.attachments?.length ? { attachments: o.attachments } : {}) };
      if (o.failed) anchor(o.after, [msg, { role: "assistant", system: true, boxLocal: true, content: o.failed, mid: `${o.id}:failed` }]);
      else mine.push(msg);
    }
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

  noteSent(id: string): void {
    this.sent.add(id);
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

/** One intent to the box (POST /api/v2/intent). */
function intent(sess: BoxChatSession, body: Record<string, unknown>) {
  return httpPost(sess.link, "/api/v2/intent", body);
}

/**
 * Send one chat turn to the box. Returns false when this isn't box mode (the
 * caller then runs its own path). While a turn runs it steers it (Enter) or
 * queues after it (Tab, `mode: "queue"`); an open question takes it as the answer.
 */
export async function boxSend(opts: { text: string; contextPreamble?: string; attachments?: ChatAttachment[]; convId?: string | null; mode?: "steer" | "queue" }): Promise<boolean> {
  if (!boxChatOn() || !session) return false;
  const sess = session;
  const s = useStore.getState();
  const vault = s.vaultPath!;
  const trimmed = opts.text.trim();
  let convId = opts.convId ?? s.activeConversationId;
  if (!convId) convId = s.newConversation();
  const images = boxImages(opts.attachments);
  if (!trimmed && !images.length) return true;
  const shown = trimmed || "(image)";
  if (s.boxChat?.reachable === false) {
    // Kept on screen as Carl's, marked as not sent (never dropped).
    sess.kick();
    const id = newClientId();
    sess.addOutgoing(convId, { id, text: shown, attachments: opts.attachments });
    sess.failOutgoing(convId, id, `⚠️ ${BOX_UNREACHABLE}. The message was NOT sent.`);
    return true;
  }
  const row = sess.row(convId);
  const conv = s.conversations.find((c) => c.id === convId);
  const ctx = (opts.contextPreamble ?? "").trim();
  const clientId = newClientId();
  const base: Record<string, unknown> = {
    convId,
    clientId,
    text: relativize(trimmed, vault),
    ...(images.length ? { images } : {}),
    ...(ctx ? { context: relativize(ctx, vault) } : {}),
  };
  const refused = (r: { network?: boolean; error?: string }, what: string) =>
    r.network ? `⚠️ ${BOX_UNREACHABLE}: ${r.error}. The ${what} was NOT delivered.` : `⚠️ The box refused the ${what}: ${r.error}`;
  // An open question: this is the answer.
  if (row?.asking) {
    sess.addOutgoing(convId, { id: clientId, text: shown, attachments: opts.attachments });
    const r = await intent(sess, { ...base, type: "answer" });
    if (!r.ok) {
      sess.failOutgoing(convId, clientId, refused(r, "answer"));
      if (r.network) sess.kick();
    }
    return true;
  }
  // A running turn: pi's steer (Enter) or follow-up (Tab). A chip until the log has it.
  if (row?.running || conv?.status === "running") {
    const kind = opts.mode === "queue" ? "queue" : "steer";
    sess.noteSent(clientId);
    const chip = addPending({ convId, kind, text: shown, sending: true, qid: clientId });
    const r = await intent(sess, { ...base, type: kind });
    if (!r.ok) {
      removePending(chip.id);
      sess.notice(convId, refused(r, "message"));
      if (r.network) sess.kick();
    }
    return true;
  }
  // A new turn: Carl's message shows at once, under the id the box echoes back.
  sess.addOutgoing(convId, { id: clientId, text: shown, attachments: opts.attachments });
  if (conv?.project && !row) base.project = projectForSend(conv.project);
  const r = await intent(sess, { ...base, type: "send" });
  if (!r.ok) {
    sess.failOutgoing(convId, clientId, refused(r, "message"));
    if (r.network) sess.kick();
  }
  return true;
}

/** Take a queued (or steering) message back from the box before pi delivers it. */
export async function boxUnqueue(convId: string, id: string): Promise<boolean> {
  if (!boxChatOn() || !session) return false;
  const r = await intent(session, { type: "unqueue", convId, id });
  return r.ok;
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
  const convId = s.activeConversationId ?? s.newConversation();
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
