// The keys Carl adds to vault-chat are the agent's to use ("that's why I add
// them"): every command the agent runs gets them as environment variables.
// Names map to the conventional variables; a user key keeps its own name.
// Only names are ever shown to a model — never the values.

const FIXED: Record<string, string> = {
  "api.openrouter": "OPENROUTER_API_KEY",
  "api.anthropic": "ANTHROPIC_API_KEY",
  "api.openai": "OPENAI_API_KEY",
  "api.google": "GOOGLE_API_KEY",
  "service.tavily": "TAVILY_API_KEY",
  "service.elevenlabs": "ELEVENLABS_API_KEY",
};

/** The environment variable for keychain entry `name`, or null (internal entries like keystore.passphrase). */
export function envNameForKey(name: string): string | null {
  if (FIXED[name]) return FIXED[name]!;
  const m = /^(api|service|user)\.([A-Za-z0-9_.-]{1,64})$/.exec(name);
  if (!m) return null;
  let base = m[2]!.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  if (/^[0-9]/.test(base)) base = `_${base}`;
  // api.<provider> / service.<name>: the usual <NAME>_API_KEY; user.<name>: its own name.
  if (m[1] === "user") return base;
  return base.endsWith("_API_KEY") || base.endsWith("_KEY") || base.endsWith("_TOKEN") ? base : `${base}_API_KEY`;
}

/** {ENV_NAME: value} for every usable key (empty values skipped). A later
 *  entry never overrides a fixed name's (api.openrouter wins OPENROUTER_API_KEY). */
export function keyEnv(entries: Iterable<[string, string]>): Record<string, string> {
  const out: Record<string, string> = {};
  const fixedSet = new Set<string>();
  for (const [name, value] of entries) {
    if (!value) continue;
    const env = envNameForKey(name);
    if (!env) continue;
    const fixed = !!FIXED[name];
    if (env in out && fixedSet.has(env) && !fixed) continue;
    out[env] = value;
    if (fixed) fixedSet.add(env);
  }
  return out;
}
