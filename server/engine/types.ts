// The engine interface: what the HTTP layer and main.ts need from whichever
// agent runtime runs the box's turns. Two implementations sit behind it:
//   VC_ENGINE=codex (default) → server/engine/engine.ts   (Codex app-server)
//   VC_ENGINE=pi              → server/engine/pi/engine.ts (pi RPC, one process per conversation)
//   VC_ENGINE=0               → no engine: the old in-process loop (Phase 1)
// Both keep the phone API, the conversation file format, wakes.json and the
// /poll events identical, so a conversation can move between them (the new
// engine hands the visible transcript to its first turn).

/** A route result; `null` hands the request to the legacy relay (old mission threads). */
export type RouteResult = Record<string, unknown> | null;

export interface AgentEngine {
  /** POST /message {text, convId?, project?, context?, images?, imagePaths?, clientMsgId?} → {ok, convId, steered?, answered?}. */
  message(body: any): Promise<RouteResult>;
  /** POST /answer {convId, text | defer} → {ok, convId, answered?}. */
  answerRoute(body: any): Promise<RouteResult>;
  /** POST /kill {convId?} → {ok, result}. */
  kill(body: any): Promise<RouteResult>;
  /** POST /api/v1/models/:id/probe (paid, on request only). */
  probe(model: string): Promise<Record<string, unknown>>;
  /** Merged into /api/v1/health under `engine`. */
  health(): Record<string, unknown>;
  /** A turn is running (not parked on a question). */
  isRunning(convId: string): boolean;
}

export type EngineKind = "codex" | "pi" | "off";

/** VC_ENGINE: "pi" | "codex" (default) | "0"/"off". */
export function engineKind(v = process.env.VC_ENGINE): EngineKind {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "0" || s === "off" || s === "false") return "off";
  if (s === "pi") return "pi";
  return "codex";
}

export type AgentEngineHandle = {
  kind: EngineKind;
  engine: AgentEngine | null;
  error: string | null;
  health: () => Record<string, unknown>;
};
