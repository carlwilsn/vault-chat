// Builds every design-variant demo from the faithful mock app.
// Each variant = src-tauri/assets/phone-demo.html (the REAL app, mock ON)
// + skin-shared.css + its own css[] appended after the app's <style>
// + its own js[] injected before </body>. No logic forks — same DOM, same
// TypeScript, different tokens/chrome/motion.
// Rebuild after any phone.html change:
//   node scripts/make-phone-demo.mjs && node demos/make-demos.mjs
import { readFileSync, writeFileSync } from "node:fs";

const read = (f) => readFileSync("demos/" + f, "utf8");
const base = readFileSync("src-tauri/assets/phone-demo.html", "utf8");
const shared = read("skin-shared.css");
const APRON = '<div class="apron" aria-hidden="true"><i></i><i></i><i></i></div>';

const VARIANTS = [
  { name: "ink", title: "Ink", css: ["skin-ink.css"] },
  { name: "graphite", title: "Graphite", css: ["skin-graphite.css"], html: APRON },
  { name: "ink-lift", title: "Ink · Lift", css: ["skin-ink.css", "ink-menu.css", "ink-lift.css"], js: ["ink-icons.js", "ink-drawer.js"] },
  { name: "ink-panel", title: "Ink · Panel", css: ["skin-ink.css", "ink-menu.css", "ink-panel.css"], js: ["ink-icons.js"] },
  { name: "ink-sheet", title: "Ink · Sheet", css: ["skin-ink.css", "ink-sheet.css"], js: ["ink-icons.js", "ink-drawer.js"] },
];

function insertBeforeLast(hay, needle, add) {
  const i = hay.lastIndexOf(needle);
  if (i < 0) throw new Error("anchor not found: " + needle);
  return hay.slice(0, i) + add + hay.slice(i);
}

for (const v of VARIANTS) {
  let out = base.replace("<title>vault-chat</title>", `<title>vault-chat · ${v.title}</title>`);
  const cssText = [shared, ...v.css.map(read)].join("\n");
  out = out.replace("</head>", `<style id="skin-${v.name}">\n${cssText}\n</style>\n</head>`);
  if (v.html) out = out.replace('<div class="offbar">', v.html + '\n  <div class="offbar">');
  if (v.js && v.js.length) {
    const jsText = v.js.map((f) => `<script>\n${read(f)}\n</script>`).join("\n");
    out = insertBeforeLast(out, "</body>", jsText + "\n");
  }
  writeFileSync(`demos/phone-${v.name}.html`, out);
  console.log(`demos/phone-${v.name}.html built`);
}
