// The @ picker's matching (src/plugins/composer/Composer.tsx): fuzzy over the vault's files and folders, the matched
// letters kept so the row can light them. Pure (no store), so test/harness/mentionMatch.test.ts runs it directly.
//
// Ranking: a match in the name beats one only in the path; contiguous beats scattered; word starts (after space - _ . /)
// beat mid-word letters; shorter names, shallower paths and recently opened files rise. Carl approved the look and
// this order from the mockup (school2 .vault-chat/local/pages/at-mentions.html, option A).
import type { FileEntry } from "../../store";

/** One picker row: the file, its vault-relative path and parent folder, and which letters matched. */
export type MentionHit = {
  path: string;
  name: string;
  rel: string;
  /** The parent folder, vault-relative ("" at the top). */
  dir: string;
  isDir: boolean;
  /** Matched letter positions in `name` and in `dir`. */
  ni: number[];
  di: number[];
};

/** The most rows the picker shows. */
export const MENTION_ROWS = 8;

const isBoundary = (s: string, j: number) => j === 0 || " -_./".includes(s[j - 1]!);

/** Fuzzy-match a lowercase query against a lowercase string: the substring when there is one (a start or a word start
 *  scores more), else the letters in order, preferring word starts. null when the letters aren't all there in order. */
export function fuzzy(q: string, s: string): { score: number; idx: number[] } | null {
  if (!q) return { score: 0, idx: [] };
  const at = s.indexOf(q);
  if (at >= 0) {
    return {
      score: 120 + q.length * 12 + (at === 0 ? 40 : isBoundary(s, at) ? 20 : 0) - s.length * 0.4,
      idx: Array.from({ length: q.length }, (_, k) => k + at),
    };
  }
  const run = (preferStarts: boolean) => {
    const idx: number[] = [];
    let from = 0;
    let score = 0;
    let prev = -2;
    for (const ch of q) {
      let j = s.indexOf(ch, from);
      if (j < 0) return null;
      if (preferStarts && j !== prev + 1 && !isBoundary(s, j)) {
        for (let k = s.indexOf(ch, j + 1); k >= 0; k = s.indexOf(ch, k + 1)) {
          if (isBoundary(s, k)) {
            j = k;
            break;
          }
        }
      }
      score += j === prev + 1 ? 9 : isBoundary(s, j) ? 7 : 1;
      idx.push(j);
      prev = j;
      from = j + 1;
    }
    return { score: score - s.length * 0.4, idx };
  };
  return run(true) ?? run(false);
}

type Item = { path: string; name: string; rel: string; dir: string; isDir: boolean; depth: number };

function itemOf(f: FileEntry, vaultPath: string): Item {
  const rel = f.path.startsWith(vaultPath + "/") ? f.path.slice(vaultPath.length + 1) : f.path;
  const cut = rel.lastIndexOf("/");
  return { path: f.path, name: f.name, rel, dir: cut < 0 ? "" : rel.slice(0, cut), isDir: f.is_dir, depth: rel.split("/").length };
}

/** Score one item, or null when it doesn't match. A query with a "/" matches the path only. */
function score(it: Item, q: string, recent: Set<string>): (MentionHit & { score: number }) | null {
  let r: { score: number; ni: number[]; di: number[] } | null = null;
  if (!q.includes("/")) {
    const m = fuzzy(q, it.name.toLowerCase());
    if (m) r = { score: m.score + 60, ni: m.idx, di: [] };
  }
  if (!r && it.dir) {
    const cut = it.dir.length + 1;
    const m = fuzzy(q, it.rel.toLowerCase());
    if (m) r = { score: m.score, ni: m.idx.filter((i) => i >= cut).map((i) => i - cut), di: m.idx.filter((i) => i < cut - 1) };
  }
  if (!r) return null;
  r.score -= it.depth * 2;
  if (recent.has(it.path)) r.score += 25;
  return { path: it.path, name: it.name, rel: it.rel, dir: it.dir, isDir: it.isDir, ni: r.ni, di: r.di, score: r.score };
}

/** The picker's rows for a query (at most MENTION_ROWS). `recent` is absolute paths, most recent first: an empty query
 *  lists them, topped up with the vault's top level in tree order; a typed one boosts them. Hidden entries never show. */
export function rankMentions(files: FileEntry[], vaultPath: string | null, query: string, recent: string[] = []): MentionHit[] {
  if (!vaultPath) return [];
  const q = query.toLowerCase();
  if (!q) {
    const byPath = new Map<string, FileEntry>();
    for (const f of files) if (!f.hidden) byPath.set(f.path, f);
    const out: MentionHit[] = [];
    const seen = new Set<string>();
    const take = (f: FileEntry | undefined) => {
      if (!f || seen.has(f.path) || out.length >= MENTION_ROWS) return;
      seen.add(f.path);
      const { depth: _d, ...it } = itemOf(f, vaultPath);
      out.push({ ...it, ni: [], di: [] });
    };
    for (const p of recent) take(byPath.get(p));
    for (const f of files) if (!f.hidden && itemOf(f, vaultPath).depth === 1) take(f);
    return out;
  }
  const boost = new Set(recent);
  const hits: Array<MentionHit & { score: number }> = [];
  for (const f of files) {
    if (f.hidden) continue;
    const h = score(itemOf(f, vaultPath), q, boost);
    if (h) hits.push(h);
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, MENTION_ROWS).map(({ score: _s, ...h }) => h);
}

/** The / menu's rows (and any list matched by name alone): the items whose name has the query's letters in order,
 *  best first (ties keep the list's order), with the matched letters; an empty query keeps the list as it is. */
export function rankNames<T>(items: T[], nameOf: (t: T) => string, query: string, max = MENTION_ROWS): Array<{ item: T; idx: number[] }> {
  const q = query.toLowerCase();
  if (!q) return items.slice(0, max).map((item) => ({ item, idx: [] }));
  const hits: Array<{ item: T; idx: number[]; score: number }> = [];
  for (const item of items) {
    const m = fuzzy(q, nameOf(item).toLowerCase());
    if (m) hits.push({ item, idx: m.idx, score: m.score });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, max).map(({ item, idx }) => ({ item, idx }));
}
