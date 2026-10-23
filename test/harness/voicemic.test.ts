// The call's audio devices pinned, and the agent's audio measured on its way in
// (Carl, 2026-10-21: "it suddenly stops hearing me"; "I stop hearing the voice,
// but the waves keep going"; "the voice is gone, then it glitches back to
// normal towards the end of the sentence"). His laptop log: 19 device changes
// mid-call, Windows flipping "Default - …" / "Communications - …" between the
// Intel array and the Realtek mic.
//   - The call opens on the physical devices behind "default" (inputDeviceId /
//     outputDeviceId) and stays there through default/communications switches.
//   - Unplugged: the best remaining device, the call going on.
//   - A mic track that ended re-acquires the same device.
//   - Safari/iOS (no virtual default listed): nothing pinned.
//   - A suspended playback context: the pill warns, and a tap resumes it (logged).
//   - Dropouts classified from the inbound WebRTC stats: network, source, local.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { installFakeTauri, makeTempVault } from "./fakes.ts";
import { MicPin, micFor, resolveVirtualMic, type MicDevice } from "../../src/voiceMic.ts";
import { DropoutWatch, PlaybackMonitor, readInbound, type Dropout, type InboundAudio } from "../../src/voiceStats.ts";
import { VoiceController, type SessionOpts, type VoiceConv } from "../../board/src/voice.ts";

// ---- Carl's Windows devices -------------------------------------------------
const INTEL: MicDevice = { deviceId: "intel-mic", groupId: "g-intel", label: "Microphone Array (Intel® Smart Sound Technology for Digital Microphones)", kind: "audioinput" };
const REALTEK: MicDevice = { deviceId: "rtk-mic", groupId: "g-rtk", label: "Microphone (Realtek(R) Audio)", kind: "audioinput" };
const SPEAKERS: MicDevice = { deviceId: "spk", groupId: "g-rtk", label: "Speakers (Realtek(R) Audio)", kind: "audiooutput" };
const HEADSET: MicDevice = { deviceId: "jabra-out", groupId: "g-jabra", label: "Headset Earphone (Jabra Evolve2)", kind: "audiooutput" };
const role = (r: "default" | "communications", d: MicDevice): MicDevice => ({ ...d, deviceId: r, label: `${r === "default" ? "Default" : "Communications"} - ${d.label}` });
/** Windows' listing: the virtual entries first, pointing at `def` / `comm`. */
const windows = (o: { def: MicDevice; comm: MicDevice; inputs?: MicDevice[]; outDef?: MicDevice; outComm?: MicDevice; outputs?: MicDevice[] }): MicDevice[] => [
  role("default", o.def),
  role("communications", o.comm),
  ...(o.inputs ?? [INTEL, REALTEK]),
  ...(o.outDef ? [role("default", o.outDef), role("communications", o.outComm ?? o.outDef)] : []),
  ...(o.outputs ?? (o.outDef ? [SPEAKERS, HEADSET] : [])),
];

class FakeMediaDevices extends EventTarget {
  constructor(public list: MicDevice[]) {
    super();
  }
  async enumerateDevices() {
    return this.list.map((d) => ({ ...d, toJSON() {} })) as unknown as MediaDeviceInfo[];
  }
  /** The system changed its devices: the new listing, then the event. */
  change(list: MicDevice[]) {
    this.list = list;
    this.dispatchEvent(new Event("devicechange"));
  }
}

const g = globalThis as any;
/** The page can pick an output (Chromium's setSinkId), for the length of `fn`. */
async function withSinkId<T>(fn: () => Promise<T>): Promise<T> {
  const had = "HTMLMediaElement" in g;
  const prev = g.HTMLMediaElement;
  g.HTMLMediaElement = class {
    setSinkId() {}
  };
  try {
    return await fn();
  } finally {
    if (had) g.HTMLMediaElement = prev;
    else delete g.HTMLMediaElement;
  }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- pure: which device -----------------------------------------------------
test("pin: the physical device behind 'Default - …' by label and group; iOS (no virtual default) pins nothing", async () => {
  const devs = windows({ def: INTEL, comm: REALTEK });
  assert.equal(resolveVirtualMic(devs)?.deviceId, "intel-mic");
  assert.equal(resolveVirtualMic(devs, "communications")?.deviceId, "rtk-mic");
  // Unplugged: the same device back under a new id first, then what default points to, then any.
  assert.equal(micFor([...devs.slice(0, 2), { ...INTEL, deviceId: "intel-2" }, REALTEK], INTEL)?.deviceId, "intel-2");
  assert.equal(micFor(windows({ def: REALTEK, comm: REALTEK, inputs: [REALTEK] }), INTEL)?.deviceId, "rtk-mic");

  const logs: string[] = [];
  const ios = new MicPin({ list: async () => [{ deviceId: "ipad-mic", groupId: "g", label: "iPad Microphone", kind: "audioinput" }], log: (e) => logs.push(e) });
  assert.equal(await ios.atStart(), undefined, "Safari lists no virtual default: the SDK's own default, untouched");
  assert.equal(ios.pinned, null);
  assert.equal(await ios.target(), "default");
  assert.deepEqual(logs, []);
});

// ---- the laptop, on a mocked SDK --------------------------------------------
const vault = makeTempVault("vc-voicemic-");
const fake = installFakeTauri(vault);
fake.setHandler("vault_box_config", ({ vault: v }) => (v === vault ? { box: "http://127.0.0.1:9", vault: "v" } : null));
fake.setHandler("box_get_json", async ({ url }) => {
  if (String(url).includes("/api/v1/voice/session")) return { status: 200, body: JSON.stringify({ systemPrompt: "p", toolNames: [], voiceId: "v1", conversationToken: "tok", signedUrl: "wss://s" }) };
  return { status: 200, body: "{}" };
});
/** What reached the box's log route (voiceShip.ts). */
const shipped: { source: string; device: string; events: { ev: string; [k: string]: any }[] }[] = [];
fake.setHandler("box_post_json", async ({ url, body }) => {
  if (String(url).includes("/api/v1/board/log")) shipped.push(JSON.parse(body));
  return { status: 200, body: JSON.stringify({ ok: true, convId: "box-voice-1" }) };
});
const shippedEv = (ev: string) => shipped.flatMap((b) => b.events).filter((e) => e.ev === ev);
const { useStore } = await import("../../src/store.ts");
const voice = await import("../../src/voice-elevenlabs.ts");

class FakeTrack extends EventTarget {
  readyState = "live";
  constructor(
    public deviceId: string,
    public label: string,
  ) {
    super();
  }
  getSettings() {
    return { deviceId: this.deviceId, echoCancellation: true, noiseSuppression: true };
  }
  end() {
    this.readyState = "ended";
    this.dispatchEvent(new Event("ended"));
  }
}
type Call = { opts: any; conv: any; track: FakeTrack };
let calls: Call[] = [];
const sdk = {
  async startSession(opts: any) {
    const track = new FakeTrack(opts.inputDeviceId ?? "default", opts.inputDeviceId === "intel-mic" ? INTEL.label! : "Default - ?");
    const room = { canPlaybackAudio: true, localParticipant: { getTrackPublication: () => ({ track: { mediaStreamTrack: call.track } }) }, on() {}, off() {} };
    const conv: any = {
      connection: { getRoom: () => room },
      inputs: [] as unknown[],
      outputs: [] as unknown[],
      async changeInputDevice(c: { inputDeviceId: string }) {
        conv.inputs.push(c);
        call.track = new FakeTrack(c.inputDeviceId, c.inputDeviceId);
      },
      async changeOutputDevice(c: unknown) {
        conv.outputs.push(c);
      },
      getInputVolume: () => 0.1,
      getOutputVolume: () => 0,
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
    const call: Call = { opts, conv, track };
    calls.push(call);
    opts.onConnect?.({ conversationId: "c" });
    return conv;
  },
};
const logs = () => JSON.parse(localStorage.getItem("vc_debug_buf") ?? "[]") as { tag: string; data?: any }[];
const tagged = (t: string) => logs().filter((e) => e.tag === t);

let md: FakeMediaDevices;
const realMd = Object.getOwnPropertyDescriptor(g.navigator ?? {}, "mediaDevices");
before(() => {
  voice.setVoiceSdkForTests(sdk);
  useStore.setState({ vaultPath: vault, serviceKeys: {} } as any);
  Object.defineProperty(g.navigator, "userAgent", { configurable: true, value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" });
});
after(() => {
  voice.setVoiceSdkForTests(null);
  if (realMd) Object.defineProperty(g.navigator, "mediaDevices", realMd);
  else delete g.navigator.mediaDevices;
});

async function startCall(list: MicDevice[]): Promise<Call> {
  md = new FakeMediaDevices(list);
  Object.defineProperty(g.navigator, "mediaDevices", { configurable: true, value: md });
  calls = [];
  await voice.startElevenLabsSession();
  await wait(5);
  assert.ok(voice.isVoiceSessionActive(), "the call is live");
  return calls[calls.length - 1]!;
}

test("laptop: Windows flipping default → communications mid-call changes neither the call's mic nor its output, and ends nothing", async () => {
  await withSinkId(async () => {
    const c = await startCall(windows({ def: INTEL, comm: INTEL, outDef: SPEAKERS }));
    try {
      assert.equal(c.opts.inputDeviceId, "intel-mic", "opened on the physical mic behind 'Default - …'");
      assert.equal(c.opts.outputDeviceId, "spk", "and on the physical output behind it");
      assert.equal(c.opts.connectionType, "webrtc");
      // Windows moves both endpoints to the Realtek mic and the headset, the devices all still there.
      md.change(windows({ def: REALTEK, comm: REALTEK, outDef: HEADSET }));
      await wait(10);
      md.change(windows({ def: INTEL, comm: REALTEK, outDef: SPEAKERS, outComm: HEADSET }));
      await wait(10);
      assert.deepEqual(c.conv.inputs, [], "the mic stays pinned");
      assert.deepEqual(c.conv.outputs, [], "the output stays pinned");
      assert.ok(voice.isVoiceSessionActive(), "the call goes on");
      // Every line is on the box (POST /api/v1/board/log, source "voice"), whole.
      await voice.voiceShipperForTests().flush();
      assert.ok(shipped.every((b) => b.source === "voice" && b.device === "laptop"));
      const ch = shippedEv("voice devices changed").pop()!;
      assert.equal(ch.micStillThere, true);
      assert.equal(ch.outputStillThere, true);
      assert.ok(ch.outputs.some((o: string) => /Jabra/.test(o)), "the outputs are listed");
      assert.ok(shippedEv("voice mic pinned").length && shippedEv("voice output pinned").length);
      assert.equal(shippedEv("voice output pinned")[0]!.outputDevice, SPEAKERS.label);
    } finally {
      await voice.endElevenLabsSession();
    }
  });
});

test("laptop: the pinned mic unplugged moves the call to the remaining physical mic; the call stays", async () => {
  const c = await startCall(windows({ def: INTEL, comm: INTEL }));
  try {
    assert.equal(c.opts.inputDeviceId, "intel-mic");
    md.change(windows({ def: REALTEK, comm: REALTEK, inputs: [REALTEK] }));
    await wait(10);
    assert.deepEqual(c.conv.inputs, [{ inputDeviceId: "rtk-mic" }]);
    assert.ok(voice.isVoiceSessionActive(), "the call goes on");
    const sw = tagged("voice mic switched").pop()!;
    assert.equal(sw.data.mic, REALTEK.label);
    assert.equal(sw.data.was, INTEL.label);
  } finally {
    await voice.endElevenLabsSession();
  }
});

test("laptop: a mic track that ended re-acquires the same pinned device", async () => {
  const c = await startCall(windows({ def: INTEL, comm: REALTEK }));
  try {
    c.track.end();
    await wait(10);
    assert.deepEqual(c.conv.inputs, [{ inputDeviceId: "intel-mic" }], "the same device, not 'default'");
    assert.equal(tagged("voice mic reacquired").length > 0, true);
    assert.ok(voice.isVoiceSessionActive());
  } finally {
    await voice.endElevenLabsSession();
  }
});

// ---- the board: pins, and its audio watched --------------------------------
function boardSdk(over: Partial<VoiceConv> & Record<string, unknown> = {}) {
  let opts: SessionOpts | null = null;
  const log = { inputs: [] as string[], outputs: [] as string[] };
  const conv: VoiceConv & Record<string, any> = {
    endSession: async () => opts?.onDisconnect(),
    setMicMuted: () => {},
    sendContextualUpdate: () => {},
    uploadFile: async () => ({ fileId: "f" }),
    sendMultimodalMessage: () => {},
    getOutputVolume: () => 0.4,
    getInputVolume: () => 0,
    changeInputDevice: async (c) => void log.inputs.push(c.inputDeviceId),
    changeOutputDevice: async (c) => void log.outputs.push(c.outputDeviceId),
    ...over,
  };
  return { sdk: { Conversation: { startSession: async (o: SessionOpts) => ((opts = o), o.onConnect(), conv) } }, conv, log, opts: () => opts! };
}
const boardApi = {
  listChats: async () => [],
  voiceSession: async () => ({ conversationToken: "tok", systemPrompt: "p", toolNames: [] }),
  voiceTool: async () => ({ result: "ok" }),
  voiceTranscript: async (b: { convId: string | null }) => ({ convId: b.convId ?? "v" }),
};
const mic = async () => ({ getTracks: () => [] }) as unknown as MediaStream;

test("board: pinned at start; an output default switch keeps the sink; the output unplugged moves it", async () => {
  await withSinkId(async () => {
    const devs = new FakeMediaDevices(windows({ def: INTEL, comm: INTEL, outDef: HEADSET }));
    const f = boardSdk();
    const events: [string, any][] = [];
    const v = new VoiceController({ api: boardApi as any, sdk: async () => f.sdk, mic, devices: devs, log: (e, d) => events.push([e, d]), stats: async () => null });
    await v.start();
    try {
      assert.equal(v.state.phase, "live");
      assert.equal(f.opts().inputDeviceId, "intel-mic");
      assert.equal(f.opts().outputDeviceId, "jabra-out");
      devs.change(windows({ def: INTEL, comm: INTEL, outDef: SPEAKERS }));
      await wait(10);
      assert.deepEqual(f.log.outputs, [], "Windows moving its default output doesn't move the call's");
      assert.equal(v.outputDevice, "jabra-out");
      devs.change(windows({ def: INTEL, comm: INTEL, outDef: SPEAKERS, outputs: [SPEAKERS] }));
      await wait(10);
      assert.deepEqual(f.log.outputs, ["spk"], "the headset unplugged: the speakers");
      assert.equal(v.state.phase, "live");
      assert.ok(events.some(([e, d]) => e === "voice devices changed" && d.outputStillThere === false));
    } finally {
      await v.end();
    }
  });
});

test("board: a suspended context while the agent speaks warns (flat waves), and the tap resumes it, logged", async () => {
  const ctx = { state: "running" as string, resumed: 0, async resume() {
    this.resumed++;
    this.state = "running";
  } };
  const f = boardSdk({ output: { context: ctx } });
  const events: [string, any][] = [];
  const v = new VoiceController({ api: boardApi as any, sdk: async () => f.sdk, mic, devices: null, log: (e, d) => events.push([e, d]), stats: async () => null });
  await v.start();
  try {
    f.opts().onModeChange({ mode: "speaking" });
    v.checkAudio();
    assert.equal(v.state.audio ?? "", "", "playing: no warning");
    assert.ok(v.outputLevel() > 0, "the waves move while it plays");
    ctx.state = "suspended";
    v.checkAudio();
    assert.equal(v.state.audio, "context-suspended");
    assert.equal(v.outputLevel(), 0, "no waves over silence");
    assert.ok(events.some(([e, d]) => e === "voice audio blocked" && d.why === "context-suspended"));
    await v.reconnectAudio();
    assert.equal(ctx.resumed, 1, "resumed");
    assert.equal(v.state.audio, "", "the warning clears");
    assert.ok(events.some(([e]) => e === "voice audio reconnect"));
    assert.ok(events.some(([e]) => e === "voice audio unblocked"));
  } finally {
    await v.end();
  }
});

// ---- dropouts, from the inbound stats ---------------------------------------
/** A reply's inbound stats every 250 ms: `at` → what changed in that step. */
function stream(steps: { lost?: number; packets?: number; concealed?: number; energy?: number }[]): InboundAudio[] {
  let s: InboundAudio = { at: 0, packetsReceived: 0, packetsLost: 0, totalSamplesReceived: 0, concealedSamples: 0, silentConcealedSamples: 0, concealmentEvents: 0, totalAudioEnergy: 0, jitter: 0.012, jitterBufferDelay: 0, jitterBufferEmittedCount: 0, audioLevel: 0.3, roundTripTime: 0.08 };
  const out = [s];
  for (const st of steps) {
    s = {
      ...s,
      at: s.at + 250,
      packetsReceived: s.packetsReceived! + (st.packets ?? 12),
      packetsLost: s.packetsLost! + (st.lost ?? 0),
      totalSamplesReceived: s.totalSamplesReceived! + 12_000,
      concealedSamples: s.concealedSamples! + (st.concealed ?? 0),
      concealmentEvents: s.concealmentEvents! + (st.concealed ? 1 : 0),
      totalAudioEnergy: s.totalAudioEnergy! + (st.energy ?? 0.01),
      jitterBufferDelay: s.jitterBufferDelay! + 12_000 * 0.06,
      jitterBufferEmittedCount: s.jitterBufferEmittedCount! + 12_000,
    };
    out.push(s);
  }
  return out;
}
const fine = { contexts: ["running"], outputDevice: "Speakers (Realtek(R) Audio)" };
function classify(samples: InboundAudio[], local = fine): Dropout[] {
  const got: Dropout[] = [];
  const w = new DropoutWatch((d) => got.push(d));
  for (const s of samples) w.sample(s, true, local);
  w.sample({ ...samples[samples.length - 1]!, at: samples[samples.length - 1]!.at + 250 }, false, local);
  return got;
}
const ok = { energy: 0.01 };

test("dropouts: a clean reply has none", () => {
  assert.deepEqual(classify(stream([ok, ok, ok, ok, ok, ok, ok, ok])), []);
});

test("dropouts: packets lost and the jitter buffer concealing mid-reply is the network", () => {
  const stall = { lost: 6, packets: 2, concealed: 9_000, energy: 0 };
  const got = classify(stream([ok, ok, stall, stall, stall, ok, ok]));
  assert.equal(got.length, 1);
  assert.equal(got[0]!.cause, "network");
  assert.ok(got[0]!.ms >= 500, `${got[0]!.ms} ms`);
  assert.equal(got[0]!.lost, 18);
  assert.ok(got[0]!.concealed >= 27_000);
  assert.equal(got[0]!.rttMs, 80);
  assert.equal(got[0]!.outputDevice, "Speakers (Realtek(R) Audio)");
});

test("dropouts: packets arriving on time that carry silence mid-reply is the source (ElevenLabs)", () => {
  const silent = { energy: 0 };
  const got = classify(stream([ok, ok, silent, silent, silent, ok, ok]));
  assert.equal(got.length, 1);
  assert.equal(got[0]!.cause, "source");
  assert.equal(got[0]!.lost, 0);
  assert.equal(got[0]!.concealed, 0);
});

test("dropouts: packets and inbound energy fine but the playback context suspended is local", () => {
  const got = classify(stream([ok, ok, ok, ok, ok]), { contexts: ["suspended"], outputDevice: "Speakers (Realtek(R) Audio)" });
  assert.equal(got.length, 1);
  assert.equal(got[0]!.cause, "local");
  assert.deepEqual(got[0]!.contexts, ["suspended"]);
});

test("dropouts: the monitor reads getStats while the agent speaks, logs the reply and its dropout; waves flat while stalled", async () => {
  const silent = { energy: 0 };
  const samples = stream([ok, ok, silent, silent, silent, ok]);
  let i = 0;
  let speaking = true;
  let now = 0;
  const report = (s: InboundAudio) => [
    { type: "inbound-rtp", kind: "audio", ...s },
    { type: "candidate-pair", nominated: true, currentRoundTripTime: 0.05 },
    { type: "inbound-rtp", kind: "video", packetsReceived: 999 },
  ];
  assert.equal(readInbound(report(samples[1]!), 1)!.roundTripTime, 0.05);
  const events: [string, any][] = [];
  const m = new PlaybackMonitor({
    stats: async () => report(samples[Math.min(i, samples.length - 1)]!),
    speaking: () => speaking,
    local: () => fine,
    log: (e, d) => events.push([e, d]),
    now: () => now,
    everyMs: 0,
    longTasks: false,
  }).start();
  let sawStalled = false;
  for (i = 0; i < samples.length; i++) {
    now = samples[i]!.at;
    await m.tick();
    sawStalled ||= m.stalled;
  }
  speaking = false;
  now += 250;
  await m.tick();
  m.stop();
  assert.ok(sawStalled, "the waves went flat during the stall");
  assert.equal(events.filter(([e]) => e === "voice dropout").length, 1);
  assert.equal(events.find(([e]) => e === "voice dropout")![1].cause, "source");
  const play = events.filter(([e]) => e === "voice playback");
  assert.deepEqual(play.map(([, d]) => d.phase), ["start", "stop"]);
  assert.equal(play[1]![1].dropouts, 1);
});

// ---- Carl, 2026-10-21: "it hung up when I switched layouts", then "Hello?" got nothing --------------------
test("layout: fullscreen chat, the panel and the popout toggled during a call keep the same session", async () => {
  const c = await startCall(windows({ def: INTEL, comm: INTEL }));
  const closed = tagged("voice closed").length;
  try {
    const st = useStore.getState() as any;
    useStore.setState({ chatFullscreen: true } as any);
    st.toggleChatSidebar?.();
    useStore.setState({ chatFullscreen: false } as any);
    st.toggleChatSidebar?.();
    useStore.setState({ popoutOpen: true } as any);
    useStore.setState({ popoutOpen: false } as any);
    await wait(20);
    assert.ok(voice.isVoiceSessionActive(), "still live");
    assert.equal(calls[calls.length - 1], c, "no new session");
    assert.equal(calls.length, 1);
    assert.equal(tagged("voice closed").length, closed, "nothing closed it");
  } finally {
    await voice.endElevenLabsSession("test");
  }
  // Who ended a call is in the log (a "user" close used to say nothing about which button).
  assert.equal(tagged("voice end").pop()!.data.by, "test");
});

test("silence rule: a greeting or a question always gets an answer; skip_turn only when he said nothing to the voice", async () => {
  const { VOICE_SILENCE_RULE } = await import("../../src/voicePrompt.ts");
  assert.match(VOICE_SILENCE_RULE, /a greeting \("hey", "hello\?"\), a question, a request, anything addressed to you — always answer/);
  assert.match(VOICE_SILENCE_RULE, /skip_turn is only for turns where he has said nothing to you/);
  assert.match(VOICE_SILENCE_RULE, /an empty or unintelligible transcript/);
});

test("on the box: the voice's update / mute / status lines and its [voice-eleven] console lines (voice.jsonl); the app's errors and box drops (app.jsonl)", async () => {
  const { SHIPPED, APP_SHIPPED } = await import("../../src/voiceShip.ts");
  for (const t of ["voice update", "voice updates", "voice update held", "voice mute", "voice status", "voice metadata", "voice mic ended", "voice mic reacquire failed", "voice timeout", "voice console"]) assert.match(t, SHIPPED, t);
  const { vlog } = await import("../../src/debugLog.ts");
  // A call started earlier in this file: the voice's shipper has its box.
  vlog("console.error", "[voice-eleven] microphone not reaching ElevenLabs: no level for 8 s");
  vlog("console.info", "[other] not the voice's");
  await voice.voiceShipperForTests().flush();
  const con = shippedEv("voice console");
  assert.ok(con.some((e) => e.level === "error" && /microphone not reaching ElevenLabs/.test(e.line)), "the voice's console error is on the box");
  assert.ok(!con.some((e) => /not the voice's/.test(e.line)));

  const { installAppShip, appShipperForTests } = await import("../../src/appShip.ts");
  for (const t of ["console.error", "window.error", "unhandledrejection", "box.feed", "box.intent", "boot"]) assert.match(t, APP_SHIPPED, t);
  assert.doesNotMatch("file.open", APP_SHIPPED);
  useStore.setState({ vaultPath: vault });
  installAppShip();
  vlog("box.feed", { state: "dropped", cursor: 4, error: "Failed to connect to thinkbox" });
  vlog("box.feed", { state: "connected", cursor: 4, downMs: 64_000 });
  vlog("console.error", "render failed: x is undefined");
  vlog("console.error", "[voice-eleven] session start failed: y");
  vlog("debugLog installed", {});
  await appShipperForTests().flush();
  const app = shipped.filter((b) => b.source === "app");
  assert.ok(app.length && app.every((b) => b.device === "laptop"));
  const evs = app.flatMap((b) => b.events);
  assert.deepEqual(
    evs.filter((e) => e.ev === "box.feed").map((e) => [e.state, e.error ?? e.downMs]),
    [
      ["dropped", "Failed to connect to thinkbox"],
      ["connected", 64_000],
    ],
  );
  assert.ok(evs.some((e) => e.ev === "console.error" && e.data === "render failed: x is undefined"));
  assert.ok(!evs.some((e) => /voice-eleven/.test(String(e.data))), "the voice's own lines go with the voice's");
  assert.ok(!evs.some((e) => e.ev === "debugLog installed"));
});
