// The call's audio devices pinned, and the agent's audio measured on its way in
// (Carl, 2026-10-21: "it suddenly stops hearing me"; "I stop hearing the voice,
// but the waves keep going"; "the voice is gone, then it glitches back to
// normal towards the end of the sentence"). His laptop log: 19 device changes
// mid-call, Windows flipping "Default - …" / "Communications - …" between the
// Intel array and the Realtek mic.
//   - The call opens on the physical devices behind "default" (inputDeviceId /
//     outputDeviceId) and stays there through default/communications switches.
//   - Unplugged: the best remaining device, the call going on.
//   - Safari/iOS (no virtual default listed): nothing pinned.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { MicPin, micFor, resolveVirtualMic, type MicDevice } from "../../src/voiceMic.ts";
import { VoiceController, type VoiceConv } from "../../board/src/voice.ts";
import type { BrainOptions } from "../../src/voiceBrainClient.ts";

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

// ---- the board's call (board/src/voice.ts), on a fake call ---------------
function boardCall(over: Partial<VoiceConv> = {}) {
  let opts: BrainOptions | null = null;
  const log = { inputs: [] as string[], outputs: [] as string[] };
  const conv: VoiceConv = {
    endSession: async () => {},
    setMicMuted: () => {},
    getOutputVolume: () => 0.4,
    getInputVolume: () => 0,
    changeInputDevice: async (c) => void log.inputs.push(c.inputDeviceId),
    changeOutputDevice: async (c) => void log.outputs.push(c.outputDeviceId),
    ...over,
  };
  return { start: async (o: BrainOptions) => ((opts = o), o.onConnect?.(), conv), conv, log, opts: () => opts! };
}
const boardApi = { listChats: async () => [], brainPost: async () => ({}) };
const mic = async () => ({ getTracks: () => [] }) as unknown as MediaStream;

test("board: pinned at start; an output default switch keeps the sink; the output unplugged moves it", async () => {
  await withSinkId(async () => {
    const devs = new FakeMediaDevices(windows({ def: INTEL, comm: INTEL, outDef: HEADSET }));
    const f = boardCall();
    const events: [string, any][] = [];
    const v = new VoiceController({ api: boardApi, startCall: f.start, mic, devices: devs, log: (e, d) => events.push([e, d]) });
    await v.start();
    try {
      assert.equal(v.state.phase, "live");
      assert.equal(f.opts().inputDeviceId, "intel-mic");
      assert.equal(f.opts().outputDeviceId, "jabra-out");
      assert.equal(f.opts().convId, "main", "no chat picked: the one main conversation");
      devs.change(windows({ def: INTEL, comm: INTEL, outDef: SPEAKERS }));
      await wait(10);
      assert.deepEqual(f.log.outputs, [], "Windows moving its default output doesn't move the call's");
      devs.change(windows({ def: INTEL, comm: INTEL, outDef: SPEAKERS, outputs: [SPEAKERS] }));
      await wait(10);
      assert.deepEqual(f.log.outputs, ["spk"], "the headset unplugged: the speakers");
      assert.equal(v.state.phase, "live");
      assert.ok(events.some(([e]) => e === "voice devices changed"));
    } finally {
      await v.end();
    }
  });
});

test("board: a call that drops says why and the mic continues the same thread; mute and end are the call's", async () => {
  let opts: BrainOptions | null = null;
  const muted: boolean[] = [];
  let ended = 0;
  const closes: any[] = [];
  const v = new VoiceController({
    api: { listChats: async () => [{ id: "project-coconut", title: "Coconut", lastActivityAt: Date.now(), source: "box", kind: "project" }, { id: "main", title: "Main", lastActivityAt: 1, source: "box", kind: "main" }], brainPost: async () => ({}) },
    startCall: async (o) => ((opts = o), o.onConnect?.(), { endSession: async () => void ended++, setMicMuted: (m: boolean) => void muted.push(m) }),
    mic,
    devices: null,
    onClose: (c) => closes.push(c),
  });
  await v.switchChat("project-coconut");
  assert.equal(opts!.convId, "project-coconut");
  assert.equal(v.state.phase, "live");
  v.setMuted(true);
  assert.deepEqual(muted, [true]);
  opts!.onDisconnect?.({ reason: "error", message: "the call's connection failed" });
  assert.equal(v.state.phase, "error");
  assert.match(v.state.error, /Tap the mic to go on with this chat/);
  assert.equal(closes.at(-1).by, "remote");
  await v.start();
  assert.equal(opts!.convId, "project-coconut", "the picked thread goes on");
  await v.end("pill");
  assert.equal(v.state.phase, "idle");
  assert.equal(ended, 1);
});
