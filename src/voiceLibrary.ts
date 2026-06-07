import { invoke } from "@tauri-apps/api/core";

// The user's saved ElevenLabs voices. Persisted per-vault to
// `<vault>/.vault-chat/voices.json` so the vault auto-sync git loop commits and
// pushes them — the saved set then travels across machines exactly like notes
// and conversations. A localStorage copy is kept as a fast render cache and a
// fallback when no vault is open. The vault file is the source of truth: on load
// it overwrites the cache, so a machine converges to the synced set.

export type SavedVoice = { name: string; id: string };

const LS_KEY = "vault_chat_elevenlabs_voice_library";
const PATH = (vault: string) => `${vault}/.vault-chat/voices.json`;

// Seeded default so a brand-new vault has a usable voice out of the box.
export const DEFAULT_VOICES: SavedVoice[] = [
  { name: "Brian (Jarvis-adjacent)", id: "nPczCjzI2devNBz1zQrb" },
];

function isSavedVoice(v: unknown): v is SavedVoice {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as SavedVoice).name === "string" &&
    typeof (v as SavedVoice).id === "string"
  );
}

/** Synchronous read of the localStorage cache — used for the initial render
 *  before the async vault read resolves, and when no vault is open. */
export function readVoiceLibraryCache(): SavedVoice[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isSavedVoice) : [];
  } catch {
    return [];
  }
}

function writeCache(voices: SavedVoice[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(voices));
  } catch {
    /* ignore quota / unavailable */
  }
}

/** Read the git-synced library from the vault. Returns null if the file doesn't
 *  exist yet (vs. an empty array, which means "synced to empty"). Refreshes the
 *  local cache on success. */
export async function readVoiceLibrary(vault: string): Promise<SavedVoice[] | null> {
  try {
    const text = (await invoke<string>("read_text_file", { path: PATH(vault) })).trim();
    if (!text) return null;
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return null;
    const voices = parsed.filter(isSavedVoice);
    writeCache(voices);
    return voices;
  } catch {
    return null;
  }
}

/** Persist the library to the vault file (git-synced) and the local cache.
 *  A null vault (none open) writes the cache only. Best-effort on the vault
 *  write — never throws. */
export async function writeVoiceLibrary(vault: string | null, voices: SavedVoice[]): Promise<void> {
  writeCache(voices);
  if (!vault) return;
  try {
    await invoke("write_text_file", {
      path: PATH(vault),
      contents: JSON.stringify(voices, null, 2) + "\n",
    });
  } catch (e) {
    console.warn("[voice-library] vault write failed, kept local cache only:", e);
  }
}
