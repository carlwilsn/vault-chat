// Where things land and float on the board. Pure: the tests use them as they are.
//
// placeParts (board/INBOX.md): added parts land at the centre of the view. One part is 60% of the view wide
// (or the width it was sent with) and within 80% of its height; several go two to a row in send order, and the
// whole arrangement is scaled down uniformly until it fits the view. Every box keeps its part's aspect ratio
// (uniform scaling only). With `avoid` (what is on the board already), the arrangement moves to the nearest spot
// in view where none of its boxes meets any of them (smaller, if it has to), so "Add all" never lands on Carl's
// ink or items; when the view has no room, beside them at full size (view.ts then brings it into view).
//
// pillSpot: where the selection's pill (Delete / Interact) floats, iPadOS-style.
export type Part = { lw: number; lh: number; width?: number };
export type View = { cx: number; cy: number; w: number; h: number };
export type Placed = { x: number; y: number; w: number; h: number };
export type Rect = { x0: number; y0: number; x1: number; y1: number };

const r1 = (v: number) => Math.round(v * 10) / 10;

/** The arrangement centred on (cx, cy), fitted to the view and then scaled by `shrink`. */
function arrange(parts: readonly Part[], view: View, cx: number, cy: number, shrink = 1): Placed[] {
  const { w: vw, h: vh } = view;
  const many = parts.length > 1;
  const aspect = (p: Part) => (p.lh || p.lw * 0.75) / p.lw;
  const sized = parts.map((p) => {
    let w = typeof p.width === "number" ? p.width : vw * (many ? 0.44 : 0.6);
    let h = w * aspect(p);
    if (!many && h > vh * 0.8) (h = vh * 0.8), (w = h / aspect(p));
    return { w, h };
  });
  const gap = vw * 0.03;
  const rows: { list: number[]; w: number; h: number }[] = [];
  sized.forEach((it, i) => {
    const row = rows[rows.length - 1];
    if (row && row.list.length < 2 && row.w + gap + it.w <= vw * 0.95) {
      row.list.push(i);
      row.w += gap + it.w;
      row.h = Math.max(row.h, it.h);
    } else rows.push({ list: [i], w: it.w, h: it.h });
  });
  const total = rows.reduce((a, r) => a + r.h, 0) + gap * (rows.length - 1);
  const widest = Math.max(...rows.map((r) => r.w));
  const k = Math.min(1, (vh * 0.86) / total, (vw * 0.92) / widest) * shrink;
  const out: Placed[] = new Array(parts.length);
  let y = cy - (total * k) / 2;
  for (const row of rows) {
    let x = cx - (row.w * k) / 2;
    for (const i of row.list) {
      const { w, h } = sized[i]!;
      out[i] = { x: r1(x), y: r1(y), w: r1(w * k), h: r1(h * k) };
      x += (w + gap) * k;
    }
    y += (row.h + gap) * k;
  }
  return out;
}

const meets = (a: Placed, b: Rect, pad: number) => a.x < b.x1 + pad && b.x0 - pad < a.x + a.w && a.y < b.y1 + pad && b.y0 - pad < a.y + a.h;

export function placeParts(parts: readonly Part[], view: View, avoid: readonly Rect[] = []): Placed[] {
  if (!parts.length) return [];
  const first = arrange(parts, view, view.cx, view.cy);
  const near = avoid.filter((b) => b.x1 > view.cx - view.w && b.x0 < view.cx + view.w && b.y1 > view.cy - view.h && b.y0 < view.cy + view.h);
  if (!near.length) return first;
  const pad = view.w * 0.015;
  const x0 = view.cx - view.w / 2, y0 = view.cy - view.h / 2;
  const inView = (bs: Placed[]) => bs.every((b) => b.x >= x0 - 0.2 && b.y >= y0 - 0.2 && b.x + b.w <= x0 + view.w + 0.2 && b.y + b.h <= y0 + view.h + 0.2);
  const free = (bs: Placed[]) => bs.every((b) => !near.some((a) => meets(b, a, pad)));
  // Nearest first: rings of candidate centres around the view's centre, then smaller, until one is clear and in view.
  const step = Math.min(view.w, view.h) * 0.05;
  for (const shrink of [1, 0.8, 0.62, 0.48, 0.36]) {
    for (let ring = 0; ring <= 12; ring++) {
      const cands: [number, number][] = [];
      for (let i = -ring; i <= ring; i++)
        for (let j = -ring; j <= ring; j++) if (Math.max(Math.abs(i), Math.abs(j)) === ring) cands.push([i * step, j * step]);
      cands.sort((a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]));
      for (const [dx, dy] of cands) {
        const bs = arrange(parts, view, view.cx + dx, view.cy + dy, shrink);
        if (inView(bs) && free(bs)) return bs;
      }
    }
  }
  // No room in view: the nearest clear spot at full size, beside what is there (the caller brings it into view).
  for (let ring = 1; ring <= 80; ring++) {
    let best: Placed[] | null = null, bestD = Infinity;
    for (let i = -ring; i <= ring; i++)
      for (let j = -ring; j <= ring; j++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue;
        const d = Math.hypot(i, j);
        if (d >= bestD) continue;
        const bs = arrange(parts, view, view.cx + i * step * 2, view.cy + j * step * 2);
        if (bs.every((b) => !avoid.some((x) => meets(b, x, pad)))) (best = bs), (bestD = d);
      }
    if (best) return best;
  }
  return first; // nothing clear anywhere near: the centre, as before
}

/**
 * The selection pill's top-left (screen css px), iPadOS-style: centred over the visible part of the selection,
 * `gap` above it (clear of its corner handles); below it when there is no room above (under the controls,
 * `top`); inside its top edge, under the top handles, when it fills the view; always inside the view. Null when
 * the selection is out of view.
 */
export function pillSpot(
  sel: Rect,
  pill: { w: number; h: number },
  view: { w: number; h: number; top: number },
  gap = 18,
  margin = 10,
): { x: number; y: number; side: "above" | "below" | "inside" } | null {
  if (sel.x1 < 0 || sel.y1 < view.top || sel.x0 > view.w || sel.y0 > view.h) return null;
  const cx = (Math.max(sel.x0, 0) + Math.min(sel.x1, view.w)) / 2;
  const x = Math.round(Math.max(margin, Math.min(view.w - margin - pill.w, cx - pill.w / 2)));
  const above = sel.y0 - gap - pill.h;
  if (above >= view.top) return { x, y: Math.round(above), side: "above" };
  const below = sel.y1 + gap;
  if (below + pill.h <= view.h - margin) return { x, y: Math.round(below), side: "below" };
  // Taller than the room around it: inside, below its top handles (or the controls, whichever is lower).
  const y = Math.max(view.top, sel.y0 + gap + 10);
  return { x, y: Math.round(Math.min(y, view.h - margin - pill.h)), side: "inside" };
}
