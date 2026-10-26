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

let listCache: { root: string; at: number; files: string[]; pdfs: string[] } | null = null;

function textFiles(root: string, now: number): string[] {
  return listed(root, now).files;
}

function listed(root: string, now: number): { files: string[]; pdfs: string[] } {
  if (listCache && listCache.root === root && now - listCache.at < 30_000) return listCache;
  const out: string[] = [];
  const pdfs: string[] = [];
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
      else if (PDF.test(n) && st.size <= MAX_PDF_BYTES && pdfs.length < MAX_PDFS) pdfs.push(p);
    }
  };
  walk(root);
  listCache = { root, at: now, files: out, pdfs };
  return listCache;
}

// ---- PDFs: most of his course material (lecture notes, homework) is PDF. Their text is indexed once per file version
// (path + size + mtime), in memory; a call searches what is indexed and indexes more within a time budget, the rest
// continues in the background — so "find the Bellman-Ford lecture" finds lecture6_typed.pdf instead of "nothing".
const PDF = /\.pdf$/i;
const MAX_PDF_BYTES = 40_000_000;
const MAX_PDFS = 1500;
const PDF_BUDGET_MS = 4_000;
const pdfText = new Map<string, { key: string; text: string }>();
let indexing: Promise<void> | null = null;

async function pdfToText(path: string): Promise<string> {
  const pdfjs: any = await import("pdfjs-dist");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), verbosity: 0 }).promise;
  try {
    const out: string[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const tc = await page.getTextContent();
      const lines: string[] = [];
      let cur = "";
      let lastY: number | null = null;
      for (const item of tc.items as { str?: string; hasEOL?: boolean; transform?: number[] }[]) {
        if (typeof item.str !== "string") continue;
        const y = item.transform?.[5];
        if (lastY !== null && y !== undefined && Math.abs(y - lastY) > 2) {
          if (cur.trim()) lines.push(cur);
          cur = "";
        }
        cur += item.str;
        if (item.hasEOL) {
          if (cur.trim()) lines.push(cur);
          cur = "";
        }
        if (y !== undefined) lastY = y;
      }
      if (cur.trim()) lines.push(cur);
      out.push(`[page ${n}]`, ...lines);
      page.cleanup();
    }
    return out.join("\n");
  } finally {
    doc.destroy();
  }
}

function pdfKey(path: string): string | null {
  try {
    const st = statSync(path);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return null;
  }
}

/** Index PDFs not indexed yet (the most likely first: their path matches the words), until `budgetMs`. */
async function indexPdfs(pdfs: string[], ts: string[], budgetMs: number): Promise<void> {
  const t0 = Date.now();
  const todo = pdfs.filter((p) => {
    const k = pdfKey(p);
    return k && pdfText.get(p)?.key !== k;
  });
  todo.sort((a, b) => ts.filter((t) => b.toLowerCase().includes(t)).length - ts.filter((t) => a.toLowerCase().includes(t)).length);
  for (const p of todo) {
    if (Date.now() - t0 >= budgetMs) break;
    const key = pdfKey(p);
    if (!key) continue;
    try {
      pdfText.set(p, { key, text: await pdfToText(p) });
    } catch {
      pdfText.set(p, { key, text: "" });
    }
  }
}

/** Lookup over his notes and his PDFs (lectures, homework): what lookup() does, with each PDF's text as a document
 *  (its "[page N]" lines in the passage say where). PDFs not indexed within the budget keep indexing in the background. */
export async function lookupAll(root: string, a: { query?: unknown; file?: unknown; lines?: unknown }, now = Date.now(), budgetMs = PDF_BUDGET_MS): Promise<string> {
  const ts = terms(String(a.query ?? ""));
  const { pdfs } = listed(root, now);
  if (ts.length && pdfs.length) {
    if (indexing) await Promise.race([indexing, new Promise((r) => setTimeout(r, budgetMs))]);
    else await indexPdfs(pdfs, ts, budgetMs);
    const left = pdfs.filter((p) => pdfText.get(p)?.key !== pdfKey(p));
    if (left.length && !indexing) indexing = indexPdfs(left, ts, 10 * 60_000).finally(() => (indexing = null));
  }
  const docs = pdfs.map((p) => ({ path: p, text: pdfText.get(p)?.text ?? "" })).filter((d) => d.text);
  return lookup(root, a, now, docs);
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
export function lookup(root: string, a: { query?: unknown; file?: unknown; lines?: unknown }, now = Date.now(), extra: { path: string; text: string }[] = []): string {
  const q = String(a.query ?? "").trim();
  const ts = terms(q);
  if (!ts.length) return "Lookup needs a few words to look for.";
  const want = String(a.file ?? "").trim().toLowerCase();
  const span = Math.max(4, Math.min(40, Number(a.lines) || 14));
  const ranked: { rel: string; score: number; lines: string[]; hits: Hit[] }[] = [];
  const texts = new Map(extra.map((d) => [d.path, d.text]));
  for (const f of [...textFiles(root, now), ...extra.map((d) => d.path)]) {
    const rel = relative(root, f).split(sep).join("/");
    const lrel = rel.toLowerCase();
    if (want && !lrel.includes(want)) continue;
    const pathScore = ts.filter((t) => lrel.includes(t)).length;
    let body: string;
    try {
      body = texts.get(f) ?? readFileSync(f, "utf8");
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
    // A PDF's passage says its page (the "[page N]" line at or before it).
    const pageAt = (i: number) => {
      for (let k = i; k >= 0; k--) {
        const m = /^\[page (\d+)\]$/.exec(r.lines[k]!);
        if (m) return ` (page ${m[1]})`;
      }
      return "";
    };
    const pdf = PDF.test(r.rel);
    const parts = spans.map(([s, e]) => `--- ${r.rel}:${s + 1}-${e}${pdf ? pageAt(Math.min(e - 1, s + 2)) : ""}\n${r.lines.slice(s, e).join("\n")}`);
    const text = parts.join("\n").slice(0, budget);
    budget -= text.length;
    out.push(text);
  }
  const more = ranked.length > 3 ? `\n(also matching: ${ranked.slice(3, 8).map((r) => r.rel).join(", ")})` : "";
  return out.join("\n\n") + more;
}
