// How the board keeps up with the Pencil while Carl writes, in WebKit as his iPad (DPR 2): a busy board (600 strokes),
// then a writing session (handwriting from board/src/inkTraces.ts at the Pencil's 240 samples a second, delivered as
// iPadOS does, a move per 120 Hz frame carrying the samples since the last; short gaps inside a word, longer ones
// between words, so saves and the agent's pictures fall between strokes and the next pen comes down on them).
// Measured from the page itself, the same way for any build of the board:
//   - input → frame: from when the pen was at a sample to the first animation frame after it reached the page
//     (median, p95, worst);
//   - dispatch delay: from the sample to its pointermove running (the main thread busy elsewhere);
//   - frame gaps over 20 ms while the pen is down, and the main thread's stalls over 20 ms (a 0 ms timer that ran late:
//     Safari has no long-task observer), anywhere in the session;
//   - the board's own perf line (`ink.perf`, board/src/view.ts) when the build has it.
// Variants: voice on (`?voice=fake`, the call started: the pill's waves, its wait line, the board's pushes to the
// voice) or off; the agent's pictures as the build makes them, or stubbed out (`pics: "off"`).
// Headless WebKit on Windows draws in software and encodes PNGs on the page (no OffscreenCanvas): read the numbers
// as relative, the real iPad's come from its `ink.perf` lines in board.jsonl.
//
//   npx tsx board/preview/box.ts 7452 &  ;  VC_BOX=http://127.0.0.1:7452 npx vite --config board/vite.config.ts --port 1471
//   PLAYWRIGHT_CORE=preview/node_modules/playwright-core node board/preview/pen-perf.mjs [board url] [runs=2]
import { ipadPage, checker } from "./ipad.mjs";

const url = process.argv[2] ?? "http://localhost:1471/board/";
const RUNS = Number(process.argv[3] ?? 2);
const LABEL = process.env.LABEL ?? "";
const { check, failed } = checker();
const { browser, page } = await ipadPage({ deviceScaleFactor: 2 });
// (A request cut off by the next navigation is reported by WebKit as an access-control page error: not the board's.)
page.on("pageerror", (e) => /access control checks/.test(e.message) || check(false, "no page error", e.message));
const logged = [];
await page.route("**/api/v1/board/log", async (route) => {
  try {
    logged.push(...(JSON.parse(route.request().postData() ?? "{}").events ?? []));
  } catch {
    /* not JSON */
  }
  await route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true,"n":0}' });
});
await page.addInitScript(() => {
  // Muted: nothing here may make a sound.
  try {
    // Nothing reaches the speakers: no node connects to an audio context's output, every media element is muted.
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (dst, ...rest) {
      if (dst && typeof AudioDestinationNode !== "undefined" && dst instanceof AudioDestinationNode) return dst;
      return connect.call(this, dst, ...rest);
    };
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      this.muted = true;
      this.volume = 0;
      return play.call(this);
    };
  } catch {
    /* no audio */
  }
  let down = null;
  const ev = (type, p, buttons, extra = {}) => new PointerEvent(type, { pointerId: 951, pointerType: "pen", isPrimary: true, bubbles: true, cancelable: true, composed: true, clientX: p.x, clientY: p.y, width: 1, height: 1, pressure: buttons ? 0.5 : 0, buttons, button: type === "pointermove" ? -1 : 0, ...extra });
  const fire = (type, p, buttons, extra) => {
    const target = type === "pointerdown" ? (document.elementFromPoint(p.x, p.y) ?? document.body) : down;
    if (type === "pointerdown") down = target;
    target.dispatchEvent(ev(type, p, buttons, extra));
  };
  // Does this WebKit take coalescedEvents in PointerEventInit? Then a move carries every sample since the last, as on the iPad.
  const coalesce = (() => {
    try {
      return new PointerEvent("pointermove", { coalescedEvents: [new PointerEvent("pointermove", { clientX: 1 })] }).getCoalescedEvents?.().length === 1;
    } catch {
      return false;
    }
  })();
  window.__coalesce = coalesce;
  /** strokes: [{pts: [{x, y, t}], gap}] (css px, ms); one move per `frameMs` with the samples due by then. */
  window.__write = async (strokes, frameMs = 1000 / 120) => {
    const st = { lat: [], disp: [], gaps: [], stalls: [], frames: 0, strokeFrames: 0, samples: 0 };
    let run = true, inStroke = false, lastF = 0, lastBeat = performance.now();
    let pending = [];
    const beat = () => {
      const t = performance.now();
      if (t - lastBeat > 20) st.stalls.push(t - lastBeat);
      lastBeat = t;
      if (run) setTimeout(beat, 0);
    };
    setTimeout(beat, 0);
    const frame = () => {
      const now = performance.now();
      st.frames++;
      if (inStroke) {
        st.strokeFrames++;
        if (lastF && now - lastF > 20) st.gaps.push(now - lastF);
        lastF = now;
      }
      for (const s of pending) st.lat.push(now - s);
      pending = [];
      if (run) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    for (const s of strokes) {
      const pts = s.pts;
      inStroke = window.__penDown = true;
      lastF = 0;
      const t0 = performance.now();
      fire("pointerdown", pts[0], 1);
      let i = 1, nextFrame = t0 + frameMs;
      await new Promise((res) => {
        const tick = () => {
          const now = performance.now();
          if (now >= nextFrame || i >= pts.length) {
            nextFrame += frameMs * Math.max(1, Math.ceil((now - nextFrame) / frameMs));
            const due = [];
            while (i < pts.length && t0 + pts[i].t - pts[0].t <= now) due.push(pts[i++]);
            if (due.length) {
              const last = due[due.length - 1];
              if (coalesce) fire("pointermove", last, 1, { coalescedEvents: due.map((d) => ev("pointermove", d, 1)) });
              else for (const d of due) fire("pointermove", d, 1);
              const after = performance.now();
              for (const d of due) {
                const at = t0 + d.t - pts[0].t;
                st.disp.push(after - at);
                pending.push(at);
                st.samples++;
              }
            }
          }
          if (i >= pts.length) return res();
          setTimeout(tick, 0);
        };
        tick();
      });
      fire("pointerup", pts[pts.length - 1], 0);
      inStroke = window.__penDown = false;
      await new Promise((r) => setTimeout(r, s.gap));
    }
    await new Promise((r) => setTimeout(r, 300));
    run = false;
    return st;
  };
});

const q = (a, p) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 10) / 10;
};

async function session(o) {
  await page.goto("about:blank");
  await page.goto(`${url}${o.voice ? "?voice=fake" : ""}#/b/${slug}`);
  await page.waitForFunction(() => !!window.__board?.debug);
  await page.waitForTimeout(1200);
  // Every picture the board draws (the agent's pair, voice's), and whether a stroke was being written meanwhile.
  await page.evaluate((off) => {
    const v = window.__board;
    window.__pics = [];
    for (const k of ["exportPictures", "snapshotView"]) {
      const f = off && k === "exportPictures" ? async () => ({}) : v[k].bind(v);
      v[k] = async (...a) => {
        const t0 = performance.now(), down = !!window.__penDown;
        try {
          return await f(...a);
        } finally {
          window.__pics.push({ k, down: down || !!window.__penDown, ms: Math.round(performance.now() - t0) });
        }
      };
    }
  }, o.pics === "off");
  if (o.voice) {
    const mic = await page.locator('[data-act="voice"]').boundingBox();
    await page.touchscreen.tap(mic.x + mic.width / 2, mic.y + mic.height / 2);
    await page.waitForFunction(() => window.__voice.state.phase === "live", null, { timeout: 8000 });
    await page.waitForTimeout(500);
  }
  const before = logged.length;
  // 32 strokes: words of 4 strokes, 140 ms between strokes, 900 ms between words (a save, the pictures and the voice's
  // push fall in those), written across the view.
  const strokes = await page.evaluate(async () => {
    const { inkTraces } = await import("/board/src/inkTraces.ts");
    const all = [0, 1, 2].flatMap((k) => inkTraces(k));
    const out = [];
    for (let i = 0; i < 32; i++) {
      const t = all[(i * 7) % all.length];
      const ox = 120 + (i % 8) * 110, oy = 160 + Math.floor(i / 8) * 120;
      const x0 = t.pts[0].x, y0 = t.pts[0].y;
      out.push({ pts: t.pts.map((p) => ({ x: Math.round(ox + (p.x - x0) * 0.6), y: Math.round(oy + (p.y - y0) * 0.6), t: p.t })), gap: i % 4 === 3 ? 900 : 140 });
    }
    return out;
  });
  const st = await page.evaluate((s) => window.__write(s), strokes);
  const drawn = await page.evaluate(() => window.__pics.splice(0));
  await page.evaluate(() => window.__board.flush?.());
  await page.waitForTimeout(2500);
  await page.evaluate(async () => {
    const m = await import("/board/src/log.ts");
    await m.flushBoardLog();
  });
  const mine = logged.slice(before);
  const pics = mine.filter((e) => e.ev === "board.pictures");
  const perf = mine.filter((e) => e.ev === "ink.perf");
  return {
    samples: st.samples,
    frames: st.strokeFrames,
    latency: { p50: q(st.lat, 0.5), p95: q(st.lat, 0.95), max: q(st.lat, 1) },
    dispatch: { p50: q(st.disp, 0.5), p95: q(st.disp, 0.95), max: q(st.disp, 1) },
    gaps20: st.gaps.length,
    gapMax: q(st.gaps, 1),
    stalls20: st.stalls.length,
    stallMax: q(st.stalls, 1),
    stallSum: Math.round(st.stalls.reduce((a, b) => a + b, 0)),
    pictures: drawn.filter((p) => p.k === "exportPictures").length,
    looks: drawn.filter((p) => p.k === "snapshotView").length,
    picsInStroke: drawn.filter((p) => p.down).length,
    picDrawMs: pics.map((p) => p.drawMs),
    perf: perf.map(({ at, ...r }) => r),
  };
}

await page.goto(url);
await page.evaluate(() => localStorage.clear());
const slug = await page.evaluate(async () => (await (await fetch("/api/v1/boards", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: `Pen perf ${Date.now() % 100000}` }) })).json()).slug);
await page.goto(`${url}#/b/${slug}`);
await page.waitForFunction(() => !!window.__board?.debug);
// A busy board: 600 strokes of handwriting, saved once (the pictures redraw it).
await page.evaluate(async () => {
  const { inkTraces } = await import("/board/src/inkTraces.ts");
  const v = window.__board;
  const all = [0, 1, 2, 3, 4].flatMap((k) => inkTraces(k));
  for (let i = 0; i < 600; i++) {
    const t = all[i % all.length];
    const ox = (i % 20) * 70 - 100, oy = Math.floor(i / 20) * 60 + 700;
    const xy = t.pts.flatMap((p) => [Math.round(((p.x - t.pts[0].x) * 0.3 + ox + 200) * 100) / 100, Math.round(((p.y - t.pts[0].y) * 0.3 + oy) * 100) / 100]);
    v.board.strokes.push({ id: `s${i}`, tool: "pen", color: "#1f1f24", w: 2.4, xy });
  }
  v.changed();
  await v.flush();
});
console.log(`coalesced events in PointerEventInit: ${await page.evaluate(() => window.__coalesce)}`);
const variants = [
  { name: "voice off, pictures as built", voice: false },
  { name: "voice off, pictures stubbed", voice: false, pics: "off" },
  { name: "voice on,  pictures as built", voice: true },
  { name: "voice on,  pictures stubbed", voice: true, pics: "off" },
];
const results = {};
for (let r = 0; r < RUNS; r++)
  for (const v of variants) {
    const res = await session(v);
    (results[v.name] ??= []).push(res);
    console.log(`${LABEL}${v.name} #${r + 1}: ${JSON.stringify(res)}`);
  }
console.log("\nsummary (median of runs): input→frame p50/p95/max · dispatch p95/max · frame gaps >20 ms (max) · stalls >20 ms (max, total) · pictures, voice pictures drawn during the session (of them in a stroke)");
const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
for (const [name, rs] of Object.entries(results)) {
  const m = (f) => med(rs.map(f));
  console.log(`${LABEL}${name}: ${m((r) => r.latency.p50)}/${m((r) => r.latency.p95)}/${m((r) => r.latency.max)} ms · ${m((r) => r.dispatch.p95)}/${m((r) => r.dispatch.max)} ms · ${m((r) => r.gaps20)} (${m((r) => r.gapMax)} ms) · ${m((r) => r.stalls20)} (${m((r) => r.stallMax)} ms, ${m((r) => r.stallSum)} ms) · ${m((r) => r.pictures)}, ${m((r) => r.looks)} (${m((r) => r.picsInStroke)})`);
}
const all = Object.values(results).flat();
check(all.every((r) => r.picsInStroke === 0 && r.pictures === 0), "no picture (the agent's or voice's) was drawn while writing: they wait for the pen to rest", JSON.stringify(all.map((r) => [r.pictures, r.looks, r.picsInStroke])));
const perf = all.flatMap((r) => r.perf);
check(perf.length > 0 && perf.every((p) => p.strokes > 0 && p.samples > 0 && p.lat.p50 > 0 && p.hz > 0), "the board reports its pen latency (ink.perf: strokes, samples, input → frame, frame rate)", perf[0] ? JSON.stringify(perf[0]) : "no ink.perf line");
check(perf.every((p) => Object.keys(p.during).length === 0), "…and none of its heavy work (pictures, save, device copy) ran with the pen down", JSON.stringify(perf.map((p) => p.during).filter((d) => Object.keys(d).length)));
await browser.close();
process.exit(failed() ? 1 : 0);
