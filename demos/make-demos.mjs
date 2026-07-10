// Builds every design-variant demo from the faithful mock app.
// Each variant = src-tauri/assets/phone-demo.html (the REAL app, mock ON)
// + skin-shared.css + its own css[] appended after the app's <style>
// + its own js[] injected before </body>. No logic forks.
// Rebuild after any phone.html change:
//   node scripts/make-phone-demo.mjs && node demos/make-demos.mjs
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const read = (f) => readFileSync("demos/" + f, "utf8");
const base = readFileSync("src-tauri/assets/phone-demo.html", "utf8");
const shared = read("skin-shared.css");
const APRON = '<div class="apron" aria-hidden="true"><i></i><i></i><i></i></div>';

// The Depth design (Panel slab + Lift recede), shared by every icon option.
const DEPTH_CSS = ["skin-ink.css", "ink-menu.css", "ink-depth.css", "ink-pagehead.css"];
const DEPTH_JS = ["ink-drawer.js", "ink-pagehead.js"];

const VARIANTS = [
  { name: "ink", title: "Ink", css: ["skin-ink.css"] },
  { name: "graphite", title: "Graphite", css: ["skin-graphite.css"], html: APRON },
  // Depth with the app's current (Lucide-geometry) icons, glyphs fixed:
  { name: "ink-depth", title: "Ink · Depth", css: DEPTH_CSS, js: ["ink-icons.js", ...DEPTH_JS] },
  // Depth with a full swapped icon set (built only if the set file exists):
  { name: "ink-lucide", title: "Ink · Depth · Lucide", css: DEPTH_CSS, iconset: "icons-lucide.js" },
  { name: "ink-iconoir", title: "Ink · Depth · Iconoir", css: DEPTH_CSS, iconset: "icons-iconoir.js" },
  { name: "ink-phosphor", title: "Ink · Depth · Phosphor", css: DEPTH_CSS, iconset: "icons-phosphor.js" },
];

function insertBeforeLast(hay, needle, add) {
  const i = hay.lastIndexOf(needle);
  if (i < 0) throw new Error("anchor not found: " + needle);
  return hay.slice(0, i) + add + hay.slice(i);
}

const built = [];
for (const v of VARIANTS) {
  // an icon-option variant loads its set + the swap engine + the drawer helper
  let js = v.js || [];
  if (v.iconset) {
    if (!existsSync("demos/" + v.iconset)) { console.log(`(skip ${v.name} — ${v.iconset} not ready)`); continue; }
    js = [v.iconset, "ink-iconswap.js", ...DEPTH_JS];
  }
  let out = base.replace("<title>vault-chat</title>", `<title>vault-chat · ${v.title}</title>`);
  const cssText = [shared, ...v.css.map(read)].join("\n");
  out = out.replace("</head>", `<style id="skin-${v.name}">\n${cssText}\n</style>\n</head>`);
  if (v.html) out = out.replace('<div class="offbar">', v.html + '\n  <div class="offbar">');
  if (js.length) {
    const jsText = js.map((f) => `<script>\n${read(f)}\n</script>`).join("\n");
    out = insertBeforeLast(out, "</body>", jsText + "\n");
  }
  writeFileSync(`demos/phone-${v.name}.html`, out);
  built.push(v.name);
  console.log(`demos/phone-${v.name}.html built`);
}
console.log("built: " + built.join(", "));
