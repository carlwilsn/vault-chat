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
// - The state and the actions are offers (app/changes: PluginRead / PluginAct), so the agent sees whether Carl is
//   trying a draft.
import { useMemo, useSyncExternalStore } from "react";
import { useStore } from "./store";
import { appPluginFolder, LIVE_APP_PLUGINS } from "./appPluginLive";
import { liveCopiesNow, useAllLiveCopies, type LiveCopies } from "./appPluginLiveHost";
import { postPluginChange, supervisorChangesNow, useSupervisorVersion } from "./pluginSupervisorApp";
import { APP_PLUGINS } from "./appPlugins";
import { BUILT_IN, TRY_SLOW_MS, draftPending, draftWhat, landing, slowMedian, type SlotCode } from "./pluginDrafts";

export const CHANGES_PLUGIN = { id: "app/changes", name: "Change ready" } as const;

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
    if (v) out.push({ plugin: id, name: appName(id), what: draftWhat(code.draft!), version: v, added: false });
  }
  for (const s of slots) {
    const v = draftPending(s, supervisorChangesNow(s.id));
    if (v) out.push({ plugin: s.id, name: s.name, what: draftWhat(s.draft!), version: v, added: s.live === undefined });
  }
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
  return useMemo(() => pendingChanges(all, slots), [all, slots, rv]);
}

/** The plugins Carl is trying now (pending drafts only), with the version. */
export function tryingNow(pending: readonly PendingChange[] = pendingChanges()): PendingChange[] {
  return pending.filter((p) => triedVersion(p.plugin) === p.version);
}

// ---------------------------------------------------------------- what happened last (the notice's line)

export type Outcome = { plugin: string; name: string; text: string; ok: boolean; at: number };
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
export const clearOutcome = () => say(null);
export const lastOutcome = () => outcome;

const nameOf = (plugin: string) => (plugin.startsWith("app/") ? appName(plugin) : vaultSlots.find((s) => s.id === plugin)?.name ?? plugin.split("/").pop() ?? plugin);

// ---------------------------------------------------------------- the actions

/** Try a draft (Carl's windows only). */
export function tryChange(plugin: string, version: string): void {
  say(null);
  setTried(plugin, version);
}

/** Stop trying: the copy in effect runs again. */
export function stopTrying(plugin: string): void {
  setTried(plugin, null);
}

/** Keep a draft: the record (the box moves the files); this window stops "trying", the kept copy runs as live. */
export async function keepChange(plugin: string, version: string, by = "carl"): Promise<{ ok: boolean; text: string }> {
  const r = await postPluginChange({ plugin, change: "keep", version, by });
  if (r.ok) setTried(plugin, null);
  say({ plugin, name: nameOf(plugin), text: r.ok ? "Kept. Switch back undoes it." : `Not kept: ${r.text}`, ok: r.ok, at: Date.now() });
  return r;
}

/** Discard a draft: this window falls back at once, then the record (the box removes the file). */
export async function discardChange(plugin: string, version: string, opts: { by?: string; reason?: string } = {}): Promise<{ ok: boolean; text: string }> {
  setTried(plugin, null);
  const r = await postPluginChange({ plugin, change: "discard", version, by: opts.by ?? "carl", ...(opts.reason ? { reason: opts.reason } : {}) });
  if (!opts.reason) say({ plugin, name: nameOf(plugin), text: r.ok ? "Discarded." : `Discard not written: ${r.text}`, ok: r.ok, at: Date.now() });
  return r;
}

/** Switch back: the copy the last Keep replaced runs again (a record; undo is another switch). */
export async function switchBack(plugin: string, by = "carl"): Promise<{ ok: boolean; text: string }> {
  const r = await postPluginChange({ plugin, change: "switch", by });
  say({ plugin, name: nameOf(plugin), text: r.ok ? r.text : `Not switched: ${r.text}`, ok: r.ok, at: Date.now() });
  return r;
}

/** Whether the plugin has a kept change Switch back can undo (the newest keep/switch record). */
export function canSwitchBack(plugin: string): boolean {
  const l = landing(supervisorChangesNow(plugin));
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
  void postPluginChange({ plugin, change: "discard", version, by: "auto", reason: short });
}

// ---------------------------------------------------------------- typing while a draft is tried

let typing: { off: () => void; samples: number[] } | null = null;

/** Measure composer / Ctrl+K keystroke-to-paint only while something is tried (nothing is listening otherwise). */
function watchTyping(): void {
  const any = Object.keys(tries).length > 0;
  if (!any) {
    typing?.off();
    typing = null;
    return;
  }
  if (typing || typeof window === "undefined" || typeof window.addEventListener !== "function" || typeof requestAnimationFrame !== "function") return;
  const samples: number[] = [];
  const onInput = (e: Event) => {
    const t = e.target as Element | null;
    if (!t || typeof t.closest !== "function" || !t.closest('[data-perf-target="composer"], [data-perf-target="ctrl-k"]')) return;
    if (document.hidden) return; // a hidden window's frames are throttled: not typing speed
    const t0 = performance.now();
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        samples.push(performance.now() - t0);
        if (samples.length > 40) samples.splice(0, samples.length - 40);
        const m = slowMedian(samples);
        if (m === null || m <= TRY_SLOW_MS) return;
        samples.length = 0;
        for (const [plugin, version] of Object.entries(tries)) autoDiscard(plugin, version, `typing got slow while it was tried (median ${Math.round(m)} ms a key, the limit is ${TRY_SLOW_MS} ms)`);
      }),
    );
  };
  window.addEventListener("input", onInput, true);
  typing = { samples, off: () => window.removeEventListener("input", onInput, true) };
}

/** Start following what this app's windows try (the app calls it once at start). */
export function startChangeReady(): void {
  followTries();
  hookStorage();
  watchTyping();
}

// ---------------------------------------------------------------- the offers (PluginRead / PluginAct)

const describe = (p: PendingChange) => ({ plugin: p.plugin, name: p.name, what: p.what || null, version: p.version, added: p.added, trying: triedVersion(p.plugin) === p.version });

export function changeOffers() {
  const need = (args: Record<string, unknown>) => {
    const plugin = String(args.plugin ?? "");
    const p = pendingChanges().find((x) => x.plugin === plugin || x.name.toLowerCase() === plugin.toLowerCase()) ?? (plugin ? null : pendingChanges()[0] ?? null);
    if (!p) throw new Error(plugin ? `no draft of ${plugin} is waiting` : "no draft is waiting");
    return p;
  };
  const pluginArg = { type: "object", properties: { plugin: { type: "string", description: "The plugin (app/composer, or a vault plugin's path); left out: the first waiting draft." } }, additionalProperties: false };
  return {
    state: {
      changes: { description: "The drafts waiting for Carl (Change ready), each with whether he is trying it now on his laptop windows.", read: () => pendingChanges().map(describe) },
      trying: { description: "The drafts Carl is trying now (they run on his windows only; nothing on the box changes until Keep).", read: () => tryingNow().map(describe) },
      last: { description: "What happened last: kept, discarded, or discarded by itself and why.", read: () => outcome },
    },
    actions: {
      try: { description: "Try a waiting draft on Carl's windows (only when he asked).", args: pluginArg, run: (a: Record<string, unknown>) => { const p = need(a); tryChange(p.plugin, p.version); return describe(p); } },
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
}

