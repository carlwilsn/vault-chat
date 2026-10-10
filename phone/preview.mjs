// Dev-only: the preview harness's hook for this phone app (never in the app
// bundle). preview/phone.mjs calls renderPhoneApp() when a tree has
// phone/preview.mjs, instead of patching src-tauri/assets/phone.html.
//
// It builds the app with its own vite.config.ts — the same sources, config and
// plugins as `npm run build:phone` — into one self-contained page (the JS and
// CSS inlined, KaTeX's fonts as data: URIs), because the harness serves the
// page itself at /phone and nothing else under it. The build is cached by a
// hash of phone/'s sources. The harness's head scripts (network wall, the
// scenario's MockDB on window.__VC_PREVIEW_DB__) go first; mock mode is turned
// on through the URL (?mock=1), the switch the page already has.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const cache = new Map();

function sourceHash() {
  const h = createHash("sha1");
  const walk = (d) => {
    for (const n of readdirSync(d).sort()) {
      if (n === "dist" || n === "node_modules") continue;
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else h.update(p).update(readFileSync(p));
    }
  };
  walk(HERE);
  return h.digest("hex");
}

/** Inline the entry chunk and stylesheet into index.html. */
const inlineAll = {
  name: "vc-phone-inline",
  enforce: "post",
  generateBundle(_o, bundle) {
    const html = Object.values(bundle).find((a) => a.type === "asset" && a.fileName.endsWith(".html"));
    let src = String(html.source);
    for (const [name, a] of Object.entries(bundle)) {
      if (a.type === "chunk" && a.isEntry) {
        src = src.replace(new RegExp(`<script type="module" crossorigin src="[^"]*${a.fileName.replace(/[.]/g, "\\.")}"></script>`), () => `<script type="module">${a.code.replace(/<\/script/gi, "<\\/script")}</script>`);
        delete bundle[name];
      } else if (a.type === "asset" && a.fileName.endsWith(".css")) {
        src = src.replace(new RegExp(`<link rel="stylesheet" crossorigin href="[^"]*${a.fileName.replace(/[.]/g, "\\.")}">`), () => `<style>${a.source}</style>`);
        delete bundle[name];
      }
    }
    html.source = src;
  },
};

async function buildPage() {
  const key = sourceHash();
  if (cache.has(key)) return cache.get(key);
  const req = createRequire(resolve(HERE, "..", "package.json"));
  const vite = await import(pathToFileURL(req.resolve("vite")).href);
  const out = await vite.build({
    configFile: join(HERE, "vite.config.ts"),
    logLevel: "warn",
    plugins: [inlineAll],
    build: {
      write: false,
      assetsInlineLimit: () => true,
      cssCodeSplit: false,
      modulePreload: false,
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
  const outputs = (Array.isArray(out) ? out : [out]).flatMap((o) => o.output);
  const html = String(outputs.find((a) => a.fileName.endsWith(".html")).source);
  cache.set(key, html);
  return html;
}

/**
 * @param {{ head: string, tail: string }} o head: scripts to run first;
 *   tail: scripts to append at the end of body.
 */
export async function renderPhoneApp({ head, tail }) {
  let html = await buildPage();
  const mockOn = `<script>if(!/[?&]mock=1(&|$)/.test(location.search))history.replaceState(null,"",location.pathname+(location.search?location.search+"&":"?")+"mock=1"+location.hash)</script>`;
  html = html.replace(/<head>/i, `<head>\n${head}\n${mockOn}`);
  html = html.replace(/<\/body>/i, `${tail}</body>`);
  return html;
}
