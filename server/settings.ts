// Carl's settings on the box (record shapes in src/settingsRecords.ts): `setting` signals in the main vault's log, and
// the settings are their fold, read once from the log's signals file and then kept up to date from the log's own
// records (like a plugin's state, server/pluginState.ts). One source of truth: the engine's model and effort, the
// voice a call speaks with and the automatic-push switch read it here; the laptop, the phone and the agent's Settings
// tool write it here. Every record is also a signal on every feed, so an open app and the phone follow at once.
//
// The agent's own idea for a setting is a draft (setting.draft) that waits for Carl as Change ready; his Keep, Discard
// and Switch back are setting.change records, a keep and a switch also the setting records they set (draftSettings,
// settingsChange; POST /api/v2/settings {change, version} and the supervisor's route for app/settings-values).
//
// Before this, those four lived in the box's localStorage file. migrateSettings moves them, once: what it moves is
// first written to a backup file (outside the vault), then becomes records, then leaves the old file.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConvLog } from "./convlog/log";
import type { LogRecord } from "../src/convlog/protocol";
import { landing, versionOf } from "../src/pluginDrafts";
import {
  SETTING,
  SETTING_CHANGE,
  SETTING_DRAFT,
  SETTINGS,
  SETTING_KEYS,
  canonicalValues,
  describeValues,
  draftVersion,
  emptySettings,
  foldSettingDraft,
  foldSettings,
  pendingSettingsDraft,
  settingValuesOf,
  isSettingKey,
  legacyValue,
  settingProblem,
  type SettingDef,
  type SettingKey,
  type SettingSignal,
  type SettingValue,
  type SettingValues,
  type SettingsState,
} from "../src/settingsRecords";

type Folded = { state: SettingsState; changed: Set<(key: SettingKey) => void> };
const folds = new WeakMap<ConvLog, Folded>();

let mainLog: (() => ConvLog) | null = null;
/** Extra checks the box makes before a value is written (the model: one the engine runs). */
const checks = new Map<SettingKey, (v: SettingValue) => string | null>();

/** At boot: the log the settings live in (the main vault's). Unset (a test, a tool run alone): every setting is its default. */
export function configureSettings(o: { log: () => ConvLog; check?: Partial<Record<SettingKey, (v: SettingValue) => string | null>> }): void {
  mainLog = o.log;
  for (const [k, f] of Object.entries(o.check ?? {})) if (isSettingKey(k) && f) checks.set(k, f);
}

function folded(log: ConvLog): Folded {
  let f = folds.get(log);
  if (f) return f;
  const state = emptySettings();
  const changed = new Set<(key: SettingKey) => void>();
  f = { state, changed };
  folds.set(log, f);
  log.onRecord((r: LogRecord) => {
    if (r.conv !== null) return;
    if (foldSettings(state, r)) {
      const key = (r as { signal?: { key?: SettingKey } }).signal!.key!;
      for (const fn of [...changed]) fn(key);
    } else foldSettingDraft(state, r);
  });
  for (const r of log.signals(0)) foldSettings(state, r) || foldSettingDraft(state, r);
  return f;
}

const copy = (s: SettingsState): SettingsState => ({ seq: s.seq, values: { ...s.values }, set: { ...s.set }, drafts: [...s.drafts], changes: [...s.changes] });

/** Every setting now (on `log`, default the main vault's). */
export function readSettings(log: ConvLog | null = mainLog?.() ?? null): SettingsState {
  return log ? copy(folded(log).state) : emptySettings();
}

/** One setting now: its value, the default when nothing set it. */
export function readSetting<K extends SettingKey>(key: K): SettingValue {
  const log = mainLog?.();
  return log ? folded(log).state.values[key] : SETTINGS[key].default;
}

/** Whether a record sets `key` (rather than its default standing). */
export function settingIsSet(key: SettingKey, log: ConvLog | null = mainLog?.() ?? null): boolean {
  return !!log && !!folded(log).state.set[key];
}

/** Call `fn` with the key each time a setting changes; returns the unsubscribe. */
export function onSettingChanged(fn: (key: SettingKey) => void, log: ConvLog | null = mainLog?.() ?? null): () => void {
  if (!log) return () => {};
  const f = folded(log);
  f.changed.add(fn);
  return () => f.changed.delete(fn);
}

export type SetResult = { ok: true; key: SettingKey; value: SettingValue; was: SettingValue; seq: number } | { ok: false; error: string; status: number };

/** Set one setting (null: back to its default): a `setting` record. Unknown keys and values it doesn't take are refused. */
export function setSetting(key: unknown, value: unknown, by: string, log: ConvLog | null = mainLog?.() ?? null): SetResult {
  const v = value === undefined ? null : value;
  const bad = settingProblem(key, v) ?? (isSettingKey(key) && v !== null ? (checks.get(key)?.(v as SettingValue) ?? null) : null);
  if (bad) return { ok: false, status: 400, error: bad };
  if (!log) return { ok: false, status: 503, error: "the settings log is not open yet" };
  const k = key as SettingKey;
  const f = folded(log); // the fold follows the log before this record is written
  const was = f.state.values[k];
  const sig: SettingSignal = { type: SETTING, key: k, value: v as SettingValue, by: String(by || "?").slice(0, 40) };
  let seq: number;
  try {
    seq = log.emit(null, { type: "signal", signal: sig }).seq;
  } catch (e) {
    return { ok: false, status: 500, error: `the log could not be written: ${(e as Error).message}` };
  }
  return { ok: true, key: k, value: f.state.values[k], was, seq };
}

/**
 * GET /api/v2/settings → every setting; POST {key, value} sets one (by `by`, the app or the phone); POST
 * {migrate: {key: value}} sets each key that no record sets yet (a laptop moving what it kept itself, once; asking
 * again changes nothing). Answers {status, body}.
 */
export function settingsRoute(method: string, body: Record<string, unknown> | null, by: string, log: ConvLog | null = mainLog?.() ?? null): { status: number; body: Record<string, unknown> } {
  if (method === "GET") return { status: 200, body: readSettings(log) };
  if (method !== "POST") return { status: 405, body: { error: "GET or POST" } };
  const b = body ?? {};
  if (b.migrate && typeof b.migrate === "object" && !Array.isArray(b.migrate)) {
    const moved: string[] = [];
    const refused: string[] = [];
    for (const [k, v] of Object.entries(b.migrate as Record<string, unknown>)) {
      if (!isSettingKey(k) || settingIsSet(k, log) || v === null || v === undefined) continue;
      const r = setSetting(k, v, `${by} (moved)`, log);
      if (r.ok) moved.push(k);
      else refused.push(`${k}: ${r.error}`);
    }
    return { status: 200, body: { ...readSettings(log), moved, refused } };
  }
  if (typeof b.change === "string") {
    const who = typeof b.by === "string" && CHANGE_BY.has(b.by) ? b.by : by;
    const c = settingsChange(b.change, b.version, who, b.reason, log);
    return c.ok ? { status: 200, body: { ok: true, seq: c.seq, text: c.text } } : { status: c.status, body: { error: c.error } };
  }
  const r = setSetting(b.key, b.value, by, log);
  return r.ok ? { status: 200, body: { ...readSettings(log), key: r.key, value: r.value } } : { status: r.status, body: { error: r.error } };
}

// ---------------------------------------------------------------- drafts (src/settingsRecords.ts)

/** Who may be named on a settings change record (as on a plugin's: server/supervisor.ts). */
const CHANGE_BY = new Set(["carl", "agent", "auto", "gate"]);

/** The value a record leaves `key` at, for comparing (null: its default). */
const effective = (k: SettingKey, v: SettingValue | undefined): SettingValue => (v === null || v === undefined ? SETTINGS[k].default : v);

export type DraftResult = { ok: true; version: string; values: SettingValues; what: string; carried: SettingValues } | { ok: false; status: number; error: string };

/**
 * The agent's own idea for some settings: a setting.draft record that waits for Carl as Change ready (nothing is set).
 * A draft still waiting carries over (its settings not named again). Values already in effect are left out; when
 * nothing is left, nothing is written. `what`: one line for the notice (default: the settings, said).
 */
export function draftSettings(values: Record<string, unknown>, what: unknown, by: string, log: ConvLog | null = mainLog?.() ?? null): DraftResult {
  const v = settingValuesOf(values);
  if (!v || !Object.keys(v).length) {
    for (const [k, x] of Object.entries(values ?? {})) {
      const bad = settingProblem(k, x === undefined ? null : x);
      if (bad) return { ok: false, status: 400, error: bad };
    }
    return { ok: false, status: 400, error: "name a setting and its value" };
  }
  for (const [k, x] of Object.entries(v)) {
    const bad = x !== null ? (checks.get(k as SettingKey)?.(x) ?? null) : null;
    if (bad) return { ok: false, status: 400, error: bad };
  }
  if (!log) return { ok: false, status: 503, error: "the settings log is not open yet" };
  const st = folded(log).state;
  const waiting = pendingSettingsDraft(st);
  const carried: SettingValues = {};
  if (waiting) for (const k of SETTING_KEYS) if (k in waiting.values && !(k in v)) carried[k] = waiting.values[k];
  const all: SettingValues = { ...carried, ...v };
  const out: SettingValues = {};
  for (const k of SETTING_KEYS) if (k in all && effective(k, all[k]) !== st.values[k]) out[k] = all[k];
  if (!Object.keys(out).length) return { ok: false, status: 409, error: `already so (${describeValues(all)}): nothing to draft` };
  const at = Date.now();
  const version = draftVersion(out, at);
  const line = typeof what === "string" && what.trim() ? what.trim().slice(0, 160) : describeValues(out);
  try {
    log.emit(null, { type: "signal", signal: { type: SETTING_DRAFT, values: out, version, what: line, by: String(by || "?").slice(0, 40), at } });
  } catch (e) {
    return { ok: false, status: 500, error: `the log could not be written: ${(e as Error).message}` };
  }
  for (const k of Object.keys(carried) as SettingKey[]) if (!(k in out)) delete carried[k];
  return { ok: true, version, values: out, what: line, carried };
}

export type ChangeResult = { ok: true; seq: number; text: string } | { ok: false; status: number; error: string };

/**
 * Carl's word on the settings draft (the Change ready buttons, app/changes, the Plugins tool, an auto-discard):
 *   keep     the draft `version` (still waiting) is set, a setting record per key, then the keep record naming what it replaced
 *   discard  the draft is dropped: only the record
 *   switch   the settings the last keep (or switch) replaced are set again, for each it set that nobody changed since;
 *            `version` given: only while that one is in effect (two windows switching back by themselves switch once)
 */
export function settingsChange(change: unknown, version: unknown, by: string, reason?: unknown, log: ConvLog | null = mainLog?.() ?? null): ChangeResult {
  if (change !== "keep" && change !== "discard" && change !== "switch") return { ok: false, status: 400, error: 'change is "keep", "discard" or "switch"' };
  if (!log) return { ok: false, status: 503, error: "the settings log is not open yet" };
  const st = folded(log).state;
  const why = typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 300) : undefined;
  const who = String(by || "?").slice(0, 40);
  const emit = (sig: Record<string, unknown>): number => log.emit(null, { type: "signal", signal: { type: SETTING_CHANGE, ...sig, by: who, ...(why ? { reason: why } : {}), at: Date.now() } }).seq;
  try {
    if (change === "keep" || change === "discard") {
      const d = st.drafts.find((x) => x.version === version);
      if (!d) return { ok: false, status: 409, error: `no settings draft ${String(version ?? "").slice(0, 20)} (look again: app/changes, or Settings)` };
      const decided = st.changes.find((c) => c.version === d.version && c.change !== "switch");
      if (decided) return decided.change === change ? { ok: true, seq: decided.seq, text: `already ${change === "keep" ? "kept" : "discarded"}` } : { ok: false, status: 409, error: `that draft was already ${decided.change === "keep" ? "kept" : "discarded"}` };
      if (change === "discard") return { ok: true, seq: emit({ change, version: d.version }), text: `discarded the settings draft (${describeValues(d.values)})` };
      if (pendingSettingsDraft(st)?.version !== d.version) return { ok: false, status: 409, error: "a newer settings draft replaced that one: look again" };
      for (const [k, x] of Object.entries(d.values)) {
        const bad = x !== null ? (checks.get(k as SettingKey)?.(x) ?? null) : null;
        if (bad) return { ok: false, status: 400, error: `${bad}; nothing kept` };
      }
      const was: SettingValues = {};
      for (const k of SETTING_KEYS) if (k in d.values) was[k] = st.set[k] ? st.values[k] : null;
      for (const [k, x] of Object.entries(d.values)) {
        const r = setSetting(k, x, who, log);
        if (!r.ok) return { ok: false, status: r.status, error: `${r.error} (the settings before it in the draft are set)` };
      }
      const seq = emit({ change, version: d.version, from: versionOf(canonicalValues(was)), values: d.values, was });
      return { ok: true, seq, text: `kept: ${describeValues(d.values)}; Switch back returns to ${describeValues(was)}` };
    }
    const l = landing(st.changes) as (typeof st.changes)[number] | null;
    if (!l) return { ok: false, status: 409, error: "the settings have nothing to switch back to (no draft was kept)" };
    if (typeof version === "string" && version && l.version !== version) return { ok: false, status: 409, error: "already switched" };
    const back: SettingValues = {};
    const left: SettingKey[] = [];
    for (const k of SETTING_KEYS) {
      if (!(k in l.values)) continue;
      if (effective(k, l.values[k]) === st.values[k]) back[k] = k in l.was ? l.was[k] : null;
      else left.push(k);
    }
    if (!Object.keys(back).length) return { ok: false, status: 409, error: `nothing to switch back: ${left.join(", ")} changed since` };
    const now: SettingValues = {};
    for (const k of Object.keys(back) as SettingKey[]) now[k] = l.values[k];
    for (const [k, x] of Object.entries(back)) {
      const r = setSetting(k, x, who, log);
      if (!r.ok) return { ok: false, status: r.status, error: r.error };
    }
    const seq = emit({ change, version: versionOf(`${canonicalValues(back)}@${Date.now()}`), from: l.version, values: back, was: now });
    return { ok: true, seq, text: `switched the settings back: ${describeValues(back)}${left.length ? ` (${left.join(", ")} left as Carl set it since)` : ""}` };
  } catch (e) {
    return { ok: false, status: 500, error: `the log could not be written: ${(e as Error).message}` };
  }
}

/**
 * The settings gate (src/gateResult.ts, kind settings): the waiting draft (or the one named) judged before Carl sees it.
 * fail: a value the box does not take now (the same checks a set makes: a model this engine runs …), a draft already
 * decided or replaced, or one that changes nothing any more; borderline: it changes something Carl sees (a window
 * setting); pass: only the box's settings. Pure reading: nothing is written.
 */
export function settingsDraftGate(version?: string | null, log: ConvLog | null = mainLog?.() ?? null): { version: string; what: string; verdict: "pass" | "borderline" | "fail"; reasons: string[] } | { error: string } {
  if (!log) return { error: "the settings log is not open yet" };
  const st = folded(log).state;
  const waiting = pendingSettingsDraft(st);
  const d = version ? st.drafts.find((x) => x.version === version) : waiting;
  if (!d) return { error: version ? `no settings draft ${String(version).slice(0, 20)}` : "no settings draft waits" };
  const reasons: string[] = [];
  if (waiting?.version !== d.version) reasons.push(st.changes.some((c) => c.version === d.version && c.change !== "switch") ? "it was already decided" : "a newer settings draft replaced it");
  for (const [k, x] of Object.entries(d.values)) {
    const bad = settingProblem(k, x) ?? (x !== null ? (checks.get(k as SettingKey)?.(x) ?? null) : null);
    if (bad) reasons.push(bad);
  }
  const changes = SETTING_KEYS.filter((k) => k in d.values && effective(k, d.values[k]) !== st.values[k]);
  if (!changes.length) reasons.push(`it changes nothing: ${describeValues(d.values)} already`);
  if (reasons.length) return { version: d.version, what: d.what, verdict: "fail", reasons };
  const seen = changes.filter((k) => SETTINGS[k].applies === "window");
  return seen.length
    ? { version: d.version, what: d.what, verdict: "borderline", reasons: [`every value is one the box takes; Carl sees ${seen.join(", ")} change`] }
    : { version: d.version, what: d.what, verdict: "pass", reasons: ["every value is one the box takes; only the box's settings change"] };
}

type Storage = { getItem(k: string): string | null; removeItem(k: string): void };

/**
 * Move the settings the box kept in its localStorage file into records, once, at startup. For each setting that lived
 * there: when its old key is present, its value goes to a backup file in `backupDir` (written before anything changes),
 * becomes a record unless one already sets it (a record always wins), and the old key is removed. Run again, there is
 * nothing left to move: idempotent. Returns what moved and where the backup is.
 */
export function migrateSettings(o: { storage: Storage; backupDir: string; source: string; log?: ConvLog | null; now?: Date }): { moved: SettingKey[]; dropped: SettingKey[]; backup: string | null } {
  const log = o.log ?? mainLog?.() ?? null;
  if (!log) return { moved: [], dropped: [], backup: null };
  const old: Partial<Record<SettingKey, string>> = {};
  for (const k of SETTING_KEYS) {
    const d = SETTINGS[k] as SettingDef;
    if (d.legacy?.where !== "box") continue;
    const raw = o.storage.getItem(d.legacy.key);
    if (raw !== null) old[k] = raw;
  }
  const keys = Object.keys(old) as SettingKey[];
  if (!keys.length) return { moved: [], dropped: [], backup: null };
  // The backup first: only these settings' old entries (the file holds other things, secrets among them, that stay put).
  const stamp = (o.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const backup = join(o.backupDir, `settings-before-records-${stamp}.json`);
  mkdirSync(o.backupDir, { recursive: true });
  const entries = Object.fromEntries(keys.map((k) => [(SETTINGS[k] as SettingDef).legacy!.key, old[k]]));
  writeFileSync(backup, JSON.stringify({ source: o.source, at: (o.now ?? new Date()).toISOString(), entries }, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(backup, 0o600);
  } catch {
    /* best effort */
  }
  const moved: SettingKey[] = [];
  const dropped: SettingKey[] = [];
  for (const k of keys) {
    const v = legacyValue(k, old[k]);
    if (v !== undefined && !settingIsSet(k, log)) {
      // A value the box no longer takes (a model it can't run) is dropped: the backup still has it.
      if (setSetting(k, v, "moved from the box's old settings file", log).ok) moved.push(k);
      else dropped.push(k);
    } else dropped.push(k);
    o.storage.removeItem((SETTINGS[k] as SettingDef).legacy!.key);
  }
  return { moved, dropped, backup };
}
