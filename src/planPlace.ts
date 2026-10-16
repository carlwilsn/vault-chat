// Where the plan (the agent's to-do list, TodoWrite) shows in the thread: with
// the turn that last wrote it, in thread order — not pinned below everything
// (a finished 3/3 plan sat under a later "hi" and its reply). While a turn
// runs, the plan is that turn's live state: at the end, with the live reply.
import type { ChatMessage } from "./store";

const PLAN_TOOLS = new Set(["TodoWrite"]);

/** The index of the message the plan follows, or -1 for the end of the thread. */
export function planIndex(messages: ChatMessage[], busy: boolean): number {
  if (busy) return -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.hidden) continue;
    if (m.toolCalls?.some((t) => PLAN_TOOLS.has(t.name))) return i;
  }
  return -1;
}

/** A plan whose every step is done: shown as one quiet line. */
export function planDone(todos: { status: string }[]): boolean {
  return todos.length > 0 && todos.every((t) => t.status === "completed");
}
