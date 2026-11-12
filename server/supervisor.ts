// The supervisor on the box (change 1.6; records and the reconciler in src/pluginSupervisor.ts). The box folds every
// plugin.desired / plugin.budget record of a vault's log, and holds only mechanism:
//   - a stopped plugin gets nothing from the box: no token (server/liveProxy.ts liveToken), no gateway call, and its page
//     is not served (the phone's inline copy, a raw open, its own link /p/<id>/ show the one "turned off" line instead);
//   - it measures each plugin's gateway calls, and when a budget record says too many, writes `stopped` (by "budget");
//   - GET /api/v2/supervisor answers the records (a host folds them itself) and waits for the next (?after=seq&wait=ms);
//     POST /api/v2/supervisor writes Carl's word ({plugin, state, from?, reason?}) or a budget ({plugin, callsPerMinute}).
// What is policy (a disable, an end date, a budget) is only ever a record; the hosts reconcile from the same records.
import { signal, signalLog, type ConvLog } from "./convlog/log";
import { budgetSignal, desiredSignal, offLine, pluginIdOf, Supervisor, type Desired, type SupervisorRecord } from "../src/pluginSupervisor";
import type { LogRecord } from "../src/convlog/protocol";

type Followed = { sup: Supervisor; changed: Set<() => void> };
const follows = new WeakMap<ConvLog, Followed>();

function followed(log: ConvLog): Followed {
  let f = follows.get(log);
  if (f) return f;
  const sup = new Supervisor();
  const changed = new Set<() => void>();
  f = { sup, changed };
  follows.set(log, f);
  log.onRecord((r: LogRecord) => {
    if (r.conv === null && sup.fold(r)) for (const fn of [...changed]) fn();
  });
  for (const r of log.signals(0)) sup.fold(r);
  return f;
}

/** The vault's supervisor (its records folded, kept up to date from the log). */
export function supervisorOf(vault: string): Supervisor {
  return followed(signalLog(vault)).sup;
}

/** What the plugin should be now. */
export function pluginDesired(vault: string, plugin: string, now = Date.now()): Desired {
  return supervisorOf(vault).desired(plugin, now);
}

/** Whether the plugin is stopped now (then the box gives it nothing). */
export function pluginStopped(vault: string, plugin: string): boolean {
  return pluginDesired(vault, plugin).state === "stopped";
}

type Written = { status: 200; seq: number } | { status: number; error: string };

function write(vault: string, sig: ReturnType<typeof desiredSignal> | ReturnType<typeof budgetSignal>): Written {
  if ("error" in sig) return sig;
  followed(signalLog(vault)); // the fold follows the log before this record is written
  const rec = signal(vault, sig);
  return rec ? { status: 200, seq: rec.seq } : { status: 500, error: "the log could not be written" };
}

/** Write a desired-state word ({plugin, state, from?, reason?}) as `by`. */
export function setPluginDesired(vault: string, b: Record<string, unknown> | null, by: string): Written {
  return write(vault, desiredSignal(b, by, Date.now()));
}

/** Write a budget ({plugin, callsPerMinute | null}) as `by`. */
export function setPluginBudget(vault: string, b: Record<string, unknown> | null, by: string): Written {
  return write(vault, budgetSignal(b, by, Date.now()));
}

/** Each plugin's gateway calls in the last minute (vault + plugin → times). */
const calls = new Map<string, number[]>();

/**
 * Measure one gateway call of the plugin. Over its budget (a plugin.budget record), the budget's word is written:
 * `stopped`, by "budget". Returns whether the call may go on (false: the plugin is stopped now).
 */
export function measurePluginCall(vault: string, plugin: string, now = Date.now()): boolean {
  const id = pluginIdOf(plugin);
  const sup = supervisorOf(vault);
  if (sup.desired(id, now).state === "stopped") return false;
  const key = `${vault}\u0000${id}`;
  const times = (calls.get(key) ?? []).filter((t) => now - t < 60_000);
  times.push(now);
  calls.set(key, times);
  const limit = sup.budget(id);
  if (limit === null || times.length <= limit) return true;
  calls.delete(key);
  setPluginDesired(vault, { plugin: id, state: "stopped", reason: `over its budget of ${limit} calls a minute` }, "budget");
  return false;
}

/** The records after `after` (all with null), at once when there are some, else when the next comes or after `waitMs`. */
export function supervisorRecords(vault: string, after: number | null, waitMs: number): Promise<{ seq: number; records: SupervisorRecord[] }> {
  const f = followed(signalLog(vault));
  const now = () => ({ seq: f.sup.seq, records: f.sup.records().filter((r) => after === null || r.seq > after) });
  if (after === null || waitMs <= 0 || f.sup.seq > after) return Promise.resolve(now());
  return new Promise((resolve) => {
    const done = () => {
      if (f.sup.seq <= after) return;
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

export type RouteOut = { status: number; body: unknown };

/** GET/POST /api/v2/supervisor (Carl's devices: the box's own auth has passed). */
export async function supervisorRoute(vault: string, method: string, query: URLSearchParams, body: Record<string, unknown> | null): Promise<RouteOut> {
  if (method === "GET") {
    const a = query.get("after");
    const after = a !== null && a !== "" && Number.isFinite(Number(a)) ? Math.trunc(Number(a)) : null;
    const w = Number(query.get("wait"));
    return { status: 200, body: await supervisorRecords(vault, after, Number.isFinite(w) ? Math.max(0, Math.min(Math.trunc(w), 25_000)) : 0) };
  }
  if (method !== "POST") return { status: 405, body: { error: "GET or POST" } };
  const w = body && "callsPerMinute" in body ? setPluginBudget(vault, body, "carl") : setPluginDesired(vault, body, "carl");
  return "error" in w ? { status: w.status, body: { error: w.error } } : { status: 200, body: { ok: true, seq: w.seq } };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** What the box serves instead of a stopped plugin's page: the one line, in the app's colours. */
export function offDocument(plugin: string, d: Desired): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;padding:10px 12px;font:12.5px/1.45 system-ui,sans-serif;color:#9a9a9a;background:transparent}</style></head><body><div data-el="plugin-off" data-vc-plugin="${esc(pluginIdOf(plugin))}">${esc(offLine(plugin, d))}</div></body></html>`;
}
