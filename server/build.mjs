// Bundle the headless server: server/main.ts plus the existing src/ modules it
// imports, with @tauri-apps/* aliased to the node shims in server/shims.
//   node server/build.mjs            → dist-server/vault-chat-server.mjs
//   node server/build.mjs --metafile → also writes dist-server/meta.json
import { build } from "esbuild";
import { readFileSync, mkdirSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { inlinedKatexCss } from "./katexCssGen.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const shims = join(root, "server", "shims");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
let rev = process.env.VC_REV || "";
if (!rev) {
  try {
    rev = execSync("git rev-parse --short HEAD", { cwd: root }).toString().trim();
  } catch {
    rev = "";
  }
}

const ALIASES = {
  "@tauri-apps/api/core": join(shims, "core.ts"),
  "@tauri-apps/api/event": join(shims, "event.ts"),
  "@tauri-apps/api/app": join(shims, "app.ts"),
  "@tauri-apps/api/window": join(shims, "window.ts"),
  "@tauri-apps/api/webviewWindow": join(shims, "window.ts"),
  "@tauri-apps/plugin-dialog": join(shims, "plugins.ts"),
  "@tauri-apps/plugin-opener": join(shims, "plugins.ts"),
  "@tauri-apps/plugin-process": join(shims, "plugins.ts"),
  "@tauri-apps/plugin-updater": join(shims, "plugins.ts"),
  "@tauri-apps/plugin-autostart": join(shims, "plugins.ts"),
  // pdf.js: DOM stubs + the legacy (node) build + its worker on the main
  // thread — see shims/pdfjs.ts.
  "pdfjs-dist": join(shims, "pdfjs.ts"),
};

/** A web app's built files (<dir>/dist), embedded as "vc:<name>" =
 * { "index.html": base64, "assets/…": base64 }. Empty unless its flag is given:
 *   --phone-app → phone/dist as vc:phone-app (else /phone keeps serving phone.html)
 *   --board-app → board/dist as vc:board-app (else /board says it isn't built) */
const APPS = { "phone-app": "phone", "board-app": "board" };
function appFiles(name) {
  if (!process.argv.includes(`--${name}`)) return {};
  const dist = join(root, APPS[name], "dist");
  if (!existsSync(join(dist, "index.html"))) {
    console.error(`build: --${name} needs ${APPS[name]}/dist — run \`npm run build:${APPS[name]}\` first`);
    process.exit(1);
  }
  const out = {};
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dist, p).split("\\").join("/")] = readFileSync(p).toString("base64");
    }
  };
  walk(dist);
  return out;
}
const webApps = {
  name: "vc-web-apps",
  setup(b) {
    b.onResolve({ filter: /^vc:(phone|board)-app$/ }, (a) => ({ path: a.path.slice(3), namespace: "vc-web-app" }));
    b.onResolve({ filter: /^vc:katex-css$/ }, () => ({ path: "katex-css", namespace: "vc-katex" }));
    b.onLoad({ filter: /.*/, namespace: "vc-katex" }, () => ({ contents: `export default ${JSON.stringify(inlinedKatexCss(root))};`, loader: "js" }));
    b.onLoad({ filter: /.*/, namespace: "vc-web-app" }, (a) => ({ contents: `export default ${JSON.stringify(appFiles(a.path))};`, loader: "js" }));
  },
};

/** Speech Rule Engine (server/speakMath.ts) loads its XML parser and XPath with eval("require")(name), which a
 * bundle cannot see and the box (one file, no node_modules) cannot resolve: those become plain requires, bundled. */
const sreRequires = {
  name: "sre-requires",
  setup(b) {
    b.onLoad({ filter: /speech-rule-engine[\\/]js[\\/]common[\\/]system_external\.js$/ }, (a) => {
      const src = readFileSync(a.path, "utf8");
      const out = src
        .replace(/SystemExternal\.extRequire\('(@xmldom\/xmldom|wicked-good-xpath|fs)'\)/g, "require('$1')")
        .replace("return eval('require');", "return require;");
      if (!/require\('@xmldom\/xmldom'\)/.test(out) || !/require\('wicked-good-xpath'\)/.test(out)) {
        return { errors: [{ text: "speech-rule-engine changed its system_external.js: update sreRequires in server/build.mjs" }] };
      }
      return { contents: out, loader: "js" };
    });
  },
};

/** Vite-isms the app modules use: `?url` asset imports and aliases. */
const viteCompat = {
  name: "vite-compat",
  setup(b) {
    b.onResolve({ filter: /\?url$/ }, (a) => ({ path: a.path, namespace: "vc-url" }));
    // `?raw`: the file's text (used for phone-sw.js, which must not be bundled).
    b.onResolve({ filter: /\?raw$/ }, (a) => ({ path: join(a.resolveDir, a.path.replace(/\?raw$/, "")), namespace: "vc-raw" }));
    b.onLoad({ filter: /.*/, namespace: "vc-raw" }, (a) => ({ contents: readFileSync(a.path, "utf8"), loader: "text" }));
    b.onLoad({ filter: /.*/, namespace: "vc-url" }, () => ({ contents: "export default '';", loader: "js" }));
    b.onResolve({ filter: /^(@tauri-apps\/|pdfjs-dist$)/ }, (a) => {
      const hit = ALIASES[a.path];
      if (hit) return { path: hit };
      return { errors: [{ text: `no headless shim for ${a.path} — add one in server/shims` }] };
    });
    // Styles are UI-only.
    b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: "vc-empty" }));
    b.onLoad({ filter: /.*/, namespace: "vc-empty" }, () => ({ contents: "", loader: "js" }));
  },
};

const outdir = join(root, "dist-server");
mkdirSync(outdir, { recursive: true });
const wantMeta = process.argv.includes("--metafile");

const result = await build({
  entryPoints: [join(root, "server", "main.ts")],
  outfile: join(outdir, "vault-chat-server.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: "linked",
  metafile: wantMeta,
  logLevel: "warning",
  loader: { ".md": "text", ".html": "text", ".png": "binary" },
  plugins: [viteCompat, webApps, sreRequires],
  // esbuild itself (the inbox bundles widgets): native, never bundled — the repo's, or one the server installs (server/inbox.ts).
  external: ["esbuild"],
  // CJS deps bundled into ESM need a real require for node builtins.
  banner: {
    js: "import { createRequire as __vcCreateRequire } from 'node:module'; const require = __vcCreateRequire(import.meta.url);",
  },
  define: {
    "import.meta.env.DEV": "false",
    "import.meta.env.PROD": "true",
    "import.meta.env.MODE": '"production"',
    "import.meta.env": '{"DEV":false,"PROD":true,"MODE":"production"}',
    __VC_VERSION__: JSON.stringify(pkg.version),
    __VC_REV__: JSON.stringify(rev),
  },
});

if (wantMeta) writeFileSync(join(outdir, "meta.json"), JSON.stringify(result.metafile, null, 1));
writeFileSync(join(outdir, "server-version.json"), JSON.stringify({ version: pkg.version, rev }) + "\n");
console.log(`built dist-server/vault-chat-server.mjs (v${pkg.version} ${rev})${Object.keys(APPS).filter((a) => process.argv.includes(`--${a}`)).map((a) => ` with --${a}`).join("")}`);
