// A key is a name and a secret, nothing more. Every key Carl adds is the
// agent's to use ("that's why I add them"): every command the agent runs gets
// it as an environment variable named after the key (upper-cased, anything
// that is not a letter, digit or _ becomes _). Nothing here knows a provider.
// Only names are ever shown to a model, never the values.

/**
 * Not a key, though it shares the keychain: Claude Code's sign-in is the box's
 * own credential for running the engine, not a service the agent calls. It goes
 * to the Claude Code process and nowhere else, so leaving it out here is what
 * keeps it out of every command's environment.
 */
export const NOT_FOR_COMMANDS = new Set(["service.claude-code"]);

/** The keychain prefix every key is stored under (`user.<name>`). */
export const KEY_PREFIX = "user.";

/** A key's environment name: its name upper-cased, [^A-Z0-9_] -> _, never starting with a digit. */
export function envName(name: string): string {
  let base = name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  if (/^[0-9]/.test(base)) base = `_${base}`;
  return base;
}

/**
 * The key's name for keychain/store entry `stored`, or null (not a key: the
 * sign-in, internal entries like keystore.passphrase). `user.<name>` is a key's
 * one storage form. Older builds stored a few keys as `api.<x>` / `service.<x>`;
 * those read as `<X>_API_KEY` (the name the same secret had in every command's
 * environment) so a store not yet migrated keeps working.
 */
export function canonicalKeyName(stored: string): string | null {
  if (NOT_FOR_COMMANDS.has(stored)) return null;
  if (stored.startsWith(KEY_PREFIX)) {
    const n = stored.slice(KEY_PREFIX.length);
    return /^[A-Za-z0-9_.-]{1,64}$/.test(n) ? n : null;
  }
  const m = /^(api|service)\.([A-Za-z0-9_.-]{1,64})$/.exec(stored);
  if (!m) return null;
  const base = envName(m[2]!);
  return /_(API_KEY|KEY|TOKEN)$/.test(base) ? base : `${base}_API_KEY`;
}

/** The environment variable for keychain entry `stored`, or null. */
export function envNameForKey(stored: string): string | null {
  const n = canonicalKeyName(stored);
  return n ? envName(n) : null;
}

/** Whether two key names name the same key (they set the same variable). */
export function sameKey(a: string, b: string): boolean {
  return envName(a) === envName(b);
}

/** {ENV_NAME: value} for every key (empty values skipped). A key in its
 *  current form (`user.<name>`) wins over an older entry for the same name. */
export function keyEnv(entries: Iterable<[string, string]>): Record<string, string> {
  const out: Record<string, string> = {};
  const current = new Set<string>();
  for (const [stored, value] of entries) {
    if (!value) continue;
    const env = envNameForKey(stored);
    if (!env) continue;
    const isCurrent = stored.startsWith(KEY_PREFIX);
    if (env in out && current.has(env) && !isCurrent) continue;
    out[env] = value;
    if (isCurrent) current.add(env);
  }
  return out;
}

/** The value of key `name` among stored entries, by name (any spelling that sets the same variable), or null. */
export function keyValueIn(entries: Iterable<[string, string]>, name: string): string | null {
  return keyEnv(entries)[envName(name)] || null;
}
