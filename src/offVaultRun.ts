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
  bindTelegramChatId,
  withConvLock,
  type Conversation,
} from "./conversations";
import {
  sendTelegramMessage,
  sendTelegramReplyWithImages,
  resolveScheduleTelegramTarget,
  scheduledDeliveryText,
} from "./telegram";
import { useStore, type ChatMessage, type LiveTool } from "./store";
import { bumpHeartbeat, endHeartbeat } from "./runHeartbeat";
import { registerRun, unregisterRun, abortRun, isRunActive } from "./runRegistry";
import { vlog } from "./debugLog";

// Minimum gap between Telegram progress pings during a long headless run,
// so the phone gets "still working" signal without being spammed.
const PROGRESS_MIN_GAP_MS = 25_000;

// withConvLock (shared read→modify→write serializer for the conversations
// store) now lives in ./conversations so the store's autosave can share it.

// Off-vault inbound handler. Runs the full Telegram round-trip for
// a vault that is NOT currently open in the UI: load that vault's
// conversations from disk, route the user message into the right
// conversation, run the agent fully headless, persist the reply,
// and send it back to Telegram via that vault's bot token.
//
// The UI is never touched — the active vault's store stays
// completely untouched. The user only sees off-vault activity by
// switching to that vault later, where they'll find the new
// messages already persisted.

export async function handleOffVaultInbound(
  vault: string,
  chatId: number,
  userText: string,
  fromUsername: string | null,
  photoFileIds: string[] = [],
): Promise<void> {
  const trimmed = userText.trim();
  // Slash commands work for any vault — pure state mutation +
  // Telegram reply, no agent needed.
  if (await handleOffVaultSlashCommand(vault, chatId, trimmed, fromUsername)) return;

  const store = useStore.getState();
  // Telegram inbound is by definition telegram-sourced — use the
  // cheaper default model. User overrides in Settings → Telegram.
  const { getTelegramModelId } = await import("./telegram");
  const modelId = getTelegramModelId();
  const spec = findModel(modelId);
  const apiKey = spec ? store.apiKeys[spec.provider] : undefined;
  if (!spec || !apiKey) {
    await sendTelegramMessage(
      vault,
      chatId,
      "(error: no model / API key configured in vault-chat)",
    ).catch(() => {});
    return;
  }

  // First write: persist the user message so it isn't lost if the
  // agent run blows up partway through.
  // Download phone-sent photos before persisting the user turn.
  const attachments: import("./store").ChatAttachment[] = [];
  if (photoFileIds.length > 0) {
    const { downloadTelegramPhoto, readImageAsAttachment } = await import(
      "./telegram"
    );
    for (const fid of photoFileIds) {
      try {
        const path = await downloadTelegramPhoto(vault, fid);
        const att = await readImageAsAttachment(path);
        attachments.push(att);
      } catch (e) {
        console.warn("[off-vault] photo download failed:", e);
      }
    }
  }

  const list = await readConversations(vault);
  let idx = list.findIndex((c) => c.telegramChatId === chatId);
  if (idx < 0) {
    const fresh: Conversation = {
      ...emptyConversation(),
      source: "telegram",
      telegramChatId: chatId,
      title: fromUsername
        ? `Telegram · @${fromUsername}`
        : deriveConversationTitle([{ role: "user", content: userText }]),
    };
    list.unshift(fresh);
    idx = 0;
  }
  const userMsg: ChatMessage = {
    role: "user",
    content: userText || (attachments.length > 0 ? "(image)" : ""),
    attachments: attachments.length > 0 ? attachments : undefined,
  };
  list[idx] = {
    ...list[idx]!,
    messages: [...list[idx]!.messages, userMsg],
    lastActivityAt: Date.now(),
  };
  await writeConversations(vault, list);

  // Run the agent. No store updates — onEvent only accumulates the
  // final assistant text and any tool calls into local buffers.
  let acc = "";
  const tools: LiveTool[] = [];
  const baseHistory = list[idx]!.messages
    .filter((m) => !m.system)
    .map((m) => ({ role: m.role, content: m.content }));

  // Live progress to the phone so a slow run doesn't strand the user.
  let lastProgressAt = 0;
  const notify = (text: string) => {
    void sendTelegramMessage(vault, chatId, text).catch(() => {});
  };

  // Register an abort handle so a supervisor can interject this run by id.
  const inboundConvId = list[idx]!.id;
  const controller = new AbortController();
  registerRun(inboundConvId, controller);

  try {
    await runAgent({
      modelId,
      apiKey,
      vault,
      history: baseHistory,
      userMessage: trimmed,
      userAttachments: attachments.length > 0 ? attachments : undefined,
      abortSignal: controller.signal,
      tavilyKey: store.serviceKeys.tavily,
      strictVault: store.strictVaultMode,
      bashDisabled: store.bashDisabled,
      voiceMode: false,
      telegramMode: true,
      conversationId: list[idx]?.id,
      isTelegramSourced: true,
      reasoningEffort: store.reasoningEffort,
      onEvent: (e) => {
        if (e.kind === "text") {
          acc += e.delta;
        } else if (e.kind === "tool_use") {
          tools.push({
            id: e.id,
            name: e.name,
            input: e.input,
            startedAt: Date.now(),
          });
          const now = Date.now();
          if (now - lastProgressAt > PROGRESS_MIN_GAP_MS) {
            lastProgressAt = now;
            notify(`🔧 ${e.name}…`);
          }
          if (list[idx]) void bumpHeartbeat(vault, list[idx]!.id, e.name);
        } else if (e.kind === "tool_result") {
          const t = tools.find((x) => x.id === e.id);
          if (t) t.result = e.result;
        } else if (e.kind === "error") {
          acc = (acc + `\n\n⚠️ ${e.message}`).trim();
          notify(`⚠️ ${e.message}`);
        }
      },
    });
  } catch (e) {
    acc = (acc + `\n\n⚠️ off-vault run failed: ${String(e)}`).trim();
    notify(`⚠️ off-vault run failed: ${String(e)}`);
  } finally {
    await endHeartbeat(vault, inboundConvId).catch(() => {});
    unregisterRun(inboundConvId, controller);
  }

  // Second write: persist the assistant reply. Re-read to avoid
  // clobbering any other writer (different vault). Match by chat_id
  // again in case the conversation got rotated between writes.
  const finalList = await readConversations(vault);
  let fi = finalList.findIndex((c) => c.telegramChatId === chatId);
  if (fi < 0) fi = 0;
  if (finalList[fi]) {
    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: acc,
      toolCalls: tools.length ? tools : undefined,
    };
    finalList[fi] = {
      ...finalList[fi]!,
      messages: [...finalList[fi]!.messages, assistantMsg],
      lastActivityAt: Date.now(),
      unread: true,
    };
    await writeConversations(vault, finalList);
  }

  // Surface the reply (and its tool calls) live if the user is on this vault.
  if (finalList[fi]) {
    await useStore
      .getState()
      .refreshConversationFromDisk(vault, finalList[fi]!.id)
      .catch(() => {});
  }

  if (acc.trim()) {
    await sendTelegramReplyWithImages(vault, chatId, acc).catch((e) =>
      console.warn("[off-vault] telegram send failed:", e),
    );
  }
}

// Scheduler fire for a non-active vault. Same disk-only contract as
// handleOffVaultInbound but the trigger is a schedule, not a Telegram
// message. If the target conversation is telegram-sourced and the
// schedule has sendViaTelegram on, the reply also goes to the phone.
export async function runScheduledHeadlessTurn(
  vault: string,
  conversationId: string,
  prompt: string,
  opts: { sendViaTelegram: boolean; modelId?: string; quietUnlessAlert?: boolean },
): Promise<void> {
  const store = useStore.getState();
  // Model precedence: the schedule's pinned model wins (it was chosen for
  // a reason — e.g. Opus for a heavy weekly sweep). Only fall back to the
  // cheaper Telegram brain when the schedule didn't pin one AND the reply
  // is Telegram-bound. Resolve the "auto" sentinel to a concrete model so
  // the headless run doesn't silently no-op on a missing model.
  let modelId = opts.modelId || store.modelId;
  if (!opts.modelId && opts.sendViaTelegram) {
    const { getTelegramModelId } = await import("./telegram");
    modelId = getTelegramModelId();
  }
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

  const isTelegramSourced = list[idx]!.source === "telegram";
  // Where Telegram output should go. Prefer the conversation's own bound
  // chat; if this schedule fires into a non-Telegram conversation (e.g. a
  // coach thread that keeps long-form context), fall back to the owner's
  // DM so "send via Telegram" still delivers. null when delivery is off
  // or no chat can be resolved.
  const ownChatId = list[idx]!.telegramChatId;
  const telegramChatId = opts.sendViaTelegram
    ? await resolveScheduleTelegramTarget(vault, ownChatId)
    : null;
  // When we deliver via the owner's DM fallback (the thread wasn't itself
  // bound), bind that DM to this thread so replies from the phone
  // continue the coach with full context instead of a stray thread.
  const bindFallback = telegramChatId != null && ownChatId === undefined;

  let acc = "";
  const tools: LiveTool[] = [];
  const baseHistory = list[idx]!.messages
    .filter((m) => !m.system)
    .map((m) => ({ role: m.role, content: m.content }));

  // Live progress to the phone so a slow run doesn't strand the user.
  // Only when the run is Telegram-bound and the conversation has a chat.
  let lastProgressAt = 0;
  const notify = (text: string) => {
    if (telegramChatId == null) return;
    void sendTelegramMessage(vault, telegramChatId, text).catch(() => {});
  };

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
      telegramMode: isTelegramSourced && opts.sendViaTelegram,
      conversationId,
      isTelegramSourced: isTelegramSourced && opts.sendViaTelegram,
      reasoningEffort: store.reasoningEffort,
      onEvent: (e) => {
        if (e.kind === "text") acc += e.delta;
        else if (e.kind === "tool_use") {
          tools.push({
            id: e.id,
            name: e.name,
            input: e.input,
            startedAt: Date.now(),
          });
          const now = Date.now();
          // A quiet supervisor stays silent while polling — no progress pings.
          if (!opts.quietUnlessAlert && now - lastProgressAt > PROGRESS_MIN_GAP_MS) {
            lastProgressAt = now;
            notify(`🔧 ${e.name}…`);
          }
          void bumpHeartbeat(vault, conversationId, e.name);
        } else if (e.kind === "tool_result") {
          const t = tools.find((x) => x.id === e.id);
          if (t) t.result = e.result;
        } else if (e.kind === "error") {
          acc = (acc + `\n\n⚠️ ${e.message}`).trim();
          notify(`⚠️ ${e.message}`);
        }
      },
    });
  } catch (e) {
    runErr = String(e);
    acc = (acc + `\n\n⚠️ scheduled run failed: ${String(e)}`).trim();
    notify(`⚠️ scheduled run failed: ${String(e)}`);
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
    };
    finalList[fi] = {
      ...finalList[fi]!,
      messages: [...finalList[fi]!.messages, assistantMsg],
      lastActivityAt: Date.now(),
      unread: true,
    };
    if (bindFallback) {
      finalList = bindTelegramChatId(finalList, conversationId, telegramChatId);
    }
    await writeConversations(vault, finalList);
  }

  // If the user is on this vault right now, surface the result (and its
  // tool calls) live without yanking their focus.
  await useStore
    .getState()
    .refreshConversationFromDisk(vault, conversationId)
    .catch(() => {});

  if (deliver != null && telegramChatId != null) {
    // Headless scheduled briefing → mirror to Telegram AND surface a summarized
    // Alert linked to this thread (the active-vault path does the same in
    // chat-controller). Only scheduled runs reach this block.
    await sendTelegramReplyWithImages(vault, telegramChatId, deliver, {
      notify: true,
      convId: conversationId,
    }).catch((e) => console.warn("[scheduler] telegram send failed:", e));
  }
}

// Run ONE turn on an existing thread with `message`, persist the exchange,
// and RETURN the reply text. Used by the AskWorker relay so one agent (a
// supervisor / the phone's front agent) can hand a message to a worker thread
// and get its answer back to relay. No Telegram delivery — the caller decides
// what to do with the reply. The worker run registers an abort handle so a
// concurrent interject can stop it.
export async function runWorkerTurn(
  vault: string,
  conversationId: string,
  message: string,
  opts: { modelId?: string; resume?: boolean } = {},
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
      telegramMode: false,
      supervisorMode,
      conversationId,
      isTelegramSourced: false,
      reasoningEffort: store.reasoningEffort,
      onEvent: (e) => {
        if (e.kind === "text") acc += e.delta;
        else if (e.kind === "reasoning") reasoningAcc += e.delta;
        else if (e.kind === "tool_use") {
          tools.push({ id: e.id, name: e.name, input: e.input, startedAt: Date.now() });
          void bumpHeartbeat(vault, conversationId, e.name);
        } else if (e.kind === "tool_result") {
          const t = tools.find((x) => x.id === e.id);
          if (t) t.result = e.result;
        } else if (e.kind === "error") {
          runErr = e.message;
          acc = (acc + `\n\n⚠️ ${e.message}`).trim();
        }
        // Mirror the worker's in-flight text + tools into convRuntime so the
        // phone (phoneApp's runDiff) streams it live. Without this a spawned
        // worker was invisible while grinding — and invisible afterward too if
        // it ended on a tool-only turn with no prose (see the persist gate).
        useStore.getState().setConvRuntime(conversationId, {
          streamingText: acc,
          streamingReasoning: "",
          liveTools: tools.slice(),
        });
      },
    });
  } catch (e) {
    runErr = String(e);
    acc = (acc + `\n\n⚠️ worker turn failed: ${String(e)}`).trim();
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
  // thread landing (a no-op if no fast model is configured). Two fast-model
  // passes off the same finished turn:
  //   - Mode A: the Activity status line — a clean one-line TASK (for the pill).
  //   - Timeline: the thought-by-thought trace — the agent's run-on narration +
  //     its actions, untangled into modular thoughts each aligned to the action
  //     it led to, stored ON this turn's assistant message. Replaces the old
  //     summarized "thinking digest" (the user wanted thought-by-thought, not a
  //     summary at the top).
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
      const actionsForTimeline = tools.map((t) => ({ name: t.name, input: t.input }));
      const [sum, timeline] = await Promise.all([
        task.trim() ? summarizeWorkerState(task, activity, apiKeys) : Promise.resolve(null),
        summarizeTimeline(acc, reasoningAcc, actionsForTimeline, apiKeys),
      ]);
      if (!sum && !timeline) return;
      await withConvLock(async () => {
        const fresh = await readConversations(vault);
        const i = fresh.findIndex((x) => x.id === conversationId);
        if (i < 0) return;
        const msgs = fresh[i]!.messages.slice();
        if (timeline) {
          // Attach to THIS turn's assistant message: the last one whose content
          // matches what we just ran, else simply the last assistant turn.
          let mi = -1;
          for (let k = msgs.length - 1; k >= 0; k--) {
            if (msgs[k]!.role === "assistant") {
              if (mi < 0) mi = k;
              if (msgs[k]!.content === acc) { mi = k; break; }
            }
          }
          if (mi >= 0) msgs[mi] = { ...msgs[mi]!, timeline };
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
  const del = useStore.getState().deleteConversation;
  for (const id of ids) del(id);
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
    fresh[i] = { ...fresh[i]!, completedAt: Date.now() };
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

// Slash command handler for off-vault chats. Mirrors the active-
// vault logic in App.tsx, but operates directly on the on-disk
// conversations list. Returns true if the command was handled.
async function handleOffVaultSlashCommand(
  vault: string,
  chatId: number,
  trimmedText: string,
  fromUsername: string | null,
): Promise<boolean> {
  const isCommand =
    /^\/(new|start|reset|help|kill)\b/i.test(trimmedText);
  if (!isCommand) return false;

  if (/^\/help\b/i.test(trimmedText)) {
    await sendTelegramMessage(
      vault,
      chatId,
      "Commands:\n/new (or /start) — start a fresh conversation; the old one stays in vault-chat\n/reset — list recent conversations and switch back to one (/reset N)\n/kill — hard-stop every running worker in this vault right now\n/help — this message\n\nNote: clearing chat history on your phone is invisible to the bot — use /new to actually reset on the vault-chat side.",
    ).catch(() => {});
    return true;
  }

  // Deterministic kill switch — aborts every in-flight run in the vault by
  // walking the run registry directly, NOT by asking the agent. So it works
  // even if the supervisor itself is mid-thought or wedged. We abort every
  // conversation that has a live run registered, except this telegram chat's
  // own (it's the one delivering the /kill, not a worker to stop).
  if (/^\/kill\b/i.test(trimmedText)) {
    const list = await readConversations(vault);
    const self = list.find((c) => c.telegramChatId === chatId);
    let killed = 0;
    const killedTitles: string[] = [];
    for (const c of list) {
      if (c.id === self?.id) continue;
      if (isRunActive(c.id) && abortRun(c.id)) {
        killed++;
        killedTitles.push(c.title || "New chat");
      }
    }
    const msg =
      killed === 0
        ? "Nothing running — no workers to kill."
        : `Killed ${killed} running worker${killed === 1 ? "" : "s"}:\n${killedTitles
            .map((t) => `• ${t}`)
            .join("\n")}`;
    await sendTelegramMessage(vault, chatId, msg).catch(() => {});
    return true;
  }

  if (/^\/(new|start)\b/i.test(trimmedText)) {
    const list = await readConversations(vault);
    // Detach existing chat_id binding, if any.
    for (let i = 0; i < list.length; i++) {
      if (list[i]!.telegramChatId === chatId) {
        list[i] = { ...list[i]!, telegramChatId: undefined };
      }
    }
    const fresh: Conversation = {
      ...emptyConversation(),
      source: "telegram",
      telegramChatId: chatId,
      title: fromUsername ? `Telegram · @${fromUsername}` : "New chat",
    };
    list.unshift(fresh);
    await writeConversations(vault, list);
    await sendTelegramMessage(
      vault,
      chatId,
      "Started a new chat — fresh context. The old conversation is still in vault-chat under Recent.",
    ).catch(() => {});
    return true;
  }

  if (/^\/reset\b/i.test(trimmedText)) {
    const argMatch = trimmedText.match(/^\/reset\s+(\d+)\s*$/i);
    const list = await readConversations(vault);
    const sorted = list
      .slice()
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      .slice(0, 10);
    if (argMatch) {
      const idx = parseInt(argMatch[1]!, 10) - 1;
      const target = sorted[idx];
      if (!target) {
        await sendTelegramMessage(
          vault,
          chatId,
          `No conversation #${idx + 1}. Send /reset alone to see the list.`,
        ).catch(() => {});
        return true;
      }
      const updated = list.map((c) => {
        if (c.telegramChatId === chatId && c.id !== target.id) {
          return { ...c, telegramChatId: undefined };
        }
        if (c.id === target.id) {
          return {
            ...c,
            source: "telegram" as const,
            telegramChatId: chatId,
          };
        }
        return c;
      });
      await writeConversations(vault, updated);
      await sendTelegramMessage(
        vault,
        chatId,
        `Reattached to: ${target.title || "New chat"}\nNext messages from your phone land in that conversation.`,
      ).catch(() => {});
      return true;
    }
    if (sorted.length === 0) {
      await sendTelegramMessage(vault, chatId, "No conversations yet.").catch(() => {});
      return true;
    }
    const fmtAge = (ts: number) => {
      const diff = Date.now() - ts;
      const min = Math.floor(diff / 60_000);
      if (min < 60) return `${Math.max(1, min)}m`;
      const hr = Math.floor(min / 60);
      if (hr < 24) return `${hr}h`;
      return `${Math.floor(hr / 24)}d`;
    };
    const lines = sorted.map(
      (c, i) =>
        `${i + 1}. ${c.title || "New chat"} · ${fmtAge(c.lastActivityAt)}${
          c.telegramChatId === chatId ? " (current)" : ""
        }`,
    );
    await sendTelegramMessage(
      vault,
      chatId,
      `Recent conversations:\n${lines.join("\n")}\n\nReply /reset <N> to switch to one.`,
    ).catch(() => {});
    return true;
  }

  return false;
}
