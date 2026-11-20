// The catalog (base spec change 1.4): what the system can do, read-only. The registered services (src/liveServices.ts,
// the one place a service is declared) and the plugins in a vault: a plugin is a vault .html page with a manifest, a
// `<meta name="vc-capabilities">` (the services it needs) and/or a `<meta name="vc-mount">` (where its code runs).
// The box reads the vault (server/pluginCatalog.ts) and answers a page granted `catalog` (vc.catalog()), the app or
// a loopback caller (GET /api/v2/plugin/catalog) and the agent (its Catalog tool), all from these functions.
// Shared by the app and the box: no node imports.
import { LIVE_SERVICES, serviceOfCap } from "./liveServices";
import { parseLiveMount, parseLiveNeeds, type LiveMount } from "./liveBridge";
import { APP_PLUGINS, SURFACE_PLUGINS } from "./appPlugins";
import { APP_PLUGIN_LIVE_DIR } from "./appPluginLive";
import { VAULT_PLUGIN_DIR } from "./vaultPlugins";

export type CatalogService = {
  name: string;
  description: string;
  /** "box": the box answers it; "host": the app or phone supplies it. */
  supplier: "box" | "host";
  /** Whether naming it in a manifest and Carl's Allow opens anything (false: declared, opens nothing). */
  grantable: boolean;
  /** Every page has it without declaring it. */
  always: boolean;
  /** The page's function for it (`vc.<fn>`), if any. */
  call: string | null;
};

export type CatalogPlugin = {
  /** The plugin's id: its vault path, with forward slashes. */
  id: string;
  /** Its <title>, else its file name. */
  name: string;
  /** Where its code runs (src/liveBridge.ts parseLiveMount). */
  mount: LiveMount | "module";
  /** A code file in .vault-chat/plugins (src/vaultPlugins.ts): its meta description. */
  description?: string;
  /** A code file: the surfaces it mounts on (its meta's devices; the laptop when none). */
  devices?: string[];
  /** The registered services its manifest names (by service name). */
  needs: string[];
  /** Names its manifest gives that no registered service has. */
  refused: string[];
};

/** A part of the app that is a plugin (src/appPlugins.ts): turned off and on like a page, by its id. */
export type CatalogAppPlugin = {
  id: string;
  name: string;
  mount: string;
  description: string;
  /** Its copies in the vault that run instead of the built-in one (src/appPluginLive.ts), by id; absent: none. */
  copies?: string[];
};

export type Catalog = { services: CatalogService[]; plugins: CatalogPlugin[]; app?: CatalogAppPlugin[]; truncated?: boolean };

/** The app's own plugins, in registry order, then the surfaces (the phone app, the iPad board). */
export function catalogAppPlugins(copies: Readonly<Record<string, string[]>> = {}): CatalogAppPlugin[] {
  return [...APP_PLUGINS, ...SURFACE_PLUGINS].map((p) => ({ id: p.id, name: p.name, mount: p.mount, description: p.description, ...(copies[p.id]?.length ? { copies: copies[p.id] } : {}) }));
}

export const CATALOG_LIMITS = {
  /** Directory entries the walk looks at, at most (a huge vault gives a partial list, marked truncated). */
  entries: 50_000,
  /** Plugins listed, at most. */
  plugins: 500,
  /** A page bigger than this is not read (the gateway's own limit for a live page). */
  fileBytes: 8 * 1024 * 1024,
  /** Folders deep. */
  depth: 16,
};

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "target", "__pycache__", "venv", "site-packages"]);

/** Whether the catalog looks inside a folder (vault-relative): ordinary folders, and of the vault's own hidden folder
 *  only .vault-chat/visuals (where the agent's pages live); not other hidden, dependency or build folders. */
export function catalogEnters(rel: string): boolean {
  const name = rel.split("/").pop() ?? "";
  if (SKIP_DIRS.has(name)) return false;
  if (rel === ".vault-chat" || rel === ".vault-chat/visuals" || rel.startsWith(".vault-chat/visuals/")) return true;
  return !name.startsWith(".") && !rel.startsWith(".");
}

/** Whether the catalog reads a file (vault-relative): an .html page in a folder it enters. */
export function catalogReads(rel: string): boolean {
  const parts = rel.split("/");
  if (!/\.html?$/i.test(parts[parts.length - 1] ?? "") || parts.slice(0, -1).join("/") === ".vault-chat") return false;
  for (let i = 1; i < parts.length; i++) if (!catalogEnters(parts.slice(0, i).join("/"))) return false;
  return true;
}

/** Every registered service, in registry order. */
export function catalogServices(): CatalogService[] {
  return LIVE_SERVICES.map((s) => ({
    name: s.name,
    description: s.description,
    supplier: s.supplier,
    grantable: s.grantable,
    always: s.always === true,
    call: s.page ? `vc.${s.page}` : null,
  }));
}

const metaNamed = (html: string, name: string) =>
  [...html.matchAll(/<meta\b[^>]*>/gi)].some((m) => new RegExp(`\\bname\\s*=\\s*["']?${name}["']?(?=[\\s>/"'])`, "i").test(m[0]));

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };

/** A page as a plugin, or null when it declares neither services nor a mount. */
export function catalogPlugin(path: string, html: string): CatalogPlugin | null {
  const { caps, refused } = parseLiveNeeds(html);
  const mounted = metaNamed(html, "vc-mount");
  if (!caps.length && !refused.length && !mounted && !metaNamed(html, "vc-capabilities")) return null;
  const id = path.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
  const t = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "";
  const title = t
    .replace(/<[^>]*>/g, "")
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, e: string) => ENTITIES[e] ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  const needs: string[] = [];
  for (const cap of caps) {
    const s = serviceOfCap(cap)?.name;
    if (s && !needs.includes(s)) needs.push(s);
  }
  return { id, name: title || id.split("/").pop() || id, mount: parseLiveMount(html), needs, refused };
}

/** The catalog as text, for the agent. */
export function catalogText(c: Catalog): string {
  const lines = [`Services a page can name in <meta name="vc-capabilities" content="..."> (${c.services.length}, src/liveServices.ts):`];
  for (const s of c.services) {
    const how = [s.supplier === "box" ? "the box" : "the app/phone", s.always ? "every page has it, no grant" : s.grantable ? "Carl allows it once per page" : "declared, opens nothing", s.call].filter(Boolean).join("; ");
    lines.push(`- ${s.name} (${how}): ${s.description}`);
  }
  lines.push("", `Plugins in this vault (${c.plugins.length}${c.truncated ? ", list cut short" : ""}): .html pages with a vc-capabilities or vc-mount manifest, and code files in ${VAULT_PLUGIN_DIR}/ (live, no app update)`);
  if (!c.plugins.length) lines.push("- none");
  for (const p of c.plugins) {
    lines.push(p.mount === "module" ? `- ${p.id}${p.name !== p.id.split("/").pop() ? ` "${p.name}"` : ""}: code file, mounted in the app${p.description ? `; ${p.description}` : ""}` : `- ${p.id}${p.name !== p.id.split("/").pop() ? ` "${p.name}"` : ""}: ${p.mount}; needs ${p.needs.length ? p.needs.join(", ") : "nothing"}${p.refused.length ? `; unknown: ${p.refused.join(", ")}` : ""}`);
  }
  if (c.app?.length) {
    lines.push("", `Parts of the app that are plugins (${c.app.length}; the Plugins tool turns them off and on by id or name):`);
    for (const p of c.app) lines.push(`- ${p.id} "${p.name}" (${p.mount}): ${p.description}${p.copies?.length ? ` Runs its copy in the vault: ${p.copies.join(", then ")}.` : ""}`);
    lines.push(`Their code is live too: \`node --import tsx scripts/app-plugin-live.ts <name> --vault <vault> --draft --what "<one line>"\` in a vault-chat checkout builds src/plugins/<name> into ${APP_PLUGIN_LIVE_DIR}/<name>.draft.js (a vault plugin's draft: ${VAULT_PLUGIN_DIR}/<name>.draft.js, first line \`// @vc-change <one line>\`). A draft runs nowhere by itself: the laptop shows "Change ready: <what>" and Carl tries it on his windows, then keeps or discards it (each a plugin.change record; a draft that throws, fails to load or slows typing while tried discards itself). Before raising one, check it in a hidden copy: \`node --import tsx scripts/gate.ts <name> --vault <vault> [--synthetic | --data <copy of real data>]\` (the one gate: also preset and box/<name>) runs the live copy and the draft side by side on a copy of real data and answers pass / borderline / fail; the Plugins tool's submit runs it and lands the verdict. The app's offers (app/changes: PluginRead) say whether Carl is trying one. --keep / --discard / --back move the files without a record; --remove goes back to the built-in copy. The Plugins tool turns a copy off by its path.`);
    lines.push(`Which of them mount where, plus their settings, is the app's preset (the built-in "daily" one unless changed): PluginRead app/preset reads it and its places; PluginAct app/preset set / edit / reset switches or edits it live in every window, no release.`);
  }
  return lines.join("\n");
}
