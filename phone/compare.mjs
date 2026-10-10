// Dev-only proof for the phone port: the old page (phone.html) and the new app
// (phone/) in the preview harness, same scenario, same taps, at 390×844 —
// screenshots, a pixel diff, and a DOM diff of the whole page.
//
//   node phone/compare.mjs [--old <url>] [--new <url>] [--harness <preview dir>] [--only id,id]
//
// Defaults: both from the after-tree's harness server on :1521 — the old page
// with ?phone=classic, the new app without it. Writes preview-proof/phone/
// (<case>-old.png, <case>-new.png, <case>-diff.png, report.json).
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const OLD = opt("old", "http://127.0.0.1:1521/phone?phone=classic&");
const NEW = opt("new", "http://127.0.0.1:1521/phone?");
const HARNESS = resolve(opt("harness", resolve(HERE, "..", "preview")));
const ONLY = opt("only", "")
  .split(",")
  .filter(Boolean);
const OUT = resolve(HERE, "..", "preview-proof", "phone");
mkdirSync(OUT, { recursive: true });

const { launch } = await import(pathToFileURL(join(HARNESS, "tools", "browser.mjs")).href);

// Every phone scenario of the harness, then the same scenarios driven further
// with taps — so the sheets, menus, drawers and live flows are compared too.
const T = (s) => ({ click: s });
const CASES = [
  { id: "home", sc: "home" },
  { id: "missions", sc: "missions" },
  { id: "missions-awaiting", sc: "missions-awaiting" },
  { id: "phone-chats", sc: "phone-chats" },
  { id: "phone-thread", sc: "phone-thread" },
  { id: "phone-mission", sc: "phone-mission" },
  { id: "phone-notes", sc: "phone-notes" },
  { id: "phone-settings", sc: "phone-settings" },
  { id: "menu-open", sc: "home", steps: [T("#menuBtn")] },
  { id: "mission-workers", sc: "phone-mission", steps: [T("#mWkToggle")] },
  { id: "mission-worker-sheet", sc: "phone-mission", steps: [T("#mWkToggle"), { eval: "document.querySelector('.sheet-body .wk-row').click()" }] },
  { id: "activity-workers", sc: "missions", steps: [T("#actScroll .wcount")] },
  { id: "feedback-thread", sc: "phone-settings", steps: [T("#fbList > *")] },
  { id: "alerts-ask-sheet", sc: "missions-awaiting", steps: [T("#alScroll .card, #alScroll .needsyou")] },
  { id: "activity-archive", sc: "missions", steps: [T(".arch-h")] },
  { id: "drawer-chat-tab", sc: "phone-settings", steps: [T("#clTabChat")] },
  { id: "drawer-gear", sc: "phone-settings", steps: [T("#clGearBtn")] },
  { id: "chat-send", sc: "phone-thread", steps: [{ type: ["#input", "What is the Fiedler vector?"] }, T("#sendBtn"), { wait: 6000 }] },
  { id: "chat-typing", sc: "home", steps: [{ type: ["#input", "a long message that wraps onto a second line in the composer field"] }] },
  { id: "notes-add", sc: "phone-notes", steps: [{ type: ["#noteInput", "Check the seed-2 LR"] }, T("#noteAddBtn")] },
  { id: "new-chat", sc: "phone-chats", steps: [T("#newBtn")] },
  { id: "offline", sc: "home", steps: [{ eval: "document.body.classList.add('offline')" }] },
].filter((c) => !ONLY.length || ONLY.includes(c.id));

/** Elements whose text is a clock or a relative time ("2m", "just now", "7:42"):
 *  the two pages are built seconds apart, so these may differ. Masked in the
 *  pixel diff, blanked in the DOM diff. */
const TIME_RE = /^(just now|now|\d+\s?(s|m|h|d|min|mins|hr|hrs|sec|secs)( ago)?|\d{1,2}:\d{2}(\s?[AP]M)?|yesterday|\d+ (seconds?|minutes?|hours?|days?) ago|(mon|tue|wed|thu|fri|sat|sun)\w*)$/i;

async function capture(page, base, c, tag) {
  await page.goto(`${base}scenario=${encodeURIComponent(c.sc)}`, { timeout: 60000 });
  await page.waitForFunction(() => window.__previewPhone?.ready, null, { timeout: 30000 });
  await page.addStyleTag({ content: "*{caret-color:transparent!important}" });
  await page.waitForTimeout(900);
  for (const s of c.steps ?? []) {
    if (s.click) {
      const el = page.locator(s.click).first();
      await el.click({ timeout: 8000 });
      await page.waitForTimeout(700);
    } else if (s.type) {
      await page.locator(s.type[0]).first().click({ timeout: 8000 });
      await page.keyboard.type(s.type[1], { delay: 5 });
      await page.waitForTimeout(400);
    } else if (s.wait) await page.waitForTimeout(s.wait);
    else if (s.eval) {
      await page.evaluate(s.eval);
      await page.waitForTimeout(700);
    }
  }
  await page.waitForTimeout(1200); // sheets/menus finish their transitions
  const info = await page.evaluate((reSrc) => {
    const re = new RegExp(reSrc.source, reSrc.flags);
    const masks = [];
    const leaf = [...document.querySelectorAll("body *")].filter((e) => e.children.length === 0 || [...e.childNodes].every((n) => n.nodeType === 3));
    for (const e of leaf) {
      const t = (e.textContent || "").trim();
      if (!t || !re.test(t)) continue;
      const r = e.getBoundingClientRect();
      if (r.width && r.height) masks.push([r.x, r.y, r.width, r.height]);
      e.setAttribute("data-cmp-time", "1");
    }
    // The DOM as laid out: unwrap React's #root, drop scripts/styles and the
    // preview's own nodes, blank time texts.
    const clone = document.body.cloneNode(true);
    const root = clone.querySelector("#root");
    if (root) root.replaceWith(...root.childNodes);
    clone.querySelectorAll("script,style,link").forEach((n) => n.remove());
    clone.querySelectorAll("[data-cmp-time]").forEach((n) => {
      n.textContent = "<time>";
      n.removeAttribute("data-cmp-time");
    });
    const walk = (n, d, out) => {
      if (n.nodeType === 3) {
        const t = n.textContent.replace(/\s+/g, " ").trim();
        if (t) out.push("  ".repeat(d) + JSON.stringify(t));
        return;
      }
      if (n.nodeType !== 1) return;
      const attrs = [...n.attributes]
        .filter((a) => a.name !== "data-cmp-time")
        .map((a) => `${a.name}=${JSON.stringify(a.name === "class" ? a.value.split(/\s+/).filter(Boolean).sort().join(" ") : a.value)}`)
        .sort();
      out.push("  ".repeat(d) + `<${n.tagName.toLowerCase()}${attrs.length ? " " + attrs.join(" ") : ""}>`);
      for (const k of n.childNodes) walk(k, d + 1, out);
    };
    const lines = [];
    walk(clone, 0, lines);
    return { masks, dom: lines, scrolls: [...document.querySelectorAll("#msgs,.scroll,.clist,.sheet-body")].map((e) => e.scrollTop) };
  }, { source: TIME_RE.source, flags: TIME_RE.flags });
  const png = await page.screenshot();
  writeFileSync(join(OUT, `${c.id}-${tag}.png`), png);
  return { png, ...info };
}

function domDiff(a, b) {
  const out = [];
  let i = 0,
    j = 0;
  while ((i < a.length || j < b.length) && out.length < 40) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    // re-sync: look ahead a little on either side
    let k = -1;
    for (let d = 1; d < 30 && k < 0; d++) {
      if (b[j + d] === a[i]) k = d;
    }
    if (k > 0) {
      for (let d = 0; d < k; d++) out.push("+ new: " + b[j + d]);
      j += k;
      continue;
    }
    let m = -1;
    for (let d = 1; d < 30 && m < 0; d++) {
      if (a[i + d] === b[j]) m = d;
    }
    if (m > 0) {
      for (let d = 0; d < m; d++) out.push("- old: " + a[i + d]);
      i += m;
      continue;
    }
    out.push("~ old: " + a[i]);
    out.push("~ new: " + b[j]);
    i++;
    j++;
  }
  return out;
}

const { browser, page, log } = await launch({ width: 390, height: 844, deviceScaleFactor: 2 });
// Same random choices on both sides (the empty-chat greeting is picked at random).
await page.addInitScript(() => {
  let x = 42;
  Math.random = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
});
// The diff runs in its own context, so the captured page stays the visible one.
const diffPage = await (await browser.newContext()).newPage();
await diffPage.setContent("<canvas id=a></canvas><canvas id=b></canvas><canvas id=d></canvas>");
const report = [];
for (const c of CASES) {
  const row = { id: c.id, scenario: c.sc };
  try {
    const o = await capture(page, OLD, c, "old");
    const n = await capture(page, NEW, c, "new");
    const masks = [...o.masks, ...n.masks];
    const res = await diffPage.evaluate(
      async ({ a, b, masks }) => {
        const img = (s) =>
          new Promise((r) => {
            const i = new Image();
            i.onload = () => r(i);
            i.src = "data:image/png;base64," + s;
          });
        const [A, B] = await Promise.all([img(a), img(b)]);
        const w = A.width,
          h = A.height;
        const get = (I, id) => {
          const cv = document.getElementById(id);
          cv.width = w;
          cv.height = h;
          const x = cv.getContext("2d");
          x.drawImage(I, 0, 0);
          return x.getImageData(0, 0, w, h);
        };
        const da = get(A, "a").data,
          db = get(B, "b").data;
        const dc = document.getElementById("d");
        dc.width = w;
        dc.height = h;
        const dx = dc.getContext("2d");
        const out = dx.createImageData(w, h);
        const s = w / 390; // device pixels per CSS pixel
        const masked = (px, py) => masks.some(([x, y, mw, mh]) => px >= (x - 2) * s && px < (x + mw + 2) * s && py >= (y - 2) * s && py < (y + mh + 2) * s);
        let diff = 0,
          maskedPx = 0,
          minX = w,
          minY = h,
          maxX = -1,
          maxY = -1;
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) {
            const p = (y * w + x) * 4;
            const d = Math.abs(da[p] - db[p]) + Math.abs(da[p + 1] - db[p + 1]) + Math.abs(da[p + 2] - db[p + 2]);
            const g = da[p] * 0.3;
            out.data[p] = out.data[p + 1] = out.data[p + 2] = g;
            out.data[p + 3] = 255;
            if (d > 24) {
              if (masked(x, y)) {
                maskedPx++;
                out.data[p + 2] = 255;
                continue;
              }
              diff++;
              out.data[p] = 255;
              out.data[p + 1] = 0;
              out.data[p + 2] = 0;
              if (x < minX) minX = x;
              if (y < minY) minY = y;
              if (x > maxX) maxX = x;
              if (y > maxY) maxY = y;
            }
          }
        dx.putImageData(out, 0, 0);
        return { pct: (100 * diff) / (w * h), diff, maskedPx, box: maxX >= 0 ? [minX / s, minY / s, maxX / s, maxY / s].map(Math.round) : null, diffPng: dc.toDataURL("image/png").split(",")[1] };
      },
      { a: o.png.toString("base64"), b: n.png.toString("base64"), masks },
    );
    writeFileSync(join(OUT, `${c.id}-diff.png`), Buffer.from(res.diffPng, "base64"));
    row.mismatchPct = +res.pct.toFixed(4);
    row.mismatchPx = res.diff;
    row.maskedPx = res.maskedPx;
    row.box = res.box;
    row.masks = masks.length;
    row.domDiff = domDiff(o.dom, n.dom);
    row.domLines = [o.dom.length, n.dom.length];
    row.scrolls = { old: o.scrolls, new: n.scrolls };
  } catch (e) {
    row.error = String(e?.message ?? e).split("\n")[0];
  }
  report.push(row);
  console.log(`${row.error ? "ERR " : row.mismatchPct < 0.5 && !row.domDiff.length ? "ok  " : "DIFF"} ${c.id.padEnd(22)} ${row.error ?? `${row.mismatchPct}% (${row.mismatchPx} px${row.box ? " in " + row.box.join(",") : ""}), dom ${row.domDiff.length ? row.domDiff.length + " lines differ" : "identical"}`}`);
}
const errs = log.pageErrors.map((e) => e.text.split("\n")[0]);
writeFileSync(join(OUT, "report.json"), JSON.stringify({ old: OLD, new: NEW, cases: report, pageErrors: errs, outbound: log.outbound }, null, 2));
console.log(`page errors: ${errs.length}${errs.length ? "\n  " + errs.join("\n  ") : ""}; outbound: ${log.outbound.length}`);
await browser.close();
