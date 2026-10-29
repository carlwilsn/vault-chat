// The phone's "+": what it picked becomes part of the next message. A photo goes inline with the
// message (images[], scaled down first, as before); any other file — a PDF from Files, a doc — is
// uploaded to the box at once (POST /api/v2/attachment: saved under .vault-chat/attachments, 25 MB
// cap, server/attachments.ts), shows as a chip in the composer, and the message names it by its
// path there (files[]), so the agent is told where it is — the laptop's route (src/boxChat.ts).

/** One file's cap, the box's own (server/attachments.ts ATTACH_MAX_BYTES). */
export const ATTACH_MAX_BYTES = 25 * 1024 * 1024;

/** Formats the box shows inline; anything else (a PDF, a HEIC we cannot draw, a doc) is a file. */
const PHOTO_MIME = /^image\/(png|jpe?g|gif|webp|heic|heif)$/i;
export const isPhoto = (f: { type?: string }): boolean => PHOTO_MIME.test(f.type || "");

export function sizeLabel(n: number): string {
  return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function tooBig(name: string, size: number): string {
  return `${name} is ${(size / (1024 * 1024)).toFixed(1)} MB; an attachment can be at most ${ATTACH_MAX_BYTES / (1024 * 1024)} MB.`;
}

/** A blob's bytes as base64 (no data: prefix). */
export async function base64Of(b: Blob): Promise<string> {
  const bytes = new Uint8Array(await b.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export type Upload = { ok: true; path: string; name: string; size: number } | { ok: false; error: string };
type Post = (path: string, init: RequestInit) => Promise<Response>;

/** One file to the box's attachments area; the path it answers is what the message carries. */
export async function uploadAttachment(post: Post, file: Blob & { name?: string }): Promise<Upload> {
  const name = file.name || "file";
  if (file.size > ATTACH_MAX_BYTES) return { ok: false, error: tooBig(name, file.size) };
  if (file.size === 0) return { ok: false, error: `${name} is empty: nothing to attach.` };
  try {
    const r = await post("/api/v2/attachment", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, dataBase64: await base64Of(file) }) });
    const d = (await r.json().catch(() => ({}))) as { path?: string; name?: string; size?: number; error?: string };
    if (!r.ok || d.error || !d.path) return { ok: false, error: d.error || `the box answered ${r.status}` };
    return { ok: true, path: d.path, name: d.name || name, size: d.size ?? file.size };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}

/** A file waiting in the composer: uploading, ready (its box path), or failed (why). */
export type PendingFile = { key: string; name: string; size: number; state: "uploading" | "ready" | "failed"; path?: string; error?: string; done: Promise<void> };

/** Starts the upload; `changed` is called when its state moves (the chip redraws). */
export function pendingFile(post: Post, file: Blob & { name?: string }, changed: () => void): PendingFile {
  const p: PendingFile = { key: Math.random().toString(36).slice(2), name: file.name || "file", size: file.size, state: "uploading", done: Promise.resolve() };
  p.done = uploadAttachment(post, file).then((u) => {
    if (u.ok) Object.assign(p, { state: "ready", path: u.path, name: u.name });
    else Object.assign(p, { state: "failed", error: (u as { error: string }).error });
    changed();
  });
  return p;
}
