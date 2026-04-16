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
};

export type ChatRole = "user" | "assistant";
export type ChatMessage = {
  role: ChatRole;
  content: string;
  toolCalls?: { id?: string; name: string; input: any; result?: string }[];
};

export type LiveTool = { id: string; name: string; input: any; result?: string };

type ApiKeys = Partial<Record<ProviderId, string>>;
export type ServiceKeys = { tavily?: string };

const KEYS_STORAGE = "vault_chat_api_keys";
const SERVICE_KEYS_STORAGE = "vault_chat_service_keys";
const MODEL_STORAGE = "vault_chat_model";
const THEME_STORAGE = "vault_chat_theme";

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
  streamingText: string;
  liveTools: LiveTool[];

  setVault: (p: string) => void;
  setFiles: (f: FileEntry[]) => void;
  setCurrentFile: (p: string, content: string) => void;
  reloadCurrent: (content: string) => void;
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
    streamingText?: string;
    liveTools?: LiveTool[];
  }) => void;
  clearMessages: () => void;
};

export const useStore = create<State>((set) => ({
  vaultPath: null,
  files: [],
  currentFile: null,
  currentContent: "",
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
  rightCollapsed: false,
  popoutOpen: false,
  tokenUsage: { prompt: 0, completion: 0, total: 0 },
  streamingText: "",
  liveTools: [],

  setVault: (p) => set({ vaultPath: p }),
  setFiles: (f) => set({ files: f }),
  setCurrentFile: (p, content) => set({ currentFile: p, currentContent: content }),
  reloadCurrent: (content) => set({ currentContent: content }),
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
      files: s.files,
      messages: s.messages,
      busy: s.busy,
      modelId: s.modelId ?? prev.modelId,
      tokenUsage: s.tokenUsage ?? prev.tokenUsage,
      streamingText: s.streamingText ?? "",
      liveTools: s.liveTools ?? [],
    })),
  clearMessages: () => set({ messages: [], tokenUsage: { prompt: 0, completion: 0, total: 0 } }),
}));
