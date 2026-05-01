import { invoke } from "@tauri-apps/api/core";

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

// Canonical key names. Keep flat (all under service com.vault-chat.app)
// to keep the surface simple — collisions impossible since providers
// and service-key names are disjoint strings.
export const KEY = {
  anthropic: "api.anthropic",
  openai: "api.openai",
  google: "api.google",
  openrouter: "api.openrouter",
  tavily: "service.tavily",
  github_pat: "service.github_pat",
  cloud_agent_url: "service.cloud_agent_url",
} as const;

// ----- user-managed custom keys -----
//
// Users can register their own credentials (Gmail tokens, SerpAPI
// keys, etc.) that meta-vault tools request via `requires_keys` in
// their TOOL.md front-matter. Values live in the OS keychain under
// user.<name>. Names are tracked separately in localStorage so we can
// enumerate the set (the keychain API has no list-by-service call).

const USER_KEY_REGISTRY = "vault_chat_user_keys";

export function userKeyName(name: string): string {
  return `user.${name}`;
}

export function listUserKeys(): string[] {
  try {
    const raw = localStorage.getItem(USER_KEY_REGISTRY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeUserKeyRegistry(names: string[]): void {
  localStorage.setItem(USER_KEY_REGISTRY, JSON.stringify(names));
}

export async function setUserKey(name: string, value: string): Promise<void> {
  await keychainSet(userKeyName(name), value);
  const names = listUserKeys();
  if (!names.includes(name)) {
    writeUserKeyRegistry([...names, name].sort());
  }
}

export async function deleteUserKey(name: string): Promise<void> {
  await keychainDelete(userKeyName(name));
  writeUserKeyRegistry(listUserKeys().filter((n) => n !== name));
}

export async function getUserKey(name: string): Promise<string | null> {
  return keychainGet(userKeyName(name));
}

/** Fetch a set of user keys as a string-to-string env dict. Missing
 *  keys are omitted (not errors) — the caller decides how to react. */
export async function getUserKeysAsEnv(
  names: string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(
    names.map(async (n) => {
      const v = await getUserKey(n);
      if (v !== null) out[n] = v;
    }),
  );
  return out;
}
