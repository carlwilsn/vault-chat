// Line diff (Myers, O(ND)) and git-style unified patches for the in-memory git.

export type Op = { t: " " | "-" | "+"; line: string };

export function diffLines(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const v = new Map<number, number>();
  v.set(1, 0);
  const trace: Map<number, number>[] = [];
  outer: for (let d = 0; d <= max; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1))) x = v.get(k + 1) ?? 0;
      else x = (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v.set(k, x);
      if (x >= n && y >= m) break outer;
    }
    if (d > 4000) break; // pathological input — fall back below
  }
  // Backtrack.
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vv = trace[d];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && (vv.get(k - 1) ?? -1) < (vv.get(k + 1) ?? -1))) prevK = k + 1;
    else prevK = k - 1;
    const prevX = vv.get(prevK) ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ t: " ", line: a[x - 1] });
      x--;
      y--;
    }
    if (d === 0) break;
    if (x === prevX) {
      ops.push({ t: "+", line: b[y - 1] });
      y--;
    } else {
      ops.push({ t: "-", line: a[x - 1] });
      x--;
    }
  }
  while (x > 0 && y > 0 && a[x - 1] === b[y - 1]) {
    ops.push({ t: " ", line: a[x - 1] });
    x--;
    y--;
  }
  while (x > 0) ops.push({ t: "-", line: a[--x] });
  while (y > 0) ops.push({ t: "+", line: b[--y] });
  return ops.reverse();
}

function split(s: string): string[] {
  if (!s) return [];
  const l = s.split("\n");
  if (l[l.length - 1] === "") l.pop();
  return l;
}

export function stat(a: string | null, b: string | null): { additions: number; deletions: number } {
  const ops = diffLines(split(a ?? ""), split(b ?? ""));
  return { additions: ops.filter((o) => o.t === "+").length, deletions: ops.filter((o) => o.t === "-").length };
}

/** `git diff`-shaped patch for one path (a = old side, b = new side). */
export function unifiedPatch(path: string, a: string | null, b: string | null, ctx = 3): string {
  if ((a ?? "") === (b ?? "") && (a === null) === (b === null)) return "";
  const ops = diffLines(split(a ?? ""), split(b ?? ""));
  const head = [
    `diff --git a/${path} b/${path}`,
    a === null ? "new file mode 100644" : b === null ? "deleted file mode 100644" : "index 0000000..0000000 100644",
    `--- ${a === null ? "/dev/null" : "a/" + path}`,
    `+++ ${b === null ? "/dev/null" : "b/" + path}`,
  ];
  const hunks: string[] = [];
  let i = 0;
  let aLine = 1;
  let bLine = 1;
  // Precompute line numbers at each op index.
  const pos: Array<{ a: number; b: number }> = [];
  for (const o of ops) {
    pos.push({ a: aLine, b: bLine });
    if (o.t !== "+") aLine++;
    if (o.t !== "-") bLine++;
  }
  while (i < ops.length) {
    if (ops[i].t === " ") {
      i++;
      continue;
    }
    let start = Math.max(0, i - ctx);
    let end = i;
    // extend while changes are within 2*ctx of each other
    let j = i;
    while (j < ops.length) {
      if (ops[j].t !== " ") {
        end = j;
        j++;
        continue;
      }
      let k = j;
      while (k < ops.length && ops[k].t === " ") k++;
      if (k < ops.length && k - j <= ctx * 2) {
        j = k;
        continue;
      }
      break;
    }
    const stop = Math.min(ops.length, end + 1 + ctx);
    const slice = ops.slice(start, stop);
    const aStart = pos[start].a;
    const bStart = pos[start].b;
    const aCount = slice.filter((o) => o.t !== "+").length;
    const bCount = slice.filter((o) => o.t !== "-").length;
    hunks.push(`@@ -${aCount ? aStart : aStart - 1},${aCount} +${bCount ? bStart : bStart - 1},${bCount} @@`);
    for (const o of slice) hunks.push(o.t + o.line);
    i = stop;
  }
  return [...head, ...hunks].join("\n") + "\n";
}
