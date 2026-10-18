// Voice's transport and health (Carl, 2026-10-18: "the waves move but I hear
// nothing, then my mic disconnects"; "vault-chat doesn't hear my mic").
//   - WebRTC (ElevenLabs' recommended transport, its echo cancellation and
//     jitter buffer) with the box's conversation token; WebSocket on Linux and
//     as the fallback when WebRTC can't connect.
//   - One mic stream, the SDK's: no getUserMedia of ours.
//   - The mic re-acquired once through the SDK when its track ends; a second
//     loss is one plain line.
//   - Every close logged with its reason.
//   - "Waves but silence" (audio arriving, nothing audible for 2 s) detected.
//   - firstResponseMs from the end of Carl's speech to the first audible audio.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const vault = makeTempVault("vc-voicehealth-");
const fake = installFakeTauri(vault);

let sessionBody: Record<string, unknown> = {};
fake.setHandler("vault_box_config", ({ vault: v }) => (v === vault ? { box: "http://127.0.0.1:9", vault: "v" } : null));
fake.setHandler("box_get_json", async ({ url }) =>
  String(url).includes("/api/v1/voice/session") ? { status: 200, body: JSON.stringify(sessionBody) } : { status: 200, body: "{}" },
);
const boxLines: string[] = [];
fake.setHandler("box_post_json", async ({ url, body }) => {
  if (String(url).includes("/api/v1/voice/transcript")) boxLines.push(String(JSON.parse(body).text ?? ""));
  return { status: 200, body: JSON.stringify({ ok: true, convId: "box-voice-1" }) };
});

const H = await import("../../src/voiceHealth.ts");
const { useStore } = await import("../../src/store.ts");
const voice = await import("../../src/voice-elevenlabs.ts");

// ---- a mocked ElevenLabs SDK -------------------------------------------------
class FakeTrack extends EventTarget {
  readyState = "live";
  label = "Headset Microphone (Jabra)";
  getSettings() {
    return { deviceId: "dev-jabra-0001", echoCancellation: true };
  }
  end() {
    this.readyState = "ended";
    this.dispatchEvent(new Event("ended"));
  }
}
type Started = { opts: any; conv: any; track: FakeTrack };
let started: Started[] = [];
let failNext: Error | null = null;
let level = { input: 0.2, output: 0 };
const sdk = {
  async startSession(opts: any) {
    if (failNext) {
      const e = failNext;
      failNext = null;
      throw e;
    }
    const track = new FakeTrack();
    const room = { canPlaybackAudio: true, localParticipant: { getTrackPublication: () => ({ track: { mediaStreamTrack: track } }) }, on() {}, off() {} };
    const conv: any = {
      connection: { getRoom: () => room },
      deviceSwitches: [] as unknown[],
      async changeInputDevice(c: unknown) {
        conv.deviceSwitches.push(c);
        if (conv.failSwitch) throw new Error("NotReadableError: device in use");
      },
      getInputVolume: () => level.input,
      getOutputVolume: () => level.output,
      getInputByteFrequencyData: () => new Uint8Array(32),
      getOutputByteFrequencyData: () => new Uint8Array(32),
      setMicMuted() {},
      setVolume() {},
      sendUserMessage() {},
      sendContextualUpdate() {},
      sendMultimodalMessage() {},
      async uploadFile() {
        return { fileId: "f" };
      },
      async endSession() {
        opts.onDisconnect?.({ reason: "user" });
      },
    };
    started.push({ opts, conv, track });
    opts.onConnect?.({ conversationId: "conv_fake" });
    return conv;
  },
};

const logs = () => JSON.parse(localStorage.getItem("vc_debug_buf") ?? "[]") as { tag: string; data?: any }[];
const tagged = (t: string) => logs().filter((e) => e.tag === t);
// Box mode: the call's lines go to the box's voice conversation.
const lines = () => boxLines;
const tick = () => new Promise((r) => setTimeout(r, 0));

before(() => {
  voice.setVoiceSdkForTests(sdk);
  useStore.setState({ vaultPath: vault, serviceKeys: {} } as any);
});
after(() => voice.setVoiceSdkForTests(null));

async function startCall(body: Record<string, unknown>): Promise<Started> {
  sessionBody = { systemPrompt: "prompt", toolNames: [], voiceId: "v1", ...body };
  started = [];
  await voice.startElevenLabsSession();
  await tick();
  assert.ok(voice.isVoiceSessionActive(), "the call is live");
  return started[started.length - 1]!;
}

// ---- pure: the transport ----------------------------------------------------
test("transport: WebRTC with a token, WebSocket on Linux webviews or with only a signed URL", () => {
  const win = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
  const linux = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15";
  assert.equal(H.pickTransport({ ua: win, hasToken: true, hasSignedUrl: true }), "webrtc");
  assert.equal(H.pickTransport({ ua: linux, hasToken: true, hasSignedUrl: true }), "websocket");
  assert.equal(H.pickTransport({ ua: win, hasToken: false, hasSignedUrl: true }), "websocket");
  assert.equal(H.pickTransport({ ua: win, override: "websocket", hasToken: true, hasSignedUrl: true }), "websocket");
  assert.equal(H.pickTransport({ ua: win, hasToken: false, hasSignedUrl: false }), null);
  assert.deepEqual(H.connectionOptions("webrtc", { conversationToken: "t", signedUrl: "wss://x", inputDeviceId: "" }), { conversationToken: "t", connectionType: "webrtc" });
  assert.deepEqual(H.connectionOptions("websocket", { conversationToken: "t", signedUrl: "wss://x", inputDeviceId: "mic-2" }), {
    signedUrl: "wss://x",
    connectionType: "websocket",
    inputDeviceId: "mic-2",
  });
});

// ---- pure: the detectors ----------------------------------------------------
test("health: a mic that reads zero for 10 s is dead (not while muted); speech with no transcript is unheard", () => {
  const ev: any[] = [];
  const h = new H.VoiceHealth((e) => ev.push(e));
  h.connected(0);
  for (let t = 100; t <= 9_900; t += 100) h.sample({ now: t, input: 0, output: 0, muted: false, speaking: false });
  assert.equal(ev.length, 0);
  h.sample({ now: 10_000, input: 0, output: 0, muted: false, speaking: false });
  assert.deepEqual(ev.map((e) => e.kind), ["mic-dead"]);

  const ev2: any[] = [];
  const m = new H.VoiceHealth((e) => ev2.push(e));
  m.connected(0);
  for (let t = 100; t <= 20_000; t += 100) m.sample({ now: t, input: 0, output: 0, muted: true, speaking: false });
  assert.equal(ev2.length, 0, "a muted mic is silent on purpose");

  const ev3: any[] = [];
  const u = new H.VoiceHealth((e) => ev3.push(e));
  u.connected(0);
  // Carl talks for 3 s; nothing comes back.
  for (let t = 100; t <= 3_000; t += 100) u.sample({ now: t, input: 0.3, output: 0, muted: false, speaking: false });
  for (let t = 3_100; t <= 11_000; t += 100) u.sample({ now: t, input: 0.01, output: 0, muted: false, speaking: false });
  assert.deepEqual(ev3.map((e) => e.kind), ["mic-unheard"]);
  assert.ok(ev3[0].speechMs >= 2_500);
});

test("health: audio arriving with nothing audible for 2 s is 'waves but silence'; the first audible audio is timed from speech end", () => {
  const ev: any[] = [];
  const h = new H.VoiceHealth((e) => ev.push(e));
  h.connected(0);
  // Carl speaks until 2 000 ms.
  for (let t = 100; t <= 2_000; t += 100) h.sample({ now: t, input: 0.3, output: 0, muted: false, speaking: false });
  h.sample({ now: 2_100, input: 0.01, output: 0, muted: false, speaking: false });
  assert.equal(h.userTranscript(2_400), 2_000, "the transcript knows when he stopped");
  // Audio arrives from 2 500 but plays nothing.
  for (let t = 2_500; t <= 4_600; t += 100) {
    h.audioReceived(t);
    h.sample({ now: t, input: 0, output: 0, muted: false, speaking: true });
  }
  assert.deepEqual(ev.map((e) => e.kind), ["silent-playback"]);
  // Then it plays.
  h.audioReceived(4_700);
  h.sample({ now: 4_700, input: 0, output: 0.3, muted: false, speaking: true });
  assert.deepEqual(ev.map((e) => e.kind), ["silent-playback", "first-audio", "playback-resumed"]);
  assert.equal(ev[1].at, 4_700);
  // A blocked audio element counts as silent even when the track has level.
  const ev2: any[] = [];
  const b = new H.VoiceHealth((e) => ev2.push(e));
  b.connected(0);
  for (let t = 100; t <= 2_300; t += 100) {
    b.audioReceived(t);
    b.sample({ now: t, input: 0.1, output: 0.4, muted: false, speaking: true, playbackBlocked: true });
  }
  assert.deepEqual(ev2.map((e) => e.kind), ["silent-playback"]);
});

// ---- the session, on a mocked SDK -------------------------------------------
test("start: WebRTC with the box's conversation token, the picked mic, no mic stream of ours", async () => {
  const g = globalThis as any;
  const realMd = g.navigator?.mediaDevices;
  let ours = 0;
  try {
    Object.defineProperty(g.navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => (ours++, { getTracks: () => [] }) } });
  } catch {
    /* node without a navigator: nothing of ours could call it anyway */
  }
  Object.defineProperty(g.navigator, "userAgent", { configurable: true, value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" });
  localStorage.setItem(voice.VOICE_INPUT_STORAGE, "dev-usb-mic");
  try {
    const s = await startCall({ conversationToken: "tok_123", signedUrl: "wss://signed" });
    assert.equal(s.opts.connectionType, "webrtc");
    assert.equal(s.opts.conversationToken, "tok_123");
    assert.equal(s.opts.signedUrl, undefined, "one credential: the SDK refuses signedUrl with webrtc");
    assert.equal(s.opts.inputDeviceId, "dev-usb-mic");
    assert.equal(ours, 0, "the SDK owns the only mic stream");
    const connected = tagged("voice connected").pop()!;
    assert.equal(connected.data.transport, "webrtc");
    assert.equal(tagged("voice mic").pop()!.data.mic, "Headset Microphone (Jabra)", "the captured device is logged");
    await voice.endElevenLabsSession();
  } finally {
    localStorage.removeItem(voice.VOICE_INPUT_STORAGE);
    if (realMd !== undefined) Object.defineProperty(g.navigator, "mediaDevices", { configurable: true, value: realMd });
  }
});

test("start: WebRTC that can't connect falls back to WebSocket once", async () => {
  failNext = new Error("could not establish pc connection");
  const s = await startCall({ conversationToken: "tok_123", signedUrl: "wss://signed" });
  assert.equal(s.opts.connectionType, "websocket");
  assert.equal(s.opts.signedUrl, "wss://signed");
  assert.equal(tagged("voice transport fallback").length, 1);
  await voice.endElevenLabsSession();
});

test("the mic track ending is re-acquired once through the SDK; a second loss says one plain line", async () => {
  const s = await startCall({ conversationToken: "tok_123", signedUrl: "wss://signed" });
  try {
  s.track.end();
  await tick();
  await tick();
  assert.deepEqual(s.conv.deviceSwitches, [{ inputDeviceId: "default" }]);
  assert.equal(tagged("voice mic reacquired").length, 1);
  assert.ok(!lines().includes(voice.MIC_UNHEARD_LINE));
  // It goes again.
  s.track.readyState = "live";
  s.track.end();
  await tick();
  await tick();
  assert.equal(s.conv.deviceSwitches.length, 1, "re-acquired once a call");
  assert.ok(lines().includes(voice.MIC_UNHEARD_LINE));
  } finally {
    await voice.endElevenLabsSession();
  }
});

test("every close is logged with its reason and code", async () => {
  const s = await startCall({ conversationToken: "tok_123", signedUrl: "wss://signed" });
  s.opts.onDisconnect({ reason: "error", message: "LiveKit connection state changed to disconnected", context: { type: "connection_state_changed", code: 1006 } });
  await tick();
  const c = tagged("voice closed").pop()!;
  assert.equal(c.data.reason, "error");
  assert.equal(c.data.message, "LiveKit connection state changed to disconnected");
  assert.equal(c.data.closeCode, 1006);
  assert.equal(c.data.transport, "webrtc");
  assert.equal(voice.isVoiceSessionActive(), false);
  // Ours too (it used to leave no line at all).
  const s2 = await startCall({ conversationToken: "tok_123", signedUrl: "wss://signed" });
  await voice.endElevenLabsSession();
  assert.equal(tagged("voice closed").pop()!.data.reason, "user");
  void s2;
});

test("firstResponseMs runs from the end of Carl's speech to the first audible agent audio", async () => {
  const realNow = Date.now;
  // Ahead of the real clock (the log persists on a forward clock).
  let now = realNow() + 60_000;
  Date.now = () => now;
  try {
    const s = await startCall({ conversationToken: "tok_123", signedUrl: "wss://signed" });
    // He speaks for a second, stops; the transcript lands 400 ms later.
    level = { input: 0.3, output: 0 };
    for (let i = 0; i < 10; i++) {
      now += 100;
      voice.sampleVoiceHealthForTests();
    }
    const spokeUntil = now;
    level = { input: 0.01, output: 0 };
    now += 400;
    voice.sampleVoiceHealthForTests();
    s.opts.onMessage({ role: "user", message: "what's on page two" });
    s.opts.onMessage({ role: "agent", message: "Page two is the proof." });
    // Audio is audible 900 ms after he stopped.
    now = spokeUntil + 900;
    level = { input: 0.01, output: 0.3 };
    voice.sampleVoiceHealthForTests();
    const turn = tagged("voice turn").pop()!;
    assert.equal(turn.data.firstAudioMs, 900);
    assert.equal(turn.data.firstResponseMs, 400, "the line came first, when the transcript landed");
    assert.equal(turn.data.via, "text");
    assert.equal(turn.data.from, "speech-end");
    assert.equal(turn.data.transcriptToAudioMs, 500);
    await voice.endElevenLabsSession();
  } finally {
    Date.now = realNow;
    level = { input: 0.2, output: 0 };
  }
});
