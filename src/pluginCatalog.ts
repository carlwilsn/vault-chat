// The catalog (base spec change 1.4): what the system can do, read-only. The registered services (src/liveServices.ts,
// the one place a service is declared) and the plugins in a vault: a plugin is a vault .html page with a manifest, a
// `<meta name="vc-capabilities">` (the services it needs) and/or a `<meta name="vc-mount">` (where its code runs).
// The box reads the vault (server/pluginCatalog.ts) and answers a page granted `catalog` (vc.catalog()), the app or
// a loopback caller (GET /api/v2/plugin/catalog) and the agent (its Catalog tool), all from these functions.
// Shared by the app and the box: no node imports.
import { LIVE_SERVICES, serviceOfCap } from "./liveServices";
import { parseLiveMount, parseLiveNeeds, type LiveMount } from "./liveBridge";

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
  mount: LiveMount;
  /** The registered services its manifest names (by service name). */
  needs: string[];
  /** Names its manifest gives that no registered service has. */
  refused: string[];
};

export type Catalog = { services: CatalogService[]; plugins: CatalogPlugin[]; truncated?: boolean };

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
  lines.push("", `Plugins in this vault (${c.plugins.length}${c.truncated ? ", list cut short" : ""}): .html pages with a vc-capabilities or vc-mount manifest`);
  if (!c.plugins.length) lines.push("- none");
  for (const p of c.plugins) {
    lines.push(`- ${p.id}${p.name !== p.id.split("/").pop() ? ` "${p.name}"` : ""}: ${p.mount}; needs ${p.needs.length ? p.needs.join(", ") : "nothing"}${p.refused.length ? `; unknown: ${p.refused.join(", ")}` : ""}`);
  }
  return lines.join("\n");
}
