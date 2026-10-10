// The seam between the engine-neutral layer (engine.ts: conversations, wakes,
// keep-going, watchdog, AskUser/Done/Blocked, ledger, CONTEXT, /poll, phone
// API) and the agent runtime that actually runs turns. codexBackend.ts is the
// Codex implementation; another runtime (e.g. pi) implements the same shape.
import type { EventEmitter } from "node:events";
import type { ThreadTokenUsage } from "./context";
import type { CallRecord } from "./ledger";

export type ToolSpec = { type: "function"; name: string; description: string; inputSchema: Record<string, unknown> };

/** What the runtime reports, in neutral terms. Every event names the thread it
 * belongs to; subagent threads report under their own ids (the engine maps
 * them to the parent conversation from the `subagents` event). */
export type BackendEvent =
  | { kind: "turnStarted"; threadId: string; turnId: string }
  | { kind: "textDelta"; threadId: string; itemId: string; delta: string }
  | { kind: "text"; threadId: string; itemId: string; text: string }
  /** A tool the runtime ran (shell, file edit, our dynamic tools …); `result` once finished. */
  | { kind: "tool"; threadId: string; itemId: string; name: string; input: unknown; result?: string }
  | { kind: "reasoning"; threadId: string; text: string }
  | { kind: "usage"; threadId: string; usage: ThreadTokenUsage }
  /** The parent spawned/messaged subagents. */
  | { kind: "subagents"; threadId: string; itemId: string; children: string[]; op: string; prompt?: string; model?: string | null; done: boolean; ok: boolean }
  | { kind: "subagentStatus"; threadId: string; child: string; status: string; path?: string }
  | { kind: "turnCompleted"; threadId: string; turnId: string | null; status: "completed" | "interrupted" | "failed" | string; error: string | null }
  /** One thread's runtime died mid-turn while the rest of the runtime is fine (pi: one process per thread).
   * The engine marks that turn cut and resumes it, as it does for all turns on "down". */
  | { kind: "threadLost"; threadId: string };

/** resumeThread throws this when the thread belongs to another runtime (or is gone): the engine starts a fresh one. */
export class ThreadUnknownError extends Error {
  readonly threadUnknown = true;
}

export type ToolCallHandler = (threadId: string, name: string, args: any) => Promise<{ ok: boolean; text: string }>;
export type UserInputHandler = (threadId: string, question: string, options: string[]) => Promise<string>;

/**
 * Events: "event" (BackendEvent), "up" (runtime ready; all threads unloaded),
 * "down" (runtime died; in-flight turns are lost — the engine resumes them).
 */
export interface EngineBackend extends EventEmitter {
  readonly name: string;
  readonly version: string;
  start(): void;
  ready(ms: number): Promise<boolean>;
  health(): Record<string, unknown>;
  /** Route the agent's calls to vault-chat's tools, and its questions to Carl. */
  setHandlers(h: { toolCall: ToolCallHandler; userInput: UserInputHandler }): void;
  /** New thread. `ref` locates its usage records (the ledger). */
  startThread(o: { cwd: string; model: string; instructions: string; tools: ToolSpec[]; subagents: boolean }): Promise<{ threadId: string; ref?: string }>;
  /** Make an existing thread runnable in this runtime process (no-op when loaded). */
  resumeThread(threadId: string, o: { model: string; subagents: boolean }): Promise<void>;
  startTurn(threadId: string, o: { texts: string[]; images: string[]; model: string }): Promise<{ turnId: string | null }>;
  steer(threadId: string, turnId: string, o: { texts: string[]; images: string[] }): Promise<void>;
  interrupt(threadId: string, turnId: string): Promise<void>;
  /** Optional: queue input until the running turn's work is done (pi's follow_up). Wakes and nudges that
   * arrive mid-turn use it when present; otherwise they steer. */
  followUp?(threadId: string, o: { texts: string[] }): Promise<void>;
  forget(threadId: string): void;
  /** Model calls (OpenRouter response ids) of a thread, optionally one turn, for the dollar ledger. */
  usageCalls(ref: string | undefined, turnId?: string | null): CallRecord[];
  /** Same, for a subagent thread known only by id. */
  childUsageCalls(threadId: string): CallRecord[];
  /** Tests: kill the runtime hard; returns its pid. */
  killHard(): number | null;
}
