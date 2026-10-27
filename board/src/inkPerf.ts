// How the board keeps up with the Pencil, measured on the device and reported in the board's log (log.ts, one
// `ink.perf` line per batch with strokes in it), so a real iPad session gives real numbers:
//
//   strokes, samples      pen strokes and the Pencil samples they carried (coalesced: 240 a second)
//   hz                    the page's frame rate while writing (median interval between frames): ~60 means Safari's
//                         "Prefer Page Rendering Updates near 60fps" is on, ~120 that ProMotion reaches the page
//   lat {p50, p95, max}   input → frame, ms: from the Pencil being at a sample (the event's own timeStamp) to the
//                         animation frame that drew it (the screen shows that frame one refresh later)
//   disp {p50, p95, max}  input → handler, ms: from a sample to the page running its pointer event (the main thread
//                         busy elsewhere shows here first)
//   gaps, gapMax          frames more than 20 ms apart while the pen is down (a dropped frame at 60 Hz is 33 ms)
//   liveMs {p50, p95, max}  the frame's own work for the stroke being written (renderLive), ms
//   long {n, max}         main-thread tasks over 50 ms while the pen was down, when the browser reports them
//                         (Safari does not: then 0 and `gaps`/`disp` tell)
//   during {what: n}      the board's own heavy work that still ran while the pen was down (pictures, save, the
//                         device copy, voice's picture): should be empty
//   voice                 a voice call was live for some of it
//   pred                  the share of frames drawn with a predicted sample (getPredictedEvents: iPadOS 18.2+)
//
// The cost is a few numbers per sample and per frame, kept in bounded arrays and summarised at each flush.

const CAP = 6000;

/**
 * The Pencil, for whatever else runs on the page (the voice pill's waves): `down` while a stroke is being written,
 * `at` the last pen event (touching or hovering, performance.now()). Work that can wait waits while it is down.
 */
export const penState = { down: false, at: 0 };

function push(a: number[], v: number): void {
  if (a.length < CAP) a.push(v);
  else a[(Math.random() * CAP) | 0] = v; // a uniform sample of the rest
}

function q(a: number[], p: number): number {
  if (!a.length) return 0;
  const s = Float64Array.from(a).sort();
  return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]! * 10) / 10;
}

export class InkPerf {
  private strokes = 0;
  private samples = 0;
  private lat: number[] = [];
  private disp: number[] = [];
  private live: number[] = [];
  private intervals: number[] = [];
  private gaps = 0;
  private gapMax = 0;
  private longN = 0;
  private longMax = 0;
  private during: Record<string, number> = {};
  private voice = false;
  private frames = 0;
  private predFrames = 0;
  /** Sample times (event timeStamps) handed in since the last frame drew. */
  private pending: number[] = [];
  private lastFrame = 0;
  private down = false;
  private po: PerformanceObserver | null = null;

  constructor() {
    try {
      const PO = typeof PerformanceObserver !== "undefined" ? PerformanceObserver : undefined;
      if (PO && (PO as unknown as { supportedEntryTypes?: string[] }).supportedEntryTypes?.includes("longtask")) {
        this.po = new PO((list) => {
          if (!this.down) return;
          for (const e of list.getEntries()) {
            this.longN++;
            this.longMax = Math.max(this.longMax, e.duration);
          }
        });
        this.po.observe({ type: "longtask" } as PerformanceObserverInit);
      }
    } catch {
      this.po = null;
    }
  }

  /** The pen came down (a stroke starts). */
  penDown(voiceLive: boolean): void {
    this.down = true;
    this.strokes++;
    this.lastFrame = 0;
    this.pending.length = 0;
    if (voiceLive) this.voice = true;
  }

  penUp(): void {
    this.down = false;
    this.pending.length = 0;
  }

  get active(): boolean {
    return this.down;
  }

  /**
   * A pointer event's samples reached the page: `ts` their timeStamps, `now` performance.now() in the handler.
   * A timestamp far from now (a browser with another time base) is not a latency and is left out.
   */
  input(ts: number[], now: number): void {
    for (const t of ts) {
      const d = now - t;
      this.samples++;
      if (d < 0 || d > 1000) continue;
      push(this.disp, d);
      this.pending.push(t);
    }
  }

  /** A frame drew the stroke being written: `ms` its own work, `pred` whether it drew a predicted sample. */
  frame(start: number, ms: number, pred: boolean): void {
    if (!this.down) return;
    this.frames++;
    if (pred) this.predFrames++;
    push(this.live, ms);
    if (this.lastFrame) {
      const iv = start - this.lastFrame;
      push(this.intervals, iv);
      if (iv > 20) {
        this.gaps++;
        this.gapMax = Math.max(this.gapMax, iv);
      }
    }
    this.lastFrame = start;
    for (const t of this.pending) push(this.lat, start - t);
    this.pending.length = 0;
  }

  /** Heavy work of the board's own (`what`) that ran: counted when the pen was down meanwhile. */
  work(what: string): void {
    if (this.down) this.during[what] = (this.during[what] ?? 0) + 1;
  }

  /** The line for the log since the last one (null when no stroke was written). */
  take(): Record<string, unknown> | null {
    if (!this.strokes) return null;
    const iv = q(this.intervals, 0.5);
    const out = {
      strokes: this.strokes,
      samples: this.samples,
      hz: iv ? Math.round(1000 / iv) : null,
      lat: { p50: q(this.lat, 0.5), p95: q(this.lat, 0.95), max: q(this.lat, 1) },
      disp: { p50: q(this.disp, 0.5), p95: q(this.disp, 0.95), max: q(this.disp, 1) },
      gaps: this.gaps,
      gapMax: Math.round(this.gapMax),
      liveMs: { p50: q(this.live, 0.5), p95: q(this.live, 0.95), max: q(this.live, 1) },
      long: { n: this.longN, max: Math.round(this.longMax) },
      during: this.during,
      voice: this.voice,
      pred: this.frames ? Math.round((this.predFrames / this.frames) * 100) / 100 : 0,
    };
    const down = this.down;
    this.strokes = down ? 1 : 0;
    this.samples = 0;
    this.lat = [];
    this.disp = [];
    this.live = [];
    this.intervals = [];
    this.gaps = this.gapMax = this.longN = this.longMax = 0;
    this.during = {};
    this.voice = false;
    this.frames = this.predFrames = 0;
    return out;
  }

  dispose(): void {
    this.po?.disconnect();
  }
}
