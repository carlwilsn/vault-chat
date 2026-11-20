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
import { test } from "node:test";
import assert from "node:assert/strict";
import { MicPin, micFor, resolveVirtualMic, type MicDevice } from "../../src/voiceMic.ts";

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
