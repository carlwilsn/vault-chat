// The shared context stream on the box: each vault's activity log under its
// own `.vault-chat/local/` (src/activityCore.ts has the shape, caps and the
// summary). Two routes (http.ts), scoped to the request's vault:
//   POST /api/v1/activity          {entry, imageBase64?, imageMime?} → {ok}
//   POST /api/v1/activity/image    {text, deictic?, exclude?}       → {image: {path, mime, dataBase64, caption} | null}
// Written by: the laptop (focus, Ctrl+K, Ctrl+L, captures), voice (voice.ts:
// what was said, what its tools did), the engine (Carl's messages as chat
// pointers, images pasted into a chat). Read through youLayer() only — the one
// "you" layer (src/activityCore.ts buildYouLayer) with the newest board and the
// notes changes read from their own files: pi's turns and Ctrl+K / Ctrl+L side
// threads get it through the pi extension (before_agent_start → a `vc-you`
// custom message in the session), voice calls youLayer for its session prompt.
// VC_ACTIVITY=0 turns writing off. Failure-silent (logged): nothing waits on it.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACTIVITY_DIR,
  ACTIVITY_LOG,
  ACTIVITY_LOG_OLD,
  CAPTURES_DIR,
  CONTEXT_IMAGE_MAX_BYTES,
  LOG_MAX_BYTES,
  DEFAULT_WINDOW_MS,
  activityLine,
  buildYouLayer,
  captureCaption,
  parseLog,
  pickContextImage,
  projectContextBlock,
  sanitizeEntry,
  type ActivityEntry,
  type BoardSnap,
  type NoteSnap,
  type YouLayer,
} from "../src/activityCore";
import { BOARDS_DIR, BOARD_FILE, OVERVIEW_FILE, VIEW_FILE, parseBoard, validSlug } from "../src/boardFormat";

export function activityOn(): boolean {
  return process.env.VC_ACTIVITY !== "0";
}

const abs = (vault: string, rel: string) => join(vault, ...rel.split("/"));

/** The local dir, kept out of git by a .gitignore of its own (and the engine's info/exclude). */
function ensureDir(vault: string): void {
  const dir = abs(vault, ACTIVITY_DIR);
  mkdirSync(dir, { recursive: true });
  const gi = join(dir, ".gitignore");
  if (!existsSync(gi)) writeFileSync(gi, "*\n");
}

/** Append one entry (sanitized, stamped with this clock). Never throws. */
export function appendActivity(vault: string, raw: unknown, now = Date.now()): ActivityEntry | null {
  if (!activityOn() || !vault) return null;
  try {
    const e = sanitizeEntry(raw, now);
    if (!e) return null;
    ensureDir(vault);
    const log = abs(vault, ACTIVITY_LOG);
    const line = JSON.stringify(e) + "\n";
    let size = 0;
    try {
      size = statSync(log).size;
    } catch {
      size = 0;
    }
    if (size + line.length > LOG_MAX_BYTES) renameSync(log, abs(vault, ACTIVITY_LOG_OLD));
    appendFileSync(log, line);
    return e;
  } catch (err) {
    console.warn(`[activity] append failed: ${(err as Error).message}`);
    return null;
  }
}

/** The entries of the last `windowMs` (both halves of the log). */
export function readActivity(vault: string, now = Date.now(), windowMs = DEFAULT_WINDOW_MS): ActivityEntry[] {
  const out: ActivityEntry[] = [];
  for (const rel of [ACTIVITY_LOG_OLD, ACTIVITY_LOG]) {
    try {
      out.push(...parseLog(readFileSync(abs(vault, rel), "utf8")));
    } catch {
      /* none yet */
    }
  }
  return out.filter((e) => e.ts > now - windowMs).sort((a, b) => a.ts - b.ts);
}

/** The newest board in the vault (by its own `updated`), or null. Reads only: never creates boards/. */
export function latestBoard(vault: string): BoardSnap | null {
  let best: BoardSnap | null = null;
  let names: string[] = [];
  try {
    names = readdirSync(join(vault, BOARDS_DIR));
  } catch {
    return null;
  }
  for (const slug of names) {
    if (!validSlug(slug)) continue;
    try {
      const b = parseBoard(readFileSync(join(vault, BOARDS_DIR, slug, BOARD_FILE), "utf8"));
      if (best && b.updated <= best.updated) continue;
      const overview = `${BOARDS_DIR}/${slug}/${OVERVIEW_FILE}`;
      const view = `${BOARDS_DIR}/${slug}/${VIEW_FILE}`;
      best = {
        slug,
        name: b.name,
        updated: b.updated,
        strokes: b.strokes.length,
        items: b.items.map((i) => ({ kind: String(i.kind ?? "item"), label: typeof i.label === "string" ? i.label.replace(/\s+/g, " ").trim().slice(0, 60) : "" })),
        overview: existsSync(join(vault, ...overview.split("/"))) ? overview : null,
        view: existsSync(join(vault, ...view.split("/"))) ? view : null,
      };
    } catch {
      /* not a board */
    }
  }
  return best;
}

/** Each note's latest state (.vault-chat/notes.jsonl: a note may have several lines; the newest last_updated wins). */
export function notesSnapshot(vault: string): NoteSnap[] {
  let raw = "";
  try {
    raw = readFileSync(join(vault, ".vault-chat", "notes.jsonl"), "utf8");
  } catch {
    return [];
  }
  const byId = new Map<string, any>();
  for (const l of raw.split("\n")) {
    if (!l.trim()) continue;
    try {
      const n = JSON.parse(l);
      if (!n || typeof n.id !== "string") continue;
      const prev = byId.get(n.id);
      if (!prev || String(n.last_updated ?? n.timestamp ?? "") >= String(prev.last_updated ?? prev.timestamp ?? "")) byId.set(n.id, n);
    } catch {
      /* a torn line */
    }
  }
  const out: NoteSnap[] = [];
  for (const n of byId.values()) {
    const ts = Date.parse(String(n.last_updated ?? n.timestamp ?? ""));
    if (!Number.isFinite(ts)) continue;
    const draft = typeof n.user_draft === "string" ? n.user_draft : "";
    const turns = Array.isArray(n.turns) ? n.turns.map((t: any) => String(t?.content ?? "")).join(" ") : "";
    out.push({ id: n.id, ts, created: n.last_updated === n.timestamp || !n.last_updated, status: String(n.status ?? "open"), text: draft || turns || String(n.title ?? "") });
  }
  return out;
}

/** How far back the layer looks for "the last thing he did". */
const YOU_LOOKBACK_MS = 7 * 24 * 60 * 60_000;

/**
 * The "you" layer (src/activityCore.ts buildYouLayer) for one reader — the one
 * function every surface reads it through: the pi extension's before_agent_start
 * (via the engine's `you` host handler), Ctrl+K / Ctrl+L side threads (the same
 * hook), and voice's session prompt. `since`: the `until` of the layer this
 * reader saw last (null: a new conversation, it gets the whole layer). `convId`:
 * the reader's own conversation. Never throws.
 */
export function youLayer(vault: string, o: { since?: number | null; convId?: string | null; now?: number } = {}): YouLayer {
  const now = o.now ?? Date.now();
  try {
    if (!activityOn()) return { text: "", until: now, items: 0 };
    return buildYouLayer(
      { entries: readActivity(vault, now, YOU_LOOKBACK_MS), board: latestBoard(vault), notes: notesSnapshot(vault) },
      { now, since: o.since ?? null, convId: o.convId ?? null },
    );
  } catch (err) {
    console.warn(`[activity] you layer failed: ${(err as Error).message}`);
    return { text: "", until: now, items: 0 };
  }
}

/**
 * RecentActivity (a read-only agent tool): the stream searched past the you layer's window — the last `hours`
 * (default 24, at most a week), the entries whose words contain every word of `query`, newest last, at most `limit`.
 * The you layer stays "what Carl just did"; anything older is found when he asks about it.
 */
export function searchActivity(vault: string, o: { query?: string; hours?: number; limit?: number; now?: number } = {}): string {
  const now = o.now ?? Date.now();
  const hours = Math.min(Math.max(Number(o.hours) || 24, 0.1), 168);
  const limit = Math.min(Math.max(Math.floor(Number(o.limit) || 30), 1), 100);
  const query = String(o.query ?? "").trim();
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = readActivity(vault, now, hours * 3_600_000).filter((e) => {
    const hay = [e.text, e.detail, e.path, e.where, e.project].filter(Boolean).join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  const span = `the last ${hours} h${query ? ` matching "${query}"` : ""}`;
  if (!hits.length) return `Nothing in ${span}.`;
  const shown = hits.slice(-limit);
  const more = hits.length - shown.length;
  return [`Carl's activity in ${span} (oldest first${more ? `; ${more} older left out` : ""}):`, ...shown.map((e) => `- ${activityLine(e, now)}`)].join("\n");
}

const MIME_EXT: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/webp": ".webp", "image/gif": ".gif" };
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const KEEP_CAPTURES = 100;

/** Store a captured image under .vault-chat/local/captures/; returns its vault-relative path. */
export function saveCapture(vault: string, dataBase64: string, mime = "image/png", now = Date.now()): string | null {
  if (!activityOn()) return null;
  try {
    const b64 = String(dataBase64 ?? "").replace(/^data:[^,]*,/, "");
    const buf = Buffer.from(b64, "base64");
    if (!buf.length || buf.length > MAX_CAPTURE_BYTES) return null;
    ensureDir(vault);
    const dir = abs(vault, CAPTURES_DIR);
    mkdirSync(dir, { recursive: true });
    const name = `${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}${MIME_EXT[mime] ?? ".png"}`;
    writeFileSync(join(dir, name), buf);
    // Keep the newest only.
    const all = readdirSync(dir).sort();
    for (const old of all.slice(0, Math.max(0, all.length - KEEP_CAPTURES))) {
      try {
        unlinkSync(join(dir, old));
      } catch {
        /* */
      }
    }
    return `${CAPTURES_DIR}/${name}`;
  } catch (err) {
    console.warn(`[activity] capture save failed: ${(err as Error).message}`);
    return null;
  }
}

/** The project's memory and rules for Ctrl+K / Ctrl+L, from the same files the chat reads. */
export async function projectContextFor(vault: string, project: string | null | undefined): Promise<string> {
  try {
    const { withVault, findProject, readProject, readGlobalRules } = await import("./context");
    return withVault(vault, () => {
      const info = project ? findProject(project) : null;
      const p = info ? readProject(info.slug) : null;
      return projectContextBlock(p, readGlobalRules());
    });
  } catch (err) {
    console.warn(`[activity] project context failed: ${(err as Error).message}`);
    return "";
  }
}

/** POST /api/v1/activity. */
export function activityPost(vault: string, b: any): { status: number; body: Record<string, unknown> } {
  if (!activityOn()) return { status: 200, body: { ok: true, off: true } };
  const raw = b?.entry && typeof b.entry === "object" ? { ...b.entry } : null;
  if (!raw) return { status: 400, body: { error: "entry is required" } };
  delete raw.image; // only a stored image is referenced
  if (typeof b.imageBase64 === "string" && b.imageBase64) {
    const rel = saveCapture(vault, b.imageBase64, typeof b.imageMime === "string" ? b.imageMime : "image/png");
    if (rel) raw.image = rel;
  }
  const e = appendActivity(vault, raw);
  return e ? { status: 200, body: { ok: true, image: e.image ?? null } } : { status: 400, body: { error: "not a valid entry" } };
}

export type ContextImage = { entry: ActivityEntry; abs: string; rel: string; mime: string; bytes: number; caption: string };

const EXT_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

/**
 * The capture a request is about (activityCore pickContextImage), when its file
 * is still there and small enough (CONTEXT_IMAGE_MAX_BYTES; captures are
 * downscaled on the laptop before they are stored). null otherwise. Never throws.
 */
export function contextImage(vault: string, text: string, o: { now?: number; deictic?: boolean; exclude?: Iterable<string> } = {}): ContextImage | null {
  try {
    const now = o.now ?? Date.now();
    const e = pickContextImage(readActivity(vault, now), text, { now, deictic: o.deictic, exclude: o.exclude });
    if (!e?.image || !e.image.startsWith(`${CAPTURES_DIR}/`) || e.image.includes("..")) return null;
    const abs = join(vault, ...e.image.split("/"));
    const bytes = statSync(abs).size;
    if (!bytes || bytes > CONTEXT_IMAGE_MAX_BYTES) return null;
    const mime = EXT_MIME[(e.image.split(".").pop() ?? "").toLowerCase()] ?? "image/png";
    return { entry: e, abs, rel: e.image, mime, bytes, caption: captureCaption(e, now) };
  } catch {
    return null;
  }
}

/** POST /api/v1/activity/image: the capture a Ctrl+K / Ctrl+L request is about, as data. */
export function activityImageRoute(vault: string, b: any): Record<string, unknown> {
  const text = typeof b?.text === "string" ? b.text : "";
  const exclude = Array.isArray(b?.exclude) ? b.exclude.filter((x: unknown) => typeof x === "string") : [];
  const img = contextImage(vault, text, { deictic: b?.deictic === true, exclude });
  if (!img) return { image: null };
  return { image: { path: img.rel, mime: img.mime, dataBase64: readFileSync(img.abs).toString("base64"), caption: img.caption } };
}
