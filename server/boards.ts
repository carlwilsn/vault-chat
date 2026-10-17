// The whiteboard's storage on the box (format: src/boardFormat.ts):
//   GET  /api/v1/boards                     → {boards:[{slug,name,updated,pages}]}, newest first
//   POST /api/v1/boards {name}              → {slug, board} — a blank board
//   GET  /api/v1/boards/<slug>              → the board
//   POST /api/v1/boards/<slug> {board, base, png?: {"1": base64, …}}
//                                           → {ok, rev, updated} | 409 {error, rev} when base ≠ the file's rev
//   GET  /api/v1/boards/<slug>/page-<n>.png → the page's snapshot
// Plain files in the vault's working copy: the box's sync cycle commits them,
// like any other vault write, and the laptop gets them on its next pull. Every
// path is a validated slug under `<vault>/boards/` (realpath-checked, so a
// symlink cannot lead out).
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { BOARDS_DIR, BOARD_FILE, blankBoard, parseBoard, serializeBoard, slugify, validSlug, type Board, type BoardSummary } from "../src/boardFormat";
import { HIDE_DEFAULTS_FILE, HIDE_FILE, hideOnce } from "../src/agentProjects";
import { renameRetry, writeAtomic } from "./atomic";

export type Out = { status: number; body: unknown; png?: Buffer };

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_CAP = 8 * 1024 * 1024;

const readOr = (p: string) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
};

/** Hide `boards` in the vault's hide list once, the first time the folder exists. */
const hiddenSeen = new Set<string>();
export function ensureBoardsHidden(vault: string): void {
  if (hiddenSeen.has(vault)) return;
  try {
    const next = hideOnce(BOARDS_DIR, readOr(join(vault, HIDE_FILE)), readOr(join(vault, HIDE_DEFAULTS_FILE)));
    if (next) {
      if (next.hide !== null) writeFileSync(join(vault, HIDE_FILE), next.hide);
      mkdirSync(dirname(join(vault, HIDE_DEFAULTS_FILE)), { recursive: true });
      writeFileSync(join(vault, HIDE_DEFAULTS_FILE), next.record);
    }
    hiddenSeen.add(vault);
  } catch (e) {
    console.warn(`[boards] ${vault}: ${(e as Error).message}`);
  }
}

/** `<vault>/boards` (created). */
function boardsRoot(vault: string): string {
  const root = join(vault, BOARDS_DIR);
  mkdirSync(root, { recursive: true });
  ensureBoardsHidden(vault);
  return root;
}

/** The folder of board `slug`, or null when the slug is invalid or the folder resolves outside `boards/`. */
export function boardDir(vault: string, slug: unknown, mustExist = true): string | null {
  if (!validSlug(slug)) return null;
  const root = boardsRoot(vault);
  const dir = join(root, slug);
  if (!existsSync(dir)) return mustExist ? null : dir;
  try {
    const realRoot = realpathSync(root);
    const real = realpathSync(dir);
    if (!real.startsWith(realRoot + sep) || !statSync(real).isDirectory()) return null;
  } catch {
    return null;
  }
  return dir;
}

function readBoard(dir: string): Board | null {
  try {
    return parseBoard(readFileSync(join(dir, BOARD_FILE), "utf8"));
  } catch {
    return null;
  }
}

export function listBoards(vault: string): BoardSummary[] {
  const root = boardsRoot(vault);
  const out: BoardSummary[] = [];
  for (const slug of readdirSync(root)) {
    const dir = boardDir(vault, slug);
    if (!dir) continue;
    const b = readBoard(dir);
    if (b) out.push({ slug, name: b.name, updated: b.updated, pages: b.pages.length });
  }
  return out.sort((a, b) => b.updated - a.updated || a.slug.localeCompare(b.slug));
}

export function createBoard(vault: string, rawName: unknown): Out {
  const name = typeof rawName === "string" && rawName.trim() ? rawName.trim().slice(0, 120) : "Untitled board";
  const base = slugify(name);
  const root = boardsRoot(vault);
  let slug = base;
  for (let i = 2; existsSync(join(root, slug)); i++) slug = `${base.slice(0, 58)}-${i}`;
  const dir = join(root, slug);
  mkdirSync(dir);
  const board = blankBoard(name);
  writeAtomic(join(dir, BOARD_FILE), serializeBoard(board));
  return { status: 200, body: { slug, board } };
}

export function getBoard(vault: string, slug: string): Out {
  const dir = boardDir(vault, slug);
  if (!dir) return { status: validSlug(slug) ? 404 : 400, body: { error: validSlug(slug) ? "no such board" : "invalid board name" } };
  const b = readBoard(dir);
  return b ? { status: 200, body: b } : { status: 500, body: { error: "board.json unreadable" } };
}

/** Saves of one board run one at a time. */
const chains = new Map<string, Promise<unknown>>();

export function saveBoard(vault: string, slug: string, body: any): Promise<Out> {
  const key = `${vault}\0${slug}`;
  const run = (chains.get(key) ?? Promise.resolve()).then(() => saveNow(vault, slug, body));
  chains.set(key, run.catch(() => {}));
  return run;
}

function saveNow(vault: string, slug: string, body: any): Out {
  const dir = boardDir(vault, slug);
  if (!dir) return { status: validSlug(slug) ? 404 : 400, body: { error: validSlug(slug) ? "no such board" : "invalid board name" } };
  const cur = readBoard(dir);
  if (cur && typeof body?.base === "number" && body.base !== cur.rev) return { status: 409, body: { error: "the board changed since you loaded it", rev: cur.rev } };
  let next: Board;
  try {
    next = parseBoard(body?.board);
  } catch (e) {
    return { status: 400, body: { error: `bad board: ${(e as Error).message}` } };
  }
  // Check every snapshot before writing anything.
  const pngs: [number, Buffer][] = [];
  const raw = body?.png && typeof body.png === "object" ? (body.png as Record<string, unknown>) : {};
  for (const [k, v] of Object.entries(raw)) {
    const n = Number(k);
    if (!Number.isInteger(n) || n < 1 || n > next.pages.length || typeof v !== "string") return { status: 400, body: { error: `bad page snapshot ${k.slice(0, 8)}` } };
    const buf = Buffer.from(v.replace(/^data:image\/png;base64,/, ""), "base64");
    if (buf.length > PNG_CAP || !buf.subarray(0, 8).equals(PNG_MAGIC)) return { status: 400, body: { error: `page ${n}: not a PNG` } };
    pngs.push([n, buf]);
  }
  next.rev = (cur?.rev ?? 0) + 1;
  next.updated = Date.now();
  next.created = cur?.created ?? next.created;
  for (const [n, buf] of pngs) {
    const f = join(dir, `page-${n}.png`);
    writeFileSync(`${f}.tmp`, buf);
    renameRetry(`${f}.tmp`, f);
  }
  writeAtomic(join(dir, BOARD_FILE), serializeBoard(next));
  // A page that is gone (undo of "new page") loses its snapshot.
  for (const f of readdirSync(dir)) {
    const m = /^page-(\d+)\.png$/.exec(f);
    if (m && Number(m[1]) > next.pages.length) rmSync(join(dir, f), { force: true });
  }
  return { status: 200, body: { ok: true, rev: next.rev, updated: next.updated } };
}

export function pagePng(vault: string, slug: string, n: number): Out {
  const dir = boardDir(vault, slug);
  if (!dir || !Number.isInteger(n) || n < 1 || n > 500) return { status: 404, body: { error: "not found" } };
  try {
    return { status: 200, body: null, png: readFileSync(join(dir, `page-${n}.png`)) };
  } catch {
    return { status: 404, body: { error: "no snapshot yet" } };
  }
}
