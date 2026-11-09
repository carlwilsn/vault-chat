// The app's real stylesheet for inline HTML pages in the chat (src/inlineHtml.ts):
// the Tailwind build of src/App.css (theme variables, dark default and
// [data-theme="light"]) plus the Inter / JetBrains Mono latin faces as data: URLs,
// so a page under CSP `font-src data:` renders in the app's own type.
// Used by server/build.mjs ("vc:app-css") and server/vitest.config.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const FACES = [["inter", 400], ["inter", 500], ["inter", 600], ["jetbrains-mono", 400], ["jetbrains-mono", 500]];

function fontFaces(root) {
  return FACES.map(([fam, w]) => {
    const file = join(root, "node_modules", "@fontsource", fam, "files", `${fam}-latin-${w}-normal.woff2`);
    const data = readFileSync(file).toString("base64");
    const name = fam === "inter" ? "Inter" : "JetBrains Mono";
    return `@font-face{font-family:'${name}';font-style:normal;font-display:swap;font-weight:${w};src:url(data:font/woff2;base64,${data}) format('woff2')}`;
  }).join("\n");
}

export async function appCss(root) {
  const require = createRequire(join(root, "package.json"));
  const postcss = require("postcss");
  const tailwind = require("tailwindcss");
  const autoprefixer = require("autoprefixer");
  // Tailwind's own loader (jiti): the config is ESM that calls require() for its plugin.
  const config = require("tailwindcss/loadConfig")(join(root, "tailwind.config.js"));
  const from = join(root, "src", "App.css");
  const result = await postcss([
    tailwind({ ...config, content: [join(root, "index.html"), join(root, "src", "**", "*.{ts,tsx}")] }),
    autoprefixer(),
  ]).process(readFileSync(from, "utf8"), { from });
  return fontFaces(root) + "\n" + result.css;
}
