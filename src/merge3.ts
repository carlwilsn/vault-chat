// A line-based three-way merge, for an open file that changed on disk while its editor had typing not saved yet
// (src/liveReload.ts): `base` is the text the typing started from, `ours` the editor's buffer, `theirs` the disk.
// Changes that touch different lines merge; changes to the same or adjacent lines are a conflict (null), as git's.

type Hunk = { s: number; e: number; lines: string[] };

const lines = (t: string) => (t ? t.split(/(?<=\n)/) : []);

/** The base → other edits, as base line ranges [s, e) and what replaces them; null when too big to diff here. */
function hunks(base: string[], other: string[]): Hunk[] | null {
  let p = 0;
  while (p < base.length && p < other.length && base[p] === other[p]) p++;
  let q = 0;
  while (q < base.length - p && q < other.length - p && base[base.length - 1 - q] === other[other.length - 1 - q]) q++;
  const a = base.slice(p, base.length - q);
  const b = other.slice(p, other.length - q);
  if (!a.length && !b.length) return [];
  if ((a.length + 1) * (b.length + 1) > 4_000_000) return null;
  // Longest common subsequence of the middle (lengths from the end), then walk it into hunks.
  const w = b.length + 1;
  const L = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      L[i * w + j] = a[i] === b[j] ? L[(i + 1) * w + j + 1]! + 1 : Math.max(L[(i + 1) * w + j]!, L[i * w + j + 1]!);
  const out: Hunk[] = [];
  let i = 0, j = 0, hs = -1, hj = 0;
  const close = () => {
    if (hs >= 0) out.push({ s: p + hs, e: p + i, lines: b.slice(hj, j) });
    hs = -1;
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      close();
      i++, j++;
      continue;
    }
    if (hs < 0) (hs = i), (hj = j);
    if (j < b.length && (i === a.length || L[i * w + j + 1]! >= L[(i + 1) * w + j]!)) j++;
    else i++;
  }
  close();
  return out;
}

/** The merged text, or null when the two sides changed the same (or adjacent) lines differently. */
export function merge3(base: string, ours: string, theirs: string): string | null {
  if (ours === theirs || theirs === base) return ours;
  if (ours === base) return theirs;
  const B = lines(base);
  const o = hunks(B, lines(ours));
  const t = hunks(B, lines(theirs));
  if (!o || !t) return null;
  const all = [...o.map((h) => ({ ...h, side: 0 })), ...t.map((h) => ({ ...h, side: 1 }))].sort((x, y) => x.s - y.s || x.e - y.e);
  const out: string[] = [];
  let at = 0;
  for (let k = 0; k < all.length; ) {
    // A group: hunks whose base ranges overlap or touch.
    const group = [all[k]!];
    let end = all[k]!.e;
    for (k++; k < all.length && all[k]!.s <= end; k++) {
      group.push(all[k]!);
      end = Math.max(end, all[k]!.e);
    }
    const start = group[0]!.s;
    const sides = new Set(group.map((h) => h.side));
    let text: string[];
    if (sides.size === 1) {
      text = [];
      let c = start;
      for (const h of group) {
        text.push(...B.slice(c, h.s), ...h.lines);
        c = h.e;
      }
      text.push(...B.slice(c, end));
    } else {
      // Both sides changed this stretch: fine only when they made the very same change.
      const one = (side: number) => {
        const r: string[] = [];
        let c = start;
        for (const h of group) if (h.side === side) r.push(...B.slice(c, h.s), ...h.lines), (c = h.e);
        r.push(...B.slice(c, end));
        return r.join("");
      };
      const mine = one(0);
      if (mine !== one(1)) return null;
      text = [mine];
    }
    out.push(...B.slice(at, start), ...text);
    at = end;
  }
  out.push(...B.slice(at));
  return out.join("");
}
