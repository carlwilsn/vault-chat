// The whiteboard's file format — one definition the box server
// (server/boards.ts), the board app (board/) and the tests share.
//
// A board is a folder in the vault: `boards/<slug>/board.json` (the ink) and
// `boards/<slug>/page-N.png` (a rendered snapshot of page N, 1-based, written
// by the board app on save — what the agent will look at). `boards/` is hidden
// once in the vault's hide list, like `agent-projects/` (src/agentProjects.ts).
//
// Pages are vertical, each PAGE_W × PAGE_H board units (US Letter), and a
// stroke's points are page-local. A stroke is stored as one flat array
// `[x, y, p, x, y, p, …]`: x and y to 0.1 unit, pressure 0..1 to 0.01 — compact
// in JSON and still readable.

export const BOARDS_DIR = "boards";
export const BOARD_FILE = "board.json";
export const BOARD_VERSION = 1;
/** Page size in board units (8.5 × 11 in; one unit ≈ 0.22 mm). */
export const PAGE_W = 1000;
export const PAGE_H = 1294;

export type Tool = "pen" | "hl";

export type Stroke = {
  id: string;
  tool: Tool;
  color: string;
  /** Nominal width in board units. */
  w: number;
  /** [x, y, pressure] triples, flat. */
  pts: number[];
};

export type Page = { strokes: Stroke[] };

/** Reserved for later milestones (the agent placing text, LaTeX, images, PDF pages). */
export type Item = Record<string, unknown> & { id: string; kind: string; page: number };

export type Board = {
  v: number;
  name: string;
  created: number;
  updated: number;
  /** Bumped by every save; a save names the rev it was based on. */
  rev: number;
  page: { w: number; h: number };
  pages: Page[];
  items: Item[];
};

export type BoardSummary = { slug: string; name: string; updated: number; pages: number };

export function blankBoard(name: string, now = Date.now()): Board {
  return { v: BOARD_VERSION, name, created: now, updated: now, rev: 0, page: { w: PAGE_W, h: PAGE_H }, pages: [{ strokes: [] }], items: [] };
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Points ({x, y, p}) → the stored flat array, rounded. */
export function packPoints(points: ReadonlyArray<{ x: number; y: number; p: number }>): number[] {
  const out: number[] = new Array(points.length * 3);
  for (let i = 0; i < points.length; i++) {
    const q = points[i]!;
    out[i * 3] = r1(q.x);
    out[i * 3 + 1] = r1(q.y);
    out[i * 3 + 2] = r2(Math.min(1, Math.max(0, q.p)));
  }
  return out;
}

/** The stored flat array → [x, y, pressure] tuples (perfect-freehand's input). */
export function unpackPoints(pts: ReadonlyArray<number>): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = 0; i + 2 < pts.length; i += 3) out.push([pts[i]!, pts[i + 1]!, pts[i + 2]!]);
  return out;
}

export function serializeBoard(b: Board): string {
  // One stroke per line: diffs stay small and the file stays greppable.
  const head = { ...b, pages: undefined };
  const pages = b.pages.map((p) => `{"strokes":[${p.strokes.map((s) => "\n" + JSON.stringify(s)).join(",")}${p.strokes.length ? "\n" : ""}]}`);
  const h = JSON.stringify(head);
  return `${h.slice(0, -1)},"pages":[${pages.join(",\n")}]}\n`;
}

const isNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const COLOR = /^#[0-9a-fA-F]{3,8}$/;

/** Parse and check a board (a file, or a save's body). Throws a short reason. */
export function parseBoard(input: unknown): Board {
  const b = (typeof input === "string" ? JSON.parse(input) : input) as Partial<Board> | null;
  if (!b || typeof b !== "object") throw new Error("not a board");
  if (!Array.isArray(b.pages) || b.pages.length < 1 || b.pages.length > 500) throw new Error("pages: 1–500 required");
  const pages: Page[] = b.pages.map((p, i) => {
    if (!p || !Array.isArray(p.strokes)) throw new Error(`page ${i + 1}: strokes missing`);
    return {
      strokes: p.strokes.map((s, j) => {
        if (!s || typeof s.id !== "string" || !s.id || s.id.length > 64) throw new Error(`page ${i + 1} stroke ${j}: id`);
        if (s.tool !== "pen" && s.tool !== "hl") throw new Error(`page ${i + 1} stroke ${j}: tool`);
        if (typeof s.color !== "string" || !COLOR.test(s.color)) throw new Error(`page ${i + 1} stroke ${j}: color`);
        if (!isNum(s.w) || s.w <= 0 || s.w > 200) throw new Error(`page ${i + 1} stroke ${j}: width`);
        if (!Array.isArray(s.pts) || s.pts.length % 3 !== 0 || !s.pts.every(isNum)) throw new Error(`page ${i + 1} stroke ${j}: points`);
        return { id: s.id, tool: s.tool, color: s.color, w: s.w, pts: s.pts };
      }),
    };
  });
  const name = typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 120) : "Untitled board";
  return {
    v: BOARD_VERSION,
    name,
    created: isNum(b.created) ? b.created : Date.now(),
    updated: isNum(b.updated) ? b.updated : Date.now(),
    rev: isNum(b.rev) ? b.rev : 0,
    page: { w: isNum(b.page?.w) ? b.page!.w : PAGE_W, h: isNum(b.page?.h) ? b.page!.h : PAGE_H },
    pages,
    items: Array.isArray(b.items) ? (b.items as Item[]) : [],
  };
}

/** A board folder's name: lowercase letters, digits and dashes. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const validSlug = (s: unknown): s is string => typeof s === "string" && SLUG_RE.test(s);

/** A slug from a board's name (not yet made unique). */
export function slugify(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return s || "board";
}
