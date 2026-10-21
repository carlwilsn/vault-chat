// How well a drawn stroke follows the hand (test/harness/board-ink.test.ts, on board/src/inkTraces.ts): its
// centreline against the true path the hand meant. Not imported by the app.
//   dev    — RMS distance from the drawn centreline to the true path (px): noise left in, and corners cut;
//   max    — the largest such distance (px);
//   wiggle — RMS change of the turning angle between 1 px steps along the drawn line (rad): jitter, kinks and
//            lumps; a smooth curve's is near 0, the true paths' own (their corners) is the floor.
export type P = [number, number];

function resample(p: readonly P[], step: number): P[] {
  if (!p.length) return [];
  const out: P[] = [p[0]!];
  let carry = 0;
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1]!, b = p[i]!, d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!d) continue;
    let s = step - carry;
    while (s <= d) {
      out.push([a[0] + ((b[0] - a[0]) * s) / d, a[1] + ((b[1] - a[1]) * s) / d]);
      s += step;
    }
    carry = d - (s - step);
  }
  return out;
}

/** Distance to a polyline, with its segments bucketed on a grid (the true paths are thousands of segments). */
function nearest(poly: readonly P[]): (x: number, y: number) => number {
  const G = 8;
  const cells = new Map<string, number[]>();
  for (let i = 0; i + 1 < poly.length; i++) {
    const [ax, ay] = poly[i]!, [bx, by] = poly[i + 1]!;
    for (let gx = Math.floor(Math.min(ax, bx) / G); gx <= Math.floor(Math.max(ax, bx) / G); gx++)
      for (let gy = Math.floor(Math.min(ay, by) / G); gy <= Math.floor(Math.max(ay, by) / G); gy++) {
        const k = `${gx},${gy}`;
        (cells.get(k) ?? cells.set(k, []).get(k)!).push(i);
      }
  }
  const seg = (i: number, x: number, y: number) => {
    const [ax, ay] = poly[i]!, [bx, by] = poly[i + 1]!;
    const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
    const t = l ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l)) : 0;
    return Math.hypot(ax + t * dx - x, ay + t * dy - y);
  };
  return (x, y) => {
    const gx = Math.floor(x / G), gy = Math.floor(y / G);
    for (let r = 1; r < 64; r++) {
      let m = Infinity;
      for (let i = gx - r; i <= gx + r; i++) for (let j = gy - r; j <= gy + r; j++) for (const s of cells.get(`${i},${j}`) ?? []) m = Math.min(m, seg(s, x, y));
      if (m <= (r - 0.5) * G) return m;
      if (r === 63) return m;
    }
    return Infinity;
  };
}

export function inkMetrics(drawn: readonly P[], truth: readonly P[]): { dev: number; max: number; wiggle: number } {
  const near = nearest(resample(truth, 1).concat([truth[truth.length - 1]!]));
  const r = resample(drawn, 0.5);
  let s = 0, max = 0;
  for (const [x, y] of r) {
    const d = near(x, y);
    s += d * d;
    max = Math.max(max, d);
  }
  const q = resample(drawn, 1);
  const turn: number[] = [];
  for (let i = 2; i < q.length; i++) {
    let d = Math.atan2(q[i]![1] - q[i - 1]![1], q[i]![0] - q[i - 1]![0]) - Math.atan2(q[i - 1]![1] - q[i - 2]![1], q[i - 1]![0] - q[i - 2]![0]);
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    turn.push(d);
  }
  let w = 0;
  for (let i = 1; i < turn.length; i++) w += (turn[i]! - turn[i - 1]!) ** 2;
  return { dev: Math.sqrt(s / Math.max(1, r.length)), max, wiggle: Math.sqrt(w / Math.max(1, turn.length - 1)) };
}
