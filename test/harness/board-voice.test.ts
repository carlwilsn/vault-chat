// The board's voice (board/src/voice.ts) on a fake call: the chat it continues, a refused mic, the mic button pressed
// through the chrome's rule (chrome.ts) into start and end. The call itself (src/voiceBrainClient.ts) is the same on
// every surface; its devices are in voicemic.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { VoiceController, recentChats, type VoiceApi, type VoiceConv } from "../../board/src/voice.ts";
import { ChromeTaps, routeChrome } from "../../board/src/chrome.ts";
import type { BrainOptions } from "../../src/voiceBrainClient.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mic = async () => ({ getTracks: () => [] }) as unknown as MediaStream;
const api = (rows: Awaited<ReturnType<VoiceApi["listChats"]>> = []): VoiceApi => ({ listChats: async () => rows, brainPost: async () => ({}) });

function fakeCall() {
  const log = { started: [] as string[], ended: 0 };
  const start = async (o: BrainOptions): Promise<VoiceConv> => {
    log.started.push(o.convId);
    setTimeout(() => o.onConnect?.(), 1);
    return { endSession: async () => void log.ended++, setMicMuted: () => {} };
  };
  return { start, log };
}

test("the chat it continues: the most recent of Carl's chats (the phone's list, missions left out)", () => {
  const rows = recentChats([
    { id: "a", title: "", lastActivityAt: 1, source: "manual" },
    { id: "w", title: "", lastActivityAt: 9, source: "worker" },
    { id: "b", title: "", lastActivityAt: 5, source: "voice" },
  ]);
  assert.deepEqual(rows.map((r) => r.id), ["b", "a"]);
});

test("no chat picked: the call is Main's (one main conversation), even when another chat was more recently active", async () => {
  const f = fakeCall();
  const v = new VoiceController({ api: api([{ id: "x", title: "X", lastActivityAt: 9, source: "box", kind: "separate" }, { id: "main", title: "Main", lastActivityAt: 1, source: "box", kind: "main" }]), startCall: f.start, mic, devices: null });
  await v.start();
  await wait(5);
  assert.deepEqual(f.log.started, ["main"]);
  assert.equal(v.state.phase, "live");
  await v.end();
});

test("a refused mic: the red state with one plain line, no call started", async () => {
  const f = fakeCall();
  const v = new VoiceController({
    api: api(),
    startCall: f.start,
    mic: async () => {
      throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
    },
  });
  await v.start();
  assert.equal(v.state.phase, "error");
  assert.match(v.state.error, /^Microphone access is off\./);
  assert.deepEqual(f.log.started, []);
  v.dismiss();
  assert.equal(v.state.phase, "idle");
  // Not HTTPS: no getUserMedia at all.
  const w = new VoiceController({ api: api(), startCall: f.start, mic: null });
  await w.start();
  assert.match(w.state.error, /isn't on HTTPS/);
});

test("the mic button, pressed by a Pencil or a finger through the chrome's rule, starts voice once and ends it once", async () => {
  const f = fakeCall();
  const v = new VoiceController({ api: api(), startCall: f.start, mic, devices: null });
  const btn = { name: "voice" };
  // view.ts: a press clicks the button; its click handler calls voice.toggle().
  const taps = new ChromeTaps<typeof btn>(() => v.toggle());
  let t = 0;
  const tap = (id: number, click: boolean) => {
    routeChrome(taps, { type: "down", id, x: 10, y: 10, t: (t += 8) }, false, () => btn);
    routeChrome(taps, { type: "up", id, x: 11, y: 11, t: (t += 8) }, false, () => btn);
    // iOS's synthesised click, dropped by the dedupe: never a second toggle.
    if (click && taps.click((t += 4))) v.toggle();
  };
  tap(2, true);
  await wait(10);
  assert.equal(v.state.phase, "live");
  tap(7, true);
  await wait(10);
  assert.equal(v.state.phase, "idle");
  assert.equal(f.log.started.length, 1);
  assert.equal(f.log.ended, 1);
});
