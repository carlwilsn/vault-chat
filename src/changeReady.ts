// What keeps a landed change safe in this app's windows (src/changeFlow.ts; records and rules in src/pluginDrafts.ts).
// There is no Try step: a change lands when the one gate passes it (a keep record) and runs here from the record. Not a
// plugin itself, so a change can never break what undoes it.
//
// - Tried drafts exist only in the preview harness (?try=, preview/runtime/boot.ts, for scripts/draft-check.ts). Carl's
//   windows never try anything.
// - After a keep, the kept copy is watched for KEEP_WATCH_MS: when it throws, fails to load or makes typing slow (within
//   KEEP_TYPING_MS of the keep), it switches back by itself (a switch record by "auto" naming the kept version, so two
//   windows switch once); the chat says why (server/changeNotices.ts autoUndone). Nothing listens to typing unless a
//   keep is under watch.
// - Switch back is the undo: a record (another switch redoes it).
// - After a core swap (src/coreFollow.ts) the window says plainly what runs now.
// - app/changes (PluginRead / PluginAct): what happened last, and switchBack.
import { useSyncExternalStore } from "react";
import { useStore } from "./store";
import { postPluginChange, supervisorChangedNow, supervisorChangesNow } from "./pluginSupervisorApp";
import { APP_PLUGINS } from "./appPlugins";
import { SETTINGS_DRAFT_ID, SETTINGS_DRAFT_NAME, pendingSettingsDraft, windowValues } from "./settingsRecords";
import { onSettingsDrafts, refreshBoxSettings, setSettingsTry, settingsDraftsNow } from "./settings";
import { isMigrationId } from "./migrations";
import { CORE_NAME, CORE_PART } from "./coreBundle";
import { UNDO_CHORD, plainWhy } from "./changeFlow";
import { BUILT_IN, KEEP_TYPING_MS, KEEP_WATCH_MS, TRY_SLOW_MS, landing, slowMedian, watchedKeep, type ChangeRecord, type SlotCode } from "./pluginDrafts";

export const CHANGES_PLUGIN = { id: "app/changes", name: "Changes" } as const;

// ---------------------------------------------------------------- what a gate run tries in this window

type Tries = Readonly<Record<string, string>>;
const NONE: Tries = Object.freeze({});
/** Where the preview harness puts the drafts its frame tries (preview/runtime/boot.ts, from ?try=). */
export const HARNESS_TRIES = "__vcHarnessTries";

function readTries(): Tries {
  const h = (globalThis as Record<string, unknown>)[HARNESS_TRIES];
  if (!h || typeof h !== "object") return NONE;
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(h as Record<string, unknown>)) if (typeof x === "string") out[k] = x;
  return out;
}

let tries: Tries | null = null;
const triesNow = (): Tries => (tries ??= readTries());
const noSubscribe = () => () => {};

/** The version of `plugin`'s draft a gate run tries in this window, or null (always null in Carl's windows). */
export function triedVersion(plugin: string): string | null {
  return triesNow()[plugin] ?? null;
}

/** triedVersion, for a component (null plugin: nothing). It never changes while the window runs. */
export function useTried(plugin: string | null): string | null {
  const get = () => (plugin ? triedVersion(plugin) : null);
  return useSyncExternalStore(noSubscribe, get, get);
}

// ---------------------------------------------------------------- Carl's settings (src/settings.ts)

/** A plugin's change records: the supervisor's, or for the settings, the settings' own (they live with them). */
export function changesOf(plugin: string): readonly ChangeRecord[] {
  return plugin === SETTINGS_DRAFT_ID ? settingsDraftsNow().changes : supervisorChangesNow(plugin);
}

/** A gate run that tries the settings draft shows its window settings over the records (in that window only). */
function syncSettingsTry(): void {
  const d = pendingSettingsDraft(settingsDraftsNow());
  const on = !!d && triedVersion(SETTINGS_DRAFT_ID) === d.version;
  setSettingsTry(on ? windowValues(d!.values) : null);
  // The page says which settings draft it shows (the gate's Drive run waits for it: server/gate.ts renderSettings).
  try {
    if (on) globalThis.document?.documentElement.setAttribute("data-vc-settings-try", d!.version);
    else globalThis.document?.documentElement.removeAttribute("data-vc-settings-try");
  } catch {
    /* no DOM */
  }
}

// ---------------------------------------------------------------- the vault plugins' slots (VaultPluginHost writes them)

export type VaultSlot = { id: string; name: string } & SlotCode;
let vaultSlots: readonly VaultSlot[] = [];

/** VaultPluginHost's last look at .vault-chat/plugins: each plugin's live, draft and prev code. */
export function setVaultSlots(list: readonly VaultSlot[]): void {
  vaultSlots = list;
}

/** After a switch of the core: the loader runs what is in effect now (src/coreFollow.ts); tests replace it. */
type CoreActs = { followNow: () => Promise<unknown> };
let coreActs: CoreActs = { followNow: async () => (await import("./coreFollow")).followCoreNow() };
/** Tests: the loader's side. */
export function _setCoreActs(a: CoreActs): void {
  coreActs = a;
}
const coreFollowNow = (plugin: string) => {
  if (plugin === CORE_PART) void coreActs.followNow().catch((e) => console.warn("[core] follow failed:", e));
};

// ---------------------------------------------------------------- what happened last (app/changes' `last`)

export type Outcome = { plugin: string; name: string; text: string; ok: boolean; at: number; /** the auto-revert record it tells of */ seq?: number };
let outcome: Outcome | null = null;
function say(o: Outcome | null): void {
  outcome = o;
}
export const clearOutcome = () => {
  if (outcome?.seq) markSeen(outcome.seq);
  say(null);
};
export const lastOutcome = () => outcome;

const appName = (id: string) => APP_PLUGINS.find((p) => p.id === id)?.name ?? id.replace(/^app\//, "");
const nameOf = (plugin: string) => (plugin === CORE_PART ? CORE_NAME : plugin === SETTINGS_DRAFT_ID ? SETTINGS_DRAFT_NAME : plugin.startsWith("app/") ? appName(plugin) : isMigrationId(plugin) ? `Data: ${plugin.slice(8)}` : plugin.startsWith("box/") ? `Box: ${plugin.slice(4)}` : vaultSlots.find((s) => s.id === plugin)?.name ?? plugin.split("/").pop() ?? plugin);

// ---------------------------------------------------------------- the undo

/** A word on a change: the box's route (for the settings too: it hands theirs to them); the settings then read back at
 *  once, not when the feed brings them. */
async function post(body: Parameters<typeof postPluginChange>[0]): Promise<{ ok: boolean; text: string }> {
  const r = await postPluginChange(body);
  if (body.plugin === SETTINGS_DRAFT_ID) await refreshBoxSettings();
  return r;
}

/** Switch back: the copy the last keep replaced runs again (a record; undo is another switch). */
export async function switchBack(plugin: string, by = "carl"): Promise<{ ok: boolean; text: string }> {
  const r = await post({ plugin, change: "switch", by });
  if (r.ok) coreFollowNow(plugin);
  say({ plugin, name: nameOf(plugin), text: r.ok ? r.text : `Not switched: ${r.text}`, ok: r.ok, at: Date.now() });
  return r;
}

/** Whether the plugin has a kept change Switch back can undo (the newest keep/switch record). */
export function canSwitchBack(plugin: string): boolean {
  const l = landing(changesOf(plugin));
  return !!l && (l.from ?? BUILT_IN) !== l.version;
}

// ---------------------------------------------------------------- after a keep: switching back by itself

/** Every plugin that can have drafts here: the app plugins with live copies and the vault plugins' slots. */
const slotIds = (): string[] => [...vaultSlots.map((s) => s.id), SETTINGS_DRAFT_ID, CORE_PART];
/** Every plugin a change can apply to here (the slots, the box's own plugins with records): the dead-man's switch
 *  watches them. */
export const changeablePlugins = (): string[] => [...new Set([...slotIds(), ...supervisorChangedNow().filter((p) => p.startsWith("box/"))])];

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
    if (r.ok) coreFollowNow(plugin);
    // Another window switched it first ("already switched"): the same outcome.
    if (!r.ok && !/already switched/.test(r.text)) {
      // Plain words for Carl (no versions); the details go to the log. Never a red developer alert.
      console.warn(`[changes] ${plugin}: wanted to switch back by itself (${short}) but the box said: ${r.text}`);
      return say({ plugin, name: nameOf(plugin), text: `Couldn't undo it by itself (${plainWhy(short)}). ${UNDO_CHORD} undoes it.`, ok: false, at: Date.now() });
    }
    // The record this tells of: dismissing it here dismisses it in every window.
    const rec = changesOf(plugin).filter((c) => c.change === "switch" && c.by === "auto" && c.seq > k.seq).pop();
    if (rec && outcome?.plugin === plugin && !outcome.seq) say({ ...outcome, seq: rec.seq });
  });
  return true;
}

const SEEN_KEY = "vc.changeSeen:";
const seenVault = () => useStore.getState().vaultPath;
const seenSeq = (): number => {
  try {
    const v = seenVault();
    return Number(v ? globalThis.localStorage?.getItem(SEEN_KEY + v) : 0) || 0;
  } catch {
    return 0;
  }
};
function markSeen(seq: number): void {
  try {
    const v = seenVault();
    if (v && seq > seenSeq()) globalThis.localStorage?.setItem(SEEN_KEY + v, String(seq));
  } catch {
    /* no storage: it shows again next start */
  }
}

/** A switch back by itself this window did not see happen (another window, before a restart): `last` says it. */
export function noticeAutoSwitch(now = Date.now()): void {
  if (outcome) return;
  const seen = seenSeq();
  let best: { plugin: string; seq: number; reason: string | null; at: number } | null = null;
  for (const plugin of changeablePlugins())
    for (const c of changesOf(plugin))
      if (c.change === "switch" && c.by === "auto" && c.seq > seen && now - c.at <= KEEP_WATCH_MS && (!best || c.seq > best.seq)) best = { plugin, seq: c.seq, reason: c.reason, at: c.at };
  if (best) say({ plugin: best.plugin, name: nameOf(best.plugin), text: `Switched back by itself${best.reason ? `: ${best.reason}` : ""}`, ok: false, at: best.at, seq: best.seq });
}

// ---------------------------------------------------------------- typing while a keep is watched

let typing: { off: () => void; samples: number[]; until: number; layout: string } | null = null;

/** What the screen holds that changes typing speed (the open files and how big, the split, full-screen chat): typing is
 *  only compared like with like, so a slowdown after Carl opens a 600-page PDF is not blamed on a change. */
export function layoutKey(): string {
  const s = useStore.getState() as unknown as { panes?: { file: string; content?: string }[]; splitDirection?: unknown; chatFullscreen?: unknown; rightCollapsed?: unknown };
  return JSON.stringify([(s.panes ?? []).map((p) => [p.file, Math.round((p.content?.length ?? 0) / 50_000)]), s.splitDirection ?? null, !!s.chatFullscreen, !!s.rightCollapsed]);
}

/** The keeps whose typing is still judged: applied less than KEEP_TYPING_MS ago (the watch for throwing stays longer). */
export function keepsForTyping(now = Date.now()): { plugin: string; version: string; until: number }[] {
  return keepsUnderWatch(now).flatMap((k) => (k.until - KEEP_WATCH_MS + KEEP_TYPING_MS > now ? [{ ...k, until: k.until - KEEP_WATCH_MS + KEEP_TYPING_MS }] : []));
}

/** Measure composer / Ctrl+K keystroke-to-paint only while a keep is under watch (nothing is listening otherwise).
 *  Called again when the records change. */
export function watchTyping(): void {
  const keeps = keepsForTyping();
  if (!keeps.length) {
    typing?.off();
    typing = null;
    return;
  }
  const until = Math.max(...keeps.map((k) => k.until));
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
    // Another layout than the samples were taken in (a file opened, the split changed): start over, like with like.
    const lk = layoutKey();
    if (typing && typing.layout !== lk) {
      typing.layout = lk;
      samples.length = 0;
    }
    const t0 = performance.now();
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (typing && typing.layout !== lk) return; // the screen changed while this key painted: not like with like
        samples.push(performance.now() - t0);
        if (samples.length > 40) samples.splice(0, samples.length - 40);
        const m = slowMedian(samples);
        if (m === null || m <= TRY_SLOW_MS) return;
        samples.length = 0;
        const ms = `median ${Math.round(m)} ms a key, the limit is ${TRY_SLOW_MS} ms`;
        for (const k of keepsForTyping()) autoRevert(k.plugin, k.version, `typing got slow after it was kept (${ms})`);
      }),
    );
  };
  window.addEventListener("input", onInput, true);
  typing = { samples, until, layout: layoutKey(), off: () => window.removeEventListener("input", onInput, true) };
}

// ---------------------------------------------------------------- after a core swap

let settingsHooked = false;
let swapChecked = false;
/** Once per page: a core swap just loaded this window, so say plainly what runs now (src/coreFollow.ts
 *  checkSwapOutcome): the new frontend, or why it could not switch. Tests replace the check. */
let swapCheck = async (): Promise<{ ok: boolean; text: string } | null> => (await import("./coreFollow")).checkSwapOutcome();
export function _setSwapCheck(fn: typeof swapCheck): void {
  swapChecked = false;
  swapCheck = fn;
}
function checkCoreSwap(): void {
  if (swapChecked) return;
  swapChecked = true;
  void swapCheck()
    .then((r) => {
      if (!r) return;
      console.info(`[core] after the swap: ${r.text}`);
      say({ plugin: CORE_PART, name: CORE_NAME, text: r.text, ok: r.ok, at: Date.now() });
    })
    .catch((e) => console.warn("[core] could not say what runs after the swap:", e));
}

/** Start (the app's ChangeKeeper calls it once). */
export function startChangeReady(): void {
  checkCoreSwap();
  if (!settingsHooked) {
    settingsHooked = true;
    // A settings draft arrived, was decided or replaced: a gate run's window follows (and a keep may be watched).
    onSettingsDrafts(() => {
      syncSettingsTry();
      watchTyping();
    });
  }
  syncSettingsTry();
  watchTyping();
}

// ---------------------------------------------------------------- the offers (PluginRead / PluginAct)

export function changeOffers() {
  return {
    state: {
      last: { description: "What happened last to a landed change here: switched back (by Carl, or by itself and why), or what runs after a core swap.", read: () => outcome },
    },
    actions: {
      switchBack: {
        description: "Switch a part back to the copy its last keep replaced (the undo; another switch redoes it).",
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
  tries = null;
  vaultSlots = [];
  outcome = null;
  revertDone.clear();
  setSettingsTry(null);
}
