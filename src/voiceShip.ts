// The voice's diagnostics, on the box (2026-10-21): the laptop and the phone
// send their voice lines — dropouts with the WebRTC stats, the mic and output
// pins and switches, every device change, closes, turns, silent playback,
// fillers in silence, long tasks while it speaks, the AudioContext's state —
// to the box (POST /api/v1/board/log with source "voice" → <state>/logs/
// voice.jsonl, rotated, every line redacted by the box), batched every 15 s, on
// call end and when the page hides. The box's own agent reads them there, no
// SSH. The board's voice lines go to board.jsonl by its own log (board/src/log.ts).

/** The lines worth shipping (the rest stay in the device's local trail). */
export const SHIPPED = /^voice (end|start|dropout|mic|output|devices|closed|turn|silent playback|playback|filler in silence|long task|audio|connected|session|transport|interruption|media device|connection poor|update|mute|status|metadata|timeout|reconnect|handoff|moved|console)/;

/** The laptop app's lines worth shipping (source "app" → <state>/logs/app.jsonl, src/appShip.ts): its errors and its
 *  connection to the box (box.feed: dropped with the error, connected with how long it was down). */
export const APP_SHIPPED = /^(console\.error|window\.error|unhandledrejection|box\.feed|box\.intent|boot$|app\.)/;

export type ShipBody = { source: "voice" | "app"; device: string; session: string; v?: string; events: { at: string; ev: string; [k: string]: unknown }[] };

export class VoiceLogShipper {
  private queue: ShipBody["events"] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sending = false;
  readonly session = Math.random().toString(36).slice(2, 10);
  /** Where a batch goes (null: nowhere yet — queued until there is a box). `keepalive`: the page is going away. */
  post: ((body: ShipBody, keepalive: boolean) => Promise<unknown>) | null = null;

  constructor(private readonly o: { device: string; v?: string; everyMs?: number; max?: number; source?: "voice" | "app"; only?: RegExp }) {}

  add(tag: string, data?: unknown): void {
    if (!(this.o.only ?? SHIPPED).test(tag)) return;
    const rest = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : data === undefined ? {} : { data };
    this.queue.push({ ...rest, at: new Date().toISOString(), ev: tag });
    const max = this.o.max ?? 300;
    if (this.queue.length > max) this.queue = this.queue.slice(-max);
    if (!this.timer && this.o.everyMs !== 0) {
      this.timer = setTimeout(() => void this.flush(), this.o.everyMs ?? 15_000);
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  /** What waits to go (tests). */
  get pending(): number {
    return this.queue.length;
  }

  /** Send what is queued; a failed batch goes back in front. Never throws. */
  async flush(keepalive = false): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.queue.length || this.sending || !this.post) return;
    const events = this.queue;
    this.queue = [];
    this.sending = true;
    try {
      await this.post({ source: this.o.source ?? "voice", device: this.o.device, session: this.session, ...(this.o.v ? { v: this.o.v } : {}), events }, keepalive);
    } catch {
      this.queue = [...events, ...this.queue].slice(-(this.o.max ?? 300));
    } finally {
      this.sending = false;
    }
  }

  /** Flush when the page hides or goes away (keepalive). Idempotent per shipper. */
  private installed = false;
  installPageHide(): void {
    if (this.installed || typeof window === "undefined" || typeof document === "undefined") return;
    this.installed = true;
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) void this.flush(true);
    });
    window.addEventListener("pagehide", () => void this.flush(true));
  }
}
