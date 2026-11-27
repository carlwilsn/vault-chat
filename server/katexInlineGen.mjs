// KaTeX for a page that loads nothing from the network (the voice board, server/board.ts): its script and its CSS
// with the WOFF2 fonts inlined as data: URLs (the WOFF/TTF fallbacks dropped). Used by server/build.mjs
// ("vc:katex-inline") and server/vitest.config.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function katexInline(root) {
  const dist = join(root, "node_modules", "katex", "dist");
  const css = readFileSync(join(dist, "katex.min.css"), "utf8").replace(/src:([^;}]+)/g, (_all, list) => {
    const woff2 = /url\((fonts\/[^)]+\.woff2)\)/.exec(list);
    if (!woff2) return `src:${list}`;
    return `src:url(data:font/woff2;base64,${readFileSync(join(dist, woff2[1])).toString("base64")}) format("woff2")`;
  });
  const js = readFileSync(join(dist, "katex.min.js"), "utf8");
  return { css, js };
}
