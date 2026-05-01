import { invoke } from "@tauri-apps/api/core";
import { runAgent } from "./agent";
import { findModel } from "./providers";
import { compactConversation } from "./compactor";
import { gitCommitAll } from "./git";
import { flushEditCommit } from "./commit-controller";
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
) {
  const s = useStore.getState();
  if (s.busy) return;
  const trimmed = text.trim();
  const preamble = contextPreamble?.trim() ?? "";
  if (!trimmed && !preamble) return;
  const spec = findModel(s.modelId);
  const apiKey = spec ? s.apiKeys[spec.provider] : undefined;
  if (!s.vaultPath || !apiKey || !spec) return;
  const tavilyKey = s.serviceKeys.tavily;

  if (
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
  // Context preamble (e.g. @mention file contents) goes in as a hidden
  // user message — present in the history sent to the agent, but not
  // rendered in the UI so the visible bubble is just what the user typed.
  if (preamble) {
    cur.appendMessage({ role: "user", content: preamble, hidden: true });
  }
  if (trimmed || (attachments && attachments.length > 0)) {
    cur.appendMessage({
      role: "user",
      content: trimmed,
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
    });
  }
  cur.setBusy(true);
  cur.resetStreaming();

  // Flush any pending user-edit-debounce commit before we hand off to
  // the agent. Otherwise stray uncommitted keystrokes get rolled into
  // the agent's end-of-turn commit with the agent's message.
  await flushEditCommit();

  const filtered = cur.messages.filter((m) => !m.system);
  const baseHistory = filtered.map((m) => ({ role: m.role, content: m.content }));
  const history = cur.compactionSummary
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
  const modelId = cur.modelId;
  const currentFile = cur.currentFile;
  const openPaneIds = cur.panes.map((p) => p.id);

  abortRef = new AbortController();
  const signal = abortRef.signal;

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
    onEvent: (e) => {
      const store = useStore.getState();
      if (e.kind === "text") {
        acc += e.delta;
        store.appendStreamingText(e.delta);
      } else if (e.kind === "reasoning_start") {
        store.clearStreamingReasoning();
      } else if (e.kind === "reasoning") {
        store.appendStreamingReasoning(e.delta);
      } else if (e.kind === "tool_input_start") {
        store.startLiveToolInput(e.id, e.name);
      } else if (e.kind === "tool_input_delta") {
        store.appendLiveToolInputDelta(e.id, e.delta);
      } else if (e.kind === "tool_use") {
        const t: LiveTool = { id: e.id, name: e.name, input: e.input, startedAt: Date.now() };
        tools.push(t);
        store.pushLiveTool(t);
      } else if (e.kind === "tool_result") {
        const t = tools.find((x) => x.id === e.id);
        if (t) t.result = e.result;
        store.updateLiveToolResult(e.id, e.result);
      } else if (e.kind === "done") {
        if (e.usage) {
          store.addTokenUsage(e.usage);
          store.setLastContext(e.usage.context);
        }
        store.appendMessage({
          role: "assistant",
          content: acc,
          toolCalls: tools.length ? tools : undefined,
          usage: e.usage,
        });
        store.resetStreaming();
        store.setBusy(false);

        // If the agent wrote / edited / deleted / ran bash, auto-commit
        // the result. The commit message is a short summary of the
        // assistant's final reply (first line, or "agent changes" as
        // fallback) plus the list of files touched.
        const mutating = new Set(["Write", "Edit", "Delete", "Bash", "NotebookEdit"]);
        const touched = tools.filter((t) => mutating.has(t.name));
        if (touched.length > 0) {
          const subject = commitSubject(trimmed, touched);
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
        store.appendMessage({ role: "assistant", content: `⚠️ ${e.message}` });
        store.resetStreaming();
        store.setBusy(false);
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

export function clearChat() {
  const s = useStore.getState();
  s.clearMessages();
  s.resetStreaming();
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
