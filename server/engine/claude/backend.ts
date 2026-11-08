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
  type Effort,
  type EngineBackend,
  type Handlers,
  type LiveChild,
  type ModelChoice,
  type SideRunner,
  type ToolSpec,
} from "../backend";
import { EFFORTS, FALLBACK_MODELS, isEffort, pickerModels } from "./models";
import type { CallRecord } from "../ledger";
import type { UserRequest } from "../piFeed";
import { appendEntries, newSessionFile } from "../../convlog/piSession";
import { McpRuntime, type ProcessServices } from "../../mcp/runtime";
import { CLAUDE_BUILTINS_OFF, ClaudeSession, type SessionSend } from "./session";
import { ruleOnToolUse, WRITING_TOOLS, CALL_WRITE_REASON, externalPath as rulePath } from "./filePolicy";
import { ClaudeSideRuns } from "./side";
import { memoryUpdate, writeClaudeMd, type MemoryMark } from "./memory";
import { ClaudeTranslator, type Emit } from "./translate";
import { sandboxedCli, type ClaudeInstall } from "./install";
import type { ClaudePaths } from "./paths";

/** vault-chat's one path policy (pi's extension owns it today; phase 4 moves it behind MCP). */
export type PathPolicy = Pick<EngineBackend, "externalPath" | "filesystem"> & Partial<Pick<EngineBackend, "nativePath">>;

/** Claude Code's own file tools, the ones vault-chat's policy can rule on. */
export const OWN_FILE_TOOLS: readonly string[] = ["Read", "Write", "Edit", "Glob", "Grep"];

/**
 * A folder's own rules for an agent working in it. pi loaded the cwd's AGENTS.md
 * itself, and the prompt promises it is loaded; Claude Code's project memory is
 * deliberately off (a project folder must not be able to put settings or hooks
 * into a session), so the host reads the file and appends it to the thread's
 * instructions instead — at each session start, so an edit lands on the next one.
 */
export function folderRules(cwd: string): string {
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    try {
      const text = readFileSync(join(cwd, name), "utf8").trim();
      if (text) return `<folder-rules file="${name}">\n${text.slice(0, 20_000)}\n</folder-rules>`;
    } catch {
      /* not there */
    }
  }
  return "";
}

export type ClaudeBackendOptions = {
  install: ClaudeInstall;
  paths: ClaudePaths;
  /** The feed's own sessions folder for this vault: where a thread's transcript goes. */
  feedSessionsDir: string;
  /** The vault whose memory a session carries natively (see claude/memory.ts). */
  vault: string;
  /** Environment for the CLI only (phase 6 puts the sign-in token here). */
  env: () => NodeJS.ProcessEnv;
  /**
   * The host that owns vault-chat's file tools, when there is one. There is
   * not any more: pi owned them, and Claude Code now uses its own under
   * vault-chat's policy (filePolicy.ruleOnToolUse, through the PreToolUse
   * hook). Left optional so a host can still supply them.
   */
  policy?: PathPolicy;
  /**
   * What a turn may not touch, from the sandbox (filePolicy.wallsOf). Given, so
   * Claude Code's OWN file tools can run under vault-chat's one policy instead
   * of pi's tools enforcing it — which is what lets pi go.
   */
  walls?: () => { denyRead: string[]; denyWrite: string[] };
  /**
   * Let Claude Code use its own Read/Write/Edit/Glob/Grep, ruled on by that
   * policy before each call. Off by default while it is proved on a real box:
   * with it off nothing changes, and vault-chat's MCP file tools stay the only
   * way a session touches a file.
   */
  ownFileTools?: boolean;
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
  /** The model the box's one-shots run on (a note's title, spoken maths). */
  fastModel?: string;
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
  /** How hard it thinks, as Carl set it for THIS chat. Absent: the model decides. */
  effort?: Effort;
  instructions: string;
  /** Its pi-format transcript. */
  file: string;
  /** How far the "you" layer has been told to this thread (see youLayer). */
  youUntil?: number;
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
  /** What the memory file looked like when this session last carried it. */
  memory: MemoryMark;
  /** The thinking level this session was last set to (the voice turns it off). */
  thinking?: string;
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
  /** The runtime's own model list, learned from the first session (models()). */
  private modelRows: ModelChoice[] = [];
  private live = new Map<string, Live>();
  private h: Handlers | null = null;
  private started = false;
  private reaper: NodeJS.Timeout | null = null;
  /** Compacting a thread, waiting for the boundary Claude Code reports. */
  private compactWaits = new Map<string, () => void>();
  /** The last rate limit Claude Code reported (the host backs wakes off until it resets). */
  private limit: { status: string; resetsAt: number | null; kindOfLimit: string | null } | null = null;

  constructor(private readonly o: ClaudeBackendOptions) {
    super();
    this.version = o.install.version;
    this.threads = readJson(o.paths.threadsFile);
    this.modelRows = readModels(modelsFile(o.paths.threadsFile));
    this.side = new ClaudeSideRuns({
      // A side run gets the same sandbox and loader wrapper a conversation does.
      cli: (cwd) => sandboxedCli({ install: o.install, dir: o.paths.binDir, name: "claude-side", sandbox: o.sandbox?.() ?? null, writable: [o.paths.configDir, cwd] }),
      env: () => o.env(),
      ...(o.mcp ? { mcp: o.mcp } : {}),
      handlers: () => this.h,
      // Ctrl+K forks the conversation's own Claude Code session, which the
      // engine names by the transcript file it knows.
      sessionOf: (file) => Object.values(this.threads).find((t) => t.file === file)?.sessionId ?? null,
      ...(o.fastModel ? { fastModel: o.fastModel } : {}),
      log: (m) => this.log(m),
    });
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

  /** Its sessions import the vault's memory themselves, so a turn must not repeat it. */
  carriesMemory(): boolean {
    return true;
  }

  /** Carl's Claude subscription is in reach (the value itself is never read out). */
  /**
   * Whether a turn can run at all: Carl's token from the app (the product path),
   * or a Claude Code login already sitting in the config dir this session uses —
   * `claude setup-token`/`claude auth login` leave their credentials there, and a
   * box signed in that way runs turns perfectly well, so reporting "not signed
   * in" for it would be a lie the UI acts on. Only the file's EXISTENCE is
   * checked; nothing reads a credential.
   */
  signedIn(): boolean {
    const env = this.o.env();
    if (env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY) return true;
    const dir = env.CLAUDE_CONFIG_DIR || this.o.paths.configDir;
    return existsSync(join(dir, ".credentials.json"));
  }

  /** No sign-in, no turn: there is nothing else to run it on. */
  cannotRun(): string | null {
    return this.signedIn() ? null : "Sign in with Claude to chat";
  }

  health(): Record<string, unknown> {
    return {
      state: this.started ? "up" : "down",
      // What Settings → Agent shows: "signed in", or "sign in again".
      signedIn: this.signedIn(),
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

  /**
   * Out of headroom until the reset Claude Code named. Only a REJECTED limit
   * holds work back: a warning means there is still room, and a reset that has
   * passed is not a limit any more.
   */
  usageLimit(): { resetsAt: number | null; kind: string | null } | null {
    const l = this.limit;
    if (!l || l.status !== "rejected") return null;
    if (l.resetsAt && l.resetsAt <= Date.now()) return null;
    return { resetsAt: l.resetsAt, kind: l.kindOfLimit };
  }

  stop(): void {
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = null;
    for (const id of [...this.live.keys()]) this.closeLive(id);
  }

  // ------------------------------------------------------------------ threads

  async startThread(o: { cwd: string; model: string; effort?: Effort; instructions: string; tools: ToolSpec[]; subagents: boolean }): Promise<{ threadId: string; ref?: string }> {
    const threadId = `${CLAUDE_THREAD_PREFIX}${randomUUID()}`;
    mkdirSync(this.o.feedSessionsDir, { recursive: true });
    const file = newSessionFile(join(this.o.feedSessionsDir, `${threadId}.jsonl`), o.cwd);
    this.threads[threadId] = { sessionId: null, cwd: o.cwd, model: o.model, ...(o.effort ? { effort: o.effort } : {}), instructions: o.instructions, file };
    this.save();
    return { threadId, ref: file };
  }

  async resumeThread(threadId: string, o: { model: string; effort?: Effort; subagents: boolean; cwd?: string }): Promise<void> {
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
    // Effort is a start option, not a control request: there is no way to tell a
    // running session to think harder. So the session ends and the next turn
    // resumes the same Claude Code session with the new effort — Carl's chat is
    // where it was, and his choice takes hold on what he asks next. A turn in
    // flight is never cut off for it: the choice is saved and the session is
    // left to finish, and the next one it starts has it.
    if (o.effort !== t.effort) {
      t.effort = o.effort;
      if (!this.live.get(threadId)?.turnId) this.closeLive(threadId);
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
    // the divider the clients already draw (translate.ts). Its summary is a turn
    // of its own, so this waits for that boundary — the host draws the divider
    // from the transcript the moment compacting returns, and would otherwise
    // look before there was anything to see.
    const landed = new Promise<void>((r) => this.compactWaits.set(threadId, r));
    live.session.send({ text: customInstructions?.trim() ? `/compact ${customInstructions.trim()}` : "/compact" });
    try {
      await Promise.race([landed, new Promise<void>((r) => {
        const t = setTimeout(r, 120_000);
        t.unref?.();
      })]);
    } finally {
      this.compactWaits.delete(threadId);
    }
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
    const you = await this.youLayer(threadId, t);
    if (o.model && o.model !== t.model) {
      t.model = o.model;
      this.save();
      await live.session.setModel(o.model);
    }
    // A call's turns ask for no thinking: a pause before the first word is a
    // silence Carl hears. Only a change is sent.
    if (o.thinking && o.thinking !== live.thinking) {
      live.thinking = o.thinking;
      await live.session.setThinking(o.thinking);
    }
    const turnId = o.turnId ?? randomUUID();
    live.turnId = turnId;
    this.push(live, { text: promptOf(o.texts, o.context, you), images: o.images }, { text: o.texts.join("\n\n"), request: o.request, images: o.images });
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
    const live = this.live.get(threadId);
    if (!live) return;
    // A stop means stop: what Claude Code has not taken yet is taken back BEFORE
    // the turn is aborted — otherwise it takes the queued message itself the
    // moment the turn ends, and a message Carl's stop should have held is
    // answered anyway.
    await this.clearQueue(threadId);
    // Its end is a stop, not a failure (translate.ts expectInterrupt).
    live.translator.expectInterrupt();
    await live.session.interrupt();
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
    if (this.o.policy) return this.o.policy.externalPath(root, path, write);
    return Promise.resolve(rulePath(root, path, write, this.o.walls?.() ?? { denyRead: [], denyWrite: [] }));
  }

  nativePath(cwd: string, path: unknown): Promise<string | null> {
    return this.o.policy?.nativePath?.(cwd, path) ?? Promise.resolve(null);
  }

  filesystem(...a: Parameters<EngineBackend["filesystem"]>): ReturnType<EngineBackend["filesystem"]> {
    if (this.o.policy) return this.o.policy.filesystem(...a);
    // No host file tools: the session uses Claude Code's own, ruled by the
    // same policy before each call (onToolUse below).
    return Promise.resolve({ specs: [], call: async () => ({ ok: false, text: "no host file tools on this box" }), close: async () => {} } as Awaited<ReturnType<EngineBackend["filesystem"]>>);
  }

  // ------------------------------------------------------------------ side threads (Ctrl+K / Ctrl+L) and one-shots

  readonly side: SideRunner;

  /** This engine holds the conversation whose transcript is `file` (the router asks). */
  ownsFile(file: string): boolean {
    return Object.values(this.threads).some((t) => t.file === file);
  }

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
    const files = await this.filesystem(t.cwd, this.o.fileTools ?? FILE_TOOLS_DEFAULT, services);
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
    // Rewritten at each session start, so a near-cap reminder and the import are current.
    const memory = writeClaudeMd(this.o.paths.configDir, this.o.vault);
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
      ...(t.effort ? { effort: t.effort } : {}),
      // The thread's own instructions, and the rules of the folder it works in.
      instructions: [t.instructions, folderRules(t.cwd)].filter(Boolean).join("\n\n"),
      ...(t.sessionId ? { resume: t.sessionId } : {}),
      configDir: this.o.paths.configDir,
      // Its CLAUDE.md is the vault's memory, imported: Claude Code loads it
      // itself, so memory is in the cached part of the context and not in front
      // of every turn. 'user' here means OUR config dir, which holds only what
      // vault-chat wrote (nothing of Carl's own Claude Code setup).
      settingSources: ["user"],
      env: this.o.env(),
      // Claude Code asks permission for a write it was not pre-approved for, and
      // a session with nobody to ask treats that as a refusal — so the tools the
      // policy rules on are pre-approved here. Reads never needed it, which is
      // why only writes failed. The ruling is the hook's, not this list's.
      ...(tools || this.ownFileTools()
        ? {
            ...(tools ? { mcpServers: tools.servers as never } : {}),
            allowedTools: [...(tools?.allowed ?? []), ...(this.ownFileTools() ? OWN_FILE_TOOLS : [])],
          }
        : {}),
      ...(this.ownFileTools()
        ? {
            // Claude Code's own file tools, under vault-chat's policy: the hook
            // rules on every call before it runs (session.ts onToolUse).
            disallowedTools: CLAUDE_BUILTINS_OFF.filter((n) => !OWN_FILE_TOOLS.includes(n)),
            onToolUse: async (tool: string, input: Record<string, unknown>) => {
              // The voice gate first, and it covers Bash too: on a live call the
              // agent delegates a change instead of making it, so a shell line
              // must not be the way around that. Same answer as vault-chat's own
              // tools give, in the same words.
              if (WRITING_TOOLS.includes(tool) && !(await this.h?.fileWrite?.(threadId))) return CALL_WRITE_REASON;
              const w = this.o.walls?.() ?? { denyRead: [], denyWrite: [] };
              return ruleOnToolUse(tool, input, { cwd: t.cwd, home: process.env.HOME ?? "/", ...w });
            },
          }
        : {}),
      ...(this.h?.afterCompact ? { onCompacted: () => this.h!.afterCompact!(threadId) } : {}),
      onPrompt: async () => {
        const live = this.live.get(threadId);
        if (!live) return "";
        const update = memoryUpdate(this.o.vault, live.memory);
        if (!update) return "";
        live.memory = update.mark;
        return update.text;
      },
      onMessage: (m) => this.onMessage(threadId, m),
      onClosed: (error) => this.onClosed(threadId, error),
      log: (s) => this.log(s),
    });
    const live: Live = { id: threadId, session, translator, turnId: null, lastUsed: Date.now(), pending: new Map(), revoke: tools?.revoke ?? null, memory };
    this.live.set(threadId, live);
    session.start();
    // What the runtime calls its models, asked once per box: the picker shows
    // those names, so vault-chat never keeps a version number of its own.
    if (!this.modelRows.length) void this.learnModels(session);
    return live;
  }

  /**
   * The models a chat can run on. The runtime's own list, newest of each family
   * (claude/models.ts pickerModels) — until a session has answered, the three
   * aliases under names that cannot be wrong.
   */
  models(): ModelChoice[] {
    return this.modelRows.length ? this.modelRows : FALLBACK_MODELS;
  }

  private async learnModels(session: ClaudeSession): Promise<void> {
    const rows = await session.models().catch(() => null);
    if (!rows?.length) return;
    const all = rows.map((r) => ({
      id: String(r.value ?? ""),
      name: String(r.displayName ?? r.value ?? ""),
      efforts: (r.supportsEffort === false ? [] : (r.supportedEffortLevels ?? EFFORTS)).filter(isEffort),
    }));
    const picked = pickerModels(all.filter((m) => m.id && m.name));
    if (!picked.length) return;
    this.modelRows = picked;
    this.log(`models: ${picked.map((m) => m.name).join(", ")}`);
    // Kept, so a box that has run a turn once shows the real names from boot
    // rather than the fallback until the first session of the day.
    try {
      writeFileSync(modelsFile(this.o.paths.threadsFile), JSON.stringify(picked, null, 1));
    } catch (e) {
      this.log(`could not save the model list: ${(e as Error).message}`);
    }
  }

  /** Whether this box lets Claude Code use its own file tools (see the option). */
  private ownFileTools(): boolean {
    // The default now: pi owned the host's file tools and pi is gone, so a
    // session uses Claude Code's own — ruled by vault-chat's policy before
    // every call (ruleOnToolUse, through the PreToolUse hook).
    return this.o.ownFileTools !== false;
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

  /**
   * What Carl did elsewhere since this thread last heard (server/activity.ts).
   * pi's extension asks the host for this before every prompt; Claude Code has
   * no extension, so the host asks and puts it in the prompt itself — which
   * also means it stays in Claude Code's own session from then on, as pi's
   * `vc-you` entry does.
   */
  private async youLayer(threadId: string, t: ThreadState): Promise<string> {
    if (!this.h?.you) return "";
    try {
      const r = await this.h.you({ threadId, since: t.youUntil ?? null });
      if (Number(r?.until) > 0) {
        t.youUntil = Number(r.until);
        this.save();
      }
      return String(r?.text ?? "").trim();
    } catch (e) {
      // Never lose a turn over it: the layer is context, not the message.
      this.log(`the "you" layer for ${threadId} failed: ${(e as Error).message}`);
      return "";
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
        // Compacting waits for its own boundary (see compact()).
        if ((e.entry as { type?: string }).type === "compaction") this.compactWaits.get(threadId)?.();
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

/**
 * The prompt: the host's context above Carl's words, and the "you" layer below
 * them — the order pi's own extension uses, so the model reads the same shape.
 */
function promptOf(texts: string[], context?: string, you?: string): string {
  return [context?.trim(), texts.filter(Boolean).join("\n\n"), you?.trim()].filter(Boolean).join("\n\n");
}

/** Beside the thread ids: the runtime's model list, as last learned. */
const modelsFile = (threadsFile: string) => join(dirname(threadsFile), "models.json");

function readModels(file: string): ModelChoice[] {
  try {
    const rows = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
    return Array.isArray(rows) ? rows.filter((m) => m && typeof m.id === "string" && typeof m.name === "string").map((m) => ({ id: m.id, name: m.name, efforts: (Array.isArray(m.efforts) ? m.efforts : []).filter(isEffort) })) : [];
  } catch {
    return [];
  }
}

function readJson(file: string): Record<string, ThreadState> {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) ?? {}) : {};
  } catch {
    return {};
  }
}
