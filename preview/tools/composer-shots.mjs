// The chat composer at every width, before and after: the fullscreen chat and the popout from the narrowest
// window up, and the phone. For each, the composer empty and with one line, and whether the textarea scrolls
// (its scrollHeight against its height) and whether the placeholder fits one line. Side by side to <out>/composer-<name>.png.
//   node preview/tools/composer-shots.mjs <out> [--url http://127.0.0.1:1610]
import { launch } from "./browser.mjs";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const out = resolve(argv[0] ?? "preview-proof/composer");
const origin = (() => {
  const i = argv.indexOf("--url");
  return i >= 0 ? argv[i + 1] : "http://127.0.0.1:1610";
})();
mkdirSync(out, { recursive: true });

const MEASURE = () => {
  const ta = document.querySelector("textarea");
  if (!ta) return null;
  const cs = getComputedStyle(ta);
  return { h: ta.clientHeight, sh: ta.scrollHeight, overflowY: cs.overflowY, scrolls: ta.scrollHeight > ta.clientHeight + 1 && cs.overflowY !== "hidden" };
};

const results = [];
const shots = {};
async function desktop(side, width, popout) {
  const { browser, page } = await launch({ width, height: 700 });
  try {
    await page.goto(`${origin}/${side}/?${popout ? "view=chat&" : ""}scenario=conv-a&side=before&narrate=0&steps=0`, { timeout: 180000 });
    await page.waitForFunction(() => window.__preview?.ready, null, { timeout: 120000 });
    await page.waitForTimeout(1200);
    if (!popout) {
      await page.keyboard.press("Control+Shift+F");
      await page.waitForTimeout(400);
    }
    {
      // The narrow case: no sidebar (the composer gets the window's width).
      await page.evaluate(async () => {
        const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => /\/src\/store\.ts/.test(n));
        const s = (await import(url)).useStore;
        if (s.getState().chatSidebarOpen) s.getState().toggleChatSidebar();
      });
      await page.waitForTimeout(400);
    }
    const name = `${popout ? "popout" : "full"}-${width}`;
    const empty = await page.evaluate(MEASURE);
    const p = join(out, `${name}-${side}.png`);
    await page.screenshot({ path: p, clip: { x: 0, y: 560, width, height: 140 } });
    (shots[name] ??= {})[side] = p;
    results.push({ side, name, empty });
  } finally {
    await browser.close();
  }
}

async function phone(side, width) {
  const { browser, page } = await launch({ width, height: 700, deviceScaleFactor: 2, isMobile: true });
  try {
    await page.goto(`${origin}/${side}/phone?scenario=p3-phone-thread`, { timeout: 180000 });
    await page.waitForFunction(() => window.__previewPhone?.ready, null, { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const name = `phone-${width}`;
    const empty = await page.evaluate(MEASURE);
    const p = join(out, `${name}-${side}.png`);
    await page.screenshot({ path: p, clip: { x: 0, y: 560, width, height: 140 } });
    (shots[name] ??= {})[side] = p;
    results.push({ side, name, empty });
  } finally {
    await browser.close();
  }
}

for (const side of ["before", "after"]) {
  for (const w of [340, 420, 560, 800]) await desktop(side, w, false);
  for (const w of [340, 480]) await desktop(side, w, true);
  for (const w of [320, 390]) await phone(side, w);
}
for (const r of results) console.log(`${r.side.padEnd(6)} ${r.name.padEnd(12)} empty: height ${r.empty?.h}, content ${r.empty?.sh}, overflow-y ${r.empty?.overflowY}${r.empty?.scrolls ? "  ← SCROLLBAR" : ""}`);

const { browser, page } = await launch({ width: 1800, height: 400 });
try {
  for (const [name, s] of Object.entries(shots)) {
    const img = (p) => `data:image/png;base64,${readFileSync(p).toString("base64")}`;
    const cell = (label, p) => `<figure style="margin:0"><figcaption style="font:600 14px system-ui;color:#ddd;margin:0 0 6px">${label} · ${name}</figcaption><img src="${img(p)}" style="display:block;border:1px solid #444;max-width:840px"></figure>`;
    await page.setContent(`<body style="margin:0;background:#1a1a1a;padding:16px;display:flex;gap:16px;width:max-content">${cell("Before", s.before)}${cell("After", s.after)}</body>`);
    const el = await page.$("body");
    await el.screenshot({ path: join(out, `composer-${name}.png`) });
  }
} finally {
  await browser.close();
}
