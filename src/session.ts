import { invoke } from "@tauri-apps/api/core";
import { useStore, type ChatMessage } from "./store";

const SESSION_FILE = ".vault-chat/session.json";

export type SessionSnapshot = {
  version: 1;
  messages: ChatMessage[];
  tokenUsage: { prompt: number; completion: number; total: number };
  lastContext: number;
  compactionSummary: string | null;
};

function sessionPath(vault: string): string {
  return `${vault}/${SESSION_FILE}`;
}

export async function loadSession(vault: string): Promise<SessionSnapshot | null> {
  try {
    const raw = await invoke<string>("read_text_file", { path: sessionPath(vault) });
    const parsed = JSON.parse(raw) as SessionSnapshot;
    if (parsed.version !== 1 || !Array.isArray(parsed.messages)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveSession(
  vault: string,
  snapshot: SessionSnapshot,
): Promise<void> {
  const contents = JSON.stringify(snapshot);
  await invoke("write_text_file", { path: sessionPath(vault), contents });
}

export async function clearSession(vault: string): Promise<void> {
  try {
    await invoke("delete_file", { path: sessionPath(vault) });
  } catch {
    // File may not exist — ignore.
  }
}

// Install session persistence for the main window. Loads the saved
// snapshot for the current vault on mount and whenever the vault
// changes, and auto-saves on every meaningful message-state change
// (debounced). The save is fire-and-forget — if it fails the user
// still has the in-memory session.
export function installSessionPersistence() {
  let currentVault: string | null = null;
  let saveTimer: number | null = null;
  let suppressSave = true; // don't save during the initial load

  const runSave = (vault: string) => {
    const s = useStore.getState();
    saveSession(vault, {
      version: 1,
      messages: s.messages,
      tokenUsage: s.tokenUsage,
      lastContext: s.lastContext,
      compactionSummary: s.compactionSummary,
    }).catch((e) => {
      console.warn("[session] save failed:", e);
    });
  };

  const scheduleSave = () => {
    if (suppressSave) return;
    const vault = currentVault;
    if (!vault) return;
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      runSave(vault);
    }, 400);
  };

  const loadForVault = async (vault: string | null) => {
    suppressSave = true;
    currentVault = vault;
    if (!vault) {
      suppressSave = false;
      return;
    }
    const snap = await loadSession(vault);
    if (currentVault !== vault) return; // vault switched again while loading
    if (snap) {
      useStore.setState({
        messages: snap.messages,
        tokenUsage: snap.tokenUsage,
        lastContext: snap.lastContext,
        compactionSummary: snap.compactionSummary,
      });
    }
    suppressSave = false;
  };

  // Initial load for whatever vault was restored from localStorage.
  loadForVault(useStore.getState().vaultPath);

  // Watch for vault changes and for chat-state changes that should
  // trigger a save.
  let lastVault = useStore.getState().vaultPath;
  let lastMessages = useStore.getState().messages;
  let lastSummary = useStore.getState().compactionSummary;
  useStore.subscribe((state) => {
    if (state.vaultPath !== lastVault) {
      lastVault = state.vaultPath;
      lastMessages = state.messages;
      lastSummary = state.compactionSummary;
      void loadForVault(state.vaultPath);
      return;
    }
    if (
      state.messages !== lastMessages ||
      state.compactionSummary !== lastSummary
    ) {
      lastMessages = state.messages;
      lastSummary = state.compactionSummary;
      scheduleSave();
    }
  });
}
