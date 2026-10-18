// The voice call's health, from the SDK's own meters (one mic stream, the
// SDK's; nothing here opens audio). Carl's reports: "the waves move but I hear
// nothing, then my mic disconnects", and "vault-chat doesn't hear my mic". The
// app log could not say which: sessions opened and closed with no reason, no
// level, no device. This watches what the SDK exposes, sampled ~10×/s:
//   - mic-dead:      the SDK's input level reads exactly zero for 10 s (the
//                    track ended, a device switch, exclusive mode) — re-acquire;
//   - mic-unheard:   Carl's level says he spoke (≥ 2.5 s of speech) but no
//                    transcript came back 8 s after he stopped — ElevenLabs is
//                    not receiving what the meter sees. Only when nothing of
//                    his was heard since the call connected, or nothing for a
//                    long span (90 s, no transcript and no agent audio) while
//                    the meter saw ≥ 15 s of speech: never in a working
//                    conversation, where a transcript can come late (Carl
//                    talking over a slow tool call) and the meter's "speech"
//                    can be a noisy room the transcriber rightly ignores;
//   - silent-playback: agent audio is arriving but the output level stays at
//                    zero for 2 s — "waves but silence";
//   - first-audio:   the first moment the agent is audible after Carl's turn
//                    (firstResponseMs, measured from the end of his speech).
// Pure: the caller feeds samples and acts on the events.

export type Transport = "webrtc" | "websocket";

/** WebRTC (ElevenLabs' recommended transport) wherever the webview can play it;
 *  WebSocket on Linux (WebKitGTK plays the agent natively, src-tauri) or when
 *  only a signed URL exists. `override` ("webrtc" | "websocket") wins when its
 *  credential exists. */
export function pickTransport(o: { ua: string; override?: string | null; hasToken: boolean; hasSignedUrl: boolean }): Transport | null {
  if (o.override === "websocket" && o.hasSignedUrl) return "websocket";
  if (o.override === "webrtc" && o.hasToken) return "webrtc";
  const linuxWebview = /Linux/.test(o.ua) && !/Android/.test(o.ua);
  if (!linuxWebview && o.hasToken) return "webrtc";
  if (o.hasSignedUrl) return "websocket";
  return o.hasToken ? "webrtc" : null;
}

/** The SDK's start options for the transport (its credential; the mic is the system default). */
export function connectionOptions(t: Transport, c: { conversationToken?: string | null; signedUrl?: string | null }): Record<string, unknown> {
  return t === "webrtc" ? { conversationToken: c.conversationToken, connectionType: "webrtc" } : { signedUrl: c.signedUrl, connectionType: "websocket" };
}

export type HealthEvent =
  | { kind: "mic-dead"; ms: number }
  | { kind: "mic-unheard"; speechMs: number; waitedMs: number }
  | { kind: "silent-playback"; ms: number }
  | { kind: "playback-resumed"; silentMs: number }
  | { kind: "first-audio"; at: number };

export type HealthSample = {
  now: number;
  /** The SDK's input level, 0..1 (getInputVolume). */
  input: number;
  /** The SDK's output level, 0..1 (getOutputVolume). */
  output: number;
  /** Carl's mic is muted on purpose (typed panel): no mic verdicts. */
  muted: boolean;
  /** The SDK's mode: "speaking" while the agent talks. */
  speaking: boolean;
  /** Something blocks playback the SDK's meter can't see (a paused audio element): counts as silent. */
  playbackBlocked?: boolean;
};

export const SPEECH_LEVEL = 0.04;
export const PLAYING_LEVEL = 0.01;

export class VoiceHealth {
  private live = false;
  private lastNonZeroInput = 0;
  private micDeadSaid = false;
  private speechMs = 0;
  private lastSample = 0;
  private lastSpeechAt = 0;
  private unheardSaid = false;
  /** Carl's last transcript (null: none since the call connected). */
  private heardAt: number | null = null;
  private lastAudioAt = 0;
  private silentSince: number | null = null;
  private silentSaid = false;
  private waitingForAudio = false;
  private playingSince: number | null = null;

  constructor(
    private readonly emit: (e: HealthEvent) => void,
    private readonly cfg = { deadMs: 10_000, unheardSpeechMs: 2_500, unheardWaitMs: 8_000, silentMs: 2_000, receivingMs: 500, heardLongMs: 90_000, unheardLongSpeechMs: 15_000 },
  ) {}

  connected(now: number): void {
    this.live = true;
    this.lastNonZeroInput = now;
    this.lastSample = now;
    this.micDeadSaid = false;
    this.speechMs = 0;
    this.lastSpeechAt = 0;
    this.unheardSaid = false;
    this.heardAt = null;
    this.lastAudioAt = 0;
    this.silentSince = null;
    this.silentSaid = false;
    this.waitingForAudio = false;
    this.playingSince = null;
  }

  /** The mic was re-acquired: "unheard" starts over ("dead" is said once a call:
   *  a very quiet room under noise suppression can read zero too). */
  micReset(now: number): void {
    this.lastNonZeroInput = now;
    this.speechMs = 0;
    this.unheardSaid = false;
  }

  /** Agent audio arrived (a chunk over WebSocket, the track's capture over WebRTC). */
  audioReceived(now: number): void {
    this.lastAudioAt = now;
  }

  /** Carl's final transcript landed: ElevenLabs heard him. Returns when his speech ended (null: the meter never saw it). */
  userTranscript(now: number): number | null {
    const end = this.lastSpeechAt && now - this.lastSpeechAt < 20_000 ? this.lastSpeechAt : null;
    this.heardAt = now;
    this.speechMs = 0;
    this.unheardSaid = false;
    // Audio may already be playing (a speculative reply): that moment counts.
    if (this.playingSince !== null && end !== null && this.playingSince >= end) this.emit({ kind: "first-audio", at: this.playingSince });
    else this.waitingForAudio = true;
    return end;
  }

  /** Speech the meter saw, no transcript for it: before he was ever heard this call, or over a long deaf span. */
  private unheard(now: number): boolean {
    if (this.speechMs < this.cfg.unheardSpeechMs || !this.lastSpeechAt || now - this.lastSpeechAt < this.cfg.unheardWaitMs) return false;
    if (this.heardAt === null) return true;
    const lastSign = Math.max(this.heardAt, this.lastAudioAt);
    return now - lastSign >= this.cfg.heardLongMs && this.speechMs >= this.cfg.unheardLongSpeechMs;
  }

  sample(s: HealthSample): void {
    const dt = Math.max(0, Math.min(s.now - this.lastSample, 1_000));
    this.lastSample = s.now;
    if (!this.live) return;
    // The mic.
    if (s.muted || s.input > 0) this.lastNonZeroInput = s.now;
    if (!this.micDeadSaid && s.now - this.lastNonZeroInput >= this.cfg.deadMs) {
      this.micDeadSaid = true;
      this.emit({ kind: "mic-dead", ms: s.now - this.lastNonZeroInput });
    }
    if (!s.muted && !s.speaking && s.input >= SPEECH_LEVEL) {
      this.speechMs += dt;
      this.lastSpeechAt = s.now;
    }
    if (!this.unheardSaid && this.unheard(s.now)) {
      this.unheardSaid = true;
      this.emit({ kind: "mic-unheard", speechMs: Math.round(this.speechMs), waitedMs: s.now - this.lastSpeechAt });
      this.speechMs = 0;
    }
    // The speaker.
    const audible = s.output >= PLAYING_LEVEL && !s.playbackBlocked;
    if (audible) {
      if (this.playingSince === null || (this.lastSpeechAt && this.playingSince < this.lastSpeechAt)) this.playingSince = s.now;
      if (this.waitingForAudio) {
        this.waitingForAudio = false;
        this.emit({ kind: "first-audio", at: s.now });
      }
    } else if (s.output < PLAYING_LEVEL) this.playingSince = null;
    const receiving = this.lastAudioAt > 0 && s.now - this.lastAudioAt <= this.cfg.receivingMs;
    if (receiving && !audible) {
      if (this.silentSince === null) this.silentSince = s.now;
      if (!this.silentSaid && s.now - this.silentSince >= this.cfg.silentMs) {
        this.silentSaid = true;
        this.emit({ kind: "silent-playback", ms: s.now - this.silentSince });
      }
    } else if (audible && this.silentSince !== null) {
      if (this.silentSaid) this.emit({ kind: "playback-resumed", silentMs: s.now - this.silentSince });
      this.silentSince = null;
      this.silentSaid = false;
    } else if (!receiving) {
      this.silentSince = null;
      this.silentSaid = false;
    }
  }
}
