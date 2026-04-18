import { create } from "zustand";
import { emit } from "@tauri-apps/api/event";
import type { ProviderId } from "./providers";
import { DEFAULT_MODEL_ID } from "./providers";
import type { Skill } from "./skills";
import { keychainGet, keychainSet, keychainDelete, KEY } from "./keychain";

export type FileEntry = {
  path: string;
  name: string;
  is_dir: boolean;
  depth: number;
  hidden: boolean;
};

export type ChatRole = "user" | "assistant";
export type ChatMessage = {
  role: ChatRole;
  content: string;
  toolCalls?: { id?: string; name: string; input: any; result?: string }[];
  system?: boolean;
  // Excluded from the UI but still sent to the agent. Used for inline-ask
  // context preambles that the user didn't type.
  hidden?: boolean;
};

export const MODEL_CONTEXT_LIMIT = 200_000;

export type LiveTool = { id: string; name: string; input: any; result?: string; startedAt?: number };

export type TodoStatus = "pending" | "in_progress" | "completed";
export type TodoItem = { content: string; status: TodoStatus; activeForm?: string };

export type Pane = { id: string; file: string; content: string };
export type SplitDirection = "horizontal" | "vertical" | null;
export type DropSide = "left" | "right" | "top" | "bottom";

const newPaneId = () =>
  (typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `p_${Math.random().toString(36).slice(2)}`);

type ApiKeys = Partial<Record<ProviderId, string>>;
export type ServiceKeys = { tavily?: string };

const MODEL_STORAGE = "vault_chat_model";
const THEME_STORAGE = "vault_chat_theme";
const VAULT_STORAGE = "vault_chat_last_vault";

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
  const [anthropic, openai, google, tavily] = await Promise.all([
    keychainGet(KEY.anthropic),
    keychainGet(KEY.openai),
    keychainGet(KEY.google),
    keychainGet(KEY.tavily),
  ]);
  const apiKeys: ApiKeys = {};
  if (anthropic) apiKeys.anthropic = anthropic;
  if (openai) apiKeys.openai = openai;
  if (google) apiKeys.google = google;
  const serviceKeys: ServiceKeys = {};
  if (tavily) serviceKeys.tavily = tavily;
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
  modelId: string;
  theme: Theme;
  skills: Skill[];
  busy: boolean;
  showSettings: boolean;
  mode: "view" | "edit";
  leftCollapsed: boolean;
  middleCollapsed: boolean;
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

  setVault: (p: string) => void;
  setFiles: (f: FileEntry[]) => void;
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
  updateLiveToolResult: (id: string, result: string) => void;
  setAgentTodos: (todos: TodoItem[]) => void;
  resetStreaming: () => void;
  applyChatSnapshot: (s: {
    vaultPath: string | null;
    currentFile: string | null;
    currentContent: string;
    files: FileEntry[];
    messages: ChatMessage[];
    busy: boolean;
    modelId?: string;
    tokenUsage?: { prompt: number; completion: number; total: number };
    lastContext?: number;
    compactionSummary?: string | null;
    compacting?: boolean;
    streamingText?: string;
    liveTools?: LiveTool[];
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

  setVault: (p) =>
    set((s) => {
      localStorage.setItem(VAULT_STORAGE, p);
      // Switching vaults drops the chat — the prior conversation's
      // file context no longer applies. Staying on the same vault
      // leaves the chat untouched.
      if (s.vaultPath === p) {
        return { vaultPath: p };
      }
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
      };
    }),
  setFiles: (f) => set({ files: f }),
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
    const keyName = name === "tavily" ? KEY.tavily : null;
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
    const keyName = name === "tavily" ? KEY.tavily : null;
    if (keyName) {
      keychainDelete(keyName).catch((e) =>
        console.error(`[keys] keychain delete ${name} failed:`, e),
      );
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
  toggleRight: () => set((s) => ({ rightCollapsed: !s.rightCollapsed })),
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
  pushLiveTool: (t) => set((prev) => ({ liveTools: [...prev.liveTools, t] })),
  updateLiveToolResult: (id, result) =>
    set((prev) => ({
      liveTools: prev.liveTools.map((t) => (t.id === id ? { ...t, result } : t)),
    })),
  setAgentTodos: (todos) => set({ agentTodos: todos }),
  resetStreaming: () => {
    cancelStreamFlush();
    cancelReasoningFlush();
    set({ streamingText: "", streamingReasoning: "", liveTools: [], agentTodos: [] });
  },
  applyChatSnapshot: (s) =>
    set((prev) => ({
      vaultPath: s.vaultPath,
      currentFile: s.currentFile,
      currentContent: s.currentContent,
      panes: [],
      splitDirection: null,
      activePaneId: null,
      files: s.files,
      messages: s.messages,
      busy: s.busy,
      modelId: s.modelId ?? prev.modelId,
      tokenUsage: s.tokenUsage ?? prev.tokenUsage,
      lastContext: s.lastContext ?? prev.lastContext,
      compactionSummary: s.compactionSummary ?? null,
      compacting: s.compacting ?? false,
      streamingText: s.streamingText ?? "",
      liveTools: s.liveTools ?? [],
    })),
  clearMessages: () =>
    set({
      messages: [],
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      lastContext: 0,
      compactionSummary: null,
      agentTodos: [],
    }),
}));
