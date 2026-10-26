// Files Carl attaches from outside the vault (a PDF from Downloads, dropped or
// picked on his laptop): their bytes come to the box with the message, the way
// Claude Code reads an attached file, and are kept in a hidden area of the
// vault (.vault-chat/attachments/<date>/<name>, out of git) — never his own
// folders. The agent is given the real path on the box; a path on his laptop
// never reaches the prompt (the box cannot open it).
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";

export const ATTACH_DIR = ".vault-chat/attachments";
/** One file's cap (the request carries it as base64: ~4/3 of this). */
export const ATTACH_MAX_BYTES = 25 * 1024 * 1024;
/** The upload route's body limit: one file a little over the cap, as base64 in JSON (so it is told why, not cut off). */
export const ATTACH_BODY_LIMIT = Math.ceil((ATTACH_MAX_BYTES * 4) / 3) * 1.25;

export function mb(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** A file name safe on every OS (no separators, no control characters, not empty). */
function safeName(raw: string): string {
  const n = basename(String(raw ?? "").replace(/\\/g, "/"))
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);
  return n || "attachment";
}

function ensureDir(vault: string, day: string): string {
  const root = join(vault, ...ATTACH_DIR.split("/"));
  mkdirSync(join(root, day), { recursive: true });
  const gi = join(root, ".gitignore");
  if (!existsSync(gi)) writeFileSync(gi, "*\n");
  return join(root, day);
}

/** POST /api/v2/attachment {name, dataBase64} → {ok, path, abs, name, size}: saved under the attachments area. */
export function saveAttachment(vault: string, b: { name?: unknown; dataBase64?: unknown }, now = new Date()): { ok: true; path: string; abs: string; name: string; size: number } | { ok: false; error: string; status: number } {
  const name = safeName(String(b?.name ?? ""));
  const b64 = String(b?.dataBase64 ?? "").replace(/^data:[^,]*,/, "");
  const buf = Buffer.from(b64, "base64");
  if (!buf.length) return { ok: false, status: 400, error: `${name} arrived empty` };
  if (buf.length > ATTACH_MAX_BYTES) return { ok: false, status: 413, error: `${name} is ${mb(buf.length)}; an attachment can be at most ${mb(ATTACH_MAX_BYTES)}` };
  const day = now.toISOString().slice(0, 10);
  const dir = ensureDir(vault, day);
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  let file = name;
  for (let i = 1; existsSync(join(dir, file)); i++) file = `${stem} (${i})${ext}`;
  writeFileSync(join(dir, file), buf);
  const path = `${ATTACH_DIR}/${day}/${file}`;
  return { ok: true, path, abs: join(dir, file), name: file, size: buf.length };
}

/** An attachment a message names (its vault-relative path from the upload), checked: inside the area, and there. */
export function attachmentAt(vault: string, rel: unknown): { path: string; abs: string; name: string; size: number } | null {
  const p = String(rel ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!p.startsWith(ATTACH_DIR + "/") || p.split("/").includes("..")) return null;
  const abs = join(vault, ...p.split("/"));
  try {
    const st = statSync(abs);
    return st.isFile() ? { path: p, abs, name: basename(abs), size: st.size } : null;
  } catch {
    return null;
  }
}

/** What the agent is told about the files a message carries: each one's path on the box, and how to read it. */
export function attachmentsNote(files: { abs: string; name: string; size: number }[]): string {
  if (!files.length) return "";
  const how = (n: string) => {
    const e = extname(n).toLowerCase();
    if (e === ".pdf") return "a PDF: read it with PdfRead; PdfPages to see its pages";
    if ([".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(e)) return "an image";
    return "read it with your file tools";
  };
  return [
    "[Carl attached these files to this message. They are saved on the box; the paths below are where they are. Do not search for them, and do not ask him to move them into the vault.]",
    ...files.map((f) => `- ${f.name} (${mb(f.size)}, ${how(f.name)}): ${f.abs}`),
  ].join("\n");
}
