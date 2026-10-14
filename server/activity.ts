// The shared context stream on the box: each vault's activity log under its
// own `.vault-chat/local/` (src/activityCore.ts has the shape, caps and the
// summary). Two routes (http.ts), scoped to the request's vault:
//   POST /api/v1/activity          {entry, imageBase64?, imageMime?} → {ok}
//   GET  /api/v1/activity/summary  ?project=&since=&exclude=       → {activity, project}
// Written by: the laptop (focus, Ctrl+K, Ctrl+L, captures), voice (voice.ts:
// what was said, what its tools did), the engine (chat pointers). Read by: the
// engine's per-turn prefix, the voice session prompt, Ctrl+K / Ctrl+L.
// VC_ACTIVITY=0 turns writing off. Failure-silent (logged): nothing waits on it.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACTIVITY_DIR,
  ACTIVITY_LOG,
  ACTIVITY_LOG_OLD,
  CAPTURES_DIR,
  LOG_MAX_BYTES,
  DEFAULT_WINDOW_MS,
  parseLog,
  projectContextBlock,
  sanitizeEntry,
  summarizeActivity,
  type ActivityEntry,
  type SummaryOptions,
} from "../src/activityCore";

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

export function activitySummary(vault: string, o: Partial<SummaryOptions> = {}): string {
  const now = o.now ?? Date.now();
  try {
    return summarizeActivity(readActivity(vault, now, o.windowMs), { ...o, now });
  } catch (err) {
    console.warn(`[activity] summary failed: ${(err as Error).message}`);
    return "";
  }
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

/** GET /api/v1/activity/summary. */
export async function activitySummaryRoute(vault: string, q: (k: string) => string): Promise<Record<string, unknown>> {
  const project = q("project") || null;
  const since = Number(q("since")) || undefined;
  return {
    activity: activitySummary(vault, { project, since, excludeConv: q("exclude") || null }),
    project: await projectContextFor(vault, project),
  };
}
