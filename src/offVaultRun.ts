import { runAgent, type TurnCost } from "./agent";
import {
  AUTO_MODEL_ID,
  resolveAutoModel,
  resolveTurnModel,
  MissingKeyError,
  roundUsd,
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
import { registerRun, unregisterRun } from "./runRegistry";
import { vlog } from "./debugLog";
import { errToString } from "./errfmt";

// withConvLock (shared read→modify→write serializer for the conversations
// store) now lives in ./conversations so the store's autosave can share it.

// ---- cost bookkeeping ----
// runAgent emits one `cost` event per call (the summed server-reported
// usage.cost of every model call it made). A turn may call runAgent more than
// once (the quota-fallback retry) — every attempt's spend is real, so it adds.
type CostAcc = { usd: number; calls: number; missing: number };
function newCostAcc(): CostAcc {
  return { usd: 0, calls: 0, missing: 0 };
}
function addTurnCost(acc: CostAcc, c: TurnCost): void {
  acc.usd = roundUsd(acc.usd + (c.usd || 0));
  acc.calls += c.calls || 0;
  acc.missing += c.missing || 0;
}
// Fields to merge onto the conversation for a turn's spend (running totals).
function convCostPatch(conv: Conversation, acc: CostAcc): Partial<Conversation> {
  if (!acc.calls) return {};
  return {
    costUsd: roundUsd((conv.costUsd ?? 0) + acc.usd),
    ...(acc.missing || conv.costMissingCalls ? { costMissingCalls: (conv.costMissingCalls ?? 0) + acc.missing } : {}),
  };
}
// The per-message field (ChatMessage lives in store.ts; the JSON passthrough
// keeps the extra field on disk).
function msgCostPatch(acc: CostAcc): { costUsd?: number } {
  return acc.calls ? { costUsd: acc.usd } : {};
}

// ---- no silent no-key runs ----
// A turn whose model has no usable provider key used to return quietly ("no
// model / API key configured", or a console.warn on the scheduled path) — on
// the box that meant missions simply stopped, with nothing anywhere saying why.
// Now the failure is written into the thread as a failed assistant turn (so the
// thread, the phone and the resume sweep all see it) and pushed as ONE
// notification per provider per half hour.
const missingKeyNotifiedAt = new Map<string, number>();
async function reportMissingKey(
  vault: string,
  conversationId: string,
  err: MissingKeyError,
  userMessage: string | null,
): Promise<void> {
  const text = `⚠️ ${err.message}`;
  vlog("turn.no-key", { conv: conversationId.slice(0, 8), model: err.modelId, provider: err.provider });
  console.error(`[harness] ${err.message} (conversation ${conversationId})`);
  await withConvLock(async () => {
    const list = await readConversations(vault);
    const idx = list.findIndex((c) => c.id === conversationId);
    if (idx < 0) return;
    const add: ChatMessage[] = [];
    if (userMessage != null) add.push({ role: "user", content: userMessage, mid: newMessageId() });
    add.push({ role: "assistant", content: text, failed: true, mid: newMessageId() });
    list[idx] = { ...list[idx]!, messages: [...list[idx]!.messages, ...add], lastActivityAt: Date.now() };
    await writeConversations(vault, list);
  }).catch((e) => console.warn("[harness] could not record the missing-key failure:", errToString(e)));
  await useStore.getState().refreshConversationFromDisk(vault, conversationId).catch(() => {});
  const k = `${err.provider ?? "?"}`;
  const now = Date.now();
  if (now - (missingKeyNotifiedAt.get(k) ?? 0) < 30 * 60_000) return;
  missingKeyNotifiedAt.set(k, now);
  try {
    const { notify } = await import("./phoneApp");
    await notify("info", "A turn did not run — missing API key", err.message, conversationId, {
      intention: "Missing API key",
      summary: err.message.slice(0, 200),
      icon: "⚠️",
      cls: "r",
    });
  } catch (e) {
    console.warn("[harness] missing-key notification failed:", errToString(e));
  }
}

// Resolve the model + key a turn runs on, or report the failure loudly and
// return null. `candidates` in preference order; the "auto" sentinel is
// resolved against `message` first.
async function resolveTurnOrReport(
  vault: string,
  conversationId: string,
  candidates: Array<string | undefined | null>,
  message: string,
  appendUser: boolean,
): Promise<{ modelId: string; apiKey: string } | null> {
  const store = useStore.getState();
  const ids = candidates.map((c) =>
    c === AUTO_MODEL_ID ? resolveAutoModel(message, store.apiKeys, getLiveCatalog())?.id ?? c : c,
  );
  try {
    const r = resolveTurnModel(ids, store.apiKeys);
    if (r.routedFrom) vlog("turn.model.rerouted", { conv: conversationId.slice(0, 8), from: r.routedFrom, to: r.modelId });
    return { modelId: r.modelId, apiKey: r.apiKey };
  } catch (e) {
    const err = e instanceof MissingKeyError ? e : new MissingKeyError(String(ids[0] ?? "?"), null, errToString(e));
    await reportMissingKey(vault, conversationId, err, appendUser ? message : null);
    return null;
  }
}

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
  const list = await readConversations(vault);
  // No silent no-key runs: a missing key is written into the target thread and
  // pushed, instead of a console.warn nobody reads.
  if (!list.some((c) => c.id === conversationId)) {
    // The schedule's target conversation no longer exists on disk — fall back
    // to creating a fresh one rather than dropping the run (persisted now so a
    // missing-key failure below has a thread to land in).
    list.unshift({
      ...emptyConversation(),
      id: conversationId,
      source: "scheduled",
      title: deriveConversationTitle([{ role: "user", content: prompt }]),
    });
    await writeConversations(vault, list);
  }
  const resolved = await resolveTurnOrReport(vault, conversationId, [opts.modelId || store.modelId], prompt, true);
  if (!resolved) return;
  const { modelId, apiKey } = resolved;

  const idx = list.findIndex((c) => c.id === conversationId);
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
  const cost = newCostAcc();
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
        } else if (e.kind === "cost") {
          addTurnCost(cost, e.cost);
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
    // A silent turn leaves no message — but its spend still counts.
    finalList[fi] = { ...finalList[fi]!, messages: pruned, ...convCostPatch(finalList[fi]!, cost) };
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
      failed: runErr ? true : undefined,
      ...msgCostPatch(cost),
    };
    finalList[fi] = {
      ...finalList[fi]!,
      ...convCostPatch(finalList[fi]!, cost),
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
