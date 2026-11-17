// Change ready (reports/07 corrected model, point 4; records and rules in src/pluginDrafts.ts): the core's side of
// trying a plugin's draft. Not a plugin itself, so a draft can never break the buttons that judge it.
//
// - Try: the draft runs on Carl's windows only. Which version he tries is kept per vault in localStorage, so every
//   window of this app follows it (the storage event) and nothing on the box changes; Back stops trying.
// - Keep / Discard: one plugin.change record on the box (it moves the files: server/pluginDrafts.ts). A kept draft runs
//   as the live copy at once (the record), before its file has synced; undo is Switch back (another record).
// - A draft being tried that throws, fails to load or makes typing slow (composer or Ctrl+K keystroke-to-paint median
//   over TRY_SLOW_MS) discards itself: Carl's windows fall back at once, a discard record is written (by "auto") and
//   the notice says why.
// - After Keep, the kept copy is watched for KEEP_WATCH_MS: when it throws, fails to load or makes typing slow, it
//   switches back by itself (a switch record by "auto" naming the kept version, so two windows switch once) and the
//   notice says why, in every window and after a restart (from the record). Nothing listens to typing unless a draft
//   is tried or a keep is under watch.
// - The state and the actions are offers (app/changes: PluginRead / PluginAct), so the agent sees whether Carl is
//   trying a draft.
// - Carl's settings have drafts too (src/settingsRecords.ts: the agent's own idea, Settings with draft: true), shown as
//   "app/settings-values": Try lays their window settings (theme, sidebar) over the records on his windows only
//   (src/settings.ts setSettingsTry); a draft of settings only the box applies (model, voice …) has no Try, only
//   Keep / Discard. Keep, Discard and Switch back post the same change to the box, which writes the settings.
import { useMemo, useSyncExternalStore } from "react";
import { useStore } from "./store";
import { appPluginFolder, LIVE_APP_PLUGINS } from "./appPluginLive";
import { liveCopiesNow, useAllLiveCopies, type LiveCopies } from "./appPluginLiveHost";
import { postPluginChange, supervisorChangesNow, useSupervisorVersion } from "./pluginSupervisorApp";
import { APP_PLUGINS } from "./appPlugins";
import { PRESET_DRAFT_FILE, PRESET_PLUGIN_ID, parseDraft } from "./appPreset";
import { SETTINGS_DRAFT_ID, SETTINGS_DRAFT_NAME, describeValues, pendingSettingsDraft, triable as settingsTriable, windowValues } from "./settingsRecords";
import { onPickWhileTrying, onSettingsDrafts, refreshBoxSettings, setSettingsTry, settingsDraftsNow, settingsDraftsVersion } from "./settings";
import { BUILT_IN, KEEP_WATCH_MS, TRY_SLOW_MS, draftPending, draftWhat, landing, slowMedian, watchedKeep, type ChangeRecord, type SlotCode } from "./pluginDrafts";

export const CHANGES_PLUGIN = { id: "app/changes", name: "Change ready" } as const;
/** What Carl calls the app's preset in the notice. */
export const PRESET_NAME = "App preset";

// ---------------------------------------------------------------- what Carl tries (this app's windows)

const TRY_KEY = "vc.tryDraft:";
type Tries = Readonly<Record<string, string>>;
const NONE: Tries = Object.freeze({});
let tryVault: string | null = null;
let tries: Tries = NONE;
const tryListeners = new Set<() => void>();

function readTries(v: string | null): Tries {
  try {
    const raw = v ? globalThis.localStorage?.getItem(TRY_KEY + v) : null;
    const o = raw ? JSON.parse(raw) : null;
    if (!o || typeof o !== "object") return NONE;
    const out: Record<string, string> = {};
    for (const [k, x] of Object.entries(o)) if (typeof x === "string") out[k] = x;
    return out;
  } catch {
    return NONE;
  }
}

function followTries(): Tries {
  const v = useStore.getState().vaultPath;
  if (v !== tryVault) {
    tryVault = v;
    tries = readTries(v);
  }
  return tries;
}

function emitTries(): void {
  syncSettingsTry();
  for (const fn of [...tryListeners]) fn();
  for (const fn of [...changeListeners]) fn();
}

let storageHooked = false;
function hookStorage(): void {
  if (storageHooked || typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  storageHooked = true;
  // Another window of this app tried or stopped a draft: follow it.
  window.addEventListener("storage", (e: StorageEvent) => {
    if (!e.key || !tryVault || e.key !== TRY_KEY + tryVault) return;
    tries = readTries(tryVault);
    watchTyping();
    emitTries();
  });
}

function subscribeTries(fn: () => void): () => void {
  hookStorage();
  tryListeners.add(fn);
  return () => tryListeners.delete(fn);
}

/** The version of `plugin`'s draft Carl tries in this app's windows, or null. */
export function triedVersion(plugin: string): string | null {
  return followTries()[plugin] ?? null;
}

/** triedVersion, following it (null plugin: nothing). */
export function useTried(plugin: string | null): string | null {
  const get = () => (plugin ? triedVersion(plugin) : null);
  return useSyncExternalStore(subscribeTries, get, get);
}

const triesNow = () => followTries();
/** Every plugin's tried version in this app's windows, following them. */
export function useTries(): Tries {
  return useSyncExternalStore(subscribeTries, triesNow, triesNow);
}

/** Try `version` of the plugin's draft on this app's windows (null: stop trying it). */
export function setTried(plugin: string, version: string | null): void {
  const cur = followTries();
  if ((cur[plugin] ?? null) === version) return;
  const next: Record<string, string> = { ...cur };
  if (version) next[plugin] = version;
  else delete next[plugin];
  tries = next;
  try {
    if (tryVault) {
      if (Object.keys(next).length) globalThis.localStorage?.setItem(TRY_KEY + tryVault, JSON.stringify(next));
      else globalThis.localStorage?.removeItem(TRY_KEY + tryVault);
    }
  } catch {
    /* no storage: this window still tries it */
  }
  watchTyping();
  emitTries();
}

// ---------------------------------------------------------------- Carl's settings (src/settings.ts)

/** A plugin's change records: the supervisor's, or for the settings, the settings' own (they live with them). */
export function changesOf(plugin: string): readonly ChangeRecord[] {
  return plugin === SETTINGS_DRAFT_ID ? settingsDraftsNow().changes : supervisorChangesNow(plugin);
}

/** This window shows the settings draft Carl tries (its window settings over the records), or the records again. */
function syncSettingsTry(): void {
  const d = pendingSettingsDraft(settingsDraftsNow());
  setSettingsTry(d && followTries()[SETTINGS_DRAFT_ID] === d.version ? windowValues(d.values) : null);
}

// ---------------------------------------------------------------- the vault plugins' slots (VaultPluginHost writes them)

export type VaultSlot = { id: string; name: string } & SlotCode;
let vaultSlots: readonly VaultSlot[] = [];
const changeListeners = new Set<() => void>();

/** VaultPluginHost's last look at .vault-chat/plugins: each plugin's live, draft and prev code. */
export function setVaultSlots(list: readonly VaultSlot[]): void {
  if (list === vaultSlots) return;
  vaultSlots = list;
  for (const fn of [...changeListeners]) fn();
}

// ---------------------------------------------------------------- the drafts waiting for Carl

export type PendingChange = {
  plugin: string;
  /** The plugin's name, as Carl knows it. */
  name: string;
  /** What the draft changes (its header's `what`, or its `// @vc-change` line), or "". */
  what: string;
  version: string;
  /** A vault plugin with no live file yet: the draft adds it. */
  added: boolean;
  /** Whether Try can run it on Carl's windows (a settings draft of only the box's settings can't: Keep sets it). */
  triable: boolean;
};

const appName = (id: string) => APP_PLUGINS.find((p) => p.id === id)?.name ?? id.replace(/^app\//, "");

function appSlotCode(all: LiveCopies, folder: string): SlotCode {
  const out: SlotCode = {};
  for (const k of ["draft", "live", "prev"] as const) {
    const c = all[`${folder}${k === "live" ? "" : `.${k}`}.js`];
    if (c !== undefined) out[k] = c;
  }
  return out;
}

/** Every draft nobody decided on yet, app plugins first. */
export function pendingChanges(all: LiveCopies = liveCopiesNow(), slots: readonly VaultSlot[] = vaultSlots): PendingChange[] {
  const out: PendingChange[] = [];
  for (const id of LIVE_APP_PLUGINS) {
    const code = appSlotCode(all, appPluginFolder(id)!);
    const v = draftPending(code, supervisorChangesNow(id));
    if (v) out.push({ plugin: id, name: appName(id), what: draftWhat(code.draft!), version: v, added: false, triable: true });
  }
  // The app's preset (src/appPreset.ts): its draft file waits the same way.
  const preset = all[PRESET_DRAFT_FILE];
  if (preset !== undefined) {
    const v = draftPending({ draft: preset }, supervisorChangesNow(PRESET_PLUGIN_ID));
    if (v) {
      const d = parseDraft(preset);
      out.push({ plugin: PRESET_PLUGIN_ID, name: PRESET_NAME, what: "preset" in d ? d.what || `the app's preset "${d.preset.name}"` : "", version: v, added: false, triable: true });
    }
  }
  for (const s of slots) {
    const v = draftPending(s, supervisorChangesNow(s.id));
    if (v) out.push({ plugin: s.id, name: s.name, what: draftWhat(s.draft!), version: v, added: s.live === undefined, triable: true });
  }
  // Carl's settings (src/settingsRecords.ts): the agent's draft of them.
  const sd = pendingSettingsDraft(settingsDraftsNow());
  if (sd) out.push({ plugin: SETTINGS_DRAFT_ID, name: SETTINGS_DRAFT_NAME, what: sd.what || describeValues(sd.values), version: sd.version, added: false, triable: settingsTriable(sd.values) });
  return out;
}

function subscribeChanges(fn: () => void): () => void {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}
const slotsNow = () => vaultSlots;

/** The drafts waiting for Carl, kept current (the copies, the vault plugins' slots, the records). */
export function usePendingChanges(): PendingChange[] {
  const all = useAllLiveCopies();
  const slots = useSyncExternalStore(subscribeChanges, slotsNow, slotsNow);
  const rv = useSupervisorVersion();
  const sv = useSyncExternalStore(onSettingsDrafts, settingsDraftsVersion, settingsDraftsVersion);
  return useMemo(() => pendingChanges(all, slots), [all, slots, rv, sv]);
}

/** The plugins Carl is trying now (pending drafts only), with the version. */
export function tryingNow(pending: readonly PendingChange[] = pendingChanges()): PendingChange[] {
  return pending.filter((p) => triedVersion(p.plugin) === p.version);
}

// ---------------------------------------------------------------- what happened last (the notice's line)

export type Outcome = { plugin: string; name: string; text: string; ok: boolean; at: number; /** the auto-revert record it tells of */ seq?: number };
let outcome: Outcome | null = null;
const outcomeListeners = new Set<() => void>();
function say(o: Outcome | null): void {
  outcome = o;
  for (const fn of [...outcomeListeners]) fn();
}
const outcomeNow = () => outcome;
export function useOutcome(): Outcome | null {
  return useSyncExternalStore((fn) => (outcomeListeners.add(fn), () => outcomeListeners.delete(fn)), outcomeNow, outcomeNow);
}
export const clearOutcome = () => {
  if (outcome?.seq) markSeen(outcome.seq);
  say(null);
};
export const lastOutcome = () => outcome;

const nameOf = (plugin: string) => (plugin === SETTINGS_DRAFT_ID ? SETTINGS_DRAFT_NAME : plugin === PRESET_PLUGIN_ID ? PRESET_NAME : plugin.startsWith("app/") ? appName(plugin) : vaultSlots.find((s) => s.id === plugin)?.name ?? plugin.split("/").pop() ?? plugin);

// ---------------------------------------------------------------- the actions

/** Try a draft (Carl's windows only). A settings draft of only the box's settings can't be tried: nothing happens. */
export function tryChange(plugin: string, version: string): void {
  if (plugin === SETTINGS_DRAFT_ID && !pendingChanges().some((p) => p.plugin === plugin && p.version === version && p.triable)) return;
  say(null);
  setTried(plugin, version);
}

/** Carl's word on a draft: the box's route (for the settings too: it hands theirs to them); the settings then read
 *  back at once, not when the feed brings them. */
async function post(body: Parameters<typeof postPluginChange>[0]): Promise<{ ok: boolean; text: string }> {
  const r = await postPluginChange(body);
  if (body.plugin === SETTINGS_DRAFT_ID) await refreshBoxSettings();
  return r;
}

/** Stop trying: the copy in effect runs again. */
export function stopTrying(plugin: string): void {
  setTried(plugin, null);
}

/** Keep a draft: the record (the box moves the files); this window stops "trying", the kept copy runs as live. */
export async function keepChange(plugin: string, version: string, by = "carl"): Promise<{ ok: boolean; text: string }> {
  const r = await post({ plugin, change: "keep", version, by });
  if (r.ok) setTried(plugin, null);
  say({ plugin, name: nameOf(plugin), text: r.ok ? "Kept. Switch back undoes it." : `Not kept: ${r.text}`, ok: r.ok, at: Date.now() });
  return r;
}

/** Discard a draft: this window falls back at once, then the record (the box removes the file). */
export async function discardChange(plugin: string, version: string, opts: { by?: string; reason?: string } = {}): Promise<{ ok: boolean; text: string }> {
  setTried(plugin, null);
  const r = await post({ plugin, change: "discard", version, by: opts.by ?? "carl", ...(opts.reason ? { reason: opts.reason } : {}) });
  if (!opts.reason) say({ plugin, name: nameOf(plugin), text: r.ok ? "Discarded." : `Discard not written: ${r.text}`, ok: r.ok, at: Date.now() });
  return r;
}

/** Switch back: the copy the last Keep replaced runs again (a record; undo is another switch). */
export async function switchBack(plugin: string, by = "carl"): Promise<{ ok: boolean; text: string }> {
  const r = await post({ plugin, change: "switch", by });
  say({ plugin, name: nameOf(plugin), text: r.ok ? r.text : `Not switched: ${r.text}`, ok: r.ok, at: Date.now() });
  return r;
}

/** Whether the plugin has a kept change Switch back can undo (the newest keep/switch record). */
export function canSwitchBack(plugin: string): boolean {
  const l = landing(changesOf(plugin));
  return !!l && (l.from ?? BUILT_IN) !== l.version;
}

const autoDone = new Set<string>();
/** A draft being tried failed (threw, did not load, slowed typing): fall back now, write the discard, say why. */
export function autoDiscard(plugin: string, version: string, why: string): void {
  if (triedVersion(plugin) !== version) return;
  const key = `${plugin}\u0000${version}`;
  setTried(plugin, null);
  if (autoDone.has(key)) return;
  autoDone.add(key);
  const short = why.split("\n")[0]!.slice(0, 200);
  say({ plugin, name: nameOf(plugin), text: `Discarded by itself: ${short}`, ok: false, at: Date.now() });
  void post({ plugin, change: "discard", version, by: "auto", reason: short });
}

// ---------------------------------------------------------------- after Keep: switching back by itself

/** Every plugin that can have drafts here: the app plugins with live copies and the vault plugins' slots. */
const slotIds = (): string[] => [...LIVE_APP_PLUGINS, ...vaultSlots.map((s) => s.id), SETTINGS_DRAFT_ID];

/** The keeps under watch now (src/pluginDrafts.ts watchedKeep): plugin, kept version, when the watch ends. */
export function keepsUnderWatch(now = Date.now()): { plugin: string; version: string; until: number }[] {
  const out: { plugin: string; version: string; until: number }[] = [];
  for (const plugin of slotIds()) {
    const k = watchedKeep(changesOf(plugin), now);
    if (k) out.push({ plugin, version: k.version, until: k.at + KEEP_WATCH_MS });
  }
  return out;
}

const revertDone = new Set<string>();
/**
 * A kept copy failed (threw, did not load, slowed typing) while its keep is under watch: switch back by itself, a record
 * by "auto" with why, and say it. `version`: the copy that failed (null: whichever is kept). Whether it switched.
 */
export function autoRevert(plugin: string, version: string | null, why: string): boolean {
  const k = watchedKeep(changesOf(plugin), Date.now());
  if (!k || (version !== null && k.version !== version)) return false;
  const key = `${plugin}\u0000${k.seq}`;
  if (revertDone.has(key)) return true;
  revertDone.add(key);
  const short = why.split("\n")[0]!.slice(0, 200);
  say({ plugin, name: nameOf(plugin), text: `Switched back by itself: ${short}`, ok: false, at: Date.now() });
  void post({ plugin, change: "switch", version: k.version, by: "auto", reason: short }).then((r) => {
    // Another window switched it first ("already switched"): the same outcome.
    if (!r.ok && !/already switched/.test(r.text)) return say({ plugin, name: nameOf(plugin), text: `It broke after Keep (${short}) but could not switch back: ${r.text}`, ok: false, at: Date.now() });
    // The record this notice tells of: dismissing it here dismisses it in every window.
    const rec = changesOf(plugin).filter((c) => c.change === "switch" && c.by === "auto" && c.seq > k.seq).pop();
    if (rec && outcome?.plugin === plugin && !outcome.seq) say({ ...outcome, seq: rec.seq });
  });
  return true;
}

const SEEN_KEY = "vc.changeSeen:";
const seenSeq = (): number => {
  try {
    return Number(tryVault ? globalThis.localStorage?.getItem(SEEN_KEY + tryVault) : 0) || 0;
  } catch {
    return 0;
  }
};
function markSeen(seq: number): void {
  try {
    if (tryVault && seq > seenSeq()) globalThis.localStorage?.setItem(SEEN_KEY + tryVault, String(seq));
  } catch {
    /* no storage: it shows again next start */
  }
}

/** A switch back by itself this window did not see happen (another window, before a restart): the notice says it. */
export function noticeAutoSwitch(now = Date.now()): void {
  if (outcome) return;
  followTries();
  const seen = seenSeq();
  let best: { plugin: string; seq: number; reason: string | null; at: number } | null = null;
  for (const plugin of slotIds())
    for (const c of changesOf(plugin))
      if (c.change === "switch" && c.by === "auto" && c.seq > seen && now - c.at <= KEEP_WATCH_MS && (!best || c.seq > best.seq)) best = { plugin, seq: c.seq, reason: c.reason, at: c.at };
  if (best) say({ plugin: best.plugin, name: nameOf(best.plugin), text: `Switched back by itself${best.reason ? `: ${best.reason}` : ""}`, ok: false, at: best.at, seq: best.seq });
}

// ---------------------------------------------------------------- typing while a draft is tried or a keep is watched

let typing: { off: () => void; samples: number[]; until: number } | null = null;

/** Measure composer / Ctrl+K keystroke-to-paint only while something is tried or a keep is under watch (nothing is
 *  listening otherwise). Called again when the records change. */
export function watchTyping(): void {
  const keeps = keepsUnderWatch();
  const any = Object.keys(tries).length > 0 || keeps.length > 0;
  if (!any) {
    typing?.off();
    typing = null;
    return;
  }
  const until = Object.keys(tries).length ? Infinity : Math.max(...keeps.map((k) => k.until));
  if (typing) {
    typing.until = until;
    return;
  }
  if (typeof window === "undefined" || typeof window.addEventListener !== "function" || typeof requestAnimationFrame !== "function") return;
  const samples: number[] = [];
  const onInput = (e: Event) => {
    const t = e.target as Element | null;
    if (!t || typeof t.closest !== "function" || !t.closest('[data-perf-target="composer"], [data-perf-target="ctrl-k"]')) return;
    if (document.hidden) return; // a hidden window's frames are throttled: not typing speed
    if (typing && Date.now() > typing.until) return void watchTyping(); // the watch ended: stop listening
    const t0 = performance.now();
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        samples.push(performance.now() - t0);
        if (samples.length > 40) samples.splice(0, samples.length - 40);
        const m = slowMedian(samples);
        if (m === null || m <= TRY_SLOW_MS) return;
        samples.length = 0;
        const ms = `median ${Math.round(m)} ms a key, the limit is ${TRY_SLOW_MS} ms`;
        for (const [plugin, version] of Object.entries(tries)) autoDiscard(plugin, version, `typing got slow while it was tried (${ms})`);
        for (const k of keepsUnderWatch()) autoRevert(k.plugin, k.version, `typing got slow after it was kept (${ms})`);
      }),
    );
  };
  window.addEventListener("input", onInput, true);
  typing = { samples, until, off: () => window.removeEventListener("input", onInput, true) };
}

/** Start following what this app's windows try (the app calls it once at start). */
let settingsHooked = false;
export function startChangeReady(): void {
  followTries();
  hookStorage();
  if (!settingsHooked) {
    settingsHooked = true;
    // A settings draft arrived, was decided or replaced: what this window shows follows (and a keep may be watched).
    onSettingsDrafts(() => {
      syncSettingsTry();
      watchTyping();
    });
    // Carl picks a setting the tried draft lays over: his pick wins and the trying stops.
    onPickWhileTrying(() => setTried(SETTINGS_DRAFT_ID, null));
  }
  syncSettingsTry();
  watchTyping();
}

// ---------------------------------------------------------------- the offers (PluginRead / PluginAct)

const describe = (p: PendingChange) => ({ plugin: p.plugin, name: p.name, what: p.what || null, version: p.version, added: p.added, trying: triedVersion(p.plugin) === p.version, triable: p.triable });

export function changeOffers() {
  const need = (args: Record<string, unknown>) => {
    const plugin = String(args.plugin ?? "");
    const p = pendingChanges().find((x) => x.plugin === plugin || x.name.toLowerCase() === plugin.toLowerCase()) ?? (plugin ? null : pendingChanges()[0] ?? null);
    if (!p) throw new Error(plugin ? `no draft of ${plugin} is waiting` : "no draft is waiting");
    return p;
  };
  const pluginArg = { type: "object", properties: { plugin: { type: "string", description: "The plugin (app/composer, a vault plugin's path, app/settings-values for Carl's settings); left out: the first waiting draft." } }, additionalProperties: false };
  return {
    state: {
      changes: { description: "The drafts waiting for Carl (Change ready), each with whether he is trying it now on his laptop windows.", read: () => pendingChanges().map(describe) },
      trying: { description: "The drafts Carl is trying now (they run on his windows only; nothing on the box changes until Keep).", read: () => tryingNow().map(describe) },
      last: { description: "What happened last: kept, discarded, or discarded by itself and why.", read: () => outcome },
    },
    actions: {
      try: {
        description: "Try a waiting draft on Carl's windows (only when he asked). A settings draft (app/settings-values) of only the box's settings has no Try.",
        args: pluginArg,
        run: (a: Record<string, unknown>) => {
          const p = need(a);
          if (!p.triable) throw new Error(`${p.name}: ${p.what} is the box's, so it can't be tried on Carl's windows; Keep sets it`);
          tryChange(p.plugin, p.version);
          return describe(p);
        },
      },
      stop: { description: "Stop trying a draft: the copy in effect runs again.", args: pluginArg, run: (a: Record<string, unknown>) => { const p = need(a); stopTrying(p.plugin); return describe(p); } },
      keep: { description: "Keep a draft (only when Carl said so): a record; the box makes it the live copy.", args: pluginArg, run: async (a: Record<string, unknown>) => { const p = need(a); return keepChange(p.plugin, p.version, "agent"); } },
      discard: { description: "Discard a draft: a record; the box removes it.", args: pluginArg, run: async (a: Record<string, unknown>) => { const p = need(a); return discardChange(p.plugin, p.version, { by: "agent" }); } },
      switchBack: {
        description: "Switch a plugin back to the copy its last Keep replaced (undo; another switch redoes it).",
        args: { type: "object", properties: { plugin: { type: "string" } }, required: ["plugin"], additionalProperties: false },
        run: async (a: Record<string, unknown>) => switchBack(String(a.plugin ?? ""), "agent"),
      },
    },
  };
}

/** Tests: forget what this module holds. */
export function _resetChangeReady(): void {
  typing?.off();
  typing = null;
  tryVault = null;
  tries = NONE;
  vaultSlots = [];
  outcome = null;
  autoDone.clear();
  revertDone.clear();
  setSettingsTry(null);
}

