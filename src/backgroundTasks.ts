// Background tasks, as Claude Code shows them: the agent's workers (Delegate, or a `subagent` call moved to the
// background when Carl wrote) are one compact chip in the chat ("2 background tasks: 1 running, 1 done"), which
// opens to the list: each task's name, status, elapsed time and what it is doing now (its latest step, from its
// own pi events on the box: server/engine/pi/subagents.ts), with Stop and Steer. A finished task's result is the
// agent's next message, never shown raw here. With the chat closed, the titlebar says "1 running".
// (Structural types only: the phone imports this too, without the laptop's store.)
export type TaskRec = { threadId: string; title?: string; task?: string; prompt?: string; state?: string; status?: string; startedAt?: number; endedAt?: number; toolCallId?: string; activity?: string; steps?: number; said?: string; activityAt?: number; background?: boolean };
type WithCalls = { toolCalls?: { id?: string; name: string; subagents?: string[] }[] };
export type TaskState = "running" | "done" | "failed" | "stopped";

export function taskState(s: TaskRec): TaskState {
  const st = String(s.state ?? s.status ?? "running");
  if (st === "running") return "running";
  if (st === "completed") return "done";
  if (st === "stopped") return "stopped";
  return "failed";
}

export function taskName(s: TaskRec): string {
  return String(s.title || s.task || s.prompt || "background task")
    .replace(/\s+/g, " ")
    .trim();
}

/** The chip's words: "1 background task running", "3 background tasks: 1 running, 2 done", "4 background tasks done". */
export function tasksSummary(list: TaskRec[]): string {
  const n = list.length;
  const count = (k: TaskState) => list.filter((s) => taskState(s) === k).length;
  const parts = ([["running", count("running")], ["done", count("done")], ["failed", count("failed")], ["stopped", count("stopped")]] as const).filter(([, c]) => c > 0);
  const noun = `${n} background task${n === 1 ? "" : "s"}`;
  if (parts.length === 1) return `${noun} ${parts[0]![0]}`;
  return `${noun}: ${parts.map(([k, c]) => `${c} ${k}`).join(", ")}`;
}

/** "0:42", "12:05", "1:02:10". */
export function elapsedText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** How long a task ran (to now while it runs). */
export function taskElapsed(s: TaskRec, now = Date.now()): number {
  const start = Number(s.startedAt) || now;
  const end = taskState(s) === "running" ? now : Number(s.endedAt) || now;
  return Math.max(0, end - start);
}

/** What a task is doing, in a few words: its latest step while it runs ("writing physics.html · 6 steps"). */
export function taskActivity(s: TaskRec): string {
  const st = taskState(s);
  const steps = Number(s.steps) || 0;
  const stepWord = steps ? `${steps} step${steps === 1 ? "" : "s"}` : "";
  if (st !== "running") return [st === "done" ? "done" : st === "stopped" ? "stopped" : "failed", stepWord].filter(Boolean).join(" · ");
  return [s.activity || "starting", stepWord].filter(Boolean).join(" · ");
}

/** The tasks a surface shows after its Clear: those still running (reachable in the chip), and those started by a
 *  message after the Clear. Finished ones from before it are gone from this view (the box keeps them). */
export function tasksAfterClear<T extends TaskRec>(list: T[], after: WithCalls[]): T[] {
  const calls = after.flatMap((m) => m.toolCalls ?? []);
  const ids = new Set(calls.flatMap((t) => t.subagents ?? []));
  const callIds = new Set(calls.map((t) => t.id).filter(Boolean));
  return list.filter((s) => taskState(s) === "running" || ids.has(s.threadId) || (!!s.toolCallId && callIds.has(s.toolCallId)));
}

/** The plan a surface shows after its Clear: only one written after it (a TodoWrite in a message after the Clear). */
export function planAfterClear<T>(todos: T[] | undefined, after: WithCalls[]): T[] | undefined {
  if (!todos?.length) return todos;
  return after.some((m) => (m.toolCalls ?? []).some((t) => t.name === "TodoWrite")) ? todos : [];
}

/** Background tasks running across the conversations (the titlebar's "1 running"). */
export function runningTaskCount(convs: { subagents?: TaskRec[] }[]): number {
  return convs.reduce((n, c) => n + (c.subagents ?? []).filter((s) => taskState(s) === "running").length, 0);
}
