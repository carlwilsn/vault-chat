import { invoke } from "@tauri-apps/api/core";
import { runAgent } from "./agent";
import { findModel } from "./providers";
import { compactConversation } from "./compactor";
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

export async function sendMessage(text: string) {
  const s = useStore.getState();
  if (s.busy) return;
  const trimmed = text.trim();
  if (!trimmed) return;
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
  cur.appendMessage({ role: "user", content: trimmed });
  cur.setBusy(true);
  cur.resetStreaming();

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
    abortSignal: signal,
    tavilyKey,
    onEvent: (e) => {
      const store = useStore.getState();
      if (e.kind === "text") {
        acc += e.delta;
        store.appendStreamingText(e.delta);
      } else if (e.kind === "tool_use") {
        const t: LiveTool = { id: e.id, name: e.name, input: e.input };
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
        });
        store.resetStreaming();
        store.setBusy(false);
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
}

export function clearChat() {
  const s = useStore.getState();
  s.clearMessages();
  s.resetStreaming();
}

export function setModel(id: string) {
  useStore.getState().setModelId(id);
}
