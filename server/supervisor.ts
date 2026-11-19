// The supervisor on the box (change 1.6; records and the reconciler in src/pluginSupervisor.ts). The box folds every
// plugin.desired / plugin.budget record of a vault's log, and holds only mechanism:
//   - a stopped plugin gets nothing from the box: no token (server/liveProxy.ts liveToken), no gateway call, and its page
//     is not served (the phone's inline copy, a raw open, its own link /p/<id>/ show the one "turned off" line instead);
//   - it measures each plugin's gateway calls, and when a budget record says too many, writes `stopped` (by "budget");
//   - GET /api/v2/supervisor answers the records (a host folds them itself) and waits for the next (?after=seq&wait=ms);
//     POST /api/v2/supervisor writes Carl's word ({plugin, state, from?, reason?}) or a budget ({plugin, callsPerMinute}),
//     or his word on a draft ({plugin, change: keep | discard | switch, version, reason?}: the record, and the files moved
//     to match, server/pluginDrafts.ts), for app/preset: the app.preset record a kept draft preset becomes, src/appPreset.ts;
//     for app/settings-values: the settings draft's word, written with the settings, server/settings.ts; for
//     migrate/<name>: a migration draft's word, server/migrations.ts).
// What is policy (a disable, an end date, a budget) is only ever a record; the hosts reconcile from the same records.
import { signal, signalLog, type ConvLog } from "./convlog/log";
import { budgetSignal, desiredSignal, offLine, pluginIdOf, Supervisor, type Desired, type SupervisorRecord } from "../src/pluginSupervisor";
import type { LogRecord } from "../src/convlog/protocol";
import { changeSignal, stagedSignal } from "../src/pluginDrafts";
import { landChange, landPreset, slotOf } from "./pluginDrafts";
import { PRESET_PLUGIN_ID, presetSignal, type PresetInEffect } from "../src/appPreset";
import { SETTINGS_DRAFT_ID } from "../src/settingsRecords";
import { readSetting, settingsChange } from "./settings";
import { isMigrationId } from "../src/migrations";
import { migrationChange } from "./migrations";
import { CORE_PART } from "../src/coreBundle";
import { coreLanding, coreStateDir, coreVault } from "./coreBundles";

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

/** The app's preset in effect (src/appPreset.ts): which plugins mount where, plus their settings. */
export function presetInEffect(vault: string): PresetInEffect {
  return supervisorOf(vault).preset();
}

/** Who may be named on a change record: Carl (the app's own Keep), the agent (offers, the scripts, the Plugins tool), an
 *  auto-discard or auto-revert, the draft gate (scripts/draft-check.ts --unasked: a clear pass or fail). */
const CHANGE_BY = new Set(["carl", "agent", "auto", "gate"]);

/**
 * Carl's word on a plugin's draft ({plugin, change, version, reason?}): the slot's files are moved, then the record is
 * written (nothing moved: no record). `by` from the body when it is one the box allows, else `by`.
 */
export function setPluginChange(vault: string, b: Record<string, unknown> | null, by: string): ({ status: 200; seq: number; text: string }) | { status: number; error: string } {
  const who = typeof b?.by === "string" && CHANGE_BY.has(b.by) ? b.by : by;
  const sig = changeSignal(b, who, Date.now());
  if ("error" in sig) return sig;
  const plugin = pluginIdOf(sig.plugin);
  if (isMigrationId(plugin)) return { status: 400, error: `${plugin} is a migration: its word goes through POST /api/v2/supervisor or app/changes (it runs migrate)` };
  if (plugin === SETTINGS_DRAFT_ID) {
    // Carl's settings (server/settings.ts): their draft and his word on it live with the settings, in the main log.
    const c = settingsChange(sig.change, sig.version, who, sig.reason);
    return c.ok ? { status: 200, seq: c.seq, text: c.text } : { status: c.status, error: c.error };
  }
  if (plugin === PRESET_PLUGIN_ID) {
    // The app's preset: its draft file is checked and removed, and the preset it lands is its own record.
    const sup = supervisorOf(vault);
    const landed = landPreset(vault, sig.change, sig.version, sup.preset(), sup.presetBefore());
    if (!landed.ok) return { status: landed.status, error: landed.error };
    followed(signalLog(vault));
    if (landed.preset !== undefined && !signal(vault, presetSignal(landed.preset, landed.version, who, Date.now()))) return { status: 500, error: "the log could not be written" };
    const rec = signal(vault, { ...sig, plugin, version: landed.version, ...(landed.from ? { from: landed.from } : {}) });
    return rec ? { status: 200, seq: rec.seq, text: landed.text } : { status: 500, error: "the log could not be written" };
  }
  if (plugin === CORE_PART) {
    // The app's core bundle (server/coreBundles.ts): nothing moves, the record is the switch; the loaders follow it.
    // Whatever vault the request names, the records are the main vault's (one core for the box).
    const dir = coreStateDir();
    const main = coreVault() ?? vault;
    if (!dir) return { status: 503, error: "this box keeps no core bundles" };
    // Until Carl turns the box's core publishing on, nothing lands as the laptop's core (a switch back still records).
    if (sig.change === "keep" && readSetting("corePublish") !== true) return { status: 409, error: "the box's core publishing is off (Carl's setting corePublish): no core bundle lands" };
    const landed = coreLanding(dir, supervisorOf(main).changes(CORE_PART), sig.change, sig.version);
    if (!landed.ok) return { status: landed.status, error: landed.error };
    followed(signalLog(main));
    const rec = signal(main, { ...sig, plugin, version: landed.version, from: landed.from });
    if (rec) tellAuto(main, plugin, sig.change, landed.version, who, sig.reason, sig.conv);
    return rec ? { status: 200, seq: rec.seq, text: landed.text } : { status: 500, error: "the log could not be written" };
  }
  const slot = slotOf(plugin);
  if (!slot) return { status: 400, error: `${plugin} has no drafts (an app plugin with live copies, or a vault plugin's .js)` };
  const landed = landChange(vault, slot, sig.change, sig.version);
  if (!landed.ok) return { status: landed.status, error: landed.error };
  followed(signalLog(vault));
  const rec = signal(vault, { ...sig, plugin, version: landed.version, ...(landed.from ? { from: landed.from } : {}) });
  if (rec) tellAuto(vault, plugin, sig.change, landed.version, who, sig.reason, sig.conv);
  return rec ? { status: 200, seq: rec.seq, text: landed.text } : { status: 500, error: "the files moved but the log could not be written" };
}

/** The draft gate passed a draft nobody asked for that Carl can see ({plugin, version, what?, conv?}): it may reach him
 *  now (src/pluginDrafts.ts plugin.staged). Only the gate (or the agent) writes it. */
export function setPluginStaged(vault: string, b: Record<string, unknown> | null, by: string): ({ status: 200; seq: number; text: string }) | { status: number; error: string } {
  const sig = stagedSignal(b, by, Date.now());
  if ("error" in sig) return sig;
  const plugin = pluginIdOf(sig.plugin);
  followed(signalLog(vault));
  const rec = signal(vault, { ...sig, plugin });
  return rec ? { status: 200, seq: rec.seq, text: `${plugin} ${sig.version} is staged: Carl sees it as "Try it?" in Main` } : { status: 500, error: "the log could not be written" };
}

/** A change that went back by itself (a switch or discard by "auto"): the chat that asked for it says so. */
function tellAuto(vault: string, plugin: string, change: string, version: string, by: string, reason: string | undefined, conv: string | undefined): void {
  if (by !== "auto" || (change !== "switch" && change !== "discard")) return;
  const sup = supervisorOf(vault);
  const changes = sup.changes(plugin);
  // A switch names what it took away (`from`); a discard, its own version.
  const last = [...changes].reverse().find((c) => c.change === change && c.by === "auto");
  const v = change === "switch" ? (last?.from ?? version) : version;
  if (!v) return;
  void import("./changeNotices").then((m) => m.autoUndone(vault, { plugin, version: v, reason: reason ?? null, conv: conv ?? null }, changes, [...sup.staged(plugin)])).catch(() => {});
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
  if (body && "change" in body && typeof body.plugin === "string" && isMigrationId(pluginIdOf(body.plugin))) {
    // A migration draft (server/migrations.ts): Keep runs migrate (in its own thread), so it answers later.
    const who = typeof body.by === "string" && CHANGE_BY.has(body.by) ? body.by : "carl";
    const m = await migrationChange(vault, body, who);
    return "error" in m ? { status: m.status, body: { error: m.error } } : { status: 200, body: { ok: true, seq: m.seq, text: m.text, ...(m.summary ? { summary: m.summary } : {}) } };
  }
  if (body && body.change === "stage") {
    const who = typeof body.by === "string" && CHANGE_BY.has(body.by) ? body.by : "carl";
    const st = setPluginStaged(vault, body, who);
    return "error" in st ? { status: st.status, body: { error: st.error } } : { status: 200, body: { ok: true, seq: st.seq, text: st.text } };
  }
  const w = body && "change" in body ? setPluginChange(vault, body, "carl") : body && "callsPerMinute" in body ? setPluginBudget(vault, body, "carl") : setPluginDesired(vault, body, "carl");
  if ("error" in w) return { status: w.status, body: { error: w.error } };
  const text = (w as { text?: string }).text;
  return { status: 200, body: { ok: true, seq: w.seq, ...(text ? { text } : {}) } };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** What the box serves instead of a stopped plugin's page: the one line, in the app's colours. */
export function offDocument(plugin: string, d: Desired): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;padding:10px 12px;font:12.5px/1.45 system-ui,sans-serif;color:#9a9a9a;background:transparent}</style></head><body><div data-el="plugin-off" data-vc-plugin="${esc(pluginIdOf(plugin))}">${esc(offLine(plugin, d))}</div></body></html>`;
}
