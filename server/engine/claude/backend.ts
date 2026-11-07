// EngineBackend on Claude Code (the Claude Agent SDK). One warm session per
// conversation; the engine drives it exactly as it drives pi.
//
// A conversation's thread id is this backend's own (`cc-…`), minted at
// startThread, so the router can tell whose thread it is from the id alone
// after a restart. Claude Code's session id is kept beside it in box state and
// is what `resume` uses.
//
// The transcript is a pi-format session file in the feed's own sessions folder
// (server/convlog/log.ts: "pi-format session files for what no pi wrote"),
// written here from the translator's entries — so the feed, the three clients,
// SearchHistory and the turn log are untouched.
//
// So a conversation has two records of itself, each authoritative for its own
// reader, and that is deliberate: Claude Code's session is what the model is
// given back on resume, and the pi-format file is what Carl's screens read.
// They are not copies of each other. The prompt the model gets carries the
// host's context above Carl's words, while the entry carries only his words,
// which is what the chat should show; and when Claude Code compacts its session
// the file still holds the whole conversation, so nothing Carl can scroll back
// to is lost.
//
// Not this phase: vault-chat's tools (phase 4 binds them as MCP per run, which
// is why `startTurn`'s tool list is not used here yet), side threads (phase 5)
// and the sign-in token (phase 6). Path policy is vault-chat's one policy,
// handed in rather than copied.
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  ThreadUnknownError,
  type BackendEvent,
  type Detached,
  type EngineBackend,
  type Handlers,
  type LiveChild,
  type SideRunner,
  type ToolSpec,
} from "../backend";
import type { CallRecord } from "../ledger";
import type { UserRequest } from "../piFeed";
import { appendEntries, newSessionFile } from "../../convlog/piSession";
import { McpRuntime, type ProcessServices } from "../../mcp/runtime";
import { ClaudeSession, type SessionSend } from "./session";
import { ClaudeTranslator, type Emit } from "./translate";
import { sandboxedCli, type ClaudeInstall } from "./install";
import type { ClaudePaths } from "./paths";

/** vault-chat's one path policy (pi's extension owns it today; phase 4 moves it behind MCP). */
export type PathPolicy = Pick<EngineBackend, "externalPath" | "filesystem"> & Partial<Pick<EngineBackend, "nativePath">>;

export type ClaudeBackendOptions = {
  install: ClaudeInstall;
  paths: ClaudePaths;
  /** The feed's own sessions folder for this vault: where a thread's transcript goes. */
  feedSessionsDir: string;
  /** Environment for the CLI only (phase 6 puts the sign-in token here). */
  env: () => NodeJS.ProcessEnv;
  policy: PathPolicy;
  /**
   * vault-chat's tools, bound per session over the host's loopback MCP server
   * (server/mcp/runtime.ts). The bearer it issues goes in the session's
   * `mcpServers[].headers` and nowhere else — never argv, env or a file.
   */
  mcp?: McpRuntime;
  /** The file tools the binding offers (vault-chat's, which enforce its path policy). */
  fileTools?: string[];
  /** A tool call's wall-clock cap. AskUser and StartJob wait on Carl, so it is generous. */
  toolTimeoutMs?: number;
  /**
   * The outer sandbox a session runs in (bubblewrap argv ending with "--"), read
   * at each session start so a newly registered folder is never missed; null on
   * a box with no sandbox. Claude Code's own config dir is carved out writable.
   */
  sandbox?: () => string[] | null;
  /** MCP servers to add to vault-chat's own (tests). */
  mcpServers?: (threadId: string) => Record<string, unknown> | undefined;
  /** Close a session that has been idle this long (the id is kept; the next turn resumes it). */
  idleMs?: number;
  /** Sessions alive at once on the box (a subscription has usage limits). */
  maxSessions?: number;
  log?: (s: string) => void;
};

/** What survives a restart for one thread. */
type ThreadState = {
  /** Claude Code's session id, once it has told us one. */
  sessionId: string | null;
  cwd: string;
  model: string;
  instructions: string;
  /** Its pi-format transcript. */
  file: string;
};

/** One message pushed into a session's input, and the user entry it will become. */
type Pushed = {
  /** What the feed shows (Carl's words, without the host's context). */
  text: string;
  request?: UserRequest;
  images: string[];
  priority?: "later" | "now";
};

type Live = {
  id: string;
  session: ClaudeSession;
  translator: ClaudeTranslator;
  /** The turn in flight, and whether the engine asked for it. */
  turnId: string | null;
  lastUsed: number;
  /** Pushed and not delivered yet: what clearQueue can take back, and the feed
   *  entry each one becomes once Claude Code actually consumes it. */
  pending: Map<string, Pushed>;
  /** Withdraws this session's MCP tools when it ends. */
  revoke: (() => Promise<void>) | null;
};

/** Thread ids this backend owns. The router needs no state to tell them apart. */
export const CLAUDE_THREAD_PREFIX = "cc-";

/** vault-chat's MCP server name. The clients strip this prefix (src/mcpNames.ts). */
export const MCP_SERVER = "vault_chat";
/** The file tools a conversation's session gets (vault-chat's, which enforce its policy). */
const FILE_TOOLS_DEFAULT = ["read", "bash", "edit", "write"];
export const isClaudeThread = (threadId: string): boolean => threadId.startsWith(CLAUDE_THREAD_PREFIX);

export class ClaudeCodeBackend extends EventEmitter implements EngineBackend {
  readonly name = "claude";
  readonly version: string;
  private threads: Record<string, ThreadState> = {};
  private live = new Map<string, Live>();
  private h: Handlers | null = null;
  private started = false;
  private reaper: NodeJS.Timeout | null = null;
  /** The last rate limit Claude Code reported (the host backs wakes off until it resets). */
  private limit: { status: string; resetsAt: number | null; kindOfLimit: string | null } | null = null;

  constructor(private readonly o: ClaudeBackendOptions) {
    super();
    this.version = o.install.version;
    this.threads = readJson(o.paths.threadsFile);
  }

  private log(s: string): void {
    (this.o.log ?? ((m: string) => console.log(`[claude] ${m}`)))(s);
  }

  // ------------------------------------------------------------------ lifecycle

  setHandlers(h: Handlers): void {
    this.h = h;
  }

  get handlers(): Handlers | null {
    return this.h;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    mkdirSync(this.o.paths.configDir, { recursive: true });
    mkdirSync(dirname(this.o.paths.threadsFile), { recursive: true });
    this.reaper = setInterval(() => this.reapIdle(), 60_000);
    this.reaper.unref?.();
    this.log(`Claude Code ${this.version} at ${this.o.install.cli} (${this.o.install.source})`);
    this.emit("up");
  }

  async ready(_ms?: number): Promise<boolean> {
    return this.started;
  }

  health(): Record<string, unknown> {
    return {
      state: this.started ? "up" : "down",
      version: this.version,
      cli: this.o.install.cli,
      source: this.o.install.source,
      sessions: this.live.size,
      threads: Object.keys(this.threads).length,
      ...(this.limit ? { rateLimit: this.limit } : {}),
    };
  }

  /** The last rate limit Claude Code reported, for the host's back-off. */
  rateLimit(): { status: string; resetsAt: number | null; kindOfLimit: string | null } | null {
    return this.limit;
  }

  stop(): void {
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = null;
    for (const id of [...this.live.keys()]) this.closeLive(id);
  }

  // ------------------------------------------------------------------ threads

  async startThread(o: { cwd: string; model: string; instructions: string; tools: ToolSpec[]; subagents: boolean }): Promise<{ threadId: string; ref?: string }> {
    const threadId = `${CLAUDE_THREAD_PREFIX}${randomUUID()}`;
    mkdirSync(this.o.feedSessionsDir, { recursive: true });
    const file = newSessionFile(join(this.o.feedSessionsDir, `${threadId}.jsonl`), o.cwd);
    this.threads[threadId] = { sessionId: null, cwd: o.cwd, model: o.model, instructions: o.instructions, file };
    this.save();
    return { threadId, ref: file };
  }

  async resumeThread(threadId: string, o: { model: string; subagents: boolean; cwd?: string }): Promise<void> {
    const t = this.threads[threadId];
    if (!t) throw new ThreadUnknownError(`no Claude Code thread ${threadId}`);
    if (o.cwd && o.cwd !== t.cwd) {
      // Its folder moved (a project was re-opened elsewhere): the session restarts there.
      t.cwd = o.cwd;
      this.closeLive(threadId);
    }
    if (o.model && o.model !== t.model) {
      t.model = o.model;
      const live = this.live.get(threadId);
      if (live) await live.session.setModel(o.model);
    }
    this.save();
    await this.open(threadId);
  }

  holds(threadId: string): boolean {
    return this.live.has(threadId);
  }

  forget(threadId: string): void {
    this.closeLive(threadId);
  }

  threadSource(threadId: string): { file: string; instr: string; cwd: string } | null {
    const t = this.threads[threadId];
    return t ? { file: t.file, instr: "", cwd: t.cwd } : null;
  }

  async note(threadId: string, data: Record<string, unknown>): Promise<boolean> {
    const t = this.threads[threadId];
    if (!t) return false;
    // vault-chat's own line: a pi custom entry, not in the model's context, and
    // this backend owns the file, so it is appended directly.
    appendEntries(t.file, [{ type: "custom", customType: "vc-note", data }]);
    return true;
  }

  async compact(threadId: string, customInstructions?: string): Promise<{ tokensBefore?: number; summary?: string }> {
    const live = await this.open(threadId);
    if (!live) throw new ThreadUnknownError(`no Claude Code thread ${threadId}`);
    // Claude Code summarises on its own command; the boundary it reports becomes
    // the divider the clients already draw (translate.ts).
    live.session.send({ text: customInstructions?.trim() ? `/compact ${customInstructions.trim()}` : "/compact" });
    return {};
  }

  // ------------------------------------------------------------------ turns

  async startTurn(
    threadId: string,
    o: { texts: string[]; context?: string; request?: UserRequest; images: string[]; model: string; turnId?: string; thinking?: string },
  ): Promise<{ turnId: string | null }> {
    const t = this.threads[threadId];
    if (!t) throw new ThreadUnknownError(`no Claude Code thread ${threadId}`);
    const live = (await this.open(threadId))!;
    if (o.model && o.model !== t.model) {
      t.model = o.model;
      this.save();
      await live.session.setModel(o.model);
    }
    const turnId = o.turnId ?? randomUUID();
    live.turnId = turnId;
    this.push(live, { text: promptOf(o.texts, o.context), images: o.images }, { text: o.texts.join("\n\n"), request: o.request, images: o.images });
    this.ev({ kind: "turnStarted", threadId, turnId });
    return { turnId };
  }

  async steer(threadId: string, _turnId: string, o: { texts: string[]; context?: string; request?: UserRequest; images: string[] }): Promise<void> {
    const t = this.threads[threadId];
    const live = await this.open(threadId);
    if (!t || !live) throw new ThreadUnknownError(`no Claude Code thread ${threadId}`);
    // No priority: Claude Code folds it into the running turn after the current tool result.
    this.push(live, { text: promptOf(o.texts, o.context), images: o.images }, { text: o.texts.join("\n\n"), request: o.request, images: o.images });
  }

  async followUp(threadId: string, o: { texts: string[]; context?: string; request?: UserRequest; images?: string[] }): Promise<void> {
    const t = this.threads[threadId];
    const live = await this.open(threadId);
    if (!t || !live) throw new ThreadUnknownError(`no Claude Code thread ${threadId}`);
    // Its own next turn.
    this.push(live, { text: promptOf(o.texts, o.context), images: o.images ?? [], priority: "later" }, { text: o.texts.join("\n\n"), request: o.request, images: o.images ?? [] });
  }

  async clearQueue(threadId: string): Promise<{ steering: string[]; followUp: string[] }> {
    const live = this.live.get(threadId);
    if (!live) return { steering: [], followUp: [] };
    const steering: string[] = [];
    const followUp: string[] = [];
    for (const [uuid, m] of [...live.pending]) {
      const taken = await live.session.withdraw(uuid);
      // Either way it stops being ours to deliver: `pending` holds only messages
      // Claude Code has not consumed, so one it refuses to give back is one it
      // has just taken, and its entry is already written.
      live.pending.delete(uuid);
      if (taken) (m.priority === "later" ? followUp : steering).push(m.text);
    }
    return { steering, followUp };
  }

  async interrupt(threadId: string, _turnId: string): Promise<void> {
    await this.live.get(threadId)?.session.interrupt();
  }

  // ------------------------------------------------------------------ cost: Claude Code reports usage, not price

  usageCalls(_ref: string | undefined, _turnId?: string | null): CallRecord[] {
    return [];
  }

  childUsageCalls(_threadId: string): CallRecord[] {
    return [];
  }

  // ------------------------------------------------------------------ files: vault-chat's one policy

  externalPath(root: string, path: unknown, write = false): Promise<string | null> {
    return this.o.policy.externalPath(root, path, write);
  }

  nativePath(cwd: string, path: unknown): Promise<string | null> {
    return this.o.policy.nativePath?.(cwd, path) ?? Promise.resolve(null);
  }

  filesystem(...a: Parameters<EngineBackend["filesystem"]>): ReturnType<EngineBackend["filesystem"]> {
    return this.o.policy.filesystem(...a);
  }

  // ------------------------------------------------------------------ side threads: phase 5

  readonly side: SideRunner = {
    start: async () => {
      throw new Error("side threads do not run on Claude Code yet");
    },
    poll: async () => null,
    wait: async () => {
      throw new Error("side threads do not run on Claude Code yet");
    },
    stop: async () => false,
    forget: () => {},
    health: () => ({ state: "not implemented" }),
  };

  get paths(): { sessionsDir: string; instrDir: string } {
    return { sessionsDir: this.o.paths.sessionsDir, instrDir: this.o.paths.instrDir };
  }

  // ------------------------------------------------------------------ background work: Claude Code's own subagents

  async background(): Promise<Record<string, unknown>> {
    // Carl's decision: vault-chat's own workers go; the agent uses Claude Code's
    // subagents (its Agent tool, run_in_background), and a background task that
    // finishes while idle starts its own turn, which the engine takes as a turn.
    throw new Error("this engine has no workers of its own: use a background subagent");
  }

  async subagentControl(childId: string, op: "steer" | "stop", _text?: string): Promise<{ ok: boolean; error?: string }> {
    if (op !== "stop") return { ok: false, error: "a Claude Code subagent cannot be steered" };
    for (const live of this.live.values()) {
      const stop = (live.session as unknown as { stopTask?: (id: string) => Promise<void> }).stopTask;
      if (stop) {
        try {
          await stop.call(live.session, childId);
          return { ok: true };
        } catch {
          /* not this session's task */
        }
      }
    }
    return { ok: false, error: "no such background task" };
  }

  detach(): Detached[] {
    return [];
  }

  /** Claude Code's subagents are its own; vault-chat keeps no children here. */
  liveChildren(): LiveChild[] {
    return [];
  }

  // ------------------------------------------------------------------ the session, and its stream

  /**
   * vault-chat's tools for one session: the host catalog the engine answers,
   * plus vault-chat's own file tools, bound over the loopback MCP server. The
   * bearer it issues is handed to Claude Code only in the session's HTTP
   * headers, so it is never in argv, the environment or a file.
   */
  private async bindTools(threadId: string, t: ThreadState): Promise<{ servers: Record<string, unknown>; allowed: string[]; revoke: () => Promise<void> } | null> {
    if (!this.o.mcp || !this.h) return null;
    const specs = await this.h.toolCatalog("conversation");
    const services: ProcessServices = {
      ...(this.h.you ? { you: (since: number | null) => this.h!.you!({ threadId, since }) } : {}),
      env: () => ({}),
      fileWrite: async () => !!(await this.h?.fileWrite?.(threadId)),
    };
    // vault-chat's file tools, not Claude Code's: these are what enforce
    // realpath and the deny rules, the voice write gate and live edits.
    const files = await this.o.policy.filesystem(t.cwd, this.o.fileTools ?? FILE_TOOLS_DEFAULT, services);
    const all = [...specs, ...files.specs];
    const scope = await this.o.mcp.bind(
      {
        specs: all,
        call: (name, args, context) =>
          files.specs.some((f) => f.name === name)
            ? files.call(name, args, context)
            : this.h
              ? this.h.toolCall(threadId, name, args, context.signal, this.h.notifyScope?.(threadId) ?? null)
              : Promise.resolve({ ok: false, text: "Engine not ready." }),
      },
      services,
    );
    // An http server is told to always load here; an in-process one carries it
    // on its own tools (createSdkMcpServer's alwaysLoad). Either way it must:
    // Claude Code defers MCP tools behind its ToolSearch by default, and
    // ToolSearch is one of the built-ins this host turns off, so a deferred
    // tool reaches the model as a placeholder it can never open.
    const extra = Object.fromEntries(
      Object.entries(this.o.mcpServers?.(threadId) ?? {}).map(([n, c]) => {
        const cfg = c as Record<string, unknown>;
        return [n, cfg.type === "http" || cfg.type === "sse" ? { alwaysLoad: true, ...cfg } : cfg];
      }),
    );
    return {
      servers: {
        [MCP_SERVER]: {
          type: "http",
          url: scope.bootstrap.url,
          headers: { Authorization: scope.bootstrap.authorization },
          // Not deferred behind tool search: vault-chat's tools ARE the agent's hands.
          alwaysLoad: true,
          // AskUser and StartJob wait on Carl, so a call is not a few seconds.
          timeout: this.o.toolTimeoutMs ?? 6 * 3_600_000,
        },
        ...extra,
      },
      // Pre-approved per server, not per tool: the host's own policy decides
      // what a tool may do, and the list cannot go stale against the catalog.
      allowed: [MCP_SERVER, ...Object.keys(extra)].map((n) => `mcp__${n}`),
      revoke: scope.revoke,
    };
  }

  /** The thread's live session, started (or resumed) if it is not up. */
  private async open(threadId: string): Promise<Live | null> {
    const t = this.threads[threadId];
    if (!t) return null;
    const existing = this.live.get(threadId);
    if (existing && !existing.session.closed) {
      existing.lastUsed = Date.now();
      return existing;
    }
    if (existing) this.live.delete(threadId);
    this.makeRoom();
    const tools = await this.bindTools(threadId, t);
    const translator = new ClaudeTranslator();
    const session = new ClaudeSession({
      // The same outer sandbox pi runs in, with Claude Code's own config dir
      // carved back out: the state dir is read-only in there, and the CLI has to
      // be able to write its own config and (phase 6) keep its sign-in.
      cli: sandboxedCli({
        install: this.o.install,
        dir: this.o.paths.binDir,
        name: `claude-${threadId}`,
        sandbox: this.o.sandbox?.() ?? null,
        writable: [this.o.paths.configDir, t.cwd],
      }),
      cwd: t.cwd,
      model: t.model,
      instructions: t.instructions,
      ...(t.sessionId ? { resume: t.sessionId } : {}),
      configDir: this.o.paths.configDir,
      env: this.o.env(),
      ...(tools ? { mcpServers: tools.servers as never, allowedTools: tools.allowed } : {}),
      onMessage: (m) => this.onMessage(threadId, m),
      onClosed: (error) => this.onClosed(threadId, error),
      log: (s) => this.log(s),
    });
    const live: Live = { id: threadId, session, translator, turnId: null, lastUsed: Date.now(), pending: new Map(), revoke: tools?.revoke ?? null };
    this.live.set(threadId, live);
    session.start();
    return live;
  }

  private push(live: Live, s: SessionSend, entry: Pushed): void {
    const uuid = randomUUID();
    live.pending.set(uuid, { ...entry, ...(s.priority ? { priority: s.priority } : {}) });
    try {
      live.session.send({ ...s, uuid });
    } catch (e) {
      // It was never sent, so it is not waiting for delivery either.
      live.pending.delete(uuid);
      throw e;
    }
    live.lastUsed = Date.now();
  }

  /**
   * Claude Code has consumed these pushed messages, so each becomes the feed's
   * user entry now — not when it was pushed. That is what makes a queued
   * message pending in the chat until its turn takes it, exactly as with pi:
   * the entry (and the pointer the feed writes for it) is the delivery.
   */
  private deliver(live: Live, t: ThreadState, uuids: unknown): void {
    for (const u of Array.isArray(uuids) ? uuids : [uuids]) {
      const p = typeof u === "string" ? live.pending.get(u) : undefined;
      if (!p) continue;
      live.pending.delete(u as string);
      this.writeUserEntry(t, p.text, p.request, p.images);
    }
  }

  /** Carl's message, as the feed's user entry (the client's identity rides on it). */
  private writeUserEntry(t: ThreadState, text: string, request: UserRequest | undefined, images: string[]): void {
    const content: Record<string, unknown>[] = [{ type: "text", text }];
    for (const url of images) {
      const m = /^data:([^;,]+);base64,(.+)$/s.exec(url);
      if (m) content.push({ type: "image", data: m[2], mimeType: m[1] });
    }
    appendEntries(t.file, [{ type: "message", message: { role: "user", content, ...(request ? { vcRequest: request } : {}) } }]);
  }

  private onMessage(threadId: string, m: SDKMessage): void {
    const live = this.live.get(threadId);
    const t = this.threads[threadId];
    if (!live || !t) return;
    live.lastUsed = Date.now();
    // Which of our pushed messages this turn has taken, in the order it took them.
    const stamped = (m as any).user_message_uuids ?? (m as any).user_message_uuid;
    if (stamped !== undefined) this.deliver(live, t, stamped);
    // An unprompted turn (a background task finished while idle) is a turn too.
    if (!live.turnId && m.type === "stream_event" && (m as any).event?.type === "message_start") {
      live.turnId = randomUUID();
      this.ev({ kind: "turnStarted", threadId, turnId: live.turnId });
    }
    for (const e of live.translator.step(m)) this.apply(threadId, live, t, e);
  }

  private apply(threadId: string, live: Live, t: ThreadState, e: Emit): void {
    switch (e.kind) {
      case "entry":
        appendEntries(t.file, [e.entry]);
        return;
      case "live":
        this.ev({ kind: "pi", threadId, ev: e.ev });
        return;
      case "usage":
        this.ev({ kind: "usage", threadId, usage: e.usage });
        return;
      case "session":
        if (t.sessionId !== e.id) {
          t.sessionId = e.id;
          this.save();
        }
        return;
      case "rateLimit":
        this.limit = { status: e.status, resetsAt: e.resetsAt, kindOfLimit: e.kindOfLimit };
        this.emit("rateLimit", this.limit);
        return;
      case "done": {
        // What is still pending was never consumed by this turn (it is queued
        // for the next one, or was taken back), so nothing is delivered here.
        // Only Claude Code's own uuid stamp says a message has been taken.
        const turnId = live.turnId;
        live.turnId = null;
        this.ev({ kind: "turnCompleted", threadId, turnId, status: e.status, error: e.error });
        return;
      }
    }
  }

  private onClosed(threadId: string, error: Error | null): void {
    const live = this.live.get(threadId);
    this.live.delete(threadId);
    void live?.revoke?.().catch(() => undefined);
    if (error) this.log(`thread ${threadId} ended: ${error.message}`);
    if (!live?.turnId) return;
    // It died mid-turn: the engine marks that turn cut and resumes it, as it does for pi.
    this.ev({ kind: "threadLost", threadId });
  }

  /** Raise a BackendEvent (tests and the engine read these). */
  ev(e: BackendEvent): void {
    this.emit("event", e);
  }

  private makeRoom(): void {
    const max = this.o.maxSessions ?? 4;
    while (this.live.size >= max) {
      const oldest = [...this.live.values()].filter((l) => !l.turnId).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!oldest) return; // every session is in a turn: the cap bends rather than cutting work short
      this.closeLive(oldest.id);
    }
  }

  private reapIdle(): void {
    const idle = this.o.idleMs ?? 10 * 60_000;
    const now = Date.now();
    for (const live of [...this.live.values()]) if (!live.turnId && now - live.lastUsed > idle) this.closeLive(live.id);
  }

  private closeLive(threadId: string): void {
    const live = this.live.get(threadId);
    if (!live) return;
    this.live.delete(threadId);
    live.session.close();
    // Its tools go with it: the bearer stops working the moment the session does.
    void live.revoke?.().catch(() => undefined);
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.o.paths.threadsFile), { recursive: true });
      writeFileSync(this.o.paths.threadsFile, JSON.stringify(this.threads, null, 1));
    } catch (e) {
      this.log(`could not save thread ids: ${(e as Error).message}`);
    }
  }
}

/** The prompt: Carl's text, with the host's context above it where there is any. */
function promptOf(texts: string[], context?: string): string {
  const body = texts.filter(Boolean).join("\n\n");
  return context?.trim() ? `${context.trim()}\n\n${body}` : body;
}

function readJson(file: string): Record<string, ThreadState> {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) ?? {}) : {};
  } catch {
    return {};
  }
}
