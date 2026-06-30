import { runAgent } from "./agent";
import {
  findModel,
  AUTO_MODEL_ID,
  DEFAULT_WORKER_MODEL_ID,
  resolveAutoModel,
  getLiveCatalog,
} from "./providers";
import {
  readConversations,
  writeConversations,
  emptyConversation,
  deriveConversationTitle,
  newConversationId,
  withConvLock,
  type Conversation,
} from "./conversations";
import { scheduledDeliveryText } from "./scheduleDelivery";
import { useStore, type ChatMessage, type LiveTool } from "./store";
import type { Timeline } from "./alert-summary";
import { bumpHeartbeat, endHeartbeat } from "./runHeartbeat";
import { registerRun, unregisterRun, abortRun } from "./runRegistry";
import { vlog } from "./debugLog";
import { errToString } from "./errfmt";


// withConvLock (shared read→modify→write serializer for the conversations
// store) now lives in ./conversations so the store's autosave can share it.

export async function runScheduledHeadlessTurn(
  vault: string,
  conversationId: string,
  prompt: string,
  opts: { modelId?: string; quietUnlessAlert?: boolean },
): Promise<void> {
  const store = useStore.getState();
  // Model precedence: the schedule's pinned model wins (it was chosen for a
  // reason — e.g. Opus for a heavy weekly sweep), else the default. Resolve the
  // "auto" sentinel to a concrete model so the headless run doesn't silently
  // no-op on a missing model.
  let modelId = opts.modelId || store.modelId;
  if (modelId === AUTO_MODEL_ID) {
    modelId = resolveAutoModel(prompt, store.apiKeys, getLiveCatalog())?.id ?? modelId;
  }
  const spec = findModel(modelId);
  const apiKey = spec ? store.apiKeys[spec.provider] : undefined;
  if (!spec || !apiKey) {
    console.warn("[scheduler] headless run: no model/key configured");
    return;
  }

  const list = await readConversations(vault);
  let idx = list.findIndex((c) => c.id === conversationId);
  if (idx < 0) {
    // The schedule's target conversation no longer exists on disk —
    // fall back to creating a fresh one rather than dropping the run.
    const fresh: Conversation = {
      ...emptyConversation(),
      id: conversationId,
      source: "scheduled",
      title: deriveConversationTitle([{ role: "user", content: prompt }]),
    };
    list.unshift(fresh);
    idx = 0;
  }
  const userMsg: ChatMessage = { role: "user", content: prompt };
  list[idx] = {
    ...list[idx]!,
    messages: [...list[idx]!.messages, userMsg],
    lastActivityAt: Date.now(),
  };
  await writeConversations(vault, list);

  let acc = "";
  // The text emitted AFTER the last tool call — i.e. the turn's actual closing
  // message, with the inter-tool "let me check X / pulling evidence" narration
  // stripped. This is the clean thing to DELIVER; `acc` (the whole blob) is kept
  // only as the message record. Resets every time a new tool runs.
  let finalSegment = "";
  let reasoningAcc = "";
  const tools: LiveTool[] = [];
  const baseHistory = list[idx]!.messages
    .filter((m) => !m.system)
    .map((m) => ({ role: m.role, content: m.content }));

  // Register an abort handle so another agent (a supervisor) can interject
  // this run by id (AskWorker / auto-nudge).
  const controller = new AbortController();
  registerRun(conversationId, controller);

  let runErr: string | null = null;
  vlog("sched.wake", {
    conv: conversationId.slice(0, 8),
    quiet: opts.quietUnlessAlert ?? false,
    prompt: prompt.slice(0, 60),
  });

  try {
    await runAgent({
      modelId,
      apiKey,
      vault,
      history: baseHistory,
      userMessage: prompt,
      abortSignal: controller.signal,
      tavilyKey: store.serviceKeys.tavily,
      strictVault: store.strictVaultMode,
      bashDisabled: store.bashDisabled,
      voiceMode: false,
      conversationId,
      reasoningEffort: store.reasoningEffort,
      onEvent: (e) => {
        if (e.kind === "text") {
          acc += e.delta;
          finalSegment += e.delta;
        } else if (e.kind === "reasoning") reasoningAcc += e.delta;
        else if (e.kind === "tool_use") {
          // A new tool call means anything narrated so far was lead-in, not the
          // closing message — start the final segment over after it.
          finalSegment = "";
          tools.push({
            id: e.id,
            name: e.name,
            input: e.input,
            startedAt: Date.now(),
          });
          // Progress reaches the phone via the heartbeat-backed /status, not a
          // push — the cockpit polls it.
          void bumpHeartbeat(vault, conversationId, e.name);
        } else if (e.kind === "tool_result") {
          const t = tools.find((x) => x.id === e.id);
          if (t) t.result = e.result;
        } else if (e.kind === "error") {
          const emsg = errToString(e.message);
          runErr = emsg;
          acc = (acc + `\n\n⚠️ ${emsg}`).trim();
          finalSegment = (finalSegment + `\n\n⚠️ ${emsg}`).trim();
        }
      },
    });
  } catch (e) {
    runErr = errToString(e);
    acc = (acc + `\n\n⚠️ scheduled run failed: ${runErr}`).trim();
  } finally {
    await endHeartbeat(vault, conversationId).catch(() => {});
    unregisterRun(conversationId, controller);
  }

  // What (if anything) this run delivers to Telegram. A quiet supervisor
  // returns null unless it explicitly emitted an ALERT:; a normal schedule
  // returns its reply unless it's the [[SILENT]] sentinel.
  const deliver = scheduledDeliveryText(acc, opts.quietUnlessAlert ?? false);
  // Per-cycle debug trail. Survives even a silent "nothing to report" turn,
  // which otherwise prunes itself and leaves no transcript — so this is the
  // timeline for diagnosing a supervisor that stopped watching: did it wake,
  // what did it call (a `Schedule` in tools = it re-armed its watch), did it
  // error, did it alert.
  vlog("sched.turn", {
    conv: conversationId.slice(0, 8),
    tools: tools.map((t) => t.name),
    replyLen: acc.length,
    error: runErr,
    deliver: deliver == null ? "silent" : "sent",
  });

  // Clean a DELIVERED scheduled turn into the same thought-by-thought timeline
  // mission/worker turns get. Two payoffs: (1) the thread renders this turn as
  // the cleaned chain instead of a raw narration blob — a scheduled run is never
  // a direct reply, so it should always read as reasoning, not prose; (2) the
  // timeline's verbatim `reply` is the turn's true closing message, which is what
  // we DELIVER to Telegram + the Alerts feed instead of the whole "let me re-read
  // the files… pulling evidence…" narration. A silent/pruned turn skips all this.
  let timeline: Timeline | null = null;
  let deliverText = deliver;
  if (deliver !== null) {
    const quiet = opts.quietUnlessAlert ?? false;
    const { cleanReplyAndTimeline } = await import("./alert-summary");
    const cleaned = await cleanReplyAndTimeline(
      acc,
      finalSegment,
      reasoningAcc,
      tools.map((t) => ({ name: t.name, input: t.input })),
      store.apiKeys,
      quiet ? "supervisor" : "worker",
    );
    timeline = cleaned.timeline;
    // A quiet supervisor's `deliver` is already its extracted ALERT: line — leave
    // it; a normal schedule delivers the cleaned closing message.
    if (!quiet) deliverText = cleaned.deliver;
  }

  let finalList = await readConversations(vault);
  let fi = finalList.findIndex((c) => c.id === conversationId);
  if (fi < 0) fi = 0;
  if (finalList[fi] && deliver === null) {
    // Nothing to report — leave no trace: drop the prompt we appended in the
    // first write, store no reply, no unread, no DM binding. The thread stays
    // exactly as it was before this poll.
    const msgs = finalList[fi]!.messages;
    const last = msgs[msgs.length - 1];
    const pruned =
      last && last.role === "user" && last.content === prompt
        ? msgs.slice(0, -1)
        : msgs;
    finalList[fi] = { ...finalList[fi]!, messages: pruned };
    await writeConversations(vault, finalList);
  } else if (finalList[fi]) {
    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: acc,
      toolCalls: tools.length ? tools : undefined,
      // Render as the cleaned chain (see above). `content` stays the full blob as
      // the record; the thread view prefers the timeline when present.
      timeline: timeline ?? undefined,
    };
    finalList[fi] = {
      ...finalList[fi]!,
      messages: [...finalList[fi]!.messages, assistantMsg],
      lastActivityAt: Date.now(),
      unread: true,
    };
    await writeConversations(vault, finalList);
  }

  // If the user is on this vault right now, surface the result (and its
  // tool calls) live without yanking their focus.
  await useStore
    .getState()
    .refreshConversationFromDisk(vault, conversationId)
    .catch(() => {});

  if (deliver != null) {
    // Only scheduled runs reach here, and the text is the CLEANED closing message
    // (deliverText), never the raw narration blob. Surface the briefing in the
    // Alerts feed (+ Web Push) — visible and inspectable.
    const safe = deliverText ?? deliver;
    const { mirrorPushNotify } = await import("./phoneApp");
    // The scheduled conversation's title is the schedule's name — a clean
    // model-free headline fallback (this box may have no fast model to summarize).
    await mirrorPushNotify(safe, conversationId, finalList[fi]?.title).catch((e) =>
      console.warn("[scheduler] alert notify failed:", e),
    );
  }
}

// Run ONE turn on an existing thread with `message`, persist the exchange,
// and RETURN the reply text. Used by the AskWorker relay so one agent (a
// supervisor / the phone's front agent) can hand a message to a worker thread
// and get its answer back to relay. No Telegram delivery — the caller decides
// what to do with the reply. The worker run registers an abort handle so a
// concurrent interject can stop it.
// Turn a raw tool call into a short human action phrase for the LIVE timeline —
// "read worker-a.md", "spawned worker X" — never the raw tool name (the user
// finds "Read"/"Bash" labels noise; the thread doesn't show them either). Unknown
// tools return "" so only the thought renders. This is the on-the-fly counterpart
// to the Haiku action-cleaning that runs once the turn finishes.
function humanizeToolAction(name: string, input: unknown): string {
  const base = (p: unknown) => String(p ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "";
  const i = (input ?? {}) as Record<string, unknown>;
  const path = () => base(i.path ?? i.file ?? i.file_path);
  switch (name) {
    case "Read":
    case "ReadFile": return `read ${path()}`.trim();
    case "Write": return `wrote ${path()}`.trim();
    case "Edit":
    case "MultiEdit": return `edited ${path()}`.trim();
    case "Bash": return "ran a command";
    case "Glob":
    case "Grep": return "searched the vault";
    case "ListDir": return "listed files";
    case "StartWorker": return `spawned worker ${i.title ? `"${String(i.title)}"` : ""}`.trim();
    case "AskWorker": return "messaged a worker";
    case "ReadConversation": return "read a worker thread";
    case "GitLog": return "checked git history";
    case "MarkDoneWhen": return "checked off a criterion";
    case "CompleteMission": return "marked the mission done";
    case "Schedule": return "scheduled a wake";
    case "CancelSchedule": return "canceled a wake";
    case "ListSchedules": return "checked its schedules";
    case "WebSearch":
    case "WebFetch": return "searched the web";
    case "ProposeMission": return "proposed a plan";
    default: return "";
  }
}

export async function runWorkerTurn(
  vault: string,
  conversationId: string,
  message: string,
  opts: { modelId?: string; resume?: boolean; direct?: boolean } = {},
): Promise<{ reply: string; error?: string }> {
  const store = useStore.getState();
  // Workers default to the heavy long-horizon worker model (Fable), NOT the
  // chat-pane default — they're expert grinds, not daily chat. An explicit
  // opts.modelId (e.g. a schedule's pinned model) still wins. If the worker
  // model can't run (no Anthropic key / not in catalog yet), fall back to the
  // chat default so a worker never silently no-ops on a fresh setup.
  let modelId = opts.modelId || DEFAULT_WORKER_MODEL_ID;
  if (modelId === AUTO_MODEL_ID) {
    modelId = resolveAutoModel(message, store.apiKeys, getLiveCatalog())?.id ?? modelId;
  }
  let spec = findModel(modelId);
  if ((!spec || !store.apiKeys[spec.provider]) && !opts.modelId && modelId !== store.modelId) {
    const fallback = findModel(store.modelId);
    if (fallback && store.apiKeys[fallback.provider]) {
      modelId = store.modelId;
      spec = fallback;
    }
  }
  const apiKey = spec ? store.apiKeys[spec.provider] : undefined;
  if (!spec || !apiKey) {
    return { reply: "", error: "no model / API key configured" };
  }

  const userMsg: ChatMessage = { role: "user", content: message };
  const seeded = await withConvLock(async () => {
    const list = await readConversations(vault);
    const idx = list.findIndex((c) => c.id === conversationId);
    if (idx < 0) return null;
    // Resume mode: `message` is ALREADY the thread's last turn (an interrupted
    // mission/worker we're re-running after a crash/restart) — don't append a
    // duplicate. Normal mode appends the new user turn.
    const messages = opts.resume
      ? list[idx]!.messages
      : [...list[idx]!.messages, userMsg];
    list[idx] = { ...list[idx]!, messages, lastActivityAt: Date.now() };
    await writeConversations(vault, list);
    return { messages, role: list[idx]!.role };
  });
  if (!seeded) return { reply: "", error: `worker thread not found: ${conversationId}` };
  const baseMessages = seeded.messages;
  // Mission threads (and any supervisor-role thread run headless) get the
  // vault's supervisor.md orchestrator prompt, same as the cockpit path in
  // chat-controller — a mission's turns ARE supervisor turns.
  const supervisorMode = seeded.role === "supervisor";

  // Surface the run to the live UI immediately: pull the just-written user
  // turn into the in-memory list so the worker chat shows the task it was
  // handed (instead of an empty pane until the turn finishes), then flip the
  // thread to "running" so it pulses in the Chats panel while it grinds. The
  // status flip MUST come after the refresh — the on-disk copy is always
  // read back as idle, so refreshing afterward would clear the pulse.
  await useStore.getState().refreshConversationFromDisk(vault, conversationId).catch(() => {});
  useStore.getState().setConversationStatus(conversationId, "running");

  const baseHistory = baseMessages
    .filter((m) => !m.system)
    .map((m) => ({ role: m.role, content: m.content }));

  let acc = "";
  // Accumulate the model's reasoning across the turn so the turn-completion hook
  // can distill it into a cleaned "thinking" digest (Mode B). Headless workers/
  // supervisors used to drop reasoning entirely, which is why their thought
  // traces were invisible.
  let reasoningAcc = "";
  const tools: LiveTool[] = [];
  // The live timeline as a chain of SUBSTANTIVE UPDATES — not one bolt per tool.
  // An update = a thing the agent narrated + the cluster of actions that prose
  // led to. A new update opens when prose RESUMES after actions (the model
  // finishing one move and starting the next thought); consecutive tools fold
  // into the current update's action list. So "read a, read b, read c, wrote d"
  // is ONE update ("…→ read a, read b, read c, wrote d"), not four bolts. The
  // phone streams these so you see real, meaningful movement on the fly.
  const liveSteps: { thought: string; actions: string[] }[] = [{ thought: "", actions: [] }];
  let liveWasAction = false;
  let runErr: string | undefined;
  const controller = new AbortController();
  registerRun(conversationId, controller);
  try {
    await runAgent({
      modelId,
      apiKey,
      vault,
      history: baseHistory,
      userMessage: message,
      abortSignal: controller.signal,
      tavilyKey: store.serviceKeys.tavily,
      strictVault: store.strictVaultMode,
      bashDisabled: store.bashDisabled,
      voiceMode: false,
      supervisorMode,
      conversationId,
      reasoningEffort: store.reasoningEffort,
      onEvent: (e) => {
        if (e.kind === "text") {
          acc += e.delta;
          // Prose resuming after actions = the start of a NEW substantive update.
          if (liveWasAction && e.delta.trim()) { liveSteps.push({ thought: "", actions: [] }); liveWasAction = false; }
          liveSteps[liveSteps.length - 1]!.thought += e.delta;
        }
        else if (e.kind === "reasoning") reasoningAcc += e.delta;
        else if (e.kind === "tool_use") {
          tools.push({ id: e.id, name: e.name, input: e.input, startedAt: Date.now() });
          // Fold this action into the CURRENT update's action cluster (don't open
          // a new bolt) — the next prose will open the next update.
          const act = humanizeToolAction(e.name, e.input);
          if (act) liveSteps[liveSteps.length - 1]!.actions.push(act);
          liveWasAction = true;
          void bumpHeartbeat(vault, conversationId, e.name);
        } else if (e.kind === "tool_result") {
          const t = tools.find((x) => x.id === e.id);
          if (t) t.result = e.result;
        } else if (e.kind === "error") {
          runErr = errToString(e.message);
          acc = (acc + `\n\n⚠️ ${runErr}`).trim();
        }
        // Mirror the worker's in-flight text + tools + step timeline into
        // convRuntime so the phone (phoneApp's runDiff) streams it live. Without
        // this a spawned worker was invisible while grinding — and invisible
        // afterward too if it ended on a tool-only turn with no prose.
        useStore.getState().setConvRuntime(conversationId, {
          streamingText: acc,
          streamingReasoning: "",
          liveTools: tools.slice(),
          liveSteps: liveSteps
            .map((s) => ({
              thought: s.thought.trim().slice(0, 600),
              // The cluster of things this update did, de-duped and capped.
              action: [...new Set(s.actions)].join(", ").slice(0, 200),
            }))
            .filter((s) => s.thought || s.action),
        });
      },
    });
  } catch (e) {
    runErr = errToString(e);
    acc = (acc + `\n\n⚠️ worker turn failed: ${runErr}`).trim();
  } finally {
    await endHeartbeat(vault, conversationId).catch(() => {});
    unregisterRun(conversationId, controller);
    // Stop the pulse the moment the turn ends — don't wait on the disk
    // round-trip below, which would leave it blinking until persistence
    // finishes (or forever, if the reply write is skipped on empty output).
    useStore.getState().setConversationStatus(conversationId, "idle");
  }

  // Persist the worker's turn so the thread is coherent and visible on every
  // surface. Persist when there was prose OR tool activity — a worker that only
  // ran tools (e.g. a Bash one-liner) still did real work, and dropping it left
  // the thread blank and the completion notice a bare "(done)".
  await withConvLock(async () => {
    const finalList = await readConversations(vault);
    const fi = finalList.findIndex((c) => c.id === conversationId);
    if (fi >= 0 && (acc.trim() || tools.length)) {
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: acc,
        toolCalls: tools.length ? tools : undefined,
        // A direct reply to something the user typed stays natural prose — the
        // cleaner skips it (see the timeline pass below).
        direct: opts.direct || undefined,
        // The turn ended in an error (SDK/model failure or thrown exception).
        // Flagged so the completion path reports "FAILED", never "done" — a
        // crashed worker that wrote nothing must not look like a deliverable.
        failed: runErr ? true : undefined,
      };
      finalList[fi] = {
        ...finalList[fi]!,
        messages: [...finalList[fi]!.messages, assistantMsg],
        lastActivityAt: Date.now(),
      };
      await writeConversations(vault, finalList);
    }
  });
  await useStore.getState().refreshConversationFromDisk(vault, conversationId).catch(() => {});
  // Now that the final turn is on disk and in the store, drop the live stream
  // so the phone swaps from the streaming bubble to the persisted message.
  useStore.getState().clearConvRuntime(conversationId);

  // Cockpit transform, fired AFTER the turn is persisted so it never delays the
  // thread landing (a no-op if no fast model is configured).
  //   - Mode A: the Activity status line — a clean one-line TASK (for the pill).
  //   - Timeline: EVERY supervisor/worker message is cleaned by a fast model into
  //     its own thought-by-thought trace (run-on narration + actions → modular
  //     thoughts each aligned to the action it led to), stored ON that message.
  //     The user reads the whole thread, so we clean per-message — never one
  //     summary at the end. We clean THIS turn (with its reasoning) and BACKFILL
  //     any recent prior turn that doesn't have a timeline yet, bounded to the
  //     last dozen assistant turns; already-cleaned turns are skipped, so steady
  //     state is one pass per new turn while old threads catch up as they run.
  void (async () => {
    try {
      const list = await readConversations(vault);
      const c = list.find((x) => x.id === conversationId);
      if (!c || (c.source !== "worker" && c.source !== "mission")) return;
      const task = c.messages.find((m) => m.role === "user" && !m.hidden)?.content ?? "";
      const toolNote = tools.length
        ? `\n\nTools run this turn: ${[...new Set(tools.map((t) => t.name))].join(", ")}`
        : "";
      const activity = (acc.trim() || "(tool-only turn, no prose)") + toolNote;
      const apiKeys = useStore.getState().apiKeys;
      const { summarizeWorkerState, summarizeTimeline } = await import("./alert-summary");
      // A mission thread is the SUPERVISOR (manages workers + mission); anything
      // else here is a worker (executes its task). Drives the cleaning's register.
      const role = c.source === "mission" ? "supervisor" : "worker";
      // Recent assistant turns still needing a clean (this turn always qualifies —
      // it has no timeline yet).
      const toClean = c.messages
        .filter((m) => m.role === "assistant")
        .slice(-12)
        // Skip DIRECT replies to the user — those are conversation, kept natural,
        // not chopped into a thought-chain. The timeline is for the reasoning the
        // user doesn't otherwise see (wakes, self-checks), not for answers to a
        // question they asked.
        .filter((m) => !m.timeline && !m.direct && ((m.content || "").trim() || (m.toolCalls || []).length));
      const cleaned = await Promise.all(
        toClean.map((m) => {
          const isThisTurn = m.content === acc; // only this turn has captured reasoning
          const actions = (m.toolCalls || []).map((t) => ({ name: t.name, input: t.input }));
          return summarizeTimeline(m.content || "", isThisTurn ? reasoningAcc : "", actions, apiKeys, role)
            .then((tl) => ({ content: m.content || "", tl }))
            .catch(() => ({ content: m.content || "", tl: null }));
        }),
      );
      const sum = task.trim() ? await summarizeWorkerState(task, activity, apiKeys) : null;
      const haveTimelines = cleaned.filter((x) => x.tl);
      if (!sum && !haveTimelines.length) return;
      await withConvLock(async () => {
        const fresh = await readConversations(vault);
        const i = fresh.findIndex((x) => x.id === conversationId);
        if (i < 0) return;
        const msgs = fresh[i]!.messages.slice();
        // Apply each timeline to its assistant message by CONTENT match — robust
        // to any turns appended since we read above.
        for (const { content, tl } of haveTimelines) {
          for (let k = msgs.length - 1; k >= 0; k--) {
            if (msgs[k]!.role === "assistant" && (msgs[k]!.content || "") === content && !msgs[k]!.timeline) {
              msgs[k] = { ...msgs[k]!, timeline: tl! };
              break;
            }
          }
        }
        fresh[i] = {
          ...fresh[i]!,
          messages: msgs,
          taskSummary: sum?.task || fresh[i]!.taskSummary,
          statusSummary: sum?.status || fresh[i]!.statusSummary,
          summaryRev: msgs.length,
        };
        await writeConversations(vault, fresh);
      });
      await useStore.getState().refreshConversationFromDisk(vault, conversationId).catch(() => {});
    } catch (e) {
      console.warn("[cockpit] timeline/state summary failed:", e);
    }
  })();

  return { reply: acc, error: runErr };
}

// Spawn a NEW worker thread (subagent) and kick its task off in the
// background, returning immediately with the new conversation's id + title.
// The orchestrator (supervisor / the phone's front agent) calls this when the
// user asks it to start a long/heavy job, so the orchestrator's own chat
// stays free to talk while the worker grinds. The worker runs one turn
// (auto-continue lets it span many steps); for GPU work it launches detached
// training that outlives the turn. The worker registers a heartbeat + abort
// handle, so the supervisor can watch and relay to it afterward.
export async function startWorker(
  vault: string,
  task: string,
  title?: string,
  modelId?: string,
  mission?: string,
): Promise<{ id: string; title: string }> {
  // Idempotency: a worker with the SAME task already spawned for this mission in
  // the last few minutes is a re-issue — a supervisor that lost track and called
  // StartWorker again — so return it instead of spawning a duplicate that would
  // re-launch a box / redo the GPU work (the structural backstop under agent
  // honesty). Bounded to a short window so a deliberate later re-run still spawns.
  {
    const m = mission?.trim();
    const RECENT_MS = 5 * 60_000;
    const now0 = Date.now();
    const existing = await readConversations(vault).catch(() => [] as Conversation[]);
    const dup = existing.find(
      (c) =>
        c.source === "worker" &&
        now0 - (c.createdAt ?? 0) < RECENT_MS &&
        (!m || (c.mission ?? "").trim() === m) &&
        (c.messages.find((x) => x.role === "user" && !x.hidden)?.content ?? "").trim() === task.trim(),
    );
    if (dup) return { id: dup.id, title: dup.title };
  }
  const id = newConversationId();
  const t = title?.trim() || deriveConversationTitle([{ role: "user", content: task }]);
  // Tagged "worker" so every surface (ChatsPanel, the phone app's list) can
  // tell spawned subagents apart from the user's own chats. The mission ties
  // it to the North Star it serves — Activity groups workers under it. A
  // worker is NEVER standalone: if no mission was named, its own title is the
  // mission of one, so the Activity grouping invariant holds everywhere.
  const fresh: Conversation = {
    ...emptyConversation(),
    id,
    source: "worker",
    title: t,
    mission: mission?.trim() || t,
  };
  await withConvLock(async () => {
    const list = await readConversations(vault);
    list.unshift(fresh);
    await writeConversations(vault, list);
  });
  await useStore.getState().refreshConversationFromDisk(vault, id).catch(() => {});
  // Fire-and-forget: the worker runs async; we don't await it so the caller
  // (and the user's chat) returns right away. runWorkerTurn appends the task
  // as the worker's first user turn and persists its reply.
  void runWorkerTurn(vault, id, task, { modelId: modelId || useStore.getState().workerModelId }).catch((e) =>
    console.warn("[worker] start failed:", e),
  );
  return { id, title: t };
}

// Start a MISSION: a dedicated supervisor thread that owns one user-approved
// goal end-to-end. The assistant (cockpit chat) calls this on plan approval
// instead of fanning out workers itself — the mission then plans, spawns its
// own workers (which inherit its mission tag), monitors them on self-scheduled
// wakes, spawns more as it learns, and reports milestones via Notify. This is
// the middle layer of assistant → missions → workers: the user talks to the
// assistant; missions do the running.
export async function startMission(
  vault: string,
  goal: string,
  title: string,
): Promise<{ id: string; title: string }> {
  const id = newConversationId();
  const t = title.trim() || deriveConversationTitle([{ role: "user", content: goal }]);
  const fresh: Conversation = {
    ...emptyConversation(),
    id,
    source: "mission",
    role: "supervisor", // its turns run with the vault's supervisor.md prompt
    title: t,
    mission: t, // its own group key — workers it spawns share this
  };
  await withConvLock(async () => {
    const list = await readConversations(vault);
    list.unshift(fresh);
    await writeConversations(vault, list);
  });
  await useStore.getState().refreshConversationFromDisk(vault, id).catch(() => {});
  const brief =
    `MISSION BRIEF (user-approved, handed off by their assistant). You own this goal end-to-end.\n\n` +
    `Mission: ${t}\n\n${goal.trim()}\n\n` +
    `The "Done when" items ARE your success criterion — each is a sub-result that defines this complete. Each is likely its own worker, but that's your call: split, merge, or sequence them as the work actually needs. Start now: open the goal file, spawn your workers (they join this mission automatically), and set your first self-check wake.`;
  void runWorkerTurn(vault, id, brief, { modelId: useStore.getState().supervisorModelId }).catch((e) =>
    console.warn("[mission] start failed:", e),
  );
  return { id, title: t };
}

// Fully tear a mission down so it actually goes away — not just off this
// device's Activity, but for good. The old version only aged the thread's
// lastActivityAt past the 48h window; that left two holes that made stopped
// missions "come back": its workers kept grinding (a running worker re-creates
// the mission's Activity group), and when any worker finished it WOKE the
// supervisor (onRunEnded), which reset lastActivityAt and resurfaced it. A
// self-scheduled wake did the same on a timer.
//
// So stopping a mission now: (1) aborts the supervisor AND every worker that
// shares its mission key, (2) cancels any self-scheduled wakes bound to those
// threads, and (3) tombstone-deletes the mission + its workers. Tombstones
// survive git sync, so a pull from another machine can't bring them back, and
// with the threads gone a late-finishing worker has no mission to wake.
export async function stopAndDeleteMission(vault: string, conversationId: string): Promise<void> {
  const list = await readConversations(vault);
  const mission = list.find((c) => c.id === conversationId && c.source === "mission");
  if (!mission) return;
  const key = (mission.mission ?? mission.title ?? "").trim();
  const workers = key
    ? list.filter((c) => c.source === "worker" && (c.mission ?? "").trim() === key)
    : [];
  const ids = [mission.id, ...workers.map((w) => w.id)];
  // 1) Stop anything mid-run. abortRun is a no-op for threads that aren't live.
  for (const id of ids) abortRun(id);
  // 2) Cancel self-scheduled wakes bound to any of these threads.
  try {
    const { readSchedules } = await import("./schedules");
    const { deleteSchedule } = await import("./schedulerLoop");
    const idSet = new Set(ids);
    for (const sc of await readSchedules(vault)) {
      const t = sc.target as { kind?: string; conversationId?: string };
      if (t?.kind === "existing" && t.conversationId && idSet.has(t.conversationId)) {
        await deleteSchedule(vault, sc.id).catch(() => {});
      }
    }
  } catch (e) {
    console.warn("[mission] schedule cleanup failed:", e);
  }
  // 3) Tombstone-delete the mission + its workers (durable, resurrection-proof).
  // AWAIT the writes: the phone reloads its Activity list the instant /kill
  // returns, and a fire-and-forget delete let that reload re-read the still-on-
  // disk mission before its tombstone flushed — the "deleted mission comes back
  // for a beat" bug. deleteConversation removes from memory synchronously (the
  // desktop stays instant) and resolves once the write lands.
  const del = useStore.getState().deleteConversation;
  await Promise.all(ids.map((id) => del(id)));
}

// Mark a mission FINISHED: its supervisor decided the goal is met. Stamps
// completedAt on the mission so it drops off the Activity page (see
// loadActivity) — the terminal state that was missing, which left done missions
// lingering for 48h. Stops any lingering workers and cancels self-scheduled
// wakes so it can't re-wake itself back onto Activity. Unlike
// stopAndDeleteMission this KEEPS the threads: the user can still open the
// finished mission to review it; it just leaves the live surface.
// Returns true only when THIS call actually retired the mission; false if it
// was already complete. The caller notifies the user only on a true, so the
// "Mission complete" card fires exactly once even when CompleteMission is
// invoked twice (parallel tool calls, or a follow-up turn re-confirming done).
export async function completeMission(vault: string, conversationId: string): Promise<boolean> {
  // Atomic check-and-set of completedAt: the FIRST caller inside the lock wins;
  // a racing/repeat caller sees it already stamped and bails. This is what kills
  // the duplicate "Mission complete" notification (two CompleteMission tool
  // calls in one turn used to both read no-completedAt and both notify).
  let mission: Conversation | undefined;
  let didComplete = false;
  await withConvLock(async () => {
    const fresh = await readConversations(vault);
    const i = fresh.findIndex((c) => c.id === conversationId && c.source === "mission");
    if (i < 0) return;
    mission = fresh[i];
    if (fresh[i]!.completedAt) return; // already complete — leave didComplete false
    // Bump lastActivityAt in lockstep with completedAt. Every cross-machine and
    // in-memory tie-break sorts on lastActivityAt — the Rust union meta-line
    // pick (reconstruct_conversation), the diskNewer test, and the persist
    // merge. Stamping completedAt WITHOUT moving lastActivityAt left the
    // completed meta line tied with a follower's stale no-completedAt line, so a
    // union merge could non-deterministically surface the stale one and a
    // finished mission RESURRECTED onto Activity. One monotonic timestamp closes
    // all three layers at once.
    const t = Date.now();
    fresh[i] = { ...fresh[i]!, completedAt: t, lastActivityAt: t };
    await writeConversations(vault, fresh);
    didComplete = true;
  });
  if (!didComplete || !mission) return false;
  // Real completion: stop leftover workers + cancel self-scheduled wakes so it
  // can't re-wake itself back onto Activity.
  const key = (mission.mission ?? mission.title ?? "").trim();
  const list = await readConversations(vault);
  const workers = key
    ? list.filter((c) => c.source === "worker" && (c.mission ?? "").trim() === key)
    : [];
  for (const w of workers) abortRun(w.id);
  try {
    const { readSchedules } = await import("./schedules");
    const { deleteSchedule } = await import("./schedulerLoop");
    const ids = new Set([mission.id, ...workers.map((w) => w.id)]);
    for (const sc of await readSchedules(vault)) {
      const t = sc.target as { kind?: string; conversationId?: string };
      if (t?.kind === "existing" && t.conversationId && ids.has(t.conversationId)) {
        await deleteSchedule(vault, sc.id).catch(() => {});
      }
    }
  } catch (e) {
    console.warn("[mission] complete: schedule cleanup failed:", e);
  }
  await useStore.getState().refreshConversationFromDisk(vault, conversationId).catch(() => {});
  return true;
}

// "Done when" bullets parsed from a mission brief — same shape the phone's
// spec view parses, so a marked criterion matches what the user sees.
function parseDoneWhenCriteria(brief: string): string[] {
  const out: string[] = [];
  for (const ln of (brief || "").split(/\r?\n/)) {
    const m = ln.match(/^\s*(?:[-*•]|\d+[.)])\s+(.+)$/);
    if (m) out.push(m[1].trim());
  }
  return out;
}
const normalizeCriterion = (s: string) =>
  s.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();

// Mark ONE of a mission's "Done when" criteria verified-complete. The supervisor
// passes the criterion (a paraphrase is fine); we fuzzy-match it to the brief's
// bullets and store the matched bullet's exact text in doneWhenDone, so the
// spec checks off that one bullet (per-criterion progress, not all-at-once).
export async function markDoneWhen(
  vault: string,
  conversationId: string,
  criterion: string,
): Promise<string | null> {
  let matched: string | null = null;
  await withConvLock(async () => {
    const list = await readConversations(vault);
    const i = list.findIndex((c) => c.id === conversationId && c.source === "mission");
    if (i < 0) return;
    const mission = list[i]!;
    const briefMsg =
      mission.messages.find((m) => m.role === "user" && /^\s*MISSION BRIEF/i.test(m.content || "")) ??
      mission.messages.find((m) => m.role === "user");
    const criteria = parseDoneWhenCriteria(briefMsg?.content ?? "");
    const cn = normalizeCriterion(criterion);
    const cwords = new Set(cn.split(" ").filter((w) => w.length > 2));
    let best: string | null = null;
    let bestScore = 0;
    for (const cand of criteria) {
      const candn = normalizeCriterion(cand);
      if (candn === cn || candn.includes(cn) || cn.includes(candn)) {
        best = cand;
        bestScore = 1;
        break;
      }
      const candWords = new Set(candn.split(" ").filter((w) => w.length > 2));
      let shared = 0;
      for (const w of cwords) if (candWords.has(w)) shared++;
      const score = shared / Math.max(1, Math.min(cwords.size, candWords.size));
      if (score > bestScore) {
        bestScore = score;
        best = cand;
      }
    }
    matched = bestScore >= 0.5 ? best : criterion.trim();
    const done = new Set(mission.doneWhenDone ?? []);
    if (matched) done.add(matched);
    list[i] = { ...mission, doneWhenDone: [...done] };
    await writeConversations(vault, list);
  });
  await useStore.getState().refreshConversationFromDisk(vault, conversationId).catch(() => {});
  return matched;
}

// Create a fresh conversation entry on disk for a vault that's not
// currently in memory. Returns the new conversation's id so the
// scheduler can bind subsequent runs to it.
export async function createScheduledConversationOnDisk(
  vault: string,
  title: string,
): Promise<string> {
  const list = await readConversations(vault);
  const fresh: Conversation = {
    ...emptyConversation(),
    id: newConversationId(),
    source: "scheduled",
    title,
  };
  list.unshift(fresh);
  await writeConversations(vault, list);
  return fresh.id;
}
