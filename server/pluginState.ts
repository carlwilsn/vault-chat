// A plugin's `state` and `log` services on the box (change 1.2; record shapes in src/pluginRecords.ts). Both write
// records into the one log, as vault-level signals of the vault the page is in; a plugin's state is the fold of its
// plugin.state records, read once from the log's signals file and then kept up to date from the log's own records.
// The gateway (server/liveProxy.ts) calls these with the plugin id from the page's token, never from the page's body.
import { signal, signalLog, type ConvLog } from "./convlog/log";
import { foldPluginState, logSignal, stateSignal, type PluginState } from "../src/pluginRecords";
import type { LogRecord } from "../src/convlog/protocol";

type Folded = { states: Map<string, PluginState>; changed: Set<() => void> };
const folds = new WeakMap<ConvLog, Folded>();

function folded(log: ConvLog): Folded {
  let f = folds.get(log);
  if (f) return f;
  const states = new Map<string, PluginState>();
  const changed = new Set<() => void>();
  f = { states, changed };
  folds.set(log, f);
  log.onRecord((r: LogRecord) => {
    if (r.conv === null && foldPluginState(states, r)) for (const fn of [...changed]) fn();
  });
  for (const r of log.signals(0)) foldPluginState(states, r);
  return f;
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

type Written = { status: 200; seq: number } | { status: number; error: string };

function write(vault: string, sig: ReturnType<typeof stateSignal> | ReturnType<typeof logSignal>, log?: ConvLog): Written {
  if ("error" in sig) return sig;
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

/** An app plugin's id ("app/<name>", src/appPlugins.ts): the only state Carl's devices write without a page's token. */
const APP_PLUGIN_RE = /^app\/[a-z][a-z0-9-]{0,40}$/;

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
  if (!APP_PLUGIN_RE.test(plugin)) return { status: 400, body: { error: "name an app plugin: app/<name>" } };
  if (method === "GET") return { status: 200, body: readPluginState(vault, plugin, log) };
  if (method !== "POST") return { status: 405, body: { error: "GET or POST" } };
  const w = write(vault, stateSignal(plugin, JSON.stringify({ key: body?.key, value: body?.value ?? null })), log);
  return "error" in w ? { status: w.status, body: { error: w.error } } : { status: 200, body: { ok: true, ...readPluginState(vault, plugin, log), seq: w.seq } };
}
