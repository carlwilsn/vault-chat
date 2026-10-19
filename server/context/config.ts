// CONTEXT's settings. ENGINE calls configureContext() once at boot; tests point
// it at temp vaults. Every function also works with the defaults, except that
// `vault` must be set.
import { AsyncLocalStorage } from "node:async_hooks";

export type ContextConfig = {
  /** The box working copy. `.vault-chat/` lives under it. */
  vault: string;
  /** The agent's default model (when a conversation has none). */
  agentModel: string;
  /** The fast model (one-shots: a note's title, spoken math). */
  recapModel: string;
  /** Builder caps, in characters: a project's shared notes (project.md) and an older roll-over's recap. */
  caps: { project: number; recap: number };
};

function defaults(): ContextConfig {
  return {
    vault: "",
    agentModel: "openai/gpt-6.1-sol",
    recapModel: "google/gemini-3.8-flash",
    caps: { project: 8_000, recap: 12_000 },
  };
}

let cfg: ContextConfig = defaults();

export function configureContext(patch: Partial<ContextConfig>): ContextConfig {
  cfg = { ...cfg, ...patch, caps: { ...cfg.caps, ...(patch.caps ?? {}) } };
  return cfg;
}

/** Back to the defaults (tests). */
export function resetContextConfig(): void {
  cfg = defaults();
}

/** A box with several vaults: each vault's engine runs its calls inside
 * withVault(), so CONTEXT reads that vault's `.vault-chat/` (projects, rules).
 * Outside it, the configured (main) vault. */
const scope = new AsyncLocalStorage<{ vault: string }>();
export function withVault<T>(vault: string, fn: () => T): T {
  return scope.run({ vault }, fn);
}

export function ctxConfig(): ContextConfig {
  const s = scope.getStore();
  if (s) return { ...cfg, vault: s.vault };
  if (!cfg.vault) throw new Error("context: configureContext({vault}) was not called");
  return cfg;
}
