import { invoke } from "@tauri-apps/api/core";
import { KEY_PREFIX, canonicalKeyName } from "./keyEnv";

// API keys and service credentials live in the OS keychain via these
// Rust-backed commands. Keys are outside any vault the agent can
// reach — the agent's Read / Write / Bash tools can't get at them.

export async function keychainGet(key: string): Promise<string | null> {
  try {
    return (await invoke<string | null>("keychain_get", { key })) ?? null;
  } catch (e) {
    console.warn(`[keychain] get ${key} failed:`, e);
    return null;
  }
}

export async function keychainSet(key: string, value: string): Promise<void> {
  await invoke("keychain_set", { key, value });
}

export async function keychainDelete(key: string): Promise<void> {
  try {
    await invoke("keychain_delete", { key });
  } catch (e) {
    console.warn(`[keychain] delete ${key} failed:`, e);
  }
}

// Claude Code's sign-in (`claude setup-token`): not a key. The box runs the
// engine with it, and it is deliberately not given to anything the agent runs
// (src/keyEnv.ts NOT_FOR_COMMANDS). Everything else is a key (below).
export const KEY = {
  claudeCode: "service.claude-code",
} as const;

// ----- keys -----
//
// A key is a name and a secret. Every key is stored the same way: the OS
// keychain entry `user.<name>` (src/keyEnv.ts KEY_PREFIX). Its name is what the
// agent's commands see as an environment variable (upper-cased) and what any
// plugin or vault tool asks for. The names are tracked in localStorage so they
// can be listed (the keychain API has no list-by-service call).

const KEY_REGISTRY = "vault_chat_user_keys";

export function keyEntry(name: string): string {
  return `${KEY_PREFIX}${name}`;
}

export function listKeyNames(): string[] {
  try {
    const raw = localStorage.getItem(KEY_REGISTRY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeKeyRegistry(names: string[]): void {
  localStorage.setItem(KEY_REGISTRY, JSON.stringify(names));
}

/** A key's name as typed in Settings: letters, digits, _ and -. */
export function cleanKeyName(name: string): string {
  return name.trim().replace(/[^\w-]/g, "_").slice(0, 64);
}

export async function setKey(name: string, value: string): Promise<void> {
  await keychainSet(keyEntry(name), value);
  const names = listKeyNames();
  if (!names.includes(name)) writeKeyRegistry([...names, name].sort());
}

export async function deleteKey(name: string): Promise<void> {
  await keychainDelete(keyEntry(name));
  writeKeyRegistry(listKeyNames().filter((n) => n !== name));
}

/** Merge in key names learned elsewhere (imported from another machine via the
 *  encrypted keystore) so Settings lists them. The values are written separately. */
export function mergeKeyNames(names: string[]): void {
  writeKeyRegistry(Array.from(new Set([...listKeyNames(), ...names])).sort());
}

export async function getKey(name: string): Promise<string | null> {
  return keychainGet(keyEntry(name));
}

/**
 * Older builds kept a few keys under fixed entries (api.anthropic,
 * service.elevenlabs, ...). Move each into the one form, in place, once: the
 * value is copied to `user.<NAME>` (the name it already had in the agent's
 * environment), read back and compared, then the old entry is kept as
 * `backup.<old>` (never read) and removed. Nothing is re-entered; no value is
 * ever logged. Returns the names moved.
 */
const LEGACY_ENTRIES = ["api.anthropic", "api.openai", "api.google", "service.tavily", "service.elevenlabs"];
export async function migrateLegacyKeys(): Promise<string[]> {
  const moved: string[] = [];
  for (const old of LEGACY_ENTRIES) {
    try {
      const v = await keychainGet(old);
      if (!v) continue;
      const name = canonicalKeyName(old)!;
      const have = await getKey(name);
      if (!have) {
        await keychainSet(keyEntry(name), v);
        if ((await getKey(name)) !== v) {
          console.warn(`[keys] migrating ${old} -> ${name}: read-back differs, old entry kept`);
          continue;
        }
      }
      mergeKeyNames([name]);
      await keychainSet(`backup.${old}`, v);
      await keychainDelete(old);
      moved.push(name);
    } catch (e) {
      console.warn(`[keys] migrating ${old} failed, old entry kept:`, e);
    }
  }
  return moved;
}
