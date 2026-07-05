import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import type { ModelSpec, ProviderId } from "./providers";
import { DEFAULT_MODEL_ID, DEFAULT_WORKER_MODEL_ID, setLiveCatalog, setAutoRouterCostBias } from "./providers";
import type { Skill } from "./skills";
import type { Note } from "./notes";
import { readNotes, appendNote, writeAllNotes } from "./notes";
import {
  type Conversation,
  deriveConversationTitle,
  emptyConversation,
  readConversations,
  writeConversations,
  withConvLock,
  newMessageId,
} from "./conversations";

// Stamp a stable `mid` on a message at creation if it lacks one (release 1 of
// the message-identity cure). Idempotent: a message that already has a mid is
// returned unchanged, so re-appending a synced/replayed message never re-mints.
function withMid(m: ChatMessage): ChatMessage {
  return m.mid ? m : { ...m, mid: newMessageId() };
}
import { formatNote } from "./notes-format";
import { findModel } from "./providers";
import { keychainGet, keychainSet, keychainDelete, KEY } from "./keychain";
import {
  fetchAllCatalog,
  loadCatalogFromLocalStorage,
  saveCatalogToLocalStorage,
} from "./modelCatalog";

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
  toolCalls?: { id?: string; name: string; input: any; result?: string }[];
  system?: boolean;
  // Excluded from the UI but still sent to the agent. Used for inline-ask
  // context preambles that the user didn't type.
  hidden?: boolean;
  // Token usage reported by the model for this turn (assistant only).
  usage?: { prompt: number; completion: number; total: number; context: number };
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
  // This assistant turn ended in an error (model/SDK failure or a thrown
  // exception), not a clean finish. The completion path reads this so a crashed
  // worker reports "FAILED" instead of a false "done — completed its task".
  failed?: boolean;
  // Stable per-message id, minted at creation (release 1 of the message-identity
  // cure). Optional — legacy messages on disk lack it; readers must tolerate its
  // absence. INERT for now (no merge logic reads it yet); it just rides on disk
  // so it has propagated everywhere before a later release dedupes/merges by id.
  mid?: string;
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

export const MODEL_CONTEXT_LIMIT = 200_000;

export type LiveTool = { id: string; name: string; input: any; result?: string; startedAt?: number; inputChars?: number; etaSeconds?: number };

export type TodoStatus = "pending" | "in_progress" | "completed";
export type TodoItem = { content: string; status: TodoStatus; activeForm?: string };

// How hard reasoning models think before answering. Maps to the right
// per-provider knob in agent.ts (Anthropic effort, OpenAI/OpenRouter
// reasoning_effort, Gemini thinking budget). Default medium.
export type ReasoningEffort = "low" | "medium" | "high";

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

function todosEqual(a: TodoItem[], b: TodoItem[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].content !== b[i].content || a[i].status !== b[i].status) return false;
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

const MODEL_STORAGE = "vault_chat_model";
// Per-role model overrides. MODEL_STORAGE above is the chat-pane (desktop)
// model; voice has its own vault_chat_elevenlabs_llm. Each role's run reads its
// own model so e.g. workers can run a heavy model while the phone assistant
// stays cheap. Routed in sendMessage (by conversation source) + the worker /
// mission spawn paths.
const ASSISTANT_MODEL_STORAGE = "vault_chat_assistant_model";
const SUPERVISOR_MODEL_STORAGE = "vault_chat_supervisor_model";
const WORKER_MODEL_STORAGE = "vault_chat_worker_model";
const THEME_STORAGE = "vault_chat_theme";
const VAULT_STORAGE = "vault_chat_last_vault";
const CHAT_STORAGE = "vault_chat_history";
const STRICT_VAULT_STORAGE = "vault_chat_strict_vault";
const BASH_DISABLED_STORAGE = "vault_chat_bash_disabled";
const REASONING_EFFORT_STORAGE = "vault_chat_reasoning_effort";
const AUTO_COST_BIAS_STORAGE = "vault_chat_auto_cost_bias";
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
// Rolling buffer of the last few finalised conversations. Capped at
// SAVED_CHATS_MAX entries (newest first), shared across vaults — the
// UI filters to the active vault on display.
const SAVED_CHATS_STORAGE = "vault_chat_saved";
const SAVED_CHATS_MAX = 20;

export type Theme = "graphite" | "light";

// Streaming text from the agent arrives one token at a time — often
// many per frame. Re-rendering the chat pane on every token re-parses
// a growing markdown buffer through remark/rehype/katex/highlight,
// which freezes the UI thread ("(Not Responding)"). Buffer here and
// flush at ~5 Hz so React only repaints a few times per second while
// streaming. Anything higher than this overwhelms rehypeHighlight for
// long messages.
const STREAM_FLUSH_MS = 200;
let streamBuffer = "";
let streamFlushTimer: ReturnType<typeof setTimeout> | null = null;
function flushStreamBuffer() {
  streamFlushTimer = null;
  if (!streamBuffer) return;
  const chunk = streamBuffer;
  streamBuffer = "";
  useStore.setState((prev) => ({ streamingText: prev.streamingText + chunk }));
}
function cancelStreamFlush() {
  streamBuffer = "";
  if (streamFlushTimer !== null) {
    clearTimeout(streamFlushTimer);
    streamFlushTimer = null;
  }
}

let reasoningBuffer = "";
let reasoningFlushTimer: ReturnType<typeof setTimeout> | null = null;
function flushReasoningBuffer() {
  reasoningFlushTimer = null;
  if (!reasoningBuffer) return;
  const chunk = reasoningBuffer;
  reasoningBuffer = "";
  useStore.setState((prev) => ({ streamingReasoning: prev.streamingReasoning + chunk }));
}
function cancelReasoningFlush() {
  reasoningBuffer = "";
  if (reasoningFlushTimer !== null) {
    clearTimeout(reasoningFlushTimer);
    reasoningFlushTimer = null;
  }
}

function loadTheme(): Theme {
  const raw = localStorage.getItem(THEME_STORAGE);
  return raw === "light" ? "light" : "graphite";
}

// Both default to ON: safer-by-default for new installs. Existing users
// can opt back into wider access in Settings.
function loadBoolFlag(key: string, defaultValue: boolean): boolean {
  const raw = localStorage.getItem(key);
  if (raw === null) return defaultValue;
  return raw === "true";
}

function loadNumFlag(key: string, defaultValue: number): number {
  const raw = localStorage.getItem(key);
  if (raw === null) return defaultValue;
  const n = Number(raw);
  return Number.isFinite(n) ? n : defaultValue;
}

function loadReasoningEffort(): ReasoningEffort {
  const raw = localStorage.getItem(REASONING_EFFORT_STORAGE);
  if (raw === "low" || raw === "medium" || raw === "high") return raw;
  return "medium";
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
  // Seed the live model catalog from last session's cache so the
  // dropdown isn't empty on boot.
  const cached = loadCatalogFromLocalStorage();
  if (cached && cached.length > 0) {
    setLiveCatalog(cached);
    useStore.setState({ catalog: cached });
  } else if (Object.keys(apiKeys).length > 0) {
    // New install with keys already in the keychain (e.g. migrated):
    // kick off a background refresh so the dropdown populates.
    void useStore.getState().refreshCatalog();
  }
}

export type SavedChat = {
  id: string;
  vaultPath: string | null;
  // First user message (trimmed to 80 chars) — labels the entry in the
  // recents popover. Empty conversations are never saved so this is
  // always meaningful.
  title: string;
  savedAt: number;
  messages: ChatMessage[];
  compactionSummary: string | null;
  lastContext: number;
  tokenUsage: { prompt: number; completion: number; total: number };
};

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
  catalog: ModelSpec[];
  catalogRefreshing: boolean;
  catalogErrors: Partial<Record<ProviderId, string>>;
  modelId: string;
  assistantModelId: string;
  supervisorModelId: string;
  workerModelId: string;
  theme: Theme;
  // Restrict file-op tools (Read/Write/Edit/Delete/Glob/Grep/ListDir/
  // NotebookEdit/PdfExtract) to the active vault + meta vault. Bash is
  // not covered — it's a separate setting because real shell containment
  // needs OS sandboxing we don't have.
  strictVaultMode: boolean;
  // Don't expose the Bash tool to the agent at all.
  bashDisabled: boolean;
  // How hard reasoning-capable models think before answering.
  reasoningEffort: ReasoningEffort;
  // Cost ⇄ quality dial for OpenRouter's auto router (0 = quality … 10 =
  // cheapest). Applies when "Auto" resolves to openrouter/auto.
  autoRouterCostBias: number;
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
  tokenUsage: { prompt: number; completion: number; total: number };
  lastContext: number;
  // When the active conversation's run started (ms). Drives the elapsed
  // timer off real run start instead of component mount, so the timer
  // keeps counting correctly across a leave/return. null when idle.
  busyStartedAt: number | null;
  compactionSummary: string | null;
  compacting: boolean;
  streamingText: string;
  streamingReasoning: string;
  liveTools: LiveTool[];
  agentTodos: TodoItem[];
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
  showHistory: boolean;
  // Desktop Mission Control modal: Missions/Schedules/Notifications tabs,
  // opened from the titlebar's Rocket button.
  showMissionControl: boolean;
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
  // Rolling buffer of finished conversations, capped to the last
  // SAVED_CHATS_MAX. Auto-snapshotted whenever the user clears or
  // loads another saved chat. UI shows entries matching the current
  // vaultPath.
  savedChats: SavedChat[];
  // Multi-chat inbox (piece #1). Persisted per-vault to
  // <vault>/.vault-chat/conversations.jsonl. The active conversation's
  // messages mirror the top-level `messages` field — switching
  // conversations swaps `messages` in/out of the active entry.
  conversations: Conversation[];
  activeConversationId: string | null;
  conversationsLoaded: boolean;
  showChatsPanel: boolean;
  showSchedulesPanel: boolean;

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
  refreshCatalog: () => Promise<void>;
  setModelId: (id: string) => void;
  setAssistantModelId: (id: string) => void;
  setSupervisorModelId: (id: string) => void;
  setWorkerModelId: (id: string) => void;
  setTheme: (t: Theme) => void;
  applyThemeFromEvent: (t: Theme) => void;
  // Turning strict mode ON also flips bashDisabled ON (it's the matching
  // safer default — no point sandboxing file ops while leaving a shell
  // open that bypasses the guard). User can independently turn Bash back
  // on after, if they explicitly want shell + strict file ops.
  setStrictVaultMode: (b: boolean) => void;
  setAutoRouterCostBias: (n: number) => void;
  setBashDisabled: (b: boolean) => void;
  setReasoningEffort: (e: ReasoningEffort) => void;
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
  toggleVoiceMode: () => void;
  toggleFollowAlong: () => void;
  setVoiceListening: (b: boolean) => void;
  setVoiceSpeaking: (b: boolean) => void;
  setVoiceThinking: (b: boolean) => void;
  setVoiceConnecting: (b: boolean) => void;
  setVoiceCurrentTool: (name: string | null) => void;
  setViewport: (v: Viewport | null) => void;
  addTokenUsage: (u: { prompt: number; completion: number; total: number }) => void;
  setLastContext: (n: number) => void;
  setCompacting: (b: boolean) => void;
  applyCompaction: (summary: string, keepCount: number, banner: ChatMessage) => void;
  appendStreamingText: (s: string) => void;
  setStreamingText: (s: string) => void;
  appendStreamingReasoning: (s: string) => void;
  clearStreamingReasoning: () => void;
  pushLiveTool: (t: LiveTool) => void;
  startLiveToolInput: (id: string, name: string) => void;
  appendLiveToolInputDelta: (id: string, delta: string) => void;
  updateLiveToolResult: (id: string, result: string) => void;
  setLiveToolEta: (id: string, seconds: number) => void;
  setAgentTodos: (todos: TodoItem[]) => void;
  loadNotes: () => Promise<void>;
  addNote: (note: Note) => Promise<void>;
  deleteNote: (id: string) => Promise<void>;
  setNoteStatus: (id: string, status: "open" | "resolved") => Promise<void>;
  clearResolvedNotes: () => Promise<void>;
  reformatNote: (id: string) => Promise<void>;
  setShowNotesPanel: (b: boolean) => void;
  setShowHistory: (b: boolean) => void;
  setShowMissionControl: (b: boolean) => void;
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
  setConvRuntime: (id: string, rt: ConvRuntime) => void;
  clearConvRuntime: (id: string) => void;
  setBusyStartedAt: (t: number | null) => void;
  openNoteComposer: (payload?: {
    initialDraft?: string;
    initialAnchors?: import("./notes").NoteAnchor[];
    initialTurns?: import("./notes").NoteTurn[];
  }) => void;
  closeNoteComposer: () => void;
  resetStreaming: () => void;
  applyChatState: (s: {
    vaultPath: string | null;
    messages: ChatMessage[];
    modelId?: string;
    tokenUsage?: { prompt: number; completion: number; total: number };
    lastContext?: number;
    compactionSummary?: string | null;
    compacting?: boolean;
    currentFile?: string | null;
    panePaths?: string[];
    files?: FileEntry[];
  }) => void;
  saveCurrentChat: () => void;
  loadSavedChat: (id: string) => void;
  applyChatStream: (s: {
    busy: boolean;
    streamingText?: string;
    streamingReasoning?: string;
    liveTools?: LiveTool[];
    agentTodos?: TodoItem[];
  }) => void;
  clearMessages: () => void;
  loadConversations: () => Promise<void>;
  refreshConversationFromDisk: (vault: string, convId: string) => Promise<void>;
  refreshConversationsFromDisk: (vault: string) => Promise<void>;
  newConversation: () => string;
  selectConversation: (id: string) => void;
  // Resolves once the durable on-disk tombstone write has settled. The
  // in-memory removal is always synchronous (desktop UI stays optimistic), so
  // most callers can ignore the promise. AWAIT it only when a follow-up DISK
  // read must not race the write — the phone reloads its Activity/Chats list
  // straight after a delete and would otherwise re-read a not-yet-tombstoned
  // thread and flicker it back.
  deleteConversation: (id: string) => Promise<void>;
  setShowChatsPanel: (b: boolean) => void;
  setShowSchedulesPanel: (b: boolean) => void;
  // Off-screen-safe message append: writes directly to a specific
  // conversation's stored messages array, regardless of which one is
  // currently active. Used by chat-controller when a run finishes
  // after the user navigated away.
  appendMessageToConversation: (id: string, m: ChatMessage) => void;
  setConversationStatus: (id: string, status: "idle" | "running") => void;
  // Bulk-clear the unread badge on every conversation. unread is a synced
  // boolean; setting all false is harmless + idempotent. Persisted via the
  // standard subscribe-driven, conv-lock-guarded merge (never shrinks history,
  // never resurrects tombstones).
  markAllRead: () => void;
};

export const useStore = create<State>((set) => ({
  vaultPath: localStorage.getItem(VAULT_STORAGE),
  files: [],
  currentFile: null,
  currentContent: "",
  panes: [],
  splitDirection: null,
  activePaneId: null,
  messages: [],
  apiKeys: {}, // populated async via hydrateKeychain
  serviceKeys: {}, // populated async via hydrateKeychain
  catalog: loadCatalogFromLocalStorage() ?? [],
  catalogRefreshing: false,
  catalogErrors: {},
  // New installs default to the app's default model (Claude Sonnet 5). Anyone who
  // has already picked a model in the dropdown keeps it — switch via the model
  // picker to apply Sonnet 5 on an existing client.
  modelId: localStorage.getItem(MODEL_STORAGE) ?? DEFAULT_MODEL_ID,
  // The phone assistant (cockpit) is the hardest agentic surface — it has to
  // hold a multi-step orchestration prompt, drive tools, and emit structured
  // plan cards. Auto's cost router was picking models too weak for that
  // (sycophantic loops, lost context, ignored conventions), so default it to a
  // strong model — same tier as supervisors/workers — not the cheap router.
  assistantModelId: localStorage.getItem(ASSISTANT_MODEL_STORAGE) ?? DEFAULT_WORKER_MODEL_ID,
  supervisorModelId: localStorage.getItem(SUPERVISOR_MODEL_STORAGE) ?? DEFAULT_WORKER_MODEL_ID,
  workerModelId: localStorage.getItem(WORKER_MODEL_STORAGE) ?? DEFAULT_WORKER_MODEL_ID,
  theme: loadTheme(),
  strictVaultMode: loadBoolFlag(STRICT_VAULT_STORAGE, true),
  bashDisabled: loadBoolFlag(BASH_DISABLED_STORAGE, true),
  reasoningEffort: loadReasoningEffort(),
  autoRouterCostBias: loadNumFlag(AUTO_COST_BIAS_STORAGE, 7),
  skills: [],
  busy: false,
  showSettings: false,
  mode: "view",
  leftCollapsed: false,
  rightCollapsed: true,
  popoutOpen: false,
  chatFullscreen: false,
  voiceMode: false,
  followAlong: true,
  voiceListening: false,
  voiceSpeaking: false,
  voiceThinking: false,
  voiceConnecting: false,
  voiceCurrentTool: null,
  viewport: null,
  tokenUsage: { prompt: 0, completion: 0, total: 0 },
  lastContext: 0,
  busyStartedAt: null,
  compactionSummary: null,
  compacting: false,
  streamingText: "",
  streamingReasoning: "",
  liveTools: [],
  agentTodos: [],
  convRuntime: {},
  notes: [],
  notesLoaded: false,
  showNotesPanel: false,
  showHistory: false,
  showMissionControl: false,
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
  savedChats: loadSavedChats(),
  conversations: [],
  activeConversationId: null,
  conversationsLoaded: false,
  showChatsPanel: false,
  showSchedulesPanel: false,
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
      // Snapshot the about-to-be-dropped chat into savedChats so
      // bouncing back to the old vault can recover it via the recents
      // popover. Same rolling-buffer logic as Clear / Pick Recent
      // (saveCurrentChat), inlined here because we need it to land in
      // the same set() as the vault swap. No-op if empty.
      let nextSavedChats = s.savedChats;
      if (s.messages.length > 0) {
        const entry: SavedChat = {
          id: `${Date.now().toString(36)}-${Math.random()
            .toString(36)
            .slice(2, 8)}`,
          vaultPath: s.vaultPath,
          title: deriveSavedChatTitle(s.messages),
          savedAt: Date.now(),
          messages: s.messages,
          compactionSummary: s.compactionSummary,
          lastContext: s.lastContext,
          tokenUsage: s.tokenUsage,
        };
        const trimmed = s.savedChats.filter((c) => c.messages !== entry.messages);
        nextSavedChats = [entry, ...trimmed].slice(0, SAVED_CHATS_MAX);
      }
      // Open files / panes are tied to the prior vault. Leaving them
      // up after the switch would point at paths that don't exist in
      // the new vault, breaking save and reload.
      return {
        vaultPath: p,
        savedChats: nextSavedChats,
        messages: [],
        tokenUsage: { prompt: 0, completion: 0, total: 0 },
        lastContext: 0,
        compactionSummary: null,
        streamingText: "",
        streamingReasoning: "",
        liveTools: [],
        agentTodos: [],
        notes: [],
        notesLoaded: false,
        conversations: [],
        activeConversationId: null,
        conversationsLoaded: false,
        showChatsPanel: false,
        showSchedulesPanel: false,
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
  refreshCatalog: async () => {
    const apiKeys = useStore.getState().apiKeys;
    set({ catalogRefreshing: true });
    try {
      const { models, errors } = await fetchAllCatalog(apiKeys);
      setLiveCatalog(models);
      saveCatalogToLocalStorage(models);
      set({ catalog: models, catalogErrors: errors, catalogRefreshing: false });
    } catch (e) {
      console.error("[catalog] refresh failed:", e);
      set({ catalogRefreshing: false });
    }
  },
  setModelId: (id) => {
    localStorage.setItem(MODEL_STORAGE, id);
    set({ modelId: id });
  },
  setAssistantModelId: (id) => { localStorage.setItem(ASSISTANT_MODEL_STORAGE, id); set({ assistantModelId: id }); },
  setSupervisorModelId: (id) => { localStorage.setItem(SUPERVISOR_MODEL_STORAGE, id); set({ supervisorModelId: id }); },
  setWorkerModelId: (id) => { localStorage.setItem(WORKER_MODEL_STORAGE, id); set({ workerModelId: id }); },
  setTheme: (t) => {
    localStorage.setItem(THEME_STORAGE, t);
    set({ theme: t });
    emit("theme:changed", t).catch(() => {});
  },
  applyThemeFromEvent: (t) => {
    localStorage.setItem(THEME_STORAGE, t);
    set({ theme: t });
  },
  setAutoRouterCostBias: (n) => {
    const clamped = Math.max(0, Math.min(10, Math.round(n)));
    localStorage.setItem(AUTO_COST_BIAS_STORAGE, String(clamped));
    setAutoRouterCostBias(clamped); // sync the providers module (fetch shim reads it)
    set({ autoRouterCostBias: clamped });
  },
  setStrictVaultMode: (b) => {
    localStorage.setItem(STRICT_VAULT_STORAGE, String(b));
    if (b) {
      localStorage.setItem(BASH_DISABLED_STORAGE, "true");
      set({ strictVaultMode: true, bashDisabled: true });
    } else {
      set({ strictVaultMode: false });
    }
  },
  setBashDisabled: (b) => {
    localStorage.setItem(BASH_DISABLED_STORAGE, String(b));
    set({ bashDisabled: b });
  },
  setReasoningEffort: (e) => {
    localStorage.setItem(REASONING_EFFORT_STORAGE, e);
    set({ reasoningEffort: e });
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
  toggleVoiceMode: () => set((s) => ({ voiceMode: !s.voiceMode })),
  toggleFollowAlong: () => set((s) => ({ followAlong: !s.followAlong })),
  setVoiceListening: (b) => set({ voiceListening: b }),
  setVoiceSpeaking: (b) => set({ voiceSpeaking: b }),
  setVoiceThinking: (b) => set({ voiceThinking: b }),
  setVoiceConnecting: (b) => set({ voiceConnecting: b }),
  setVoiceCurrentTool: (name) => set({ voiceCurrentTool: name }),
  setViewport: (v) => set({ viewport: v }),
  addTokenUsage: (u) =>
    set((s) => ({
      tokenUsage: {
        prompt: s.tokenUsage.prompt + u.prompt,
        completion: s.tokenUsage.completion + u.completion,
        total: s.tokenUsage.total + u.total,
      },
    })),
  setLastContext: (n) => set({ lastContext: n }),
  setCompacting: (b) => set({ compacting: b }),
  applyCompaction: (summary, keepCount, banner) =>
    set((s) => ({
      messages: [banner, ...s.messages.slice(-keepCount)],
      compactionSummary: summary,
      lastContext: 0,
    })),
  appendStreamingText: (s) => {
    streamBuffer += s;
    if (streamFlushTimer === null) {
      streamFlushTimer = setTimeout(flushStreamBuffer, STREAM_FLUSH_MS);
    }
  },
  setStreamingText: (s) => {
    cancelStreamFlush();
    set({ streamingText: s });
  },
  appendStreamingReasoning: (s) => {
    reasoningBuffer += s;
    if (reasoningFlushTimer === null) {
      reasoningFlushTimer = setTimeout(flushReasoningBuffer, STREAM_FLUSH_MS);
    }
  },
  clearStreamingReasoning: () => {
    cancelReasoningFlush();
    set({ streamingReasoning: "" });
  },
  pushLiveTool: (t) =>
    set((prev) => {
      // If we already created a placeholder via startLiveToolInput,
      // upgrade it in place rather than pushing a duplicate.
      const i = prev.liveTools.findIndex((x) => x.id === t.id);
      if (i >= 0) {
        const next = prev.liveTools.slice();
        next[i] = { ...next[i], ...t };
        return { liveTools: next };
      }
      return { liveTools: [...prev.liveTools, t] };
    }),
  startLiveToolInput: (id, name) =>
    set((prev) => {
      if (prev.liveTools.some((t) => t.id === id)) return prev;
      const placeholder: LiveTool = {
        id,
        name,
        input: undefined,
        startedAt: Date.now(),
        inputChars: 0,
      };
      return { liveTools: [...prev.liveTools, placeholder] };
    }),
  appendLiveToolInputDelta: (id, delta) =>
    set((prev) => ({
      liveTools: prev.liveTools.map((t) =>
        t.id === id ? { ...t, inputChars: (t.inputChars ?? 0) + delta.length } : t,
      ),
    })),
  updateLiveToolResult: (id, result) =>
    set((prev) => ({
      liveTools: prev.liveTools.map((t) => (t.id === id ? { ...t, result } : t)),
    })),
  setLiveToolEta: (id, seconds) =>
    set((prev) => ({
      liveTools: prev.liveTools.map((t) =>
        t.id === id ? { ...t, etaSeconds: seconds } : t,
      ),
    })),
  setAgentTodos: (todos) => set({ agentTodos: todos }),
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
    const next = useStore.getState().notes.filter((n) => n.status !== "resolved");
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
    const spec = findModel(state.modelId);
    const apiKey = spec ? state.apiKeys[spec.provider] : undefined;
    if (!spec || !apiKey) {
      console.warn("[notes] reformat skipped: no model + key");
      return;
    }
    try {
      const formatted = await formatNote(note, spec, apiKey);
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
    set(b ? { showNotesPanel: true, showChatsPanel: false, showSchedulesPanel: false } : { showNotesPanel: false }),
  setShowHistory: (b) => set({ showHistory: b }),
  setShowMissionControl: (b) => set({ showMissionControl: b }),
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
  resetStreaming: () => {
    cancelStreamFlush();
    cancelReasoningFlush();
    set({ streamingText: "", streamingReasoning: "", liveTools: [], agentTodos: [] });
  },
  setConvRuntime: (id, rt) =>
    set((s) => ({ convRuntime: { ...s.convRuntime, [id]: rt } })),
  setBusyStartedAt: (t) => set({ busyStartedAt: t }),
  clearConvRuntime: (id) =>
    set((s) => {
      if (!(id in s.convRuntime)) return {};
      const next = { ...s.convRuntime };
      delete next[id];
      return { convRuntime: next };
    }),
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
        modelId: s.modelId ?? prev.modelId,
        tokenUsage: s.tokenUsage ?? prev.tokenUsage,
        lastContext: s.lastContext ?? prev.lastContext,
        compactionSummary: s.compactionSummary ?? null,
        compacting: s.compacting ?? false,
        currentFile: s.currentFile !== undefined ? s.currentFile : prev.currentFile,
        panes: nextPanes,
        files: s.files ?? prev.files,
      };
    }),
  applyChatStream: (s) =>
    set((prev) => {
      const incomingTools = s.liveTools ?? [];
      const incomingTodos = s.agentTodos ?? [];
      return {
        busy: s.busy,
        streamingText: s.streamingText ?? "",
        streamingReasoning: s.streamingReasoning ?? "",
        liveTools: liveToolsEqual(prev.liveTools, incomingTools) ? prev.liveTools : incomingTools,
        agentTodos: todosEqual(prev.agentTodos, incomingTodos) ? prev.agentTodos : incomingTodos,
      };
    }),
  clearMessages: () =>
    set({
      messages: [],
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      lastContext: 0,
      compactionSummary: null,
      agentTodos: [],
    }),
  saveCurrentChat: () =>
    set((s) => {
      if (s.messages.length === 0) return {};
      const entry: SavedChat = {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        vaultPath: s.vaultPath,
        title: deriveSavedChatTitle(s.messages),
        savedAt: Date.now(),
        messages: s.messages,
        compactionSummary: s.compactionSummary,
        lastContext: s.lastContext,
        tokenUsage: s.tokenUsage,
      };
      // Prune any older entry that already matches by message ref —
      // happens when the user loads then immediately re-saves the same
      // chat without changes.
      const trimmed = s.savedChats.filter((c) => c.messages !== entry.messages);
      const next = [entry, ...trimmed].slice(0, SAVED_CHATS_MAX);
      return { savedChats: next };
    }),
  loadSavedChat: (id) =>
    set((s) => {
      const entry = s.savedChats.find((c) => c.id === id);
      if (!entry) return {};
      return {
        messages: entry.messages,
        compactionSummary: entry.compactionSummary,
        lastContext: entry.lastContext,
        tokenUsage: entry.tokenUsage,
        agentTodos: [],
        streamingText: "",
        streamingReasoning: "",
        liveTools: [],
      };
    }),
  loadConversations: async () => {
    const vault = useStore.getState().vaultPath;
    if (!vault) return;
    try {
      const list = await readConversations(vault);
      const state = useStore.getState();
      // First-run migration: if conversations.jsonl is empty but the
      // user has live messages from the legacy single-chat path,
      // promote them into a first conversation entry so nothing is
      // lost across the upgrade.
      if (list.length === 0 && state.messages.length > 0) {
        const seeded: Conversation = {
          ...emptyConversation(),
          messages: state.messages,
          title: deriveConversationTitle(state.messages),
          lastActivityAt: Date.now(),
        };
        const next = [seeded];
        useStore.setState({
          conversations: next,
          activeConversationId: seeded.id,
          conversationsLoaded: true,
        });
        try {
          await writeConversations(vault, next);
        } catch (e) {
          console.warn("[conversations] seed-write failed:", e);
        }
        return;
      }
      if (list.length === 0) {
        // Brand-new vault — start with one empty conversation so the
        // chat surface always has something selected.
        const fresh = emptyConversation();
        useStore.setState({
          conversations: [fresh],
          activeConversationId: fresh.id,
          conversationsLoaded: true,
          messages: [],
        });
        return;
      }
      // Sort by most-recent first.
      const sorted = list
        .slice()
        .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
      // Per-device active conversation: restore THIS device's last-open thread
      // (persisted per vault) rather than auto-jumping to whatever was most-
      // recently touched — that's what let a phone chat steal the desktop's open
      // pane. Fall back to the most-recent thread when there's no saved pick or
      // it was deleted elsewhere.
      const savedId = savedActiveConvId(vault);
      const active =
        (savedId ? sorted.find((c) => c.id === savedId) : undefined) ??
        sorted[0];
      persistActiveConvId(vault, active.id);
      // Husk-prune: drop 0-message "New chat" shells that are neither the active
      // thread nor freshly created (failed voice opens minted ~21 in one 20-min
      // spree; a crashed worker/mission spawn leaves an empty shell too). The
      // >2min createdAt guard spares a just-opened empty chat the user is about
      // to type in; messages.length===0 means a thread with real messages is
      // never touched; tombstoning (not omission) keeps a husk synced from
      // another machine from resurrecting.
      const HUSK_MAX_AGE_MS = 2 * 60 * 1000;
      const nowTs = Date.now();
      // Only interactive-chat husks (failed voice opens, abandoned "New chat").
      // NEVER prune a worker/mission/scheduled shell: those are written empty
      // then populated async (possibly by another machine), so tombstoning one
      // here could race-delete a thread the box is about to fill.
      const huskSources = new Set(["manual", "voice", "phone"]);
      const husks = sorted.filter(
        (c) =>
          c.messages.length === 0 &&
          c.id !== active.id &&
          huskSources.has(c.source) &&
          nowTs - (c.createdAt ?? nowTs) > HUSK_MAX_AGE_MS,
      );
      const survivors = husks.length
        ? sorted.filter((c) => !husks.some((h) => h.id === c.id))
        : sorted;
      for (const h of husks) {
        invoke<void>("conversation_delete", { vault, id: h.id }).catch((e) =>
          console.warn("[conversations] husk-prune delete failed:", e),
        );
      }
      useStore.setState({
        conversations: survivors,
        activeConversationId: active.id,
        conversationsLoaded: true,
        messages: active.messages,
        compactionSummary: null,
        lastContext: 0,
        tokenUsage: { prompt: 0, completion: 0, total: 0 },
        agentTodos: [],
        streamingText: "",
        streamingReasoning: "",
        liveTools: [],
      });
    } catch (e) {
      console.error("[conversations] load failed:", e);
      useStore.setState({ conversationsLoaded: true });
    }
  },
  refreshConversationFromDisk: async (vault, convId) => {
    // Non-destructive: pull ONE conversation's latest on-disk state into
    // the in-memory list without disturbing the user's active view. Used
    // after a headless scheduled / off-vault run so its result appears
    // live if the user is on that vault, without yanking focus the way
    // loadConversations() would.
    if (useStore.getState().vaultPath !== vault) return;
    try {
      const list = await readConversations(vault);
      const updated = list.find((c) => c.id === convId);
      if (!updated) return;
      set((s) => {
        const exists = s.conversations.some((c) => c.id === convId);
        const conversations = exists
          ? s.conversations.map((c) => (c.id === convId ? updated : c))
          : [updated, ...s.conversations];
        // Only refresh the visible message list when the user is actually
        // looking at this conversation and nothing is mid-run.
        if (s.activeConversationId === convId && !s.busy) {
          return { conversations, messages: updated.messages };
        }
        return { conversations };
      });
    } catch (e) {
      console.warn("[conversations] refresh-from-disk failed:", e);
    }
  },
  refreshConversationsFromDisk: async (vault) => {
    // After a sync pull brings conversation changes in from another machine
    // (e.g. a reply you wrote on your phone), merge the on-disk state into the
    // in-memory list so it appears WITHOUT an app restart — the list-level
    // sibling of refreshConversationFromDisk.
    //
    // SELF-CORRECTING by design: the update decision is recomputed from the
    // CURRENT store + disk on every pull, never gated by a one-shot signature.
    // An earlier signature-dedup version stranded the open thread — if the pull
    // that carried the change happened to land while the thread was momentarily
    // busy, the message pane was skipped AND the dedup then blocked every later
    // pull from retrying, so it took an app restart. Now a skipped pane simply
    // refreshes on the next pull once it's safe.
    //
    // Non-destructive: a conversation running locally keeps its live in-memory
    // copy; disk only wins when it's genuinely newer (more messages, or changed
    // metadata at equal length), so a not-yet-flushed local edit is never
    // clobbered (mirrors the persist merge); brand-new local conversations are
    // never dropped by omission; the open thread's messages refresh only when
    // nothing is mid-run.
    if (useStore.getState().vaultPath !== vault) return;
    if (!useStore.getState().conversationsLoaded) return; // initial load owns the first read
    let list: Conversation[];
    try {
      list = await readConversations(vault);
    } catch (e) {
      console.warn("[conversations] list refresh-from-disk failed:", e);
      return;
    }
    if (list.length === 0) return;
    if (useStore.getState().vaultPath !== vault) return; // vault switched during the read
    set((s) => {
      const byId = new Map(list.map((c) => [c.id, c]));
      const seen = new Set<string>();
      const merged: Conversation[] = [];
      let listChanged = false;
      for (const cur of s.conversations) {
        seen.add(cur.id);
        const disk = byId.get(cur.id);
        // Keep the in-memory copy when there's no disk version yet (a brand-new
        // local conversation not committed) or it's running locally (its live
        // stream is newer than disk).
        if (!disk || cur.status === "running") {
          merged.push(cur);
          continue;
        }
        // Terminal state is monotonic (defense-in-depth behind the Rust
        // reconstruct guard): once a mission is completed in memory, a disk copy
        // that isn't terminal must never revert it — that's the resurrection bug
        // where a stray post-completion wake re-surfaced a finished mission.
        if (cur.completedAt && !disk.completedAt) {
          merged.push(cur);
          continue;
        }
        // Disk wins only when it's genuinely newer — more messages (an append
        // from another machine) or changed metadata at equal length. A disk copy
        // that's BEHIND memory (a local edit not yet flushed) is ignored.
        const diskNewer =
          disk.messages.length > cur.messages.length ||
          (disk.messages.length === cur.messages.length &&
            (disk.lastActivityAt !== cur.lastActivityAt ||
              disk.title !== cur.title ||
              disk.unread !== cur.unread));
        if (diskNewer) {
          merged.push(disk);
          listChanged = true;
        } else {
          merged.push(cur);
        }
      }
      // Conversations on disk but not in memory were created on another machine.
      for (const d of list) {
        if (!seen.has(d.id)) {
          merged.push(d);
          listChanged = true;
        }
      }
      // Refresh the visible message pane only when the open thread isn't mid-run
      // and disk genuinely has MORE messages (a remote append) — so a phone reply
      // to the thread you're reading appears live without interrupting a local
      // stream or clobbering a local message not yet flushed to disk.
      const activeId = s.activeConversationId;
      const activeDisk = activeId ? byId.get(activeId) : undefined;
      const activeRunning =
        s.conversations.find((c) => c.id === activeId)?.status === "running";
      const messagesStale =
        !!activeDisk &&
        !s.busy &&
        !activeRunning &&
        activeDisk.messages.length > s.messages.length;

      if (!listChanged && !messagesStale) return {}; // nothing to apply → no re-render

      const patch: Partial<State> = {};
      if (listChanged) {
        merged.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
        patch.conversations = merged;
      }
      if (messagesStale) patch.messages = activeDisk!.messages;
      return patch;
    });
  },
  newConversation: () => {
    const fresh = emptyConversation();
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
        lastContext: rt?.lastContext ?? 0,
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
    const done = vault
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
        lastContext: 0,
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
    set(b ? { showChatsPanel: true, showNotesPanel: false, showSchedulesPanel: false } : { showChatsPanel: false }),
  setShowSchedulesPanel: (b) =>
    set(b ? { showSchedulesPanel: true, showNotesPanel: false, showChatsPanel: false } : { showSchedulesPanel: false }),
  markAllRead: () =>
    set((s) => {
      if (!s.conversations.some((c) => c.unread)) return {}; // no-op → no re-render / no write
      return {
        conversations: s.conversations.map((c) =>
          c.unread ? { ...c, unread: false } : c,
        ),
      };
    }),
  appendMessageToConversation: (id, m) =>
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === id
          ? {
              ...c,
              messages: [...c.messages, withMid(m)],
              lastActivityAt: Date.now(),
              // [unread hygiene] Never badge worker/mission threads — they live on
              // the Activity surface, not the chat list, so a background turn
              // appending to one must not mark it unread (the "everything's unread"
              // noise). Only user-facing chats the user isn't looking at go unread.
              unread:
                s.activeConversationId === id || c.source === "worker" || c.source === "mission"
                  ? c.unread
                  : true,
            }
          : c,
      ),
    })),
  setConversationStatus: (id, status) =>
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== id) return c;
        if (status === "running") {
          // Stamp the run start once, on the idle→running edge, so the elapsed
          // clock counts from when the prompt was sent and stays continuous
          // across open/close, reload, and phone↔desktop. A re-entrant "running"
          // (a multi-turn agent loop that never went idle) keeps its original
          // start instead of resetting to now.
          const runStartedAt =
            c.status === "running" && c.runStartedAt ? c.runStartedAt : Date.now();
          return { ...c, status, runStartedAt };
        }
        // Run ended — drop the start so a later open doesn't show a phantom clock.
        return { ...c, status, runStartedAt: undefined };
      }),
    })),
}));

// Sync the persisted auto-router cost bias into the providers module on
// boot (its fetch shim reads a module-level copy, not the store).
setAutoRouterCostBias(useStore.getState().autoRouterCostBias);

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
      agentTodos: s.agentTodos,
      tokenUsage: s.tokenUsage,
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

function deriveSavedChatTitle(messages: ChatMessage[]): string {
  for (const m of messages) {
    if (m.role !== "user") continue;
    const trimmed = (m.content ?? "").trim();
    if (!trimmed) continue;
    const firstLine = trimmed.split(/\r?\n/)[0]!;
    return firstLine.length <= 80 ? firstLine : firstLine.slice(0, 77) + "…";
  }
  return "(no prompt)";
}

function loadSavedChats(): SavedChat[] {
  try {
    const raw = localStorage.getItem(SAVED_CHATS_STORAGE);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, SAVED_CHATS_MAX);
  } catch (e) {
    console.warn("[saved-chats] load failed:", e);
    return [];
  }
}

// Mirror live `messages` + busy state into the active conversation
// entry, debounce-write the conversations list to disk. Skip while
// the conversations list is empty (not yet loaded) so we don't write
// over a real on-disk file with a no-op empty.
let conversationsPersistTimer: ReturnType<typeof setTimeout> | null = null;
let conversationsPersistVault: string | null = null;
function scheduleConversationsPersist(vault: string) {
  conversationsPersistVault = vault;
  if (conversationsPersistTimer !== null) return;
  conversationsPersistTimer = setTimeout(() => {
    conversationsPersistTimer = null;
    const v = conversationsPersistVault;
    if (!v) return;
    // Persist UNDER the shared conversation lock with a non-destructive merge.
    // Background runs (offVaultRun: missions, workers, wakes) advance
    // conversations on disk via the same lock; a blind memory→disk rewrite here
    // would clobber their appends — that's what dropped the mission brief and
    // truncated worker threads. Inside the lock, read disk and, per
    // conversation, keep whichever copy has MORE messages (append-only ⇒ more =
    // newer), then union in disk-only conversations memory hasn't seen.
    void withConvLock(async () => {
      const state = useStore.getState();
      if (state.vaultPath !== v) return;
      let disk: Conversation[] = [];
      try {
        disk = await readConversations(v);
      } catch {
        disk = [];
      }
      const diskById = new Map(disk.map((c) => [c.id, c]));
      const memIds = new Set(state.conversations.map((c) => c.id));
      const merged = state.conversations.map((c) => {
        const d = diskById.get(c.id);
        return d && d.messages.length > c.messages.length ? d : c;
      });
      for (const d of disk) if (!memIds.has(d.id)) merged.push(d);
      await writeConversations(v, merged);
    }).catch((e) => console.warn("[conversations] persist failed:", e));
  }, 500);
}

let conversationsLastMessagesRef: ChatMessage[] | null = null;
let conversationsLastBusy = false;
let conversationsLastListRef: Conversation[] | null = null;
useStore.subscribe((state) => {
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
      if (state.vaultPath) scheduleConversationsPersist(state.vaultPath);
      return;
    }
  }
  conversationsLastListRef = state.conversations;
  if (state.vaultPath) scheduleConversationsPersist(state.vaultPath);
});

let savedChatsLastSig = "";
useStore.subscribe((state) => {
  // Defensive: never crash the subscribe pipeline if the field is
  // somehow missing — Zustand state shape can drift across refactors
  // and the popout's installPopoutSync overwrites partial state.
  const list = state.savedChats ?? [];
  const sig = list.map((c) => c.id).join("|");
  if (sig === savedChatsLastSig) return;
  savedChatsLastSig = sig;
  try {
    localStorage.setItem(SAVED_CHATS_STORAGE, JSON.stringify(list));
  } catch (e) {
    console.warn("[saved-chats] persist failed:", e);
  }
});

// Persist chat history to localStorage so HMR reloads (or crashes) don't
// nuke the conversation mid-edit. We only snapshot finalized fields —
// streaming text, live tools, and todos are mid-turn ephemera that would
// be stale or misleading if restored across a reload.
type PersistedChat = {
  vaultPath: string | null;
  messages: ChatMessage[];
  compactionSummary: string | null;
  lastContext: number;
  tokenUsage: { prompt: number; completion: number; total: number };
};

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist() {
  if (persistTimer !== null) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const s = useStore.getState();
      const snapshot: PersistedChat = {
        vaultPath: s.vaultPath,
        messages: s.messages,
        compactionSummary: s.compactionSummary,
        lastContext: s.lastContext,
        tokenUsage: s.tokenUsage,
      };
      localStorage.setItem(CHAT_STORAGE, JSON.stringify(snapshot));
    } catch (e) {
      console.warn("[chat] persist failed:", e);
    }
  }, 500);
}

let lastSig = "";
useStore.subscribe((state) => {
  const sig = `${state.vaultPath ?? ""}|${state.messages.length}|${state.lastContext}|${state.tokenUsage.total}|${state.compactionSummary ?? ""}`;
  if (sig === lastSig) return;
  lastSig = sig;
  schedulePersist();
});

/** Restore persisted chat from a previous session. Only restores if the
 *  persisted vault matches the currently-selected vault — switching
 *  vaults always starts fresh. Call after hydrateKeychain in main.tsx. */
export function hydratePersistedChat(): void {
  try {
    const raw = localStorage.getItem(CHAT_STORAGE);
    if (!raw) return;
    const parsed = JSON.parse(raw) as PersistedChat;
    const current = useStore.getState().vaultPath;
    if (parsed.vaultPath !== current) return;
    useStore.setState({
      messages: parsed.messages ?? [],
      compactionSummary: parsed.compactionSummary ?? null,
      lastContext: parsed.lastContext ?? 0,
      tokenUsage: parsed.tokenUsage ?? { prompt: 0, completion: 0, total: 0 },
    });
  } catch (e) {
    console.warn("[chat] hydrate failed:", e);
  }
}

// One-shot migration: when the ElevenLabs Conversational AI pipeline
// lands, the user asked us to clear out test chats from the prior
// voice-mode iterations so the new conversation starts fresh. The flag
// makes this idempotent — runs once per install on first boot after
// the upgrade.
const VOICE_V2_CLEAR_FLAG = "vault_chat_voice_v2_cleared";
export function maybeClearMessagesForVoiceV2(): void {
  try {
    if (localStorage.getItem(VOICE_V2_CLEAR_FLAG) === "1") return;
    localStorage.removeItem(CHAT_STORAGE);
    useStore.setState({
      messages: [],
      compactionSummary: null,
      lastContext: 0,
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      streamingText: "",
      streamingReasoning: "",
      liveTools: [],
      agentTodos: [],
    });
    localStorage.setItem(VOICE_V2_CLEAR_FLAG, "1");
  } catch (e) {
    console.warn("[chat] voice-v2 clear failed:", e);
  }
}
