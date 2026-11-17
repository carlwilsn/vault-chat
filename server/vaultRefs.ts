// "That file in vault Y": the registered vaults (server/sync.ts listVaults, the engine's VaultRef list) as a tool argument.
// Show, app/viewer's open (through Show's signal) and PluginRead take a file in any registered vault: a vault-relative
// path plus the vault's name, or an absolute path inside a registered vault. Left out, the conversation owner's vault,
// exactly as before. Only registered vaults: never an arbitrary folder.
import { resolve, sep } from "node:path";

export type NamedVault = { name: string; path: string };

const inside = (root: string, p: string) => {
  const r = resolve(root);
  const x = resolve(p);
  return x === r || x.startsWith(r.endsWith(sep) ? r : r + sep);
};

/**
 * The vault a tool call means and the path within it. `name` is null when it is the owner's vault (the default: the
 * call is what it always was); otherwise the registered vault's name, for the signal the laptop gets.
 */
export function vaultFor(own: string, vaults: NamedVault[] | undefined, vault: unknown, path: string): { vault: string; name: string | null; path: string } | { error: string } {
  const all = vaults ?? [];
  const asked = typeof vault === "string" ? vault.trim() : "";
  if (asked) {
    const v = all.find((x) => x.name.toLowerCase() === asked.toLowerCase()) ?? all.find((x) => resolve(x.path) === resolve(asked));
    if (!v) {
      // The owner's own vault by its folder name (a server that lists no vaults): the default.
      if (asked.toLowerCase() === (own.split(/[\\/]/).filter(Boolean).pop() ?? "").toLowerCase()) return { vault: own, name: null, path };
      return { error: `no registered vault is named "${asked}"${all.length ? ` (the vaults: ${all.map((x) => x.name).join(", ")})` : ""}` };
    }
    if (path.startsWith("/") && !inside(v.path, path)) return { error: `${path} is not inside the vault ${v.name} (${v.path})` };
    return { vault: v.path, name: resolve(v.path) === resolve(own) ? null : v.name, path };
  }
  if (path.startsWith("/") && !inside(own, path)) {
    const v = all.find((x) => inside(x.path, path));
    if (v) return { vault: v.path, name: v.name, path };
  }
  return { vault: own, name: null, path };
}
