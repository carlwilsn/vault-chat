import { invoke } from "@tauri-apps/api/core";
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
  newMessageId,
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
import { harnessV2Enabled, twoLaneMissionChatEnabled } from "./harness";

// A mission thread has an unaddressed user steer when a user message sits after
// the executor's last real (non-direct) turn — e.g. one the two-lane
// conversational front just appended while the executor was working. On its next
// wake the executor must run WITH continuity (not fresh-context, which would drop
// history and never see the steer), so the user's instruction actually lands.
function hasTrailingUserSteer(messages: ChatMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "assistant" && !m.direct) return false; // hit the executor's last real turn first
    if (m.role === "user" && !m.hidden && !/^(Watched run |Worker "|Reply from worker |HARNESS CHECK |MISSION BRIEF)/.test(m.content || "")) {
      return true;
    }
  }
  return false;
}


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
  const userMsg: ChatMessage = { role: "user", content: prompt, mid: newMessageId() };
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
      // [harness v2] A scheduled fire into a mission thread IS an autonomous
      // supervisor wake — give it the supervisor prompt AND fresh context (drop
      // history, re-hydrate from mind.md). Gated by the kill-switch, so legacy
      // behavior (no supervisorMode here) is unchanged when it's off.
      supervisorMode: harnessV2Enabled() && list[idx]?.role === "supervisor",
      freshContext: harnessV2Enabled() && list[idx]?.role === "supervisor",
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
      mid: newMessageId(),
    };
    finalList[fi] = {
      ...finalList[fi]!,
      messages: [...finalList[fi]!.messages, assistantMsg],
      lastActivityAt: Date.now(),
      // [unread hygiene] Only user-facing threads earn an unread badge. A mission
      // self-check fires through this scheduled path too, and missions/workers live
      // on the Activity surface, not the chat list — badging them was the "why is
      // everything unread" noise. Leave their unread untouched.
      unread:
        finalList[fi]!.source === "worker" || finalList[fi]!.source === "mission"
          ? finalList[fi]!.unread
          : true,
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
  // [harness v2] forkNudge marks the ONE deterministic re-entry the fork-forcing
  // rule is allowed (see the end of this function) — a nudged turn that parks
  // again escalates instead of recursing.
  opts: { modelId?: string; resume?: boolean; direct?: boolean; forkNudge?: boolean } = {},
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

  const userMsg: ChatMessage = { role: "user", content: message, mid: newMessageId() };
  // [harness v2] Harness-generated wakes (worker-finish, watched-run, fork nudge,
  // async AskWorker replies) must NOT clear a mission's waiting-on-the-user state
  // — only a genuine answer does. These are the harness's own wake prefixes.
  const isHarnessWake = /^(Watched run |Worker "|Reply from worker |HARNESS CHECK )/.test(message);
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
    // [harness v2] A genuine incoming message to a mission that's AWAITING_USER
    // IS the user's answer — flip it back to RUNNING as the turn seeds, so the
    // board stops saying "needs you" the moment the reply lands. (The scheduler
    // refuses to fire self-checks into an awaiting mission, so anything arriving
    // here that isn't a recognized harness wake came from the user, directly or
    // relayed.)
    const clearAwait =
      harnessV2Enabled() &&
      list[idx]!.source === "mission" &&
      list[idx]!.missionState === "AWAITING_USER" &&
      !opts.resume &&
      !isHarnessWake;
    list[idx] = {
      ...list[idx]!,
      messages,
      lastActivityAt: Date.now(),
      ...(clearAwait ? { missionState: "RUNNING" as const } : {}),
    };
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
  // [harness v2] Whether this turn handed the user a decision (AskUser). The
  // flag lives inside runAgent and isn't surfaced, so observe the tool stream —
  // it drives the AWAITING_USER state stamp and exempts the turn from the
  // fork-forcing rule.
  let askedUserThisTurn = false;
  const controller = new AbortController();
  registerRun(conversationId, controller);
  // [harness v2] Quota-class failures get ONE retry on a different model. The
  // existing fallback only triggers on a MISSING provider key — a key that's
  // present but broken (an exhausted upstream behind openrouter/auto, an unpaid
  // account) sailed straight through it, and every respawned worker marched into
  // the same dead upstream (5× in the first battery). Provider quota is not a
  // task failure; don't let it read as one.
  const QUOTA_ERR_RE = /quota|billing|insufficient[_ ]?credit|credit balance|payment required|exceeded your current/i;
  const resolveQuotaFallback = (failedId: string): { id: string; key: string } | null => {
    const s = useStore.getState();
    for (const cand of [s.supervisorModelId, DEFAULT_WORKER_MODEL_ID, s.modelId]) {
      if (!cand || cand === failedId || cand === AUTO_MODEL_ID) continue;
      const cSpec = findModel(cand);
      const cKey = cSpec ? s.apiKeys[cSpec.provider] : undefined;
      if (cSpec && cKey) return { id: cand, key: cKey };
    }
    return null;
  };
  let attemptModelId = modelId;
  let attemptKey = apiKey;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        // Fresh accumulators — the failed attempt's crash text must not leak
        // into the retried turn's record.
        acc = "";
        reasoningAcc = "";
        tools.length = 0;
        liveSteps.splice(0, liveSteps.length, { thought: "", actions: [] });
        liveWasAction = false;
        runErr = undefined;
        askedUserThisTurn = false;
      }
      try {
        await runAgent({
          modelId: attemptModelId,
          apiKey: attemptKey,
      vault,
      history: baseHistory,
      userMessage: message,
      abortSignal: controller.signal,
      tavilyKey: store.serviceKeys.tavily,
      strictVault: store.strictVaultMode,
      bashDisabled: store.bashDisabled,
      voiceMode: false,
      supervisorMode,
      // [harness v2] Autonomous supervisor wakes (self-checks, worker-finished
      // relays, resumes) run FRESH-CONTEXT — drop the accumulated thread, re-hydrate
      // from mind.md + the kept brief + live-state. A direct reply to something the
      // user typed keeps full continuity. Gated by the kill-switch.
      // Fresh-context autonomous wake — UNLESS a two-lane conversational front
      // left an unaddressed user steer in the thread, in which case keep continuity
      // so the executor actually sees + handles it (gated: off = unchanged).
      freshContext:
        supervisorMode &&
        !opts.direct &&
        harnessV2Enabled() &&
        !(twoLaneMissionChatEnabled() && hasTrailingUserSteer(baseMessages)),
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
          if (e.name === "AskUser") askedUserThisTurn = true;
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
      }
      // Retry decision: only a first-attempt quota-class failure earns the one
      // fallback run; anything else (real task errors, aborts) lands as-is.
      if (!runErr || attempt > 0 || !QUOTA_ERR_RE.test(runErr) || !harnessV2Enabled()) break;
      const fb = resolveQuotaFallback(attemptModelId);
      if (!fb) break;
      vlog("worker.quota.fallback", {
        conv: conversationId.slice(0, 8),
        from: attemptModelId,
        to: fb.id,
      });
      attemptModelId = fb.id;
      attemptKey = fb.key;
    }
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
        mid: newMessageId(),
      };
      // [harness v2] Stamp the mission's lifecycle state as this turn lands:
      // AskUser → AWAITING_USER; otherwise back to RUNNING (never overwrite a
      // terminal DONE/KILLED — CompleteMission/stop may have stamped it mid-turn).
      const cur = finalList[fi]!;
      // [harness v2] AskUser → AWAITING_USER. Otherwise RUNNING — EXCEPT never
      // clobber a live AWAITING_USER from an autonomous turn (a worker-finish
      // wake landing while the mission waits on the user); only a genuine user
      // reply (opts.direct) clears the wait. Terminal states are untouched.
      const v2state: Conversation["missionState"] =
        harnessV2Enabled() && supervisorMode && cur.source === "mission" &&
        cur.missionState !== "DONE" && cur.missionState !== "KILLED"
          ? askedUserThisTurn
            ? "AWAITING_USER"
            : cur.missionState === "AWAITING_USER" && !opts.direct
              ? "AWAITING_USER"
              : "RUNNING"
          : cur.missionState;
      finalList[fi] = {
        ...cur,
        messages: [...cur.messages, assistantMsg],
        lastActivityAt: Date.now(),
        missionState: v2state,
      };
      await writeConversations(vault, finalList);
    }
  });
  await useStore.getState().refreshConversationFromDisk(vault, conversationId).catch(() => {});
  // Now that the final turn is on disk and in the store, drop the live stream
  // so the phone swaps from the streaming bubble to the persisted message.
  useStore.getState().clearConvRuntime(conversationId);

  // [harness v2] Fork-forcing: a mission turn may not END PARKED. The Coconut
  // gap-closer reached its budget fork, wrote a diagnosis, and went idle with no
  // AskUser and no next wake — invisible for a day while the box billed to ~$100.
  // Enforced deterministically after every autonomous supervisor turn: there must
  // be a NEXT TICK (work delegated, a wake scheduled, a watched run, a live
  // worker) or a pending user decision — otherwise re-enter once with a nudge,
  // and if the nudged turn parks again, escalate to the user. Fire-and-forget so
  // callers (AskWorker, watcher wakes) are never blocked on it.
  if (harnessV2Enabled() && supervisorMode && !opts.direct && !opts.resume && !runErr) {
    void enforceMissionLoopInvariant(
      vault,
      conversationId,
      tools.map((t) => t.name),
      askedUserThisTurn,
      !!opts.forkNudge,
      acc,
    ).catch((e) => console.warn("[mission] loop-invariant check failed:", e));
  }

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

// ---- the conversational front (two-lane mission chat) ----
//
// A message to a BUSY mission used to queue silently behind the executor's turn
// and go unanswered for minutes. Instead, this runs the assistant persona as a
// SECOND lane on the SAME thread: it reads a snapshot of the executor's live
// state and answers the user immediately, while the executor keeps grinding.
// One thread on the surface, two agents behind it.
//
// Safe-by-construction: it runs at ASSISTANT tier (assistantMode forces it in
// agent.ts), which drops StartWorker/CompleteMission/MarkDoneWhen — so the
// conversational front can READ and ANSWER but can never spawn or mutate the
// mission's work concurrently with the executor that owns it. It registers under
// a distinct `#chat` run key so it never collides with the executor's run,
// status, or live-stream slot, and it broadcasts its own `chat` lane events
// (start/stream/end) so the phone freezes the executor's edge while it answers.
export async function runMissionChatTurn(
  vault: string,
  conversationId: string,
  message: string,
): Promise<{ reply: string; error?: string }> {
  const store = useStore.getState();
  const text = message.trim();
  if (!text) return { reply: "", error: "empty message" };

  // The conversational front is the interactive assistant — use the chat default
  // model (a full-fidelity surface), not the heavy worker grind model.
  let modelId = store.modelId;
  let spec = findModel(modelId);
  if (!spec || !store.apiKeys[spec.provider]) {
    const fb = findModel(store.supervisorModelId) || findModel(DEFAULT_WORKER_MODEL_ID);
    if (fb && store.apiKeys[fb.provider]) { modelId = fb.id; spec = fb; }
  }
  const apiKey = spec ? store.apiKeys[spec.provider] : undefined;
  if (!spec || !apiKey) return { reply: "", error: "no model / API key configured" };

  // Distinct run identity so the conversational lane never touches the executor's
  // run registration, status, or convRuntime slot.
  const chatKey = conversationId + "#chat";

  const broadcastChat = (phase: string, extra?: Record<string, unknown>) =>
    void invoke("phone_broadcast", {
      json: JSON.stringify({ type: "chat", convId: conversationId, phase, ...(extra || {}) }),
    }).catch(() => {});

  // Append the user's turn to the mission thread up front, so the exchange is one
  // clean [user, reply] pair in the right order and the executor's next turn sees
  // the message in place (no duplicate append from a separate steering path).
  const userMsg: ChatMessage = { role: "user", content: text, mid: newMessageId() };
  const seeded = await withConvLock(async () => {
    const list = await readConversations(vault);
    const idx = list.findIndex((c) => c.id === conversationId);
    if (idx < 0) return null;
    const messages = [...list[idx]!.messages, userMsg];
    // A genuine user reply clears an AWAITING_USER wait, same as the executor path.
    const clearAwait =
      harnessV2Enabled() && list[idx]!.source === "mission" && list[idx]!.missionState === "AWAITING_USER";
    list[idx] = {
      ...list[idx]!,
      messages,
      lastActivityAt: Date.now(),
      ...(clearAwait ? { missionState: "RUNNING" as const } : {}),
    };
    await writeConversations(vault, list);
    return { messages, title: list[idx]!.title };
  });
  if (!seeded) return { reply: "", error: `mission thread not found: ${conversationId}` };
  await useStore.getState().refreshConversationFromDisk(vault, conversationId).catch(() => {});

  // Snapshot the executor's live state at the instant of asking — where its
  // current turn is, or that it's idle. This is what lets the front answer "what
  // are you doing right now" without waiting for the executor to pause.
  const rt = useStore.getState().convRuntime[conversationId];
  let snapshot: string;
  if (rt && (((rt.streamingText || "").trim()) || (rt.liveSteps || []).length)) {
    const steps = (rt.liveSteps || [])
      .map((s) => `- ${(s.thought || "").trim()}${s.action ? ` → ${s.action}` : ""}`)
      .filter((l) => l.trim() !== "-")
      .join("\n");
    const tail = (rt.streamingText || "").slice(-1400);
    snapshot =
      "[LIVE EXECUTOR SNAPSHOT — the mission's executor (a separate agent) is working RIGHT NOW; this is where its current turn stands, frozen at the moment the user asked.]\n" +
      (steps ? `Recent reasoning → actions:\n${steps}\n` : "") +
      (tail ? `\nText in progress:\n${tail}\n` : "");
  } else {
    snapshot =
      "[EXECUTOR STATE: idle right now — between self-checks. Its last completed work is the thread above.]";
  }
  const framing =
    "You are the always-on conversational front for this mission — the person the user talks to. A separate executor agent does the actual work (spawns/steers workers, runs the mission loop); you do NOT orchestrate. Answer the user directly and concisely from the thread and the snapshot below. If they're steering the work, acknowledge it plainly — the executor will pick their message up from this thread on its next turn. Don't pretend to have done work yourself.";

  const baseHistory = seeded.messages
    .filter((m) => !m.system && m.content !== text) // exclude the just-appended turn (passed as userMessage)
    .map((m) => ({ role: m.role, content: m.content }));

  const controller = new AbortController();
  registerRun(chatKey, controller);
  broadcastChat("start");

  let acc = "";
  let lastLen = 0;
  let runErr: string | undefined;
  try {
    await runAgent({
      modelId,
      apiKey,
      vault,
      history: baseHistory,
      userMessage: `${framing}\n\n${snapshot}\n\n---\n\nUser: ${text}`,
      abortSignal: controller.signal,
      tavilyKey: store.serviceKeys.tavily,
      strictVault: store.strictVaultMode,
      bashDisabled: store.bashDisabled,
      voiceMode: false,
      // assistantMode forces assistant tier in agent.ts — read/answer only.
      assistantMode: true,
      conversationId,
      reasoningEffort: store.reasoningEffort,
      onEvent: (e) => {
        if (e.kind === "text") {
          acc += e.delta;
          // Throttle stream broadcasts to keep the SSE light; final flush below.
          if (acc.length - lastLen >= 16) {
            lastLen = acc.length;
            broadcastChat("stream", { text: acc.slice(-4000) });
          }
        } else if (e.kind === "error") {
          runErr = errToString(e.message);
        }
      },
    });
  } catch (e) {
    runErr = errToString(e);
  } finally {
    unregisterRun(chatKey, controller);
  }

  // Persist the reply as a DIRECT turn (natural prose — the timeline cleaner and
  // the fresh-context executor wakes both skip `direct` messages).
  const reply = acc.trim();
  if (reply) {
    await withConvLock(async () => {
      const list = await readConversations(vault);
      const idx = list.findIndex((c) => c.id === conversationId);
      if (idx < 0) return;
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: reply,
        direct: true,
        mid: newMessageId(),
      };
      list[idx] = { ...list[idx]!, messages: [...list[idx]!.messages, assistantMsg], lastActivityAt: Date.now() };
      await writeConversations(vault, list);
    });
    await useStore.getState().refreshConversationFromDisk(vault, conversationId).catch(() => {});
  }
  // End the lane last, AFTER the reply is on disk — the phone unfreezes the
  // executor edge and folds the reply in from the persisted thread.
  broadcastChat("end");
  return { reply, error: runErr };
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
    missionState: harnessV2Enabled() ? "RUNNING" : undefined,
  };
  // [harness v2] One objective, one card. Two live cards for the same gap (the
  // Coconut duplication) meant every status check first had to disambiguate
  // WHICH mission — and the $80 cap lived on one card while the work ran on the
  // other. If a live (not completed/killed) mission with this title already
  // exists, approval re-binds to it instead of minting a twin. Checked INSIDE
  // the lock so two rapid approvals can't race past each other.
  const existing = await withConvLock(async () => {
    const list = await readConversations(vault);
    if (harnessV2Enabled()) {
      const same = list.find(
        (c) =>
          c.source === "mission" &&
          !c.completedAt &&
          c.missionState !== "DONE" &&
          c.missionState !== "KILLED" &&
          normalizeCriterion(c.title) === normalizeCriterion(t),
      );
      if (same) return same;
    }
    list.unshift(fresh);
    await writeConversations(vault, list);
    return null;
  });
  if (existing) {
    // Wake the existing mission with the (possibly refined) goal instead of
    // starting a parallel twin.
    void runWorkerTurn(
      vault,
      existing.id,
      `The user re-approved this mission's objective. Refreshed brief follows — reconcile it with your current state (goal file + mind.md) and continue; do NOT restart finished work.\n\n${goal.trim()}`,
      { modelId: useStore.getState().supervisorModelId },
    ).catch((e) => console.warn("[mission] re-approve wake failed:", e));
    return { id: existing.id, title: existing.title };
  }
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
  // 3) [harness v2] KEEP the thread, stamp it KILLED — the visible Archive.
  // Silent deletion is what produced "missions disappearing???" / "what happened
  // to my coconut mission": a killed mission vanished without a trace and the
  // user had to reconstruct what happened. Now it leaves the live board (via
  // completedAt, same as a finished mission) but survives in the archive with
  // its final state readable. Workers are kept too — they're the mission's
  // history. Aborts + wake-cancellation above already guarantee it can't
  // resurrect itself onto Activity. Explicit swipe-delete in the archive remains
  // the way to actually remove it (tombstoned, resurrection-proof).
  // A mission that's ALREADY terminal (archived DONE/KILLED) being killed again
  // is the user clearing it out of the archive (swipe-delete) — fall through to
  // the real tombstone-delete below. First kill archives; second kill removes.
  const alreadyTerminal =
    !!mission.completedAt || mission.missionState === "DONE" || mission.missionState === "KILLED";
  if (harnessV2Enabled() && !alreadyTerminal) {
    await withConvLock(async () => {
      const fresh = await readConversations(vault);
      const t = Date.now();
      for (let i = 0; i < fresh.length; i++) {
        if (fresh[i]!.id === mission.id) {
          // lastActivityAt bumps in lockstep so a union tie-break can't surface
          // a stale not-killed meta line (same rule as completeMission), and the
          // reconstruct terminal-wins guard makes KILLED durable regardless.
          // unread:false so an archived mission never nags from the chat list.
          fresh[i] = { ...fresh[i]!, missionState: "KILLED" as const, billing: false, completedAt: t, lastActivityAt: t, unread: false };
        }
      }
      await writeConversations(vault, fresh);
    });
    await useStore.getState().refreshConversationFromDisk(vault, mission.id).catch(() => {});
    return;
  }
  // Legacy (kill-switch off): tombstone-delete the mission + its workers.
  // AWAIT the writes: the phone reloads its Activity list the instant /kill
  // returns, and a fire-and-forget delete let that reload re-read the still-on-
  // disk mission before its tombstone flushed — the "deleted mission comes back
  // for a beat" bug. deleteConversation removes from memory synchronously (the
  // desktop stays instant) and resolves once the write lands.
  const del = useStore.getState().deleteConversation;
  await Promise.all(ids.map((id) => del(id)));
}

// [harness v2] The fork-forcing rule: after an autonomous supervisor turn, the
// mission must have a next tick or a pending user decision — "idle at a fork" is
// illegal. Exits that satisfy the invariant:
//   (a) work delegated / advanced this turn (StartWorker, AskWorker, WatchRun,
//       MarkDoneWhen, CompleteMission) or a wake scheduled (Schedule),
//   (b) the user was asked (AskUser → AWAITING_USER; their reply is the wake),
//   (c) an external wake source already exists: an enabled schedule targeting
//       this thread, a live watched run it owns, or a live worker of its mission,
//   (d) the mission is terminal (DONE / KILLED).
// If NONE hold, the harness re-enters the thread once with a corrective nudge;
// a nudged turn that parks again escalates to the user's Alerts feed and flips
// the mission to AWAITING_USER so the board shows the truth ("parked, needs
// you") instead of a healthy-looking idle card.
// NOTE: MarkDoneWhen is deliberately NOT here — checking off a criterion doesn't
// secure a next tick (a turn can check a box and still strand the mission).
const PROGRESS_TOOLS = new Set([
  "StartWorker",
  "AskWorker",
  "WatchRun",
  "CompleteMission",
  "Schedule",
]);

async function enforceMissionLoopInvariant(
  vault: string,
  conversationId: string,
  toolNames: string[],
  askedUser: boolean,
  wasNudge: boolean,
  turnText: string,
): Promise<void> {
  // (a) + (b): satisfied by this turn's own actions.
  if (askedUser) return;
  if (toolNames.some((n) => PROGRESS_TOOLS.has(n))) return;

  const list = await readConversations(vault);
  const mission = list.find((c) => c.id === conversationId && c.source === "mission");
  if (!mission) return;
  // (d) terminal.
  if (mission.completedAt || mission.missionState === "DONE" || mission.missionState === "KILLED") return;

  // (c) external wake sources.
  try {
    const { readSchedules } = await import("./schedules");
    for (const sc of await readSchedules(vault)) {
      const t = sc.target as { kind?: string; conversationId?: string };
      if (
        sc.enabled &&
        t?.kind === "existing" &&
        t.conversationId === conversationId &&
        (sc.recurrence?.kind !== "once" || !sc.lastFiredAt)
      )
        return; // a wake is coming
    }
  } catch {
    // unreadable schedules — fall through to the nudge rather than assume safety
  }
  try {
    const { readJobs } = await import("./runWatcher");
    if ((await readJobs(vault)).some((j) => j.status === "running" && j.ownerConvId === conversationId))
      return; // the run-watcher will wake it
  } catch {
    /* same */
  }
  try {
    const { activeRuns } = await import("./runRegistry");
    const live = new Set(activeRuns());
    const key = (mission.mission ?? mission.title ?? "").trim();
    if (
      key &&
      list.some((c) => c.source === "worker" && (c.mission ?? "").trim() === key && live.has(c.id))
    )
      return; // a live worker's finish will wake it
  } catch {
    /* same */
  }

  if (!wasNudge) {
    // One deterministic re-entry: name the violation, name the legal exits.
    vlog("mission.parked.nudge", { conv: conversationId.slice(0, 8) });
    void runWorkerTurn(
      vault,
      conversationId,
      `HARNESS CHECK — your last turn ended PARKED: no worker running, no watched run, no scheduled wake, no question to the user. A mission may never idle silently. Pick the right exit now: (1) if you're at a genuine money/irreversible fork the user must decide, call AskUser with one crisp question; (2) if the next step is yours to take, take it (StartWorker / WatchRun / act directly) — for a reversible judgment call, decide it yourself and record it; (3) if you're waiting on something external, Schedule your own next check; (4) if the goal is verified done, call CompleteMission. Do not reply with only prose.`,
      { modelId: useStore.getState().supervisorModelId, forkNudge: true },
    ).catch((e) => console.warn("[mission] fork nudge failed:", e));
    return;
  }

  // Nudged and STILL parked — stop burning turns, surface the truth to the user.
  vlog("mission.parked.escalate", { conv: conversationId.slice(0, 8) });
  await withConvLock(async () => {
    const fresh = await readConversations(vault);
    const i = fresh.findIndex((c) => c.id === conversationId);
    if (i < 0) return;
    if (fresh[i]!.missionState === "DONE" || fresh[i]!.missionState === "KILLED") return;
    fresh[i] = { ...fresh[i]!, missionState: "AWAITING_USER" as const, lastActivityAt: Date.now() };
    await writeConversations(vault, fresh);
  });
  try {
    const { notify } = await import("./phoneApp");
    const tail = (turnText || "").trim().slice(-400);
    await notify(
      "ask",
      `Mission parked — ${mission.title}`,
      `This mission ended two turns in a row with no next step (no worker, no wake, no question). It is HOLDING, not progressing. Its last words:\n\n${tail || "(no prose)"}\n\nOpen the thread and tell it how to proceed.`,
      conversationId,
      {
        intention: `Mission parked · ${mission.title}`,
        summary: "Supervisor idled at a decision point twice — needs your direction.",
        icon: "⏸️",
        cls: "r",
      },
    );
  } catch (e) {
    console.warn("[mission] parked-escalation notify failed:", e);
  }
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
export async function completeMission(
  vault: string,
  conversationId: string,
): Promise<{ ok: boolean; already?: boolean; missing?: string[] }> {
  // [harness v2] Deterministic completion gate: a mission may only complete when
  // every "Done when" bullet in its brief has been individually checked off via
  // MarkDoneWhen (each of which passed the independent evidence check). Pure
  // code, zero tokens — the supervisor cannot declare victory over an unmet
  // criterion; it must either verify the remaining items or take the miss to the
  // user. Closes the "sweep is done but the mission isn't" / silent-done class.
  if (harnessV2Enabled()) {
    const pre = await readConversations(vault);
    const m0 = pre.find((c) => c.id === conversationId && c.source === "mission");
    if (m0 && !m0.completedAt) {
      const briefMsg =
        m0.messages.find((m) => m.role === "user" && /^\s*MISSION BRIEF/i.test(m.content || "")) ??
        m0.messages.find((m) => m.role === "user");
      const criteria = parseDoneWhenCriteria(briefMsg?.content ?? "");
      const done = new Set((m0.doneWhenDone ?? []).map(normalizeCriterion));
      const missing = criteria.filter((c) => !done.has(normalizeCriterion(c)));
      if (missing.length > 0) {
        vlog("mission.complete.rejected", { conv: conversationId.slice(0, 8), missing: missing.length });
        return { ok: false, missing };
      }
    }
  }
  // Atomic check-and-set of completedAt: the FIRST caller inside the lock wins;
  // a racing/repeat caller sees it already stamped and bails. This is what kills
  // the duplicate "Mission complete" notification (two CompleteMission tool
  // calls in one turn used to both read no-completedAt and both notify).
  let mission: Conversation | undefined;
  let didComplete = false;
  let already = false;
  await withConvLock(async () => {
    const fresh = await readConversations(vault);
    const i = fresh.findIndex((c) => c.id === conversationId && c.source === "mission");
    if (i < 0) return;
    mission = fresh[i];
    if (fresh[i]!.completedAt) {
      already = true;
      return; // already complete — leave didComplete false
    }
    // Bump lastActivityAt in lockstep with completedAt. Every cross-machine and
    // in-memory tie-break sorts on lastActivityAt — the Rust union meta-line
    // pick (reconstruct_conversation), the diskNewer test, and the persist
    // merge. Stamping completedAt WITHOUT moving lastActivityAt left the
    // completed meta line tied with a follower's stale no-completedAt line, so a
    // union merge could non-deterministically surface the stale one and a
    // finished mission RESURRECTED onto Activity. One monotonic timestamp closes
    // all three layers at once.
    const t = Date.now();
    // Clear unread on completion: the source-gated badging paths only PRESERVE a
    // mission's unread (they never force it false), so a badge picked up mid-run
    // would otherwise cling to the finished thread — "why is this completed
    // mission unread?" A terminal mission is, by definition, nothing to catch up
    // on. unread:false here is the one place that guarantees it.
    fresh[i] = {
      ...fresh[i]!,
      completedAt: t,
      lastActivityAt: t,
      missionState: "DONE" as const,
      billing: false,
      unread: false,
    };
    await writeConversations(vault, fresh);
    didComplete = true;
  });
  if (!didComplete || !mission) return { ok: false, already };
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
  return { ok: true };
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

// Pull the vault-relative file paths a criterion / brief names and read each one
// live from disk (capped, bounded count), so the evidence auditor judges a "the
// file exists / has N lines / contains X" claim against the REAL bytes, not the
// agent's paraphrase. Reports non-existence explicitly — a criterion that
// requires a file the disk doesn't have is not met, whatever the agent wrote.
async function readNamedFiles(
  vault: string,
  text: string,
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>,
): Promise<string> {
  const seen = new Set<string>();
  const rels: string[] = [];
  // The leading `\.?` is load-bearing: vault paths are dotfiles
  // (`.vault-chat/...`), and a match that starts at `[\w]` would drop the dot and
  // resolve `${vault}/vault-chat/...` — a path that never exists — making every
  // criterion that names a vault file read as "absent" and get falsely rejected.
  const re = /`?(\.?[\w][\w./\-]*\.[A-Za-z0-9]{1,6})`?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const rel = m[1]!.replace(/^\.\//, "");
    if (!rel.includes("/")) continue; // a bare filename is too ambiguous to resolve
    if (rel.includes("..")) continue; // never traverse out of the vault
    if (seen.has(rel)) continue;
    seen.add(rel);
    rels.push(rel);
    if (rels.length >= 6) break; // bound the reads
  }
  const parts: string[] = [];
  for (const rel of rels) {
    const body = await invoke<string>("read_text_file", { path: `${vault}/${rel}` }).catch(() => null);
    if (body == null) {
      // Could NOT read — treat as INCONCLUSIVE, never as proof of failure. A path
      // this reader can't resolve (or a transient read error) must not hard-block
      // a legitimate completion; the auditor falls back to the goal file. Only a
      // file that reads with CONTRADICTING content is a hard fail.
      parts.push(`-- ${rel}: could not be read here (unresolved path or read error) — inconclusive, not proof of absence --`);
    } else {
      const lineCount = body.split(/\r?\n/).length;
      parts.push(`-- ${rel} (${lineCount} lines, ${body.length} bytes) --\n${body.slice(0, 2500)}`);
    }
  }
  return parts.join("\n\n");
}

// Mark ONE of a mission's "Done when" criteria verified-complete. The supervisor
// passes the criterion (a paraphrase is fine); we fuzzy-match it to the brief's
// bullets and store the matched bullet's exact text in doneWhenDone, so the
// spec checks off that one bullet (per-criterion progress, not all-at-once).
export async function markDoneWhen(
  vault: string,
  conversationId: string,
  criterion: string,
): Promise<{ matched: string | null; verified: boolean; reason?: string }> {
  // Fuzzy-match the claimed criterion to the brief's bullets (read-only pass —
  // the write happens under the lock only after verification).
  const list0 = await readConversations(vault);
  const mission0 = list0.find((c) => c.id === conversationId && c.source === "mission");
  if (!mission0) return { matched: null, verified: false, reason: "mission not found" };
  const briefMsg =
    mission0.messages.find((m) => m.role === "user" && /^\s*MISSION BRIEF/i.test(m.content || "")) ??
    mission0.messages.find((m) => m.role === "user");
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
  const matched = bestScore >= 0.5 ? best : criterion.trim();

  // [harness v2] Independent verification BEFORE the check-off lands. The actor
  // doesn't grade its own work: a fresh fast-model auditor judges whether the
  // RECORDED state (mind.md + the thread's recent output) concretely
  // substantiates the criterion. The BitNet-era lesson ("a worker reporting
  // 'completed' is NOT evidence") becomes a rail instead of a prompt plea.
  // Fails OPEN when no fast model is configured (verifier returns null).
  if (harnessV2Enabled() && matched) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      // Evidence is GROUND TRUTH, not the agent's own prose. Two battery failures
      // drove this: (1) reading the SHARED supervisor/mind.md let ANOTHER mission's
      // state (a still-parked AskUser) contaminate this audit and cause phantom
      // rejections — so read only THIS mission's goal file; (2) the auditor
      // rubber-stamped "no missed wakes / no gaps" off the agent's self-authored
      // summary while the log on disk had out-of-order timestamps — so read the
      // files NAMED IN THE CRITERION straight from disk and give the auditor the
      // real bytes to check the claim against. The agent's narration is now a
      // CLAIM to corroborate, not the evidence itself.
      const briefText = briefMsg?.content ?? "";
      const goalPath = (briefText.match(/\.vault-chat\/supervisor\/goals\/[\w.\-]+\.md/) ?? [])[0];
      const goalDoc = goalPath
        ? await invoke<string>("read_text_file", { path: `${vault}/${goalPath}` }).catch(() => "")
        : "";
      const groundTruth = await readNamedFiles(vault, `${matched}\n${criterion}\n${briefText}`, invoke);
      const recent = mission0.messages
        .filter((m) => m.role === "assistant")
        .slice(-2)
        .map((m) => m.content ?? "")
        .join("\n\n");
      const evidence =
        (goalDoc
          ? `== this mission's goal file (scoped — no other mission's state) ==\n${goalDoc.slice(0, 6000)}\n\n`
          : "") +
        (groundTruth
          ? `== GROUND TRUTH: files named in the criterion, read from disk just now ==\n${groundTruth}\n\n`
          : "") +
        `== the agent's own recent narration (a CLAIM — corroborate it against the ground truth above; do NOT trust it on its own) ==\n${recent.slice(-3000)}`;
      const { verifyCriterionEvidence } = await import("./alert-summary");
      const verdict = await verifyCriterionEvidence(matched, evidence, useStore.getState().apiKeys);
      if (verdict && !verdict.pass) {
        vlog("mission.markdone.rejected", { conv: conversationId.slice(0, 8), reason: verdict.reason });
        return { matched, verified: false, reason: verdict.reason };
      }
    } catch (e) {
      console.warn("[mission] done-when verification errored (failing open):", e);
    }
  }

  await withConvLock(async () => {
    const list = await readConversations(vault);
    const i = list.findIndex((c) => c.id === conversationId && c.source === "mission");
    if (i < 0) return;
    const done = new Set(list[i]!.doneWhenDone ?? []);
    if (matched) done.add(matched);
    list[i] = { ...list[i]!, doneWhenDone: [...done], lastActivityAt: Date.now() };
    await writeConversations(vault, list);
  });
  await useStore.getState().refreshConversationFromDisk(vault, conversationId).catch(() => {});
  return { matched, verified: true };
}

// [harness v2] The hard-note tool: append one structured judgment to the
// per-vault decision log. Soft, head-only judgments ("the user sounded hesitant
// about spend — lean conservative"; "seed 3's divergence is real, not noise")
// were exactly what a fresh-context wake could lose if left un-written; this
// gives them a durable, append-only home the model is contractually required to
// use at decision time (see supervisor.md). decisions.jsonl is COLD storage —
// audit/history, never auto-injected into context (mind.md stays the pruned hot
// state), so it can grow without re-creating the dumb-zone problem in a file.
export async function recordJudgment(
  vault: string,
  conversationId: string,
  j: { claim: string; why: string; confidence: string; whatWouldChangeIt?: string },
): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  const path = `${vault}/.vault-chat/supervisor/decisions.jsonl`;
  let missionTitle = "";
  try {
    const conv = (await readConversations(vault)).find((c) => c.id === conversationId);
    missionTitle = conv?.mission ?? conv?.title ?? "";
  } catch {
    /* title is best-effort */
  }
  const rec = {
    ts: Date.now(),
    conv: conversationId,
    mission: missionTitle,
    claim: j.claim.slice(0, 600),
    why: j.why.slice(0, 1000),
    confidence: j.confidence,
    whatWouldChangeIt: (j.whatWouldChangeIt ?? "").slice(0, 600) || undefined,
  };
  const prev = await invoke<string>("read_text_file", { path }).catch(() => "");
  await invoke("write_text_file", {
    path,
    contents: (prev ? prev.replace(/\n?$/, "\n") : "") + JSON.stringify(rec) + "\n",
  });
}

// [harness v2] Stamp a mission AWAITING_USER (idempotent) — called when a pending
// unanswered AskUser is detected, so the board shows "needs you" instead of a
// healthy-idle card. lastActivityAt bumps in lockstep (union tie-break rule).
export async function stampMissionAwaitingUser(vault: string, conversationId: string): Promise<void> {
  await withConvLock(async () => {
    const list = await readConversations(vault);
    const i = list.findIndex((c) => c.id === conversationId && c.source === "mission");
    if (i < 0) return;
    const cur = list[i]!;
    if (cur.completedAt || cur.missionState === "AWAITING_USER" || cur.missionState === "DONE" || cur.missionState === "KILLED") return;
    list[i] = { ...cur, missionState: "AWAITING_USER" as const, lastActivityAt: Date.now() };
    await writeConversations(vault, list);
  });
  await useStore.getState().refreshConversationFromDisk(vault, conversationId).catch(() => {});
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
