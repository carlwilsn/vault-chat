// Ink is one smooth band of the stroke's width (board/src/ink.ts), checked on pixels in WebKit at DPR 2: every stroke
// drawn alone, at each zoom, and its ink against its centreline (perfect-freehand's stabilised samples, as drawn):
//   - one connected band (8-connected ink pixels: one component);
//   - no bulge: every ink pixel within w/2 (+15%, + 0.75 device px of anti-aliasing) of the centreline;
//   - no neck: every pixel within w/2 (-15%, - 0.75 px) of it is ink;
//   - its width across (ink measured along the normal, every device px along the path, away from the caps, tight
//     turns and places where the stroke meets itself) within ±15% of w (+ 1.5 px: the run is read off whole device
//     pixels at each end, which matters only at widths of 2–3 px).
// Beads, knots and blobs (the filled perfect-freehand outline folding over itself at uniform width) fail it.
// The strokes: the recorded handwriting (board/src/inkTraces.ts) and any board.json given (a real board's strokes).
// INK_MODULE checks another ink.ts served by the dev server (e.g. a copy of an older one), with the same centreline.
// SHOTS=1: also the board's strokes at each zoom, side by side with INK_BEFORE's (a module path), into OUT.
//
//   VC_BOX=… npm run dev:board   (only the dev server is used: no box needed)
//   PLAYWRIGHT_CORE=preview/node_modules/playwright-core node board/preview/ink-band.mjs [board.json …]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ipadPage, checker } from "./ipad.mjs";

const url = process.env.URL ?? "http://localhost:1431/board/";
const OUT = process.env.OUT ?? join(tmpdir(), "board-ink-band");
mkdirSync(OUT, { recursive: true });
const mod = process.env.INK_MODULE ?? "/board/src/ink.ts";
const before = process.env.INK_BEFORE ?? "";
// Zooms as multiples of the iPad's home zoom ((1194 - 32) / 1000 css px per unit, landscape).
const HOME = (1194 - 32) / 1000;
const ZOOMS = (process.env.ZOOMS ?? "0.5,1,2,4").split(",").map(Number);
const boards = process.argv.slice(2).map((f) => ({ name: basename(f), strokes: JSON.parse(readFileSync(f, "utf8")).strokes ?? [] }));

const { check, failed } = checker();
const { browser, page } = await ipadPage();
page.on("pageerror", (e) => check(false, "no page error", e.message));
page.on("requestfailed", (r) => console.log("request failed", r.url(), r.failure()?.errorText));
// A module of the dev server as the page (same origin, and no HMR client to reload it while a check runs).
await page.goto(new URL("src/geom.ts", url).href);

const sets = await page.evaluate(async (boards) => {
  const { inkTraces } = await import("/board/src/inkTraces.ts");
  // The traces are screen css px at the home zoom: as the board stores them (samples under half a px apart left out).
  const traces = [0, 1, 2].flatMap((v) => inkTraces(v)).map((t) => {
    const xy = [];
    for (const p of t.pts) {
      const n = xy.length;
      if (n >= 2 && Math.hypot(p.x - xy[n - 2], p.y - xy[n - 1]) < 0.5) continue;
      xy.push(Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100);
    }
    return { id: t.name, tool: "pen", color: "#000", w: 2.4, xy };
  });
  // Where a filled outline folds over itself: hairpins, sharp zigzags, and a slow stretch of jittery samples.
  const rnd = ((v) => () => ((v = (v * 1664525 + 1013904223) >>> 0) / 2 ** 32 - 0.5))(7);
  const turns = [];
  for (const w of [1.4, 2.4, 4]) {
    const hp = [], zz = [], slow = [];
    for (let i = 0; i <= 40; i++) hp.push(i, 0);
    for (let i = 1; i <= 40; i++) hp.push(40 - i, 0.4 + i * 0.02);
    for (let i = 0; i <= 120; i++) zz.push(i * 0.5, (Math.floor(i / 10) % 2 ? 10 - (i % 10) : i % 10) * 1.6);
    for (let i = 0; i <= 300; i++) slow.push(i * 0.1 + rnd() * 0.4, Math.sin(i / 30) * 3 + rnd() * 0.4);
    turns.push({ id: `hairpin w${w}`, tool: "pen", color: "#000", w, xy: hp }, { id: `zigzag w${w}`, tool: "pen", color: "#000", w, xy: zz }, { id: `slow w${w}`, tool: "pen", color: "#000", w, xy: slow });
  }
  return [{ name: "inkTraces", strokes: traces }, { name: "sharp turns", strokes: turns }, ...boards];
}, boards);

for (const set of sets) {
  for (const zk of ZOOMS) {
    const r = await page.evaluate(
      async ([mod, strokes, z]) => {
        const ink = await import(mod);
        const cur = await import("/board/src/ink.ts");
        const D = 2, s = z * D;
        const res = [];
        for (const st of strokes) {
          if (st.xy.length < 4) continue;
          const wpx = st.w * s;
          // The centreline as drawn: quadratic curves through the midpoints, flattened to ~0.25 device px.
          const c = cur.inkCentre(st.xy, st.w);
          const P = [];
          for (let i = 0; i + 1 < c.length; i += 2) P.push([c[i] * s, c[i + 1] * s]);
          const curve = [P[0]];
          if (P.length > 2) {
            let a = P[0];
            for (let i = 1; i < P.length - 1; i++) {
              const m = [(P[i][0] + P[i + 1][0]) / 2, (P[i][1] + P[i + 1][1]) / 2];
              const n = Math.max(2, Math.ceil((Math.hypot(P[i][0] - a[0], P[i][1] - a[1]) + Math.hypot(m[0] - P[i][0], m[1] - P[i][1])) / 0.25));
              for (let k = 1; k <= n; k++) {
                const t = k / n, u = 1 - t;
                curve.push([u * u * a[0] + 2 * u * t * P[i][0] + t * t * m[0], u * u * a[1] + 2 * u * t * P[i][1] + t * t * m[1]]);
              }
              a = m;
            }
          }
          const L = P[P.length - 1], l0 = curve[curve.length - 1];
          const nl = Math.max(1, Math.ceil(Math.hypot(L[0] - l0[0], L[1] - l0[1]) / 0.25));
          for (let k = 1; k <= nl; k++) curve.push([l0[0] + ((L[0] - l0[0]) * k) / nl, l0[1] + ((L[1] - l0[1]) * k) / nl]);
          const arc = [0];
          for (let i = 1; i < curve.length; i++) arc.push(arc[i - 1] + Math.hypot(curve[i][0] - curve[i - 1][0], curve[i][1] - curve[i - 1][1]));
          // The stroke alone, black on transparent.
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          for (const [x, y] of curve) (x0 = Math.min(x0, x)), (y0 = Math.min(y0, y)), (x1 = Math.max(x1, x)), (y1 = Math.max(y1, y));
          const pad = Math.ceil(wpx + 6);
          const ox = Math.floor(x0) - pad, oy = Math.floor(y0) - pad;
          const W = Math.ceil(x1) + pad - ox, H = Math.ceil(y1) + pad - oy;
          const cv = document.createElement("canvas");
          cv.width = W;
          cv.height = H;
          const ctx = cv.getContext("2d");
          ctx.setTransform(s, 0, 0, s, -ox, -oy);
          ink.drawStroke(ctx, { ...st, tool: "pen", color: "#000", style: undefined });
          const A = ctx.getImageData(0, 0, W, H).data;
          const on = (x, y) => x >= 0 && y >= 0 && x < W && y < H && A[(y * W + x) * 4 + 3] >= 128;
          cv.width = cv.height = 0;
          // Each pixel's distance to the centreline (and where along it the nearest point is), splatted.
          const dist = new Float32Array(W * H).fill(Infinity), at = new Float32Array(W * H);
          const R = Math.ceil(wpx * 0.75 + 3);
          for (let i = 0; i < curve.length; i++) {
            const cx = curve[i][0] - ox, cy = curve[i][1] - oy;
            for (let y = Math.max(0, Math.floor(cy - R)); y <= Math.min(H - 1, Math.ceil(cy + R)); y++)
              for (let x = Math.max(0, Math.floor(cx - R)); x <= Math.min(W - 1, Math.ceil(cx + R)); x++) {
                const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy), k = y * W + x;
                if (d < dist[k]) (dist[k] = d), (at[k] = arc[i]);
              }
          }
          const rOut = (wpx / 2) * 1.15 + 0.75, rIn = Math.max(0, (wpx / 2) * 0.85 - 0.75);
          let bulge = 0, neck = 0, worst = 0, ink1 = 0;
          for (let y = 0; y < H; y++)
            for (let x = 0; x < W; x++) {
              const k = y * W + x, d = dist[k];
              if (on(x, y)) {
                ink1++;
                if (d > rOut) bulge++, (worst = Math.max(worst, d === Infinity ? 99 : (d - wpx / 2) / wpx));
              } else if (d <= rIn) neck++;
            }
          // One connected band.
          const seen = new Uint8Array(W * H);
          let comps = 0;
          for (let y = 0; y < H; y++)
            for (let x = 0; x < W; x++) {
              if (!on(x, y) || seen[y * W + x]) continue;
              comps++;
              const q = [y * W + x];
              seen[y * W + x] = 1;
              while (q.length) {
                const k = q.pop(), px = k % W, py = (k - px) / W;
                for (let dy = -1; dy <= 1; dy++)
                  for (let dx = -1; dx <= 1; dx++) {
                    const nx = px + dx, ny = py + dy;
                    if (on(nx, ny) && !seen[ny * W + nx]) (seen[ny * W + nx] = 1), q.push(ny * W + nx);
                  }
              }
            }
          // Widths across, every device px along the path (not within a width of either end).
          const widths = [];
          const total = arc[arc.length - 1];
          let j = 0, back = 0, fwd = 0;
          for (let a = wpx; a < total - wpx; a += 1) {
            while (j + 1 < curve.length && arc[j + 1] < a) j++;
            while (back + 1 < curve.length && arc[back + 1] <= a - wpx / 2) back++;
            while (fwd + 1 < curve.length && arc[fwd] < a + wpx / 2) fwd++;
            const tx = curve[fwd][0] - curve[back][0], ty = curve[fwd][1] - curve[back][1], tl = Math.hypot(tx, ty);
            // A tight turn (the chord over one width much shorter than the arc): the inside of a turn is legitimately
            // wider; beads show on straight and gently curved stretches too, and as bulges everywhere (above).
            if (tl < 0.9 * (arc[fwd] - arc[back])) continue;
            const nx = -ty / tl, ny = tx / tl, cx = curve[j][0] - ox, cy = curve[j][1] - oy;
            let ext = 0, crossed = false;
            for (const sg of [1, -1]) {
              let e = 0;
              for (let t = 0.25; t < wpx * 2; t += 0.25) {
                const px = Math.floor(cx + sg * nx * t), py = Math.floor(cy + sg * ny * t);
                if (!on(px, py)) break;
                // Run into another stretch of the same stroke (it crosses or comes back): not a width.
                if (Math.abs(at[py * W + px] - a) > 0.75 * wpx) crossed = true;
                e = t;
              }
              ext += e;
            }
            if (!crossed) widths.push(ext);
          }
          widths.sort((p, q) => p - q);
          const bad = widths.filter((v) => Math.abs(v - wpx) > 0.15 * wpx + 1.5).length;
          res.push({ id: st.id, wpx, ink: ink1, bulge, neck, worst, comps, n: widths.length, bad, wmin: widths[0] ?? 0, wmed: widths[widths.length >> 1] ?? 0, wmax: widths[widths.length - 1] ?? 0 });
        }
        return res;
      },
      [mod, set.strokes, zk * HOME],
    );
    const fails = r.filter((x) => x.comps !== 1 || x.bulge || x.neck || x.bad);
    const wm = r.map((x) => x.wmed / x.wpx).sort((a, b) => a - b);
    const detail = `${r.length} strokes, w ${r[0]?.wpx.toFixed(2)} device px; failing ${fails.length}: bulges ${r.reduce((n, x) => n + x.bulge, 0)} px (worst ${Math.max(0, ...r.map((x) => x.worst)).toFixed(2)} w past the edge), necks ${r.reduce((n, x) => n + x.neck, 0)} px, split ${r.filter((x) => x.comps !== 1).length}, widths off ${r.reduce((n, x) => n + x.bad, 0)}/${r.reduce((n, x) => n + x.n, 0)}; median width ${(wm[wm.length >> 1] ?? 0).toFixed(3)} w`;
    check(fails.length === 0, `${set.name} at ${zk}× home zoom: one band of the stroke's width`, detail);
    if (fails.length && process.env.VERBOSE) for (const f of fails.sort((p, q) => q.bulge + q.neck - p.bulge - p.neck).slice(0, 8)) console.log("    ", JSON.stringify(f));
  }
}

// Screenshots: a board's strokes as the iPad shows them at each zoom (DPR 2), before | after.
if (process.env.SHOTS) {
  for (const set of sets.slice(1)) {
    for (const zk of ZOOMS) {
      const b64 = await page.evaluate(
        async ([mods, strokes, z]) => {
          const D = 2, s = z * D;
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          for (const st of strokes) for (let i = 0; i + 1 < st.xy.length; i += 2) (x0 = Math.min(x0, st.xy[i])), (y0 = Math.min(y0, st.xy[i + 1])), (x1 = Math.max(x1, st.xy[i])), (y1 = Math.max(y1, st.xy[i + 1]));
          x0 -= 10, y0 -= 10, x1 += 10, y1 += 10;
          // At most 1600 device px of the board across per panel (the top-left of it when zoomed in further).
          const cw = Math.min(1600, Math.ceil((x1 - x0) * s)), ch = Math.min(1000, Math.ceil((y1 - y0) * s));
          const c = document.createElement("canvas");
          c.width = cw * mods.length + 16 * (mods.length - 1);
          c.height = ch;
          const ctx = c.getContext("2d");
          ctx.fillStyle = "#888";
          ctx.fillRect(0, 0, c.width, c.height);
          for (const [k, m] of mods.entries()) {
            const ink = await import(m);
            ctx.save();
            ctx.translate(k * (cw + 16), 0);
            ctx.fillStyle = "#fff";
            ctx.fillRect(0, 0, cw, ch);
            ctx.beginPath();
            ctx.rect(0, 0, cw, ch);
            ctx.clip();
            ctx.transform(s, 0, 0, s, -x0 * s, -y0 * s);
            for (const st of ink.paintOrder(strokes)) ink.drawStroke(ctx, st);
            ctx.restore();
          }
          return c.toDataURL("image/png").split(",")[1];
        },
        [before ? [before, mod] : [mod], set.strokes, zk * HOME],
      );
      const f = join(OUT, `${set.name.replace(/\W+/g, "-")}-${zk}x.png`);
      writeFileSync(f, Buffer.from(b64, "base64"));
      console.log("shot", f);
    }
  }
}

await browser.close();
console.log(failed() ? `${failed()} FAILED` : "all ok");
process.exit(failed() ? 1 : 0);
