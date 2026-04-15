import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useStore, type ChatMessage, type FileEntry } from "./store";

const POPOUT_LABEL = "chat-popout";
const MAIN_LABEL = "main";

type Snapshot = {
  vaultPath: string | null;
  currentFile: string | null;
  currentContent: string;
  files: FileEntry[];
  messages: ChatMessage[];
  busy: boolean;
};

function takeSnapshot(): Snapshot {
  const s = useStore.getState();
  return {
    vaultPath: s.vaultPath,
    currentFile: s.currentFile,
    currentContent: s.currentContent,
    files: s.files,
    messages: s.messages,
    busy: s.busy,
  };
}

export async function installMainSync() {
  await listen("chat:ready", async () => {
    await emitTo(POPOUT_LABEL, "chat:handoff", takeSnapshot());
  });
  await listen<Snapshot>("chat:handback", (e) => {
    useStore.getState().applyChatSnapshot(e.payload);
    useStore.getState().setPopoutOpen(false);
  });
}

export async function installPopoutSync() {
  await listen<Snapshot>("chat:handoff", (e) => {
    useStore.getState().applyChatSnapshot(e.payload);
  });
  await emit("chat:ready");
  window.addEventListener("beforeunload", () => {
    emitTo(MAIN_LABEL, "chat:handback", takeSnapshot()).catch(() => {});
  });
}

export async function openChatPopout() {
  try {
    const existing = await WebviewWindow.getByLabel(POPOUT_LABEL);
    if (existing) {
      await existing.setFocus();
      return;
    }
  } catch {}

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
    console.error("popout error", e);
    useStore.getState().setPopoutOpen(false);
  });
}
