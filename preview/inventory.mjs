// The style inventory, generated from a tree's code on every request:
//   /__preview/inventory?surface=desktop|phone
// Desktop: the CSS custom properties in src/App.css (dark + light), the
// Tailwind theme mapping, the src/ui.tsx components (mounted live, both
// themes) with their import counts, and Tailwind class usage across src/**:
// type sizes, colours, radii, spacing, arbitrary values, inline style={{}}
// sites, raw hex colours. Phone: the :root tokens in phone.html, its tw-
// classes and its most-used component classes.
// `node preview/inventory.mjs --runtime` adds what is actually drawn: computed
// colours / type / radii from every scenario screen (out/inventory-runtime.json).
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function walk(dir, exts, acc = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, exts, acc);
    else if (exts.some((e) => n.endsWith(e))) acc.push(p);
  }
  return acc;
}

function cssVars(block) {
  const out = [];
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.push([m[1], m[2].trim()]);
  return out;
}

function blockAfter(css, selector) {
  const i = css.indexOf(selector);
  if (i < 0) return "";
  const start = css.indexOf("{", i);
  let depth = 0;
  for (let j = start; j < css.length; j++) {
    if (css[j] === "{") depth++;
    else if (css[j] === "}" && --depth === 0) return css.slice(start + 1, j);
  }
  return "";
}

/** A CSS value as something a swatch can paint, or null. */
function paintable(v) {
  if (/^\d+(\.\d+)?\s+\d+(\.\d+)?%\s+\d+(\.\d+)?%/.test(v)) return `hsl(${v})`;
  if (/^(#|rgb|hsl|oklch|color-mix)/i.test(v)) return v;
  return null;
}

function countMap(arr) {
  const m = new Map();
  for (const x of arr) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function classTokens(src) {
  const toks = [];
  for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{\s*cn\(([^)]*)\)|\{"([^"]*)"\})/g)) {
    const s = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? "").replace(/\$\{[^}]*\}/g, " ");
    for (const t of s.split(/[\s"',]+/)) if (/^[a-z!-][\w:/.[\]%#()-]*$/i.test(t) && t.length > 1) toks.push(t);
  }
  // Class strings held in variables/objects (variants maps etc.).
  for (const m of src.matchAll(/"((?:[a-z-]+:)*(?:bg|text|border|rounded|p[xytrbl]?|m[xytrbl]?|gap|h|w|font|shadow|ring)-[^"]*)"/g))
    for (const t of m[1].split(/\s+/)) toks.push(t);
  return toks;
}

function bucket(toks) {
  const base = (t) => t.replace(/^(?:[a-z-]+:)+/, "");
  const b = { text: [], color: [], radius: [], spacing: [], arbitrary: [], weight: [] };
  for (const t0 of toks) {
    const t = base(t0);
    if (/\[.+\]/.test(t)) b.arbitrary.push(t);
    if (/^text-(xs|sm|base|lg|xl|\dxl|\[\d)/.test(t)) b.text.push(t);
    else if (/^(text|bg|border|ring|from|to|via|fill|stroke|divide|outline|placeholder)-(?!\d|\[)[a-z]/.test(t) && !/^border-(t|b|l|r|x|y)$/.test(t)) b.color.push(t);
    if (/^rounded/.test(t)) b.radius.push(t);
    if (/^-?(p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y|space-x|space-y)-/.test(t)) b.spacing.push(t);
    if (/^font-(thin|light|normal|medium|semibold|bold|extrabold|black)$/.test(t)) b.weight.push(t);
  }
  return Object.fromEntries(Object.entries(b).map(([k, v]) => [k, countMap(v)]));
}

function table(rows, cols) {
  return `<table><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
}

function chips(entries, max = 80) {
  return `<div class="chips">${entries
    .slice(0, max)
    .map(([k, n]) => `<span class="chip"><code>${esc(k)}</code><i>${n}</i></span>`)
    .join("")}${entries.length > max ? `<span class="dim">+${entries.length - max} more</span>` : ""}</div>`;
}

function swatches(vars) {
  return `<div class="sw">${vars
    .map(([k, v]) => {
      const p = paintable(v);
      return `<div class="s"><span class="box" style="${p ? `background:${esc(p)}` : "background:repeating-linear-gradient(45deg,#333 0 4px,#222 4px 8px)"}"></span><code>${esc(k)}</code><small>${esc(v)}</small></div>`;
    })
    .join("")}</div>`;
}

const PAGE_CSS = `
body{margin:0;background:#101113;color:#e7e7e7;font:13px/1.45 Inter,system-ui,sans-serif}
main{max-width:1180px;margin:0 auto;padding:22px}
main h1{font-size:20px!important;font-weight:600!important;margin:0 0 4px!important} main h2{font-size:15px!important;font-weight:600!important;margin:28px 0 8px!important;border-bottom:1px solid #2a2c31;padding-bottom:6px} main h3{font-size:13px!important;font-weight:600!important;margin:16px 0 6px!important;color:#bbb} main pre{white-space:pre-wrap;background:#17181b;padding:10px;border-radius:6px}
.dim{color:#8b8f98} code{font:11.5px ui-monospace,Consolas,monospace}
.sw{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:6px}
.s{display:flex;align-items:center;gap:8px;padding:4px 6px;border:1px solid #23252a;border-radius:6px;min-width:0}
.s .box{width:28px;height:20px;border-radius:4px;flex:none;box-shadow:0 0 0 1px #0006 inset}
.s small{color:#8b8f98;margin-left:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:110px}
.chips{display:flex;flex-wrap:wrap;gap:4px}.chip{border:1px solid #2a2c31;border-radius:5px;padding:1px 6px;display:inline-flex;gap:6px;align-items:center}.chip i{color:#8b8f98;font-style:normal;font-size:11px}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #23252a;padding:4px 8px;text-align:left;vertical-align:top}th{color:#8b8f98;font-weight:500}
.flag{color:#f0b54a}.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}
#gallery{display:grid;grid-template-columns:1fr 1fr;gap:12px}#gallery>div{border-radius:8px;padding:14px}
`;

export function desktopInventory(tree) {
  const css = readFileSync(join(tree, "src", "App.css"), "utf8");
  const dark = cssVars(blockAfter(css, ":root"));
  const light = cssVars(blockAfter(css, '[data-theme="light"]'));
  const tw = readFileSync(join(tree, "tailwind.config.js"), "utf8");
  const files = walk(join(tree, "src"), [".tsx", ".ts"]);
  const toks = [];
  const inline = [];
  const hex = [];
  const uiImports = new Map();
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const rel = relative(tree, f).replace(/\\/g, "/");
    if (f.endsWith(".tsx")) toks.push(...classTokens(src));
    src.split("\n").forEach((line, i) => {
      if (/style=\{\{/.test(line)) inline.push(`${rel}:${i + 1}`);
      for (const m of line.matchAll(/#[0-9a-fA-F]{3,8}\b(?![\w-])/g)) if (/["'`]/.test(line) && !/^\s*(\/\/|\*)/.test(line)) hex.push(`${rel}:${i + 1} ${m[0]}`);
    });
    const im = /import\s*\{([^}]*)\}\s*from\s*["']\.\/ui["']/.exec(src);
    if (im) for (const n of im[1].split(",").map((s) => s.trim().replace(/^type\s+/, "")).filter(Boolean)) uiImports.set(n, (uiImports.get(n) ?? 0) + 1);
  }
  const b = bucket(toks);
  const uiSrc = readFileSync(join(tree, "src", "ui.tsx"), "utf8");
  const comps = [...uiSrc.matchAll(/^export (?:const|function) (\w+)/gm)].map((m) => m[1]);
  const runtimeFile = join(HERE, "out", `inventory-runtime-desktop.json`);
  const runtime = existsSync(runtimeFile) ? JSON.parse(readFileSync(runtimeFile, "utf8")) : null;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Style inventory · desktop</title><style>${PAGE_CSS}</style></head><body><main>
<h1>Style inventory — desktop</h1>
<p class="dim">Generated from ${esc(tree)} on ${new Date().toISOString().slice(0, 16).replace("T", " ")}. Refresh to regenerate.</p>
<h2>Tokens — src/App.css</h2>
<div class="cols"><div><h3>:root (graphite, default) · ${dark.length}</h3>${swatches(dark)}</div><div><h3>[data-theme="light"] · ${light.length}</h3>${swatches(light)}</div></div>
<h2>Components — src/ui.tsx (live, both themes)</h2>
<p class="dim">${comps.map((c) => `<code>${esc(c)}</code> ×${uiImports.get(c) ?? 0} imports`).join(" · ")}</p>
<div id="gallery"><div data-theme="graphite" class="dim">loading…</div><div data-theme="light"></div></div>
<script type="module" src="/@vc-preview/gallery"></script>
<h2>Tailwind usage across src/**/*.tsx (${toks.length} class tokens)</h2>
<h3>Type sizes</h3>${chips(b.text)}
<h3>Font weights</h3>${chips(b.weight)}
<h3>Colours (utility → token)</h3>${chips(b.color, 120)}
<h3>Radii</h3>${chips(b.radius)}
<h3>Spacing</h3>${chips(b.spacing, 100)}
<h3 class="flag">Arbitrary values — off the scale (${b.arbitrary.reduce((a, [, n]) => a + n, 0)} uses)</h3>${chips(b.arbitrary, 150)}
<h3 class="flag">Inline style={{}} sites (${inline.length})</h3><p><code>${inline.map(esc).join("<br>")}</code></p>
<h3 class="flag">Raw hex colours in strings (${hex.length})</h3><p><code>${hex.slice(0, 60).map(esc).join("<br>")}</code></p>
<h2>Tailwind theme — tailwind.config.js</h2><pre><code>${esc(tw)}</code></pre>
${runtime ? runtimeSection(runtime) : `<h2>Runtime (what is drawn)</h2><p class="dim">Not collected yet — run <code>node preview/inventory.mjs --runtime</code> with the preview running.</p>`}
</main></body></html>`;
}

function runtimeSection(r) {
  const rows = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]);
  return `<h2>Runtime — computed styles over ${r.screens.length} scenario screens (${r.elements} elements)</h2>
<p class="dim">Collected ${esc(r.at)}. Colours not equal to any token's computed value are flagged.</p>
<h3>Text colours</h3>${rtChips(rows(r.color), r.tokenColors)}
<h3>Backgrounds</h3>${rtChips(rows(r.background), r.tokenColors)}
<h3>Font sizes</h3>${chips(rows(r.fontSize))}
<h3>Font families</h3>${chips(rows(r.fontFamily))}
<h3>Radii</h3>${chips(rows(r.radius))}`;
}

function rtChips(entries, tokenColors) {
  return `<div class="chips">${entries
    .slice(0, 80)
    .map(([k, n]) => {
      const tok = tokenColors?.[k];
      return `<span class="chip" title="${esc(tok ?? "not a token value")}"><span class="box" style="display:inline-block;width:12px;height:12px;border-radius:3px;background:${esc(k)}"></span><code class="${tok ? "" : "flag"}">${esc(k)}</code><i>${n}${tok ? " · " + esc(tok) : ""}</i></span>`;
    })
    .join("")}</div>`;
}

export function phoneInventory(tree) {
  const html = readFileSync(join(tree, "src-tauri", "assets", "phone.html"), "utf8");
  const style = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
  const vars = cssVars(blockAfter(style, ":root"));
  const ts = html.slice(html.indexOf('<script id="phone-ts"'));
  const tw = countMap([...html.matchAll(/\btw-[\w:/.[\]%-]+/g)].map((m) => m[0]));
  const cls = countMap(
    [...html.matchAll(/class(?:Name)?=["'`]([^"'`]+)["'`]/g)].flatMap((m) => m[1].split(/\s+/)).filter((c) => c && !c.startsWith("tw-") && !c.includes("$")),
  );
  const sizes = countMap([...style.matchAll(/font-size\s*:\s*([^;}\s]+)/g)].map((m) => m[1]));
  const radii = countMap([...style.matchAll(/border-radius\s*:\s*([^;}]+)/g)].map((m) => m[1].trim()));
  const hex = countMap([...style.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]));
  void ts;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Style inventory · phone</title><style>${PAGE_CSS}</style></head><body><main>
<h1>Style inventory — phone (src-tauri/assets/phone.html)</h1>
<p class="dim">Generated from ${esc(tree)}. Refresh to regenerate.</p>
<h2>Tokens — :root (${vars.length})</h2>${swatches(vars)}
<h2>Type sizes in the stylesheet</h2>${chips(sizes)}
<h2>Radii in the stylesheet</h2>${chips(radii)}
<h2 class="flag">Raw hex in the stylesheet (${hex.length} distinct)</h2>${chips(hex)}
<h2>Tailwind (tw-) classes (${tw.length} distinct)</h2>${chips(tw, 150)}
<h2>Component classes by frequency</h2>${chips(cls, 150)}
</main></body></html>`;
}

/** The live gallery module: ui.tsx components in both themes. */
export function galleryModule() {
  return `
import React from "react";
import { createRoot } from "react-dom/client";
import "/src/App.css";
import * as UI from "/src/ui.tsx";
const h = React.createElement;
function Gallery({ theme }) {
  const [sel, setSel] = React.useState("b");
  const row = (label, ...kids) => h("div", { style: { display: "flex", gap: 8, alignItems: "center", margin: "8px 0", flexWrap: "wrap" } }, h("span", { style: { width: 80, opacity: .6, fontSize: 11 } }, label), ...kids);
  const B = UI.Button;
  return h("div", { "data-theme": theme, className: "bg-background text-foreground", style: { padding: 14, borderRadius: 8, fontSize: 13 } },
    h("div", { style: { fontSize: 11, opacity: .6, marginBottom: 6 } }, theme),
    row("Button", ...["default", "secondary", "outline", "ghost", "destructive"].map((v) => h(B, { key: v, variant: v }, v))),
    row("size", h(B, { size: "sm" }, "sm"), h(B, {}, "default"), h(B, { size: "icon", title: "icon" }, "★"), h(B, { disabled: true }, "disabled")),
    UI.Input && row("Input", h(UI.Input, { placeholder: "Input…", style: { width: 220 } })),
    UI.Textarea && row("Textarea", h(UI.Textarea, { placeholder: "Textarea…", rows: 2, style: { width: 260 } })),
    UI.Select && row("Select", h(UI.Select, { defaultValue: "a" }, h("option", { value: "a" }, "Option A"), h("option", { value: "b" }, "Option B"))),
    UI.MenuSelect && row("MenuSelect", h(UI.MenuSelect, { value: sel, onChange: setSel, groups: [{ label: "Group", options: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }] }] })),
    UI.Kbd && row("Kbd", h(UI.Kbd, null, "Ctrl"), h(UI.Kbd, null, "K")),
    UI.Separator && row("Separator", h("div", { style: { width: 200 } }, h(UI.Separator, {}))),
    row("text", ...["text-[11px]", "text-xs", "text-[12.5px]", "text-[13px]", "text-sm", "text-base"].map((c) => h("span", { key: c, className: c }, c))),
    row("muted", h("span", { className: "text-muted-foreground" }, "muted-foreground"), h("span", { className: "bg-card px-2 py-1 rounded border border-border" }, "card + border"), h("span", { className: "bg-accent px-2 py-1 rounded" }, "accent")),
  );
}
const g = document.getElementById("gallery");
g.innerHTML = "";
for (const t of ["graphite", "light"]) { const d = document.createElement("div"); g.appendChild(d); createRoot(d).render(h(Gallery, { theme: t })); }
`;
}

// ---- --runtime: computed styles over every scenario screen ------------------
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes("--runtime")) {
  const { launch } = await import("./tools/browser.mjs");
  const origin = process.env.PREVIEW_BEFORE ?? "http://127.0.0.1:1520/before";
  const list = await (await fetch(origin + "/__preview/scenarios.json")).json();
  const agg = { at: new Date().toISOString(), screens: [], elements: 0, color: {}, background: {}, fontSize: {}, fontFamily: {}, radius: {}, tokenColors: {} };
  const { browser, page } = await launch({ width: 1400, height: 900 });
  for (const sc of list.filter((s) => s.surfaces.includes("desktop"))) {
    await page.goto(`${origin}/?scenario=${sc.id}&overlay=0`);
    await page.waitForFunction(() => window.__preview?.stepsDone, null, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(800);
    const r = await page.evaluate(() => {
      const out = { n: 0, color: {}, background: {}, fontSize: {}, fontFamily: {}, radius: {}, tokens: {} };
      const inc = (o, k) => (o[k] = (o[k] ?? 0) + 1);
      for (const el of document.querySelectorAll("#root *")) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none") continue;
        out.n++;
        if (el.childNodes.length && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) {
          inc(out.color, cs.color);
          inc(out.fontSize, cs.fontSize);
          inc(out.fontFamily, cs.fontFamily.split(",")[0].replace(/"/g, ""));
        }
        if (cs.backgroundColor !== "rgba(0, 0, 0, 0)") inc(out.background, cs.backgroundColor);
        if (cs.borderTopLeftRadius !== "0px") inc(out.radius, cs.borderTopLeftRadius);
      }
      // Each token's computed colour, for mapping values back to tokens.
      const probe = document.createElement("div");
      document.body.appendChild(probe);
      const root = getComputedStyle(document.documentElement);
      for (let i = 0; i < root.length; i++) {
        const name = root[i];
        if (!name.startsWith("--")) continue;
        const v = root.getPropertyValue(name).trim();
        probe.style.color = "";
        probe.style.color = /^\d/.test(v) ? `hsl(${v})` : v;
        if (probe.style.color) out.tokens[getComputedStyle(probe).color] = name;
      }
      probe.remove();
      return out;
    });
    agg.screens.push(sc.id);
    agg.elements += r.n;
    for (const k of ["color", "background", "fontSize", "fontFamily", "radius"]) for (const [v, n] of Object.entries(r[k])) agg[k][v] = (agg[k][v] ?? 0) + n;
    Object.assign(agg.tokenColors, r.tokens);
    console.log(`  ${sc.id}: ${r.n} elements`);
  }
  await browser.close();
  mkdirSync(join(HERE, "out"), { recursive: true });
  writeFileSync(join(HERE, "out", "inventory-runtime-desktop.json"), JSON.stringify(agg, null, 1));
  console.log(`wrote preview/out/inventory-runtime-desktop.json (${agg.screens.length} screens)`);
}
