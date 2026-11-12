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

/** The plugin's state now. */
export function readPluginState(vault: string, plugin: string): PluginState {
  return folded(signalLog(vault)).states.get(plugin) ?? { seq: 0, state: {} };
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

function write(vault: string, sig: ReturnType<typeof stateSignal> | ReturnType<typeof logSignal>): Written {
  if ("error" in sig) return sig;
  folded(signalLog(vault)); // the fold follows the log before this record is written
  const rec = signal(vault, sig);
  return rec ? { status: 200, seq: rec.seq } : { status: 500, error: "the log could not be written" };
}

/** Set one key of the plugin's state (`{key, value}`): a plugin.state record. */
export function setPluginState(vault: string, plugin: string, body: string): Written {
  return write(vault, stateSignal(plugin, body));
}

/** Append one record (the body, any JSON) to the log for the plugin: a plugin.log record. */
export function appendPluginLog(vault: string, plugin: string, body: string): Written {
  return write(vault, logSignal(plugin, body));
}
