// Plugin records (change 1.2 of the plugin refactor): what a page's `state` and `log` services write into the one log.
// A plugin is identified by its id, for now the page's vault path (the path its token is scoped to). Its records are
// vault-level signals in the box's feed (server/convlog/log.ts, `_signals.jsonl`), so they live where every other
// record lives and every view of the plugin reads the same thing:
//
//   {type: "plugin.state", plugin, key, value}   one key of the plugin's own state set (value null: the key removed)
//   {type: "plugin.log",   plugin, record}       a record the plugin appended (what it did, for the agent to read)
//
// A plugin's state is a fold of its plugin.state records, newest last. Shared by the box (server/pluginState.ts) and
// the preview harness's fake box: no imports.
//
// A migration (src/migrations.ts, change by asking for data) reshapes a plugin's state without touching what is there:
// expand / contract. Keep writes one record that switches the plugin to a new epoch with the migrated state, and from
// then on the box writes that plugin's sets as epoch records; Switch back is another switch record naming the epoch it
// left (its state as the box last had it). The old plugin.state records stay in the log and are never rewritten, so a
// reader that knows no epochs (an older app or phone) keeps reading the old shape, and switching back reads it again.
//
//   {type: "plugin.epoch",       plugin, epoch, from, state, migration?, version?, by?}   the epoch in effect from here
//   {type: "plugin.epoch.state", plugin, epoch, key, value}                               one key set within an epoch
//
// "" is the epoch of every plain plugin.state record (no migration ever). A fold applies a record only to the epoch in
// effect; the box also keeps the other epochs (`others`) so it can switch back to one.

export const PLUGIN_STATE = "plugin.state";
export const PLUGIN_LOG = "plugin.log";
export const PLUGIN_EPOCH = "plugin.epoch";
export const PLUGIN_EPOCH_STATE = "plugin.epoch.state";

export const PLUGIN_LIMITS = {
  /** A state key: 1..200 characters. */
  keyChars: 200,
  /** The most JSON bytes one state value or one log record takes. */
  valueBytes: 64 * 1024,
  /** The most writes (state sets and log appends) one plugin makes a minute, on the box. */
  writesPerMinute: 300,
  /** The longest a subscribe waits for a change before it answers with what is there. */
  waitMs: 25_000,
} as const;

export type PluginStateSignal = { type: typeof PLUGIN_STATE; plugin: string; key: string; value: unknown };
export type PluginLogSignal = { type: typeof PLUGIN_LOG; plugin: string; record: unknown };
export type PluginEpochSignal = { type: typeof PLUGIN_EPOCH; plugin: string; epoch: string; from: string; state: Record<string, unknown>; migration?: string; version?: string; by?: string; /** written by a Keep (not a switch) */ kept?: boolean };
export type PluginEpochStateSignal = { type: typeof PLUGIN_EPOCH_STATE; plugin: string; epoch: string; key: string; value: unknown };
/** A plugin's state as its views see it: the keys and the seq of the last record that changed them (0: none yet);
 *  `epoch`: the migration epoch in effect (absent: none, the plain plugin.state records). */
export type PluginState = { seq: number; state: Record<string, unknown>; epoch?: string };
/** The epochs not in effect, kept by the box to switch back to (key: plugin + "\u0000" + epoch). */
export type OtherEpochs = Map<string, PluginState>;
export const epochKey = (plugin: string, epoch: string): string => `${plugin}\u0000${epoch}`;
/** Whether a vault-level signal is one of a plugin's state records (plain, epoch, or an epoch switch). */
export const isStateSignalType = (t: unknown): boolean => t === PLUGIN_STATE || t === PLUGIN_EPOCH_STATE || t === PLUGIN_EPOCH;

type Bad = { error: string; status: number };

const bytes = (s: string): number => new TextEncoder().encode(s).length;

/** The JSON a page sent, or an error (400, 413). */
function parse(body: string): { value: unknown } | Bad {
  if (bytes(body) > PLUGIN_LIMITS.valueBytes + 1024) return { status: 413, error: `at most ${PLUGIN_LIMITS.valueBytes} bytes of JSON` };
  try {
    return { value: JSON.parse(body || "null") };
  } catch {
    return { status: 400, error: "bad JSON" };
  }
}

/** The signal a state set becomes (`{key, value}`; value null or absent: remove the key), or why not. */
export function stateSignal(plugin: string, body: string): PluginStateSignal | Bad {
  const p = parse(body);
  if ("error" in p) return p;
  const b = p.value as { key?: unknown; value?: unknown } | null;
  if (!b || typeof b !== "object" || Array.isArray(b)) return { status: 400, error: "send {key, value}" };
  if (typeof b.key !== "string" || !b.key || b.key.length > PLUGIN_LIMITS.keyChars) return { status: 400, error: `a key is a string of 1 to ${PLUGIN_LIMITS.keyChars} characters` };
  const value = b.value === undefined ? null : b.value;
  if (bytes(JSON.stringify(value)) > PLUGIN_LIMITS.valueBytes) return { status: 413, error: `a value is at most ${PLUGIN_LIMITS.valueBytes} bytes of JSON` };
  return { type: PLUGIN_STATE, plugin, key: b.key, value };
}

/** The signal a log append becomes (the body is the record, any JSON), or why not. */
export function logSignal(plugin: string, body: string): PluginLogSignal | Bad {
  const p = parse(body);
  if ("error" in p) return p;
  if (bytes(JSON.stringify(p.value)) > PLUGIN_LIMITS.valueBytes) return { status: 413, error: `a record is at most ${PLUGIN_LIMITS.valueBytes} bytes of JSON` };
  return { type: PLUGIN_LOG, plugin, record: p.value };
}

/** Fold one record of the log into the plugins' states (only plugin.state / plugin.epoch.state / plugin.epoch signals
 *  change anything): whether the state in effect changed. `others` (the box's): the epochs not in effect, kept so a
 *  switch back has them; without it (a window, the phone) a record of another epoch is ignored and a switch takes the
 *  state its record carries. */
export function foldPluginState(states: Map<string, PluginState>, rec: { seq: number; type?: unknown; signal?: unknown }, others?: OtherEpochs): boolean {
  const s = rec.type === "signal" ? (rec.signal as Record<string, unknown> | undefined) : undefined;
  if (!s || typeof s.plugin !== "string") return false;
  const plugin = s.plugin;
  const cur = states.get(plugin) ?? { seq: 0, state: {} };
  const active = cur.epoch ?? "";
  if (s.type === PLUGIN_EPOCH) {
    if (typeof s.epoch !== "string" || !s.state || typeof s.state !== "object" || Array.isArray(s.state)) return false;
    if (others) {
      if (s.epoch !== active) others.set(epochKey(plugin, active), { ...cur, state: { ...cur.state } });
      others.delete(epochKey(plugin, s.epoch));
    }
    states.set(plugin, { seq: rec.seq, state: { ...(s.state as Record<string, unknown>) }, ...(s.epoch ? { epoch: s.epoch } : {}) });
    return true;
  }
  let epoch: string;
  if (s.type === PLUGIN_STATE) epoch = "";
  else if (s.type === PLUGIN_EPOCH_STATE && typeof s.epoch === "string" && s.epoch) epoch = s.epoch;
  else return false;
  if (typeof s.key !== "string") return false;
  const set = (into: PluginState): PluginState => {
    const state = { ...into.state };
    if (s.value === null || s.value === undefined) delete state[s.key as string];
    else state[s.key as string] = s.value;
    return { ...into, seq: rec.seq, state };
  };
  if (epoch !== active) {
    // Another epoch's record: the box keeps it (a switch back reads it); a window has no use for it.
    if (others) others.set(epochKey(plugin, epoch), set(others.get(epochKey(plugin, epoch)) ?? { seq: 0, state: {}, ...(epoch ? { epoch } : {}) }));
    return false;
  }
  states.set(plugin, set(cur));
  return true;
}

/** The read side of `GET /api/v2/plugin/state?after=N&wait=MS`: answer now, or wait (and for how long). */
export function stateQuery(query: string): { after: number | null; wait: number } {
  const q = new URLSearchParams(query);
  const a = q.get("after");
  const after = a !== null && a !== "" && Number.isFinite(Number(a)) ? Math.trunc(Number(a)) : null;
  const w = Number(q.get("wait"));
  return { after, wait: Number.isFinite(w) ? Math.max(0, Math.min(Math.trunc(w), PLUGIN_LIMITS.waitMs)) : 0 };
}
