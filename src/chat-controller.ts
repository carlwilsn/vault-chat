import { invoke } from "@tauri-apps/api/core";
import { runAgent } from "./agent";
import { findModel } from "./providers";
import { compactConversation } from "./compactor";
import { estimateBashEta } from "./eta-estimator";
import { gitCommitAll } from "./git";
import { flushEditCommit } from "./commit-controller";
import { sendTelegramReplyWithImages } from "./telegram";
import {
  useStore,
  MODEL_CONTEXT_LIMIT,
  type ChatMessage,
  type FileEntry,
  type LiveTool,
} from "./store";

let abortRef: AbortController | null = null;

const COMPACT_THRESHOLD = 0.85;
const KEEP_RECENT = 4;

export async function sendMessage(
  text: string,
  contextPreamble?: string,
  attachments?: import("./store").ChatAttachment[],
  // Optional override. When set, the run targets this conversation
  // instead of whichever is currently active — used by the Telegram
  // inbound handler so phone messages don't yank the user's focus.
  // The user keeps looking at whatever they were on; the agent runs
  // in the background and the off-screen path in the mid-run-switch
  // logic routes events to the right place.
  targetConvIdOverride?: string,
) {
  const s = useStore.getState();
  if (s.busy) return;
  const trimmed = text.trim();
  const preamble = contextPreamble?.trim() ?? "";
  if (!trimmed && !preamble) return;
  // Telegram-sourced runs use a cheaper default model — see
  // getTelegramModelId. User can override in Settings → Telegram.
  const targetForModelLookup = targetConvIdOverride
    ? s.conversations.find((c) => c.id === targetConvIdOverride)
    : s.conversations.find((c) => c.id === s.activeConversationId);
  let modelId = s.modelId;
  if (targetForModelLookup?.source === "telegram") {
    const { getTelegramModelId } = await import("./telegram");
    modelId = getTelegramModelId();
  }
  const spec = findModel(modelId);
  const apiKey = spec ? s.apiKeys[spec.provider] : undefined;
  if (!s.vaultPath || !apiKey || !spec) return;
  const tavilyKey = s.serviceKeys.tavily;
  const strictVault = s.strictVaultMode;
  const bashDisabled = s.bashDisabled;

  const targetConvId = targetConvIdOverride ?? s.activeConversationId;
  const isOffTarget = !!targetConvIdOverride && targetConvIdOverride !== s.activeConversationId;
  // The conversation we're actually running against — read its
  // stored messages so the history is correct even when off-target.
  const targetConv = targetConvId
    ? s.conversations.find((c) => c.id === targetConvId)
    : null;
  const targetMessages = isOffTarget
    ? (targetConv?.messages ?? [])
    : s.messages;

  // Skip compaction for off-target runs — compaction reaches into
  // the global s.messages view, which doesn't belong to the target.
  // If a Telegram-driven background run grows past the threshold,
  // we'll compact it the next time the user opens that chat.
  if (
    !isOffTarget &&
    s.lastContext > COMPACT_THRESHOLD * MODEL_CONTEXT_LIMIT &&
    s.messages.length > KEEP_RECENT
  ) {
    s.setBusy(true);
    s.setCompacting(true);
    try {
      const toSummarize = s.messages.slice(0, -KEEP_RECENT);
      const summary = await compactConversation({
        provider: spec.provider,
        apiKey,
        messages: toSummarize,
      });
      const banner: ChatMessage = {
        role: "assistant",
        content: "Conversation compacted to free context.",
        system: true,
      };
      useStore.getState().applyCompaction(summary, KEEP_RECENT, banner);
    } catch (err) {
      console.error("[compaction] failed:", err);
      useStore.getState().appendMessage({
        role: "assistant",
        content: `⚠️ Compaction failed: ${(err as any)?.message ?? String(err)}`,
        system: true,
      });
    }
    useStore.getState().setCompacting(false);
    useStore.getState().setBusy(false);
  }

  const cur = useStore.getState();
  // Append the user message. On-target → global view (current
  // behavior). Off-target → directly into the target conversation
  // entry so the user's currently-viewed chat is untouched.
  const localHistory: ChatMessage[] = isOffTarget ? targetMessages.slice() : [];
  const pushUserMsg = (m: ChatMessage) => {
    if (isOffTarget && targetConvId) {
      cur.appendMessageToConversation(targetConvId, m);
      localHistory.push(m);
    } else {
      cur.appendMessage(m);
    }
  };
  if (preamble) {
    pushUserMsg({ role: "user", content: preamble, hidden: true });
  }
  if (trimmed || (attachments && attachments.length > 0)) {
    pushUserMsg({
      role: "user",
      content: trimmed,
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
    });
  }
  if (isOffTarget && targetConvId) {
    // Off-target: don't flip the global busy flag — the user's
    // current chat shouldn't show timer / heartbeat / stop button
    // for a background run that doesn't belong to it. The target
    // conversation gets its own per-conv "running" status which
    // surfaces as the pulse in the Chats panel.
    cur.setConversationStatus(targetConvId, "running");
  } else {
    cur.setBusy(true);
    cur.resetStreaming();
  }

  // Flush any pending user-edit-debounce commit before we hand off to
  // the agent. Otherwise stray uncommitted keystrokes get rolled into
  // the agent's end-of-turn commit with the agent's message.
  await flushEditCommit();

  // History source depends on target. On-target uses the global view
  // (which was just appended into above). Off-target uses our local
  // snapshot of the target conversation's messages plus the user
  // message we pushed.
  const filtered = (isOffTarget ? localHistory : useStore.getState().messages).filter(
    (m) => !m.system,
  );
  const baseHistory = filtered.map((m) => ({ role: m.role, content: m.content }));
  const history = cur.compactionSummary && !isOffTarget
    ? [
        {
          role: "user" as const,
          content: `[Earlier conversation summary]\n\n${cur.compactionSummary}`,
        },
        {
          role: "assistant" as const,
          content: "Continuing from where we left off.",
        },
        ...baseHistory,
      ]
    : baseHistory;

  const vault = cur.vaultPath!;
  // modelId was already resolved above (Telegram-sourced convs swap
  // to the cheaper default). Don't re-read from store here — that
  // would undo the override.
  const currentFile = cur.currentFile;
  const openPaneIds = cur.panes.map((p) => p.id);
  const isTargetActive = () =>
    useStore.getState().activeConversationId === targetConvId;
  // Mirror the assistant's final reply to Telegram if the target
  // conversation is telegram-sourced — regardless of which conv the
  // user is currently watching.
  const telegramChatId =
    targetConv?.source === "telegram" ? targetConv.telegramChatId : undefined;

  // For off-target runs use a local AbortController — don't clobber
  // the singleton abortRef that the active conversation's Stop button
  // controls. Means there's no way to abort a background run from
  // the UI, but Stop button doesn't render in that case anyway.
  const controller = new AbortController();
  if (!isOffTarget) abortRef = controller;
  const signal = controller.signal;

  let acc = "";
  const tools: LiveTool[] = [];

  await runAgent({
    modelId,
    apiKey,
    vault,
    history,
    userMessage: trimmed,
    userAttachments: attachments,
    abortSignal: signal,
    tavilyKey,
    strictVault,
    bashDisabled,
    voiceMode: cur.voiceMode,
    telegramMode: targetConv?.source === "telegram",
    conversationId: targetConvId ?? undefined,
    isTelegramSourced: targetConv?.source === "telegram",
    onEvent: (e) => {
      const store = useStore.getState();
      const live = isTargetActive();
      if (e.kind === "text") {
        acc += e.delta;
        if (live) store.appendStreamingText(e.delta);
      } else if (e.kind === "reasoning_start") {
        if (live) store.clearStreamingReasoning();
      } else if (e.kind === "reasoning") {
        if (live) store.appendStreamingReasoning(e.delta);
      } else if (e.kind === "tool_input_start") {
        if (live) store.startLiveToolInput(e.id, e.name);
      } else if (e.kind === "tool_input_delta") {
        if (live) store.appendLiveToolInputDelta(e.id, e.delta);
      } else if (e.kind === "tool_use") {
        const t: LiveTool = { id: e.id, name: e.name, input: e.input, startedAt: Date.now() };
        tools.push(t);
        if (live) store.pushLiveTool(t);
        // Fire-and-forget ETA estimate for Bash. Updates the live tool
        // if Haiku comes back before the command finishes; ignored
        // otherwise. Bounded by the agent's abort signal.
        if (e.name === "Bash" && typeof e.input?.command === "string") {
          const cmd = e.input.command as string;
          const toolId = e.id;
          estimateBashEta({
            command: cmd,
            apiKeys: useStore.getState().apiKeys,
            signal,
          })
            .then((secs) => {
              if (secs == null) return;
              const live = useStore.getState().liveTools.find((x) => x.id === toolId);
              if (!live || live.result) return;
              useStore.getState().setLiveToolEta(toolId, secs);
            })
            .catch(() => {});
        }
      } else if (e.kind === "tool_result") {
        const t = tools.find((x) => x.id === e.id);
        if (t) t.result = e.result;
        if (live) store.updateLiveToolResult(e.id, e.result);
      } else if (e.kind === "done") {
        if (e.usage && live) {
          store.addTokenUsage(e.usage);
          store.setLastContext(e.usage.context);
        }
        const assistantMsg: ChatMessage = {
          role: "assistant",
          content: acc,
          toolCalls: tools.length ? tools : undefined,
          usage: e.usage,
        };
        if (live) {
          // User is still watching this conversation — write to the
          // global view and let syncActiveMessages persist on switch.
          store.appendMessage(assistantMsg);
          store.resetStreaming();
          store.setBusy(false);
        } else {
          // User navigated away mid-run. Write the final message
          // straight to the target conversation's stored messages so
          // it lands in the right place, and flip its status to idle.
          // Don't touch global streamingText/busy — those belong to
          // whatever conversation the user is currently viewing.
          if (targetConvId) {
            store.appendMessageToConversation(targetConvId, assistantMsg);
            store.setConversationStatus(targetConvId, "idle");
          }
        }

        // Status markers: the agent can end with `(ask: …)` to signal
        // it needs user input, or `(error: …)` to signal an
        // unrecoverable failure. Drives the colored dot in the Chats
        // panel for off-screen chats. Absence = assumed done.
        if (targetConvId) {
          const tail = acc.slice(-400);
          const kind: "ask" | "error" | null = /\(\s*error\s*:[^)]*\)\s*$/i.test(tail)
            ? "error"
            : /\(\s*ask\s*:[^)]*\)\s*$/i.test(tail)
              ? "ask"
              : null;
          if (kind) store.setConversationAttention(targetConvId, kind);
        }

        if (telegramChatId !== undefined && acc.trim()) {
          // Markdown image refs in the reply get pulled out and sent
          // as photos via sendPhoto; the remaining text goes as a
          // regular message. Telegram doesn't render markdown for
          // sendMessage, so without this the agent's `![alt](path)`
          // arrives as literal text on the phone.
          sendTelegramReplyWithImages(vault, telegramChatId, acc).catch((err) =>
            console.warn("[telegram] outbound reply failed:", err),
          );
        }

        // If the agent wrote / edited / deleted / ran bash, auto-commit
        // the result. The commit message is a short summary of the
        // assistant's final reply (first line, or "agent changes" as
        // fallback) plus the list of files touched.
        const mutating = new Set(["Write", "Edit", "Delete", "Bash", "NotebookEdit"]);
        const touched = tools.filter((t) => mutating.has(t.name));
        if (touched.length > 0) {
          // `[agent]` prefix on the subject so `git log --grep='^\[agent\]'`
          // cleanly separates what the agent wrote from what the user
          // wrote. The file-watcher / editor auto-commits leave subjects
          // un-prefixed, which is the user's implicit bucket.
          const subject = `[agent] ${commitSubject(trimmed, touched)}`;
          const body = touchedFilesBody(touched);
          const msg = body ? `${subject}\n\n${body}` : subject;
          // Second flush for edits the user made WHILE the agent was
          // running — they'd otherwise sneak into the agent commit.
          flushEditCommit()
            .then(() => gitCommitAll(vault, msg))
            .catch(() => {});
        }

        invoke<FileEntry[]>("list_markdown_files", { vault })
          .then(store.setFiles)
          .catch(() => {});
        if (openPaneIds.length > 0) {
          for (const paneId of openPaneIds) {
            const pane = useStore.getState().panes.find((p) => p.id === paneId);
            if (!pane) continue;
            const path = pane.file;
            invoke<string>("read_text_file", { path })
              .then((text) => useStore.getState().setPaneFile(paneId, path, text))
              .catch(() => {});
          }
        } else if (currentFile) {
          invoke<string>("read_text_file", { path: currentFile })
            .then(store.reloadCurrent)
            .catch(() => {});
        }
      } else if (e.kind === "error") {
        const errMsg: ChatMessage = {
          role: "assistant",
          content: `⚠️ ${e.message}`,
        };
        if (live) {
          store.appendMessage(errMsg);
          store.resetStreaming();
          store.setBusy(false);
        } else if (targetConvId) {
          store.appendMessageToConversation(targetConvId, errMsg);
          store.setConversationStatus(targetConvId, "idle");
        }
      }
    },
  });
}

export function stopAgent() {
  abortRef?.abort();
  abortRef = null;
  const store = useStore.getState();
  store.resetStreaming();
  store.setBusy(false);
}

// Mid-generation interruption. Captures whatever the agent had
// streamed so far as a final assistant turn (so the conversation
// keeps its history), aborts the in-flight call, then immediately
// fires off the new user message as a fresh turn. If the agent
// wasn't busy, this just degrades to a normal sendMessage.
export async function interruptAndSend(
  text: string,
  contextPreamble?: string,
  attachments?: import("./store").ChatAttachment[],
) {
  const s = useStore.getState();
  if (s.busy) {
    const partialText = s.streamingText.trim();
    const partialTools = s.liveTools;
    // Append a final assistant turn for whatever the agent had
    // produced. Italic suffix marks the interrupt so the user can
    // see at a glance which turns were cut short.
    const interrupted: ChatMessage = {
      role: "assistant",
      content: partialText
        ? `${partialText}\n\n_(interrupted)_`
        : "_(interrupted before any reply)_",
      toolCalls: partialTools.length > 0 ? partialTools : undefined,
    };
    s.appendMessage(interrupted);
    abortRef?.abort();
    abortRef = null;
    s.resetStreaming();
    s.setBusy(false);
  }
  // Hand off to the normal send flow on the next microtask so the
  // store updates from the interrupt above settle first.
  await Promise.resolve();
  await sendMessage(text, contextPreamble, attachments);
}

export function clearChat() {
  const s = useStore.getState();
  // With multi-chat, "Delete" removes the active conversation entirely
  // — the user explicitly clicked the trash. The legacy savedChats
  // rolling buffer is still updated for cross-vault recovery.
  s.saveCurrentChat();
  s.resetStreaming();
  if (s.activeConversationId) {
    s.deleteConversation(s.activeConversationId);
  } else {
    s.clearMessages();
  }
}

export function setModel(id: string) {
  useStore.getState().setModelId(id);
}

// Build a commit subject from what the user asked for, not what the
// agent replied. The agent's replies ("Sure! I'll do that…") make noisy
// commit logs. User prompts describe the intent and skim as real
// commit history.
function commitSubject(userPrompt: string, touched: LiveTool[]): string {
  const cleaned = userPrompt
    .replace(/^\/[\w-]+\s*/, "") // strip leading /skill-name
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned) {
    const oneLine = cleaned.split("\n")[0];
    if (oneLine.length <= 72) return oneLine;
    return oneLine.slice(0, 69) + "…";
  }
  const verbs: Record<string, string> = {
    Write: "wrote",
    Edit: "edited",
    Delete: "deleted",
    Bash: "ran",
    NotebookEdit: "edited notebook",
  };
  const primary = touched[touched.length - 1];
  return `agent ${verbs[primary.name] ?? "touched"} ${touchedName(primary)}`;
}

function touchedName(t: LiveTool): string {
  if (t.name === "Bash") {
    const cmd = typeof t.input?.command === "string" ? t.input.command : "";
    return cmd.split(/\s+/)[0] || "shell command";
  }
  const p = typeof t.input?.path === "string" ? t.input.path : "";
  return p.split("/").pop() ?? "file";
}

function touchedFilesBody(touched: LiveTool[]): string {
  const lines: string[] = [];
  for (const t of touched) {
    const name = touchedName(t);
    lines.push(`- ${t.name}: ${name}`);
  }
  return lines.join("\n");
}
