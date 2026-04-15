import { create } from "zustand";
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

type ApiKeys = Partial<Record<ProviderId, string>>;

const KEYS_STORAGE = "vault_chat_api_keys";
const MODEL_STORAGE = "vault_chat_model";

function loadKeys(): ApiKeys {
  try {
    const raw = localStorage.getItem(KEYS_STORAGE);
    if (raw) return JSON.parse(raw);
  } catch {}
  const legacy = localStorage.getItem("anthropic_api_key");
  if (legacy) return { anthropic: legacy };
  return {};
}

type State = {
  vaultPath: string | null;
  files: FileEntry[];
  currentFile: string | null;
  currentContent: string;
  messages: ChatMessage[];
  apiKeys: ApiKeys;
  modelId: string;
  skills: Skill[];
  busy: boolean;
  showSettings: boolean;
  mode: "view" | "edit";

  setVault: (p: string) => void;
  setFiles: (f: FileEntry[]) => void;
  setCurrentFile: (p: string, content: string) => void;
  reloadCurrent: (content: string) => void;
  appendMessage: (m: ChatMessage) => void;
  setApiKey: (p: ProviderId, k: string) => void;
  setModelId: (id: string) => void;
  setSkills: (s: Skill[]) => void;
  setBusy: (b: boolean) => void;
  setShowSettings: (b: boolean) => void;
  setMode: (m: "view" | "edit") => void;
  toggleMode: () => void;
  clearMessages: () => void;
};

export const useStore = create<State>((set) => ({
  vaultPath: null,
  files: [],
  currentFile: null,
  currentContent: "",
  messages: [],
  apiKeys: loadKeys(),
  modelId: localStorage.getItem(MODEL_STORAGE) ?? DEFAULT_MODEL_ID,
  skills: [],
  busy: false,
  showSettings: false,
  mode: "view",

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
  setModelId: (id) => {
    localStorage.setItem(MODEL_STORAGE, id);
    set({ modelId: id });
  },
  setSkills: (s) => set({ skills: s }),
  setBusy: (b) => set({ busy: b }),
  setShowSettings: (b) => set({ showSettings: b }),
  setMode: (m) => set({ mode: m }),
  toggleMode: () => set((s) => ({ mode: s.mode === "view" ? "edit" : "view" })),
  clearMessages: () => set({ messages: [] }),
}));
