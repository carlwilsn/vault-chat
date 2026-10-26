// The New voice's call, on any device (laptop, iPad board, phone): the device
// is only a microphone and a speaker. Its audio goes to the box over WebRTC on
// the tailnet (server/voiceBrain.ts → voice-pipeline/bot.py); the box hears,
// asks the conversation's own pi agent (the voice IS the agent), and speaks
// pi's reply back as this call's audio track. Nothing here talks to a model,
// keeps a transcript or routes typed text: what Carl types goes to the chat as
// always, and the box speaks its reply into the call.
//
// Shaped like the ElevenLabs SDK's conversation object the clients already
// drive (setMicMuted, setVolume, get…ByteFrequencyData, endSession), so the
// waves, mute and end work unchanged. The mode (listening / thinking /
// speaking) is read from the audio itself: the bot's track playing is
// "speaking"; Carl having just spoken and nothing playing yet is "thinking".
// The reply plays through an <audio> element (not Web Audio), so the browser's
// echo cancellation sees it (WebView2 and Safari cancel only what they play).

export type BrainDevice = "laptop" | "board" | "phone";
export type BrainMode = "listening" | "thinking" | "speaking";

/** POST to the box; resolves with the JSON body or throws with the box's words. */
export type BrainPost = (path: string, body: Record<string, unknown>) => Promise<any>;

export type BrainOptions = {
  post: BrainPost;
  convId: string;
  device: BrainDevice;
  inputDeviceId?: string;
  outputDeviceId?: string;
  onConnect?: () => void;
  onMode?: (mode: BrainMode) => void;
  /** The call ended without endSession (the network, the box). */
  onDisconnect?: (d: { reason: string; message?: string }) => void;
  log?: (ev: string, data: Record<string, unknown>) => void;
  /** [tests] */
  deps?: Partial<BrainDeps>;
};

type BrainDeps = {
  getUserMedia: (c: MediaStreamConstraints) => Promise<MediaStream>;
  peer: () => RTCPeerConnection;
  audioContext: () => AudioContext;
  audioElement: () => HTMLAudioElement;
  now: () => number;
};

const defaultDeps = (): BrainDeps => ({
  getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
  peer: () => new RTCPeerConnection(),
  audioContext: () => new AudioContext(),
  audioElement: () => {
    const el = document.createElement("audio");
    el.autoplay = true;
    return el;
  },
  now: () => Date.now(),
});

/** Carl's mic level that counts as speech, and the bot's that counts as audible (0..1 RMS). */
export const SPEECH_RMS = 0.02;
export const PLAYING_RMS = 0.01;
/** The bot's audio quiet this long: it stopped speaking. Carl quiet this long after speaking: his turn is over. */
export const SPEAKING_HANG_MS = 400;
export const TURN_END_MS = 350;
/** "Thinking" never shows longer than this without audio (a turn that says nothing, a skipped turn). */
export const THINKING_MAX_MS = 20_000;
/** Barge-in, here on the device: Carl's voice above this (well above the echo the browser's canceller leaves) for
 *  BARGE_MS while the reply plays silences the reply at once — the box's own stop follows (VAD → cancel), but its
 *  audio already on the way would play for another ~0.4 s. If the box didn't take it as an interruption (a "yeah"),
 *  the reply comes back after RESUME_MS of his silence. */
export const BARGE_RMS = 0.05;
export const BARGE_MS = 75;
export const RESUME_MS = 900;
/** How often the levels are read. */
export const TICK_MS = 25;
/** The window his level is measured over: longer than a tick, so every sample counts. At 512 (10.7 ms read every
 *  25 ms) more than half his voice went unseen, a gap between syllables reset the barge-in clock, and the reply went
 *  silent late (replayed over the recorded questions: p90 0.36 s → 0.21 s at 2048; the same threshold and the same
 *  75 ms of voice, so a keyboard's 12 ms clicks still never count). The waves keep their own 512 analyser. */
export const LEVEL_FFT = 2048;

/** His voice, not a keyboard: the level above SPEECH_RMS in at least SPEECH_TICKS of the last SPEECH_WINDOW ticks
 *  (250 ms). Speech is loud nearly every tick; typing is short clicks (a tick or two each, 60–240 ms apart) and used to
 *  turn "thinking" on with no words at all (the roleplay: 22 s of keyboard clatter, "thinking" shown, nothing said). */
export const SPEECH_WINDOW = 10;
export const SPEECH_TICKS = 7;
/** Pure: the next window (a bit per tick, newest lowest) and whether it is his voice. */
export function voiced(bits: number, loud: boolean): { bits: number; voice: boolean } {
  const next = ((bits << 1) | (loud ? 1 : 0)) & ((1 << SPEECH_WINDOW) - 1);
  let n = 0;
  for (let b = next; b; b &= b - 1) n++;
  return { bits: next, voice: n >= SPEECH_TICKS };
}

/** A dropped connection is offered again once (on the same call: the box keeps it) before the call is given up;
 *  at most once a minute, and the new connection has this long to come up. */
export const RECONNECT_EVERY_MS = 60_000;
export const RECONNECT_MS = 10_000;

/** Pure: the call's mode from what the levels did and when. */
export function brainMode(s: { now: number; lastPlaying: number; lastSpeech: number; speechSince: number | null; thinkingSince: number | null }): BrainMode {
  if (s.now - s.lastPlaying < SPEAKING_HANG_MS) return "speaking";
  if (s.thinkingSince !== null && s.now - s.thinkingSince < THINKING_MAX_MS) return "thinking";
  return "listening";
}

function rms(a: Float32Array): number {
  let s = 0;
  for (const v of a) s += v * v;
  return Math.sqrt(s / Math.max(1, a.length));
}

export class BrainConversation {
  readonly callId: string;
  private pc: RTCPeerConnection;
  private mic: MediaStream;
  private ctx: AudioContext;
  private el: HTMLAudioElement;
  private inAn: AnalyserNode;
  /** His level, for barge-in and the call's mode (LEVEL_FFT). */
  private levelAn: AnalyserNode;
  private outAn: AnalyserNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ended = false;
  private mode: BrainMode = "listening";
  private lastPlaying = 0;
  private lastSpeech = 0;
  private speechSince: number | null = null;
  private thinkingSince: number | null = null;
  private muted = false;
  private volume = 1;
  /** The reply is silenced here because Carl started talking over it (local barge-in). */
  private ducked = false;
  private bargeSince: number | null = null;
  /** The last SPEECH_WINDOW ticks of his level (voiced()). */
  private loudBits = 0;
  /** Offering the dropped connection again (reconnect), and when that last happened. */
  private reconnecting = false;
  private reconnectAt = -Infinity;

  private constructor(
    private o: BrainOptions,
    private d: BrainDeps,
    parts: { callId: string; pc: RTCPeerConnection; mic: MediaStream; ctx: AudioContext; el: HTMLAudioElement; inAn: AnalyserNode; levelAn: AnalyserNode },
  ) {
    this.callId = parts.callId;
    this.pc = parts.pc;
    this.mic = parts.mic;
    this.ctx = parts.ctx;
    this.el = parts.el;
    this.inAn = parts.inAn;
    this.levelAn = parts.levelAn;
  }

  /** Open the mic, start the call on the box, connect. Throws (a refused mic, the box's error) and leaves nothing open. */
  static async start(o: BrainOptions): Promise<BrainConversation> {
    const d = { ...defaultDeps(), ...(o.deps ?? {}) };
    const t0 = d.now();
    const mic = await d.getUserMedia({
      audio: { ...(o.inputDeviceId ? { deviceId: { exact: o.inputDeviceId } } : {}), echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    let pc: RTCPeerConnection | null = null;
    let ctx: AudioContext | null = null;
    try {
      ctx = d.audioContext();
      void ctx.resume?.().catch(() => {});
      const inAn = ctx.createAnalyser();
      inAn.fftSize = 512;
      const levelAn = ctx.createAnalyser();
      levelAn.fftSize = LEVEL_FFT;
      const src = ctx.createMediaStreamSource(mic);
      src.connect(inAn);
      src.connect(levelAn);
      const el = d.audioElement();
      if (o.outputDeviceId && typeof (el as any).setSinkId === "function") await (el as any).setSinkId(o.outputDeviceId).catch(() => {});
      pc = d.peer();
      for (const t of mic.getAudioTracks()) pc.addTrack(t, mic);
      const call = await o.post("/api/v1/brain/call", { convId: o.convId, device: o.device });
      if (!call?.callId) throw new Error(call?.error ?? "the box did not start the call");
      const conv = new BrainConversation(o, d, { callId: String(call.callId), pc, mic, ctx, el, inAn, levelAn });
      conv.wire();
      await pc.setLocalDescription(await pc.createOffer());
      // All candidates in the offer (no trickle): the tailnet address is among them.
      await new Promise<void>((res) => {
        if (pc!.iceGatheringState === "complete") return res();
        const done = () => pc!.iceGatheringState === "complete" && res();
        pc!.addEventListener("icegatheringstatechange", done);
        setTimeout(res, 2000);
      });
      const ans = await o.post("/api/v1/brain/offer", { callId: conv.callId, sdp: pc.localDescription!.sdp, type: pc.localDescription!.type });
      if (!ans?.sdp) {
        await o.post(`/api/v1/brain/call/${encodeURIComponent(conv.callId)}/end`, {}).catch(() => {});
        throw new Error(ans?.error ?? "the box's voice pipeline did not answer");
      }
      await pc.setRemoteDescription({ sdp: ans.sdp, type: ans.type });
      o.log?.("voice brain offer", { ms: d.now() - t0, model: call.model ?? null });
      return conv;
    } catch (e) {
      for (const t of mic.getTracks()) t.stop();
      pc?.close();
      void ctx?.close?.().catch(() => {});
      throw e;
    }
  }

  private wire(): void {
    this.wirePeer(this.pc);
    const buf = new Float32Array(512);
    const lbuf = new Float32Array(LEVEL_FFT);
    this.timer = setInterval(() => this.tick(buf, lbuf), TICK_MS);
  }

  private wirePeer(pc: RTCPeerConnection): void {
    pc.ontrack = (ev) => {
      const stream = ev.streams[0] ?? new MediaStream([ev.track]);
      this.el.srcObject = stream;
      void this.el.play().catch((e) => this.o.log?.("voice brain play", { error: String((e as Error)?.message ?? e).slice(0, 200) }));
      const an = this.ctx.createAnalyser();
      an.fftSize = 512;
      this.ctx.createMediaStreamSource(stream).connect(an);
      this.outAn = an;
    };
    let lostAt: number | null = null;
    pc.onconnectionstatechange = () => {
      // A connection this call replaced (reconnect) closing is not the call's.
      if (pc !== this.pc) return;
      const s = pc.connectionState;
      this.o.log?.("voice brain connection", { state: s });
      if (s === "connected") {
        lostAt = null;
        if (this.reconnecting) this.o.log?.("voice brain reconnected", { ms: this.d.now() - this.reconnectAt });
        this.reconnecting = false;
        this.o.onConnect?.();
      } else if (s === "failed" || s === "closed") {
        this.lost(s);
      } else if (s === "disconnected") {
        // WebRTC often recovers a short drop by itself: give it 5 s.
        lostAt = this.d.now();
        setTimeout(() => pc === this.pc && lostAt !== null && pc.connectionState === "disconnected" && this.lost("disconnected"), 5000);
      }
    };
  }

  private tick(buf: Float32Array, lbuf: Float32Array): void {
    if (this.ended) return;
    const now = this.d.now();
    if (this.outAn) {
      this.outAn.getFloatTimeDomainData(buf);
      if (rms(buf) > PLAYING_RMS) {
        this.lastPlaying = now;
        this.thinkingSince = null;
      }
    }
    if (!this.muted) {
      this.levelAn.getFloatTimeDomainData(lbuf);
      const level = rms(lbuf);
      // Local barge-in: he talks over the reply → it goes silent now, not when the box's stop arrives.
      const playing = now - this.lastPlaying < SPEAKING_HANG_MS;
      if (playing && level > BARGE_RMS) {
        this.bargeSince ??= now;
        if (!this.ducked && now - this.bargeSince >= BARGE_MS) {
          this.ducked = true;
          this.el.volume = 0;
          this.o.log?.("voice brain barge-in", { level: Math.round(level * 1000) / 1000 });
        }
      } else if (level <= BARGE_RMS) this.bargeSince = null;
      if (this.ducked) {
        if (level > SPEECH_RMS) this.lastSpeech = now;
        // The reply stopped (the box took the interruption), or he stopped and it went on (it didn't): sound back.
        if (!playing || now - this.lastSpeech >= RESUME_MS) {
          this.ducked = false;
          this.el.volume = this.volume;
        }
      }
      const v = voiced(this.loudBits, level > SPEECH_RMS);
      this.loudBits = v.bits;
      if (v.voice && (!playing || this.ducked)) {
        this.speechSince ??= now;
        this.lastSpeech = now;
        this.thinkingSince = null;
      } else if (this.speechSince !== null && now - this.lastSpeech >= TURN_END_MS) {
        // He spoke and stopped: until the reply plays, the box is working on it.
        this.speechSince = null;
        this.thinkingSince = now;
      }
    }
    const m = brainMode({ now, lastPlaying: this.lastPlaying, lastSpeech: this.lastSpeech, speechSince: this.speechSince, thinkingSince: this.thinkingSince });
    if (m !== this.mode) {
      this.mode = m;
      this.o.onMode?.(m);
    }
  }

  private lost(reason: string): void {
    if (this.ended || this.reconnecting) return;
    // A blip (the network, the box's media path): offer the connection again on the same call before giving it up.
    if (this.d.now() - this.reconnectAt >= RECONNECT_EVERY_MS) {
      void this.reconnect(reason);
      return;
    }
    this.giveUp(reason);
  }

  private giveUp(reason: string): void {
    if (this.ended) return;
    this.teardown();
    this.o.onDisconnect?.({ reason: "error", message: `the call's connection ${reason}` });
  }

  /** A new connection for the same call: the mic's track, a new offer; the box swaps its media path (bot.py). */
  private async reconnect(reason: string): Promise<void> {
    this.reconnecting = true;
    this.reconnectAt = this.d.now();
    this.o.log?.("voice brain reconnect", { reason });
    const old = this.pc;
    try {
      const pc = this.d.peer();
      for (const t of this.mic.getAudioTracks()) pc.addTrack(t, this.mic);
      this.pc = pc;
      try {
        old.close();
      } catch {
        /* closed */
      }
      this.wirePeer(pc);
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise<void>((res) => {
        if (pc.iceGatheringState === "complete") return res();
        pc.addEventListener("icegatheringstatechange", () => pc.iceGatheringState === "complete" && res());
        setTimeout(res, 2000);
      });
      const ans = await this.o.post("/api/v1/brain/offer", { callId: this.callId, sdp: pc.localDescription!.sdp, type: pc.localDescription!.type });
      if (!ans?.sdp) throw new Error(ans?.error ?? "no answer");
      await pc.setRemoteDescription({ sdp: ans.sdp, type: ans.type });
      setTimeout(() => {
        if (this.reconnecting && pc === this.pc) {
          this.reconnecting = false;
          this.giveUp(`${reason} (it did not come back)`);
        }
      }, RECONNECT_MS);
    } catch (e) {
      this.reconnecting = false;
      this.giveUp(`${reason} (reconnect: ${String((e as Error)?.message ?? e).slice(0, 120)})`);
    }
  }

  private teardown(): void {
    this.ended = true;
    if (this.timer) clearInterval(this.timer);
    for (const t of this.mic.getTracks()) t.stop();
    try {
      this.pc.close();
    } catch {
      /* closed */
    }
    this.el.srcObject = null;
    void this.ctx.close?.().catch(() => {});
  }

  get isEnded(): boolean {
    return this.ended;
  }

  getMode(): BrainMode {
    return this.mode;
  }

  /** Mute: the mic's track is disabled, so nothing leaves the device (the box still speaks a result). */
  setMicMuted(muted: boolean): void {
    this.muted = muted;
    for (const t of this.mic.getAudioTracks()) t.enabled = !muted;
  }

  setVolume(o: { volume: number }): void {
    this.volume = Math.max(0, Math.min(1, o.volume));
    if (!this.ducked) this.el.volume = this.volume;
  }

  /** What is audible from the reply now (its level × the element's volume): the waves, and the barge-in measure. */
  audibleVolume(): number {
    return this.getOutputVolume() * (this.ducked ? 0 : this.el.volume);
  }

  async setOutputDevice(id: string): Promise<void> {
    if (typeof (this.el as any).setSinkId === "function") await (this.el as any).setSinkId(id);
  }

  getInputByteFrequencyData(): Uint8Array {
    const a = new Uint8Array(this.inAn.frequencyBinCount);
    if (!this.muted) this.inAn.getByteFrequencyData(a);
    return a;
  }

  getOutputByteFrequencyData(): Uint8Array {
    const an = this.outAn;
    const a = new Uint8Array(an?.frequencyBinCount ?? 256);
    // Silenced by a barge-in: the waves go flat with it (never waves over silence).
    if (!this.ducked) an?.getByteFrequencyData(a);
    return a;
  }

  getInputVolume(): number {
    const a = new Float32Array(this.inAn.fftSize);
    this.inAn.getFloatTimeDomainData(a);
    return this.muted ? 0 : rms(a);
  }

  getOutputVolume(): number {
    if (!this.outAn) return 0;
    const a = new Float32Array(this.outAn.fftSize);
    this.outAn.getFloatTimeDomainData(a);
    return rms(a);
  }

  /** The pinned mic moved (voiceMic.ts): the call's track is replaced in place, no renegotiation. */
  async changeInputDevice(o: { inputDeviceId?: string }): Promise<void> {
    const next = await this.d.getUserMedia({ audio: { ...(o.inputDeviceId ? { deviceId: { exact: o.inputDeviceId } } : {}), echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const track = next.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !this.muted;
    const sender = this.pc.getSenders().find((s) => s.track?.kind === "audio");
    await sender?.replaceTrack(track);
    for (const t of this.mic.getTracks()) t.stop();
    this.mic = next;
    const src = this.ctx.createMediaStreamSource(next);
    src.connect(this.inAn);
    src.connect(this.levelAn);
  }

  async changeOutputDevice(o: { outputDeviceId?: string }): Promise<void> {
    if (o.outputDeviceId) await this.setOutputDevice(o.outputDeviceId);
  }

  // What the Classic client pushed into ElevenLabs' own agent has no place here: pi already has the conversation, the
  // "you" layer and the screens (server side). These stay as no-ops so shared code paths can't break a call.
  sendContextualUpdate(_text: string): void {}
  sendUserMessage(_text: string): void {
    this.o.log?.("voice brain ignored", { what: "sendUserMessage" });
  }
  sendMultimodalMessage(_m: { text?: string; fileId: string }): void {}
  async uploadFile(_blob: Blob): Promise<{ fileId: string }> {
    throw new Error("not used by the New voice (pi reads images from the conversation)");
  }

  /** The mic stream (the clients' health and pin watchers read its track). */
  micStream(): MediaStream {
    return this.mic;
  }

  /** End the call here and on the box. */
  async endSession(): Promise<void> {
    if (this.ended) return;
    this.teardown();
    await this.o.post(`/api/v1/brain/call/${encodeURIComponent(this.callId)}/end`, {}).catch(() => {});
  }
}

/** The box's voice engine (Settings → Voice engine, kept on the box so every device follows it). */
export type VoiceEngine = "classic" | "new";
export const voiceEngineOf = (x: unknown): VoiceEngine => (x === "new" ? "new" : "classic");
