// Where added parts land (board/INBOX.md): at the centre of the view. One part
// is 60% of the view wide (or the width it was sent with) and within 80% of
// its height; several go two to a row, and the whole arrangement is scaled
// down uniformly until it fits the view. Every box keeps its part's aspect
// ratio (uniform scaling only). Pure: the tests use it as it is.
export type Part = { lw: number; lh: number; width?: number };
export type View = { cx: number; cy: number; w: number; h: number };
export type Placed = { x: number; y: number; w: number; h: number };

const r1 = (v: number) => Math.round(v * 10) / 10;

export function placeParts(parts: readonly Part[], view: View): Placed[] {
  if (!parts.length) return [];
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
  const k = Math.min(1, (vh * 0.86) / total, (vw * 0.92) / widest);
  const out: Placed[] = new Array(parts.length);
  let y = view.cy - (total * k) / 2;
  for (const row of rows) {
    let x = view.cx - (row.w * k) / 2;
    for (const i of row.list) {
      const { w, h } = sized[i]!;
      out[i] = { x: r1(x), y: r1(y), w: r1(w * k), h: r1(h * k) };
      x += (w + gap) * k;
    }
    y += (row.h + gap) * k;
  }
  return out;
}
