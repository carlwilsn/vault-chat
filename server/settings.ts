// Carl's settings on the box (record shapes in src/settingsRecords.ts): `setting` signals in the main vault's log, and
// the settings are their fold, read once from the log's signals file and then kept up to date from the log's own
// records (like a plugin's state, server/pluginState.ts). One source of truth: the engine's model and effort, the
// voice a call speaks with and the automatic-push switch read it here; the laptop, the phone and the agent's Settings
// tool write it here. Every record is also a signal on every feed, so an open app and the phone follow at once.
//
// Before this, those four lived in the box's localStorage file. migrateSettings moves them, once: what it moves is
// first written to a backup file (outside the vault), then becomes records, then leaves the old file.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConvLog } from "./convlog/log";
import type { LogRecord } from "../src/convlog/protocol";
import {
  SETTING,
  SETTINGS,
  SETTING_KEYS,
  emptySettings,
  foldSettings,
  isSettingKey,
  legacyValue,
  settingProblem,
  type SettingDef,
  type SettingKey,
  type SettingSignal,
  type SettingValue,
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
    if (r.conv === null && foldSettings(state, r)) {
      const key = (r as { signal?: { key?: SettingKey } }).signal!.key!;
      for (const fn of [...changed]) fn(key);
    }
  });
  for (const r of log.signals(0)) foldSettings(state, r);
  return f;
}

const copy = (s: SettingsState): SettingsState => ({ seq: s.seq, values: { ...s.values }, set: { ...s.set } });

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
  const r = setSetting(b.key, b.value, by, log);
  return r.ok ? { status: 200, body: { ...readSettings(log), key: r.key, value: r.value } } : { status: r.status, body: { error: r.error } };
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
