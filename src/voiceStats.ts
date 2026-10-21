// The agent's audio on its way in, measured (Carl, 2026-10-21: "the voice is
// gone, then it glitches back to normal towards the end of the sentence", the
// waves moving all along). A stall mid-reply has two homes and the log has to
// tell them apart:
//   - network / ElevenLabs: packets lost or late, the jitter buffer concealing
//     (concealedSamples climbing), or packets arriving that carry silence;
//   - local: packets and inbound energy fine, but the playback context
//     suspended, the output device gone, or the main thread starved.
// While the agent speaks, the inbound WebRTC audio stats are read every 250 ms
// (RTCRtpReceiver.getStats through the SDK's LiveKit room): packetsLost,
// jitter, jitterBufferDelay/EmittedCount, concealedSamples,
// silentConcealedSamples, concealmentEvents, inserted/removed samples,
// audioLevel, totalAudioEnergy, roundTripTime. One compact "voice dropout" line
// per stall says which it was; one "voice playback" line per reply sums it up.
// Long main-thread tasks (> 200 ms) while it speaks are logged too.
// Pure classifier (DropoutWatch) plus the sampler (PlaybackMonitor); the caller
// hands it its room, its contexts and its log.

export type InboundAudio = {
  at: number;
  packetsReceived?: number;
  packetsLost?: number;
  jitter?: number;
  jitterBufferDelay?: number;
  jitterBufferEmittedCount?: number;
  totalSamplesReceived?: number;
  concealedSamples?: number;
  silentConcealedSamples?: number;
  concealmentEvents?: number;
  insertedSamplesForDeceleration?: number;
  removedSamplesForAcceleration?: number;
  audioLevel?: number;
  totalAudioEnergy?: number;
  roundTripTime?: number;
};

type StatLike = Record<string, unknown> & { type?: string; kind?: string; mediaType?: string };
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** The inbound audio stream's numbers from a getStats report (the busiest inbound-rtp audio), RTT from the
 *  candidate pair in use or the remote-outbound report. */
export function readInbound(report: Iterable<StatLike> | { forEach(f: (s: StatLike) => void): void } | null | undefined, at: number): InboundAudio | null {
  if (!report) return null;
  const all: StatLike[] = [];
  if (typeof (report as { forEach?: unknown }).forEach === "function") (report as { forEach(f: (s: StatLike) => void): void }).forEach((s) => all.push(s));
  else for (const s of report as Iterable<StatLike>) all.push(s);
  const inbound = all
    .filter((s) => s.type === "inbound-rtp" && (s.kind ?? s.mediaType) === "audio")
    .sort((a, b) => (num(b.packetsReceived) ?? 0) - (num(a.packetsReceived) ?? 0))[0];
  if (!inbound) return null;
  const pair = all.find((s) => s.type === "candidate-pair" && (s.nominated === true || s.selected === true) && num(s.currentRoundTripTime) !== undefined);
  const remote = all.find((s) => s.type === "remote-outbound-rtp" && (s.kind ?? s.mediaType) === "audio");
  const out: InboundAudio = { at, roundTripTime: num(pair?.currentRoundTripTime) ?? num(remote?.roundTripTime) };
  for (const k of [
    "packetsReceived",
    "packetsLost",
    "jitter",
    "jitterBufferDelay",
    "jitterBufferEmittedCount",
    "totalSamplesReceived",
    "concealedSamples",
    "silentConcealedSamples",
    "concealmentEvents",
    "insertedSamplesForDeceleration",
    "removedSamplesForAcceleration",
    "audioLevel",
    "totalAudioEnergy",
  ] as const)
    out[k] = num(inbound[k]);
  return out;
}

export type DropoutCause = "network" | "source" | "local";
export type Dropout = {
  cause: DropoutCause;
  ms: number;
  lost: number;
  concealed: number;
  silentConcealed: number;
  concealEvents: number;
  packets: number;
  jitterMs: number | null;
  bufferMs: number | null;
  rttMs: number | null;
  audioLevel: number | null;
  stretched: number;
  /** Local evidence: the playback contexts' states, the output in use, a long task in the window. */
  contexts: string[];
  outputDevice: string | null;
  longTaskMs: number;
};

/** What the page knows about its own playback at a sample. */
export type LocalPlayback = { contexts: string[]; outputDevice: string | null; outputLost?: boolean };

const d = (a: number | undefined, b: number | undefined) => (a !== undefined && b !== undefined ? Math.max(0, a - b) : 0);
const round = (x: number | undefined | null, k = 1) => (x === undefined || x === null ? null : Math.round(x * k) / k);

/** Classifies stalls in the inbound audio while the agent speaks. Feed it every sample; it emits one Dropout per
 *  stall when the stall ends (or the reply does). */
export class DropoutWatch {
  private prev: InboundAudio | null = null;
  private stallFrom: InboundAudio | null = null;
  private stallSince = 0;
  private heardEnergy = false;
  private longTask = 0;
  private localSince: number | null = null;
  private localSaid = false;
  /** A stall in progress (the waves should be flat). */
  stalled = false;

  constructor(
    private readonly emit: (d: Dropout) => void,
    private readonly cfg = { stallMs: 500, concealShare: 0.2, energyEps: 1e-7 },
  ) {}

  /** A long main-thread task (ms) happened: counted into the next dropout's evidence. */
  noteLongTask(ms: number): void {
    this.longTask = Math.max(this.longTask, ms);
  }

  reset(): void {
    this.prev = null;
    this.stallFrom = null;
    this.heardEnergy = false;
    this.stalled = false;
    this.longTask = 0;
    this.localSince = null;
    this.localSaid = false;
  }

  private report(from: InboundAudio, to: InboundAudio, cause: DropoutCause, local: LocalPlayback): void {
    const emitted = d(to.jitterBufferEmittedCount, from.jitterBufferEmittedCount);
    this.emit({
      cause,
      ms: Math.round(to.at - from.at),
      lost: d(to.packetsLost, from.packetsLost),
      concealed: d(to.concealedSamples, from.concealedSamples),
      silentConcealed: d(to.silentConcealedSamples, from.silentConcealedSamples),
      concealEvents: d(to.concealmentEvents, from.concealmentEvents),
      packets: d(to.packetsReceived, from.packetsReceived),
      jitterMs: round(to.jitter !== undefined ? to.jitter * 1000 : undefined),
      bufferMs: emitted > 0 ? round((d(to.jitterBufferDelay, from.jitterBufferDelay) / emitted) * 1000) : null,
      rttMs: round(to.roundTripTime !== undefined ? to.roundTripTime * 1000 : undefined),
      audioLevel: round(to.audioLevel, 1000),
      stretched: d(to.insertedSamplesForDeceleration, from.insertedSamplesForDeceleration) + d(to.removedSamplesForAcceleration, from.removedSamplesForAcceleration),
      contexts: local.contexts,
      outputDevice: local.outputDevice,
      longTaskMs: Math.round(this.longTask),
    });
    this.longTask = 0;
  }

  /** Network or source: concealment or loss across the stall says the packets didn't come (in time). */
  private causeOf(from: InboundAudio, to: InboundAudio): DropoutCause {
    const concealed = d(to.concealedSamples, from.concealedSamples) - d(to.silentConcealedSamples, from.silentConcealedSamples);
    const samples = d(to.totalSamplesReceived, from.totalSamplesReceived);
    const share = samples > 0 ? concealed / samples : concealed > 0 ? 1 : 0;
    if (d(to.packetsLost, from.packetsLost) > 0 || share >= this.cfg.concealShare || d(to.packetsReceived, from.packetsReceived) === 0) return "network";
    return "source";
  }

  sample(s: InboundAudio, speaking: boolean, local: LocalPlayback): void {
    const prev = this.prev;
    this.prev = s;
    if (!prev) return;
    if (!speaking) {
      // The reply ended mid-stall: the stall is reported with what it had.
      if (this.stallFrom && s.at - this.stallSince >= this.cfg.stallMs) this.report(this.stallFrom, prev, this.causeOf(this.stallFrom, prev), local);
      this.stallFrom = null;
      this.stalled = false;
      this.heardEnergy = false;
      this.localSince = null;
      this.localSaid = false;
      return;
    }
    const energyKnown = s.totalAudioEnergy !== undefined && prev.totalAudioEnergy !== undefined;
    const energyRose = energyKnown && s.totalAudioEnergy! - prev.totalAudioEnergy! > this.cfg.energyEps;
    const concealedNow = d(s.concealedSamples, prev.concealedSamples) - d(s.silentConcealedSamples, prev.silentConcealedSamples);
    const samplesNow = d(s.totalSamplesReceived, prev.totalSamplesReceived);
    const concealing = d(s.packetsLost, prev.packetsLost) > 0 || (samplesNow > 0 ? concealedNow / samplesNow >= this.cfg.concealShare : concealedNow > 0);
    // A stall: mid-reply (energy was heard), the energy stops rising, or the buffer conceals while energy shows.
    const stallNow = this.heardEnergy && ((energyKnown && !energyRose) || concealing);
    if (energyRose && !concealing) {
      if (this.stallFrom) {
        if (s.at - this.stallSince >= this.cfg.stallMs || concealing) this.report(this.stallFrom, prev, this.causeOf(this.stallFrom, prev), local);
        this.stallFrom = null;
      }
      this.stalled = false;
      this.heardEnergy = true;
      // Local: the stream is fine, the page can't play it.
      const localBad = local.outputLost || local.contexts.some((c) => c === "suspended" || c === "interrupted");
      if (localBad) {
        if (this.localSince === null) this.localSince = prev.at;
        if (!this.localSaid && s.at - this.localSince >= this.cfg.stallMs) {
          this.localSaid = true;
          this.report({ ...prev, at: this.localSince }, s, "local", local);
        }
      } else {
        this.localSince = null;
        this.localSaid = false;
      }
      return;
    }
    if (stallNow && !this.stallFrom) {
      this.stallFrom = prev;
      this.stallSince = prev.at;
    }
    if (this.stallFrom) this.stalled = s.at - this.stallSince >= this.cfg.stallMs;
    if (!energyKnown && !concealing && this.stallFrom) {
      this.stallFrom = null;
      this.stalled = false;
    }
  }
}

export type PlaybackSummary = { ms: number; lost: number; concealed: number; packets: number; jitterMs: number | null; rttMs: number | null; dropouts: number };

/** Where the stats come from: the SDK's LiveKit room's remote audio track (its receiver), else the subscriber
 *  peer connection. Null: no WebRTC here (the WebSocket transport). */
export async function roomAudioStats(room: any): Promise<unknown> {
  if (!room) return null;
  try {
    const parts: any[] = room.remoteParticipants?.values ? [...room.remoteParticipants.values()] : [];
    for (const p of parts) {
      const pubs: any[] = p?.audioTrackPublications?.values ? [...p.audioTrackPublications.values()] : [];
      for (const pub of pubs) {
        const t = pub?.track;
        if (t?.getRTCStatsReport) {
          const r = await t.getRTCStatsReport();
          if (r) return r;
        }
        if (t?.receiver?.getStats) return await t.receiver.getStats();
      }
    }
    const sub = room.engine?.pcManager?.subscriber;
    if (sub?.getStats) return await sub.getStats();
    if (sub?.pc?.getStats) return await sub.pc.getStats();
  } catch {
    /* closed */
  }
  return null;
}

/** Long main-thread tasks: the longtask observer where there is one (Chromium), else a timer's drift (WebKit). */
export function watchLongTasks(onTask: (ms: number) => void, minMs = 200): () => void {
  const PO = typeof PerformanceObserver !== "undefined" ? PerformanceObserver : undefined;
  if (PO && (PO as unknown as { supportedEntryTypes?: string[] }).supportedEntryTypes?.includes("longtask")) {
    const po = new PO((list) => {
      for (const e of list.getEntries()) if (e.duration >= minMs) onTask(e.duration);
    });
    po.observe({ type: "longtask", buffered: false } as PerformanceObserverInit);
    return () => po.disconnect();
  }
  let last = Date.now();
  const t = setInterval(() => {
    const now = Date.now();
    const late = now - last - 100;
    last = now;
    if (late >= minMs) onTask(late);
  }, 100);
  (t as { unref?: () => void }).unref?.();
  return () => clearInterval(t);
}

/** One call's playback monitor: samples the inbound stats while the agent speaks, logs a "voice playback" line per
 *  reply (start/stop and its numbers), a "voice dropout" per stall, a "voice long task" per long task. */
export class PlaybackMonitor {
  readonly watch: DropoutWatch;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopLong: (() => void) | null = null;
  private speakingSince: number | null = null;
  private first: InboundAudio | null = null;
  private last: InboundAudio | null = null;
  private dropouts = 0;
  private busy = false;

  constructor(
    private readonly o: {
      stats: () => Promise<unknown>;
      speaking: () => boolean;
      local: () => LocalPlayback;
      log: (event: string, data: Record<string, unknown>) => void;
      now?: () => number;
      everyMs?: number;
      longTasks?: boolean;
    },
  ) {
    this.watch = new DropoutWatch((x) => {
      this.dropouts++;
      this.o.log("voice dropout", x as unknown as Record<string, unknown>);
    });
  }

  private now(): number {
    return this.o.now ? this.o.now() : Date.now();
  }

  start(): this {
    this.stop();
    if (this.o.everyMs !== 0) {
      this.timer = setInterval(() => void this.tick(), this.o.everyMs ?? 250);
      (this.timer as { unref?: () => void }).unref?.();
    }
    if (this.o.longTasks !== false)
      this.stopLong = watchLongTasks((ms) => {
        if (this.speakingSince === null) return;
        this.watch.noteLongTask(ms);
        this.o.log("voice long task", { ms: Math.round(ms), ...this.o.local() });
      });
    return this;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopLong?.();
    this.stopLong = null;
    if (this.speakingSince !== null) this.ended();
    this.watch.reset();
  }

  /** A stall in progress: the waves go flat. */
  get stalled(): boolean {
    return this.watch.stalled;
  }

  private ended(): void {
    const f = this.first,
      l = this.last;
    const s: PlaybackSummary = {
      ms: Math.round(this.now() - (this.speakingSince ?? this.now())),
      lost: d(l?.packetsLost, f?.packetsLost),
      concealed: d(l?.concealedSamples, f?.concealedSamples),
      packets: d(l?.packetsReceived, f?.packetsReceived),
      jitterMs: round(l?.jitter !== undefined ? l.jitter * 1000 : undefined),
      rttMs: round(l?.roundTripTime !== undefined ? l.roundTripTime * 1000 : undefined),
      dropouts: this.dropouts,
    };
    this.o.log("voice playback", { phase: "stop", ...s, ...this.o.local() });
    this.speakingSince = null;
    this.first = this.last = null;
    this.dropouts = 0;
  }

  /** One sample now (the timer's tick; tests call it directly). */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const speaking = this.o.speaking();
      if (speaking && this.speakingSince === null) {
        this.speakingSince = this.now();
        this.o.log("voice playback", { phase: "start", ...this.o.local() });
      }
      if (!speaking && this.speakingSince === null) return;
      const s = readInbound((await this.o.stats()) as Iterable<StatLike> | null, this.now());
      const local = this.o.local();
      if (s) {
        if (speaking && !this.first) this.first = s;
        if (speaking) this.last = s;
        this.watch.sample(s, speaking, local);
      }
      if (!speaking) this.ended();
    } finally {
      this.busy = false;
    }
  }
}
