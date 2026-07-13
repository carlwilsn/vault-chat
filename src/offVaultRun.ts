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
import { registerRun, unregisterRun, abortRun, isRunActive } from "./runRegistry";
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
          // Text resuming after a tool call = new paragraph; separate it so the
          // content doesn't jam together ("…done.Next…"). finalSegment resets to ""
          // on tool_use, so empty finalSegment + non-empty acc means we're resuming.
          if (!finalSegment && acc && e.delta.trim() && !/\n\s*$/.test(acc)) acc += "\n\n";
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
  // [AskUser redesign] `answer` marks a TAGGED answer (a tapped option or a
  // committed free-form reply, arriving via the /answer route) — the ONLY thing
  // that clears a mission's AWAITING_USER wait and resumes the executor. A plain
  // chat message (untagged /message) no longer clears the wait; it goes to the
  // conversational front for probing instead of ending the ask.
  opts: { modelId?: string; resume?: boolean; direct?: boolean; forkNudge?: boolean; answer?: boolean } = {},
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

  // A genuine user turn (a typed reply or a tapped /answer) is a DIRECT message —
  // the deliberation sheet's exchange shows it; harness wakes stay unmarked.
  const userMsg: ChatMessage = {
    role: "user",
    content: message,
    direct: opts.direct || opts.answer ? true : undefined,
    // A tapped option / committed answer via /answer is a FORMAL decision —
    // flagged so the thread renders it as a decision chip and the record of
    // which way the user called it is durable, not inferred from prose.
    decision: opts.answer ? true : undefined,
    mid: newMessageId(),
  };
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
    // [AskUser redesign] Only a TAGGED answer (opts.answer — a tapped option or a
    // committed free-form reply via /answer) clears a mission's AWAITING_USER wait
    // and resumes the executor. A plain chat message no longer clears it: those go
    // through the conversational front (runMissionChatTurn) for probing and never
    // reach this function while AWAITING_USER. The `!isHarnessWake` guard stays as
    // defense-in-depth — a harness wake must never clear the wait even if tagged.
    // (The scheduler already refuses to fire self-checks into an awaiting mission.)
    const clearAwait =
      harnessV2Enabled() &&
      list[idx]!.source === "mission" &&
      list[idx]!.missionState === "AWAITING_USER" &&
      !opts.resume &&
      !isHarnessWake &&
      !!opts.answer;
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
          // Prose resuming AFTER a tool call starts a new paragraph. Insert a break
          // into `acc` (→ the persisted turn content) so two text blocks either side
          // of a tool boundary don't render jammed together ("…remove.The three…" —
          // the run-together bug). liveSteps already splits on this; acc did not.
          const resuming = liveWasAction && !!e.delta.trim();
          if (resuming && acc && !/\n\s*$/.test(acc)) acc += "\n\n";
          acc += e.delta;
          if (resuming) { liveSteps.push({ thought: "", actions: [] }); liveWasAction = false; }
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
      // [ask-visibility] AskUser's question otherwise lives ONLY in the tool-call
      // input + the push notification — the thread rendered a bare "1 step" chip,
      // and when the turn was JUST the ask (acc empty) the bubble was blank, so
      // opening the asking thread from the notification showed nothing to answer.
      // Surface the question as real message content so the thread reads as a
      // question you can reply to right there.
      let content = acc;
      const ask = tools.find((t) => t.name === "AskUser");
      if (ask && ask.input) {
        const about = String((ask.input as { about?: unknown }).about ?? "").trim();
        const question = String((ask.input as { question?: unknown }).question ?? "").trim();
        if (question && !content.includes(question)) {
          const block = `**❓ Needs your input${about ? ` — ${about}` : ""}**\n\n${question}`;
          content = content.trim() ? `${content.trim()}\n\n${block}` : block;
        }
      }
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content,
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
      // reply (opts.direct) or a TAGGED answer (opts.answer, via /answer) clears
      // the wait. Terminal states are untouched.
      const v2state: Conversation["missionState"] =
        harnessV2Enabled() && supervisorMode && cur.source === "mission" &&
        cur.missionState !== "DONE" && cur.missionState !== "KILLED"
          ? askedUserThisTurn
            ? "AWAITING_USER"
            : cur.missionState === "AWAITING_USER" && !opts.direct && !opts.answer
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
// [AskUser redesign] Durably record a user message on a mission thread WITHOUT
// running any turn — used only for the two-lane-OFF fallback of a probe to an
// AWAITING_USER mission: the message must be preserved (the executor picks it up
// on its next run) but the wait must NOT be cleared and no executor turn should
// fire. Deliberately does not touch missionState.
export async function appendUserMessageOnly(
  vault: string,
  conversationId: string,
  message: string,
): Promise<void> {
  const text = message.trim();
  if (!text) return;
  const userMsg: ChatMessage = { role: "user", content: text, mid: newMessageId() };
  await withConvLock(async () => {
    const list = await readConversations(vault);
    const idx = list.findIndex((c) => c.id === conversationId);
    if (idx < 0) return;
    list[idx] = {
      ...list[idx]!,
      messages: [...list[idx]!.messages, userMsg],
      lastActivityAt: Date.now(),
    };
    await writeConversations(vault, list);
  });
  await useStore.getState().refreshConversationFromDisk(vault, conversationId).catch(() => {});
}

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

  // One turn at a time on the chat lane (block-until-done, note 4bd29abb) — a
  // second send mid-answer would interleave two generations into the thread.
  if (isRunActive(chatKey)) return { reply: "", error: "still answering the last message — wait for it to finish" };

  const broadcastChat = (phase: string, extra?: Record<string, unknown>) =>
    void invoke("phone_broadcast", {
      json: JSON.stringify({ type: "chat", convId: conversationId, phase, ...(extra || {}) }),
    }).catch(() => {});

  // Append the user's turn to the mission thread up front, so the exchange is one
  // clean [user, reply] pair in the right order and the executor's next turn sees
  // the message in place (no duplicate append from a separate steering path).
  // direct:true — the user typed this; the deliberation sheet's exchange filter
  // (m.direct) needs it or the question renders without its answer's question.
  const userMsg: ChatMessage = { role: "user", content: text, direct: true, mid: newMessageId() };
  const seeded = await withConvLock(async () => {
    const list = await readConversations(vault);
    const idx = list.findIndex((c) => c.id === conversationId);
    if (idx < 0) return null;
    const messages = [...list[idx]!.messages, userMsg];
    // [AskUser redesign] The conversational front is PROBING — it does NOT clear
    // an AWAITING_USER wait. Talking it through (a plain chat message to an asking
    // mission) leaves the ask pending; only a TAGGED answer via /answer (which
    // routes to runWorkerTurn with opts.answer) resumes the executor. So this path
    // never touches missionState — it just records the exchange and replies.
    list[idx] = {
      ...list[idx]!,
      messages,
      lastActivityAt: Date.now(),
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
  let sawTool = false;
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
      // The user drove this turn — presence-gated asks render inline.
      interactive: true,
      conversationId,
      reasoningEffort: store.reasoningEffort,
      onEvent: (e) => {
        if (e.kind === "text") {
          // Text resuming after a (read-only) tool call = new paragraph; keep the
          // segments from jamming together ("…checked.Here's…").
          if (sawTool && acc && e.delta.trim() && !/\n\s*$/.test(acc)) acc += "\n\n";
          sawTool = false;
          acc += e.delta;
          // Throttle stream broadcasts to keep the SSE light; final flush below.
          if (acc.length - lastLen >= 16) {
            lastLen = acc.length;
            broadcastChat("stream", { text: acc.slice(-4000) });
          }
        } else if (e.kind === "tool_use") {
          sawTool = true;
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
  // the fresh-context executor wakes both skip `direct` messages). [unified ask]
  // Carry any option cards the front staged via an interactive AskUser — the
  // presence-gated inline form: cards land WITH the prose that argues for them.
  const reply = acc.trim();
  const { takePendingAskOptions } = await import("./tools");
  const staged = takePendingAskOptions(conversationId);
  if (reply || staged.length) {
    await withConvLock(async () => {
      const list = await readConversations(vault);
      const idx = list.findIndex((c) => c.id === conversationId);
      if (idx < 0) return;
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: reply || "Here are the options I'd put in front of you:",
        direct: true,
        mid: newMessageId(),
        ...(staged.length ? { askOptions: staged } : {}),
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

// [ask redesign] Mint a notification's OWN conversation. Called when an AskUser
// fires (and lazily when the user follows up on an info alert). The thread is
// isolated from the mission by construction — the structural fix for the
// "supervisor chat bleeds into the ask" spillover: there is no shared thread to
// bleed across. The ask's question + original options are seeded as a hidden
// context message; the phone renders the decision card from the notification,
// so the visible thread starts empty.
export async function mintAskConversation(
  vault: string,
  opts: {
    // The conversation the notification came from — the mission whose
    // supervisor waits on the answer (the deterministic relay target). Absent
    // for a sourceless info alert.
    missionConvId?: string;
    notifId: string;
    title: string;
    // Mission group label, for display.
    mission?: string;
    question: string;
    options?: { answer: string; title?: string; body?: string; primary?: boolean }[];
    // "ask" seeds a decision conversation; "info" a follow-up conversation.
    kind: "ask" | "info";
  },
): Promise<string> {
  const now = Date.now();
  const seedLines = [
    opts.kind === "ask" ? `[ASK CONTEXT — the decision this conversation is about]` : `[ALERT CONTEXT — the notification this conversation follows up on]`,
    opts.mission ? `Mission: ${opts.mission}` : "",
    `Question/alert: ${opts.question}`,
    ...(opts.options && opts.options.length
      ? [
          "Original options (pinned above the conversation on the user's screen):",
          ...opts.options.map((o, i) => `${i + 1}. ${o.answer}${o.body ? ` — ${o.body}` : ""}${o.primary ? " (recommended)" : ""}`),
        ]
      : []),
  ].filter(Boolean);
  const conv: Conversation = {
    ...emptyConversation(),
    source: "ask",
    title: opts.title.slice(0, 90),
    mission: opts.mission,
    askOf: opts.missionConvId,
    askNotifId: opts.notifId,
    createdAt: now,
    lastActivityAt: now,
    messages: [
      { role: "user", content: seedLines.join("\n"), hidden: true, system: true, mid: newMessageId() },
    ],
  };
  await withConvLock(async () => {
    const list = await readConversations(vault);
    await writeConversations(vault, [conv, ...list]);
  });
  await useStore.getState().refreshConversationFromDisk(vault, conv.id).catch(() => {});
  return conv.id;
}

// [unified ask] Land a refined option set ON THE PENDING ASK. When the user
// deliberates a parked fork with the mission's conversational FRONT (not the
// ask thread) and the front tightens the options, those cards must live where
// the DECISION lives: appended to the ask's own conversation, where the
// decision sheet renders them as tappable relay cards stacking under the
// original pinned options — a tap there rides the real /answer path and
// actually clears AWAITING_USER. (Inline cards in the mission thread would
// look answerable while clearing nothing — NF-1; and dropping the options
// entirely wasted the deliberation.) Returns the ask thread's title, or null
// when no live ask conversation exists to land on.
export async function appendOptionsToPendingAsk(
  vault: string,
  missionConvId: string,
  options: { answer: string; title: string; body: string; primary?: boolean }[],
  note: string,
): Promise<string | null> {
  if (!options.length) return null;
  let landedTitle: string | null = null;
  let landedId: string | null = null;
  await withConvLock(async () => {
    const list = await readConversations(vault);
    // The live ask = the NEWEST ask conversation pointing at this mission
    // (a superseding ask mints a fresh thread; older ones are settled rounds).
    const asks = list
      .filter((c) => c.source === "ask" && c.askOf === missionConvId)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const ask = asks[0];
    if (!ask) return;
    const idx = list.findIndex((c) => c.id === ask.id);
    const msg: ChatMessage = {
      role: "assistant",
      content: note || "Refined options from the deliberation:",
      direct: true,
      mid: newMessageId(),
      askOptions: options,
    };
    list[idx] = { ...ask, messages: [...ask.messages, msg], lastActivityAt: Date.now() };
    await writeConversations(vault, list);
    landedTitle = ask.title;
    landedId = ask.id;
  });
  if (landedId) await useStore.getState().refreshConversationFromDisk(vault, landedId).catch(() => {});
  return landedTitle;
}

// [ask redesign] One turn of the dedicated ask agent, in the notification's own
// conversation. Modeled on runMissionChatTurn (same chat lane + broadcast
// contract, so the phone sheet streams it identically) but a different persona:
// ask.md, ask-tier tools (read + converse + ProposeOptions), and a briefing
// compiled FRESH each turn from the source mission's thread on disk — a
// starting snapshot, not a blindfold; the agent reads live ground truth when
// the user asks how things stand now.
export async function runAskTurn(
  vault: string,
  conversationId: string,
  message: string,
): Promise<{ reply: string; error?: string }> {
  const store = useStore.getState();
  const text = message.trim();
  if (!text) return { reply: "", error: "empty message" };

  let modelId = store.modelId;
  let spec = findModel(modelId);
  if (!spec || !store.apiKeys[spec.provider]) {
    const fb = findModel(store.supervisorModelId) || findModel(DEFAULT_WORKER_MODEL_ID);
    if (fb && store.apiKeys[fb.provider]) { modelId = fb.id; spec = fb; }
  }
  const apiKey = spec ? store.apiKeys[spec.provider] : undefined;
  if (!spec || !apiKey) return { reply: "", error: "no model / API key configured" };

  const chatKey = conversationId + "#chat";
  const broadcastChat = (phase: string, extra?: Record<string, unknown>) =>
    void invoke("phone_broadcast", {
      json: JSON.stringify({ type: "chat", convId: conversationId, phase, ...(extra || {}) }),
    }).catch(() => {});

  // One turn at a time on this lane (block-until-done, note 4bd29abb): a second
  // message while the agent is mid-answer would interleave two generations'
  // writes into one thread. The phone disables send while the lane streams;
  // this is the backstop for a raced request.
  if (isRunActive(chatKey)) return { reply: "", error: "still answering the last message — wait for it to finish" };

  // Append the user's turn up front (durable before anything can refresh over
  // it). [unified ask] A DECIDED ask stays talkable — the decision receipt is
  // recorded (askDecided + the archive card) but the conversation is not
  // frozen: the user keeps talking after making the call, can dig into why, or
  // revise with a follow-up. "Settled" means recorded, not closed.
  const userMsg: ChatMessage = { role: "user", content: text, direct: true, mid: newMessageId() };
  const seeded = await withConvLock(async () => {
    const list = await readConversations(vault);
    const idx = list.findIndex((c) => c.id === conversationId);
    if (idx < 0) return null;
    const messages = [...list[idx]!.messages, userMsg];
    list[idx] = { ...list[idx]!, messages, lastActivityAt: Date.now() };
    await writeConversations(vault, list);
    return { messages, askOf: list[idx]!.askOf };
  });
  if (!seeded) return { reply: "", error: `ask thread not found: ${conversationId}` };
  await useStore.getState().refreshConversationFromDisk(vault, conversationId).catch(() => {});

  // Compile the source mission's context fresh from disk — title, state, and a
  // compact tail of its thread. Fresh-at-turn-time beats a mint-time freeze
  // (the user may return hours later), and reading disk never touches the
  // executor.
  let missionBlock = "[No source thread — this notification has no conversation behind it.]";
  if (seeded.askOf) {
    try {
      const src = (await readConversations(vault)).find((c) => c.id === seeded.askOf);
      if (src) {
        const tail = src.messages
          .filter((m) => !m.hidden && (m.content || "").trim())
          .slice(-12)
          .map((m) => {
            const one = (m.content || "").replace(/\s+/g, " ").slice(0, 280);
            return `- ${m.role}${m.direct ? " (direct)" : ""}${m.decision ? " [DECISION]" : ""}: ${one}`;
          })
          .join("\n");
        missionBlock =
          `[SOURCE MISSION — compiled from its thread on disk just now]\n` +
          `Title: ${src.title}\n` +
          (src.missionState ? `State: ${src.missionState}\n` : "") +
          (src.statusSummary ? `Status: ${src.statusSummary}\n` : "") +
          (src.taskSummary ? `Task: ${src.taskSummary}\n` : "") +
          `Recent thread tail:\n${tail}`;
      }
    } catch {
      /* keep placeholder */
    }
  }
  // The hidden seed (ask question + original options) rides in the system
  // framing, not the visible history.
  const seedCtx = seeded.messages.find((m) => m.system && m.hidden)?.content || "";
  const framing =
    "You are the dedicated agent for ONE notification (see your role prompt). The user is deliberating with you in the notification's own conversation. The mission context below is a fresh snapshot — read live ground truth with your tools when the user asks how things stand now. If the deliberation moves the fork, call ProposeOptions.";

  const baseHistory = seeded.messages
    .filter((m) => !m.hidden && !m.system && m.content !== text)
    .map((m) => ({ role: m.role, content: m.content }));

  const controller = new AbortController();
  registerRun(chatKey, controller);
  broadcastChat("start");

  let acc = "";
  let lastLen = 0;
  let sawTool = false;
  let runErr: string | undefined;
  try {
    await runAgent({
      modelId,
      apiKey,
      vault,
      history: baseHistory,
      userMessage: `${framing}\n\n${seedCtx}\n\n${missionBlock}\n\n---\n\nUser: ${text}`,
      abortSignal: controller.signal,
      tavilyKey: store.serviceKeys.tavily,
      strictVault: store.strictVaultMode,
      bashDisabled: store.bashDisabled,
      voiceMode: false,
      askMode: true,
      // The user drove this turn — presence-gated asks render inline.
      interactive: true,
      conversationId,
      reasoningEffort: store.reasoningEffort,
      onEvent: (e) => {
        if (e.kind === "text") {
          if (sawTool && acc && e.delta.trim() && !/\n\s*$/.test(acc)) acc += "\n\n";
          sawTool = false;
          acc += e.delta;
          if (acc.length - lastLen >= 16) {
            lastLen = acc.length;
            broadcastChat("stream", { text: acc.slice(-4000) });
          }
        } else if (e.kind === "tool_use") {
          sawTool = true;
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

  // Persist the reply as a DIRECT turn, carrying any option cards the agent
  // staged via ProposeOptions — cards land WITH the prose that argues for them.
  const reply = acc.trim();
  const { takePendingAskOptions } = await import("./tools");
  const staged = takePendingAskOptions(conversationId);
  if (reply || staged.length) {
    await withConvLock(async () => {
      const list = await readConversations(vault);
      const idx = list.findIndex((c) => c.id === conversationId);
      if (idx < 0) return;
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: reply || "Here are the options I'd put in front of you:",
        direct: true,
        mid: newMessageId(),
        ...(staged.length ? { askOptions: staged } : {}),
      };
      list[idx] = { ...list[idx]!, messages: [...list[idx]!.messages, assistantMsg], lastActivityAt: Date.now() };
      await writeConversations(vault, list);
    });
    await useStore.getState().refreshConversationFromDisk(vault, conversationId).catch(() => {});
  }
  broadcastChat("end");
  return { reply, error: runErr };
}

// [ask redesign] Stamp a settled ask: append the decision receipt to the ask
// thread and record it on the header (askDecided). Called from the /answer
// path AFTER the tagged answer was accepted by the mission — the ask thread
// records what was decided; the mission thread received the actual answer.
// [unified ask] The stamp is a RECORD, not a freeze — the thread stays
// talkable (runAskTurn accepts turns after it; only the first stamp wins).
export async function stampAskDecided(
  vault: string,
  askConvId: string,
  answer: string,
): Promise<void> {
  await withConvLock(async () => {
    const list = await readConversations(vault);
    const idx = list.findIndex((c) => c.id === askConvId);
    if (idx < 0) return;
    // Idempotent against the SAME answer (double-tap / PWA retry) — but a
    // DIFFERENT answer is a revision from the still-open conversation: append
    // a fresh receipt and update the record so the thread and the archive
    // card tell the same story.
    if (list[idx]!.askDecided === answer.slice(0, 160)) return;
    const receipt: ChatMessage = {
      role: "user",
      content: answer,
      direct: true,
      decision: true,
      mid: newMessageId(),
    };
    list[idx] = {
      ...list[idx]!,
      messages: [...list[idx]!.messages, receipt],
      askDecided: answer.slice(0, 160),
      askDecidedAt: Date.now(),
      lastActivityAt: Date.now(),
    };
    await writeConversations(vault, list);
  });
  await useStore.getState().refreshConversationFromDisk(vault, askConvId).catch(() => {});
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
//       CompleteMission) — trusted by tool NAME because their effect is
//       async/eventually-consistent (a spawned worker or watched run may not be
//       on disk the instant this hook runs),
//   (b) the user was asked (AskUser → AWAITING_USER; their reply is the wake),
//   (c) an external wake source already exists ON DISK: an enabled schedule
//       targeting this thread, a live watched run it owns, or a live worker of
//       its mission,
//   (d) the mission is terminal (DONE / KILLED).
// If NONE hold, the harness re-enters the thread once with a corrective nudge;
// a nudged turn that parks again escalates to the user's Alerts feed and flips
// the mission to AWAITING_USER so the board shows the truth ("parked, needs
// you") instead of a healthy-looking idle card.
// NOTE: MarkDoneWhen is deliberately NOT here — checking off a criterion doesn't
// secure a next tick (a turn can check a box and still strand the mission).
// NOTE: Schedule is deliberately NOT trusted by name either. Its effect is a
// synchronous row in schedules.jsonl, which (c) reads directly — so a
// self-schedule is VERIFIED on disk, not assumed from the tool call. A Schedule
// whose write silently no-ops (the failure that stranded a mission at a "parked"
// phase with a phantom wake) then correctly falls through to the nudge instead
// of passing. Verifying the wake actually landed is the whole point.
const PROGRESS_TOOLS = new Set([
  "StartWorker",
  "AskWorker",
  "WatchRun",
  "CompleteMission",
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
  // Completion criteria are ONLY the bullets under the brief's "Done when:"
  // header. A real brief also carries bulleted config blocks (WatchRun params
  // like `title:` / `cadence_minutes:`), numbered step-by-step instructions, and
  // a "GROUND-TRUTH VERDICT" bullet list — none of which are markable criteria.
  // Grabbing EVERY bullet in the whole brief inflated the gate with un-markable
  // junk, so a mission that HAD met its real criteria could never satisfy the
  // gate and deadlocked RUNNING while billing (cost-guard C1 stuck at missing:1:
  // the auditor rightly refused to "verify" `cadence_minutes: 1` as done). Scope
  // strictly to the Done-when section: start at the header, take bullets, stop at
  // the first non-blank line that isn't a bullet (the next section/prose).
  const lines = (brief || "").split(/\r?\n/);
  const bullet = /^\s*(?:[-*•]|\d+[.)])\s+(.+)$/;
  const out: string[] = [];
  let inSection = false;
  for (const ln of lines) {
    if (/^\s*\*{0,2}done\s+when\b/i.test(ln)) { inSection = true; continue; }
    if (!inSection) continue;
    const m = ln.match(bullet);
    if (m) { out.push(m[1].trim()); continue; }
    if (ln.trim() === "") continue; // blank lines between bullets are fine
    break; // a non-blank, non-bullet line ends the Done-when list
  }
  // Fallback for a brief with NO "Done when" header at all: keep the legacy
  // whole-brief scan so an unconventional brief still gets *some* gate rather
  // than silently completing ungated. (Standard/probe briefs have the header and
  // never reach this branch.)
  if (!out.length && !/done\s+when/i.test(brief || "")) {
    for (const ln of lines) {
      const m = ln.match(bullet);
      if (m) out.push(m[1].trim());
    }
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
// [markdone auditor] Whether a criterion is satisfied by a file's ABSENCE — a
// removal / deletion / "is gone" / "cleaned up" criterion. For these, a file that
// does NOT exist is POSITIVE proof of success, not "inconclusive". Detected from
// the criterion text so the evidence line can say so, and the auditor stops
// falsely rejecting a real cleanup (a "delete X" mission was rejected 4× then
// killed because "not found" read as inconclusive — impossible to satisfy).
function isAbsenceCriterion(text: string): boolean {
  // Classify from the criterion's INTENT PROSE, not the filenames it names — a
  // presence criterion that happens to name `delete-me.md` must NOT read as an
  // absence criterion. Strip file-like tokens (word.ext, incl. dotted paths)
  // first, then match. Stems carry no trailing \b (so "delete"/"deleted"/
  // "deletion" all match — "\bdelet\b" would fail on "delete", no t|e boundary);
  // whole-word tokens are \b-bounded (so "clean" doesn't match "cleanliness",
  // "rm"/"gone" don't match inside other words).
  const prose = text.replace(/`?\.?[\w][\w./\-]*\.[A-Za-z0-9]{1,6}`?/g, " ");
  return (
    /\b(delet|remov|purg|decommission|terminat|unlink|teardown|tear[\s-]?down|torn[\s-]?down|empt(y|ied)|no longer (exist|present)|does\s*n[o']?t exist)/i.test(prose) ||
    /\b(gone|absent|cleared|cleaned|clean[\s-]?up|clean|dropped|rm)\b/i.test(prose) ||
    /\bis\s+gone\b|\bare\s+gone\b|\bbe\s+gone\b/i.test(prose)
  );
}

async function readNamedFiles(
  vault: string,
  criterionText: string,
  briefText: string,
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>,
  // When set, a criterion that concerns a Notify/notification/alert also gets
  // this mission's slice of notifications.jsonl as ground truth. [shakedown
  // root cause] "one completion Notify was sent" is DISK-VERIFIABLE — the
  // Notify row sits in notifications.jsonl — but the auditor couldn't see it,
  // refused the criterion twice, and the cornered supervisor escaped into an
  // invented wait-on-the-user (the one illegal dependency a mission must never
  // have). Evidence gathering first, judge tuning never.
  missionConvId?: string,
): Promise<string> {
  // An absence/removal criterion inverts the read: a missing named file is the
  // proof of success, not an inconclusive gap.
  // [proxy-v3] Classified from the CRITERION ALONE — never the brief. The brief
  // routinely describes a deliberately-missing file ("reconcile against
  // missing-input.md, which does not exist"), and classifying from the combined
  // text turned EVERY criterion into an absence check ("6 removal-absence
  // checks (unrelated files)"), scrambling the auditor for the whole run.
  const absence = isAbsenceCriterion(criterionText);
  const vaultFwd = vault.replace(/\\/g, "/").replace(/\/+$/, "");
  const toRel = (p: string) => {
    const a = p.replace(/\\/g, "/");
    return a.startsWith(vaultFwd + "/") ? a.slice(vaultFwd.length + 1) : a;
  };
  const globVault = async (pattern: string): Promise<string[]> =>
    ((await invoke<string[]>("glob_files", { pattern, cwd: vault }).catch(() => [])) ?? [])
      .filter((h) => !/\/(\.git|node_modules)\//.test(h.replace(/\\/g, "/")));
  // The leading `\.?` is load-bearing: vault paths are dotfiles
  // (`.vault-chat/...`), and a match that starts at `[\w]` would drop the dot and
  // resolve `${vault}/vault-chat/...` — a path that never exists — making every
  // criterion that names a vault file read as "absent" and get falsely rejected.
  const extractRels = (text: string): string[] => {
    const out: string[] = [];
    const re = /`?(\.?[\w][\w./\-]*\.[A-Za-z0-9]{1,6})`?/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const rel = m[1]!.replace(/^\.\//, "");
      if (rel.includes("..")) continue; // never traverse out of the vault
      // Bare filenames are no longer skipped: "Write a RESULTS.md scorecard"
      // is how criteria actually read, and skipping the name left the auditor
      // with NO ground truth for a file sitting on disk — the residual
      // blindness that made the notification-surfaces dummy need a force-close
      // waiver on the very build that fixed the pathed cases. The suffix
      // search below resolves them (newest match wins — for a "just written"
      // artifact, mtime order is exactly the right disambiguator).
      if (!rel.includes("/") && rel.length < 5) continue; // too short to search safely
      out.push(rel);
    }
    return out;
  };
  // Template/wildcard paths (`cap-<name>.md`, `fail-*.md`) — criteria phrase
  // fan-out artifacts this way, and "verify every file exists and is
  // substantive" was structurally unprovable while the reader skipped them
  // (PROXY V3's fan-out criterion failed 8+ times with real files on disk).
  // Require ≥3 literal chars in the basename prefix so `*.md` can't list the
  // whole vault.
  const extractTemplates = (text: string): string[] => {
    const out: string[] = [];
    const re = /`?(\.?[\w][\w./\-]*(?:<[^>`\s]{0,40}>|\*)[\w./\-]*\.[A-Za-z0-9]{1,6})`?/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const pat = m[1]!.replace(/^\.\//, "").replace(/<[^>]*>/g, "*");
      if (pat.includes("..")) continue;
      const base = pat.split("/").pop() || "";
      if ((base.split("*")[0] || "").length < 3) continue;
      out.push(pat);
    }
    return out;
  };
  // Criterion-named files take the read budget FIRST; brief-named files fill
  // the remainder. (The old shared cap of 6 let the brief's paths starve the
  // criterion's own files out of the evidence entirely.)
  const seen = new Set<string>();
  const rels: string[] = [];
  for (const rel of extractRels(criterionText)) {
    if (!seen.has(rel) && rels.length < 6) { seen.add(rel); rels.push(rel); }
  }
  for (const rel of extractRels(briefText)) {
    if (!seen.has(rel) && rels.length < 8) { seen.add(rel); rels.push(rel); }
  }
  const templates = [...new Set(extractTemplates(criterionText))].slice(0, 3);
  const parts: string[] = [];
  // Dedup by RESOLVED location, not by the rel string: briefs name the same
  // file both pathed (".vault-chat/…/journal.log") and bare ("journal.log"),
  // and reading it twice burned half the judge's hard-capped evidence window
  // on a duplicate — which sliced the worker-results section off entirely
  // (the evidence-tail-worker probe's silent-rejection root cause).
  const readResolved = new Set<string>();
  for (const rel of rels) {
    // Direct read first; on a miss, RESOLVE BY SUFFIX SEARCH before concluding
    // anything. [proxy-v3 root cause] Briefs put artifacts under a base dir
    // stated once in prose (".vault-chat/selftest/proxy-r3/") while criteria
    // say "proxy-r3/wakes.log" — the strict `${vault}/${rel}` read missed for
    // 20 hours straight and every artifact was reported absent while sitting
    // on disk AND in committed git HEAD.
    let at = rel;
    let searched = false;
    let alsoMatched = "";
    let body = await invoke<string>("read_text_file", { path: `${vault}/${rel}` }).catch(() => null);
    if (body == null) {
      searched = true;
      const hits = await globVault(`**/${rel}`);
      if (hits.length) {
        // Newest match first (glob_files sorts by mtime) — for a just-written
        // artifact that's the right pick. Surface any other matches so the
        // auditor can see the ambiguity instead of trusting a silent choice.
        body = await invoke<string>("read_text_file", { path: hits[0]! }).catch(() => null);
        if (body != null) {
          at = toRel(hits[0]!);
          if (hits.length > 1) alsoMatched = ` (newest of ${hits.length} matches; others: ${hits.slice(1, 3).map(toRel).join(", ")})`;
        }
      }
    }
    if (body == null) {
      if (absence) {
        // [markdone auditor] A removal/absence criterion is SATISFIED by the file
        // not existing — and with the recursive search behind it, "not found" is
        // now a strong, honest signal rather than a maybe-unresolved path.
        parts.push(`-- ${rel}: NOT FOUND anywhere under the vault (direct read + recursive search) — this is a removal/absence criterion, so a missing file is POSITIVE PROOF the criterion is MET (do not reject as inconclusive). --`);
      } else {
        // Genuinely absent: the recursive search means this is no longer "maybe
        // an unresolved path" — the file does not exist on this machine. State
        // that plainly so the auditor can verify absence honestly (it used to be
        // unable to distinguish "missing" from "misresolved").
        parts.push(`-- ${rel}: NOT FOUND anywhere under the vault (direct read + recursive suffix search both missed) — for a presence criterion, this file genuinely does not exist here. --`);
      }
    } else if (body != null && readResolved.has(at)) {
      // Already read under another name this pass — don't burn the evidence
      // window on a byte-identical duplicate.
      continue;
    } else if (absence && body.trim() === "") {
      // An empty file for an "emptied / cleared" criterion is also positive proof.
      readResolved.add(at);
      parts.push(`-- ${at}: EXISTS but is EMPTY — for an emptied/cleared criterion this is POSITIVE PROOF the criterion is MET. --`);
    } else {
      readResolved.add(at);
      const lineCount = body.split(/\r?\n/).length;
      const where = (searched && at !== rel ? `${rel} → resolved at ${at}` : at) + alsoMatched;
      // An explicit truncation marker: the notification-surfaces dummy was
      // rejected over a heartbeat line "cut mid-write" that was OUR 2500-char
      // evidence cap, not the file — the auditor must never mistake the cap
      // for a truncated/corrupt file. HEAD+TAIL, not head-only: proof routinely
      // lives at the END of a long file (a journal's last wake line, a
      // scorecard's totals, an endurance span = first ts vs last ts), and the
      // head-only cap made the HARD proxy fail 7+ verification rounds until it
      // rewrote its own journal tersely enough to fit the reader's blind spot.
      const HEAD = 1900;
      const TAIL = 1900;
      const capped = body.length > HEAD + TAIL
        ? `${body.slice(0, HEAD)}\n[… middle elided by the auditor's reader — showing the first ${HEAD} and last ${TAIL} of ${body.length} bytes. The FILE ITSELF IS CONTINUOUS; a line cut at either edge of this gap is an artifact of the cap, not of the file.]\n${body.slice(-TAIL)}`
        : body;
      parts.push(`-- ${where} (${lineCount} lines, ${body.length} bytes) --\n${capped}`);
    }
  }
  // Expand each template into a real listing + a bounded sample of contents —
  // the ground truth for "all <pattern> files exist and are substantive".
  for (const pat of templates) {
    const hits = await globVault(`**/${pat}`);
    if (!hits.length) {
      parts.push(absence
        ? `-- pattern ${pat}: matches NOTHING under the vault — for a removal/absence criterion this is POSITIVE PROOF the criterion is MET. --`
        : `-- pattern ${pat}: matches NOTHING under the vault (recursive search) — the expected files do not exist here. --`);
      continue;
    }
    const listed = hits.slice(0, 24);
    const lines: string[] = [];
    for (let i = 0; i < listed.length; i++) {
      const body = await invoke<string>("read_text_file", { path: listed[i]! }).catch(() => null);
      const relAt = toRel(listed[i]!);
      if (body == null) { lines.push(`  - ${relAt} (unreadable)`); continue; }
      const lc = body.split(/\r?\n/).length;
      lines.push(`  - ${relAt} (${lc} lines, ${body.length} bytes)`);
      // Content sample for the first few so "substantive" is judgeable, not
      // just countable.
      if (i < 3) lines.push(`    | ${body.slice(0, 400).replace(/\n/g, "\n    | ")}`);
    }
    parts.push(`-- pattern ${pat}: ${hits.length} file(s) match under the vault${hits.length > 24 ? " (showing 24)" : ""} --\n${lines.join("\n")}`);
  }
  // Notification ground truth: a criterion about a Notify/alert/ask is
  // verifiable from notifications.jsonl — every Notify/AskUser call appends a
  // row keyed to the mission's conversation id. Surface this mission's slice
  // (newest last, bounded) so "a completion Notify was sent" is judged from
  // the record, not from whether the auditor believes the supervisor's story.
  if (missionConvId && /\b(notif|alert|push|ask ?user|needs ?you)/i.test(criterionText)) {
    const raw = await invoke<string>("read_text_file", { path: `${vault}/.vault-chat/notifications.jsonl` }).catch(() => "");
    const mine: string[] = [];
    for (const line of String(raw || "").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const v = JSON.parse(line) as { type?: string; convId?: string; ts?: number; kind?: string; title?: string; body?: string };
        if (v.type || v.convId !== missionConvId) continue; // rows only, this mission only
        mine.push(`  - ts=${v.ts} kind=${v.kind} title=${JSON.stringify((v.title || "").slice(0, 90))} body=${JSON.stringify((v.body || "").slice(0, 140))}`);
      } catch { /* skip unparsable */ }
    }
    parts.push(mine.length
      ? `-- notifications.jsonl, rows for THIS mission (${mine.length} total; newest last) — the durable record of every Notify/AskUser that reached the user's feed. A criterion about a notification being sent is PROVEN or REFUTED by these rows: --\n${mine.slice(-15).join("\n")}`
      : `-- notifications.jsonl: NO rows for this mission's conversation — no Notify/AskUser from this mission has reached the user's feed. --`);
  }
  return parts.join("\n\n");
}

// Mark ONE of a mission's "Done when" criteria verified-complete. The supervisor
// passes the criterion (a paraphrase is fine); we fuzzy-match it to the brief's
// bullets and store the matched bullet's exact text in doneWhenDone, so the
// spec checks off that one bullet (per-criterion progress, not all-at-once).
// Harness-generated wake prefixes share role:"user" with real user messages —
// used to exclude plumbing wherever "the user's own words" matter (auditor
// evidence, the user-waiver rail).
const isPlumbingUserMsg = (t: string) =>
  /^\s*(MISSION BRIEF|Watched run |Worker "|Your worker |Reply from worker |HARNESS CHECK )/.test(t);

export async function markDoneWhen(
  vault: string,
  conversationId: string,
  criterion: string,
  // [user-waiver rail] A verbatim quote of the USER's message that authorizes
  // checking this criterion off (a force-close, an explicit confirmation, a
  // rescope). Verified DETERMINISTICALLY: the quote must actually appear in a
  // real (non-plumbing) user message on this thread — user messages arrive from
  // the phone and cannot be authored by the agent. When it matches, the LLM
  // audit is bypassed: the self-test deadlock proved a fast-model auditor
  // cannot be trusted to APPLY its user-authority rule under conflict (it
  // rejected a post-completion criterion over mind.md's "still EXECUTING" while
  // four explicit force-close taps sat in its evidence).
  userWaiver?: string,
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

  // [user-waiver rail] Deterministic user authority: if the agent cites the
  // user's authorizing words and the quote REALLY exists in a user message on
  // this thread, the criterion passes without the LLM audit. String-match on
  // normalized whitespace/case; minimum length so a trivial fragment ("ok")
  // can't waive anything.
  const waiverQuote = (userWaiver || "").replace(/\s+/g, " ").trim().toLowerCase();
  let userAuthorized = false;
  if (matched && waiverQuote.length >= 8) {
    userAuthorized = mission0.messages.some(
      (m) =>
        m.role === "user" &&
        !isPlumbingUserMsg(m.content || "") &&
        (m.content || "").replace(/\s+/g, " ").trim().toLowerCase().includes(waiverQuote),
    );
    if (!userAuthorized) {
      return {
        matched,
        verified: false,
        reason: `the cited user_waiver quote does not appear in any user message on this thread — quote their authorization verbatim, or drop user_waiver and provide evidence`,
      };
    }
    vlog("mission.markdone.user-waived", { conv: conversationId.slice(0, 8) });
  }

  // [harness v2] Independent verification BEFORE the check-off lands. The actor
  // doesn't grade its own work: a fresh fast-model auditor judges whether the
  // RECORDED state (mind.md + the thread's recent output) concretely
  // substantiates the criterion. The BitNet-era lesson ("a worker reporting
  // 'completed' is NOT evidence") becomes a rail instead of a prompt plea.
  // Fails OPEN when no fast model is configured (verifier returns null).
  // Skipped entirely when the user's own words authorized the check-off above.
  if (harnessV2Enabled() && matched && !userAuthorized) {
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
      // Criterion text drives absence-classification and gets read priority;
      // the brief only contributes secondary paths (see readNamedFiles —
      // classifying absence from the combined text poisoned every PROXY V3
      // audit via the brief's "which does not exist" phrase).
      const groundTruth = await readNamedFiles(vault, `${matched}\n${criterion}`, briefText, invoke, conversationId);
      const recent = mission0.messages
        .filter((m) => m.role === "assistant")
        .slice(-2)
        .map((m) => m.content ?? "")
        .join("\n\n");
      // [markdone auditor] Tool-call RESULTS from the thread are ground truth for
      // an EXTERNAL-VERIFICATION criterion (a box terminated shown by a list tool
      // returning empty, a command's stdout). Surface the recent tool calls + their
      // recorded results so the auditor can pass a criterion a tool already proved,
      // instead of demanding a local file that doesn't exist for external state.
      // Self-referential harness tools are EXCLUDED from evidence: a prior
      // MarkDoneWhen's "VERIFICATION FAILED — no worker tool result…" is the
      // auditor's OWN past verdict, and surfacing it as in-thread "ground
      // truth" made every retry re-reject by citing the previous rejection —
      // a self-reinforcing loop the evidence-tail-worker probe caught live
      // (the auditor literally wrote "the ground-truth MarkDoneWhen response
      // explicitly states verification failed" while a genuine worker Bash
      // result sat in the evidence). Verdicts are not world state.
      const SELF_REFERENTIAL_TOOLS = new Set(["MarkDoneWhen", "CompleteMission", "AskUser", "RecordJudgment"]);
      const clipToolResults = (msgs: typeof mission0.messages, msgWindow: number, keep: number) =>
        msgs
          .filter((m) => m.role === "assistant" && Array.isArray(m.toolCalls) && m.toolCalls.length)
          .slice(-msgWindow)
          .flatMap((m) => (m.toolCalls ?? []))
          .filter((t) => t && typeof t.result === "string" && t.result.trim() && !SELF_REFERENTIAL_TOOLS.has(t.name))
          .slice(-keep)
          .map((t) => {
            const input = t.input ? JSON.stringify(t.input).slice(0, 200) : "";
            return `- ${t.name}(${input}) => ${String(t.result).trim().slice(0, 1200)}`;
          })
          .join("\n");
      const toolResults = clipToolResults(mission0.messages, 3, 8);
      // [markdone auditor] WORKER threads are where deliverables actually get
      // built — a mission that fans out writes its artifacts through worker
      // tool calls the mission thread never sees. Auditing only the mission
      // thread made every worker-built deliverable look unevidenced (the
      // handoff's defect B). Surface the freshest workers' recorded tool
      // results as labeled ground truth, same rules as the mission's own.
      const workerConvs = list0
        .filter(
          (c) =>
            c.source === "worker" &&
            (c.mission ?? "") === (mission0.mission ?? mission0.title ?? "") &&
            c.messages.some((m) => m.role === "assistant" && (m.toolCalls ?? []).length),
        )
        .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
        .slice(0, 3);
      const workerToolResults = workerConvs
        .map((w) => {
          const r = clipToolResults(w.messages, 2, 4);
          return r ? `worker "${w.title ?? w.id}":\n${r}` : "";
        })
        .filter(Boolean)
        .join("\n");
      // [markdone auditor] The USER's own replies are ground truth the agent cannot
      // author — they arrive from the phone (/message and /answer), never from a
      // tool. Without them the auditor's "a criterion explicitly waived by the user
      // passes" rule was starved of data: the self-test kind-4 circular gate
      // survived FOUR verbatim "Force-close it" taps because the auditor only ever
      // saw the agent's second-hand record of the authorization (narration it is
      // told to distrust) — an unfixable deadlock that ping-spammed the user.
      // Harness wakes share role:"user", so exclude the known plumbing prefixes.
      const userVoice = mission0.messages
        .filter((m) => m.role === "user" && (m.content || "").trim() && !isPlumbingUserMsg(m.content || ""))
        .slice(-4)
        .map((m) => `- "${(m.content || "").trim().slice(0, 400)}"`)
        .join("\n");
      // Section ORDER is load-bearing: the judge prompt hard-caps the evidence,
      // so the compact, highest-signal sections (recorded tool results, the
      // user's own words) go FIRST and the bulky ones (file bodies, narration)
      // last. The evidence-tail-worker probe caught the failure mode live: a
      // double-read journal + thread results filled the whole cap and the
      // worker section — which held the only proof — was silently sliced off,
      // so the judge truthfully reported "no recorded tool result" forever.
      const evidence =
        (toolResults
          ? `== GROUND TRUTH: tool-call results recorded in the thread (external verification — e.g. a list/command result proving a box is terminated or a check passed) ==\n${toolResults}\n\n`
          : "") +
        (workerToolResults
          ? `== GROUND TRUTH: tool-call results from this mission's worker threads (workers build the deliverables — their recorded writes/commands are evidence the mission thread itself never shows) ==\n${workerToolResults}\n\n`
          : "") +
        (userVoice
          ? `== GROUND TRUTH: the USER's own recent replies in this thread (typed/tapped on their phone — the agent cannot author these; the user is the final authority) ==\n${userVoice}\n\n`
          : "") +
        (groundTruth
          ? `== GROUND TRUTH: files named in the criterion, read from disk just now ==\n${groundTruth}\n\n`
          : "") +
        (goalDoc
          ? `== this mission's goal file (scoped — no other mission's state) ==\n${goalDoc.slice(0, 6000)}\n\n`
          : "") +
        `== the agent's own recent narration (a CLAIM — corroborate it against the ground truth above; do NOT trust it on its own) ==\n${recent.slice(-3000)}`;
      // Section sizes make an empty evidence lane diagnosable from the app log
      // (an auditor rejection with workers=0 while a worker built the artifact
      // is an evidence-gathering bug, not a judging bug).
      vlog("mission.markdone.evidence", {
        conv: conversationId.slice(0, 8),
        goal: goalDoc.length,
        files: groundTruth.length,
        thread: toolResults.length,
        workers: workerToolResults.length,
        user: userVoice.length,
      });
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
