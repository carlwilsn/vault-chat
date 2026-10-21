// Where in a file: one address scheme per file type, shared by pi's Show tool
// (server/show.ts → the laptop's viewer, src/showOnLaptop.ts) and laptop
// voice's ScrollTo. Both put a request on the store (requestScrollAnchor); the
// viewer of that type reads it with decodeTarget, lands it with the functions
// below (the same matcher whichever tool asked) and answers through
// reportScroll (src/scrollTarget.ts) with the spot it landed on — or, for a
// target that is not there, the valid range or the nearest headings.
//
//   PDF       page (1-based) | text (the first page containing the phrase)
//   Markdown  line (source line) | heading (text or slug) | text
//   Code/text line, or line…endLine (the editor scrolls there and highlights the range)
//   HTML      anchor (an element id) | heading | text (hash-routed pages follow their nav)
//   Notebook  cell (1-based) | text (the first cell containing it)
//   Image     nothing (it just opens)
//   Board     label (an item's label, e.g. "Problem 3"; centred in the view)
//
// Older requests are plain strings ("page=4", "L12-L18", "#id", a heading or a
// phrase): they decode to `query` and every viewer keeps its old meaning for it.
import type { FileKind } from "./fileKind";

export type ViewTarget = {
  page?: number;
  line?: number;
  endLine?: number;
  heading?: string;
  text?: string;
  anchor?: string;
  cell?: number;
  label?: string;
  /** A free string from an older caller (voice ScrollTo, a note's anchor): id, heading, page or phrase. */
  query?: string;
};

export type TargetKey = Exclude<keyof ViewTarget, "query">;

/** Which keys each kind of file takes (nothing listed: it only opens). */
export const TARGET_KEYS: Record<FileKind | "board", TargetKey[]> = {
  pdf: ["page", "text"],
  markdown: ["line", "heading", "text"],
  code: ["line", "endLine"],
  html: ["anchor", "heading", "text"],
  notebook: ["cell", "text"],
  image: [],
  video: [],
  tex: [],
  unsupported: [],
  board: ["label"],
};

const KIND_NAME: Record<FileKind | "board", string> = {
  pdf: "a PDF",
  markdown: "a markdown file",
  code: "a code or text file",
  html: "an HTML page",
  notebook: "a notebook",
  image: "an image",
  video: "a video",
  tex: "a TeX file",
  unsupported: "this kind of file",
  board: "the board",
};

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, 300) : undefined);
const int = (v: unknown): number | undefined => {
  const n = typeof v === "string" && /^\s*\d+\s*$/.test(v) ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? Math.trunc(n) : undefined;
};

/** The target keys of a tool's arguments (anything else ignored), cleaned. */
export function targetOf(a: Record<string, unknown> | null | undefined): ViewTarget {
  const t: ViewTarget = {};
  if (!a) return t;
  const page = int(a.page);
  const line = int(a.line);
  const endLine = int(a.endLine);
  const cell = int(a.cell);
  if (page !== undefined) t.page = page;
  if (line !== undefined) t.line = line;
  if (endLine !== undefined) t.endLine = endLine;
  if (cell !== undefined) t.cell = cell;
  for (const k of ["heading", "text", "anchor", "label"] as const) {
    const v = str(a[k]);
    if (v !== undefined) t[k] = k === "anchor" ? v.replace(/^#/, "") : v;
  }
  return t;
}

export const hasTarget = (t: ViewTarget): boolean => Object.keys(t).length > 0;

/** Null when `t` fits a file of this kind; else what it takes instead (an error line for the agent). */
export function targetError(kind: FileKind | "board", t: ViewTarget, name = "it"): string | null {
  const keys = Object.keys(t).filter((k) => k !== "query") as TargetKey[];
  if (!keys.length) return null;
  const ok = TARGET_KEYS[kind];
  const bad = keys.filter((k) => !ok.includes(k));
  if (bad.length) {
    const takes = ok.length ? `takes ${ok.join(", ")}` : "has no places to go to (it just opens)";
    return `Error: ${name} is ${KIND_NAME[kind]}, which ${takes} — not ${bad.join(", ")}.`;
  }
  // One place at a time (endLine only with line).
  const main = keys.filter((k) => k !== "endLine");
  if (main.length > 1) return `Error: give one place in ${name}: ${main.join(" or ")}, not both.`;
  if (t.endLine !== undefined && t.line === undefined) return `Error: endLine needs line (the first line of the range).`;
  for (const k of ["page", "line", "cell"] as const) if (t[k] !== undefined && t[k]! < 1) return `Error: ${k} counts from 1.`;
  if (t.endLine !== undefined && t.line !== undefined && t.endLine < t.line) return `Error: endLine (${t.endLine}) is before line (${t.line}).`;
  return null;
}

// ---------------------------------------------------------------- the request string

const PREFIX = "@target:";

/** The one string the store carries to the viewer (requestScrollAnchor). */
export function encodeTarget(t: ViewTarget): string {
  return PREFIX + JSON.stringify(t);
}

/** A viewer's request back to a target: an encoded one, or an older free string. */
export function decodeTarget(anchor: string): ViewTarget {
  if (anchor.startsWith(PREFIX)) {
    try {
      const t = JSON.parse(anchor.slice(PREFIX.length));
      if (t && typeof t === "object") return targetOf(t) as ViewTarget;
    } catch {
      /* fall through: treat it as text */
    }
  }
  const q = anchor.trim();
  const lines = /^L(\d+)(?:\s*[-–]\s*L?(\d+))?$/i.exec(q);
  if (lines) return { line: Number(lines[1]), ...(lines[2] ? { endLine: Number(lines[2]) } : {}) };
  const cell = /^cell[=\s]*(\d+)$/i.exec(q);
  if (cell) return { cell: Number(cell[1]) };
  return { query: q };
}

/** How a landed spot reads in a result: "page 4", "line 42", "lines 12–18", "cell 7", "heading \"Bellman\"". */
export function spotLabel(t: ViewTarget): string {
  if (t.page !== undefined) return `page ${t.page}`;
  if (t.line !== undefined) return t.endLine !== undefined && t.endLine !== t.line ? `lines ${t.line}–${t.endLine}` : `line ${t.line}`;
  if (t.cell !== undefined) return `cell ${t.cell}`;
  if (t.heading) return `heading "${t.heading}"`;
  if (t.anchor) return `#${t.anchor}`;
  if (t.text) return `the text "${t.text}"`;
  if (t.label) return `"${t.label}"`;
  return t.query ?? "";
}

// ---------------------------------------------------------------- landing (pure: the viewers and the tests call these)

const base = (file: string) => file.split(/[\\/]/).pop() ?? file;
const squash = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** A PDF: the page to show, or the error. `pageTexts` (may be empty while loading) finds `text`. */
export function landPdf(t: ViewTarget, pages: number, pageTexts: string[], file: string): { page: number; said: string } | { error: string } {
  const name = base(file);
  let page = 0;
  let via = "";
  const phrase = t.text ?? (t.query && !/^(?:page\s*=?\s*)?\d+$/i.test(t.query) && !/page=\d+/.test(t.query) ? t.query : undefined);
  if (t.page !== undefined) page = t.page;
  else if (t.query && !phrase) page = Number((/page=(\d+)/.exec(t.query) ?? /(\d+)/.exec(t.query))![1]);
  else if (phrase) {
    page = pageTexts.findIndex((x) => squash(x).includes(squash(phrase))) + 1;
    if (!page) return { error: `Error: "${phrase}" does not appear in ${name} (${pages} pages). Pass a page number (1–${pages}), or a phrase that is in the PDF.` };
    via = ` (where "${phrase}" appears)`;
  } else return { error: `Error: no page given for ${name}.` };
  if (page < 1 || page > pages) return { error: `Error: ${name} has ${pages} page${pages === 1 ? "" : "s"}; there is no page ${page}. Pages are 1–${pages}.` };
  return { page, said: `Scrolled to page ${page} of ${pages}${via} in ${name}` };
}

/** Code or text (and markdown being edited): the line range to show, or the error with the valid range. */
export function landLines(t: ViewTarget, total: number, file: string): { line: number; endLine: number; said: string } | { error: string } {
  const name = base(file);
  if (t.line === undefined) return { error: `Error: ${name} takes line (and endLine for a range), 1–${total}.` };
  if (t.line < 1 || t.line > total) return { error: `Error: ${name} has ${total} line${total === 1 ? "" : "s"}; there is no line ${t.line}. Lines are 1–${total}.` };
  const end = Math.min(Math.max(t.endLine ?? t.line, t.line), total);
  return { line: t.line, endLine: end, said: `Scrolled to ${spotLabel({ line: t.line, endLine: end })} in ${name}` };
}

/** A notebook: the cell to show (1-based), or the error. `cells`: each cell's source. */
export function landCell(t: ViewTarget, cells: string[], file: string): { cell: number; said: string } | { error: string } {
  const name = base(file);
  const n = cells.length;
  if (t.cell !== undefined) {
    if (t.cell < 1 || t.cell > n) return { error: `Error: ${name} has ${n} cell${n === 1 ? "" : "s"}; there is no cell ${t.cell}. Cells are 1–${n}.` };
    return { cell: t.cell, said: `Scrolled to cell ${t.cell} of ${n} in ${name}` };
  }
  const phrase = t.text ?? t.query;
  if (!phrase) return { error: `Error: ${name} takes cell (1–${n}) or text.` };
  const i = cells.findIndex((c) => squash(c).includes(squash(phrase)));
  if (i < 0) return { error: `Error: "${phrase}" is in none of the ${n} cells of ${name}. Pass a cell number (1–${n}) or a phrase that is in it.` };
  return { cell: i + 1, said: `Scrolled to cell ${i + 1} of ${n} (where "${phrase}" appears) in ${name}` };
}

/**
 * Markdown in reading view: a source line becomes what to look for on the
 * rendered page — the heading on that line, else the text of the first
 * non-blank line at or after it, stripped of markdown. Null: past the end.
 */
export function mdLineQuery(source: string, line: number): { heading?: string; text?: string } | null {
  const ls = source.split(/\r?\n/);
  if (line < 1 || line > ls.length) return null;
  // Front matter is not on the page.
  let start = line - 1;
  if (ls[0]?.trim() === "---") {
    const end = ls.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (end > 0 && start <= end) start = end + 1;
  }
  for (let i = start; i < ls.length; i++) {
    const raw = ls[i]!;
    if (!raw.trim() || /^\s*(```|~~~|\$\$|---+\s*$|\|?\s*:?-{3,})/.test(raw)) continue;
    const h = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(raw);
    if (h) return { heading: plain(h[1]!) };
    // A few words are enough to find it: from the longest run of prose (math renders as other text in between).
    const runs = raw.split(/\$[^$]*\$|!?\[[^\]]*\]\([^)]*\)|`[^`]*`/).map((seg) => plain(seg).split(" ").filter(Boolean).slice(0, 6).join(" "));
    const probe = runs.reduce((a, b) => (b.length > a.length ? b : a), "");
    if (probe.length >= 3) return { text: probe };
  }
  return null;
}

function plain(s: string): string {
  return s
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "")
    .replace(/^\s*>\s?/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\$[^$]*\$/g, " ")
    .replace(/[*_`~]+/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
