import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useStore, type ChatMessage, type LiveTool, type Theme, type TodoItem } from "./store";
import { sendMessage, stopAgent, clearChat, setModel } from "./chat-controller";

const POPOUT_LABEL = "chat-popout";
const MAIN_LABEL = "main";

export const isPopout = new URLSearchParams(window.location.search).get("view") === "chat";

// Two-tier broadcast:
// - chat:state carries message list + session metadata, fires only when
//   those actually change (new turn, model swap, compaction, vault).
// - chat:stream carries streaming text + live tools + todos, fires at
//   streaming cadence (~5 Hz) during agent responses.
// Keeping them on separate channels means streaming chunks don't churn
// the messages array reference in the popout, so MessageBubble rows
// don't re-render on every token.
type StateSnapshot = {
  vaultPath: string | null;
  messages: ChatMessage[];
  modelId: string;
  tokenUsage: { prompt: number; completion: number; total: number };
  lastContext: number;
  compactionSummary: string | null;
  compacting: boolean;
  // Mirrored so the popout can reason about what's open in main —
  // used to gate the Capture button's enabled state.
  currentFile: string | null;
  panePaths: string[];
};

type StreamSnapshot = {
  busy: boolean;
  streamingText: string;
  streamingReasoning: string;
  liveTools: LiveTool[];
  agentTodos: TodoItem[];
};

export type ChatAction =
  | {
      kind: "send";
      text: string;
      contextPreamble?: string;
      attachments?: import("./store").ChatAttachment[];
    }
  | { kind: "stop" }
  | { kind: "clear" }
  | { kind: "setModel"; id: string }
  | { kind: "startCapture" };

function takeStateSnapshot(): StateSnapshot {
  const s = useStore.getState();
  return {
    vaultPath: s.vaultPath,
    messages: s.messages,
    modelId: s.modelId,
    tokenUsage: s.tokenUsage,
    lastContext: s.lastContext,
    compactionSummary: s.compactionSummary,
    compacting: s.compacting,
    currentFile: s.currentFile,
    panePaths: s.panes.map((p) => p.file),
  };
}

function takeStreamSnapshot(): StreamSnapshot {
  const s = useStore.getState();
  return {
    busy: s.busy,
    streamingText: s.streamingText,
    streamingReasoning: s.streamingReasoning,
    liveTools: s.liveTools,
    agentTodos: s.agentTodos,
  };
}

function applyActionLocal(a: ChatAction) {
  if (a.kind === "send") sendMessage(a.text, a.contextPreamble, a.attachments);
  else if (a.kind === "stop") stopAgent();
  else if (a.kind === "clear") clearChat();
  else if (a.kind === "setModel") setModel(a.id);
  else if (a.kind === "startCapture") {
    // Triggered by popout's Camera button. Main sets the pending
    // flag and fires marquee-toggle on main's window — the user
    // draws in main's viewer, the resulting image is then emitted
    // back to popout via chat:captured.
    const s = useStore.getState();
    s.setEditPromptCapturePending(false);
    s.setNoteCapturePending(false);
    s.setChatPaneCapturePending(true);
    window.dispatchEvent(new CustomEvent("vc-marquee-toggle"));
  }
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

async function broadcastState() {
  await emitTo(POPOUT_LABEL, "chat:state", takeStateSnapshot()).catch(() => {});
}

async function broadcastStream() {
  await emitTo(POPOUT_LABEL, "chat:stream", takeStreamSnapshot()).catch(() => {});
}

async function broadcastFull() {
  await broadcastState();
  await broadcastStream();
}

export async function installMainSync() {
  await installThemeSync();
  await listen<ChatAction>("chat:action", (e) => applyActionLocal(e.payload));
  await listen("chat:ready", () => {
    broadcastFull();
  });
  useStore.subscribe((state, prev) => {
    if (!state.popoutOpen) return;

    const stateChanged =
      state.messages !== prev.messages ||
      state.modelId !== prev.modelId ||
      state.tokenUsage !== prev.tokenUsage ||
      state.lastContext !== prev.lastContext ||
      state.compactionSummary !== prev.compactionSummary ||
      state.compacting !== prev.compacting ||
      state.vaultPath !== prev.vaultPath ||
      state.currentFile !== prev.currentFile ||
      state.panes !== prev.panes;
    if (stateChanged) broadcastState();

    const streamChanged =
      state.busy !== prev.busy ||
      state.streamingText !== prev.streamingText ||
      state.streamingReasoning !== prev.streamingReasoning ||
      state.liveTools !== prev.liveTools ||
      state.agentTodos !== prev.agentTodos;
    if (streamChanged) broadcastStream();

    // Chat-pane Capture bridge: when a viewer divert lands an image
    // in chatPaneLastCapture on main while the popout is open,
    // forward it to the popout as a one-shot chat:captured event and
    // clear main's so it doesn't linger (main's ChatPane isn't
    // mounted while popped out, so nothing else consumes it).
    if (
      state.chatPaneLastCapture &&
      state.chatPaneLastCapture !== prev.chatPaneLastCapture
    ) {
      const payload = state.chatPaneLastCapture;
      emitTo(POPOUT_LABEL, "chat:captured", payload).catch(() => {});
      useStore.getState().setChatPaneLastCapture(null);
    }
  });
}

export async function installPopoutSync() {
  await installThemeSync();
  let gotSnapshot = false;
  await listen<StateSnapshot>("chat:state", (e) => {
    gotSnapshot = true;
    useStore.getState().applyChatState(e.payload);
  });
  await listen<StreamSnapshot>("chat:stream", (e) => {
    useStore.getState().applyChatStream(e.payload);
  });
  // Image-capture relay: main bounces the Capture result back here;
  // popout's ChatPane useEffect picks it up and appends to its
  // pendingImages.
  await listen<{
    imageDataUrl: string;
    sourcePath: string;
    sourceAnchor: string | null;
  }>("chat:captured", (e) => {
    useStore.getState().setChatPaneLastCapture(e.payload);
  });
  // The chat:ready → broadcast handshake is one-shot, so a single lost
  // event leaves the popout showing an empty chat forever. Retry with
  // backoff until the first snapshot lands — main's handler is
  // idempotent (just re-broadcasts current state).
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
        broadcastFull();
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
