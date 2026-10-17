// KaTeX's CSS with the WOFF2 fonts inlined and the WOFF/TTF fallbacks dropped
// (server/katexCss.ts). Used by server/build.mjs and server/vitest.config.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function inlinedKatexCss(root) {
  const dist = join(root, "node_modules", "katex", "dist");
  const css = readFileSync(join(dist, "katex.min.css"), "utf8");
  return css.replace(/src:([^;}]+)/g, (_all, list) => {
    const woff2 = /url\((fonts\/[^)]+\.woff2)\)/.exec(list);
    if (!woff2) return `src:${list}`;
    const data = readFileSync(join(dist, woff2[1])).toString("base64");
    return `src:url(data:font/woff2;base64,${data}) format("woff2")`;
  });
}
