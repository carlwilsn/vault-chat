// The preview's Vite plugin, added to each tree's dev server (vite-child.mjs).
// It never edits the tree: it injects the boot module ahead of /src/main.tsx,
// reroutes the reused server/commands ports' node imports to in-memory shims,
// serves fixtures and the phone page, and sends a CSP that blocks every
// outside origin at the browser level.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderPhone } from "./phone.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)); // <harness>/preview
const HARNESS = resolve(HERE, "..");
const posix = (p) => p.replace(/\\/g, "/");

const TEXT_EXT = new Set([
  "", ".md", ".markdown", ".txt", ".json", ".jsonl", ".html", ".htm", ".css", ".js", ".mjs", ".ts", ".tsx", ".py", ".ipynb",
  ".tex", ".bib", ".csv", ".tsv", ".yaml", ".yml", ".toml", ".sh", ".ps1", ".rs", ".go", ".c", ".h", ".cpp", ".java", ".svg",
  ".xml", ".ini", ".cfg", ".gitignore", ".vaultchatignore", ".vaultchatdeny", ".log", ".r", ".jl", ".sql", ".lua", ".rb",
]);
const LAZY_TEXT_OVER = 2 * 1024 * 1024;

/** Fixture bases: name → { vault folder name, directories overlaid in order
 *  (each mounted at a prefix inside the vault) }. */
export function baseDirs() {
  const out = {
    synthetic: {
      vaultName: "summer-demo",
      dirs: [
        { dir: join(HARNESS, "demo-vault"), prefix: "guide/" },
        { dir: join(HERE, "fixtures", "synthetic", "vault"), prefix: "" },
      ],
    },
  };
  const priv = join(HERE, "fixtures", "private");
  if (existsSync(priv))
    for (const n of readdirSync(priv)) {
      const v = join(priv, n, "vault");
      if (existsSync(v)) out[n] = { vaultName: n, dirs: [{ dir: v, prefix: "" }] };
    }
  return out;
}

function walk(dir, root, acc) {
  for (const n of readdirSync(dir)) {
    if (n === ".git" || n === "node_modules") continue;
    const p = join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, root, acc);
    else acc.set(posix(relative(root, p)), { path: p, size: st.size, mtime: st.mtimeMs });
  }
  return acc;
}

function loadBase(name) {
  const b = baseDirs()[name];
  if (!b) throw new Error(`unknown fixture base "${name}"`);
  const all = new Map();
  for (const { dir, prefix } of b.dirs) if (existsSync(dir)) for (const [rel, f] of walk(dir, dir, new Map())) all.set(prefix + rel, f);
  const files = {};
  const lazy = {};
  for (const [rel, f] of all) {
    const ext = extname(rel).toLowerCase();
    const isText = (TEXT_EXT.has(ext) || rel.startsWith(".")) && f.size <= LAZY_TEXT_OVER;
    if (isText) files[rel] = readFileSync(f.path, "utf8");
    else lazy[rel] = { url: `/__preview/fixture/${encodeURIComponent(name)}/${rel.split("/").map(encodeURIComponent).join("/")}`, size: f.size };
  }
  return { name, vaultName: b.vaultName, files, lazy, mtime: Date.parse("2026-10-09T18:00:00Z") };
}

function fixtureFile(name, rel) {
  const b = baseDirs()[name];
  if (!b) return null;
  for (const { dir, prefix } of [...b.dirs].reverse()) {
    if (!rel.startsWith(prefix)) continue;
    const p = resolve(dir, rel.slice(prefix.length));
    if (!p.startsWith(resolve(dir))) return null;
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

const MIME = { ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".mp4": "video/mp4", ".css": "text/css", ".js": "text/javascript", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".json": "application/json" };

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline' blob:",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'self' ws://127.0.0.1:* ws://localhost:* data: blob:",
  "worker-src 'self' blob:",
  "frame-src 'self' blob: data: about:",
  "child-src 'self' blob: data:",
  "frame-ancestors http://127.0.0.1:* http://localhost:*",
].join("; ");

/**
 * @param {{ side: string, tree: string, label: string }} opts
 */
export function previewPlugin(opts) {
  const memfs = posix(join(HERE, "runtime", "shims", "memfs.ts"));
  const pathShim = posix(join(HERE, "runtime", "shims", "path.ts"));
  const busShim = posix(join(HERE, "runtime", "shims", "bus.ts"));
  const atomicShim = posix(join(HERE, "runtime", "shims", "atomic.ts"));
  const serverDir = posix(join(HARNESS, "server")) + "/";
  const boot = posix(join(HERE, "runtime", "boot.ts"));
  const scenariosEntry = join(HERE, "scenarios", "index.ts");
  let server;

  return {
    name: "vc-preview",
    enforce: "pre",
    configureServer(s) {
      server = s;
      s.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://x");
        res.setHeader("Content-Security-Policy", CSP);
        res.setHeader("Access-Control-Allow-Origin", "*");
        if (url.pathname.startsWith("/__preview/fixture/")) {
          const [, , , base, ...rest] = url.pathname.split("/");
          const p = fixtureFile(decodeURIComponent(base), rest.map(decodeURIComponent).join("/"));
          if (!p) return void ((res.statusCode = 404), res.end("no such fixture"));
          res.setHeader("content-type", MIME[extname(p).toLowerCase()] ?? "application/octet-stream");
          res.setHeader("cache-control", "max-age=3600");
          return void res.end(readFileSync(p));
        }
        if (url.pathname === "/__preview/info") {
          res.setHeader("content-type", "application/json");
          return void res.end(JSON.stringify({ side: opts.side, tree: opts.tree, label: opts.label, bases: Object.keys(baseDirs()) }));
        }
        if (url.pathname === "/__preview/scenarios.json") {
          try {
            const mod = await s.ssrLoadModule(scenariosEntry);
            const list = mod.scenarios.map((x) => ({ id: x.id, title: x.title, group: x.group, notes: x.notes, surfaces: x.surfaces ?? ["desktop"], phonePage: x.phone?.page ?? null }));
            res.setHeader("content-type", "application/json");
            return void res.end(JSON.stringify(list));
          } catch (e) {
            res.statusCode = 500;
            return void res.end(String(e?.stack ?? e));
          }
        }
        if (url.pathname.startsWith("/__vendor/katex/")) {
          const rel = url.pathname.slice("/__vendor/katex/".length);
          const p = resolve(opts.tree, "node_modules", "katex", "dist", rel);
          if (!existsSync(p)) return void ((res.statusCode = 404), res.end());
          res.setHeader("content-type", MIME[extname(p).toLowerCase()] ?? "application/octet-stream");
          return void res.end(readFileSync(p));
        }
        if (url.pathname === "/phone" || url.pathname === "/phone.html") {
          try {
            const html = await renderPhone({ tree: opts.tree, server: s, scenario: url.searchParams.get("scenario") ?? "home", base: url.searchParams.get("base") ?? "synthetic", side: opts.side, scenariosEntry, loadBase });
            res.setHeader("content-type", "text/html; charset=utf-8");
            res.setHeader("cache-control", "no-store");
            return void res.end(html);
          } catch (e) {
            res.statusCode = 500;
            res.setHeader("content-type", "text/plain");
            return void res.end(String(e?.stack ?? e));
          }
        }
        next();
      });
    },
    transformIndexHtml: {
      order: "pre",
      handler(html, ctx) {
        const u = new URL(ctx.originalUrl ?? ctx.path ?? "/", "http://x");
        const base = u.searchParams.get("base") ?? "synthetic";
        const tag = `<script type="module" src="/@vc-preview/entry?base=${encodeURIComponent(base)}"></script>\n    `;
        const needle = /<script type="module" src="\/src\/main\.tsx"><\/script>/;
        if (!needle.test(html)) throw new Error("preview: /src/main.tsx entry not found in index.html — the boot can't be injected");
        return html.replace(needle, (m) => tag + m).replace("<title>vault-chat</title>", `<title>vault-chat · ${opts.label}</title>`);
      },
    },
    resolveId(id, importer) {
      if (id.startsWith("/@vc-preview/entry")) return "\0vc-preview-entry" + (id.includes("?") ? id.slice(id.indexOf("?")) : "");
      if (id.startsWith("virtual:vc-preview-base/")) return "\0" + id;
      const imp = importer ? posix(importer) : "";
      if (imp.startsWith(serverDir) || imp.includes("/preview/runtime/shims/")) {
        if (id === "node:fs" || id === "fs") return memfs;
        if (id === "node:path" || id === "path") return pathShim;
        if (id === "../bus" && imp.startsWith(serverDir + "commands/")) return busShim;
        if (id === "../atomic" && imp.startsWith(serverDir + "commands/")) return atomicShim;
      }
      return null;
    },
    load(id) {
      if (id.startsWith("\0vc-preview-entry")) {
        const q = new URLSearchParams(id.slice("\0vc-preview-entry".length).replace(/^\?/, ""));
        const base = q.get("base") ?? "synthetic";
        return `import base from "virtual:vc-preview-base/${base}";\nimport { boot } from "/@fs/${boot}";\nboot(base);\n`;
      }
      if (id.startsWith("\0virtual:vc-preview-base/")) {
        const name = id.slice("\0virtual:vc-preview-base/".length);
        return `export default ${JSON.stringify(loadBase(name))};`;
      }
      return null;
    },
  };
}

export { loadBase };
