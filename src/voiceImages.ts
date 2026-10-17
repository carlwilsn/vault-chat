// Ambient vision for voice, images: what Carl is looking at goes to the voice
// conversation the way an open PDF does (voice-elevenlabs pushPdfIfNeeded) —
// uploaded to the ElevenLabs conversation once, with a short note saying what
// it is. Deduped per session by key (a file path, or path + page for a page
// capture), size-capped, one upload of a key at a time.

/** What the ElevenLabs conversation offers for this (a subset of the SDK's). */
export type VoiceImageSink = {
  uploadFile(file: Blob): Promise<{ fileId: string }>;
  sendMultimodalMessage(m: { text?: string; fileId: string }): void;
};

/** A multimodal_message in the current shape — `files: [{type: "file_input", file_id}]`
 *  (≤ 5; the single `file` field the SDK still sends is deprecated). Falls back to
 *  the SDK's own call where its connection isn't reachable. */
export function sendFilesMessage(conv: VoiceImageSink, text: string | undefined, fileIds: string[]): void {
  const ids = fileIds.filter(Boolean).slice(0, 5);
  if (!ids.length) return;
  // The SDK's connection (protected in its types, there at runtime).
  const c = (conv as unknown as { connection?: { sendMessage?: (m: Record<string, unknown>) => void } }).connection;
  const send = c?.sendMessage?.bind(c);
  if (send) {
    send({
      type: "multimodal_message",
      ...(text ? { text: { type: "user_message", text } } : {}),
      files: ids.map((file_id) => ({ type: "file_input", file_id })),
    });
    return;
  }
  for (const [i, fileId] of ids.entries()) conv.sendMultimodalMessage({ ...(i === 0 && text ? { text } : {}), fileId });
}

export type PushResult = "sent" | "duplicate" | "too-large" | "unsupported" | "failed";

/** 10 MB: a phone photo fits; anything bigger is shrunk first (when the page can) or skipped. */
export const MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** The upload type for an image file the voice model can read, or null (svg, heic, tiff…). */
export function voiceImageMime(path: string): string | null {
  const ext = (path.split(".").pop() ?? "").toLowerCase();
  return MIME[ext] ?? null;
}

/** The note that goes with an image: what Carl is looking at, in a bracket like the PDF's. */
export function lookingAtNote(name: string, extra?: string): string {
  return `[The user is looking at ${name}${extra ? ` (${extra})` : ""}. The image is attached — you can see it. Don't describe it unless asked.]`;
}

/** Shrink an image to fit under `max` bytes (longest side ≤ 2048, JPEG) where the page can draw; null otherwise. */
export async function shrinkImage(blob: Blob, max = MAX_IMAGE_UPLOAD_BYTES): Promise<Blob | null> {
  const g = globalThis as { createImageBitmap?: (b: Blob) => Promise<ImageBitmap>; OffscreenCanvas?: typeof OffscreenCanvas };
  if (!g.createImageBitmap || !g.OffscreenCanvas) return null;
  try {
    const bmp = await g.createImageBitmap(blob);
    const scale = Math.min(1, 2048 / Math.max(bmp.width, bmp.height));
    const c = new g.OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
    c.getContext("2d")?.drawImage(bmp, 0, 0, c.width, c.height);
    const out = await c.convertToBlob({ type: "image/jpeg", quality: 0.85 });
    return out.size <= max ? out : null;
  } catch {
    return null;
  }
}

/** The longest side an image goes to the voice model at: a screen's worth of
 *  detail, a fraction of the tokens a 2048 px capture costs. */
export const VOICE_IMAGE_MAX_SIDE = 1280;

/** Images as ONE downscaled JPEG for the voice model, stacked top to bottom
 *  (a look's several images are one picture, not five files in its context):
 *  width ≤ maxSide, the stack's height ≤ 2 × maxSide. Null where the page can't
 *  draw (the caller sends the originals). */
export async function composeImages(blobs: Blob[], maxSide = VOICE_IMAGE_MAX_SIDE): Promise<Blob | null> {
  const g = globalThis as { createImageBitmap?: (b: Blob) => Promise<ImageBitmap>; OffscreenCanvas?: typeof OffscreenCanvas };
  if (!g.createImageBitmap || !g.OffscreenCanvas || !blobs.length) return null;
  try {
    const bmps = await Promise.all(blobs.map((b) => g.createImageBitmap!(b)));
    const gap = bmps.length > 1 ? 16 : 0;
    const w = Math.max(...bmps.map((b) => b.width));
    const h = bmps.reduce((a, b) => a + b.height, 0) + gap * (bmps.length - 1);
    const scale = Math.min(1, maxSide / w, (2 * maxSide) / h);
    // One small image: nothing to gain.
    if (bmps.length === 1 && scale === 1) return null;
    const c = new g.OffscreenCanvas(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)));
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, c.width, c.height);
    let y = 0;
    for (const b of bmps) {
      ctx.drawImage(b, 0, y * scale, b.width * scale, b.height * scale);
      y += b.height + gap;
    }
    return await c.convertToBlob({ type: "image/jpeg", quality: 0.85 });
  } catch {
    return null;
  }
}

/** A data URL of the image for the thread: shrunk to 1024 px where the page can
 *  draw, the original when it is small, else null. */
export async function thumbDataUrl(blob: Blob): Promise<string | null> {
  const toUrl = (b: Blob) =>
    new Promise<string>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.onerror = () => rej(r.error);
      r.readAsDataURL(b);
    });
  const g = globalThis as { createImageBitmap?: (b: Blob) => Promise<ImageBitmap>; OffscreenCanvas?: typeof OffscreenCanvas; FileReader?: unknown };
  if (!g.FileReader) return null;
  try {
    if (g.createImageBitmap && g.OffscreenCanvas && blob.type !== "image/gif") {
      const bmp = await g.createImageBitmap(blob);
      const scale = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
      if (scale < 1 || blob.size > 400_000) {
        const c = new g.OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
        c.getContext("2d")?.drawImage(bmp, 0, 0, c.width, c.height);
        return await toUrl(await c.convertToBlob({ type: "image/jpeg", quality: 0.85 }));
      }
    }
    return blob.size <= 1_500_000 ? await toUrl(blob) : null;
  } catch {
    return null;
  }
}

/** One voice session's image uploads. `reset()` at session start. */
export class VoiceImagePusher {
  private sent = new Set<string>();
  private inFlight = new Set<string>();
  /** Files uploaded to this session (each stays in the model's context until ElevenLabs frees it). */
  uploaded = 0;
  constructor(
    private readonly max = MAX_IMAGE_UPLOAD_BYTES,
    private readonly shrink: (b: Blob, max: number) => Promise<Blob | null> = shrinkImage,
    // Downscales one image, or stacks several into one (null: send as they are).
    private readonly compose: (bs: Blob[]) => Promise<Blob | null> = composeImages,
  ) {}

  reset(): void {
    this.sent.clear();
    this.inFlight.clear();
    this.uploaded = 0;
  }

  has(key: string): boolean {
    return this.sent.has(key);
  }

  /** Several images in ONE message (≤ 5 files, ElevenLabs' cap) with one note:
   *  each new key is uploaded; a key already sent is "duplicate" (it is in the
   *  conversation). Nothing new → nothing sent. Results in the items' order. */
  async pushMany(
    sink: VoiceImageSink & { sendFiles(text: string | undefined, fileIds: string[]): void },
    items: { key: string; blob: Blob }[],
    note: string,
    still: () => boolean = () => true,
  ): Promise<PushResult[]> {
    const out: PushResult[] = [];
    // The new images (index into out, key, a body under the cap).
    const fresh: { i: number; key: string; body: Blob }[] = [];
    const claimed: string[] = [];
    try {
      for (const it of items.slice(0, 5)) {
        if (this.sent.has(it.key) || this.inFlight.has(it.key) || claimed.includes(it.key)) {
          out.push("duplicate");
          continue;
        }
        if (!it.blob.type.startsWith("image/")) {
          out.push("unsupported");
          continue;
        }
        this.inFlight.add(it.key);
        claimed.push(it.key);
        let body: Blob | null = it.blob;
        if (body.size > this.max) body = await this.shrink(body, this.max).catch(() => null);
        if (!body || body.size > this.max) {
          out.push("too-large");
          continue;
        }
        fresh.push({ i: out.length, key: it.key, body });
        out.push("sent");
      }
      if (!fresh.length) return out;
      const fail = () => {
        for (const f of fresh) out[f.i] = "failed";
        return out;
      };
      if (!still()) return fail();
      // One picture for the look where the page can draw (stacked, downscaled), else each as it is.
      const one = await this.compose(fresh.map((f) => f.body)).catch(() => null);
      const bodies = one && one.size <= this.max ? [one] : fresh.map((f) => f.body);
      const ids: string[] = [];
      try {
        for (const b of bodies) ids.push((await sink.uploadFile(b)).fileId);
      } catch (e) {
        console.warn("[voice-image] upload failed:", (e as Error)?.message ?? e);
        return fail();
      }
      if (!still()) return fail();
      const n = fresh.length;
      const text = bodies.length === 1 && n > 1 ? `${note} (The ${n} images are stacked top to bottom in one picture.)` : note;
      try {
        sink.sendFiles(text, ids);
      } catch (e) {
        console.warn("[voice-image] send failed:", (e as Error)?.message ?? e);
        return fail();
      }
      this.uploaded += ids.length;
      for (const f of fresh) this.sent.add(f.key);
      return out;
    } finally {
      for (const k of claimed) this.inFlight.delete(k);
    }
  }

  /** Upload `blob` once per key and send it with `note`. */
  async push(sink: VoiceImageSink, key: string, blob: Blob, note: string, still: () => boolean = () => true): Promise<PushResult> {
    if (this.sent.has(key) || this.inFlight.has(key)) return "duplicate";
    if (!blob.type.startsWith("image/")) return "unsupported";
    this.inFlight.add(key);
    try {
      let body: Blob | null = blob;
      if (body.size > this.max) body = await this.shrink(body, this.max);
      if (!body || body.size > this.max) {
        this.sent.add(key); // don't retry on every viewport change
        return "too-large";
      }
      if (!still()) return "failed";
      // Downscaled for the model where the page can draw.
      const small = await this.compose([body]).catch(() => null);
      if (small && small.size < body.size) body = small;
      const { fileId } = await sink.uploadFile(body);
      if (!still()) return "failed";
      sink.sendMultimodalMessage({ text: note, fileId });
      this.uploaded++;
      this.sent.add(key);
      return "sent";
    } catch (e) {
      console.warn("[voice-image] upload failed:", (e as Error)?.message ?? e);
      return "failed";
    } finally {
      this.inFlight.delete(key);
    }
  }
}
