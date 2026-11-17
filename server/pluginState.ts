// A plugin's `state` and `log` services on the box (change 1.2; record shapes in src/pluginRecords.ts). Both write
// records into the one log, as vault-level signals of the vault the page is in; a plugin's state is the fold of its
// plugin.state records, read once from the log's signals file and then kept up to date from the log's own records.
// The gateway (server/liveProxy.ts) calls these with the plugin id from the page's token, never from the page's body.
import { signal, signalLog, type ConvLog } from "./convlog/log";
import { PLUGIN_EPOCH_STATE, PLUGIN_LOG, epochKey, foldPluginState, isStateSignalType, logSignal, stateSignal, type OtherEpochs, type PluginEpochSignal, type PluginState, type PluginStateSignal } from "../src/pluginRecords";
import type { LogRecord } from "../src/convlog/protocol";

/** One plugin.log record as the agent reads it. */
export type PluginLogEntry = { seq: number; at: number; record: unknown };
/** What the box knows of one plugin without its page being open: its last record (state or log) and its recent log. */
export type PluginActivity = { seq: number; at: number; logs: PluginLogEntry[]; logCount: number };

type Folded = { states: Map<string, PluginState>; others: OtherEpochs; activity: Map<string, PluginActivity>; changed: Set<() => void> };
const folds = new WeakMap<ConvLog, Folded>();

/** The most recent plugin.log records kept per plugin for PluginRead. */
export const RECENT_LOGS = 20;

/** Fold one record into the plugins' activity (their last record and recent log): whether it was a plugin's. */
function foldActivity(activity: Map<string, PluginActivity>, r: LogRecord): boolean {
  const s = r.type === "signal" ? ((r as { signal?: unknown }).signal as { type?: unknown; plugin?: unknown; record?: unknown } | undefined) : undefined;
  if (!s || typeof s.plugin !== "string" || (s.type !== PLUGIN_LOG && !isStateSignalType(s.type))) return false;
  const a = activity.get(s.plugin) ?? { seq: 0, at: 0, logs: [], logCount: 0 };
  a.seq = r.seq;
  a.at = typeof r.at === "number" ? r.at : a.at;
  if (s.type === PLUGIN_LOG) {
    a.logs.push({ seq: r.seq, at: a.at, record: s.record ?? null });
    if (a.logs.length > RECENT_LOGS) a.logs.splice(0, a.logs.length - RECENT_LOGS);
    a.logCount++;
  }
  activity.set(s.plugin, a);
  return true;
}

function folded(log: ConvLog): Folded {
  let f = folds.get(log);
  if (f) return f;
  const states = new Map<string, PluginState>();
  const activity = new Map<string, PluginActivity>();
  const others: OtherEpochs = new Map();
  const changed = new Set<() => void>();
  f = { states, others, activity, changed };
  folds.set(log, f);
  log.onRecord((r: LogRecord) => {
    if (r.conv !== null) return;
    const s = foldPluginState(states, r, others);
    if (foldActivity(activity, r) || s) for (const fn of [...changed]) fn();
  });
  for (const r of log.signals(0)) {
    foldPluginState(states, r, others);
    foldActivity(activity, r);
  }
  return f;
}

/** A page's (or any plugin's) records as the box keeps them: its state, its last change and its recent log. */
export function readPluginRecords(vault: string, plugin: string, log: ConvLog = signalLog(vault)): PluginState & PluginActivity {
  const f = folded(log);
  const st = f.states.get(plugin) ?? { seq: 0, state: {} };
  const a = f.activity.get(plugin) ?? { seq: 0, at: 0, logs: [], logCount: 0 };
  return { state: st.state, seq: a.seq, at: a.at, logs: [...a.logs], logCount: a.logCount };
}

/** Every plugin with records in the log (state or log), by id, with its last change; app plugins and note widgets left out. */
export function pagesWithRecords(vault: string, log: ConvLog = signalLog(vault)): { id: string; seq: number; at: number; keys: string[]; logCount: number }[] {
  const f = folded(log);
  return [...f.activity]
    .filter(([id]) => !APP_PLUGIN_RE.test(id))
    .map(([id, a]) => ({ id, seq: a.seq, at: a.at, keys: Object.keys(f.states.get(id)?.state ?? {}), logCount: a.logCount }))
    .sort((x, y) => y.seq - x.seq);
}

/** A plugin's records once something of it (a state set or a log record) is newer than `after`, or as they are after `waitMs`. */
export function awaitPluginRecords(vault: string, plugin: string, after: number, waitMs: number, log: ConvLog = signalLog(vault)): Promise<PluginState & PluginActivity> {
  const f = folded(log);
  const now = () => readPluginRecords(vault, plugin, log);
  if (waitMs <= 0 || now().seq > after) return Promise.resolve(now());
  return new Promise((resolve) => {
    const done = () => {
      if (now().seq <= after) return;
      clearTimeout(t);
      f.changed.delete(done);
      resolve(now());
    };
    const t = setTimeout(() => {
      f.changed.delete(done);
      resolve(now());
    }, waitMs);
    t.unref?.();
    f.changed.add(done);
  });
}

/** The plugin's state now (on `log`, default the vault's). */
export function readPluginState(vault: string, plugin: string, log: ConvLog = signalLog(vault)): PluginState {
  return folded(log).states.get(plugin) ?? { seq: 0, state: {} };
}

/** The plugin's state once its seq is not `after` (at once when it already differs), or as it is after `waitMs`. */
export function awaitPluginState(vault: string, plugin: string, after: number | null, waitMs: number): Promise<PluginState> {
  const f = folded(signalLog(vault));
  const now = () => f.states.get(plugin) ?? { seq: 0, state: {} };
  if (after === null || waitMs <= 0 || now().seq !== after) return Promise.resolve(now());
  return new Promise((resolve) => {
    const done = () => {
      if (now().seq === after) return;
      clearTimeout(t);
      f.changed.delete(done);
      resolve(now());
    };
    const t = setTimeout(() => {
      f.changed.delete(done);
      resolve(now());
    }, waitMs);
    t.unref?.();
    f.changed.add(done);
  });
}

/** The state of `plugin` in an epoch not in effect (as the box last had it), or null when the box has none. */
export function otherEpochState(vault: string, plugin: string, epoch: string, log: ConvLog = signalLog(vault)): PluginState | null {
  const f = folded(log);
  if ((f.states.get(plugin)?.epoch ?? "") === epoch) return f.states.get(plugin) ?? { seq: 0, state: {} };
  return f.others.get(epochKey(plugin, epoch)) ?? (epoch === "" ? { seq: 0, state: {} } : null);
}

/** Write an epoch switch (server/migrations.ts): the plugin's state in effect becomes the record's. */
export function writeEpoch(vault: string, sig: PluginEpochSignal, log?: ConvLog): Written {
  return write(vault, sig, log);
}

type Written = { status: 200; seq: number } | { status: number; error: string };

function write(vault: string, sig: ReturnType<typeof stateSignal> | ReturnType<typeof logSignal> | PluginEpochSignal, log?: ConvLog): Written {
  if ("error" in sig) return sig;
  // A set of a plugin whose state was migrated goes to the epoch in effect; the plain records stay as they were.
  if (sig.type === "plugin.state") {
    const ep = folded(log ?? signalLog(vault)).states.get(sig.plugin)?.epoch;
    if (ep) sig = { type: PLUGIN_EPOCH_STATE, plugin: sig.plugin, epoch: ep, key: (sig as PluginStateSignal).key, value: (sig as PluginStateSignal).value } as unknown as PluginStateSignal;
  }
  if (!log) {
    folded(signalLog(vault)); // the fold follows the log before this record is written
    const rec = signal(vault, sig);
    return rec ? { status: 200, seq: rec.seq } : { status: 500, error: "the log could not be written" };
  }
  folded(log);
  try {
    return { status: 200, seq: log.emit(null, { type: "signal", signal: sig }).seq };
  } catch {
    return { status: 500, error: "the log could not be written" };
  }
}

/** Set one key of the plugin's state (`{key, value}`): a plugin.state record. */
export function setPluginState(vault: string, plugin: string, body: string): Written {
  return write(vault, stateSignal(plugin, body));
}

/** Append one record (the body, any JSON) to the log for the plugin: a plugin.log record. */
export function appendPluginLog(vault: string, plugin: string, body: string): Written {
  return write(vault, logSignal(plugin, body));
}

// ---------------------------------------------------------------- the app's own plugins

/** An app plugin's id ("app/<name>", src/appPlugins.ts) or a note widget's ("widget:<note>#<widget>", src/noteWidgets.ts):
 *  the only state Carl's devices write without a page's token. */
const APP_PLUGIN_RE = /^(?:app\/[a-z][a-z0-9-]{0,40}|widget:[^\u0000-\u001f]{1,400})$/;

/**
 * GET /api/v2/plugin/app-state → every app plugin's state ({states: {id: {seq, state}}}); ?plugin=app/<name> → that
 * one's ({seq, state}); POST {plugin, key, value}
 * sets one key (value null: removed), a plugin.state record like a page's, so every window that runs the app plugin
 * follows it on the feed and it survives a restart. Carl's devices only (the box's own auth has passed); a page sets its
 * own state through its token (server/liveProxy.ts), never an app plugin's.
 */
export function appPluginStateRoute(vault: string, method: string, query: URLSearchParams, body: Record<string, unknown> | null, log?: ConvLog): { status: number; body: unknown } {
  if (method === "GET" && !query.has("plugin")) {
    const all = folded(log ?? signalLog(vault)).states;
    return { status: 200, body: { states: Object.fromEntries([...all].filter(([id]) => APP_PLUGIN_RE.test(id))) } };
  }
  const plugin = method === "GET" ? String(query.get("plugin") ?? "") : String(body?.plugin ?? "");
  if (!APP_PLUGIN_RE.test(plugin)) return { status: 400, body: { error: "name an app plugin (app/<name>) or a note widget (widget:<note>#<widget>)" } };
  if (method === "GET") return { status: 200, body: readPluginState(vault, plugin, log) };
  if (method !== "POST") return { status: 405, body: { error: "GET or POST" } };
  const w = write(vault, stateSignal(plugin, JSON.stringify({ key: body?.key, value: body?.value ?? null })), log);
  return "error" in w ? { status: w.status, body: { error: w.error } } : { status: 200, body: { ok: true, ...readPluginState(vault, plugin, log), seq: w.seq } };
}
