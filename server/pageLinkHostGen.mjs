// The host script of a page's own link (/p/<id>/, server/pageLink.ts): src/pageLinkHost.ts and the live-page bridge it
// installs (src/liveBridge.ts), bundled for a browser into one classic script the box inlines into the link's shell.
// Used by server/build.mjs ("vc:page-link-host") and server/vitest.config.ts.
import { join } from "node:path";
import { build } from "esbuild";

export async function pageLinkHostJs(root) {
  const out = await build({
    entryPoints: [join(root, "src", "pageLinkHost.ts")],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2020",
    minify: true,
    logLevel: "warning",
  });
  // Inlined in a <script>: a "</script" inside it would end the element early.
  return out.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
}
