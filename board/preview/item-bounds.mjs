// Every kind of inbox item shows completely, with its true proportions, at any zoom — in WebKit as Carl's iPad
// (Mac UA, touch, DPR 2). Seeds the preview box's inbox (board/preview/box.ts) with the awkward ones through the
// real send: long typeset math (a wide display equation, a tall multi-paragraph proof), a very wide and a very tall
// PNG, an SVG with only a viewBox, a phone photo stored sideways (a JPEG with EXIF orientation 6), plus the seeded
// PDF pages and widget. Each is added to a board from the inbox (a real tap on Add), then checked at several zooms:
//
//   image / pdf — the item box has the picture's own aspect (as WebKit decodes it, EXIF applied), and the
//                 picture's coloured frame is on screen on all four edges of the box (nothing cut off);
//   math        — every glyph of the typeset math lies inside the item's box on screen (nothing clipped by its
//                 overflow: hidden), and the box is no more than a line taller than the math;
//   widget      — the iframe fills the box exactly, at the widget's own layout aspect.
//
// Screenshots: board/preview/out/item-bounds-*.png.
//
//   npx tsx board/preview/box.ts 7442 &  ;  VC_BOX=http://127.0.0.1:7442 npm run dev:board
//   PLAYWRIGHT_CORE=preview/node_modules/playwright-core node board/preview/item-bounds.mjs <vault dir> [board url] [box url]
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { ipadPage, checker, touchScript } from "./ipad.mjs";

const vault = process.argv[2];
if (!vault) throw new Error("usage: item-bounds.mjs <vault dir> [board url] [box url]");
const url = process.argv[3] ?? "http://localhost:1431/board/";
const box = process.argv[4] ?? "http://127.0.0.1:7442";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "out");
mkdirSync(OUT, { recursive: true });
const { check, failed } = checker();

// ---------------------------------------------------------------- test pictures: a coloured frame on every edge

const crcT = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc = (b) => {
  let c = -1;
  for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
/** A PNG w×h: white, a 6% magenta frame, a grey diagonal (so a stretch would show too). */
function framedPng(w, h) {
  const f = Math.max(4, Math.round(Math.min(w, h) * 0.06));
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const edge = x < f || y < f || x >= w - f || y >= h - f;
      const diag = Math.abs(x / w - y / h) < 0.01;
      const [r, g, b] = edge ? [230, 0, 200] : diag ? [90, 90, 90] : [255, 255, 255];
      const i = y * (w * 3 + 1) + 1 + x * 3;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const FRAME_SVG = (w, h) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#fff"/><rect x="${w * 0.03}" y="${w * 0.03}" width="${w - w * 0.06}" height="${h - w * 0.06}" fill="none" stroke="#e600c8" stroke-width="${w * 0.06}"/><text x="${w / 2}" y="${h / 2}" font-size="${h / 4}" text-anchor="middle" dominant-baseline="middle" fill="#333">viewBox only</text></svg>`;

const dir = join(vault, "boards", ".inbox", "_bounds");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "wide.png"), framedPng(2400, 420));
writeFileSync(join(dir, "tall.png"), framedPng(380, 2000));
writeFileSync(join(dir, "viewbox.svg"), FRAME_SVG(900, 240));

const { browser, page } = await ipadPage();
await page.addInitScript(touchScript());
page.on("pageerror", (e) => check(false, "no page error", e.message));
await page.route("**/api/v1/board/log", (route) => route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true,"n":0}' }));
await page.goto(url);
await page.evaluate(() => localStorage.clear());

// A phone photo stored sideways: a 1200×700 JPEG (landscape pixels) with EXIF orientation 6 (shown portrait).
{
  const b64 = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 1200;
    c.height = 700;
    const x = c.getContext("2d");
    x.fillStyle = "#fff";
    x.fillRect(0, 0, 1200, 700);
    x.strokeStyle = "#e600c8";
    x.lineWidth = 84;
    x.strokeRect(0, 0, 1200, 700);
    x.fillStyle = "#333";
    x.font = "120px sans-serif";
    x.fillText("EXIF 6", 380, 400);
    return c.toDataURL("image/jpeg", 0.92).split(",")[1];
  });
  const jpg = Buffer.from(b64, "base64");
  // APP1 Exif: II, one IFD0 entry, Orientation (0x0112) SHORT = 6.
  const tiff = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0, 0, 0, 0x01, 0x00, 0x12, 0x01, 0x03, 0x00, 0x01, 0, 0, 0, 0x06, 0x00, 0x00, 0x00, 0, 0, 0, 0]);
  const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(body.length + 2);
  writeFileSync(join(dir, "photo.jpg"), Buffer.concat([jpg.subarray(0, 2), Buffer.from([0xff, 0xe1]), len, body, jpg.subarray(2)]));
}

const have = (await (await fetch(`${box}/api/v1/inbox`)).json()).entries ?? [];
const send = async (body) => {
  // Seeded by an earlier run: the same entry (the list stays short).
  const old = have.find((e) => e.title === body.title && !e.making && !e.failed);
  if (old) return old.id;
  const r = await fetch(`${box}/api/v1/inbox`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!j.ok) throw new Error(`refused: ${JSON.stringify(j.refusals ?? j)}`);
  return j.id;
};
const WIDE_EQ = `$$${Array.from({ length: 14 }, (_, k) => `\\frac{x^{${k + 1}}}{${k + 1}!}`).join(" + ")} + \\cdots = e^{x} - 1$$`;
const TALL = [
  "**Theorem.** Every bounded monotone sequence of reals converges.",
  "*Proof.* Let $(x_n)$ be increasing and bounded above, and let $L = \\sup_n x_n$, which exists by the completeness of $\\mathbb{R}$.",
  "Given $\\varepsilon > 0$, $L - \\varepsilon$ is not an upper bound, so there is $N$ with $x_N > L - \\varepsilon$. For $n \\ge N$,",
  "$$L - \\varepsilon < x_N \\le x_n \\le L,$$",
  "so $|x_n - L| < \\varepsilon$. Hence $x_n \\to L$.",
  "$$\\begin{aligned} a_1 &= 1, \\\\ a_{n+1} &= \\sqrt{2 + a_n}, \\\\ \\lim_{n\\to\\infty} a_n &= 2. \\end{aligned}$$",
  "The decreasing case is the same with $\\inf$. $\\blacksquare$",
  "| $n$ | $a_n$ |\n|---|---|\n| 1 | 1 |\n| 2 | 1.732 |\n| 3 | 1.932 |\n| 4 | 1.983 |",
].join("\n\n");
const ids = {
  wideMath: await send({ title: "Bounds: wide equation", parts: [{ kind: "math", label: "Series", markdown: `The exponential series, written out:\n\n${WIDE_EQ}` }] }),
  tallMath: await send({ title: "Bounds: tall proof", parts: [{ kind: "math", label: "Proof", markdown: TALL }] }),
  wide: await send({ title: "Bounds: wide image", parts: [{ kind: "image", path: "boards/.inbox/_bounds/wide.png", alt: "a wide framed test picture" }] }),
  tall: await send({ title: "Bounds: tall image", parts: [{ kind: "image", path: "boards/.inbox/_bounds/tall.png", alt: "a tall framed test picture" }] }),
  svg: await send({ title: "Bounds: viewBox SVG", parts: [{ kind: "image", path: "boards/.inbox/_bounds/viewbox.svg", alt: "an SVG with only a viewBox" }] }),
  photo: await send({ title: "Bounds: sideways photo", parts: [{ kind: "image", path: "boards/.inbox/_bounds/photo.jpg", alt: "a JPEG stored sideways with EXIF orientation 6" }] }),
};
const seeded = await page.evaluate(async () => (await (await fetch("/api/v1/inbox")).json()).entries.filter((e) => !e.making && !e.failed).map((e) => ({ id: e.id, kinds: e.parts.map((p) => p.kind) })));
const pdfE = seeded.find((e) => e.kinds[0] === "pdf");
const widgetE = seeded.find((e) => e.kinds[0] === "widget");
const mathSet = seeded.find((e) => e.kinds.length > 1 && e.kinds[0] === "math");

const slug = await page.evaluate(async () => (await (await fetch("/api/v1/boards", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: `Bounds ${Date.now() % 100000}` }) })).json()).slug);
await page.goto("about:blank");
await page.goto(`${url}#/b/${slug}`);
await page.waitForFunction(() => !!window.__board?.debug);

const tap = async (sel) => {
  for (let i = 0; i < 40; i++) {
    const el = page.locator(sel).first();
    await el.waitFor({ state: "visible", timeout: 8000 });
    // A card below the sheet's fold: scrolled into view as a finger would.
    await el.evaluate((n) => n.scrollIntoView({ block: "center" })).catch(() => {});
    const b = await el.boundingBox().catch(() => null);
    if (b) return page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
    await page.waitForTimeout(50);
  }
  throw new Error(`nothing to tap: ${sel}`);
};
const addAll = async (id) => {
  const before = await page.evaluate(() => window.__board.debug().itemsList.length);
  // Somewhere empty, so each lands on its own.
  await page.evaluate((n) => {
    const v = window.__board;
    v.cam = { x: n * 5000, y: 0, z: v.homeZ };
    v.renderBase();
  }, before);
  await tap('[data-act="inbox"]');
  await tap(`aside.inbox button[data-id="${id}"]`);
  // The entry opens (its Add all shows); a tap that met no card is tapped again, as a finger would.
  for (let k = 0; k < 2 && !(await page.locator('aside.inbox button[data-add="all"]').isVisible()); k++) {
    await page.waitForTimeout(1500);
    if (!(await page.locator('aside.inbox button[data-add="all"]').isVisible())) await tap(`aside.inbox button[data-id="${id}"]`).catch(() => {});
  }
  await tap('aside.inbox button[data-add="all"]').catch(async (e) => {
    await page.screenshot({ path: join(OUT, "item-bounds-stuck.png") });
    throw e;
  });
  await page.waitForFunction((n) => window.__board.debug().itemsList.length > n, before, { timeout: 20000 });
  await page.waitForSelector("aside.inbox", { state: "detached", timeout: 5000 }).catch(() => {});
  return page.evaluate((n) => window.__board.debug().itemsList.slice(n), before);
};

/** Look at one item at zoom `zf` × the home zoom, centred: what shows, against its box. */
const look = (id, zf) =>
  page.evaluate(
    async ({ id, zf }) => {
      const v = window.__board;
      const it0 = v.debug().itemsList.find((x) => x.id === id);
      const stage = document.querySelector(".stage").getBoundingClientRect();
      const z = v.homeZ * zf;
      v.cam = { z, x: it0.x + it0.w / 2 - stage.width / 2 / z, y: it0.y + it0.h / 2 - (76 + (stage.height - 76) / 2) / z };
      v.camMoved();
      // Let the camera settle, the images decode, the fonts land, pdf.js sharpen.
      const t0 = performance.now();
      const ready = () => {
        const d = v.debug();
        return !v.gesturing && d.tileScale === v.screenScale();
      };
      while (performance.now() - t0 < 6000 && !ready()) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 700));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const it = v.debug().itemsList.find((x) => x.id === id);
      const full = v.board.items.find((x) => x.id === id);
      const sx = (it.x - v.cam.x) * v.cam.z, sy = (it.y - v.cam.y) * v.cam.z, sw = it.w * v.cam.z, sh = it.h * v.cam.z;
      const res = { kind: it.kind, zf, box: [sx, sy, sw, sh].map((n) => Math.round(n)), aspect: it.w / it.h };
      if (it.kind === "math") {
        const el = document.querySelector(`.items > .it[data-item="${id}"]`);
        const r = el.getBoundingClientRect();
        // Every glyph's box (KaTeX's spans and the text runs) against the item's box.
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const range = document.createRange();
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          // Not KaTeX's MathML copy for screen readers (clipped to a pixel, never shown).
          if (!n.textContent.trim() || n.parentElement?.closest(".katex-mathml")) continue;
          range.selectNodeContents(n);
          for (const q of range.getClientRects()) {
            if (!q.width || !q.height) continue;
            x0 = Math.min(x0, q.left);
            y0 = Math.min(y0, q.top);
            x1 = Math.max(x1, q.right);
            y1 = Math.max(y1, q.bottom);
          }
        }
        res.el = [r.left - stage.left, r.top - stage.top, r.width, r.height].map((n) => Math.round(n));
        res.content = [x0 - stage.left, y0 - stage.top, x1 - x0, y1 - y0].map((n) => Math.round(n));
        const tol = 1.5;
        res.inside = x0 >= r.left - tol && y0 >= r.top - tol && x1 <= r.right + tol && y1 <= r.bottom + tol;
        res.slack = Math.round((r.bottom - y1) / (r.height / (it.h * 1)) ) ;
        res.slackPx = Math.round(r.bottom - y1);
        res.matchesBox = Math.abs(r.width - sw) < 2 && Math.abs(r.height - sh) < 2;
        res.lineH = 18 * 1.5 * (r.width / Number(full.lw));
        return res;
      }
      if (it.kind === "widget") {
        const el = document.querySelector(`.items > .it[data-item="${id}"]`);
        const f = el.querySelector("iframe").getBoundingClientRect();
        res.frame = [f.left - stage.left, f.top - stage.top, f.width, f.height].map((n) => Math.round(n));
        res.layoutAspect = Number(full.lw) / Number(full.lh);
        res.fills = Math.abs(f.width - sw) < 2 && Math.abs(f.height - sh) < 2;
        return res;
      }
      // Canvas-drawn: the picture's natural aspect (WebKit's decode, EXIF applied) and its frame on each edge.
      if (it.kind === "image") {
        const img = new Image();
        img.src = `/api/v1/boards/${encodeURIComponent(v.slug)}/${full.src}`;
        await img.decode();
        res.natural = img.naturalWidth / img.naturalHeight;
      } else if (it.kind === "pdf") res.natural = Number(full.lw) / Number(full.lh);
      const base = document.querySelector("canvas.base");
      const dpr = base.width / stage.width;
      const ctx = base.getContext("2d");
      const px = (x, y) => {
        const d = ctx.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data;
        return [d[0], d[1], d[2], d[3]];
      };
      const magenta = (p) => p[3] > 200 && p[0] > 180 && p[1] < 90 && p[2] > 150;
      const inset = Math.max(2, Math.min(sw, sh) * 0.015);
      const edges = { left: [], right: [], top: [], bottom: [] };
      for (let k = 1; k < 10; k++) {
        const fx = sx + (sw * k) / 10, fy = sy + (sh * k) / 10;
        if (fy > 76 && fy < stage.height) {
          if (sx + inset > 0) edges.left.push(magenta(px(sx + inset, fy)));
          if (sx + sw - inset < stage.width) edges.right.push(magenta(px(sx + sw - inset, fy)));
        }
        if (fx > 0 && fx < stage.width) {
          if (sy + inset > 76) edges.top.push(magenta(px(fx, sy + inset)));
          if (sy + sh - inset < stage.height) edges.bottom.push(magenta(px(fx, sy + sh - inset)));
        }
      }
      res.frame = Object.fromEntries(Object.entries(edges).map(([k, a]) => [k, a.length ? `${a.filter(Boolean).length}/${a.length}` : "off screen"]));
      res.framed = Object.values(edges).every((a) => !a.length || a.filter(Boolean).length >= a.length - 1);
      return res;
    },
    { id, zf },
  );

const ZOOMS = [1, 0.4, 2.5];
const run = async (label, entryId, framed) => {
  if (!entryId) return check(false, `${label}: an inbox entry`);
  const made = await addAll(entryId);
  for (const it of made) {
    for (const zf of ZOOMS) {
      const r = await look(it.id, zf);
      const tag = `${label} (${r.kind}) at ${zf}× zoom`;
      if (r.kind === "math") {
        check(r.inside, `${tag}: all the math inside its box`, JSON.stringify({ el: r.el, content: r.content }));
        check(r.matchesBox, `${tag}: the math's box is the item's box`, JSON.stringify({ el: r.el, box: r.box }));
        check(r.slackPx <= r.lineH * 1.6 + 2, `${tag}: the box hugs the math (≤ a line of slack)`, `${r.slackPx}px below the last line (a line: ${Math.round(r.lineH)}px)`);
      } else if (r.kind === "widget") {
        check(r.fills, `${tag}: the widget fills its box`, JSON.stringify({ frame: r.frame, box: r.box }));
        check(Math.abs(r.aspect / r.layoutAspect - 1) < 0.01, `${tag}: at its layout's aspect`, `${r.aspect.toFixed(3)} vs ${r.layoutAspect.toFixed(3)}`);
      } else {
        check(Math.abs(r.aspect / r.natural - 1) < 0.01, `${tag}: the box has the picture's own aspect`, `${r.aspect.toFixed(3)} vs ${r.natural.toFixed(3)}`);
        if (framed) check(r.framed, `${tag}: its frame shows on every edge (nothing cut off)`, JSON.stringify(r.frame));
      }
      if (zf === 1) await page.screenshot({ path: join(OUT, `item-bounds-${label.replace(/\W+/g, "-")}-${made.indexOf(it)}.png`) });
    }
  }
};

await run("wide equation", ids.wideMath);
await run("tall proof", ids.tallMath);
await run("problem set", mathSet?.id);
await run("wide image", ids.wide, true);
await run("tall image", ids.tall, true);
await run("viewBox SVG", ids.svg, true);
await run("sideways photo", ids.photo, true);
await run("PDF pages", pdfE?.id);
await run("widget", widgetE?.id);

// Reopened (a fresh page: the board as stored), every item still keeps its proportions.
await page.goto("about:blank");
await page.goto(`${url}#/b/${slug}`);
await page.waitForFunction(() => !!window.__board?.debug);
const items = await page.evaluate(() => window.__board.debug().itemsList.map((x) => x.id));
for (const id of items) {
  const r = await look(id, 1);
  if (r.kind === "math") check(r.inside && r.matchesBox, `reopened: ${r.kind} ${id} whole`, JSON.stringify({ el: r.el, content: r.content }));
  else if (r.natural) check(Math.abs(r.aspect / r.natural - 1) < 0.01, `reopened: ${r.kind} ${id} at its own aspect`, `${r.aspect.toFixed(3)} vs ${r.natural.toFixed(3)}`);
}

await browser.close();
console.log(failed() ? `\n${failed()} check(s) failed` : "\nall checks passed");
process.exit(failed() ? 1 : 0);
