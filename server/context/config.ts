// CONTEXT's settings. ENGINE calls configureContext() once at boot; tests point
// it at temp vaults. Every function also works with the defaults, except that
// `vault` must be set.
import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";

export type ContextConfig = {
  /** The box working copy. `.vault-chat/` lives under it. */
  vault: string;
  /** The agent's default model (when a conversation has none). */
  agentModel: string;
  /** The fast model (one-shots: a note's title, spoken math). */
  recapModel: string;
  /** The projects home (server/projectsHome.ts): every project, whatever vault is open. "": none configured. */
  projectsHome: string;
  /** Until `projects migrate` has run on this box (server/projectsMigrate.ts): each vault's projects stay where they
   *  were (<vault>/agent-projects/, its own registry and log), so an update never hides them before the move. */
  legacyProjects?: boolean;
  /** Builder caps, in characters: a project's shared notes (project.md) and an older roll-over's recap. */
  caps: { project: number; recap: number };
};

function defaults(): ContextConfig {
  return {
    vault: "",
    projectsHome: "",
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

/** The projects home (the same whatever vault a call runs in); throws when none is configured. */
export function projectsRoot(): string {
  if (cfg.legacyProjects) return join(ctxConfig().vault, "agent-projects");
  const h = cfg.projectsHome;
  if (!h) throw new Error("no projects home is configured (server/projectsHome.ts)");
  return h;
}

/** Whether a projects home is configured. */
export function hasProjectsHome(): boolean {
  return !!cfg.projectsHome || !!cfg.legacyProjects;
}
