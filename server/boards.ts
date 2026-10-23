// The whiteboard's storage on the box (format: src/boardFormat.ts):
//   GET  /api/v1/boards                       → {boards:[{slug,name,updated,strokes,items}]}, newest first
//   POST /api/v1/boards {name}                → {slug, board} — a blank board
//   GET  /api/v1/boards/<slug>                → the board (a version-1 board arrives migrated)
//   POST /api/v1/boards/<slug> {board, base, overview?: base64 PNG, history?}
//                                             → {ok, rev, updated} | 409 {error, rev} when base ≠ the file's rev
//                                               (history: the app's undo/redo, written to history.json stamped
//                                               with the new rev; a bad or oversized one is dropped, not an error)
//   GET  /api/v1/boards/<slug>/history        → {v, rev, undo, redo} (empty, rev -1, when there is none)
//   POST /api/v1/boards/<slug>/rename {name}  → {ok, name}
//   POST /api/v1/boards/<slug>/delete         → {ok} — moved to boards/.trash/<slug>-<time>, never removed
//   GET  /api/v1/boards/<slug>/overview.png   → the snapshot of the whole board
//   POST /api/v1/boards/<slug>/assets {data: base64 PNG/JPEG}
//                                             → {src: "assets/<name>", w, h} — a file for an item
//   GET  /api/v1/boards/<slug>/assets/<name>  → that file
//   POST /api/v1/boards/<slug>/assets/copy {from, srcs: ["assets/<name>", …]}
//                                             → {ok, copied} — another board's files, for items pasted from it
//                                               (the same names: an asset's name never changes meaning)
// Plain files in the vault's working copy: the box's sync cycle commits them,
// like any other vault write, and the laptop gets them on its next pull. Every
// path is a validated slug under `<vault>/boards/` (realpath-checked, so a
// symlink cannot lead out).
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { ASSETS_DIR, ASSET_RE, BOARDS_DIR, BOARD_VERSION, BOARD_FILE, HISTORY_BYTES, HISTORY_FILE, OVERVIEW_FILE, VIEW_FILE, blankBoard, imageSize, parseBoard, parseHistory, serializeBoard, serializeHistory, slugify, validSlug, type Board, type BoardSummary } from "../src/boardFormat";
import { HIDE_DEFAULTS_FILE, HIDE_FILE, hideOnce } from "../src/agentProjects";
import { renameRetry, writeAtomic } from "./atomic";

export type Out = { status: number; body: unknown; file?: Buffer; mime?: string; headers?: Record<string, string> };

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_CAP = 8 * 1024 * 1024;
const ASSET_CAP = 12 * 1024 * 1024;

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
  // A board's undo history and the picture of the part in view are this machine's working state, rewritten on
  // every save: never committed.
  const gi = join(root, ".gitignore");
  const want = [`*/${HISTORY_FILE}`, `*/${VIEW_FILE}`];
  const have = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  const missing = want.filter((l) => !have.split(/\r?\n/).includes(l));
  if (missing.length) writeFileSync(gi, (have && !have.endsWith("\n") ? have + "\n" : have) + missing.join("\n") + "\n");
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
    if (b) out.push({ slug, name: b.name, updated: b.updated, strokes: b.strokes.length, items: b.items.length });
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
  if (!b) return { status: 500, body: { error: "board.json unreadable" } };
  // `fresh`: the file is version 1 (it arrives migrated) or has no overview yet: the app saves it once.
  const raw = readOr(join(dir, BOARD_FILE));
  const fresh = !raw.startsWith(`{"v":${BOARD_VERSION},`) || !existsSync(join(dir, OVERVIEW_FILE));
  return { status: 200, body: fresh ? { ...b, fresh: true } : b };
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
  let overview: Buffer | null = null;
  if (typeof body?.overview === "string") {
    overview = Buffer.from(body.overview.replace(/^data:image\/png;base64,/, ""), "base64");
    if (overview.length > PNG_CAP || !overview.subarray(0, 8).equals(PNG_MAGIC)) return { status: 400, body: { error: "overview: not a PNG" } };
  }
  let view: Buffer | null = null;
  if (typeof body?.view === "string") {
    view = Buffer.from(body.view.replace(/^data:image\/png;base64,/, ""), "base64");
    if (view.length > PNG_CAP || !view.subarray(0, 8).equals(PNG_MAGIC)) return { status: 400, body: { error: "view: not a PNG" } };
  }
  for (const it of next.items) {
    if (it.src && !existsSync(join(dir, it.src))) return { status: 400, body: { error: `item ${it.id}: ${it.src} is not in the board folder` } };
    if (typeof it.snap === "string" && (!ASSET_RE.test(it.snap) || it.snap.includes("..") || !existsSync(join(dir, it.snap)))) return { status: 400, body: { error: `item ${it.id}: its snapshot is not in the board folder` } };
  }
  next.rev = (cur?.rev ?? 0) + 1;
  next.updated = Date.now();
  next.created = cur?.created ?? next.created;
  for (const [file, png] of [[OVERVIEW_FILE, overview], [VIEW_FILE, view]] as const) {
    if (!png) continue;
    const f = join(dir, file);
    writeFileSync(`${f}.tmp`, png);
    renameRetry(`${f}.tmp`, f);
  }
  writeAtomic(join(dir, BOARD_FILE), serializeBoard(next));
  if (body?.history !== undefined) {
    try {
      const h = parseHistory(body.history);
      h.rev = next.rev;
      const text = serializeHistory(h);
      if (text.length <= HISTORY_BYTES) writeAtomic(join(dir, HISTORY_FILE), text);
      else rmSync(join(dir, HISTORY_FILE), { force: true });
    } catch (e) {
      console.warn(`[boards] ${slug}: history dropped: ${(e as Error).message}`);
      rmSync(join(dir, HISTORY_FILE), { force: true });
    }
  }
  // Version 1's page snapshots are gone with its pages.
  for (const f of readdirSync(dir)) if (/^page-\d+\.png$/.test(f)) rmSync(join(dir, f), { force: true });
  return { status: 200, body: { ok: true, rev: next.rev, updated: next.updated } };
}

/** GET …/history: the undo and redo the app saved with the board (rev -1 and empty when none, or unreadable). */
export function getHistory(vault: string, slug: string): Out {
  const dir = boardDir(vault, slug);
  if (!dir) return { status: validSlug(slug) ? 404 : 400, body: { error: "no such board" } };
  try {
    return { status: 200, body: parseHistory(readFileSync(join(dir, HISTORY_FILE), "utf8")) };
  } catch {
    return { status: 200, body: { v: 1, rev: -1, undo: [], redo: [] } };
  }
}

/** A board's new name (its folder keeps its slug). */
export function renameBoard(vault: string, slug: string, body: any): Out {
  const dir = boardDir(vault, slug);
  if (!dir) return { status: validSlug(slug) ? 404 : 400, body: { error: "no such board" } };
  const name = typeof body?.name === "string" ? body.name.trim().slice(0, 120) : "";
  if (!name) return { status: 400, body: { error: "a name is required" } };
  const b = readBoard(dir);
  if (!b) return { status: 500, body: { error: "board.json unreadable" } };
  b.name = name;
  writeAtomic(join(dir, BOARD_FILE), serializeBoard(b));
  return { status: 200, body: { ok: true, name } };
}

/** Delete = move the folder to boards/.trash/ (the vault's history keeps it too); nothing is removed. */
export function deleteBoard(vault: string, slug: string): Out {
  const dir = boardDir(vault, slug);
  if (!dir) return { status: validSlug(slug) ? 404 : 400, body: { error: "no such board" } };
  const trash = join(vault, BOARDS_DIR, ".trash");
  mkdirSync(trash, { recursive: true });
  renameRetry(dir, join(trash, `${slug}-${Date.now().toString(36)}`));
  return { status: 200, body: { ok: true } };
}

/** A file for an item: a PNG or JPEG, named by its content's random id. */
export function addAsset(vault: string, slug: string, body: any): Out {
  const dir = boardDir(vault, slug);
  if (!dir) return { status: validSlug(slug) ? 404 : 400, body: { error: validSlug(slug) ? "no such board" : "invalid board name" } };
  if (typeof body?.data !== "string") return { status: 400, body: { error: "data (base64) required" } };
  const buf = Buffer.from(body.data.replace(/^data:image\/[a-z]+;base64,/, ""), "base64");
  if (buf.length > ASSET_CAP) return { status: 413, body: { error: "image too large" } };
  const size = imageSize(buf);
  if (!size) return { status: 400, body: { error: "not a PNG or JPEG" } };
  const name = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}.${size.type === "png" ? "png" : "jpg"}`;
  mkdirSync(join(dir, ASSETS_DIR), { recursive: true });
  const f = join(dir, ASSETS_DIR, name);
  writeFileSync(`${f}.tmp`, buf);
  renameRetry(`${f}.tmp`, f);
  return { status: 200, body: { src: `${ASSETS_DIR}/${name}`, w: size.w, h: size.h } };
}

/** Copy assets from board `from` into board `slug` (the board's clipboard pasting items across boards). */
export function copyAssets(vault: string, slug: string, body: any): Out {
  const dir = boardDir(vault, slug);
  if (!dir) return { status: validSlug(slug) ? 404 : 400, body: { error: validSlug(slug) ? "no such board" : "invalid board name" } };
  const src = boardDir(vault, body?.from);
  if (!src) return { status: 404, body: { error: "no such board to copy from" } };
  const srcs: unknown = body?.srcs;
  if (!Array.isArray(srcs) || srcs.length > MAX_COPY || !srcs.every((x) => typeof x === "string" && ASSET_RE.test(x) && !x.includes(".."))) return { status: 400, body: { error: "srcs: asset paths" } };
  let copied = 0;
  mkdirSync(join(dir, ASSETS_DIR), { recursive: true });
  for (const a of new Set(srcs as string[])) {
    const to = join(dir, a);
    if (existsSync(to)) continue;
    let buf: Buffer;
    try {
      buf = readFileSync(join(src, a));
    } catch {
      return { status: 404, body: { error: `not found: ${a}` } };
    }
    writeFileSync(`${to}.tmp`, buf);
    renameRetry(`${to}.tmp`, to);
    copied++;
  }
  return { status: 200, body: { ok: true, copied } };
}
const MAX_COPY = 400;

export function assetFile(vault: string, slug: string, name: string): Out {
  const dir = boardDir(vault, slug);
  const src = `${ASSETS_DIR}/${name}`;
  if (!dir || !ASSET_RE.test(src) || name.includes("..")) return { status: 404, body: { error: "not found" } };
  try {
    // Images, and the inbox's kinds (a PDF, typeset math, a widget's bundle).
    // Nothing runs on the box's origin: an SVG or a PDF is sandboxed by CSP,
    // the math and the bundle are plain text the app puts in place itself.
    const mime = ASSET_MIME[/\.[a-z0-9]+$/i.exec(name)?.[0]?.toLowerCase() ?? ""];
    if (!mime) return { status: 404, body: { error: "not found" } };
    // An asset never changes under its name (a new upload, or a name from its content): the browser keeps it,
    // so a board opens on what it already has (a PDF page's PNG, its PDF) without asking again.
    return { status: 200, body: null, file: readFileSync(join(dir, ASSETS_DIR, name)), mime, headers: { ...INERT_HEADERS, "Cache-Control": "private, max-age=31536000, immutable" } };
  } catch {
    return { status: 404, body: { error: "not found" } };
  }
}

const ASSET_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".html": "text/plain; charset=utf-8",
  ".js": "text/plain; charset=utf-8",
};
const INERT_HEADERS = { "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox", "X-Content-Type-Options": "nosniff" };

export function overviewPng(vault: string, slug: string): Out {
  const dir = boardDir(vault, slug);
  if (!dir) return { status: 404, body: { error: "not found" } };
  try {
    return { status: 200, body: null, file: readFileSync(join(dir, OVERVIEW_FILE)), mime: "image/png" };
  } catch {
    return { status: 404, body: { error: "no snapshot yet" } };
  }
}

/** A board's pictures for the agent's eyes: what it attaches to a tool result (base64, PNG). */
export type BoardImage = { data: string; mimeType: string };

const LOOK_FILLER = new Set(["my", "the", "a", "his", "board", "whiteboard", "white", "boards", "just", "on", "ipad"]);
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !LOOK_FILLER.has(w));

/** The board `query` names (its slug, its name, or words of its name: "physics", "the Physics whiteboard"), or — no
 *  query, or only "my whiteboard" — the one changed last. Null when nothing matches. */
export function findBoard(boards: BoardSummary[], query: unknown): BoardSummary | null {
  const q = typeof query === "string" ? query.trim() : "";
  if (!q) return boards[0] ?? null;
  const lower = q.toLowerCase();
  const exact = boards.find((b) => b.slug === q || b.name.toLowerCase() === lower);
  if (exact) return exact;
  const want = words(q);
  if (!want.length) return boards[0] ?? null;
  // Every word he said is in its name or slug; else any of them; the newest such board (boards come newest first).
  const all = boards.find((b) => {
    const have = new Set([...words(b.name), ...words(b.slug)]);
    return want.every((w) => have.has(w));
  });
  if (all) return all;
  return boards.find((b) => want.some((w) => `${b.name} ${b.slug}`.toLowerCase().includes(w))) ?? null;
}

/** BoardLook: one of Carl's boards as its files have it — on a screen or not — with the picture of the part he had
 *  in view on the iPad at its last save (view.png) and of the whole board (overview.png). */
export function lookBoard(vault: string, query?: unknown): { ok: boolean; text: string; images: BoardImage[] } {
  let boards: BoardSummary[] = [];
  try {
    boards = listBoards(vault);
  } catch {
    boards = [];
  }
  if (!boards.length) return { ok: true, text: "Carl has no whiteboard boards yet.", images: [] };
  const names = (except?: string) =>
    boards
      .filter((b) => b.slug !== except)
      .slice(0, 12)
      .map((b) => `"${b.name}"`)
      .join(", ");
  const b = findBoard(boards, query);
  if (!b) return { ok: false, text: `No board matches "${String(query).slice(0, 80)}". His boards, newest first: ${names()}.`, images: [] };
  const dir = boardDir(vault, b.slug);
  const images: BoardImage[] = [];
  const attached: string[] = [];
  for (const [file, what] of [
    [VIEW_FILE, "the part he had in view on the iPad"],
    [OVERVIEW_FILE, "the whole board"],
  ] as const) {
    try {
      if (!dir) break;
      const png = readFileSync(join(dir, file));
      if (!png.length || png.length > PNG_CAP || !png.subarray(0, 8).equals(PNG_MAGIC)) continue;
      images.push({ data: png.toString("base64"), mimeType: "image/png" });
      attached.push(`${what} (${BOARDS_DIR}/${b.slug}/${file})`);
    } catch {
      /* not saved yet */
    }
  }
  const saved = new Date(b.updated).toISOString().replace(/\.\d+Z$/, "Z");
  const named = typeof query === "string" && words(query).length > 0;
  const others = names(b.slug);
  return {
    ok: true,
    text: [
      `Board "${b.name}"${named ? "" : " (his most recently changed board)"}, ${BOARDS_DIR}/${b.slug}/, last saved ${saved}: ${b.strokes} stroke${b.strokes === 1 ? "" : "s"} of his handwriting, ${b.items} item${b.items === 1 ? "" : "s"}.`,
      attached.length
        ? `Attached, as saved (whether or not the board is on a screen now): ${attached.join("; ")}. Look at them.`
        : "It has no saved picture yet (the iPad writes one when the board is saved).",
      others ? `His other boards: ${others}.` : "",
    ]
      .filter(Boolean)
      .join(" "),
    images,
  };
}
