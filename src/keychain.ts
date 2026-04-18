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
  tavily: "service.tavily",
} as const;
