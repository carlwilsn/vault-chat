import { create } from "zustand";
import { isPopout } from "./windowKind";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import type { Skill } from "./skills";
import type { Note } from "./notes";
import { readNotes, appendNote, writeAllNotes } from "./notes";
import {
  type Conversation,
  deriveConversationTitle,
  emptyConversation,
  newMessageId,
} from "./conversations";

// Stamp a stable `mid` on a message at creation if it lacks one (release 1 of
// the message-identity cure). Idempotent: a message that already has a mid is
// returned unchanged, so re-appending a synced/replayed message never re-mints.
function withMid(m: ChatMessage): ChatMessage {
  return m.mid ? m : { ...m, mid: newMessageId() };
}
import { formatNote } from "./notes-format";
import { lastReportedContext } from "./chatContext";

import { keychainGet, keychainSet, keychainDelete, KEY, type ProviderId } from "./keychain";

export type FileEntry = {
  path: string;
  name: string;
  is_dir: boolean;
  depth: number;
  hidden: boolean;
  // True when this path (or an ancestor) is in `.vaultchatdeny`. The
  // file tree shows a lock badge; agent file-touching tools refuse it.
  denied: boolean;
  // True when this exact path is in <vault>/.vault-chat/humanized.json.
  // Agent write tools refuse it; the user can still edit by hand.
  humanized: boolean;
  // Set only for directories that ARE a git repo root (contain `.git`).
  // Branch name, e.g. "main", or "detached". Used only to detect "is a repo";
  // the file tree no longer renders the branch name.
  git_branch?: string;
  // Number of uncommitted changes (lines from `git status --porcelain`).
  // 0 = clean; >0 = dirty. Only set when git_branch is set.
  git_dirty_count?: number;
  // Set only when a nested repo is genuinely stuck (detached at an old commit
  // that won't sync). Human-readable reason for the tooltip. Absent when healthy.
  git_warn?: string;
};

export type ChatRole = "user" | "assistant";
export type ChatAttachment = {
  imageDataUrl: string;
  sourcePath?: string;
  sourceAnchor?: string | null;
  // Vault-relative path where the capture's PNG bytes are saved on disk
  // (e.g. ".vault-chat/captures/2026-05-07_142530-abc123.png"). Surfaced
  // to the agent so it can reference the image in a markdown file via
  // `![cap](.vault-chat/captures/...)`. Captures get pruned after the
  // retention window, after which this path dangles — chat bubbles
  // still render from the data URL.
  capturedFilePath?: string;
};

export type ChatMessage = {
  role: ChatRole;
  content: string;
  // `subagents` (box mode): the children a `subagent` call spawned — their
  // threadIds; their state, cost and summary live in Conversation.subagents.
  toolCalls?: { id?: string; name: string; input: any; result?: string; subagents?: string[] }[];
  system?: boolean;
  // Excluded from the UI but still sent to the agent. Used for inline-ask
  // context preambles that the user didn't type.
  hidden?: boolean;
  // Token usage reported by the model for this turn (assistant only).
  // `window` (box mode): the box model's context window the turn ran in.
  usage?: { prompt: number; completion: number; total: number; context: number; window?: number; costUsd?: number };
  // The model's thinking for this turn (box: pi's thinking blocks; laptop: the
  // reasoning stream), kept with the reply.
  thinking?: string;
  // What this turn cost (USD, OpenRouter's own figure), when known.
  costUsd?: number;
  // Images attached to this turn via the chat pane's Capture button.
  // Render as thumbnails under the bubble; sent to the agent as
  // structured image parts on that turn.
  attachments?: ChatAttachment[];
  // Haiku-cleaned timeline for a worker/mission turn: the agent's reasoning as a
  // chain of COMPLETE logical thoughts (the work woven into each, obstacles flagged
  // via snag), plus the turn's final reply. Computed at turn completion and
  // rendered in the cockpit thread so the user follows the real reasoning instead
  // of one run-on blob + a tool chip.
  timeline?: {
    steps: { thought: string; action?: string; snag?: boolean }[];
    reply: string;
  };
  // A DIRECT reply to a message the user typed (vs. autonomous/background work
  // like a worker-wake review or a scheduled self-check). Direct replies stay
  // NATURAL — they're a conversation, not reasoning — so the cleaner leaves them
  // as prose instead of chopping them into a thought-chain timeline.
  direct?: boolean;
  // A FORMAL user decision — a tapped AskUser option or a committed free-form
  // answer arriving via the phone's /answer route. Distinct from an ordinary
  // typed message so the cockpit renders it as a decision chip ("Your call —
  // …") and the record of WHICH way the user decided survives in the thread,
  // deterministically, instead of as loose prose.
  decision?: boolean;
  // This assistant turn ended in an error (model/SDK failure or a thrown
  // exception), not a clean finish. The completion path reads this so a crashed
  // worker reports "FAILED" instead of a false "done — completed its task".
  failed?: boolean;
  // Stable per-message id, minted at creation (release 1 of the message-identity
  // cure). Optional — legacy messages on disk lack it; readers must tolerate its
  // absence. INERT for now (no merge logic reads it yet); it just rides on disk
  // so it has propagated everywhere before a later release dedupes/merges by id.
  mid?: string;
  // Voice lines: what the bubble shows instead of `content` — the same words
  // with the spoken math as LaTeX (voiceMath.ts). `content` stays as spoken.
  display?: string;
  // A line said on a voice call (Carl's or the voice's): shown as a compact voice turn, not a bubble.
  voice?: boolean;
  // Voice asked the agent something in the background (server/voice.ts Ask): one collapsed row, never a bubble.
  voiceAsk?: { request: string; result: string; failed: boolean; act?: boolean };
  // [ask redesign] A fresh option set the ask agent proposed mid-conversation
  // (via its ProposeOptions tool). The phone renders these as tappable cards
  // that STACK under the exchange — the original options at the top of the ask
  // are never replaced. Tapping one relays it as the tagged answer to the
  // waiting mission. Only ever set on assistant turns in source:"ask" threads.
  askOptions?: { answer: string; title: string; body: string; primary?: boolean }[];
  // [box mode] Shown by this client only (src/boxChat.ts): `boxPending`, its
  // own message on its way to the box (the box's log confirms it in place, by
  // `mid`); `boxLocal`, a line the box never got (unreachable, refused).
  boxPending?: boolean;
  boxLocal?: boolean;
  // A compaction divider (always `system: true`): the earlier conversation was
  // summarized here. The model sees this summary plus only the messages AFTER
  // the divider; the chat shows a quiet divider whose summary expands. See
  // chatContext.ts.
  compaction?: { summary: string; at?: number };
  // [box] A roll-over marker (server/context/rollover.ts): the conversation
  // moved to a fresh session here, with this recap. Shown like a compaction.
  rollover?: { at?: number; fromThread?: string; recap?: string };
};

// Shallow content-compare for the chat message list. The popout
// receives a fresh array from JSON.parse on every chat:state broadcast;
// if the contents are identical we reuse the existing reference so
// MessageBubble rows don't re-render.
function messagesEqual(a: ChatMessage[], b: ChatMessage[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.role !== y.role || x.content !== y.content || x.hidden !== y.hidden) return false;
    const xt = x.toolCalls?.length ?? 0;
    const yt = y.toolCalls?.length ?? 0;
    if (xt !== yt) return false;
    const xa = x.attachments?.length ?? 0;
    const ya = y.attachments?.length ?? 0;
    if (xa !== ya) return false;
  }
  return true;
}


export type LiveTool = { id: string; name: string; input: any; result?: string; startedAt?: number; inputChars?: number; etaSeconds?: number };

export type TodoStatus = "pending" | "in_progress" | "completed";
export type TodoItem = { content: string; status: TodoStatus; activeForm?: string };

// Snapshot of a single conversation's in-flight streaming view, used to
// keep a backgrounded run's progress visible across leave/return.
export type ConvRuntime = {
  streamingText: string;
  streamingReasoning: string;
  liveTools: LiveTool[];
  // Live thought-by-thought steps for a background worker/supervisor turn,
  // built on the fly from the interleaving of prose and tool calls (the server
  // sees the exact order). The phone renders these as a GROWING timeline so you
  // watch it work step by step — the live counterpart to the Haiku-cleaned
  // timeline that lands on the message once the turn finishes. The last entry is
  // the in-flight thought (action still pending).
  liveSteps?: { thought: string; action: string }[];
  agentTodos?: TodoItem[];
  tokenUsage?: { prompt: number; completion: number; total: number };
  lastContext?: number;
  // [box] The box model's context window, reported with the live usage.
  contextWindow?: number;
  startedAt?: number;
};

function liveToolsEqual(a: LiveTool[], b: LiveTool[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.id !== y.id ||
      x.name !== y.name ||
      x.result !== y.result ||
      (x.inputChars ?? 0) !== (y.inputChars ?? 0) ||
      (x.etaSeconds ?? 0) !== (y.etaSeconds ?? 0)
    )
      return false;
  }
  return true;
}


export type Pane = { id: string; file: string; content: string; mode: "view" | "edit" };
export type SplitDirection = "horizontal" | "vertical" | null;
export type DropSide = "left" | "right" | "top" | "bottom";

const newPaneId = () =>
  (typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `p_${Math.random().toString(36).slice(2)}`);

type ApiKeys = Partial<Record<ProviderId, string>>;
export type ServiceKeys = { tavily?: string; elevenlabs?: string };

const THEME_STORAGE = "vault_chat_theme";
const CHAT_SIDEBAR_STORAGE = "vc_chat_sidebar";

/** Fullscreen chat's sidebar: open unless it was last closed. */
function readChatSidebarOpen(): boolean {
  try {
    return localStorage.getItem(CHAT_SIDEBAR_STORAGE) !== "0";
  } catch {
    return true;
  }
}
const VAULT_STORAGE = "vault_chat_last_vault";
// The box's X-Vault-Token (box-mode chat and the sync's API calls), the same
// token the phone uses. Machine-local by design — never in the synced config.
// The key keeps its old name (it was the mission host's token).
const BOX_TOKEN_STORAGE = "vault_chat_mission_host_token";
// The active/open conversation is PER-DEVICE, not synced: your phone chat and
// your desktop chat are independent (message CONTENT still syncs via the vault).
// Persisted per vault so reopening the app restores THIS device's last-open
// thread instead of auto-jumping to whatever was most-recently touched — a
// phone chat bumps a thread to the top, which used to yank the desktop onto it.
const ACTIVE_CONV_STORAGE = "vault_chat_active_conv";
function activeConvKey(vault: string): string {
  return `${ACTIVE_CONV_STORAGE}:${vault}`;
}
function savedActiveConvId(vault: string | null): string | null {
  if (!vault) return null;
  try {
    return localStorage.getItem(activeConvKey(vault));
  } catch {
    return null;
  }
}
function persistActiveConvId(vault: string | null, id: string | null): void {
  if (!vault) return;
  try {
    if (id) localStorage.setItem(activeConvKey(vault), id);
    else localStorage.removeItem(activeConvKey(vault));
  } catch {
    /* localStorage unavailable — non-fatal */
  }
}
export type Theme = "graphite" | "light";

function loadTheme(): Theme {
  const raw = localStorage.getItem(THEME_STORAGE);
  return raw === "light" ? "light" : "graphite";
}

/** Fetch every known credential from the OS keychain into memory.
 *  Called once on app boot (see `hydrateKeychain` below). */
async function fetchAllFromKeychain(): Promise<{
  apiKeys: ApiKeys;
  serviceKeys: ServiceKeys;
}> {
  const [anthropic, openai, google, openrouter, tavily, elevenlabs] = await Promise.all([
    keychainGet(KEY.anthropic),
    keychainGet(KEY.openai),
    keychainGet(KEY.google),
    keychainGet(KEY.openrouter),
    keychainGet(KEY.tavily),
    keychainGet(KEY.elevenlabs),
  ]);
  const apiKeys: ApiKeys = {};
  if (anthropic) apiKeys.anthropic = anthropic;
  if (openai) apiKeys.openai = openai;
  if (google) apiKeys.google = google;
  if (openrouter) apiKeys.openrouter = openrouter;
  const serviceKeys: ServiceKeys = {};
  if (tavily) serviceKeys.tavily = tavily;
  if (elevenlabs) serviceKeys.elevenlabs = elevenlabs;
  return { apiKeys, serviceKeys };
}

/** One-time migration: if the previous version stored keys in
 *  localStorage, copy them to the keychain and clear the localStorage
 *  entries. Silent — users don't re-enter anything. */
async function migrateLocalStorageKeys(): Promise<void> {
  const OLD_API = "vault_chat_api_keys";
  const OLD_SERVICE = "vault_chat_service_keys";
  try {
    const rawApi = localStorage.getItem(OLD_API);
    if (rawApi) {
      const parsed = JSON.parse(rawApi) as ApiKeys;
      if (parsed.anthropic) await keychainSet(KEY.anthropic, parsed.anthropic);
      if (parsed.openai) await keychainSet(KEY.openai, parsed.openai);
      if (parsed.google) await keychainSet(KEY.google, parsed.google);
      if (parsed.openrouter) await keychainSet(KEY.openrouter, parsed.openrouter);
      localStorage.removeItem(OLD_API);
    }
  } catch (e) {
    console.warn("[keys] api migration failed:", e);
  }
  try {
    const rawService = localStorage.getItem(OLD_SERVICE);
    if (rawService) {
      const parsed = JSON.parse(rawService) as ServiceKeys;
      if (parsed.tavily) await keychainSet(KEY.tavily, parsed.tavily);
      localStorage.removeItem(OLD_SERVICE);
    }
  } catch (e) {
    console.warn("[keys] service migration failed:", e);
  }
}

/** Migrate legacy localStorage state into the keychain (once), then
 *  load every credential into the store. Call from main.tsx after
 *  createRoot but before the first user turn. */
export async function hydrateKeychain(): Promise<void> {
  await migrateLocalStorageKeys();
  const { apiKeys, serviceKeys } = await fetchAllFromKeychain();
  useStore.setState({ apiKeys, serviceKeys });
}

export type Viewport = {
  path: string;
  scrollRatio?: number;
  visibleText?: string;
  page?: number;
  totalPages?: number;
  pageText?: string;
};

type State = {
  vaultPath: string | null;
  files: FileEntry[];
  currentFile: string | null;
  currentContent: string;
  panes: Pane[];
  splitDirection: SplitDirection;
  activePaneId: string | null;
  messages: ChatMessage[];
  apiKeys: ApiKeys;
  serviceKeys: ServiceKeys;
  theme: Theme;
  // The box's X-Vault-Token (same contract as the phone). Empty = none.
  boxToken: string;
  skills: Skill[];
  busy: boolean;
  showSettings: boolean;
  mode: "view" | "edit";
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  popoutOpen: boolean;
  // Ctrl+Shift+F toggles a borderless fullscreen mode where the chat
  // pane covers the entire window — no titlebar, no file tree, no
  // viewer. Same toggle exits. Not persisted; resets on app start.
  chatFullscreen: boolean;
  // Fullscreen chat's left sidebar (the conversations, like Claude Code
  // desktop / Codex). Ctrl+B or its toggle; remembered across launches.
  chatSidebarOpen: boolean;
  // Resets to false on app start — never persisted.
  voiceMode: boolean;
  // Always-on: the active document and viewport are sent as context
  // with every voice contextual update and chat message. No UI toggle;
  // kept as a flag for code-level reasoning and future override.
  followAlong: boolean;
  // Live status flags driven by the voice modules — used by the
  // VoiceCockpit to derive its status label. Both reset on voice
  // mode off.
  voiceListening: boolean;
  voiceSpeaking: boolean;
  // True in the gap between the user finishing a turn and the agent's
  // TTS audio actually starting — the "agent is thinking" window.
  // ElevenLabs doesn't expose a dedicated processing mode, so we set
  // this on `listening → !listening` and clear it once output audio
  // amplitude crosses a threshold (or speaking ends). Drives the
  // cockpit's sine-wave visualizer during the otherwise-silent gap.
  voiceThinking: boolean;
  // The voice session's mic is muted (the fullscreen voice bar's mute, the
  // typed-reply panel). Set by setVoiceMicMuted; cleared when the session ends.
  voiceMicMuted: boolean;
  // The last voice failure (start or mid-session), shown as red waves by the
  // composer's mic until the next start attempt or a successful connect.
  voiceError: string | null;
  // A plain word about voice that isn't a failure ("Voice moved to iPad": another device took the call over).
  voiceNotice: string | null;
  // True between mic-click and the ElevenLabs session reporting ready
  // — covers agent provisioning, signed-URL fetch, and the WebRTC
  // handshake. The cockpit shows "Connecting…" during this window.
  voiceConnecting: boolean;
  // Name of the client tool the ElevenLabs agent is currently
  // executing, or null when no tool is in flight. Drives the
  // cockpit's "Running <Tool>…" label during voice mode. Distinct
  // from `liveTools` (which is the chat-controller's text-mode
  // tool stream — these two pipelines don't overlap).
  voiceCurrentTool: string | null;
  // What the user is currently looking at. Updated by each viewer on
  // scroll. Voice mode's follow-along preamble uses this to send the
  // visible portion of the active document, not the whole file —
  // so "what does this say?" answers about the part you can see.
  viewport: Viewport | null;
  lastContext: number;
  // When the active conversation's run started (ms). Drives the elapsed
  // timer off real run start instead of component mount, so the timer
  // keeps counting correctly across a leave/return. null when idle.
  busyStartedAt: number | null;
  streamingText: string;
  streamingReasoning: string;
  liveTools: LiveTool[];
  // Per-conversation live-run buffer. A run that's backgrounded (the user
  // switched away from it) keeps writing its streaming text / reasoning /
  // live tools here keyed by conversation id, and the global streaming
  // view is snapshotted here on leave + rehydrated from here on return —
  // so leaving and coming back to a running thread shows the same live
  // progress you'd see if you'd stayed. Not persisted to disk.
  convRuntime: Record<string, ConvRuntime>;
  notes: Note[];
  notesLoaded: boolean;
  showNotesPanel: boolean;
  // When set, a viewer should scroll to this anchor inside the
  // given path once it's ready. Consumed + cleared by the viewer.
  pendingScrollAnchor: { path: string; anchor: string } | null;
  // Most recent marquee / selection captured by any viewer. Ctrl+N
  // reads this to pre-seed a note with the last region the user
  // pointed at. Cleared on use or after a short idle window.
  lastCapture: {
    path: string;
    source_anchor: string | null;
    selection: string | null;
    imageDataUrl: string | null;
    timestamp: number;
  } | null;
  // When the NotePopup's "Capture region" button is clicked we hide
  // the popup, let the user draw a marquee, then reopen with the
  // image attached. This flag tells viewers to divert their marquee
  // output into the composer instead of opening InlineEditPrompt.
  noteCapturePending: boolean;
  // Same pattern for the InlineEditPrompt ask/edit modes when the
  // user wants to inject a marquee as extra context mid-conversation.
  editPromptCapturePending: boolean;
  // Result of a Capture inside the popover. Carries the image and
  // the source location so the agent turn can cite it ("image from
  // paper.pdf page 3") rather than receiving a naked image.
  editPromptLastCapture: {
    imageDataUrl: string;
    sourcePath: string;
    sourceAnchor: string | null;
  } | null;
  // Same pattern for the main chat pane's Capture button.
  chatPaneCapturePending: boolean;
  chatPaneLastCapture: {
    imageDataUrl: string;
    sourcePath: string;
    sourceAnchor: string | null;
  } | null;
  // Voice mode's typed-input panel: a floating popup that lets the
  // user reply by text instead of speaking aloud (libraries, commute,
  // etc.). Open ⇒ mic is muted; submitting sends a user turn into the
  // live ElevenLabs session and the agent replies with TTS as normal.
  voiceTextPanelOpen: boolean;
  // Marquee capture routing for the voice text panel — same pattern as
  // chatPaneCapturePending / chatPaneLastCapture so we don't fight the
  // ChatPane for the same capture queue while voice mode is on.
  voiceCapturePending: boolean;
  voiceLastCapture: {
    imageDataUrl: string;
    sourcePath: string;
    sourceAnchor: string | null;
  } | null;
  // Current selection inside any code / monaco editor in the app.
  // Ctrl+N prefers this over window.getSelection() because
  // Monaco's selection lives outside the native browser selection
  // API, so window.getSelection() returns empty when the editor
  // has focus.
  editorSelection: {
    path: string;
    text: string;
    lineStart: number;
    lineEnd: number;
  } | null;
  noteComposer: {
    open: boolean;
    initialDraft?: string;
    initialAnchors?: import("./notes").NoteAnchor[];
    initialTurns?: import("./notes").NoteTurn[];
  };
  // Multi-chat inbox (piece #1). Persisted per-vault to
  // <vault>/.vault-chat/conversations.jsonl. The active conversation's
  // messages mirror the top-level `messages` field — switching
  // conversations swaps `messages` in/out of the active entry.
  conversations: Conversation[];
  activeConversationId: string | null;
  conversationsLoaded: boolean;
  // [phase 2] Box mode: the open vault's chat runs on the box (boxChat.ts).
  // null = not box mode.
  boxChat: import("./boxChat").BoxChatState | null;
  showChatsPanel: boolean;

  // Git repo root for the currently-open file. When the file lives inside a
  // nested sub-repo (e.g. `DeepDL/bitnet-repro/notes.md`) this is that
  // sub-repo's root, not vaultPath. Falls back to vaultPath when the file is
  // not in a sub-repo. Null until a file is opened.
  repoRoot: string | null;

  setVault: (p: string) => void;
  setFiles: (f: FileEntry[]) => void;
  applyDeleteCascade: (paths: string[]) => Promise<void>;
  applyRenameCascade: (moves: { from: string; to: string }[]) => Promise<void>;
  setCurrentFile: (p: string | null, content: string) => void;
  reloadCurrent: (path: string, content: string) => void;
  splitWith: (path: string, content: string, side: DropSide) => void;
  setPaneFile: (paneId: string, path: string, content: string) => void;
  closePane: (paneId: string) => void;
  setActivePane: (paneId: string) => void;
  updatePaneContent: (paneId: string, content: string) => void;
  rearrangePanes: (draggedId: string, targetId: string, side: DropSide) => void;
  placeFileAtEdge: (path: string, content: string, side: DropSide) => void;
  appendMessage: (m: ChatMessage) => void;
  setApiKey: (p: ProviderId, k: string) => void;
  clearApiKey: (p: ProviderId) => void;
  setServiceKey: (name: keyof ServiceKeys, k: string) => void;
  clearServiceKey: (name: keyof ServiceKeys) => void;
  setTheme: (t: Theme) => void;
  applyThemeFromEvent: (t: Theme) => void;
  setBoxToken: (token: string) => void;
  setSkills: (s: Skill[]) => void;
  setBusy: (b: boolean) => void;
  setShowSettings: (b: boolean) => void;
  setMode: (m: "view" | "edit") => void;
  toggleMode: () => void;
  togglePaneMode: (paneId: string) => void;
  toggleLeft: () => void;
  toggleRight: () => void;
  setPopoutOpen: (b: boolean) => void;
  toggleChatFullscreen: () => void;
  toggleChatSidebar: () => void;
  toggleVoiceMode: () => void;
  toggleFollowAlong: () => void;
  setVoiceListening: (b: boolean) => void;
  setVoiceSpeaking: (b: boolean) => void;
  setVoiceThinking: (b: boolean) => void;
  setVoiceConnecting: (b: boolean) => void;
  setVoiceCurrentTool: (name: string | null) => void;
  setViewport: (v: Viewport | null) => void;
  loadNotes: () => Promise<void>;
  addNote: (note: Note) => Promise<void>;
  deleteNote: (id: string) => Promise<void>;
  setNoteStatus: (id: string, status: "open" | "resolved") => Promise<void>;
  clearResolvedNotes: () => Promise<void>;
  reformatNote: (id: string) => Promise<void>;
  setShowNotesPanel: (b: boolean) => void;
  requestScrollAnchor: (path: string, anchor: string) => void;
  clearScrollAnchor: () => void;
  setLastCapture: (cap: State["lastCapture"]) => void;
  clearLastCapture: () => void;
  stashNoteForCapture: (payload: {
    draft: string;
    anchors: import("./notes").NoteAnchor[];
    turns: import("./notes").NoteTurn[];
  }) => void;
  setNoteCapturePending: (b: boolean) => void;
  setEditPromptCapturePending: (b: boolean) => void;
  setEditPromptLastCapture: (cap: State["editPromptLastCapture"]) => void;
  setChatPaneCapturePending: (b: boolean) => void;
  setChatPaneLastCapture: (cap: State["chatPaneLastCapture"]) => void;
  setVoiceTextPanelOpen: (b: boolean) => void;
  setVoiceCapturePending: (b: boolean) => void;
  setVoiceLastCapture: (cap: State["voiceLastCapture"]) => void;
  setEditorSelection: (sel: State["editorSelection"]) => void;
  openNoteComposer: (payload?: {
    initialDraft?: string;
    initialAnchors?: import("./notes").NoteAnchor[];
    initialTurns?: import("./notes").NoteTurn[];
  }) => void;
  closeNoteComposer: () => void;
  applyChatState: (s: {
    vaultPath: string | null;
    messages: ChatMessage[];
    lastContext?: number;
    currentFile?: string | null;
    panePaths?: string[];
    files?: FileEntry[];
    // The chats list and which one is open (the popout's sidebar and title),
    // the list without each chat's messages — the open one's come as messages.
    conversations?: Conversation[];
    activeConversationId?: string | null;
    // Voice runs in the main window; the popout's mic and waves show it.
    voice?: Pick<State, "voiceMode" | "voiceConnecting" | "voiceSpeaking" | "voiceListening" | "voiceMicMuted" | "voiceError">;
    // The chat runs on main's box: the popout's composer follows its state.
    boxChat?: State["boxChat"];
  }) => void;
  applyChatStream: (s: {
    busy: boolean;
    streamingText?: string;
    streamingReasoning?: string;
    liveTools?: LiveTool[];
    agentTodos?: TodoItem[];
  }) => void;
  loadConversations: () => Promise<void>;
  /** `id`: the chat popout picks the id and the main window creates it. */
  newConversation: (id?: string) => string;
  selectConversation: (id: string) => void;
  // Resolves once the durable on-disk tombstone write has settled. The
  // in-memory removal is always synchronous (desktop UI stays optimistic), so
  // most callers can ignore the promise. AWAIT it only when a follow-up DISK
  // read must not race the write — the phone reloads its Activity/Chats list
  // straight after a delete and would otherwise re-read a not-yet-tombstoned
  // thread and flicker it back.
  deleteConversation: (id: string) => Promise<void>;
  setShowChatsPanel: (b: boolean) => void;
  setBoxChat: (b: import("./boxChat").BoxChatState | null) => void;
  // The box created a conversation the laptop had opened locally under another
  // id: move it (list entry, active pointer, runtime) to the box's id.
  rekeyConversation: (from: string, to: string) => void;
  // Bulk-clear the unread badge on every conversation. unread is a synced
  // boolean; setting all false is harmless + idempotent. Persisted via the
  // standard subscribe-driven, conv-lock-guarded merge (never shrinks history,
  // never resurrects tombstones).
  markAllRead: () => void;
};

// The git-synced load behind loadConversations (moved out so box mode can
// start after it whatever path it returns by).
export const useStore = create<State>((set) => ({
  // [harness-loop rig — DEV only, prod ignores VITE_DEV_VAULT] Boot straight
  // into a chosen active vault so the local rig has a deterministic vaultPath
  // (needed for app-log flushing + the cockpit) without clicking the OS picker.
  vaultPath:
    localStorage.getItem(VAULT_STORAGE) ||
    (import.meta.env.DEV
      ? ((import.meta.env as unknown as Record<string, string | undefined>).VITE_DEV_VAULT ?? null)
      : null),
  files: [],
  currentFile: null,
  currentContent: "",
  panes: [],
  splitDirection: null,
  activePaneId: null,
  messages: [],
  apiKeys: {}, // populated async via hydrateKeychain
  serviceKeys: {}, // populated async via hydrateKeychain
  theme: loadTheme(),
  boxToken: localStorage.getItem(BOX_TOKEN_STORAGE) ?? "",
  skills: [],
  busy: false,
  showSettings: false,
  mode: "view",
  leftCollapsed: false,
  rightCollapsed: true,
  popoutOpen: false,
  chatFullscreen: false,
  chatSidebarOpen: readChatSidebarOpen(),
  voiceMode: false,
  followAlong: true,
  voiceListening: false,
  voiceSpeaking: false,
  voiceThinking: false,
  voiceConnecting: false,
  voiceCurrentTool: null,
  voiceMicMuted: false,
  voiceError: null,
  voiceNotice: null,
  viewport: null,
  lastContext: 0,
  busyStartedAt: null,
  streamingText: "",
  streamingReasoning: "",
  liveTools: [],
  convRuntime: {},
  notes: [],
  notesLoaded: false,
  showNotesPanel: false,
  pendingScrollAnchor: null,
  lastCapture: null,
  noteCapturePending: false,
  editPromptCapturePending: false,
  editPromptLastCapture: null,
  chatPaneCapturePending: false,
  chatPaneLastCapture: null,
  voiceTextPanelOpen: false,
  voiceCapturePending: false,
  voiceLastCapture: null,
  editorSelection: null,
  noteComposer: { open: false },
  conversations: [],
  activeConversationId: null,
  conversationsLoaded: false,
  boxChat: null,
  showChatsPanel: false,
  repoRoot: null,

  setVault: (p) =>
    set((s) => {
      localStorage.setItem(VAULT_STORAGE, p);
      // Switching vaults drops the chat — the prior conversation's
      // file context no longer applies. Staying on the same vault
      // leaves the chat untouched.
      if (s.vaultPath === p) {
        return { vaultPath: p };
      }
      // Open files / panes are tied to the prior vault. Leaving them
      // up after the switch would point at paths that don't exist in
      // the new vault, breaking save and reload.
      return {
        vaultPath: p,
        messages: [],
        lastContext: 0,
        streamingText: "",
        streamingReasoning: "",
        liveTools: [],
        agentTodos: [],
        notes: [],
        notesLoaded: false,
        conversations: [],
        activeConversationId: null,
        conversationsLoaded: false,
        boxChat: null,
        showChatsPanel: false,
        currentFile: null,
        currentContent: "",
        panes: [],
        splitDirection: null,
        activePaneId: null,
      };
    }),
  setFiles: (f) => set({ files: f }),
  // Cascade store cleanup after a filesystem delete. Closes panes
  // pointing at the removed paths, clears currentFile if it dies,
  // strips note anchors that reference deleted paths, and drops
  // notes that become empty (no surviving anchors, draft, or turns).
  // Caller is responsible for the on-disk delete and for pruning the
  // ignore file via remove_prefix_from_ignore.
  applyDeleteCascade: async (paths) => {
    if (paths.length === 0) return;
    const isUnder = (p: string): boolean => {
      for (const d of paths) {
        if (p === d || p.startsWith(d + "/")) return true;
      }
      return false;
    };
    const state = useStore.getState();
    const panesAfter = state.panes.filter((pn) => !isUnder(pn.file));
    const panesChanged = panesAfter.length !== state.panes.length;
    let updatedNotes = state.notes;
    let notesChanged = false;
    if (state.notes.length > 0) {
      const next: Note[] = [];
      for (const n of state.notes) {
        const filtered = n.anchors.filter((a) => !isUnder(a.source_path));
        if (filtered.length === n.anchors.length) {
          next.push(n);
          continue;
        }
        notesChanged = true;
        const isEmpty =
          filtered.length === 0 &&
          n.turns.length === 0 &&
          (!n.user_draft || n.user_draft.trim() === "");
        if (isEmpty) continue;
        const promoted = filtered.map((a, i) => ({ ...a, primary: i === 0 }));
        next.push({
          ...n,
          anchors: promoted,
          last_updated: new Date().toISOString(),
        });
      }
      if (notesChanged) updatedNotes = next;
    }
    const patch: Partial<State> = {};
    if (panesChanged) {
      if (panesAfter.length === 0) {
        patch.panes = [];
        patch.splitDirection = null;
        patch.activePaneId = null;
      } else if (panesAfter.length === 1) {
        // Collapse back to single-pane mode. Leaving panes=[one] with
        // splitDirection still set leaves the app in an inconsistent
        // state: UI sees panes.length > 0 and thinks you're still
        // split (so split actions are gated off), and setCurrentFile
        // replaces the file in the lone surviving pane instead of
        // opening a new split. The single-pane invariant is panes=[]
        // + currentFile set, so collapse to that.
        const survivor = panesAfter[0];
        patch.panes = [];
        patch.splitDirection = null;
        patch.activePaneId = null;
        patch.currentFile = survivor.file;
        patch.currentContent = survivor.content;
      } else {
        patch.panes = panesAfter;
        const stillActive = panesAfter.some((p) => p.id === state.activePaneId);
        patch.activePaneId = stillActive ? state.activePaneId : panesAfter[0].id;
      }
    }
    if (state.currentFile && isUnder(state.currentFile)) {
      const survivor = panesChanged ? panesAfter[0] : state.panes[0];
      if (survivor) {
        patch.currentFile = survivor.file;
        patch.currentContent = survivor.content;
      } else {
        patch.currentFile = null;
        patch.currentContent = "";
      }
    }
    if (notesChanged) patch.notes = updatedNotes;
    if (Object.keys(patch).length > 0) set(patch);
    if (notesChanged && state.vaultPath) {
      try {
        await writeAllNotes(state.vaultPath, updatedNotes);
      } catch (e) {
        console.error("[delete-cascade] persist notes failed:", e);
      }
    }
  },
  // Cascade store cleanup after a rename or move. Rewrites pane file
  // paths, currentFile, and note anchor source_paths whose value
  // matches m.from exactly or sits beneath it. Caller handles the
  // on-disk rename and ignore-file rewrite.
  applyRenameCascade: async (moves) => {
    if (moves.length === 0) return;
    const rewrite = (p: string): string => {
      for (const m of moves) {
        if (p === m.from) return m.to;
        if (p.startsWith(m.from + "/")) return m.to + p.slice(m.from.length);
      }
      return p;
    };
    const state = useStore.getState();
    let panesChanged = false;
    const panesAfter = state.panes.map((pn) => {
      const next = rewrite(pn.file);
      if (next === pn.file) return pn;
      panesChanged = true;
      return { ...pn, file: next };
    });
    let currentChanged = false;
    let nextCurrent = state.currentFile;
    if (nextCurrent) {
      const r = rewrite(nextCurrent);
      if (r !== nextCurrent) {
        nextCurrent = r;
        currentChanged = true;
      }
    }
    let notesChanged = false;
    const updatedNotes = state.notes.map((n) => {
      let anchorsChanged = false;
      const newAnchors = n.anchors.map((a) => {
        const r = rewrite(a.source_path);
        if (r === a.source_path) return a;
        anchorsChanged = true;
        return { ...a, source_path: r };
      });
      if (!anchorsChanged) return n;
      notesChanged = true;
      return {
        ...n,
        anchors: newAnchors,
        last_updated: new Date().toISOString(),
      };
    });
    const patch: Partial<State> = {};
    if (panesChanged) patch.panes = panesAfter;
    if (currentChanged) patch.currentFile = nextCurrent;
    if (notesChanged) patch.notes = updatedNotes;
    if (Object.keys(patch).length > 0) set(patch);
    if (notesChanged && state.vaultPath) {
      try {
        await writeAllNotes(state.vaultPath, updatedNotes);
      } catch (e) {
        console.error("[rename-cascade] persist notes failed:", e);
      }
    }
  },
  setCurrentFile: (p, content) => {
    set((s) => {
      if (s.panes.length > 0 && s.activePaneId && p) {
        const panes = s.panes.map((pane) =>
          pane.id === s.activePaneId ? { ...pane, file: p, content } : pane,
        );
        return { panes, currentFile: p, currentContent: content, viewport: null };
      }
      return { currentFile: p, currentContent: content, panes: [], splitDirection: null, activePaneId: null, viewport: null };
    });
    // Async: resolve which git repo root owns this file, then update
    // repoRoot. Fire-and-forget — the sync state update above is
    // instantaneous; repoRoot catches up on the next microtask.
    const vault = useStore.getState().vaultPath;
    if (p && vault) {
      invoke<string | null>("git_repo_root_for_file", { vault, path: p })
        .then((root) => {
          set({ repoRoot: root ?? vault });
        })
        .catch(() => {
          set({ repoRoot: vault });
        });
    } else {
      set({ repoRoot: vault });
    }
  },
  reloadCurrent: (path, content) =>
    set((s) => {
      // Path-guarded: only apply the content if the view still shows
      // `path`. A reload can land late (e.g. the agent finishes writing
      // file A just after the user switched to file B); without this
      // guard reloadCurrent would write A's text into B's view — the
      // transient "wrong file's content flashes up" bug.
      if (!path) return {};
      const norm = (p: string) => p.replace(/\\/g, "/");
      const want = norm(path);
      if (s.panes.length > 0 && s.activePaneId) {
        const active = s.panes.find((p) => p.id === s.activePaneId);
        if (!active || norm(active.file) !== want) return {};
        const panes = s.panes.map((pane) =>
          pane.id === s.activePaneId ? { ...pane, content } : pane,
        );
        return { panes, currentContent: content };
      }
      if (!s.currentFile || norm(s.currentFile) !== want) return {};
      return { currentContent: content };
    }),
  splitWith: (path, content, side) =>
    set((s) => {
      const existingFile = s.currentFile;
      const existingContent = s.currentContent;
      if (!existingFile) {
        return { currentFile: path, currentContent: content };
      }
      const direction: SplitDirection = side === "left" || side === "right" ? "horizontal" : "vertical";
      // Splitting inherits the global mode for both panes — that's
      // the user's last choice. Per-pane toggle takes over from there.
      const newPane: Pane = { id: newPaneId(), file: path, content, mode: s.mode };
      const existingPane: Pane = { id: newPaneId(), file: existingFile, content: existingContent, mode: s.mode };
      const panes =
        side === "left" || side === "top" ? [newPane, existingPane] : [existingPane, newPane];
      return {
        panes,
        splitDirection: direction,
        activePaneId: newPane.id,
        currentFile: path,
        currentContent: content,
      };
    }),
  setPaneFile: (paneId, path, content) =>
    set((s) => {
      const panes = s.panes.map((p) => (p.id === paneId ? { ...p, file: path, content } : p));
      const isActive = paneId === s.activePaneId;
      return isActive
        ? { panes, currentFile: path, currentContent: content }
        : { panes };
    }),
  closePane: (paneId) =>
    set((s) => {
      const remaining = s.panes.filter((p) => p.id !== paneId);
      if (remaining.length <= 1) {
        const survivor = remaining[0];
        if (survivor) {
          return {
            panes: [],
            splitDirection: null,
            activePaneId: null,
            currentFile: survivor.file,
            currentContent: survivor.content,
          };
        }
        return { panes: [], splitDirection: null, activePaneId: null };
      }
      const newActive = remaining[0].id;
      return {
        panes: remaining,
        activePaneId: newActive,
        currentFile: remaining[0].file,
        currentContent: remaining[0].content,
      };
    }),
  setActivePane: (paneId) =>
    set((s) => {
      const pane = s.panes.find((p) => p.id === paneId);
      if (!pane) return {};
      return {
        activePaneId: paneId,
        currentFile: pane.file,
        currentContent: pane.content,
      };
    }),
  updatePaneContent: (paneId, content) =>
    set((s) => {
      const panes = s.panes.map((p) => (p.id === paneId ? { ...p, content } : p));
      const isActive = paneId === s.activePaneId;
      return isActive ? { panes, currentContent: content } : { panes };
    }),
  rearrangePanes: (draggedId, targetId, side) =>
    set((s) => {
      if (draggedId === targetId) return {};
      const dragged = s.panes.find((p) => p.id === draggedId);
      const target = s.panes.find((p) => p.id === targetId);
      if (!dragged || !target) return {};
      const direction: SplitDirection =
        side === "left" || side === "right" ? "horizontal" : "vertical";
      const panes =
        side === "left" || side === "top" ? [dragged, target] : [target, dragged];
      return { panes, splitDirection: direction };
    }),
  placeFileAtEdge: (path, content, side) =>
    set((s) => {
      const newDirection: SplitDirection =
        side === "left" || side === "right" ? "horizontal" : "vertical";

      if (!s.currentFile && s.panes.length === 0) {
        return { currentFile: path, currentContent: content };
      }

      if (s.panes.length === 0) {
        const newPane: Pane = { id: newPaneId(), file: path, content, mode: s.mode };
        const existingPane: Pane = {
          id: newPaneId(),
          file: s.currentFile!,
          content: s.currentContent,
          mode: s.mode,
        };
        const panes =
          side === "left" || side === "top" ? [newPane, existingPane] : [existingPane, newPane];
        return {
          panes,
          splitDirection: newDirection,
          activePaneId: newPane.id,
          currentFile: path,
          currentContent: content,
        };
      }

      if (newDirection === s.splitDirection) {
        const edgeIndex = side === "left" || side === "top" ? 0 : 1;
        const target = s.panes[edgeIndex];
        const panes = s.panes.map((p) =>
          p.id === target.id ? { ...p, file: path, content } : p,
        );
        return {
          panes,
          activePaneId: target.id,
          currentFile: path,
          currentContent: content,
        };
      }

      const activeIdx = s.panes.findIndex((p) => p.id === s.activePaneId);
      const keep = s.panes[activeIdx >= 0 ? activeIdx : 0];
      const newPane: Pane = { id: newPaneId(), file: path, content, mode: keep.mode };
      const panes =
        side === "left" || side === "top" ? [newPane, keep] : [keep, newPane];
      return {
        panes,
        splitDirection: newDirection,
        activePaneId: newPane.id,
        currentFile: path,
        currentContent: content,
      };
    }),
  appendMessage: (m) => set((s) => ({ messages: [...s.messages, withMid(m)] })),
  setApiKey: (p, k) => {
    set((s) => ({ apiKeys: { ...s.apiKeys, [p]: k } }));
    keychainSet(KEY[p], k).catch((e) =>
      console.error(`[keys] keychain set ${p} failed:`, e),
    );
  },
  clearApiKey: (p) => {
    set((s) => {
      const next = { ...s.apiKeys };
      delete next[p];
      return { apiKeys: next };
    });
    keychainDelete(KEY[p]).catch((e) =>
      console.error(`[keys] keychain delete ${p} failed:`, e),
    );
  },
  setServiceKey: (name, k) => {
    set((s) => ({ serviceKeys: { ...s.serviceKeys, [name]: k } }));
    const keyName =
      name === "tavily"
        ? KEY.tavily
        : name === "elevenlabs"
          ? KEY.elevenlabs
          : null;
    if (keyName) {
      keychainSet(keyName, k).catch((e) =>
        console.error(`[keys] keychain set ${name} failed:`, e),
      );
    }
  },
  clearServiceKey: (name) => {
    set((s) => {
      const next = { ...s.serviceKeys };
      delete next[name];
      return { serviceKeys: next };
    });
    const keyName =
      name === "tavily"
        ? KEY.tavily
        : name === "elevenlabs"
          ? KEY.elevenlabs
          : null;
    if (keyName) {
      keychainDelete(keyName).catch((e) =>
        console.error(`[keys] keychain delete ${name} failed:`, e),
      );
    }
  },
  setTheme: (t) => {
    localStorage.setItem(THEME_STORAGE, t);
    set({ theme: t });
    emit("theme:changed", t).catch(() => {});
  },
  applyThemeFromEvent: (t) => {
    localStorage.setItem(THEME_STORAGE, t);
    set({ theme: t });
  },
  setBoxToken: (token) => {
    const t = token.trim();
    localStorage.setItem(BOX_TOKEN_STORAGE, t);
    set({ boxToken: t });
  },
  setSkills: (s) => set({ skills: s }),
  setBusy: (b) => set({ busy: b }),
  setShowSettings: (b) => set({ showSettings: b }),
  setMode: (m) => set({ mode: m }),
  toggleMode: () => set((s) => ({ mode: s.mode === "view" ? "edit" : "view" })),
  togglePaneMode: (paneId) =>
    set((s) => ({
      panes: s.panes.map((p) =>
        p.id === paneId ? { ...p, mode: p.mode === "view" ? "edit" : "view" } : p,
      ),
    })),
  toggleLeft: () => set((s) => ({ leftCollapsed: !s.leftCollapsed })),
  toggleRight: () =>
    // No-op while the chat is popped out — the right pane doesn't
    // render in that state, so flipping the collapsed flag would just
    // cause the chat to jump back in when the popout closes.
    set((s) => (s.popoutOpen ? s : { rightCollapsed: !s.rightCollapsed })),
  setPopoutOpen: (b) => set({ popoutOpen: b }),
  toggleChatFullscreen: () => set((s) => ({ chatFullscreen: !s.chatFullscreen })),
  toggleChatSidebar: () =>
    set((s) => {
      const next = !s.chatSidebarOpen;
      try {
        localStorage.setItem(CHAT_SIDEBAR_STORAGE, next ? "1" : "0");
      } catch {
        /* localStorage unavailable — the toggle still works this session */
      }
      return { chatSidebarOpen: next };
    }),
  toggleVoiceMode: () => set((s) => ({ voiceMode: !s.voiceMode })),
  toggleFollowAlong: () => set((s) => ({ followAlong: !s.followAlong })),
  setVoiceListening: (b) => set({ voiceListening: b }),
  setVoiceSpeaking: (b) => set({ voiceSpeaking: b }),
  setVoiceThinking: (b) => set({ voiceThinking: b }),
  setVoiceConnecting: (b) => set({ voiceConnecting: b }),
  setVoiceCurrentTool: (name) => set({ voiceCurrentTool: name }),
  setViewport: (v) => set({ viewport: v }),
  loadNotes: async () => {
    const vault = useStore.getState().vaultPath;
    if (!vault) return;
    try {
      const notes = await readNotes(vault);
      // Reverse-chron so newest is first in the panel.
      notes.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
      set({ notes, notesLoaded: true });
    } catch (e) {
      console.error("[notes] load failed:", e);
      set({ notes: [], notesLoaded: true });
    }
  },
  addNote: async (note) => {
    const vault = useStore.getState().vaultPath;
    if (!vault) return;
    try {
      await appendNote(vault, note);
      set((s) => ({ notes: [note, ...s.notes], notesLoaded: true }));
    } catch (e) {
      console.error("[notes] append failed:", e);
    }
  },
  deleteNote: async (id) => {
    const vault = useStore.getState().vaultPath;
    if (!vault) return;
    const next = useStore.getState().notes.filter((n) => n.id !== id);
    set({ notes: next });
    try {
      await writeAllNotes(vault, next);
    } catch (e) {
      console.error("[notes] delete failed:", e);
    }
  },
  setNoteStatus: async (id, status) => {
    const vault = useStore.getState().vaultPath;
    if (!vault) return;
    const now = new Date().toISOString();
    const next = useStore.getState().notes.map((n) =>
      n.id === id ? { ...n, status, last_updated: now } : n,
    );
    set({ notes: next });
    try {
      await writeAllNotes(vault, next);
    } catch (e) {
      console.error("[notes] status-update failed:", e);
    }
  },
  clearResolvedNotes: async () => {
    const vault = useStore.getState().vaultPath;
    if (!vault) return;
    // Flip resolved → cleared (a terminal status), do NOT drop the rows: notes.jsonl
    // is merge=union, so a row removed by omission here comes right back when another
    // machine's copy (which still has it) merges in — the schedule-tombstone trap.
    // Writing an explicit `cleared` row that outranks `resolved` (preferredNote)
    // makes the clear durable across the sync instead.
    const now = new Date().toISOString();
    const next = useStore.getState().notes.map((n) =>
      n.status === "resolved" ? { ...n, status: "cleared" as const, last_updated: now } : n,
    );
    set({ notes: next });
    try {
      await writeAllNotes(vault, next);
    } catch (e) {
      console.error("[notes] clear-resolved failed:", e);
    }
  },
  reformatNote: async (id) => {
    const state = useStore.getState();
    const vault = state.vaultPath;
    if (!vault) return;
    const note = state.notes.find((n) => n.id === id);
    if (!note) return;
    try {
      const formatted = await formatNote(note);
      // Write-first, then commit to memory, so a crash between steps
      // leaves either both (disk + memory) or neither — not a "memory
      // has summary, disk doesn't, restart nukes it" state.
      const updated = useStore
        .getState()
        .notes.map((n) =>
          n.id === id
            ? { ...n, formatted, last_updated: new Date().toISOString() }
            : n,
        );
      await writeAllNotes(vault, updated);
      set({ notes: updated });
    } catch (e) {
      console.error("[notes] reformat failed:", e);
    }
  },
  setShowNotesPanel: (b) =>
    set(b ? { showNotesPanel: true, showChatsPanel: false } : { showNotesPanel: false }),
  requestScrollAnchor: (path, anchor) => set({ pendingScrollAnchor: { path, anchor } }),
  clearScrollAnchor: () => set({ pendingScrollAnchor: null }),
  setLastCapture: (cap) => set({ lastCapture: cap }),
  clearLastCapture: () => set({ lastCapture: null }),
  stashNoteForCapture: (payload) =>
    set({
      noteComposer: {
        open: false,
        initialDraft: payload.draft,
        initialAnchors: payload.anchors,
        initialTurns: payload.turns,
      },
      noteCapturePending: true,
    }),
  setNoteCapturePending: (b) => set({ noteCapturePending: b }),
  setEditPromptCapturePending: (b) => set({ editPromptCapturePending: b }),
  setEditPromptLastCapture: (cap) => set({ editPromptLastCapture: cap }),
  setChatPaneCapturePending: (b) => set({ chatPaneCapturePending: b }),
  setChatPaneLastCapture: (cap) => set({ chatPaneLastCapture: cap }),
  setVoiceTextPanelOpen: (b) => set({ voiceTextPanelOpen: b }),
  setVoiceCapturePending: (b) => set({ voiceCapturePending: b }),
  setVoiceLastCapture: (cap) => set({ voiceLastCapture: cap }),
  setEditorSelection: (sel) => set({ editorSelection: sel }),
  openNoteComposer: (payload) =>
    set({
      noteComposer: {
        open: true,
        initialDraft: payload?.initialDraft,
        initialAnchors: payload?.initialAnchors,
        initialTurns: payload?.initialTurns,
      },
    }),
  closeNoteComposer: () => set({ noteComposer: { open: false } }),
  applyChatState: (s) =>
    set((prev) => {
      // Preserve existing messages reference if the incoming list is
      // content-equal — a fresh array from JSON.parse would otherwise
      // invalidate the messages selector and re-render every bubble.
      const nextMessages = messagesEqual(prev.messages, s.messages)
        ? prev.messages
        : s.messages;
      // Sync file / pane mirror so the popout's Capture gate can
      // decide whether marquee is possible in main's view.
      const nextPanes =
        s.panePaths !== undefined
          ? s.panePaths.map((p, i) => ({
              id: prev.panes[i]?.id ?? `popout-${i}`,
              file: p,
              content: "",
              mode: prev.panes[i]?.mode ?? ("view" as const),
            }))
          : prev.panes;
      return {
        vaultPath: s.vaultPath,
        messages: nextMessages,
        lastContext: s.lastContext ?? prev.lastContext,
        currentFile: s.currentFile !== undefined ? s.currentFile : prev.currentFile,
        panes: nextPanes,
        files: s.files ?? prev.files,
        ...(s.conversations ? { conversations: s.conversations } : {}),
        ...(s.activeConversationId !== undefined ? { activeConversationId: s.activeConversationId } : {}),
        ...(s.voice ?? {}),
        ...(s.boxChat !== undefined ? { boxChat: s.boxChat } : {}),
      };
    }),
  applyChatStream: (s) =>
    set((prev) => {
      const incomingTools = s.liveTools ?? [];
      return {
        busy: s.busy,
        streamingText: s.streamingText ?? "",
        streamingReasoning: s.streamingReasoning ?? "",
        liveTools: liveToolsEqual(prev.liveTools, incomingTools) ? prev.liveTools : incomingTools,
      };
    }),
  loadConversations: async () => {
    const vault = useStore.getState().vaultPath;
    if (!vault) return;
    // The conversations are the box's event log, never files on this disk
    // (src/boxChat.ts fills the list from the box, or from its cache). No box:
    // no chat, and the pane says so.
    const bc = await import("./boxChat");
    if (!(await bc.boxLinkFor(vault).catch(() => null))) {
      if (useStore.getState().vaultPath !== vault) return;
      useStore.setState({ boxChat: { on: false, reachable: null, reason: "" }, conversations: [], activeConversationId: null, conversationsLoaded: true, messages: [], streamingText: "", streamingReasoning: "", liveTools: [] });
      return;
    }
    // Its feed is already live (a second load): the list is the feed's, keep it.
    if (bc.boxChatOn()) {
      useStore.setState({ conversationsLoaded: true });
      return;
    }
    const fresh = emptyConversation();
    const saved = savedActiveConvId(vault);
    useStore.setState({
      boxChat: useStore.getState().boxChat?.on ? useStore.getState().boxChat : { on: true, reachable: null, reason: "" },
      conversations: saved ? [] : [fresh],
      activeConversationId: saved ?? fresh.id,
      conversationsLoaded: true,
      messages: [],
      streamingText: "",
      streamingReasoning: "",
      liveTools: [],
    });
    if (useStore.getState().vaultPath !== vault) return;
    void bc.startBoxChat(vault).catch((e) => console.warn("[box-chat] start failed:", e));
  },
  newConversation: (id) => {
    const fresh = id ? { ...emptyConversation(), id } : emptyConversation();
    set((s) => {
      // Snapshot whatever is in-flight into the prior active entry
      // before swapping.
      const synced = syncActiveMessages(s);
      return {
        conversations: [fresh, ...synced],
        // Preserve the leaving run's live view so returning to it shows
        // the same streaming progress, not a blank pane.
        convRuntime: snapshotRuntime(s),
        activeConversationId: fresh.id,
        // Fresh conversation is never mid-run; clear the global busy
        // flag even if the previous conversation's agent is still
        // running off-screen. The previous conversation's entry
        // already carries status="running" from syncActiveMessages.
        busy: false,
        busyStartedAt: null,
        messages: [],
        compactionSummary: null,
        lastContext: 0,
        tokenUsage: { prompt: 0, completion: 0, total: 0 },
        agentTodos: [],
        streamingText: "",
        streamingReasoning: "",
        liveTools: [],
      };
    });
    persistActiveConvId(useStore.getState().vaultPath, fresh.id);
    return fresh.id;
  },
  selectConversation: (id) =>
    set((s) => {
      // Remember this device's pick so app restart / a vault-sync reload keeps
      // it, instead of jumping to the most-recently-touched (phone) thread.
      persistActiveConvId(s.vaultPath, id);
      if (s.activeConversationId === id) {
        // Selecting the already-active chat is just a clear-unread.
        return {
          conversations: s.conversations.map((c) =>
            c.id === id ? { ...c, unread: false } : c,
          ),
        };
      }
      const target = s.conversations.find((c) => c.id === id);
      if (!target) return {};
      const synced = syncActiveMessages(s).map((c) =>
        // Bump lastActivityAt on open so a thread you OPEN — even a worker you
        // never message — pins to the top of the recent-conversations list
        // instead of sinking out of view until it gets a message. `surfaced`
        // marks it as viewed, so a mission/worker thread (hidden from the
        // phone's recent list by default) joins recent once you look at it.
        c.id === id ? { ...c, unread: false, lastActivityAt: Date.now(), surfaced: true } : c,
      );
      // Snapshot the leaving run's live view, then rehydrate the global
      // streaming view from the target's buffer if it has one in flight.
      const convRuntime = snapshotRuntime(s);
      const rt = convRuntime[id];
      return {
        conversations: synced,
        activeConversationId: id,
        messages: target.messages,
        convRuntime,
        // Global busy/streaming/tools view follows the conversation we
        // just landed on. If the target was mid-run when we switched away
        // earlier, it's still running in the background — re-arm the UI
        // and replay whatever it has streamed so far from its buffer, so
        // returning to a running thread looks exactly like never leaving.
        busy: target.status === "running",
        compactionSummary: null,
        // A chat reopened without a live run shows its last reported context
        // (from its newest assistant turn) instead of no dial at all.
        lastContext: rt?.lastContext || lastReportedContext(target.messages),
        tokenUsage: rt?.tokenUsage ?? { prompt: 0, completion: 0, total: 0 },
        agentTodos: rt?.agentTodos ?? [],
        busyStartedAt: target.status === "running" ? rt?.startedAt ?? null : null,
        streamingText: rt?.streamingText ?? "",
        streamingReasoning: rt?.streamingReasoning ?? "",
        liveTools: rt?.liveTools ?? [],
      };
    }),
  deleteConversation: (id): Promise<void> => {
    // Tombstone on disk — removing it from the in-memory list alone no longer
    // deletes anything (conversations_write_all never deletes by omission; see
    // the multi-machine flapping bug it caused). We fire the write and KEEP its
    // promise: the in-memory removal below is synchronous (so the desktop UI is
    // optimistic), but callers that immediately re-read from DISK — the phone
    // reloads Activity/Chats right after /kill — must await it, or that reload
    // races the not-yet-flushed tombstone and the deleted thread flickers back.
    const vault = useStore.getState().vaultPath;
    // Box mode: a delete is an intent to the box (a record in its log every client folds).
    const done = useStore.getState().boxChat?.on
      ? import("./boxChat").then((bc) => bc.boxDelete(id)).then(() => undefined, (e) => console.warn("[conversations] delete failed:", e))
      : vault
        ? invoke<void>("conversation_delete", { vault, id }).catch((e) => {
            console.warn("[conversations] delete failed:", e);
          })
        : Promise.resolve();
    set((s) => {
      const next = s.conversations.filter((c) => c.id !== id);
      if (s.activeConversationId !== id) {
        return { conversations: next };
      }
      // The active chat was just deleted — fall back to the most
      // recent surviving conversation, or seed a fresh empty one.
      if (next.length === 0) {
        const fresh = emptyConversation();
        return {
          conversations: [fresh],
          activeConversationId: fresh.id,
          messages: [],
          compactionSummary: null,
          lastContext: 0,
          tokenUsage: { prompt: 0, completion: 0, total: 0 },
          agentTodos: [],
          streamingText: "",
          streamingReasoning: "",
          liveTools: [],
        };
      }
      const sorted = next
        .slice()
        .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
      // Pick the most-recent thread as the new active one after a delete.
      const target = sorted[0];
      return {
        conversations: next,
        activeConversationId: target.id,
        messages: target.messages,
        compactionSummary: null,
        lastContext: lastReportedContext(target.messages),
        tokenUsage: { prompt: 0, completion: 0, total: 0 },
        agentTodos: [],
        streamingText: "",
        streamingReasoning: "",
        liveTools: [],
      };
    });
    return done;
  },
  setShowChatsPanel: (b) =>
    set(b ? { showChatsPanel: true, showNotesPanel: false } : { showChatsPanel: false }),
  markAllRead: () =>
    set((s) => {
      if (!s.conversations.some((c) => c.unread)) return {}; // no-op → no re-render / no write
      return {
        conversations: s.conversations.map((c) =>
          c.unread ? { ...c, unread: false } : c,
        ),
      };
    }),
  setBoxChat: (b) => set({ boxChat: b }),
  rekeyConversation: (from, to) => {
    if (from === to) return;
    set((s) => {
      const exists = s.conversations.some((c) => c.id === to);
      const conversations = exists
        ? s.conversations.filter((c) => c.id !== from)
        : s.conversations.map((c) => (c.id === from ? { ...c, id: to } : c));
      let convRuntime = s.convRuntime;
      if (from in convRuntime) {
        convRuntime = { ...convRuntime, [to]: convRuntime[from]! };
        delete convRuntime[from];
      }
      // The box's run may have streamed under its id before the rekey (its
      // events land in convRuntime while the chat is still the local id): the
      // open chat picks that up now instead of waiting for the next event.
      const rt = s.activeConversationId === from ? convRuntime[to] : undefined;
      if (rt) {
        convRuntime = { ...convRuntime };
        delete convRuntime[to];
      }
      return {
        conversations,
        convRuntime,
        ...(s.activeConversationId === from ? { activeConversationId: to } : {}),
        ...(rt
          ? {
              busy: true,
              streamingText: rt.streamingText || s.streamingText,
              streamingReasoning: rt.streamingReasoning || s.streamingReasoning,
              liveTools: rt.liveTools?.length ? rt.liveTools : s.liveTools,
            }
          : {}),
      };
    });
    if (useStore.getState().activeConversationId === to) {
      persistActiveConvId(useStore.getState().vaultPath, to);
    }
  },

}));

// Mirror the live `messages` / `busy` view back into the active
// conversation entry. Called from any action that swaps the active
// conversation so the about-to-be-replaced entry keeps its messages.
// Capture the active conversation's live streaming view into the
// per-conversation runtime buffer before we swap away from it, so a run
// that keeps going in the background can be replayed when the user
// returns. No-op unless the active conversation is mid-run.
function snapshotRuntime(s: State): Record<string, ConvRuntime> {
  if (!s.activeConversationId || !s.busy) return s.convRuntime;
  const prev = s.convRuntime[s.activeConversationId];
  return {
    ...s.convRuntime,
    [s.activeConversationId]: {
      ...prev,
      streamingText: s.streamingText,
      streamingReasoning: s.streamingReasoning,
      liveTools: s.liveTools,
      lastContext: s.lastContext,
      startedAt: s.busyStartedAt ?? prev?.startedAt,
    },
  };
}

function syncActiveMessages(s: State): Conversation[] {
  if (!s.activeConversationId) return s.conversations;
  return s.conversations.map((c) => {
    if (c.id !== s.activeConversationId) return c;
    const messagesChanged = c.messages !== s.messages;
    const nextTitle =
      c.title === "New chat" && s.messages.length > 0
        ? deriveConversationTitle(s.messages)
        : c.title;
    if (
      !messagesChanged &&
      nextTitle === c.title &&
      c.status === (s.busy ? "running" : "idle")
    ) {
      return c;
    }
    return {
      ...c,
      messages: s.messages,
      title: nextTitle,
      status: s.busy ? "running" : "idle",
      lastActivityAt: messagesChanged ? Date.now() : c.lastActivityAt,
    };
  });
}

let conversationsLastMessagesRef: ChatMessage[] | null = null;
let conversationsLastBusy = false;
let conversationsLastListRef: Conversation[] | null = null;
useStore.subscribe((state) => {
  // The chat popout shows main's list (sync.ts); main alone writes it.
  if (isPopout) return;
  if (!state.conversationsLoaded) return;
  const activeId = state.activeConversationId;
  const messagesChanged = state.messages !== conversationsLastMessagesRef;
  const busyChanged = state.busy !== conversationsLastBusy;
  const listChanged = state.conversations !== conversationsLastListRef;
  if (!messagesChanged && !busyChanged && !listChanged) return;
  conversationsLastMessagesRef = state.messages;
  conversationsLastBusy = state.busy;
  if (activeId && (messagesChanged || busyChanged)) {
    const synced = syncActiveMessages(state);
    if (synced !== state.conversations) {
      useStore.setState({ conversations: synced });
      conversationsLastListRef = synced;
      return;
    }
  }
  conversationsLastListRef = state.conversations;
});
