// The laptop app's reconciler (change 1.6; records and rules in src/pluginSupervisor.ts). It folds the box's
// plugin.desired / plugin.budget records (once from GET /api/v2/supervisor, then as they arrive on the feed: src/boxChat.ts)
// and every view of a plugin (the viewer, a chat's inline copy; an iframe or an in-process mount) follows it through
// usePluginDesired: stopped, the view takes the plugin down (unmounting reverts its effects; the live bridge lets go of
// its frames) and shows the one "turned off" line; running again, it mounts it afresh. No box: every plugin runs.
//
// Until the records are known no view mounts its plugin (usePluginDesired answers null), so a plugin that is turned off
// is never painted on start. The records last seen are kept per vault in localStorage and folded synchronously when the
// app starts (log seqs never go back, so the box's answer folds on top of them): with a copy, the first paint is right.
import { useCallback, useSyncExternalStore } from "react";
import { boxGet, boxLinkFor, boxPost } from "./boxChat";
import { useStore } from "./store";
import { PLUGIN_STOPPED_EVENT } from "./liveBridge";
import { pluginIdOf, Reconciler, Supervisor, type Desired, type SupervisorRecord } from "./pluginSupervisor";
import type { ChangeRecord } from "./pluginDrafts";
import { DAILY_IN_EFFECT, type PresetInEffect } from "./appPreset";

let vault: string | null = null;
let sup = new Supervisor();
let rec = new Reconciler(sup);
let loading: Promise<void> | null = null;
/** Whether this vault's records are known (its cached copy, or the box's answer, or no box to ask). */
let known = false;
const listeners = new Set<() => void>();
const CACHE = "vc.supervisor:";
/** How often, and how long apart, a failed read is tried again (the box may be restarting with an update). */
const RETRIES = 20;
const RETRY_MS = 3000;

function cached(v: string | null): SupervisorRecord[] | null {
  try {
    const raw = v ? globalThis.localStorage?.getItem(CACHE + v) : null;
    const list = raw ? JSON.parse(raw) : null;
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  }
}

function keep(): void {
  try {
    if (vault) globalThis.localStorage?.setItem(CACHE + vault, JSON.stringify(sup.records()));
  } catch {
    /* no storage: the next start waits for the box */
  }
}

/** Bumped whenever records are folded or another vault's fold starts: what change records' readers follow. */
let version = 0;
const recordListeners = new Set<() => void>();

function notifyAll(): void {
  version++;
  for (const fn of [...listeners]) fn();
  for (const fn of [...recordListeners]) fn();
}

/** A fresh fold for another vault, seeded from its cached records. */
function forVault(v: string | null): void {
  if (v === vault) return;
  vault = v;
  sup = new Supervisor();
  rec = new Reconciler(sup);
  loading = null;
  const list = cached(v);
  for (const r of list ?? []) sup.fold(r);
  known = list !== null;
  notifyAll();
}

/** Records of the box's feed (vault-level ones): the supervisor's are folded, everything else is ignored. */
export function foldSupervisorRecords(records: readonly SupervisorRecord[]): void {
  let any = false;
  for (const r of records) any = sup.fold(r) || any;
  if (!any) return;
  keep();
  rec.changed();
  version++;
  for (const fn of [...recordListeners]) fn();
}

/** Read every record from the box (once per vault, or again with `fresh`). */
export function loadSupervisor(fresh = false, tries = RETRIES): Promise<void> {
  forVault(useStore.getState().vaultPath);
  if (loading && !fresh) return loading;
  const v = vault;
  loading = (async () => {
    const link = await boxLinkFor(v).catch(() => null);
    let read = false;
    if (link) {
      try {
        const r = await boxGet(link, "/api/v2/supervisor");
        if (vault === v && Array.isArray(r?.records)) {
          foldSupervisorRecords(r.records);
          keep();
        }
        read = true;
      } catch (e) {
        // A box from before the supervisor (404): every plugin runs. Unreachable: try again soon.
        read = (e as { status?: number }).status === 404;
      }
    }
    if (vault !== v) return;
    if (!read && tries > 0) {
      const t = setTimeout(() => vault === v && void loadSupervisor(true, tries - 1), RETRY_MS);
      (t as { unref?: () => void }).unref?.();
    }
    // Nothing to wait for any more (or a copy already says what to show): views mount what runs.
    if (!known && (read || !link || tries === 0)) {
      known = true;
      notifyAll();
    }
  })();
  return loading;
}

// The vault the app starts in: its cached records, before the first render.
forVault(useStore.getState().vaultPath);

const key = (d: Desired) => `${d.state}\u0000${d.by ?? ""}\u0000${d.reason ?? ""}`;

/**
 * What a view of the plugin should be now; it re-renders when that changes (a record, or a word's time coming).
 * null: not known yet, so the view shows nothing of the plugin (neither it nor its off line).
 */
export function usePluginDesired(path: string | null | undefined): Desired | null {
  const id = path ? pluginIdOf(path) : "";
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!id) return () => {};
      const onChange = (d: Desired) => {
        // The live bridge lets go of what it holds for the plugin's frames before they go.
        if (d.state === "stopped" && typeof window !== "undefined") window.dispatchEvent(new CustomEvent(PLUGIN_STOPPED_EVENT, { detail: { plugin: id } }));
        notify();
      };
      void loadSupervisor();
      let off = rec.watch(id, onChange);
      // Another vault (watch its reconciler instead), or the records just became known.
      const again = () => {
        off();
        off = rec.watch(id, onChange);
        notify();
      };
      listeners.add(again);
      // Another vault chosen: its records (cached, then the box's).
      const unStore = useStore.subscribe((s) => {
        if (s.vaultPath !== vault) void loadSupervisor();
      });
      return () => {
        unStore();
        listeners.delete(again);
        off();
      };
    },
    [id],
  );
  // Known only for the vault the records are of (another one chosen: not yet).
  const ready = () => known && vault === useStore.getState().vaultPath;
  const get = () => (!id ? "running" : ready() ? key(rec.desired(id)) : "unknown");
  const snap = useSyncExternalStore(subscribe, get, get);
  void snap;
  if (!id) return { state: "running", by: null, reason: null, seq: 0, next: null };
  return ready() ? rec.desired(id) : null;
}

/** What usePluginDesired would say now, outside React (null: not known yet). */
export function pluginDesiredNow(path: string): Desired | null {
  const id = pluginIdOf(path);
  return known && vault === useStore.getState().vaultPath ? rec.desired(id) : null;
}

/** Carl's word from a view (the off line's Turn on): a plugin.desired record on the box. */
export async function setPluginRunning(path: string, running: boolean): Promise<boolean> {
  const link = await boxLinkFor(useStore.getState().vaultPath).catch(() => null);
  if (!link) return false;
  const r = await boxPost(link, "/api/v2/supervisor", { plugin: pluginIdOf(path), state: running ? "running" : "stopped" });
  // The record also arrives on the feed; reading it now makes the view follow at once.
  await loadSupervisor(true);
  return r.ok;
}

/** Tests: the reconciler the app's views follow (`known`: whether the current vault's records are known). */
export function _appReconciler(isKnown?: boolean): Reconciler {
  if (isKnown !== undefined) forVault(useStore.getState().vaultPath);
  if (isKnown !== undefined && isKnown !== known) {
    known = isKnown;
    notifyAll();
  }
  return rec;
}

// ---------------------------------------------------------------- change records (src/pluginDrafts.ts)

function onRecords(fn: () => void): () => void {
  recordListeners.add(fn);
  void loadSupervisor();
  const unStore = useStore.subscribe((s) => {
    if (s.vaultPath !== vault) void loadSupervisor();
  });
  return () => {
    unStore();
    recordListeners.delete(fn);
  };
}
const recordVersion = () => version;

/** Follow the change records: re-renders when any supervisor record arrives (cheap: a counter). */
export function useSupervisorVersion(): number {
  return useSyncExternalStore(onRecords, recordVersion, recordVersion);
}

/** The plugin's change records now (keep / discard / switch), oldest first; none until the vault's records are known. */
export function supervisorChangesNow(plugin: string): readonly ChangeRecord[] {
  forVault(useStore.getState().vaultPath);
  return sup.changes(plugin);
}

/** Carl's word on a draft ({plugin, change, version, reason?, by?}): the box moves the files and writes the record. */
export async function postPluginChange(body: { plugin: string; change: "keep" | "discard" | "switch"; version?: string; reason?: string; by?: string } & Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
  const link = await boxLinkFor(useStore.getState().vaultPath).catch(() => null);
  if (!link) return { ok: false, text: "no box: Keep and Discard are written on the box" };
  try {
    const r = await boxPost(link, "/api/v2/supervisor", body);
    await loadSupervisor(true);
    const d = (r as { data?: { text?: string; error?: string }; error?: string });
    return { ok: !!r.ok, text: String(d.data?.text ?? d.data?.error ?? d.error ?? (r.ok ? "done" : "the box refused it")) };
  } catch (e) {
    return { ok: false, text: String((e as Error)?.message ?? e) };
  }
}

// ---------------------------------------------------------------- the app's preset (src/appPreset.ts)

/** The preset the records put in effect (the cached copy at start, then the box's), else the built-in daily one.
 *  What Carl tries on top of it is src/presetApp.ts's. */
export function recordPresetNow(): PresetInEffect {
  return known && vault === useStore.getState().vaultPath ? sup.preset() : DAILY_IN_EFFECT;
}
