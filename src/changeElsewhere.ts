// A change line about a vault the laptop does not have open. The app folds the change records of its open vault only
// (src/pluginSupervisorApp.ts), so a "Done: …" for a plugin of another vault (the chat's vault, while the laptop shows
// another) drew no Undo: its records were not there (2026-11-20). The line names its vault (ChangeRef.vault, written by
// server/changeNotices.ts); here that vault's records are read from the box on their own, and Undo writes the switch
// into that vault (the same POST /api/v2/supervisor, scoped with ?vault=).
import { useCallback, useEffect, useState } from "react";
import { boxGet, boxLinkFor, boxPost, type Link } from "./boxChat";
import { useStore } from "./store";
import { Supervisor, type SupervisorRecord } from "./pluginSupervisor";
import type { ChangeRecord } from "./pluginDrafts";
import type { ChangeRef } from "./changeFlow";

/** A vault's folder name: how a change line names it. */
export const vaultNameOf = (p: string | null | undefined): string => (p ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "";

/** Whether a change line is about a vault other than the one open here. */
export function isElsewhere(change: Pick<ChangeRef, "vault">, openVault: string | null | undefined): boolean {
  return !!change.vault && change.vault.toLowerCase() !== vaultNameOf(openVault).toLowerCase();
}

/** The change records of one plugin in the box's records of a vault. */
export function changesIn(records: readonly SupervisorRecord[], plugin: string): readonly ChangeRecord[] {
  const s = new Supervisor();
  for (const r of records) s.fold(r);
  return s.changes(plugin);
}

export type ElsewhereDeps = { link: (vault: string | null) => Promise<Link | null>; get: typeof boxGet; post: typeof boxPost };
const appDeps: ElsewhereDeps = { link: boxLinkFor, get: boxGet, post: boxPost };

/** That vault's records (null while unknown), and Undo (switch back) written there. */
export async function readElsewhere(change: ChangeRef, openVault: string | null, d: ElsewhereDeps = appDeps): Promise<{ link: Link; changes: readonly ChangeRecord[] } | null> {
  const base = await d.link(openVault).catch(() => null);
  if (!base || !change.vault) return null;
  const link = { ...base, vault: change.vault };
  const r = await d.get(link, "/api/v2/supervisor");
  return { link, changes: Array.isArray(r?.records) ? changesIn(r.records as SupervisorRecord[], change.plugin) : [] };
}

export async function undoElsewhere(change: ChangeRef, openVault: string | null, d: ElsewhereDeps = appDeps): Promise<{ ok: boolean; text: string }> {
  const base = await d.link(openVault).catch(() => null);
  if (!base || !change.vault) return { ok: false, text: "no box: Undo is written on the box" };
  const r = (await d.post({ ...base, vault: change.vault }, "/api/v2/supervisor", { plugin: change.plugin, change: "switch", by: "carl" })) as { ok?: boolean; data?: { text?: string; error?: string }; error?: string };
  return { ok: !!r.ok, text: String(r.data?.text ?? r.data?.error ?? r.error ?? (r.ok ? "done" : "the box refused it")) };
}

/** For ChangeLine: null when the change is this vault's (the usual records apply); else that vault's records and Undo. */
export function useElsewhere(change: ChangeRef): { changes: readonly ChangeRecord[] | null; undo: () => Promise<{ ok: boolean; text: string }> } | null {
  const open = useStore((s) => s.vaultPath);
  const away = isElsewhere(change, open);
  const [changes, setChanges] = useState<readonly ChangeRecord[] | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!away) return;
    let live = true;
    readElsewhere(change, open)
      .then((r) => live && setChanges(r?.changes ?? []))
      .catch(() => live && setChanges([]));
    return () => {
      live = false;
    };
  }, [away, change.plugin, change.version, change.vault, open, tick]);
  const undo = useCallback(async () => {
    const r = await undoElsewhere(change, open);
    setTick((t) => t + 1);
    return r;
  }, [change, open]);
  return away ? { changes, undo } : null;
}
