// Vault plugins in the app (src/vaultPlugins.ts): every code file in <vault>/.vault-chat/plugins is mounted through the
// plugin host (light DOM, fully trusted), under the supervisor by its id (its vault path). The folder is read at startup
// and every few seconds after (a file added, changed or removed, by the agent or by a box sync merge, is live with no app
// update): a changed file is a fresh mount (its effects reverted first), a removed one is unmounted.
//
// Drafts (change by asking, src/pluginDrafts.ts): <name>.draft.js next to a plugin (or alone: a new plugin) never mounts
// by itself. It is listed in Change ready (src/changeReady.ts) and runs while Carl tries it, or once kept; a draft that
// fails while tried discards itself.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AppPluginMount } from "./PluginMount";
import { useStore } from "./store";
import { VAULT_PLUGIN_DIR, VAULT_PLUGIN_MAX_BYTES, isVaultPluginFile, parseVaultPluginMeta, vaultPluginId, vaultPluginRunsOn } from "./vaultPlugins";
import { chooseCopy, slotFileOf } from "./pluginDrafts";
import { autoDiscard, setVaultSlots, useTried } from "./changeReady";
import { supervisorChangesNow, useSupervisorVersion } from "./pluginSupervisorApp";

/** A plugin of the folder: its live file (`code`; "" with `added` when only a draft is there) and its draft and the
 *  copy the last Keep replaced, when there are. */
export type VaultPluginFile = { file: string; id: string; name: string; code: string; draft?: string; prev?: string; added?: boolean };
type Invoke = <T>(cmd: string, args: Record<string, unknown>) => Promise<T>;

/** Read the plugin folder: every plugin file with its code, by name. A missing folder is no plugins; an unreadable file is skipped. */
export async function scanVaultPlugins(vault: string, call: Invoke = invoke as Invoke): Promise<VaultPluginFile[]> {
  const dir = `${vault.replace(/\\/g, "/").replace(/\/+$/, "")}/${VAULT_PLUGIN_DIR}`;
  let entries: { name: string; path: string; is_dir: boolean }[];
  try {
    entries = await call("list_dir", { path: dir });
  } catch {
    return [];
  }
  const out: VaultPluginFile[] = [];
  const extra = new Map<string, { draft?: string; prev?: string }>();
  for (const e of entries) {
    const slot = e.is_dir ? null : slotFileOf(e.name);
    if (!slot || (slot.kind === "live" && !isVaultPluginFile(e.name))) continue;
    try {
      const code = await call<string>("read_text_file", { path: e.path });
      if (code.length > VAULT_PLUGIN_MAX_BYTES) continue;
      // A plugin whose meta names only other surfaces (devices: "phone") is not mounted here.
      if (!vaultPluginRunsOn(code, "laptop")) continue;
      const file = `${slot.base}${slot.ext}`;
      if (slot.kind !== "live") (extra.get(file) ?? extra.set(file, {}).get(file)!)[slot.kind] = code;
      else out.push({ file: e.name, id: vaultPluginId(e.name), name: parseVaultPluginMeta(code, e.name).name, code });
    } catch {
      /* mid-write or gone: the next look sees it */
    }
  }
  for (const [file, x] of extra) {
    const p = out.find((o) => o.file === file);
    if (p) Object.assign(p, x);
    else if (x.draft !== undefined) out.push({ file, id: vaultPluginId(file), name: parseVaultPluginMeta(x.draft, file).name, code: "", added: true, ...x });
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : 1));
}

/** The folder's plugins, kept current: the same list object while nothing changed. */
export function useVaultPlugins(vault: string | null, everyMs = 2000): VaultPluginFile[] {
  const [list, setList] = useState<VaultPluginFile[]>([]);
  useEffect(() => {
    if (!vault) return setList([]);
    let alive = true;
    let busy = false;
    const look = async () => {
      if (busy) return;
      busy = true;
      try {
        const next = await scanVaultPlugins(vault);
        if (!alive) return;
        const sig = (l: VaultPluginFile[]) => l.map((p) => `${p.file}\u0000${p.code}\u0000${p.draft ?? ""}\u0000${p.prev ?? ""}`).join("\u0001");
        setList((prev) => (sig(prev) === sig(next) ? prev : next));
      } finally {
        busy = false;
      }
    };
    void look();
    const t = setInterval(look, everyMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [vault, everyMs]);
  return list;
}

function One({ p }: { p: VaultPluginFile }) {
  const info = useMemo(() => ({ id: p.id, name: p.name }), [p.id, p.name]);
  const tried = useTried(p.id);
  useSupervisorVersion();
  const slot = { ...(p.added ? {} : { live: p.code }), ...(p.draft !== undefined ? { draft: p.draft } : {}), ...(p.prev !== undefined ? { prev: p.prev } : {}) };
  const choice = chooseCopy(slot, supervisorChangesNow(p.id), tried);
  const code = choice.kind ? slot[choice.kind] : undefined;
  if (code === undefined) return null;
  // A tried draft that fails discards itself; the copy in effect runs again.
  const fallback = choice.why === "tried" && tried ? (info: { error: string | null }): ReactNode => (info.error ? <DraftFailed plugin={p.id} version={tried} why={info.error} /> : null) : undefined;
  return <AppPluginMount key={choice.kind ?? "none"} plugin={info} code={code} fallback={fallback} />;
}

function DraftFailed({ plugin, version, why }: { plugin: string; version: string; why: string }) {
  useEffect(() => autoDiscard(plugin, version, `it stopped: ${why}`), [plugin, version, why]);
  return null;
}

export function VaultPlugins() {
  const vault = useStore((s) => s.vaultPath);
  const list = useVaultPlugins(vault);
  // Change ready lists the drafts here.
  useEffect(() => setVaultSlots(list.map((p) => ({ id: p.id, name: p.name, ...(p.added ? {} : { live: p.code }), ...(p.draft !== undefined ? { draft: p.draft } : {}), ...(p.prev !== undefined ? { prev: p.prev } : {}) }))), [list]);
  return (
    <>
      {list.map((p) => (
        <One key={p.id} p={p} />
      ))}
    </>
  );
}
