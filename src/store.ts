import { create } from "zustand";
import { emit } from "@tauri-apps/api/event";
import type { ModelSpec, ProviderId } from "./providers";
import { DEFAULT_MODEL_ID, MODELS as SEED_MODELS, setLiveCatalog } from "./providers";
import type { Skill } from "./skills";
import type { Note } from "./notes";
import { readNotes, appendNote, writeAllNotes } from "./notes";
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
};

export type ChatRole = "user" | "assistant";
export type ChatAttachment = {
  imageDataUrl: string;
  sourcePath?: string;
  sourceAnchor?: string | null;
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

export type LiveTool = { id: string; name: string; input: any; result?: string; startedAt?: number; inputChars?: number };

export type TodoStatus = "pending" | "in_progress" | "completed";
export type TodoItem = { content: string; status: TodoStatus; activeForm?: string };

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
      (x.inputChars ?? 0) !== (y.inputChars ?? 0)
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

export type Pane = { id: string; file: string; content: string };
export type SplitDirection = "horizontal" | "vertical" | null;
export type DropSide = "left" | "right" | "top" | "bottom";

const newPaneId = () =>
  (typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `p_${Math.random().toString(36).slice(2)}`);

type ApiKeys = Partial<Record<ProviderId, string>>;
export type ServiceKeys = { tavily?: string; github_pat?: string };

const MODEL_STORAGE = "vault_chat_model";
const THEME_STORAGE = "vault_chat_theme";
const VAULT_STORAGE = "vault_chat_last_vault";
const CHAT_STORAGE = "vault_chat_history";
// Rolling buffer of the last few finalised conversations. Capped at
// SAVED_CHATS_MAX entries (newest first), shared across vaults — the
// UI filters to the active vault on display.
const SAVED_CHATS_STORAGE = "vault_chat_saved";
const SAVED_CHATS_MAX = 3;

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

/** Fetch every known credential from the OS keychain into memory.
 *  Called once on app boot (see `hydrateKeychain` below). */
async function fetchAllFromKeychain(): Promise<{
  apiKeys: ApiKeys;
  serviceKeys: ServiceKeys;
}> {
  const [anthropic, openai, google, openrouter, tavily, github_pat] = await Promise.all([
    keychainGet(KEY.anthropic),
    keychainGet(KEY.openai),
    keychainGet(KEY.google),
    keychainGet(KEY.openrouter),
    keychainGet(KEY.tavily),
    keychainGet(KEY.github_pat),
  ]);
  const apiKeys: ApiKeys = {};
  if (anthropic) apiKeys.anthropic = anthropic;
  if (openai) apiKeys.openai = openai;
  if (google) apiKeys.google = google;
  if (openrouter) apiKeys.openrouter = openrouter;
  const serviceKeys: ServiceKeys = {};
  if (tavily) serviceKeys.tavily = tavily;
  if (github_pat) serviceKeys.github_pat = github_pat;
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
      if (parsed.github_pat) await keychainSet(KEY.github_pat, parsed.github_pat);
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
  // dropdown isn't empty on boot. The actual refresh happens on demand
  // (Settings button) or in the background via refreshCatalog().
  const cached = loadCatalogFromLocalStorage();
  if (cached && cached.length > 0) {
    setLiveCatalog(cached);
    useStore.setState({ catalog: cached });
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
  theme: Theme;
  skills: Skill[];
  busy: boolean;
  showSettings: boolean;
  mode: "view" | "edit";
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  popoutOpen: boolean;
  tokenUsage: { prompt: number; completion: number; total: number };
  lastContext: number;
  compactionSummary: string | null;
  compacting: boolean;
  streamingText: string;
  streamingReasoning: string;
  liveTools: LiveTool[];
  agentTodos: TodoItem[];
  notes: Note[];
  notesLoaded: boolean;
  showNotesPanel: boolean;
  showHistory: boolean;
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
  // Feedback composer — same anchor + image plumbing as notes, but
  // submits a GitHub issue (label `auto-fix:queued`) instead of writing
  // to notes.jsonl. The cloud auto-fix agent picks queued issues up
  // nightly and lands fixes on main.
  feedbackComposer: {
    open: boolean;
    initialDraft?: string;
    initialAnchors?: import("./notes").NoteAnchor[];
  };
  feedbackCapturePending: boolean;
  // Rolling buffer of finished conversations, capped to the last
  // SAVED_CHATS_MAX. Auto-snapshotted whenever the user clears or
  // loads another saved chat. UI shows entries matching the current
  // vaultPath.
  savedChats: SavedChat[];

  setVault: (p: string) => void;
  setFiles: (f: FileEntry[]) => void;
  applyDeleteCascade: (paths: string[]) => Promise<void>;
  applyRenameCascade: (moves: { from: string; to: string }[]) => Promise<void>;
  setCurrentFile: (p: string | null, content: string) => void;
  reloadCurrent: (content: string) => void;
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
  setTheme: (t: Theme) => void;
  applyThemeFromEvent: (t: Theme) => void;
  setSkills: (s: Skill[]) => void;
  setBusy: (b: boolean) => void;
  setShowSettings: (b: boolean) => void;
  setMode: (m: "view" | "edit") => void;
  toggleMode: () => void;
  toggleLeft: () => void;
  toggleRight: () => void;
  setPopoutOpen: (b: boolean) => void;
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
  setAgentTodos: (todos: TodoItem[]) => void;
  loadNotes: () => Promise<void>;
  addNote: (note: Note) => Promise<void>;
  deleteNote: (id: string) => Promise<void>;
  setNoteStatus: (id: string, status: "open" | "resolved") => Promise<void>;
  clearResolvedNotes: () => Promise<void>;
  reformatNote: (id: string) => Promise<void>;
  setShowNotesPanel: (b: boolean) => void;
  setShowHistory: (b: boolean) => void;
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
  setEditorSelection: (sel: State["editorSelection"]) => void;
  openNoteComposer: (payload?: {
    initialDraft?: string;
    initialAnchors?: import("./notes").NoteAnchor[];
    initialTurns?: import("./notes").NoteTurn[];
  }) => void;
  closeNoteComposer: () => void;
  openFeedbackComposer: (payload?: {
    initialDraft?: string;
    initialAnchors?: import("./notes").NoteAnchor[];
  }) => void;
  closeFeedbackComposer: () => void;
  stashFeedbackForCapture: (payload: {
    draft: string;
    anchors: import("./notes").NoteAnchor[];
  }) => void;
  setFeedbackCapturePending: (b: boolean) => void;
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
  catalog: loadCatalogFromLocalStorage() ?? SEED_MODELS,
  catalogRefreshing: false,
  catalogErrors: {},
  modelId: localStorage.getItem(MODEL_STORAGE) ?? DEFAULT_MODEL_ID,
  theme: loadTheme(),
  skills: [],
  busy: false,
  showSettings: false,
  mode: "view",
  leftCollapsed: false,
  rightCollapsed: true,
  popoutOpen: false,
  tokenUsage: { prompt: 0, completion: 0, total: 0 },
  lastContext: 0,
  compactionSummary: null,
  compacting: false,
  streamingText: "",
  streamingReasoning: "",
  liveTools: [],
  agentTodos: [],
  notes: [],
  notesLoaded: false,
  showNotesPanel: false,
  showHistory: false,
  pendingScrollAnchor: null,
  lastCapture: null,
  noteCapturePending: false,
  editPromptCapturePending: false,
  editPromptLastCapture: null,
  chatPaneCapturePending: false,
  chatPaneLastCapture: null,
  editorSelection: null,
  noteComposer: { open: false },
  feedbackComposer: { open: false },
  feedbackCapturePending: false,
  savedChats: loadSavedChats(),

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
        tokenUsage: { prompt: 0, completion: 0, total: 0 },
        lastContext: 0,
        compactionSummary: null,
        streamingText: "",
        streamingReasoning: "",
        liveTools: [],
        agentTodos: [],
        notes: [],
        notesLoaded: false,
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
  setCurrentFile: (p, content) =>
    set((s) => {
      if (s.panes.length > 0 && s.activePaneId && p) {
        const panes = s.panes.map((pane) =>
          pane.id === s.activePaneId ? { ...pane, file: p, content } : pane,
        );
        return { panes, currentFile: p, currentContent: content };
      }
      return { currentFile: p, currentContent: content, panes: [], splitDirection: null, activePaneId: null };
    }),
  reloadCurrent: (content) =>
    set((s) => {
      if (s.panes.length > 0 && s.activePaneId) {
        const panes = s.panes.map((pane) =>
          pane.id === s.activePaneId ? { ...pane, content } : pane,
        );
        return { panes, currentContent: content };
      }
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
      const newPane: Pane = { id: newPaneId(), file: path, content };
      const existingPane: Pane = { id: newPaneId(), file: existingFile, content: existingContent };
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
        const newPane: Pane = { id: newPaneId(), file: path, content };
        const existingPane: Pane = {
          id: newPaneId(),
          file: s.currentFile!,
          content: s.currentContent,
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
      const newPane: Pane = { id: newPaneId(), file: path, content };
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
  appendMessage: (m) => set((s) => ({ messages: [...s.messages, m] })),
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
      name === "tavily" ? KEY.tavily : name === "github_pat" ? KEY.github_pat : null;
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
      name === "tavily" ? KEY.tavily : name === "github_pat" ? KEY.github_pat : null;
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
  setTheme: (t) => {
    localStorage.setItem(THEME_STORAGE, t);
    set({ theme: t });
    emit("theme:changed", t).catch(() => {});
  },
  applyThemeFromEvent: (t) => {
    localStorage.setItem(THEME_STORAGE, t);
    set({ theme: t });
  },
  setSkills: (s) => set({ skills: s }),
  setBusy: (b) => set({ busy: b }),
  setShowSettings: (b) => set({ showSettings: b }),
  setMode: (m) => set({ mode: m }),
  toggleMode: () => set((s) => ({ mode: s.mode === "view" ? "edit" : "view" })),
  toggleLeft: () => set((s) => ({ leftCollapsed: !s.leftCollapsed })),
  toggleRight: () =>
    // No-op while the chat is popped out — the right pane doesn't
    // render in that state, so flipping the collapsed flag would just
    // cause the chat to jump back in when the popout closes.
    set((s) => (s.popoutOpen ? s : { rightCollapsed: !s.rightCollapsed })),
  setPopoutOpen: (b) => set({ popoutOpen: b }),
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
  setShowNotesPanel: (b) => set({ showNotesPanel: b }),
  setShowHistory: (b) => set({ showHistory: b }),
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
  openFeedbackComposer: (payload) =>
    set({
      feedbackComposer: {
        open: true,
        initialDraft: payload?.initialDraft,
        initialAnchors: payload?.initialAnchors,
      },
    }),
  closeFeedbackComposer: () => set({ feedbackComposer: { open: false } }),
  stashFeedbackForCapture: (payload) =>
    set({
      feedbackComposer: {
        open: false,
        initialDraft: payload.draft,
        initialAnchors: payload.anchors,
      },
      feedbackCapturePending: true,
    }),
  setFeedbackCapturePending: (b) => set({ feedbackCapturePending: b }),
  resetStreaming: () => {
    cancelStreamFlush();
    cancelReasoningFlush();
    set({ streamingText: "", streamingReasoning: "", liveTools: [], agentTodos: [] });
  },
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
}));

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
