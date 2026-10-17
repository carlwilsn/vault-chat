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
  constructor(
    private readonly max = MAX_IMAGE_UPLOAD_BYTES,
    private readonly shrink: (b: Blob, max: number) => Promise<Blob | null> = shrinkImage,
  ) {}

  reset(): void {
    this.sent.clear();
    this.inFlight.clear();
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
    const ids: string[] = [];
    const keys: string[] = [];
    for (const it of items.slice(0, 5)) {
      if (this.sent.has(it.key) || this.inFlight.has(it.key) || keys.includes(it.key)) {
        out.push("duplicate");
        continue;
      }
      if (!it.blob.type.startsWith("image/")) {
        out.push("unsupported");
        continue;
      }
      this.inFlight.add(it.key);
      try {
        let body: Blob | null = it.blob;
        if (body.size > this.max) body = await this.shrink(body, this.max);
        if (!body || body.size > this.max) {
          out.push("too-large");
          continue;
        }
        if (!still()) {
          out.push("failed");
          continue;
        }
        const { fileId } = await sink.uploadFile(body);
        ids.push(fileId);
        keys.push(it.key);
        out.push("sent");
      } catch (e) {
        console.warn("[voice-image] upload failed:", (e as Error)?.message ?? e);
        out.push("failed");
      } finally {
        this.inFlight.delete(it.key);
      }
    }
    if (ids.length) {
      if (!still()) return out.map((r) => (r === "sent" ? "failed" : r));
      try {
        sink.sendFiles(note, ids);
      } catch (e) {
        console.warn("[voice-image] send failed:", (e as Error)?.message ?? e);
        return out.map((r) => (r === "sent" ? "failed" : r));
      }
      for (const k of keys) this.sent.add(k);
    }
    return out;
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
      const { fileId } = await sink.uploadFile(body);
      if (!still()) return "failed";
      sink.sendMultimodalMessage({ text: note, fileId });
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
