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

export const PLUGIN_STATE = "plugin.state";
export const PLUGIN_LOG = "plugin.log";

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
/** A plugin's state as its views see it: the keys and the seq of the last record that changed them (0: none yet). */
export type PluginState = { seq: number; state: Record<string, unknown> };

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

/** Fold one record of the log into the plugins' states (only plugin.state signals change anything): whether it did. */
export function foldPluginState(states: Map<string, PluginState>, rec: { seq: number; type?: unknown; signal?: unknown }): boolean {
  const s = rec.type === "signal" ? (rec.signal as Partial<PluginStateSignal> | undefined) : undefined;
  if (!s || s.type !== PLUGIN_STATE || typeof s.plugin !== "string" || typeof s.key !== "string") return false;
  const cur = states.get(s.plugin) ?? { seq: 0, state: {} };
  const state = { ...cur.state };
  if (s.value === null || s.value === undefined) delete state[s.key];
  else state[s.key] = s.value;
  states.set(s.plugin, { seq: rec.seq, state });
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
