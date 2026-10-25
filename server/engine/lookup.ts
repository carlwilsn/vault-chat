// Lookup: find something in Carl's notes and read it, in one call. A voice turn that chained find → grep → read spent
// three model round trips (1–2 s each) on one question ("read me the first theorem in the workbook": 6.6 s of silence
// for 31 ms of tool time). This takes his words, picks the files whose names and text match them best, and returns the
// best-matching passages with their surrounding lines — so the model can answer from one result.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SKIP_DIRS = new Set([".git", ".vault-chat", "node_modules", "dist", "build", ".next", ".cache", "site", "__pycache__", ".venv", "venv"]);
const TEXT = /\.(md|markdown|txt|tex|org)$/i;
const MAX_FILES = 6000;
const MAX_BYTES = 1_000_000;
const STOP = new Set(
  "the a an and or of in on at to for from with about my me is are was were be what which who how does do did it its this that these those there any anything where i you your read find show tell say exactly bit part".split(" "),
);

let listCache: { root: string; at: number; files: string[] } | null = null;

function textFiles(root: string, now: number): string[] {
  if (listCache && listCache.root === root && now - listCache.at < 30_000) return listCache.files;
  const out: string[] = [];
  const walk = (dir: string) => {
    if (out.length >= MAX_FILES) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (out.length >= MAX_FILES) return;
      const p = join(dir, n);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(n) && !n.startsWith(".")) walk(p);
      } else if (TEXT.test(n) && st.size <= MAX_BYTES) out.push(p);
    }
  };
  walk(root);
  listCache = { root, at: now, files: out };
  return out;
}

/** His words as search terms: lower case, numbers kept whole ("1.2"), spelled numbers as digits, filler dropped. */
export function terms(query: string): string[] {
  const spelled: Record<string, string> = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10" };
  let q = query.toLowerCase().replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten) point (one|two|three|four|five|six|seven|eight|nine|ten)\b/g, (_, a, b) => `${spelled[a]}.${spelled[b]}`);
  q = q.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/g, (w) => spelled[w]!);
  const words = q.match(/[\p{L}\p{N}]+(?:[.'][\p{L}\p{N}]+)*/gu) ?? [];
  return [...new Set(words.filter((w) => (w.length > 2 || /\d/.test(w)) && !STOP.has(w)))];
}

type Hit = { line: number; score: number };

/** One call: the files that best match `query` (optionally only paths containing `file`), and their best passages. */
export function lookup(root: string, a: { query?: unknown; file?: unknown; lines?: unknown }, now = Date.now()): string {
  const q = String(a.query ?? "").trim();
  const ts = terms(q);
  if (!ts.length) return "Lookup needs a few words to look for.";
  const want = String(a.file ?? "").trim().toLowerCase();
  const span = Math.max(4, Math.min(40, Number(a.lines) || 14));
  const ranked: { rel: string; score: number; lines: string[]; hits: Hit[] }[] = [];
  for (const f of textFiles(root, now)) {
    const rel = relative(root, f).split(sep).join("/");
    const lrel = rel.toLowerCase();
    if (want && !lrel.includes(want)) continue;
    const pathScore = ts.filter((t) => lrel.includes(t)).length;
    let body: string;
    try {
      body = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    const low = body.toLowerCase();
    if (!pathScore && !ts.some((t) => low.includes(t))) continue;
    const lines = body.split(/\r?\n/);
    const hits: Hit[] = [];
    lines.forEach((l, i) => {
      const ll = l.toLowerCase();
      let s = 0;
      for (const t of ts) if (/\d/.test(t) ? new RegExp(`(^|[^\\d.])${t.replace(/\./g, "\\.")}($|[^\\d])`).test(ll) : ll.includes(t)) s += /\d/.test(t) ? 2 : 1;
      if (s && /^\s*#/.test(l)) s += 1;
      if (s) hits.push({ line: i, score: s });
    });
    if (!hits.length && !pathScore) continue;
    const best = hits.reduce((m, h) => Math.max(m, h.score), 0);
    ranked.push({ rel, score: pathScore * 3 + best * 2 + Math.min(5, hits.filter((h) => h.score >= 2).length), lines, hits });
  }
  if (!ranked.length) return `Nothing in the vault matches "${q}".`;
  ranked.sort((x, y) => y.score - x.score || x.rel.length - y.rel.length);
  const out: string[] = [];
  let budget = 6000;
  for (const r of ranked.slice(0, 3)) {
    if (budget <= 0) break;
    const top = [...r.hits].sort((x, y) => y.score - x.score || x.line - y.line).slice(0, 3).sort((x, y) => x.line - y.line);
    const spans: [number, number][] = [];
    for (const h of top.length ? top : [{ line: 0, score: 0 }]) {
      const s = Math.max(0, h.line - 2), e = Math.min(r.lines.length, h.line + span);
      const last = spans[spans.length - 1];
      if (last && s <= last[1]) last[1] = Math.max(last[1], e);
      else spans.push([s, e]);
    }
    const parts = spans.map(([s, e]) => `--- ${r.rel}:${s + 1}-${e}\n${r.lines.slice(s, e).join("\n")}`);
    const text = parts.join("\n").slice(0, budget);
    budget -= text.length;
    out.push(text);
  }
  const more = ranked.length > 3 ? `\n(also matching: ${ranked.slice(3, 8).map((r) => r.rel).join(", ")})` : "";
  return out.join("\n\n") + more;
}
