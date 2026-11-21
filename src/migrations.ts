// Change by asking, for data (reports/07 corrected model, point 4: "data formats, either way: expand -> migrate ->
// contract"). When a change needs a plugin's state in a new shape, the agent proposes the reshape as a migration draft,
// and it goes through the one gate like any draft (Plugins submit):
//
//   .vault-chat/migrations/<name>.draft.js     the draft (an ES module):
//       // @vc-change chat-rows: the plan placement becomes {where, folded}
//       export const plugin = "app/chat-rows";             // whose state: app/<name>, box/<name>, a page's vault path
//       export function migrate(old) { return { ...old }; } // its whole state now -> its whole state after (may be async)
//
//   gate    the box runs migrate on a copy of the plugin's real state (read from the log, nothing written) in a thread
//           of its own (time and memory capped): the dry run. One that throws is dropped; one that passes is kept.
//   Keep    the box backs up the plugin's records and state (outside the vault), runs migrate on the state in effect,
//           and writes one plugin.epoch record (src/pluginRecords.ts) switching the plugin to a new epoch holding the
//           result, then the plugin.change record. Nothing in the log is rewritten or deleted: the old records stay
//           readable, and an older app keeps reading them. The draft file becomes <name>.kept-<version>.js.
//   Discard the draft file is removed.
//   Switch back  another plugin.epoch record: the plugin reads the epoch it left again (the old records; what was
//           written in the migrated epoch stays in the log for a switch forward). A second switch goes forward again.
//
// Id `migrate/<name>`; the records are plugin.change records like every other draft's. Shared by the app, the box and the
// harness: no imports.

export const MIGRATION_DIR = ".vault-chat/migrations";
export const MIGRATION_PREFIX = "migrate/";
const NAME_RE = /^[a-z][a-z0-9-]{0,40}$/;

/** A migration's name from its id (migrate/<name>) or its name, or null. */
export function migrationName(id: string): string | null {
  const m = /^(?:migrate\/)?([^/]+)$/.exec(String(id ?? "").trim());
  return m && NAME_RE.test(m[1]!) ? m[1]! : null;
}
export const migrationId = (name: string): string => MIGRATION_PREFIX + name;
export const isMigrationId = (id: string): boolean => String(id ?? "").startsWith(MIGRATION_PREFIX) && migrationName(id) !== null;

/** The draft's file name and the name a kept draft is moved to. */
export const migrationDraftFile = (name: string): string => `${name}.draft.js`;
export const migrationKeptFile = (name: string, version: string): string => `${name}.kept-${version}.js`;

/** The plugin whose state the draft reshapes (its `export const plugin = "..."`), or null. */
export function migrationTarget(code: string): string | null {
  const m = /export\s+const\s+plugin\s*=\s*(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/.exec(String(code ?? "").slice(0, 8000));
  const t = m ? m[2]!.replace(/\\(.)/g, "$1").trim() : "";
  return t && t.length <= 400 && !/[\u0000-\u001f]/.test(t) && !t.split("/").includes("..") ? t : null;
}

/** The epoch a Keep of this draft writes: unique per keep, readable in the log. */
export const epochName = (name: string, version: string, now: number): string => `${name}@${version}.${now.toString(36)}`;

// ---------------------------------------------------------------- the result's checks and the before / after summary

export const MIGRATION_LIMITS = {
  /** A key: 1..200 characters (a plugin.state key). */
  keyChars: 200,
  /** One value's JSON (a plugin.state value). */
  valueBytes: 64 * 1024,
  /** The whole migrated state: it is one record. */
  stateBytes: 1024 * 1024,
  /** How long migrate may run. */
  ms: 5_000,
  /** Its thread's heap. */
  memMb: 128,
} as const;

const bytes = (s: string): number => new TextEncoder().encode(s).length;

/** migrate's answer as a state (null values dropped: null means "no such key"), or why it is not one. */
export function checkMigrated(out: unknown): { state: Record<string, unknown> } | { error: string } {
  if (!out || typeof out !== "object" || Array.isArray(out)) return { error: "migrate must return the whole new state as an object of keys" };
  let json: string;
  try {
    json = JSON.stringify(out);
  } catch (e) {
    return { error: `the new state is not JSON: ${(e as Error).message}` };
  }
  if (bytes(json) > MIGRATION_LIMITS.stateBytes) return { error: `the new state is over ${MIGRATION_LIMITS.stateBytes} bytes of JSON` };
  const state: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(JSON.parse(json) as Record<string, unknown>)) {
    if (!k || k.length > MIGRATION_LIMITS.keyChars) return { error: `the key "${k.slice(0, 40)}" is not 1 to ${MIGRATION_LIMITS.keyChars} characters` };
    if (v === null || v === undefined) continue;
    if (bytes(JSON.stringify(v)) > MIGRATION_LIMITS.valueBytes) return { error: `the value of "${k}" is over ${MIGRATION_LIMITS.valueBytes} bytes of JSON` };
    state[k] = v;
  }
  return { state };
}

export type MigrationSummary = {
  plugin: string;
  /** The epoch the state was read from ("" : no migration yet). */
  epoch: string;
  before: { keys: number; bytes: number };
  after: { keys: number; bytes: number };
  added: string[];
  removed: string[];
  changed: string[];
  same: number;
  /** A few changed keys, before and after (JSON, cut short). */
  samples: { key: string; before: string | null; after: string | null }[];
};

const short = (v: unknown): string | null => {
  if (v === undefined) return null;
  const s = JSON.stringify(v);
  return s.length > 160 ? `${s.slice(0, 157)}...` : s;
};

/** What a migration does to one state. */
export function summarize(plugin: string, epoch: string, before: Record<string, unknown>, after: Record<string, unknown>): MigrationSummary {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  let same = 0;
  for (const k of Object.keys(after)) {
    if (!(k in before)) added.push(k);
    else if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) changed.push(k);
    else same++;
  }
  for (const k of Object.keys(before)) if (!(k in after)) removed.push(k);
  const samples = [...changed, ...added, ...removed].slice(0, 5).map((key) => ({ key, before: short(before[key]), after: short(after[key]) }));
  return {
    plugin,
    epoch,
    before: { keys: Object.keys(before).length, bytes: bytes(JSON.stringify(before)) },
    after: { keys: Object.keys(after).length, bytes: bytes(JSON.stringify(after)) },
    added,
    removed,
    changed,
    same,
    samples,
  };
}

/** The summary in one line, as the card says it. */
export function summaryLine(s: MigrationSummary): string {
  const parts: string[] = [];
  if (s.changed.length) parts.push(`${s.changed.length} changed`);
  if (s.added.length) parts.push(`${s.added.length} added`);
  if (s.removed.length) parts.push(`${s.removed.length} removed`);
  if (s.same) parts.push(`${s.same} the same`);
  return `${s.before.keys} keys -> ${s.after.keys} keys${parts.length ? ` (${parts.join(", ")})` : ""}`;
}
