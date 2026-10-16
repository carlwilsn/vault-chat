// Voice "cut out and said a different sentence": our own pushes into the live
// conversation (contextual updates; uploads, which ElevenLabs takes as a user
// turn) interrupted the agent mid-reply. They now wait until it stops speaking
// (src/voiceQuiet.ts), the latest of each kind only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const vault = makeTempVault("vc-voicequiet-");
const fake = installFakeTauri(vault);
fake.setHandler("read_binary_file", ({ path: p }) => [...fs.readFileSync(p)]);
fake.setHandler("git_repo_root_for_file", () => vault);

const { QuietGate } = await import("../../src/voiceQuiet.ts");
const { useStore } = await import("../../src/store.ts");
const voice = await import("../../src/voice-elevenlabs.ts");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("the gate: at once when quiet; held while speaking; the latest per key goes after the settle", async () => {
  let speaking = false;
  const g = new QuietGate(() => speaking, 50);
  const ran: string[] = [];
  g.run("viewport", () => ran.push("v0"));
  assert.deepEqual(ran, ["v0"]);
  speaking = true;
  g.modeChanged();
  g.run("viewport", () => ran.push("v1"));
  g.run("viewport", () => ran.push("v2"));
  g.run("typing", () => ran.push("t1"));
  let waited = false;
  void g.quiet(5_000).then(() => (waited = true));
  await sleep(120);
  assert.deepEqual(ran, ["v0"], "nothing while it speaks");
  // A pause between sentences shorter than the settle: still held.
  speaking = false;
  g.modeChanged();
  await sleep(10);
  speaking = true;
  g.modeChanged();
  await sleep(100);
  assert.deepEqual(ran, ["v0"]);
  speaking = false;
  g.modeChanged();
  await sleep(120);
  assert.deepEqual(ran, ["v0", "v2", "t1"]);
  assert.ok(waited);
  assert.equal(g.pending, 0);
  // A capped wait gives up after its max.
  speaking = true;
  g.modeChanged();
  const t0 = Date.now();
  await g.quiet(80);
  assert.ok(Date.now() - t0 >= 70);
  g.reset();
});

test("live session: a follow-along upload waits until the agent stops speaking", async () => {
  const PNG = path.join(vault, "figs", "plot.png");
  fs.mkdirSync(path.dirname(PNG), { recursive: true });
  fs.writeFileSync(PNG, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
  const uploads: Blob[] = [];
  const sent: unknown[] = [];
  const updates: string[] = [];
  const conv = {
    async uploadFile(b: Blob) {
      uploads.push(b);
      return { fileId: `f${uploads.length}` };
    },
    sendMultimodalMessage: (m: unknown) => sent.push(m),
    sendContextualUpdate: (t: string) => updates.push(t),
    setMicMuted() {},
    getInputByteFrequencyData: () => new Uint8Array(32),
    getOutputByteFrequencyData: () => new Uint8Array(32),
    endSession: async () => {},
  };
  useStore.setState({ vaultPath: vault, followAlong: true, currentFile: null } as any);
  voice.adoptVoiceSessionForPreview(conv);
  try {
    useStore.getState().setVoiceSpeaking(true);
    // Carl opens the plot mid-reply.
    useStore.setState({ currentFile: PNG } as any);
    voice.pushViewportContextDebounced();
    await sleep(1200);
    assert.equal(sent.length, 0, "no user turn while the agent speaks");
    assert.ok(voice.heldVoicePushes() > 0);
    // The agent finishes its sentence: the push goes (after the settle).
    useStore.getState().setVoiceSpeaking(false);
    const end = Date.now() + 3000;
    while (sent.length === 0 && Date.now() < end) await sleep(25);
    assert.equal(sent.length, 1, "sent once it was quiet");
    assert.equal(uploads.length, 1);
  } finally {
    voice.adoptVoiceSessionForPreview(null);
  }
});
