// Builds the two design-variant demos from the faithful mock demo.
// Each variant = src-tauri/assets/phone-demo.html (the REAL app, mock ON)
// + a skin layer appended after the app's own <style> so it wins the cascade.
// No logic forks: same DOM, same TypeScript, different design tokens + chrome.
// Run after any phone.html change:
//   node scripts/make-phone-demo.mjs && node demos/make-demos.mjs
import { readFileSync, writeFileSync } from "node:fs";

const base = readFileSync("src-tauri/assets/phone-demo.html", "utf8");
const shared = readFileSync("demos/skin-shared.css", "utf8");

function build(name, css, extraHtml) {
  let out = base;
  out = out.replace("<title>vault-chat</title>", `<title>vault-chat · ${name}</title>`);
  const skin = `<style id="skin-${name}">\n${shared}\n${css}\n</style>\n`;
  if (!out.includes("</head>")) throw new Error("no </head> anchor");
  out = out.replace("</head>", skin + "</head>");
  if (extraHtml) {
    if (!out.includes('<div class="offbar">')) throw new Error("no offbar anchor");
    out = out.replace('<div class="offbar">', extraHtml + '\n  <div class="offbar">');
  }
  writeFileSync(`demos/phone-${name}.html`, out);
  console.log(`demos/phone-${name}.html built`);
}

build("ink", readFileSync("demos/skin-ink.css", "utf8"));
build(
  "graphite",
  readFileSync("demos/skin-graphite.css", "utf8"),
  '<div class="apron" aria-hidden="true"><i></i><i></i><i></i></div>',
);
