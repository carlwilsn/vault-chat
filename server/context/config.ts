// CONTEXT's settings. ENGINE calls configureContext() once at boot; tests point
// it at temp vaults and a fake model server. Every function also works with the
// defaults, except that `vault` must be set.
import { AsyncLocalStorage } from "node:async_hooks";
import { keychainCommands } from "../keys";

export type ContextConfig = {
  /** The box working copy. `.vault-chat/` lives under it. */
  vault: string;
  /** OpenRouter API base (no trailing slash). */
  baseUrl: string;
  /** Returns the OpenRouter key, read in-process. Never logged. */
  apiKey: () => string | null;
  /** The agent's default model (when a conversation has none). */
  agentModel: string;
  /** Cheap model for roll-over recaps. */
  recapModel: string;
  /** Verifier when the agent is NOT Anthropic; and the one when it is. */
  verifierModel: string;
  verifierModelAlt: string;
  verifierTimeoutMs: number;
  /** Paths the verifier may never read (the key store, the server's state). */
  verifierDeny: string[];
  /** Roll a thread when its context passes min(window × rollFraction, rollMaxTokens). */
  rollFraction: number;
  rollMaxTokens: number;
  /** Builder caps, in characters. */
  caps: { project: number; memory: number; plan: number; progress: number; recap: number };
  fetch: typeof fetch;
};

function defaultApiKey(): string | null {
  const v = keychainCommands.keychain_get({ key: "api.openrouter" });
  return typeof v === "string" && v ? v : null;
}

function defaults(): ContextConfig {
  return {
    vault: "",
    baseUrl: (process.env.VC_OPENROUTER_BASE || "https://openrouter.ai/api/v1").replace(/\/+$/, ""),
    apiKey: defaultApiKey,
    agentModel: "openai/gpt-6.1-sol",
    recapModel: "google/gemini-3.8-flash",
    verifierModel: "anthropic/claude-sonnet-5.5",
    verifierModelAlt: "openai/gpt-6.1-sol",
    verifierTimeoutMs: 90_000,
    verifierDeny: [],
    rollFraction: 0.6,
    rollMaxTokens: 300_000,
    caps: { project: 4_000, memory: 8_000, plan: 4_000, progress: 3_000, recap: 12_000 },
    fetch: (...a) => globalThis.fetch(...a),
  };
}

let cfg: ContextConfig = defaults();

export function configureContext(patch: Partial<ContextConfig>): ContextConfig {
  cfg = { ...cfg, ...patch, caps: { ...cfg.caps, ...(patch.caps ?? {}) } };
  if (patch.baseUrl) cfg.baseUrl = patch.baseUrl.replace(/\/+$/, "");
  return cfg;
}

/** Back to the defaults (tests). */
export function resetContextConfig(): void {
  cfg = defaults();
}

/** A box with several vaults: each vault's engine runs its calls inside
 * withVault(), so CONTEXT reads that vault's `.vault-chat/` (projects, rules,
 * the verifier's working directory) and the verifier is denied the other
 * vaults. Outside it, the configured (main) vault. */
const scope = new AsyncLocalStorage<{ vault: string; deny?: () => string[] }>();
export function withVault<T>(vault: string, fn: () => T, deny?: () => string[]): T {
  return scope.run({ vault, deny }, fn);
}

export function ctxConfig(): ContextConfig {
  const s = scope.getStore();
  if (s) return { ...cfg, vault: s.vault, verifierDeny: [...cfg.verifierDeny, ...(s.deny?.() ?? [])] };
  if (!cfg.vault) throw new Error("context: configureContext({vault}) was not called");
  return cfg;
}
