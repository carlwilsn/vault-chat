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
import { useStore, type ChatMessage, type ChatAttachment, type LiveTool } from "./store";
import { readBoxConfig } from "./vaultSync";
import type { Conversation } from "./conversations";

export const BOX_UNREACHABLE = "Box unreachable — agent runs on the box";

export type BoxChatState = {
  on: boolean;
  /** null = not known yet (first contact pending). */
  reachable: boolean | null;
  reason: string;
};

type Link = { url: string; token: string | null };
type HttpResult = { status: number; body: string };

const POLL_TIMEOUT_MS = 35_000;
const LIST_REFRESH_MS = 60_000;
const DETAIL_N = 200;
const CACHE_PREFIX = "vault-chat:box-chat-cache:";
const CACHE_MAX_CONVS = 30;
const CACHE_MAX_BYTES = 3_000_000;

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
  return { url: cfg.box.replace(/\/+$/, ""), token: useStore.getState().missionHostToken || null };
}

async function httpGet(link: Link, path: string, timeoutMs = 20_000): Promise<any> {
  const r = await invoke<HttpResult>("box_get_json", {
    url: `${link.url}${path}`,
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

async function httpPost(
  link: Link,
  path: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string; data?: Record<string, unknown>; network?: boolean }> {
  let r: HttpResult;
  try {
    r = await invoke<HttpResult>("box_post_json", {
      url: `${link.url}${path}`,
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

// ---------- the box's shapes → the store's ----------

type BoxRow = {
  id: string;
  title?: string;
  lastActivityAt?: number;
  source?: string;
  msgCount?: number;
  missionState?: string;
};

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

const keyOf = (m: { role?: string; content?: string }) =>
  `${m.role === "user" ? "user" : "assistant"}\u0000${(m.content ?? "").slice(0, 20_000)}`;

/** Merge the box's view of a conversation into the local copy.
 *  - `full`: the box's messages ARE the conversation.
 *  - phone shape (the last ≤200 visible messages): keep the local full-fidelity
 *    prefix up to the last message both sides share, then the box's newer tail.
 *  Optimistic local user messages the box has not recorded yet are kept. */
export function mergeBoxMessages(local: ChatMessage[], d: BoxDetail, pending: string[] = []): ChatMessage[] {
  const boxMsgs = Array.isArray(d.messages) ? d.messages : [];
  let merged: ChatMessage[];
  if (d.full) {
    merged = boxMsgs as ChatMessage[];
  } else {
    const B = boxMsgs.map(fromPhoneMessage);
    const visIdx: number[] = [];
    local.forEach((m, i) => {
      if (!m.hidden && !m.boxPending) visIdx.push(i);
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
      const keep = local.slice(0, visIdx[hit.i]! + 1).filter((m) => !m.boxPending);
      merged = [...keep, ...B.slice(hit.j + 1)];
    } else if (L.length === 0 || B.length < DETAIL_N) {
      merged = B; // the box's window is the whole visible conversation
    } else {
      merged = [...local.filter((m) => !m.boxPending), ...B];
    }
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
  "codexThreadId",
  "project",
  "working",
  "nextWakeAt",
  "state",
  "verdict",
  "askOf",
  "askNotifId",
  "askDecided",
  "askDecidedAt",
  "lastActivityAt",
  "createdAt",
] as const;

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
          .filter((m) => !m.boxPending)
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
  private known = new Set<string>();
  private pending = new Map<string, string[]>();
  private detailTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastList = 0;
  private cacheTimer: ReturnType<typeof setTimeout> | null = null;
  private unsub: (() => void) | null = null;
  private wake: (() => void) | null = null;

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
          await this.syncAll();
          this.setReach(true);
          backoff = 1000;
        }
        if (Date.now() - this.lastList > LIST_REFRESH_MS) await this.syncList();
        const r = await httpGet(this.link, `/poll?after=${this.cursor}`, POLL_TIMEOUT_MS);
        if (!this.live()) return;
        this.setReach(true);
        backoff = 1000;
        const next = Number(r?.next);
        const events: any[] = Array.isArray(r?.events) ? r.events : [];
        for (const ev of events) this.onEvent(ev);
        if (Number.isFinite(next)) {
          if (next < (this.cursor ?? 0)) {
            // The ring lost its state: resync everything.
            this.cursor = null;
            continue;
          }
          this.cursor = next;
        }
      } catch (e) {
        if (!this.live()) return;
        this.setReach(false, String((e as Error)?.message ?? e));
        this.cursor = null;
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

  private async syncAll(): Promise<void> {
    await this.syncList();
    try {
      const st = await httpGet(this.link, "/status", 10_000);
      const runs: any[] = Array.isArray(st?.runs) ? st.runs : [];
      for (const r of runs) {
        if (typeof r?.convId === "string") this.scheduleDetail(r.convId, 0);
      }
    } catch {
      /* /status is optional for the chat */
    }
    const active = useStore.getState().activeConversationId;
    if (active && this.known.has(active)) this.scheduleDetail(active, 0);
  }

  async syncList(): Promise<void> {
    this.lastList = Date.now();
    const r = await httpGet(this.link, "/conversations", 15_000);
    if (!this.live()) return;
    const rows: BoxRow[] = Array.isArray(r?.conversations) ? r.conversations : [];
    const s = useStore.getState();
    const byId = new Map(s.conversations.map((c) => [c.id, c]));
    const added: Conversation[] = [];
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
        });
        if (fetches++ < 20) this.scheduleDetail(row.id, 0);
        continue;
      }
      const msgs = local.id === s.activeConversationId ? s.messages : local.messages;
      if (
        (row.msgCount ?? 0) > msgs.length ||
        (row.lastActivityAt ?? 0) > local.lastActivityAt ||
        (row.title && row.title !== local.title)
      ) {
        this.scheduleDetail(row.id, 0);
      }
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
        void this.fetchDetail(id).catch(() => {});
      }, ms),
    );
  }

  async fetchDetail(id: string): Promise<void> {
    let d: BoxDetail;
    try {
      d = await httpGet(this.link, `/conversation?id=${encodeURIComponent(id)}&n=${DETAIL_N}&full=1`, 15_000);
    } catch (e) {
      if ((e as { status?: number }).status === 404) return; // not on the box (yet)
      throw e;
    }
    if (!this.live() || !d || typeof d !== "object") return;
    this.known.add(id);
    this.applyDetail(id, d);
  }

  applyDetail(id: string, d: BoxDetail): void {
    const pend = this.pending.get(id) ?? [];
    const running = d.status === "running";
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
      let messages = mergeBoxMessages(localMsgs, d, pend);
      if (sameMessages(messages, localMsgs)) messages = localMsgs;
      // Settle the optimistic turns the box now has.
      const stillPending = messages.filter((m) => m.boxPending).map((m) => m.content);
      if (stillPending.length !== pend.length) {
        if (stillPending.length) this.pending.set(id, stillPending);
        else this.pending.delete(id);
      }
      const next: Conversation = { ...base, messages };
      if (d.title && d.title !== base.title) next.title = d.title;
      if (d.full && d.meta) {
        for (const k of META_KEYS) {
          if (k in d.meta) (next as Record<string, unknown>)[k] = d.meta[k];
        }
      }
      if (messages !== localMsgs && messages.length > localMsgs.length) {
        next.lastActivityAt = Math.max(base.lastActivityAt, Number(d.meta?.lastActivityAt) || Date.now());
        if (!isActive && base.source !== "worker" && base.source !== "mission") next.unread = true;
      }
      // Status: the box is the truth. An optimistic send keeps "running" until
      // the box has its user turn.
      const wantRunning = running || stillPending.length > 0;
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
          patch.streamingText = "";
          patch.streamingReasoning = "";
          patch.liveTools = [];
        }
      }
      if (!wantRunning && id in s.convRuntime) {
        const rt = { ...s.convRuntime };
        delete rt[id];
        patch.convRuntime = rt;
      }
      return patch;
    });
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
      case "status": {
        if (!id) return;
        const running = e.status === "running";
        this.setStatus(id, running);
        this.scheduleDetail(id, running ? 250 : 0);
        return;
      }
      case "runtime": {
        if (!id) return;
        this.setRuntime(id, String(e.text ?? ""), String(e.tool ?? ""), e.steps, Number(e.startedAt) || undefined);
        return;
      }
      case "message": {
        if (!id) return;
        // A finalized assistant message replaces the live stream.
        if (e.role === "assistant") this.setRuntime(id, "", "", undefined, undefined, true);
        this.scheduleDetail(id, 150);
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
        if (e.phase === "start") this.setStatus(id, true);
        else if (e.phase === "stream" || e.phase === "delta")
          this.setRuntime(id, String(e.text ?? ""), String(e.tool ?? ""), undefined, undefined);
        else if (e.phase === "end") this.setStatus(id, false);
        this.scheduleDetail(id, 150);
        return;
      }
      default:
        if (id) this.scheduleDetail(id, 500);
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
        if (!want) {
          patch.streamingText = "";
          patch.streamingReasoning = "";
          patch.liveTools = [];
        }
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
    clearOnly = false,
  ): void {
    const liveTools: LiveTool[] = tool ? [{ id: `box-live-${tool}`, name: tool, input: {} }] : [];
    const s = useStore.getState();
    if (!clearOnly && !s.conversations.some((c) => c.id === id && c.status === "running")) this.setStatus(id, true);
    if (s.activeConversationId === id) {
      if (clearOnly) {
        if (s.streamingText || s.liveTools.length) useStore.setState({ streamingText: "", liveTools: [] });
        return;
      }
      useStore.setState({
        streamingText: text,
        liveTools,
        busy: true,
        ...(s.busyStartedAt ? {} : { busyStartedAt: startedAt ?? Date.now() }),
      });
    } else {
      if (clearOnly) {
        const rt = s.convRuntime[id];
        if (rt) s.setConvRuntime(id, { ...rt, streamingText: "", liveTools: [] });
        return;
      }
      s.setConvRuntime(id, {
        ...(s.convRuntime[id] ?? { streamingReasoning: "" }),
        streamingText: text,
        streamingReasoning: "",
        liveTools,
        liveSteps: Array.isArray(steps) ? (steps as { thought: string; action: string }[]) : undefined,
        startedAt: startedAt ?? s.convRuntime[id]?.startedAt ?? Date.now(),
      });
    }
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
        if (!hit || hit.messages.length <= c.messages.filter((m) => !m.hidden).length) return c;
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
}): Promise<boolean> {
  if (!boxChatOn() || !session) return false;
  const sess = session;
  const s = useStore.getState();
  const vault = s.vaultPath!;
  const trimmed = opts.text.trim();
  let convId = opts.convId ?? s.activeConversationId;
  if (!convId) convId = s.newConversation();
  if (!trimmed) return true;
  if (opts.attachments && opts.attachments.length) {
    appendTo(convId, {
      role: "assistant",
      system: true,
      content: "⚠️ Images can't be sent to the box yet — the message was NOT sent. Send it as text.",
    });
    return true;
  }
  if (s.boxChat?.reachable === false) {
    sess.kick();
    appendTo(convId, {
      role: "assistant",
      system: true,
      content: `⚠️ ${BOX_UNREACHABLE}. The message was NOT sent.`,
    });
    return true;
  }
  const conv = s.conversations.find((c) => c.id === convId);
  // A conversation the box knows: anything it listed, or any with messages
  // (those files came from the box through git). A fresh local "New chat" is
  // created on the box by omitting the id.
  const knownToBox = sess.isKnown(convId) || (conv?.messages.some((m) => !m.boxPending) ?? false);
  const answer = knownToBox && waitingOnUser(conv);

  // Optimistic: the user's turn shows at once and the thread reads running.
  sess.addPending(convId, trimmed);
  appendTo(convId, { role: "user", content: trimmed, boxPending: true });
  useStore.getState().setConversationStatus(convId, "running");
  if (useStore.getState().activeConversationId === convId) {
    const cur = useStore.getState();
    if (!cur.busy) {
      cur.setBusy(true);
      cur.setBusyStartedAt(Date.now());
      cur.resetStreaming();
    }
  }

  const ctx = (opts.contextPreamble ?? "").trim();
  const payload: Record<string, unknown> = {
    text: relativize(trimmed, vault),
    clientMsgId: newClientMsgId(),
  };
  if (knownToBox) payload.convId = convId;
  if (ctx) payload.context = relativize(ctx, vault);
  if (conv?.project) payload.project = conv.project;
  const r = await sess_post(sess, answer ? "/answer" : "/message", payload);

  if (!r.ok) {
    sess.dropPending(convId, trimmed);
    useStore.setState((st) => {
      const strip = (ms: ChatMessage[]) => {
        const i = ms.map((m) => !!m.boxPending && m.content === trimmed).lastIndexOf(true);
        return i < 0 ? ms : [...ms.slice(0, i), { role: "user" as const, content: trimmed }, ...ms.slice(i + 1)];
      };
      return {
        conversations: st.conversations.map((c) => (c.id === convId ? { ...c, messages: strip(c.messages) } : c)),
        ...(st.activeConversationId === convId ? { messages: strip(st.messages) } : {}),
      };
    });
    appendTo(convId, {
      role: "assistant",
      system: true,
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
  sess.scheduleDetail(boxId, 400);
  return true;
}

function sess_post(sess: BoxChatSession, path: string, payload: Record<string, unknown>) {
  return httpPost(sess.link, path, payload);
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
    appendTo(convId, { role: "assistant", system: true, content: `⚠️ Couldn't send the answer to the box: ${r.error}` });
    return true;
  }
  sess.scheduleDetail(convId, 300);
  return true;
}
