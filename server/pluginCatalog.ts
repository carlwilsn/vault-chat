// The catalog on the box (change 1.4; shapes in src/pluginCatalog.ts): the registered services and the plugins in a
// vault, read from the vault each time it is asked (no index to go stale). The walk enters the folders catalogEnters
// takes (no symlinks) and stops at CATALOG_LIMITS.
import { closeSync, openSync, readSync, readdirSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { CATALOG_LIMITS, catalogEnters, catalogPlugin, catalogReads, catalogServices, type Catalog, type CatalogPlugin } from "../src/pluginCatalog";

function readText(full: string, size: number): string | null {
  try {
    const fd = openSync(full, "r");
    try {
      const buf = Buffer.alloc(size);
      const n = readSync(fd, buf, 0, size, 0);
      return buf.subarray(0, n).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** The plugins in a vault, by path. */
export function vaultPlugins(vault: string): { plugins: CatalogPlugin[]; truncated: boolean } {
  const plugins: CatalogPlugin[] = [];
  let seen = 0;
  let truncated = false;
  const walk = (dir: string, rel: string, depth: number) => {
    if (truncated) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (++seen > CATALOG_LIMITS.entries || plugins.length >= CATALOG_LIMITS.plugins) {
        truncated = true;
        return;
      }
      const r = rel ? `${rel}/${e.name}` : e.name;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < CATALOG_LIMITS.depth && catalogEnters(r)) walk(full, r, depth + 1);
      } else if (e.isFile() && catalogReads(r)) {
        let size = 0;
        try {
          size = statSync(full).size;
        } catch {
          continue;
        }
        if (size > CATALOG_LIMITS.fileBytes) continue;
        const html = readText(full, size);
        const p = html === null ? null : catalogPlugin(r, html);
        if (p) plugins.push(p);
      }
    }
  };
  walk(vault, "", 0);
  return { plugins, truncated };
}

/** The whole catalog: the services, then the vault's plugins. */
export function pluginCatalog(vault: string): Catalog {
  const { plugins, truncated } = vaultPlugins(vault);
  return { services: catalogServices(), plugins, ...(truncated ? { truncated: true } : {}) };
}
