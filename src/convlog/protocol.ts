// The box's conversation feed (one per vault). The transcript of every
// conversation is pi's own session file, unchanged; this feed only adds what
// pi's file can't say, as thin records under one vault-wide sequence:
//
//   entry  a pointer to one entry of a pi session file (the entry itself rides
//          along on the wire; on disk only the pointer), with the id of the
//          client message it is, and the text Carl typed (pi's copy carries the
//          engine's prefixes);
//   live   one of pi's raw RPC events for the message in flight (its deltas,
//          a tool running) — superseded by the entry pi writes at message_end,
//          kept so a client reconnecting, or a crash, loses nothing shown;
//   meta   the conversation's own fields (title, project, running, pending
//          steers, an open question, cost, subagents, its sessions …);
//   signal a vault-level nudge (the vault changed, a file changed, the inbox).
//
// Wire and disk: one JSON record per line, {seq, conv, at, type, ...}. `seq` is
// the vault's monotonic sequence (never reused, gaps allowed). Every client
// folds the records with the one reducer (./reduce.ts), which reassembles pi's
// streaming messages by pi's own rule (json.md): buffer the deltas, take each
// block's *_end content, then the message_end message, then the entry.

export const PROTOCOL_VERSION = 2;

/** One entry of a pi session file (session-format.md), as pi wrote it. */
export type PiEntry = {
  type: string;
  id: string;
  parentId?: string | null;
  timestamp?: string;
  message?: PiMessage;
  customType?: string;
  data?: any;
  summary?: string;
  [k: string]: unknown;
};

export type PiBlock = { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: any; data?: string; mimeType?: string; [k: string]: any };

export type PiMessage = {
  role: "user" | "assistant" | "toolResult" | "system" | string;
  content?: string | PiBlock[];
  timestamp?: number;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  stopReason?: string;
  errorMessage?: string;
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  [k: string]: unknown;
};

/** vault-chat's own entries in a pi session (a pi custom entry; not in the model's context). */
export const VC_NOTE = "vc-note";
/** A line said on a voice call (Carl's or the voice's): a pi custom_message, so it IS in the model's
 *  context — the conversation's agent hears what was said by voice on its next turn. Its `details`
 *  hold the line as a vc-note line holds it ({kind: "line", role, text, via: "voice", clientId}). */
export const VC_VOICE = "vc-voice";

export type Todo = { content: string; status: "pending" | "in_progress" | "completed"; activeForm?: string };
export type ItemImage = { path: string; dataUrl?: string };

/** A message Carl sent while a turn ran, not delivered by pi yet. */
export type PendingInput = { id: string; kind: "steer" | "queue"; text: string; at: number };

export type SubagentRec = { threadId: string; [k: string]: unknown };

/** The conversation's own fields (a `meta` record patches them; null removes one). */
export type ConvMeta = {
  title: string;
  source: string;
  createdAt: number;
  lastActivityAt: number;
  project?: string;
  /** The engine's state: idle | running | sleeping | waiting_user | done | blocked. */
  state?: string;
  working?: boolean;
  nextWakeAt?: number;
  verdict?: { verdict: string; notes?: string[]; at?: number; summary?: string };
  /** The turn running now (null: idle). */
  running?: { turn: string; kind: string; startedAt: number } | null;
  /** Steers and queued messages pi has not delivered. */
  pending?: PendingInput[];
  /** A question waiting for Carl. */
  asking?: { question: string; options: string[]; toolCallId?: string; at: number } | null;
  costUsd?: number;
  subagents?: SubagentRec[];
  /** The model's context window. */
  contextWindow?: number;
  /** pi's session (engine only). */
  threadId?: string;
  threadPath?: string;
  deleted?: boolean;
  [k: string]: unknown;
};

export type EventBody =
  | { type: "meta"; patch: Record<string, unknown> }
  | { type: "entry"; file: string; entry: PiEntry; clientId?: string; shown?: string; via?: string; images?: ItemImage[] }
  | { type: "live"; ev: any }
  | { type: "signal"; signal: Record<string, unknown> };

export type LogRecord = EventBody & { seq: number; conv: string | null; at: number };

/** GET /poll?after=N → exactly the records after N (one vault). */
export type PollAnswer = { next: number; events: LogRecord[]; reset?: boolean; more?: boolean; epoch?: string };

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
  asking: boolean;
  deleted?: boolean;
  /** An older conversation file not imported yet. */
  legacy?: boolean;
  seq: number;
};

export function isLogRecord(v: unknown): v is LogRecord {
  return !!v && typeof v === "object" && typeof (v as LogRecord).seq === "number" && typeof (v as LogRecord).type === "string";
}
