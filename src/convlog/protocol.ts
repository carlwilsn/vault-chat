// The conversation event log: the one record of every conversation the box
// runs. The box server is its only writer; every client (laptop in box mode,
// popout, phone, board) reads it and folds it with the one reducer
// (./reduce.ts). Nothing else describes a conversation.
//
// Wire and disk shape: one JSON record per line,
//   {seq, conv, at, type, ...body}
// `seq` is the vault's monotonic sequence (never reused, gaps allowed), `conv`
// the conversation id (null for a vault-level signal), `at` the server's clock.
//
// Items have stable ids and a lifecycle: started -> deltas/updates -> completed
// (or removed, explicitly). Ids: a user message carries the id its client chose
// (the optimistic copy is confirmed in place); assistant text and thinking are
// `<turn>:<message>:<block>`; a tool call is pi's toolCallId.

export const PROTOCOL_VERSION = 1;

export type ItemKind =
  /** Carl's message (typed, an answer, a voice line, a steer or queued message once delivered). */
  | "user"
  /** The agent's text (one content block). */
  | "assistant"
  /** The agent's thinking (one content block). */
  | "thinking"
  /** A tool call: its streamed arguments, its run, its result. */
  | "tool"
  /** The to-do list the agent keeps (TodoWrite). */
  | "plan"
  /** The earlier conversation was summarized (pi compaction, or a roll-over to a fresh session). */
  | "compaction"
  /** A line from the engine (a failure, a stop, a restart, a retry, the verifier's verdict). */
  | "notice"
  /** The agent asked Carl (AskUser): open until answered. */
  | "ask"
  /** A turn the engine started by itself: a scheduled wake, a job ending, a keep-going nudge, a resume. */
  | "wake";

export type ItemStatus = "streaming" | "pending" | "running" | "done" | "error" | "stopped";

export type Todo = { content: string; status: "pending" | "in_progress" | "completed"; activeForm?: string };

export type ItemImage = { path: string; dataUrl?: string };

export type Item = {
  id: string;
  kind: ItemKind;
  status: ItemStatus;
  /** When it started (server clock). */
  at: number;
  /** The turn it belongs to (absent for items outside a turn: a voice line, an imported message). */
  turn?: string;
  /** user / assistant / thinking / notice / compaction (the summary) / wake (the reason). */
  text?: string;
  /** user: how it came in. assistant: "voice" for a voice agent's line. */
  via?: "chat" | "answer" | "voice" | "steer" | "queue" | "import";
  /** user: images sent with it (vault-relative paths; a small data URL to show at once). */
  images?: ItemImage[];
  /** user: hidden from the transcript (a context preamble the model saw). */
  hidden?: boolean;
  // tool
  name?: string;
  /** The arguments as they stream (serialized JSON, possibly partial). */
  argsText?: string;
  /** The arguments, parsed (once the call is complete). */
  args?: unknown;
  result?: string;
  /** The latest partial output of a running tool (dropped when it completes). */
  partial?: string;
  /** The subagents this call spawned (their thread ids). */
  subagents?: string[];
  // plan
  todos?: Todo[];
  // ask
  question?: string;
  options?: string[];
  answer?: string;
  // notice
  level?: "info" | "warn" | "error";
  // wake
  wake?: "wake" | "job" | "nudge" | "resume";
  // compaction
  rollover?: boolean;
};

/** A message Carl sent while a turn ran, not yet in the transcript. */
export type PendingInput = { id: string; kind: "steer" | "queue"; text: string; at: number; images?: ItemImage[] };

export type SubagentRec = { threadId: string; [k: string]: unknown };

/** Conversation-level fields (the list row, the engine's own bookkeeping). */
export type ConvMeta = {
  title: string;
  source: string;
  createdAt: number;
  lastActivityAt: number;
  project?: string;
  /** The engine's state: idle | running | sleeping | waiting_user | done | blocked. */
  state?: string;
  /** Keep-going mode. */
  working?: boolean;
  nextWakeAt?: number;
  verdict?: { verdict: string; notes?: string; at?: number; summary?: string };
  /** pi's session for this conversation (engine only). */
  threadId?: string;
  threadPath?: string;
  /** The recap a roll-over carried into the next session (engine only). */
  recap?: string;
  costUsd?: number;
  costMissingCalls?: number;
  subagents?: SubagentRec[];
  [k: string]: unknown;
};

/** Fields a `conv.updated` may set. A null value removes the field. */
export const META_FIELDS = [
  "title",
  "source",
  "project",
  "state",
  "working",
  "nextWakeAt",
  "verdict",
  "threadId",
  "threadPath",
  "recap",
  "costMissingCalls",
  "role",
  "mission",
  "missionState",
  "surfaced",
] as const;

export type TurnKind = "user" | "wake" | "nudge" | "resume";
export type TurnEnd = "completed" | "interrupted" | "failed" | "stopped" | "stalled" | "cut";

export type EventBody =
  | { type: "conv.created"; meta: Partial<ConvMeta> & { title: string; source: string } }
  | { type: "conv.updated"; patch: Record<string, unknown> }
  | { type: "turn.started"; turn: string; kind: TurnKind }
  | { type: "turn.ended"; turn: string; status: TurnEnd; error?: string }
  | { type: "item.started"; item: Item }
  | { type: "item.delta"; id: string; field: "text" | "argsText"; delta: string }
  | { type: "item.updated"; id: string; patch: Partial<Item> }
  | { type: "item.completed"; id: string; patch?: Partial<Item> }
  | { type: "item.removed"; id: string }
  | { type: "pending.added"; pending: PendingInput }
  | { type: "pending.removed"; id: string; reason: "delivered" | "taken-back" | "stopped" | "failed" }
  | { type: "usage"; turn?: string; context: number; window?: number }
  | { type: "cost"; turn?: string; usd: number; missing?: number }
  | { type: "subagent"; threadId: string; patch: Record<string, unknown> }
  /** A vault-level signal (conv: null): the vault changed, a file changed, the inbox, notifications, a project. */
  | { type: "signal"; signal: Record<string, unknown> };

export type LogRecord = EventBody & { seq: number; conv: string | null; at: number };

/** GET /poll?after=N → exactly the records after N (one vault). */
export type PollAnswer = {
  next: number;
  events: LogRecord[];
  /** The vault's log does not reach back to `after` (a cursor from a log that was reset): start over from 0. */
  reset?: boolean;
  /** More records are waiting: poll again at once. */
  more?: boolean;
};

/** One row of GET /api/v2/conversations. */
export type ConvRow = {
  id: string;
  title: string;
  source: string;
  createdAt: number;
  lastActivityAt: number;
  project?: string;
  state?: string;
  working?: boolean;
  nextWakeAt?: number;
  costUsd?: number;
  running: boolean;
  /** An open question waits for Carl. */
  asking: boolean;
  /** Not in the log yet (an older conversation file, imported when first opened). */
  legacy?: boolean;
  /** The last record of this conversation (0 for a legacy one). */
  seq: number;
};

/** POST /api/v2/intent. Every intent from a client; the box is the only writer. */
export type Intent =
  | { type: "send"; convId?: string | null; clientId: string; text: string; images?: { name?: string; mime?: string; dataBase64?: string }[]; imagePaths?: string[]; context?: string; project?: string; source?: string }
  | { type: "steer"; convId: string; clientId: string; text: string; images?: { name?: string; mime?: string; dataBase64?: string }[]; context?: string }
  | { type: "queue"; convId: string; clientId: string; text: string; images?: { name?: string; mime?: string; dataBase64?: string }[]; context?: string }
  | { type: "unqueue"; convId: string; id: string }
  | { type: "stop"; convId: string }
  | { type: "answer"; convId: string; clientId: string; text: string; defer?: boolean }
  | { type: "project"; convId: string; project: string | null }
  /** Lines brought into a chat as they are (a Ctrl+K exchange, a note opened for discussion); no turn runs. */
  | { type: "lines"; convId?: string | null; clientId: string; lines: { role: "user" | "assistant"; text: string; hidden?: boolean; images?: string[] }[] }
  | { type: "delete"; convId: string };

export function isLogRecord(v: unknown): v is LogRecord {
  return !!v && typeof v === "object" && typeof (v as LogRecord).seq === "number" && typeof (v as LogRecord).type === "string";
}
