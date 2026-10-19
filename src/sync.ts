import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useStore, type ChatMessage, type FileEntry, type LiveTool, type Theme } from "./store";
import { sendMessage, stopAgent, clearChat, interruptAndSend, sendMidTurn, cancelPending } from "./chat-controller";
import type { Conversation } from "./conversations";
import { newConversationId } from "./conversations";
import { listProjects, openProjectNotes, routeProjectChangesTo, routeProjectNotesTo, setConversationProject } from "./projects";
import { toggleVoice, voiceBarLevels } from "./voice-elevenlabs";
import { isPopout } from "./windowKind";

const POPOUT_LABEL = "chat-popout";
const MAIN_LABEL = "main";

export { isPopout };

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
  lastContext: number;
  // Mirrored so the popout can reason about what's open in main —
  // used to gate the Capture button's enabled state.
  currentFile: string | null;
  panePaths: string[];
  // Mirrored so the popout's @-mention picker and the resolver in
  // ChatPane.send() can see the vault file list — without this the
  // popout's `files` is always [] and @-refs silently drop.
  files: FileEntry[];
  // The popout is the fullscreen chat: its sidebar lists main's chats and its
  // title names the open one. Each chat without its messages (the open one's
  // are `messages`), so a long history is not re-sent on every turn.
  conversations: Conversation[];
  activeConversationId: string | null;
  /** The chat runs on main's box: its state (on, reachable, why) for the popout's composer. */
  boxChat: import("./boxChat").BoxChatState | null;
  // Voice runs in main; the popout's mic and waves show its state.
  voice: {
    voiceMode: boolean;
    voiceConnecting: boolean;
    voiceSpeaking: boolean;
    voiceListening: boolean;
    voiceMicMuted: boolean;
    voiceError: string | null;
  };
  /** Sent along when the stream changed in the same update (a reply landing as
   *  its message): the popout applies both at once — no frame without either. */
  stream?: StreamSnapshot;
};

type StreamSnapshot = {
  busy: boolean;
  streamingText: string;
  streamingReasoning: string;
  liveTools: LiveTool[];
};

export type ChatAction =
  | {
      kind: "send";
      text: string;
      contextPreamble?: string;
      attachments?: import("./store").ChatAttachment[];
    }
  // Mid-generation interruption. Aborts the current run, captures
  // whatever the agent had streamed so far as a final assistant
  // message (so the conversation isn't lost), then sends the new
  // user turn. Same payload shape as `send`.
  | {
      kind: "interrupt";
      text: string;
      contextPreamble?: string;
      attachments?: import("./store").ChatAttachment[];
    }
  // Sent while the agent works: into the running turn (steer) or after it (queue).
  | {
      kind: "steer" | "queue";
      text: string;
      contextPreamble?: string;
      attachments?: import("./store").ChatAttachment[];
    }
  | { kind: "unqueue"; id: string }
  | { kind: "stop" }
  | { kind: "clear" }
  | { kind: "startCapture" }
  // The fullscreen chat's sidebar, mic and Ctrl+T, from the popout: main owns
  // the chats list (it runs the agent and writes the list to disk).
  | { kind: "newConversation"; id: string }
  | { kind: "selectConversation"; id: string }
  | { kind: "deleteConversation"; id: string }
  | { kind: "markAllRead" }
  | { kind: "setProject"; convId: string; nameOrSlug: string | null }
  | { kind: "openProjectNotes"; slug: string; name: string }
  | { kind: "toggleVoice" };

function takeStateSnapshot(): StateSnapshot {
  const s = useStore.getState();
  return {
    vaultPath: s.vaultPath,
    messages: s.messages,
    lastContext: s.lastContext,
    currentFile: s.currentFile,
    panePaths: s.panes.map((p) => p.file),
    files: s.files,
    conversations: s.conversations.map((c) => (c.messages.length ? { ...c, messages: [] } : c)),
    activeConversationId: s.activeConversationId,
    boxChat: s.boxChat,
    voice: {
      voiceMode: s.voiceMode,
      voiceConnecting: s.voiceConnecting,
      voiceSpeaking: s.voiceSpeaking,
      voiceListening: s.voiceListening,
      voiceMicMuted: s.voiceMicMuted,
      voiceError: s.voiceError,
    },
  };
}

function takeStreamSnapshot(): StreamSnapshot {
  const s = useStore.getState();
  return {
    busy: s.busy,
    streamingText: s.streamingText,
    streamingReasoning: s.streamingReasoning,
    liveTools: s.liveTools,
  };
}

function applyActionLocal(a: ChatAction) {
  // One brain answers each turn: what Carl types goes to the conversation's agent even while voice is live on it
  // (voice hears it, and the agent's answer, as context it never answers aloud: server/voice.ts updates).
  if (a.kind === "send") sendMessage(a.text, a.contextPreamble, a.attachments);
  else if (a.kind === "interrupt") interruptAndSend(a.text, a.contextPreamble, a.attachments);
  else if (a.kind === "steer" || a.kind === "queue") void sendMidTurn(a.kind, a.text, a.contextPreamble, a.attachments);
  else if (a.kind === "unqueue") void cancelPending(a.id);
  else if (a.kind === "stop") stopAgent();
  else if (a.kind === "clear") clearChat();
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
  } else if (a.kind === "newConversation") useStore.getState().newConversation(a.id);
  else if (a.kind === "selectConversation") useStore.getState().selectConversation(a.id);
  else if (a.kind === "deleteConversation") void useStore.getState().deleteConversation(a.id);
  else if (a.kind === "markAllRead") useStore.getState().markAllRead();
  else if (a.kind === "toggleVoice") toggleVoice();
  else if (a.kind === "openProjectNotes") {
    // From the popout: main has the viewer, so it opens here and comes forward.
    void openProjectNotes(a.slug, a.name).then(() => WebviewWindow.getByLabel(MAIN_LABEL).then((w) => w?.setFocus()).catch(() => {}));
  }
  else if (a.kind === "setProject") {
    void listProjects(useStore.getState().vaultPath)
      .then((known) => setConversationProject(a.convId, a.nameOrSlug, known))
      .then((r) => {
        if (!r.ok) console.warn("[popout] project:", r.error);
      });
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

async function broadcastState(withStream = false) {
  const snap = takeStateSnapshot();
  if (withStream) snap.stream = takeStreamSnapshot();
  await emitTo(POPOUT_LABEL, "chat:state", snap).catch(() => {});
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
      state.lastContext !== prev.lastContext ||
      state.vaultPath !== prev.vaultPath ||
      state.currentFile !== prev.currentFile ||
      state.panes !== prev.panes ||
      state.files !== prev.files ||
      state.conversations !== prev.conversations ||
      state.activeConversationId !== prev.activeConversationId ||
      state.voiceMode !== prev.voiceMode ||
      state.voiceConnecting !== prev.voiceConnecting ||
      state.voiceSpeaking !== prev.voiceSpeaking ||
      state.voiceListening !== prev.voiceListening ||
      state.voiceMicMuted !== prev.voiceMicMuted ||
      state.voiceError !== prev.voiceError ||
      state.boxChat !== prev.boxChat;
    const streamChanged =
      state.busy !== prev.busy ||
      state.streamingText !== prev.streamingText ||
      state.streamingReasoning !== prev.streamingReasoning ||
      state.liveTools !== prev.liveTools;
    if (stateChanged) broadcastState(streamChanged);
    else if (streamChanged) broadcastStream();

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

    // The popout's voice waves: voice's audio is here, so send its levels
    // (~16 frames a second) while voice is on and the chat is popped out.
    const relay = state.popoutOpen && state.voiceMode;
    if (relay && !levelRelay) {
      levelRelay = setInterval(() => {
        emitTo(POPOUT_LABEL, "voice:levels", voiceBarLevels(VOICE_BARS)).catch(() => {});
      }, 60);
    }
  });
  useStore.subscribe((state) => {
    if (levelRelay && !(state.popoutOpen && state.voiceMode)) {
      clearInterval(levelRelay);
      levelRelay = null;
    }
  });
  // A project made or changed here: the popout's lists re-read theirs.
  window.addEventListener("vc-projects-changed", () => {
    if (useStore.getState().popoutOpen) emitTo(POPOUT_LABEL, "projects:changed", null).catch(() => {});
  });
}

const VOICE_BARS = 12;
let levelRelay: ReturnType<typeof setInterval> | null = null;
let relayed: number[] = [];

/** The popout's voice waves: the latest levels main sent (0 when none). */
export function relayedVoiceLevels(n: number): number[] {
  return Array.from({ length: n }, (_, i) => relayed[i] ?? 0);
}

/** The popout's chats list is main's: these store actions go to main, which
 *  applies them and broadcasts the list back (chat:state). */
function routeChatsToMain() {
  const send = (a: ChatAction) => dispatchChatAction(a);
  useStore.setState({
    newConversation: (id?: string) => {
      const nid = id ?? newConversationId();
      send({ kind: "newConversation", id: nid });
      return nid;
    },
    selectConversation: (id: string) => send({ kind: "selectConversation", id }),
    deleteConversation: async (id: string) => send({ kind: "deleteConversation", id }),
    markAllRead: () => send({ kind: "markAllRead" }),
  });
  routeProjectChangesTo((convId, nameOrSlug) => send({ kind: "setProject", convId, nameOrSlug }));
  routeProjectNotesTo((slug, name) => send({ kind: "openProjectNotes", slug, name }));
}

export async function installPopoutSync() {
  routeChatsToMain();
  await installThemeSync();
  await listen<number[]>("voice:levels", (e) => {
    relayed = Array.isArray(e.payload) ? e.payload : [];
  });
  await listen("projects:changed", () => {
    window.dispatchEvent(new CustomEvent("vc-projects-changed"));
  });
  let gotSnapshot = false;
  await listen<StateSnapshot>("chat:state", (e) => {
    gotSnapshot = true;
    useStore.getState().applyChatState(e.payload);
    // Same task: React shows the message and the emptied stream in one frame.
    if (e.payload.stream) useStore.getState().applyChatStream(e.payload.stream);
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
    // The fullscreen chat's layout: the chats sidebar (272px) beside the chat.
    width: 980,
    height: 820,
    minWidth: 380,
    minHeight: 400,
    decorations: false,
    backgroundColor: "#1f1f23",
    theme: "dark",
    // Stay hidden until the popout's main.tsx has mounted React and the
    // splash has begun fading — invokes `app_ready`. Avoids showing an
    // unpainted frame while the WebView loads.
    visible: false,
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
