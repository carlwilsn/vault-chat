// Vault plugins in the app (src/vaultPlugins.ts): every code file in <vault>/.vault-chat/plugins is mounted through the
// plugin host (light DOM, fully trusted), under the supervisor by its id (its vault path). The folder is read at startup
// and every few seconds after (a file added, changed or removed, by the agent or by a box sync merge, is live with no app
// update): a changed file is a fresh mount (its effects reverted first), a removed one is unmounted.
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AppPluginMount } from "./PluginMount";
import { useStore } from "./store";
import { VAULT_PLUGIN_DIR, VAULT_PLUGIN_MAX_BYTES, isVaultPluginFile, parseVaultPluginMeta, vaultPluginId } from "./vaultPlugins";

export type VaultPluginFile = { file: string; id: string; name: string; code: string };
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
  for (const e of entries) {
    if (e.is_dir || !isVaultPluginFile(e.name)) continue;
    try {
      const code = await call<string>("read_text_file", { path: e.path });
      if (code.length > VAULT_PLUGIN_MAX_BYTES) continue;
      out.push({ file: e.name, id: vaultPluginId(e.name), name: parseVaultPluginMeta(code, e.name).name, code });
    } catch {
      /* mid-write or gone: the next look sees it */
    }
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
        const sig = (l: VaultPluginFile[]) => l.map((p) => `${p.file}\u0000${p.code}`).join("\u0001");
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
  return <AppPluginMount plugin={info} code={p.code} />;
}

export function VaultPlugins() {
  const vault = useStore((s) => s.vaultPath);
  const list = useVaultPlugins(vault);
  return (
    <>
      {list.map((p) => (
        <One key={p.id} p={p} />
      ))}
    </>
  );
}
