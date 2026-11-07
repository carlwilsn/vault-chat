// Bounded, opt-in Ralph-style continuation on Pi's FINAL actionable boundary.
// State lives ONLY in the active native session branch; no timer or work queue.
// A restored active run is paused, not replayed (delivery is not transactional).
import { Type } from "typebox";

const STATE = "vc-continuation";
const HUMAN = new Set(["chat", "queue", "voice"]);
export function continuationState(ctx) {
  return ctx.sessionManager.getBranch().filter(e => e.type === "custom" && e.customType === STATE).at(-1)?.data;
}
function human(ctx) {
  return ctx.sessionManager.getBranch().filter(e => e.type === "message" && e.message?.role === "user" && HUMAN.has(e.message.vcRequest?.via)).at(-1)?.message.vcRequest;
}
const draft = data => ({ type: "custom", customType: STATE, data });

export function registerContinuation(pi) {
  const save = data => pi.appendEntry(STATE, data);
  const close = (ctx, status, reason) => {
    const s = continuationState(ctx);
    if (s?.status === "active") save({ ...s, status, reason, next: null });
  };
  // Existing Stop sends this command BEFORE native abort. Even a late successful
  // tool result cannot overwrite it: execute re-reads the native branch.
  const cancel = ctx => {
    const s = continuationState(ctx);
    if (s && !["complete", "cancelled", "limit"].includes(s.status)) save({ ...s, status: "cancelled", reason: "Stopped by user", next: null });
  };
  pi.on("session_start", (_event, ctx) => {
    close(ctx, "paused", "Session restored; no automatic replay. A new explicit human request is needed.");
    pi.setActiveTools([...new Set([...pi.getActiveTools(), "ContinueWork"])]);
  });
  pi.on("message_end", (event, ctx) => {
    const request = event.message?.vcRequest;
    const s = continuationState(ctx);
    if (s?.status === "active" && event.message?.role === "user" && request?.clientId !== s.request) close(ctx, "paused", "New human input or native event takes priority; no stale checkpoint replay");
  });
  // Enforce a model-TURN bound, not a monetary cap. Retries/compaction and an
  // in-flight request/tool may still cost time/money. No hidden timer privilege.
  pi.on("turn_start", (_event, ctx) => {
    const s = continuationState(ctx);
    if (s?.status !== "active") return;
    if (s.steps >= s.maxSteps || Date.now() >= s.deadline) {
      close(ctx, "limit", "Model-turn/time boundary reached");
      ctx.abort();
    } else save({ ...s, steps: s.steps + 1 });
  });
  pi.on("tool_call", (event, ctx) => {
    const s = continuationState(ctx);
    if (s?.status === "active" && Date.now() >= s.deadline) {
      close(ctx, "limit", "Time boundary reached");
      ctx.abort();
      return { block: true, reason: "Bounded continuation time limit reached" };
    }
    // Waiting is an outcome, not a request for more periodic checks. Notify is
    // deliberately not intercepted: it may report one completed subtask while
    // other actionable work remains. AskUser already owns its native tool wait.
    if (s?.status === "active" && /(?:^|__)(AskUser|ScheduleWake)$/.test(event.toolName)) close(ctx, "blocked", "Waiting on the existing question or requested wake; do not repeat checks");
  });
  pi.on("agent_before_settle", (event, ctx) => {
    const s = continuationState(ctx);
    if (s?.status !== "active") return;
    let reason;
    if (event.outcome !== "completed") reason = event.outcome === "aborted" ? "Interrupted" : "Run failed";
    else if (ctx.hasPendingMessages() || event.context.pendingMessages.length) reason = "Queued input takes priority";
    else if (Date.now() >= s.deadline || s.iterations >= s.maxIterations || s.steps >= s.maxSteps) reason = "Continuation limit reached";
    else if (!s.next) reason = "No new actionable checkpoint; paused instead of repeating the objective";
    if (reason) return { entries: [draft({ ...s, status: event.outcome === "aborted" ? "cancelled" : reason === "Continuation limit reached" ? "limit" : "paused", next: null, reason })] };
    const next = { ...s, iterations: s.iterations + 1, next: null };
    return {
      entries: [draft(next), { type: "custom_message", customType: "vc-continuation-context", display: false,
        content: `Bounded continuation ${next.iterations}/${s.maxIterations}. Objective: ${s.objective}\nVerified progress: ${s.progress}\nNext actionable work: ${s.next}\nDo that work now. Use ContinueWork checkpoint with NEW verified progress and a concrete next action only if more work is available. Complete when verified; blocked when waiting. Never poll an unchanged blocker, repeat a status update, or elevate permissions. Real job/delegate results use their existing delivery; ScheduleWake remains only for a reminder/later check Carl requested.`,
        details: { request: s.request, iteration: next.iterations } }],
      continue: true,
    };
  });
  pi.registerTool({
    name: "ContinueWork", label: "Continue work", exposure: "model-only",
    description: "Opt-in bounded continuation for a clear human long-running assignment in ANY project; never activate for ordinary questions or background events. One native session, no task files/timers. start records the human-authorized objective; checkpoint arms ONE next continuation after NEW verified progress with concrete actionable work. complete/blocked/cancel end automatic continuation; report a blocker once and wait on the existing question/job/delegate/requested timer. A new human request is needed after pause/cancel/limit; late callbacks must not rearm it. Limits are model turns/continuation iterations checked at boundaries, NOT a hard spending or in-flight wall-clock cap. Existing money/irreversible/taste permissions are unchanged.",
    parameters: Type.Object({
      action: Type.Union(["start", "checkpoint", "complete", "blocked", "cancel", "status"].map(v => Type.Literal(v))),
      objective: Type.Optional(Type.String({ maxLength: 4000 })),
      progress: Type.Optional(Type.String({ maxLength: 4000 })),
      next: Type.Optional(Type.String({ maxLength: 2000 })),
      maxIterations: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      maxSteps: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      minutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 120 })),
    }),
    async execute(_id, args, signal, _update, ctx) {
      let s = continuationState(ctx);
      const result = text => ({ content: [{ type: "text", text }], details: s ?? null });
      if (args.action === "status") return result(s ? JSON.stringify(s) : "No bounded continuation");
      if (signal?.aborted) return result("Interrupted; no continuation armed");
      if (args.action === "start") {
        const h = human(ctx);
        // The most recent input must itself be human, not a job/wake borrowing
        // the last human's authority. Native host inputs have no vcRequest.
        const last = ctx.sessionManager.getBranch().filter(e => e.type === "message" && e.message?.role === "user").at(-1)?.message;
        if (!h || last?.vcRequest?.clientId !== h.clientId || !args.objective?.trim()) return result("Start requires a current explicit human assignment and objective, not a callback");
        if (s?.request === h.clientId) return result("This human request already has a continuation outcome; do not rearm or reset its limits");
        s = { request: h.clientId, objective: args.objective.trim(), status: "active", progress: "Assignment accepted", next: null,
          iterations: 0, steps: 0, maxIterations: args.maxIterations ?? 10, maxSteps: args.maxSteps ?? 50, deadline: Date.now() + (args.minutes ?? 30) * 60_000 };
      } else {
        if (!s || s.status !== "active") return result("No active continuation; late/duplicate callbacks cannot reactivate it");
        if (args.action === "checkpoint") {
          if (!args.progress?.trim() || !args.next?.trim() || args.progress.trim() === s.progress) {
            s = { ...s, status: "paused", next: null, reason: "No new verified progress or next action" };
          } else s = { ...s, progress: args.progress.trim(), next: args.next.trim() };
        } else s = { ...s, status: args.action === "cancel" ? "cancelled" : args.action, next: null, reason: args.progress?.trim() || args.action };
      }
      save(s);
      return result(`Continuation ${s.status}. ${s.next ? "One next action armed at final settlement." : "No automatic next action armed."}`);
    },
  });
  return { cancel };
}
