// The whiteboard's file format — one definition the box server
// (server/boards.ts), the board app (board/) and the tests share.
//
// A board is a folder in the vault: `boards/<slug>/board.json` (the ink and
// the items), `boards/<slug>/assets/…` (the files items show) and
// `boards/<slug>/overview.png` (a rendered snapshot of everything on the board,
// written by the board app on save — what the agent looks at). `boards/` is
// hidden once in the vault's hide list, like `agent-projects/`
// (src/agentProjects.ts).
//
// A board is ONE infinite canvas: no pages. Coordinates are canvas units
// (1000 units ≈ the width of a sheet of paper; the app opens at about that
// width). A stroke is uniform width (no pressure) and stored as one flat array
// `[x, y, x, y, …]` to 0.1 unit — compact in JSON and still readable. Items are
// positioned boxes the agent (or an insert) places: images, PDF pages,
// typeset LaTeX. Ink belongs to the writer, items to whoever placed them: the
// erasers never touch items.
//
// Version 1 (milestone 1) had vertical pages of 1000 × 1294 and
// `pts: [x, y, pressure, …]` page-local; it loads as its pages stacked
// vertically into canvas coordinates, pressure dropped.

export const BOARDS_DIR = "boards";
export const BOARD_FILE = "board.json";
export const OVERVIEW_FILE = "overview.png";
export const ASSETS_DIR = "assets";
export const BOARD_VERSION = 2;
/** Version 1's page, and the gap between its pages (for the migration). */
export const V1_PAGE = { w: 1000, h: 1294, gap: 28 };

export type Tool = "pen" | "hl";
export type Grid = "plain" | "dots" | "grid";
/** A pen stroke's line: solid (the default, not stored), dashed or dotted. */
export type LineStyle = "dash" | "dot";

export type Stroke = {
  id: string;
  tool: Tool;
  color: string;
  /** Width in canvas units (uniform: no pressure). */
  w: number;
  /** [x, y] pairs, flat, canvas units. */
  xy: number[];
  /** Dashed or dotted (dash lengths scale with `w`, in canvas units); absent = solid. */
  style?: LineStyle;
};

/** A placed box. `src` (for image-like kinds) is a file in the board folder, `assets/<name>`. */
export type Item = Record<string, unknown> & { id: string; kind: string; x: number; y: number; w: number; h: number; src?: string };

export type Board = {
  v: number;
  name: string;
  created: number;
  updated: number;
  /** Bumped by every save; a save names the rev it was based on. */
  rev: number;
  /** The canvas's background. */
  grid: Grid;
  strokes: Stroke[];
  items: Item[];
};

export type BoardSummary = { slug: string; name: string; updated: number; strokes: number; items: number };

export function blankBoard(name: string, now = Date.now()): Board {
  return { v: BOARD_VERSION, name, created: now, updated: now, rev: 0, grid: "grid", strokes: [], items: [] };
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Points → the stored flat array, rounded to 0.1 unit. */
export function packXY(points: ReadonlyArray<{ x: number; y: number }>): number[] {
  const out: number[] = new Array(points.length * 2);
  for (let i = 0; i < points.length; i++) {
    out[i * 2] = r1(points[i]!.x);
    out[i * 2 + 1] = r1(points[i]!.y);
  }
  return out;
}

export function serializeBoard(b: Board): string {
  // One stroke (and one item) per line: diffs stay small and the file stays greppable.
  const head = JSON.stringify({ ...b, strokes: undefined, items: undefined });
  const list = (a: unknown[]) => `[${a.map((s) => "\n" + JSON.stringify(s)).join(",")}${a.length ? "\n" : ""}]`;
  return `${head.slice(0, -1)},"items":${list(b.items)},"strokes":${list(b.strokes)}}\n`;
}

const isNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const COLOR = /^#[0-9a-fA-F]{3,8}$/;
/** An item's file: inside the board folder's assets/, one plain name. */
export const ASSET_RE = /^assets\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
export const MAX_STROKES = 200_000;
export const MAX_ITEMS = 2000;

function checkStroke(s: any, where: string, dx = 0, dy = 0): Stroke {
  if (!s || typeof s.id !== "string" || !s.id || s.id.length > 64) throw new Error(`${where}: id`);
  if (s.tool !== "pen" && s.tool !== "hl") throw new Error(`${where}: tool`);
  if (typeof s.color !== "string" || !COLOR.test(s.color)) throw new Error(`${where}: color`);
  if (!isNum(s.w) || s.w <= 0 || s.w > 200) throw new Error(`${where}: width`);
  let xy: number[];
  if (Array.isArray(s.xy)) {
    if (s.xy.length % 2 !== 0 || !s.xy.every(isNum)) throw new Error(`${where}: points`);
    xy = dx || dy ? s.xy.map((v: number, k: number) => r1(v + (k % 2 ? dy : dx))) : s.xy;
  } else if (Array.isArray(s.pts)) {
    // Version 1: [x, y, pressure] triples, page-local.
    if (s.pts.length % 3 !== 0 || !s.pts.every(isNum)) throw new Error(`${where}: points`);
    xy = [];
    for (let k = 0; k + 2 < s.pts.length; k += 3) xy.push(r1(s.pts[k] + dx), r1(s.pts[k + 1] + dy));
  } else throw new Error(`${where}: points`);
  if (!xy.length) throw new Error(`${where}: points`);
  if (s.style !== undefined && s.style !== "dash" && s.style !== "dot") throw new Error(`${where}: style`);
  return { id: s.id, tool: s.tool, color: s.color, w: s.w, xy, ...(s.style ? { style: s.style as LineStyle } : {}) };
}

function checkItem(it: any, where: string): Item {
  if (!it || typeof it !== "object" || typeof it.id !== "string" || !it.id || it.id.length > 64) throw new Error(`${where}: id`);
  if (typeof it.kind !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(it.kind)) throw new Error(`${where}: kind`);
  for (const k of ["x", "y", "w", "h"]) if (!isNum(it[k])) throw new Error(`${where}: ${k}`);
  if (it.w <= 0 || it.h <= 0) throw new Error(`${where}: size`);
  if (it.src !== undefined && (typeof it.src !== "string" || !ASSET_RE.test(it.src) || it.src.includes(".."))) throw new Error(`${where}: src`);
  return { ...it };
}

/** Parse and check a board (a file, or a save's body). Version 1 boards migrate. Throws a short reason. */
export function parseBoard(input: unknown): Board {
  const b = (typeof input === "string" ? JSON.parse(input) : input) as any;
  if (!b || typeof b !== "object") throw new Error("not a board");
  let strokes: Stroke[];
  let items: Item[] = [];
  if (Array.isArray(b.strokes)) {
    if (b.strokes.length > MAX_STROKES) throw new Error("too many strokes");
    strokes = b.strokes.map((s: unknown, j: number) => checkStroke(s, `stroke ${j}`));
    if (b.items !== undefined && !Array.isArray(b.items)) throw new Error("items: a list");
    items = (b.items ?? []).map((it: unknown, j: number) => checkItem(it, `item ${j}`));
    if (items.length > MAX_ITEMS) throw new Error("too many items");
  } else if (Array.isArray(b.pages)) {
    // Version 1: pages stacked top to bottom.
    if (b.pages.length < 1 || b.pages.length > 500) throw new Error("pages: 1–500 required");
    const ph = isNum(b.page?.h) ? b.page.h : V1_PAGE.h;
    strokes = [];
    b.pages.forEach((p: any, i: number) => {
      if (!p || !Array.isArray(p.strokes)) throw new Error(`page ${i + 1}: strokes missing`);
      p.strokes.forEach((s: unknown, j: number) => strokes.push(checkStroke(s, `page ${i + 1} stroke ${j}`, 0, i * (ph + V1_PAGE.gap))));
    });
    // Version 1 never placed items (the field was reserved).
  } else throw new Error("strokes missing");
  const name = typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 120) : "Untitled board";
  return {
    v: BOARD_VERSION,
    name,
    created: isNum(b.created) ? b.created : Date.now(),
    updated: isNum(b.updated) ? b.updated : Date.now(),
    rev: isNum(b.rev) ? b.rev : 0,
    // A board that never chose a background has the grid (Carl, 2026-10-18); a saved choice stays.
    grid: b.grid === "dots" || b.grid === "plain" ? b.grid : "grid",
    strokes,
    items,
  };
}

/** The bounds of everything on the board (canvas units), or null when it is empty. */
export function contentBounds(b: Pick<Board, "strokes" | "items">): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of b.strokes) {
    const r = s.w / 2;
    for (let k = 0; k + 1 < s.xy.length; k += 2) {
      const x = s.xy[k]!, y = s.xy[k + 1]!;
      if (x - r < x0) x0 = x - r;
      if (x + r > x1) x1 = x + r;
      if (y - r < y0) y0 = y - r;
      if (y + r > y1) y1 = y + r;
    }
  }
  for (const it of b.items) {
    x0 = Math.min(x0, it.x);
    y0 = Math.min(y0, it.y);
    x1 = Math.max(x1, it.x + it.w);
    y1 = Math.max(y1, it.y + it.h);
  }
  return x0 <= x1 ? { x0, y0, x1, y1 } : null;
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

/** The EXIF Orientation (1–8) in an APP1 segment's payload at `at` (`n` bytes), or 0. */
function exifOrientation(buf: Uint8Array, at: number, n: number): number {
  if (n < 14 || at + n > buf.length) return 0;
  if (String.fromCharCode(...buf.subarray(at, at + 4)) !== "Exif" || buf[at + 4] !== 0 || buf[at + 5] !== 0) return 0;
  const t = at + 6, end = at + n;
  const le = buf[t] === 0x49 && buf[t + 1] === 0x49;
  if (!le && !(buf[t] === 0x4d && buf[t + 1] === 0x4d)) return 0;
  const u16 = (o: number) => (o + 2 > end ? -1 : le ? buf[o]! | (buf[o + 1]! << 8) : (buf[o]! << 8) | buf[o + 1]!);
  const u32 = (o: number) => (o + 4 > end ? -1 : le ? (buf[o]! | (buf[o + 1]! << 8) | (buf[o + 2]! << 16)) + buf[o + 3]! * 0x1000000 : buf[o]! * 0x1000000 + ((buf[o + 1]! << 16) | (buf[o + 2]! << 8) | buf[o + 3]!));
  const ifd = u32(t + 4);
  if (ifd < 8) return 0;
  const count = u16(t + ifd);
  for (let k = 0; k < count && k < 200; k++) {
    const e = t + ifd + 2 + k * 12;
    if (u16(e) === 0x0112) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : 0;
    }
  }
  return 0;
}

/** A PNG's or JPEG's size as shown (a JPEG's EXIF orientation applied), or null. */
export function imageSize(buf: Uint8Array): { type: "png" | "jpeg"; w: number; h: number } | null {
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const w = dv.getUint32(16), h = dv.getUint32(20);
    return w && h ? { type: "png", w, h } : null;
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    // EXIF orientation 5–8 (a phone photo stored sideways): shown, and drawn, with its sides swapped.
    let turned = false;
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const m = buf[i + 1]!;
      if (m === 0xff) {
        i += 1; // fill byte
        continue;
      }
      if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) {
        i += 2;
        continue;
      }
      const len = (buf[i + 2]! << 8) | buf[i + 3]!;
      if (m === 0xe1) turned = exifOrientation(buf, i + 4, len - 2) >= 5 || turned;
      // SOF0–SOF15, not DHT (C4), JPG (C8) or DAC (CC).
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        const h = (buf[i + 5]! << 8) | buf[i + 6]!, w = (buf[i + 7]! << 8) | buf[i + 8]!;
        return w && h ? { type: "jpeg", w: turned ? h : w, h: turned ? w : h } : null;
      }
      i += 2 + len;
    }
  }
  return null;
}
