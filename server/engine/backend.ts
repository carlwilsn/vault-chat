// The engine's contract with an agent runtime. engine.ts knows only this file;
// pi is one implementation of it (pi/backend.ts), Claude Code will be another
// (claude/). Everything here is neutral: no pi process, session file or
// extension appears in a type, even where a comment still names pi as the
// runtime that happens to produce it today.
//
// The names are the ones the engine already used, so an implementation is free
// to mean something else by a "thread" (a pi session; a Claude Code session) as
// long as it answers for the ids it hands out.
import type { CallRecord } from "./ledger";
import type { ThreadTokenUsage } from "./context";
import type { UserRequest } from "./piFeed";
import type { TurnLine } from "./turnLog";
import type { ProcessServices } from "../mcp/runtime";
import type { BoundTools } from "../mcp/tools";

// ---- what the engine (./engine.ts) sees: neutral events and the two handlers it answers
/** `readOnly`: the tool changes nothing (Ctrl+K / Ctrl+L side threads get every such tool: pi/side.ts). */
/**
 * How hard a chat thinks. A runtime that has no such control ignores it; Claude
 * Code takes it as a start option (claude/session.ts).
 */
export type Effort = "low" | "medium" | "high" | "max";

/** One model a chat can run on, as a client shows it: a real name, never an id. */
export type ModelChoice = { id: string; name: string; efforts: Effort[] };

export type ToolSpec = { type: "function"; name: string; description: string; inputSchema: Record<string, unknown>; readOnly?: boolean };

/** What the runtime reports, in neutral terms. Every event names the thread it
 * belongs to; subagent threads report under their own ids (the engine maps
 * them to the parent conversation from the `subagents` event). */
export type BackendEvent =
  | { kind: "turnStarted"; threadId: string; turnId: string }
  /** One live session event in pi's shape, as the feed and all three clients read it
   * (the engine maps it into the log, 1:1: ../piMap.ts). A backend that is not pi
   * translates its own stream into this shape rather than changing the clients. */
  | { kind: "pi"; threadId: string; ev: any }
  /** The context size of the last model call, and the model's window. */
  | { kind: "usage"; threadId: string; usage: ThreadTokenUsage }
  /** The parent spawned/messaged subagents. */
  | { kind: "subagents"; threadId: string; itemId: string; children: string[]; op: string; prompt?: string; model?: string | null; done: boolean; ok: boolean }
  | { kind: "subagentStatus"; threadId: string; child: string; status: string; path?: string; patch?: Record<string, unknown> }
  | { kind: "turnCompleted"; threadId: string; turnId: string | null; status: "completed" | "interrupted" | "failed" | string; error: string | null }
  /** One thread's runtime died mid-turn while the rest of the runtime is fine (pi: one process per thread).
   * The engine marks that turn cut and resumes it, as it does for all turns on "down". */
  | { kind: "threadLost"; threadId: string }
  /**
   * The API refused this box's sign-in. Raised the moment it is known — which is
   * on the runtime's first RETRY, because a runtime retries a 401 (measured: 8
   * requests in 90 seconds, and it would have gone on). The engine says so once
   * and stops the turn; nothing is retried on a credential that is being
   * refused.
   */
  | { kind: "signInRefused"; threadId: string; error: string | null };

/** resumeThread throws this when the thread belongs to another runtime (or is gone): the engine starts a fresh one. */
export class ThreadUnknownError extends Error {
  readonly threadUnknown = true;
}

/** A host tool's answer: its text, and images it attaches (pi image blocks: base64 + mime). */
/**
 * The tools a side thread may use and still be "read only": a Ctrl+K lookup
 * answers from the vault without changing it. (pi's, originally; the names are
 * the contract both engines' side runners speak.)
 */
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

export type ToolAnswer = { ok: boolean; text: string; images?: { data: string; mimeType: string }[]; resources?: { uri: string; mimeType: string; blob: string }[] };
/** A piece of work the host started that has now finished, named so a bounded
 *  continuation can tell its own completion from any other event. */
export type NativeCompletion = { kind: "job" | "delegate" | "wake"; id: string };
export type Interaction = Readonly<{ request: string; device: "laptop" | "phone" | "board" | null }>;
// The existing host-owned worker scope captures its originating interaction too.
// No second queue/presence registry: the source is the delivered native feed entry.
export type NotifyScope = Readonly<{
  workId: string; byCarl: boolean; interaction?: Interaction;
  /** Only the host's accepted BoardMake, bound to its own entry (never model args/text). */
  boardMake?: Readonly<{ id: string; interaction: Interaction; asked: boolean }>;
}>;
export type ToolCallHandler = (threadId: string, name: string, args: any, signal?: AbortSignal, notifyScope?: NotifyScope | null) => Promise<ToolAnswer>;
export type UserInputHandler = (threadId: string, question: string, options: string[]) => Promise<string>;
/** The "you" layer for a session (pi's extension asks in before_agent_start; another backend asks
 * wherever it builds a prompt): what Carl did since `since` (that session's last layer). A
 * conversation's thread names itself by `threadId`; a Ctrl+K / Ctrl+L side thread by the
 * conversation it was forked from (`convId`, or none). */
export type YouHandler = (q: { threadId?: string; convId?: string | null; since: number | null }) => Promise<{ text: string; until: number }>;
/** A read-only vault-chat tool called from a Ctrl+K / Ctrl+L side thread, as of the conversation it was opened from (or none). */
export type SideToolHandler = (convId: string | null, name: string, args: any, signal?: AbortSignal) => Promise<ToolAnswer>;
/** Host policy identifiers, not persisted schema snapshots. */
export type HostLoadout = "conversation" | "readOnly" | "voiceRead" | "voiceAct";
export type Handlers = {
  toolCatalog: (loadout: HostLoadout) => Promise<ToolSpec[]>;
  toolCall: ToolCallHandler;
  /** Host-only snapshot of the original ask at worker creation, never tool arguments. */
  notifyScope?: (threadId: string) => NotifyScope | null;
  /** Source-owner workspace allocation, before a native child is spawned. */
  workerCwd?: (threadId: string, cwd?: string) => Promise<string>;
  userInput: UserInputHandler;
  you?: YouHandler;
  /** A bounded continuation is waiting on this completion: true if it is the one it was waiting for. */
  continuationWait?: (threadId: string, event: NativeCompletion) => Promise<boolean>;
  sideTool?: SideToolHandler;
  /** Enforced private service, never an agent-callable MCP tool. */
  fileWrite?: (threadId: string) => Promise<boolean>;
  /** A worker (a parent thread's child) wrote a file: its write/edit input (the screens showing it refresh). */
  childWrote?: (parentThreadId: string, input: Record<string, unknown>) => void;
  /**
   * The host context a thread should be given again because its session was
   * just summarised and the summary may not have kept it (the rules, memory,
   * the project's own notes). A backend whose runtime can inject context into
   * the compacted session asks for it there and then, so the turn in flight
   * keeps its footing instead of waiting for the next prompt.
   */
  afterCompact?: (threadId: string) => Promise<string>;
};

// ---- side threads (Ctrl+K / Ctrl+L) and one-shots: /api/v1/side, answered off the conversation
export type SideStart = {
  /** What it is (the log line). */
  kind: string;
  /** Continue this side thread (a popover's next request). */
  side?: string | null;
  /** Fork the conversation's session, named the way its own backend names sessions. */
  fork?: string | null;
  /** The agent's instructions file; ignored with `system`. */
  instr?: string;
  /** A system prompt of its own, for a one-shot. */
  system?: string;
  cwd: string;
  model: string;
  /** The backend's own built-in tools allowed; [] (and no hostTools) = no tools at all. */
  tools: string[];
  /** vault-chat tools the backend offers it: Ctrl+K / Ctrl+L get the read-only ones. */
  hostTools?: ToolSpec[];
  /** Host-selected policy; refinements cannot change an existing session's authority. */
  hostLoadout?: Exclude<HostLoadout, "conversation">;
  /** Nothing is persisted (one-shots). */
  ephemeral?: boolean;
  thinking?: string;
  /** Where the session goes (persisted side threads). */
  sessionDir: string;
  /** Ctrl+K / Ctrl+L: the "you" layer before each request, as of this conversation (null: none open). One-shots: off. */
  you?: { convId: string | null } | null;
  /** Host-captured viewer binding, recorded once in the side session. */
  context?: string;
  text: string;
  /** data: URLs. */
  images?: string[];
  /** The box's turn log (turnLog.ts): one line per request of this side thread, mode "side". Kept for its next requests. */
  log?: SideLog;
};

/** `act`: the side thread has write tools; `allowed`: the backend built-ins it was given (its line shows both). */
export type SideLog = { vault: string; conv: string | null; via: string; version: string; act?: boolean; allowed?: string[]; write: (line: TurnLine) => void };

export type SideState = { id: string; text: string; v: number; done: boolean; error: string | null; file: string | null };

/** The side-thread runs of one backend, as /api/v1/side drives them. */
export type SideRunner = {
  start(o: SideStart): Promise<SideState>;
  poll(id: string, after: number, waitMs: number): Promise<SideState | null>;
  wait(id: string): Promise<SideState>;
  stop(id: string): Promise<boolean>;
  forget(id: string): void;
  health(): Record<string, unknown>;
};

// ---- background work started inside a turn (today pi's own children; later Claude Code's subagents)
/** A child the parent stopped waiting for: it reports on its own when it finishes. */
export type Detached = { id: string; title: string; result: Promise<Record<string, unknown>> };

/** A running child as the agent's JobList / JobStatus read it. */
export type LiveChild = { id: string; parent: string; title: string; activity: string; steps: number; said: string; startedAt: number; background: boolean };

/**
 * One agent runtime, as the engine drives it. `threadId` is the backend's own
 * id for a conversation's session; the engine stores it on the conversation and
 * hands it back, and never looks inside it.
 *
 * Implementations: pi/backend.ts (PiBackend), claude/ (ClaudeCodeBackend).
 */
export type EngineBackend = {
  /** Which runtime this is ("pi", "claude"): health, logs and the engine's own error text. */
  readonly name: string;
  /**
   * This thread's runtime is given the vault's memory by its own means (Claude
   * Code imports it in the session's CLAUDE.md and asks for changes through a
   * hook), so the turn's context must NOT repeat it. Absent, or false: memory
   * rides in front of the turn, as pi's does.
   */
  carriesMemory?(threadId: string): boolean;

  // -- lifecycle
  /** Every BackendEvent for every thread. */
  on(event: "event", fn: (e: BackendEvent) => void): unknown;
  /** The runtime came up (the engine resumes the turns that were cut) or went down. */
  on(event: "up" | "down", fn: () => void): unknown;
  /** The engine answers tool calls, questions and the "you" layer through these. Called once, before start(). */
  setHandlers(h: Handlers): void;
  /** Begin running (after setHandlers). */
  /** Bring the runtime up, once its handlers are wired. A backend with nothing
   *  to start (a test's stand-in) may leave it out. */
  start?(): void;
  /** Resolve true once the runtime can take a turn, false if it could not within `ms`. */
  ready(ms?: number): Promise<boolean>;
  /**
   * Why no turn can start at all, or null when one can.
   *
   * Unlike `ready`, this is not about warming up: nothing will change until a
   * person does something (signs in). The engine asks before it starts a turn,
   * so a scheduled wake waits quietly instead of failing every time it fires.
   */
  cannotRun?(): string | null;
  /** A new sign-in arrived: forget what the API said about the last one. */
  tokenChanged?(): void;
  /** One tiny real call to find out whether the sign-in actually works. */
  checkToken?(): Promise<{ ok: boolean | null; error: string | null }>;
  health(): Record<string, unknown>;

  // -- threads
  /** Open a session for a conversation and return the engine's handle on it (`ref`: where its transcript lives).
   * `conv` is the conversation it is for: the one call that names no thread yet, so a router of
   * several engines can read the conversation's own choice here (server/engine/router.ts). */
  startThread(o: { cwd: string; model: string; effort?: Effort; instructions: string; tools: ToolSpec[]; subagents: boolean; conv?: string }): Promise<{ threadId: string; ref?: string }>;
  /** Take a known thread back in hand. Throws ThreadUnknownError when it is gone or belongs elsewhere. */
  resumeThread(threadId: string, o: { model: string; effort?: Effort; subagents: boolean; cwd?: string }): Promise<void>;
  /** The models it offers a chat, by their real names (the composer's picker). */
  models?(): ModelChoice[];
  /** This runtime holds that thread right now (it can be noted into, forgotten, interrupted). */
  holds(threadId: string): boolean;
  /** Drop the thread from this runtime without ending the conversation (the next turn takes it again). */
  forget(threadId: string): void;
  /** Which engine owns this thread, by name. A single backend is always itself;
  /** Where a thread's transcript, instructions and working folder are, or null (not this runtime's). */
  threadSource(threadId: string): { file: string; instr: string; cwd: string } | null;
  /** Write one of vault-chat's own lines (a notice) into the thread's transcript. False: it could not. */
  note(threadId: string, data: Record<string, unknown>): Promise<boolean>;
  /** Summarise the thread now; `tokensBefore` and the summary when the runtime reports them. */
  compact(threadId: string, customInstructions?: string): Promise<{ tokensBefore?: number; summary?: string }>;

  // -- turns
  /** Start a turn. `turnId` is the engine's; a runtime that names turns itself returns its own. */
  startTurn(threadId: string, o: { texts: string[]; /** Host context the runtime stores as a hidden message, not Carl's input. */ context?: string; request?: UserRequest; completion?: NativeCompletion; images: string[]; model: string; turnId?: string; thinking?: string }): Promise<{ turnId: string | null }>;
  /** Fold input into the running turn (Carl kept talking). */
  steer(threadId: string, turnId: string, o: { texts: string[]; context?: string; request?: UserRequest; completion?: NativeCompletion; images: string[] }): Promise<void>;
  /** Queue input as its own next turn. */
  followUp(threadId: string, o: { texts: string[]; context?: string; request?: UserRequest; completion?: NativeCompletion; images?: string[] }): Promise<void>;
  /** Take back everything queued and not yet delivered, so the engine can re-send or drop it. */
  clearQueue(threadId: string): Promise<{ steering: string[]; followUp: string[] }>;
  /** Stop the running turn (it ends "interrupted"). */
  interrupt(threadId: string, turnId: string): Promise<void>;

  // -- what a turn cost (the ledger settles these; Claude Code reports usage, not price)
  usageCalls(ref: string | undefined, turnId?: string | null): CallRecord[];
  childUsageCalls(threadId: string): CallRecord[];

  // -- files: the runtime's own path policy (realpath, deny rules, the voice write gate)
  /** Why `path` is refused for a tool reaching outside a thread's folder, or null (allowed). */
  externalPath(root: string, path: unknown, write?: boolean): Promise<string | null>;
  /** The same check for the runtime's in-process file tools, or null (allowed). */
  nativePath?(cwd: string, path: unknown): Promise<string | null>;
  /** vault-chat's policy-enforcing file tools, bound to one folder. */
  filesystem(cwd: string, allowed: string[], services: ProcessServices, root?: string): Promise<BoundTools>;

  // -- side threads and one-shots
  readonly side: SideRunner;
  /** Only what the engine reads: where side sessions and instruction files go. */
  readonly paths: { sessionsDir: string; instrDir: string };

  // -- background work inside a turn
  /** Start children for a parent thread (the agent's own Delegate/BoardMake call). */
  background(parentThreadId: string, a: Record<string, unknown>, onStarted?: (id: string) => void, boardMake?: NotifyScope["boardMake"]): Promise<Record<string, unknown>>;
  subagentControl(childId: string, op: "steer" | "stop", text?: string): Promise<{ ok: boolean; error?: string }>;
  /** The parent stopped waiting: its still-running children, which report when they finish. */
  detach(parentThreadId: string): Detached[];
  liveChild?(childId: string): LiveChild | null;
  /** A parent's running children, as its own JobList reads them. */
  liveChildren(parentThreadId: string): LiveChild[];
  endedChild?(childId: string): { state: string; endedAt: number } | null;

  /**
   * The engine is out of headroom on Carl's subscription until this moment, so
   * work the host would start on its own — a wake, a schedule — waits rather
   * than burning a rejected call. Null when there is headroom. A turn Carl asked
   * for is never held back here: he can see the answer and decide.
   */
  usageLimit?(): { resetsAt: number | null; kind: string | null } | null;

  // -- a bounded continuation the agent opted into, where the runtime has one
  /** Stop a thread's continuation without a turn to interrupt (Carl pressed stop while it was idle). */
  cancelContinuation?(threadId: string): Promise<boolean>;
};
