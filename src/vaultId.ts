import { invoke } from "@tauri-apps/api/core";

// Stable identifier for a vault, used to route cross-machine sync
// requests. Lives at <vault>/.vault-chat/vault-id and gets committed
// to git by the vault auto-sync loop, so both machines converge to
// the same id after a sync round-trip.
//
// Cross-machine conversation sync DEPENDS on this id existing on
// both machines for a given vault. If you don't have vault auto-sync
// (item #6) enabled for a vault, the id won't propagate, and
// conversation sync silently degrades to "two different ids, no
// shared conversations." That's an unavoidable architectural
// dependency, not a bug.

const PATH = (vault: string) => `${vault}/.vault-chat/vault-id`;

const cache = new Map<string, string>();

function newUuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID.
  return `vc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Read the vault's id from disk. Returns null if the file doesn't
 *  exist yet (call ensureVaultId to create one). */
export async function readVaultId(vault: string): Promise<string | null> {
  const cached = cache.get(vault);
  if (cached) return cached;
  try {
    const text = (await invoke<string>("read_text_file", { path: PATH(vault) })).trim();
    if (text) {
      cache.set(vault, text);
      return text;
    }
    return null;
  } catch {
    return null;
  }
}

/** Get the vault's id, creating one if missing. Idempotent. The new
 *  id gets persisted to disk so the auto-sync git commit loop picks
 *  it up on its next cycle. */
export async function ensureVaultId(vault: string): Promise<string> {
  const existing = await readVaultId(vault);
  if (existing) return existing;
  const id = newUuid();
  try {
    await invoke("write_text_file", {
      path: PATH(vault),
      contents: `${id}\n`,
    });
    cache.set(vault, id);
  } catch (e) {
    console.warn("[vault-id] write failed, using in-memory id only:", e);
    cache.set(vault, id);
  }
  return id;
}

/** Forget a cached id (e.g. when the vault's contents changed under us). */
export function invalidateVaultId(vault: string): void {
  cache.delete(vault);
}
