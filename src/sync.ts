import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useStore, type ChatMessage, type FileEntry, type LiveTool, type Theme } from "./store";
import { sendMessage, stopAgent, clearChat, setModel } from "./chat-controller";

const POPOUT_LABEL = "chat-popout";
const MAIN_LABEL = "main";

const isPopout = new URLSearchParams(window.location.search).get("view") === "chat";

type Snapshot = {
  vaultPath: string | null;
  currentFile: string | null;
  currentContent: string;
  files: FileEntry[];
  messages: ChatMessage[];
  busy: boolean;
  modelId: string;
  tokenUsage: { prompt: number; completion: number; total: number };
  lastContext: number;
  compactionSummary: string | null;
  compacting: boolean;
  streamingText: string;
  liveTools: LiveTool[];
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
    currentFile: s.currentFile,
    currentContent: s.currentContent,
    files: s.files,
    messages: s.messages,
    busy: s.busy,
    modelId: s.modelId,
    tokenUsage: s.tokenUsage,
    lastContext: s.lastContext,
    compactionSummary: s.compactionSummary,
    compacting: s.compacting,
    streamingText: s.streamingText,
    liveTools: s.liveTools,
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
      state.liveTools !== prev.liveTools ||
      state.modelId !== prev.modelId ||
      state.tokenUsage !== prev.tokenUsage ||
      state.lastContext !== prev.lastContext ||
      state.compactionSummary !== prev.compactionSummary ||
      state.compacting !== prev.compacting ||
      state.vaultPath !== prev.vaultPath ||
      state.currentFile !== prev.currentFile ||
      state.currentContent !== prev.currentContent ||
      state.files !== prev.files
    ) {
      broadcastSnapshot();
    }
  });
}

export async function installPopoutSync() {
  await installThemeSync();
  await listen<Snapshot>("chat:state", (e) => {
    useStore.getState().applyChatSnapshot(e.payload);
  });
  await emit("chat:ready");
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
