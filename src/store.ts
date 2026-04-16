import { create } from "zustand";
import { emit } from "@tauri-apps/api/event";
import type { ProviderId } from "./providers";
import { DEFAULT_MODEL_ID } from "./providers";
import type { Skill } from "./skills";

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
};

export const MODEL_CONTEXT_LIMIT = 200_000;

export type LiveTool = { id: string; name: string; input: any; result?: string };

export type Pane = { id: string; file: string; content: string };
export type SplitDirection = "horizontal" | "vertical" | null;
export type DropSide = "left" | "right" | "top" | "bottom";

const newPaneId = () =>
  (typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `p_${Math.random().toString(36).slice(2)}`);

type ApiKeys = Partial<Record<ProviderId, string>>;
export type ServiceKeys = { tavily?: string };

const KEYS_STORAGE = "vault_chat_api_keys";
const SERVICE_KEYS_STORAGE = "vault_chat_service_keys";
const MODEL_STORAGE = "vault_chat_model";
const THEME_STORAGE = "vault_chat_theme";
const VAULT_STORAGE = "vault_chat_last_vault";

export type Theme = "graphite" | "light";

function loadTheme(): Theme {
  const raw = localStorage.getItem(THEME_STORAGE);
  return raw === "light" ? "light" : "graphite";
}

function loadKeys(): ApiKeys {
  try {
    const raw = localStorage.getItem(KEYS_STORAGE);
    if (raw) return JSON.parse(raw);
  } catch {}
  const legacy = localStorage.getItem("anthropic_api_key");
  if (legacy) return { anthropic: legacy };
  return {};
}

function loadServiceKeys(): ServiceKeys {
  try {
    const raw = localStorage.getItem(SERVICE_KEYS_STORAGE);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {};
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
  rightCollapsed: boolean;
  popoutOpen: boolean;
  tokenUsage: { prompt: number; completion: number; total: number };
  lastContext: number;
  compactionSummary: string | null;
  compacting: boolean;
  streamingText: string;
  liveTools: LiveTool[];

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
  setServiceKey: (name: keyof ServiceKeys, k: string) => void;
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
  pushLiveTool: (t: LiveTool) => void;
  updateLiveToolResult: (id: string, result: string) => void;
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
  apiKeys: loadKeys(),
  serviceKeys: loadServiceKeys(),
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
  liveTools: [],

  setVault: (p) => {
    localStorage.setItem(VAULT_STORAGE, p);
    set({ vaultPath: p });
  },
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
  setApiKey: (p, k) =>
    set((s) => {
      const next = { ...s.apiKeys, [p]: k };
      localStorage.setItem(KEYS_STORAGE, JSON.stringify(next));
      return { apiKeys: next };
    }),
  setServiceKey: (name, k) =>
    set((s) => {
      const next = { ...s.serviceKeys, [name]: k };
      localStorage.setItem(SERVICE_KEYS_STORAGE, JSON.stringify(next));
      return { serviceKeys: next };
    }),
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
  appendStreamingText: (s) => set((prev) => ({ streamingText: prev.streamingText + s })),
  setStreamingText: (s) => set({ streamingText: s }),
  pushLiveTool: (t) => set((prev) => ({ liveTools: [...prev.liveTools, t] })),
  updateLiveToolResult: (id, result) =>
    set((prev) => ({
      liveTools: prev.liveTools.map((t) => (t.id === id ? { ...t, result } : t)),
    })),
  resetStreaming: () => set({ streamingText: "", liveTools: [] }),
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
    }),
}));
