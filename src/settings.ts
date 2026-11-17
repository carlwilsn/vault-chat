// Carl's settings on the laptop (record shapes in src/settingsRecords.ts; the truth is the box's records,
// server/settings.ts). The app reads them from the box when its chat connects (GET /api/v2/settings), follows every
// change on the feed it already polls (a `setting` signal: src/boxChat.ts), and writes Carl's picks back as records
// (POST /api/v2/settings). A change the agent or the phone makes shows here at once.
//
// What the app needs before the box answers (the theme at first paint) it reads from a copy in localStorage, under
// the keys those settings used to live in. That copy is written only from the records (and by Carl's own pick, which
// becomes a record): it is a cache, never a second truth. Startup never waits on the box.
//
// Moving the laptop's own old values: once, when the box has no record for a setting this laptop kept itself
// (the theme, the fullscreen chat's sidebar), the laptop sends its value (POST {migrate}: set only where no record is).
//
// The agent's settings drafts and Carl's word on them (setting.draft / setting.change) are followed here the same way
// (settingsDraftsNow). Trying one (src/changeReady.ts) lays its window settings over the records on this app's windows
// only (setSettingsTry): nothing is written, the first-paint copy keeps the records' values, and Back, Discard or Keep
// takes the overlay away (after a Keep the records say the same).
import { useEffect, useState } from "react";
import { useStore } from "./store";
import { boxGet, boxLinkFor, boxPost, type Link } from "./boxChat";
import {
  SETTINGS,
  SETTING_KEYS,
  emptySettings,
  foldSettingDraft,
  isSettingKey,
  legacyValue,
  settingProblem,
  type SettingDef,
  type SettingKey,
  type SettingValue,
  type SettingValues,
  type SettingsState,
} from "./settingsRecords";

const MIGRATED = "vc_settings_moved";
/** The seq of the newest record applied here (a snapshot older than a signal already applied is not applied). */
let seq = 0;
let values: Record<SettingKey, SettingValue> = (() => {
  const v = emptySettings().values;
  for (const k of SETTING_KEYS) {
    const d = SETTINGS[k] as SettingDef;
    if (d.legacy?.where !== "laptop" && k !== "voice") continue;
    try {
      const raw = localStorage.getItem(k === "voice" ? "vault_chat_elevenlabs_voice" : d.legacy!.key);
      const x = legacyValue(k, raw);
      if (x !== undefined) v[k] = x;
    } catch {
      /* no localStorage: the defaults */
    }
  }
  return v;
})();
const subs = new Set<() => void>();
/** A draft Carl tries on this app's windows: its window settings, over the records (empty: none). */
let overlay: SettingValues = {};
/** What the screen shows for `key`: the tried value, else the records'. */
const shown = (key: SettingKey): SettingValue => (key in overlay ? (overlay[key] === null ? SETTINGS[key].default : overlay[key]!) : values[key]);

/** A setting as this app shows it now (a tried draft's value while Carl tries it). */
export function setting<K extends SettingKey>(key: K): SettingValue {
  return shown(key);
}

/** The local copy (what first paint reads) for the settings that have one. */
function cache(key: SettingKey, v: SettingValue): void {
  try {
    if (key === "theme") localStorage.setItem("vault_chat_theme", String(v));
    else if (key === "chatSidebar") localStorage.setItem("vc_chat_sidebar", v ? "1" : "0");
    else if (key === "voice") localStorage.setItem("vault_chat_elevenlabs_voice", String(v));
  } catch {
    /* the records are the truth */
  }
}

/** Apply one setting here: the store (the screen follows), the local copy, and what follows from it. */
function apply(key: SettingKey, v: SettingValue): void {
  const before = shown(key);
  values = { ...values, [key]: v };
  cache(key, v);
  show(key, before);
}

/** The screen follows what it shows for `key` now (`was`: what it showed before). */
function show(key: SettingKey, was: SettingValue): void {
  const v = shown(key);
  const st = useStore.getState();
  // A tried theme is shown without touching the first-paint copy (applyTheme writes it): a restart shows the records'.
  if (key === "theme" && (v === "graphite" || v === "light") && st.theme !== v) {
    if (key in overlay) useStore.setState({ theme: v });
    else st.applyTheme(v);
  }
  if (key === "chatSidebar" && typeof v === "boolean" && st.chatSidebarOpen !== v) useStore.setState({ chatSidebarOpen: v });
  if ((key === "model" || key === "effort") && was !== v && st.vaultPath) void import("./chatModels").then((m) => m.refreshChatModels(st.vaultPath!)).catch(() => {});
  if (was !== v) for (const f of [...subs]) f();
}

/** A `setting` record from the feed (src/boxChat.ts). */
export function settingSignal(e: Record<string, unknown>, recSeq?: number): void {
  if (!isSettingKey(e.key)) return;
  const v = e.value === undefined ? null : (e.value as SettingValue);
  if (settingProblem(e.key, v) !== null) return;
  if (typeof recSeq === "number") seq = Math.max(seq, recSeq);
  apply(e.key, v === null ? SETTINGS[e.key].default : v);
}

/** Every setting as the box has them, applied here; a laptop's own old values moved once. Never throws. */
export async function loadBoxSettings(link: Link): Promise<void> {
  try {
    let r = (await boxGet(link, "/api/v2/settings", 10_000)) as { seq?: number; values?: Record<string, unknown>; set?: Record<string, unknown> };
    let moved = false;
    try {
      moved = localStorage.getItem(MIGRATED) === "1";
    } catch {
      moved = true;
    }
    if (!moved) {
      const migrate: Record<string, SettingValue> = {};
      for (const k of SETTING_KEYS) {
        const d = SETTINGS[k] as SettingDef;
        if (d.legacy?.where !== "laptop" || r.set?.[k]) continue;
        const v = legacyValue(k, localStorage.getItem(d.legacy.key));
        if (v !== undefined && v !== d.default) migrate[k] = v;
      }
      if (Object.keys(migrate).length) {
        const m = await boxPost(link, "/api/v2/settings", { migrate });
        if (!m.ok) return; // tried again on the next connect
        r = m.data as typeof r;
      }
      localStorage.setItem(MIGRATED, "1");
    }
    loadDrafts(r as { drafts?: unknown; changes?: unknown });
    const at = Number(r.seq ?? 0);
    if (at < seq || !r.values) return;
    seq = at;
    for (const k of SETTING_KEYS) if (k in r.values && settingProblem(k, r.values[k]) === null) apply(k, r.values[k] as SettingValue);
  } catch {
    /* an older box without settings, or offline: the local copy stands */
  }
}

/** Read every setting and draft from the box again now (after Carl's word on a draft: the feed brings it too). */
export async function refreshBoxSettings(): Promise<void> {
  const link = await boxLinkFor(useStore.getState().vaultPath).catch(() => null);
  if (link) await loadBoxSettings(link);
}

/** Carl's pick: shown here at once, then a record on the box (which every other app and the phone follow). */
export async function saveSetting(key: SettingKey, value: SettingValue): Promise<string | null> {
  const bad = settingProblem(key, value);
  if (bad) return bad;
  // Carl picks a setting a draft he tries lays over: his pick wins, the trying stops (src/changeReady.ts).
  if (key in overlay) pickedWhileTrying?.();
  apply(key, value === null ? SETTINGS[key].default : value);
  const link = await boxLinkFor(useStore.getState().vaultPath).catch(() => null);
  if (!link) return "no box is connected";
  const r = await boxPost(link, "/api/v2/settings", { key, value });
  return r.ok ? null : (r.error ?? "the box refused");
}

/** A setting, kept current (a record from anywhere re-renders the component). */
export function useSetting(key: SettingKey): SettingValue {
  const [v, setV] = useState(shown(key));
  useEffect(() => {
    const f = () => setV(shown(key));
    subs.add(f);
    f();
    return () => void subs.delete(f);
  }, [key]);
  return v;
}

// ---------------------------------------------------------------- drafts (src/settingsRecords.ts) and trying one

let drafts: Pick<SettingsState, "drafts" | "changes"> = { drafts: [], changes: [] };
let draftsVersion = 0;
const draftSubs = new Set<() => void>();
function draftsChanged(): void {
  draftsVersion++;
  for (const f of [...draftSubs]) f();
}

/** The settings drafts and the word on them as this app knows them. */
export const settingsDraftsNow = (): Pick<SettingsState, "drafts" | "changes"> => drafts;
/** Follow them (a counter that moves when a draft or a word arrives). */
export function onSettingsDrafts(fn: () => void): () => void {
  draftSubs.add(fn);
  return () => void draftSubs.delete(fn);
}
export const settingsDraftsVersion = () => draftsVersion;

/** A setting.draft / setting.change record from the feed (src/boxChat.ts), or the box's list on connect. */
export function settingDraftSignal(e: Record<string, unknown>, recSeq: number): void {
  const next = { drafts: [...drafts.drafts], changes: [...drafts.changes] } as SettingsState;
  if (!foldSettingDraft(next, { seq: recSeq, type: "signal", signal: e })) return;
  drafts = { drafts: next.drafts, changes: next.changes };
  draftsChanged();
}

function loadDrafts(r: { drafts?: unknown; changes?: unknown }): void {
  if (!Array.isArray(r.drafts) && !Array.isArray(r.changes)) return;
  const next = { drafts: [...drafts.drafts], changes: [...drafts.changes] } as SettingsState;
  let any = false;
  for (const d of (Array.isArray(r.drafts) ? r.drafts : []) as Record<string, unknown>[]) any = foldSettingDraft(next, { seq: Number(d.seq), type: "signal", signal: { ...d, type: "setting.draft" } }) || any;
  for (const c of (Array.isArray(r.changes) ? r.changes : []) as Record<string, unknown>[]) any = foldSettingDraft(next, { seq: Number(c.seq), type: "signal", signal: { ...c, type: "setting.change" } }) || any;
  if (!any) return;
  drafts = { drafts: next.drafts, changes: next.changes };
  draftsChanged();
}

/** Lay a tried draft's window settings over the records on this app's windows (null: take it away). Nothing is
 *  written anywhere: the records, the box and the first-paint copy stay as they are. */
export function setSettingsTry(v: SettingValues | null): void {
  const next: SettingValues = {};
  for (const k of SETTING_KEYS) if (v && k in v && SETTINGS[k].applies === "window" && settingProblem(k, v[k]) === null) next[k] = v[k];
  const keys = new Set([...Object.keys(overlay), ...Object.keys(next)] as SettingKey[]);
  if ([...keys].every((k) => overlay[k] === next[k] && (k in overlay) === (k in next))) return;
  const before = Object.fromEntries([...keys].map((k) => [k, shown(k)])) as Record<SettingKey, SettingValue>;
  overlay = next;
  for (const k of keys) show(k, before[k]);
}

let pickedWhileTrying: (() => void) | null = null;
/** What to do when Carl picks a setting a tried draft lays over (src/changeReady.ts: stop trying it). */
export function onPickWhileTrying(fn: (() => void) | null): void {
  pickedWhileTrying = fn;
}

/** What Try lays over the records now (tests, the offers). */
export const settingsTriedNow = (): SettingValues => overlay;

/** Tests: forget what was applied. */
export function _resetSettings(): void {
  seq = 0;
  values = emptySettings().values;
  overlay = {};
  drafts = { drafts: [], changes: [] };
}
