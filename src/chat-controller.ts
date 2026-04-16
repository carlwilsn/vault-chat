import { invoke } from "@tauri-apps/api/core";
import { runAgent } from "./agent";
import { findModel } from "./providers";
import { useStore, type FileEntry, type LiveTool } from "./store";

let abortRef: AbortController | null = null;

export async function sendMessage(text: string) {
  const s = useStore.getState();
  if (s.busy) return;
  const trimmed = text.trim();
  if (!trimmed) return;
  const spec = findModel(s.modelId);
  const apiKey = spec ? s.apiKeys[spec.provider] : undefined;
  if (!s.vaultPath || !apiKey) return;
  const tavilyKey = s.serviceKeys.tavily;

  s.appendMessage({ role: "user", content: trimmed });
  s.setBusy(true);
  s.resetStreaming();

  const history = s.messages.map((m) => ({ role: m.role, content: m.content }));
  const vault = s.vaultPath;
  const modelId = s.modelId;
  const currentFile = s.currentFile;

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
        if (e.usage) store.addTokenUsage(e.usage);
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
        if (currentFile) {
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
