// The laptop app's reconciler (change 1.6; records and rules in src/pluginSupervisor.ts). It folds the box's
// plugin.desired / plugin.budget records (once from GET /api/v2/supervisor, then as they arrive on the feed: src/boxChat.ts)
// and every view of a plugin (the viewer, a chat's inline copy; an iframe or an in-process mount) follows it through
// usePluginDesired: stopped, the view takes the plugin down (unmounting reverts its effects; the live bridge lets go of
// its frames) and shows the one "turned off" line; running again, it mounts it afresh. No box: every plugin runs.
import { useCallback, useSyncExternalStore } from "react";
import { boxGet, boxLinkFor, boxPost } from "./boxChat";
import { useStore } from "./store";
import { PLUGIN_STOPPED_EVENT } from "./liveBridge";
import { pluginIdOf, Reconciler, Supervisor, type Desired, type SupervisorRecord } from "./pluginSupervisor";

let vault: string | null = null;
let sup = new Supervisor();
let rec = new Reconciler(sup);
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** A fresh fold for another vault. */
function forVault(v: string | null): void {
  if (v === vault) return;
  vault = v;
  sup = new Supervisor();
  rec = new Reconciler(sup);
  loading = null;
  for (const fn of [...listeners]) fn();
}

/** Records of the box's feed (vault-level ones): the supervisor's are folded, everything else is ignored. */
export function foldSupervisorRecords(records: readonly SupervisorRecord[]): void {
  let any = false;
  for (const r of records) any = sup.fold(r) || any;
  if (any) rec.changed();
}

/** Read every record from the box (once per vault, or again with `fresh`). */
export function loadSupervisor(fresh = false): Promise<void> {
  forVault(useStore.getState().vaultPath);
  if (loading && !fresh) return loading;
  const v = vault;
  loading = (async () => {
    const link = await boxLinkFor(v).catch(() => null);
    if (!link) return;
    try {
      const r = await boxGet(link, "/api/v2/supervisor");
      if (vault === v && Array.isArray(r?.records)) foldSupervisorRecords(r.records);
    } catch {
      /* a box from before the supervisor: every plugin runs */
    }
  })();
  return loading;
}

const key = (d: Desired) => `${d.state}\u0000${d.by ?? ""}\u0000${d.reason ?? ""}`;

/** What a view of the plugin should be now; it re-renders when that changes (a record, or a word's time coming). */
export function usePluginDesired(path: string | null | undefined): Desired {
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
      // Another vault: watch its reconciler instead.
      const again = () => {
        off();
        off = rec.watch(id, onChange);
        notify();
      };
      listeners.add(again);
      return () => {
        listeners.delete(again);
        off();
      };
    },
    [id],
  );
  const snap = useSyncExternalStore(subscribe, () => (id ? key(rec.desired(id)) : "running\u0000\u0000"));
  void snap;
  return id ? rec.desired(id) : { state: "running", by: null, reason: null, seq: 0, next: null };
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

/** Tests: the reconciler the app's views follow. */
export function _appReconciler(): Reconciler {
  return rec;
}
