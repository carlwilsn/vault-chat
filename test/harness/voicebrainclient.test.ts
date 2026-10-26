// The New voice's device client (src/voiceBrainClient.ts): a dropped connection is offered again on the same call
// before the call is given up, and keyboard clatter is not his voice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BrainConversation, RECONNECT_EVERY_MS, SPEECH_WINDOW, voiced } from "../../src/voiceBrainClient.ts";

/** Levels a tick at a time (25 ms): true = above SPEECH_RMS. Returns how many ticks counted as his voice. */
function voicedTicks(levels: boolean[]): number {
  let bits = 0;
  let n = 0;
  for (const l of levels) {
    const v = voiced(bits, l);
    bits = v.bits;
    if (v.voice) n++;
  }
  return n;
}

test("his voice counts within 250 ms; keyboard clatter never does", () => {
  // Speech: loud on nearly every tick (a dip between syllables).
  const speech = Array.from({ length: 40 }, (_, i) => i % 9 !== 4);
  assert.ok(voicedTicks(speech) >= 30);
  // Typing: each click is loud for 2 ticks of the 43 ms window, a click every 100–225 ms (10 keys a second at most).
  const typing: boolean[] = [];
  for (let k = 0; k < 120; k++) {
    typing.push(true, true);
    for (let g = 0; g < 2 + ((k * 5) % 6); g++) typing.push(false);
  }
  assert.equal(voicedTicks(typing), 0);
  assert.equal(SPEECH_WINDOW, 10);
});

class FakePC {
  connectionState = "new";
  iceGatheringState = "complete";
  localDescription: { sdp: string; type: string } | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ontrack: unknown = null;
  closed = false;
  addTrack() {}
  addEventListener() {}
  async createOffer() {
    return { sdp: "offer", type: "offer" };
  }
  async setLocalDescription(d: { sdp: string; type: string }) {
    this.localDescription = d;
  }
  async setRemoteDescription() {}
  getSenders() {
    return [];
  }
  close() {
    this.closed = true;
    this.set("closed");
  }
  set(s: string) {
    this.connectionState = s;
    this.onconnectionstatechange?.();
  }
}

function fakes(now: { t: number }) {
  const pcs: FakePC[] = [];
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  const analyser = () => ({ fftSize: 512, frequencyBinCount: 256, connect() {}, getFloatTimeDomainData(a: Float32Array) { a.fill(0); }, getByteFrequencyData() {} });
  const track = { kind: "audio", enabled: true, stop() {} };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  const deps = {
    getUserMedia: async () => stream as unknown as MediaStream,
    peer: () => {
      const p = new FakePC();
      pcs.push(p);
      return p as unknown as RTCPeerConnection;
    },
    audioContext: () => ({ resume: async () => {}, close: async () => {}, createAnalyser: analyser, createMediaStreamSource: () => ({ connect() {} }) }) as unknown as AudioContext,
    audioElement: () => ({ play: async () => {}, volume: 1, srcObject: null }) as unknown as HTMLAudioElement,
    now: () => now.t,
  };
  const post = async (path: string, body: Record<string, unknown>) => {
    posts.push({ path, body });
    if (path === "/api/v1/brain/call") return { callId: "bc-1" };
    if (path === "/api/v1/brain/offer") return { sdp: "answer", type: "answer" };
    return { ok: true };
  };
  return { pcs, posts, deps, post };
}

test("a dropped connection is offered again on the same call; a second drop within a minute gives up", async () => {
  const now = { t: 1_000_000 };
  const f = fakes(now);
  const drops: string[] = [];
  let connects = 0;
  const c = await BrainConversation.start({ post: f.post, convId: "main", device: "laptop", deps: f.deps, onConnect: () => connects++, onDisconnect: (d) => drops.push(d.message ?? d.reason) });
  try {
    f.pcs[0]!.set("connected");
    assert.equal(connects, 1);
    // The tailnet blips: the connection fails.
    f.pcs[0]!.set("failed");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(f.pcs.length, 2, "a new connection");
    const offers = f.posts.filter((p) => p.path === "/api/v1/brain/offer");
    assert.equal(offers.length, 2);
    assert.equal(offers[1]!.body.callId, "bc-1", "the same call");
    assert.ok(f.pcs[0]!.closed);
    assert.deepEqual(drops, [], "not given up");
    f.pcs[1]!.set("connected");
    assert.equal(connects, 2);
    assert.equal(c.isEnded, false);
    // A second drop within the minute: given up, said once.
    now.t += RECONNECT_EVERY_MS - 1;
    f.pcs[1]!.set("failed");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(f.pcs.length, 2);
    assert.equal(drops.length, 1);
    assert.match(drops[0]!, /failed/);
    assert.equal(c.isEnded, true);
  } finally {
    await c.endSession();
  }
});
