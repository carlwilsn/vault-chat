// The live call's side of voice as front of house (D3), shared by the three
// clients (the laptop, src/voice-elevenlabs.ts; the board, board/src/voice.ts;
// the phone, phone/src/boot.ts):
//   - VoiceUpdates: the box's updates for the attached conversation (GET
//     /api/v1/voice/updates, long-polled) put into the live call, each held
//     while the voice speaks (QuietGate) — the agent's answer to an Ask and
//     its questions as a user message the voice answers aloud ([vc:result],
//     [vc:question]), everything already handled (a typed turn, the "you"
//     layer) as a contextual update it never answers ([vc:context]);
//   - pushStartImages: the conversation's newest images, sent with the call's
//     start (the box reads them from the conversation; empty ones are never sent).
import type { QuietGate } from "./voiceQuiet";
import { VoiceImagePusher, sendFilesMessage, type PushResult, type VoiceImageSink } from "./voiceImages";

export type VoiceUpdate = { id: string; kind: string; text: string; speak: boolean };
export type UpdatesPage = { updates: VoiceUpdate[]; cursor: string };
/** As much of the SDK's conversation as an update needs. */
export type UpdateConv = { sendUserMessage?(text: string): void; sendContextualUpdate(text: string, o?: { contextId?: string }): void };

/** One live call's updates loop. `fetch` long-polls the box from `cursor`; stop() ends it. */
export class VoiceUpdates {
  private stopped = false;
  private seen = new Set<string>();
  /** What reached the call (tests, diagnostics). */
  readonly delivered: VoiceUpdate[] = [];

  constructor(
    private readonly o: {
      fetch: (cursor: string | null) => Promise<UpdatesPage>;
      conv: () => UpdateConv | null;
      gate: QuietGate;
      cursor: string | null;
      retryMs?: number;
      log?: (ev: string, data: Record<string, unknown>) => void;
    },
  ) {}

  start(): this {
    void this.loop();
    return this;
  }

  stop(): void {
    this.stopped = true;
  }

  private async loop(): Promise<void> {
    let cursor = this.o.cursor;
    while (!this.stopped) {
      try {
        const page = await this.o.fetch(cursor);
        if (this.stopped) return;
        cursor = page.cursor || cursor;
        for (const u of page.updates ?? []) this.deliver(u);
      } catch (e) {
        this.o.log?.("voice updates", { error: String((e as Error)?.message ?? e).slice(0, 200) });
        await new Promise((r) => setTimeout(r, this.o.retryMs ?? 3000));
      }
    }
  }

  /** Into the call once the voice is quiet: a user message it answers aloud, or a contextual update it never answers. */
  deliver(u: VoiceUpdate): void {
    if (!u?.id || this.seen.has(u.id)) return;
    this.seen.add(u.id);
    const conv = this.o.conv();
    if (!conv) return;
    this.o.gate.run(`vc:${u.id}`, () => {
      if (this.stopped || this.o.conv() !== conv) return;
      try {
        if (u.speak && conv.sendUserMessage) conv.sendUserMessage(u.text);
        else conv.sendContextualUpdate(u.text);
        this.delivered.push(u);
        this.o.log?.("voice update", { kind: u.kind, speak: u.speak, chars: u.text.length });
      } catch (e) {
        this.o.log?.("voice update failed", { kind: u.kind, error: String((e as Error)?.message ?? e).slice(0, 200) });
      }
    });
  }
}

/** The conversation's newest images (the box's session: base64), sent with the call's start in one message. */
export async function pushStartImages(
  conv: VoiceImageSink,
  pusher: VoiceImagePusher,
  images: { mime: string; dataBase64: string }[] | undefined,
  still: () => boolean = () => true,
): Promise<PushResult[]> {
  // Each image's result in order; an empty one (no bytes) is never sent and never counted in the note.
  const out: (PushResult | null)[] = [];
  const items: { key: string; blob: Blob }[] = [];
  for (const im of (images ?? []).slice(0, 3)) {
    try {
      const bin = atob(String(im.dataBase64 ?? ""));
      if (!bin.length) {
        out.push("empty");
        continue;
      }
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      items.push({ key: `start:${im.mime}:${bytes.length}:${bin.slice(0, 64)}`, blob: new Blob([bytes], { type: im.mime || "image/png" }) });
      out.push(null);
    } catch {
      out.push("failed");
    }
  }
  if (!items.length) return out as PushResult[];
  const sink = { ...conv, sendFiles: (t: string | undefined, ids: string[]) => sendFilesMessage(conv, t, ids) };
  const sent = await pusher.pushMany(sink, items, threadImagesNote(items.length), still);
  let k = 0;
  return out.map((r) => r ?? sent[k++] ?? "failed");
}

/** The note with a call's start images (the laptop's pushThreadImages says the same). */
export const threadImagesNote = (n: number): string =>
  `[Earlier in this conversation (before this call), ${n === 1 ? "this image was" : `these ${n} images were`} shared in the chat, oldest first — attached so you can see them. Say nothing about them now; wait for Carl.]`;
