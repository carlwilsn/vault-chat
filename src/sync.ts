import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useStore, type ChatMessage, type LiveTool, type Theme, type TodoItem } from "./store";
import { sendMessage, stopAgent, clearChat, setModel } from "./chat-controller";

const POPOUT_LABEL = "chat-popout";
const MAIN_LABEL = "main";

const isPopout = new URLSearchParams(window.location.search).get("view") === "chat";

// Only the fields the popout's ChatPane/ChatWindow actually read. Keeping
// currentContent/files out of the broadcast matters: during streaming we
// emit at ~5 Hz, and shipping the whole open file + vault tree through
// IPC on every chunk causes noticeable lag in long conversations.
type Snapshot = {
  vaultPath: string | null;
  messages: ChatMessage[];
  busy: boolean;
  modelId: string;
  tokenUsage: { prompt: number; completion: number; total: number };
  lastContext: number;
  compactionSummary: string | null;
  compacting: boolean;
  streamingText: string;
  streamingReasoning: string;
  liveTools: LiveTool[];
  agentTodos: TodoItem[];
};

export type ChatAction =
  | { kind: "send"; text: string }
  | { kind: "stop" }
  | { kind: "clear" }
  | { kind: "setModel"; id: string };

function takeSnapshot(): Snapshot {
  const s = useStore.getState();
  return {
    vaultPath: s.vaultPath,
    messages: s.messages,
    busy: s.busy,
    modelId: s.modelId,
    tokenUsage: s.tokenUsage,
    lastContext: s.lastContext,
    compactionSummary: s.compactionSummary,
    compacting: s.compacting,
    streamingText: s.streamingText,
    streamingReasoning: s.streamingReasoning,
    liveTools: s.liveTools,
    agentTodos: s.agentTodos,
  };
}

function applyActionLocal(a: ChatAction) {
  if (a.kind === "send") sendMessage(a.text);
  else if (a.kind === "stop") stopAgent();
  else if (a.kind === "clear") clearChat();
  else if (a.kind === "setModel") setModel(a.id);
}

export function dispatchChatAction(a: ChatAction) {
  if (isPopout) {
    emitTo(MAIN_LABEL, "chat:action", a).catch((err) =>
      console.error("[chat:action] emit failed:", err),
    );
  } else {
    applyActionLocal(a);
  }
}

async function installThemeSync() {
  await listen<Theme>("theme:changed", (e) => {
    useStore.getState().applyThemeFromEvent(e.payload);
  });
}

async function broadcastSnapshot() {
  await emitTo(POPOUT_LABEL, "chat:state", takeSnapshot()).catch(() => {});
}

export async function installMainSync() {
  await installThemeSync();
  await listen<ChatAction>("chat:action", (e) => applyActionLocal(e.payload));
  await listen("chat:ready", () => {
    broadcastSnapshot();
  });
  useStore.subscribe((state, prev) => {
    if (!state.popoutOpen) return;
    if (
      state.messages !== prev.messages ||
      state.busy !== prev.busy ||
      state.streamingText !== prev.streamingText ||
      state.streamingReasoning !== prev.streamingReasoning ||
      state.liveTools !== prev.liveTools ||
      state.agentTodos !== prev.agentTodos ||
      state.modelId !== prev.modelId ||
      state.tokenUsage !== prev.tokenUsage ||
      state.lastContext !== prev.lastContext ||
      state.compactionSummary !== prev.compactionSummary ||
      state.compacting !== prev.compacting ||
      state.vaultPath !== prev.vaultPath
    ) {
      broadcastSnapshot();
    }
  });
}

export async function installPopoutSync() {
  await installThemeSync();
  let gotSnapshot = false;
  await listen<Snapshot>("chat:state", (e) => {
    gotSnapshot = true;
    useStore.getState().applyChatSnapshot(e.payload);
  });
  // The chat:ready → broadcastSnapshot handshake is one-shot, so a
  // single lost event leaves the popout showing an empty chat forever.
  // Retry with backoff until the first snapshot lands — main's handler
  // is idempotent (just re-broadcasts current state).
  const delays = [0, 150, 400, 900, 1800, 3000];
  for (const d of delays) {
    if (gotSnapshot) return;
    if (d > 0) await new Promise((r) => setTimeout(r, d));
    if (gotSnapshot) return;
    try { await emit("chat:ready"); } catch {}
  }
}

export async function openChatPopout() {
  try {
    const existing = await WebviewWindow.getByLabel(POPOUT_LABEL);
    if (existing) {
      try {
        await existing.show();
        await existing.unminimize();
        await existing.setFocus();
        useStore.getState().setPopoutOpen(true);
        broadcastSnapshot();
        return;
      } catch (e) {
        console.warn("[popout] failed to reuse existing, closing it:", e);
        try { await existing.close(); } catch {}
      }
    }
  } catch (e) {
    console.error("[popout] getByLabel error:", e);
  }

  const w = new WebviewWindow(POPOUT_LABEL, {
    url: "index.html?view=chat",
    title: "Chat",
    width: 540,
    height: 820,
    minWidth: 380,
    minHeight: 400,
    decorations: false,
    backgroundColor: "#1f1f23",
    theme: "dark",
  });
  useStore.getState().setPopoutOpen(true);
  w.once("tauri://destroyed", () => {
    useStore.getState().setPopoutOpen(false);
  });
  w.once("tauri://error", (e) => {
    console.error("[popout] window error:", e);
    useStore.getState().setPopoutOpen(false);
  });
}
