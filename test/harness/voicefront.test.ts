// The live call's side of voice as front of house (src/voiceFront.ts), shared by the laptop, the phone and
// the board: the box's updates go into the call — the agent's answer as a user message the voice answers
// aloud, everything already handled as a contextual update it never answers — each once, held while the
// voice speaks; and the conversation's images go with the call's start, an empty one never.
import { test } from "node:test";
import assert from "node:assert/strict";
import { QuietGate } from "../../src/voiceQuiet.ts";
import { VoiceImagePusher } from "../../src/voiceImages.ts";
import { VoiceUpdates, pushStartImages, type UpdatesPage } from "../../src/voiceFront.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function conv() {
  const spoken: string[] = [];
  const context: string[] = [];
  return {
    spoken,
    context,
    sendUserMessage: (t: string) => spoken.push(t),
    sendContextualUpdate: (t: string) => context.push(t),
  };
}

test("an answer is spoken, context is not; each update once; nothing while the voice speaks, all of it after", async () => {
  let speaking = false;
  const gate = new QuietGate(() => speaking, 10);
  const c = conv();
  const pages: UpdatesPage[] = [
    { cursor: "2:2", updates: [{ id: "r1", kind: "result", speak: true, text: "[vc:result] The agent answered: 91." }] },
    // A repeat (a retried poll) changes nothing.
    { cursor: "3:3", updates: [{ id: "r1", kind: "result", speak: true, text: "[vc:result] The agent answered: 91." }, { id: "c1", kind: "context", speak: false, text: "[vc:context] Carl typed in the chat." }] },
  ];
  const cursors: (string | null)[] = [];
  const u = new VoiceUpdates({
    cursor: "1:1",
    gate,
    conv: () => c,
    fetch: async (cur) => {
      cursors.push(cur);
      const p = pages.shift();
      if (p) return p;
      await wait(20);
      return { cursor: cur ?? "", updates: [] };
    },
  }).start();
  await wait(30);
  assert.deepEqual(c.spoken, ["[vc:result] The agent answered: 91."]);
  assert.deepEqual(c.context, ["[vc:context] Carl typed in the chat."]);
  assert.deepEqual(cursors.slice(0, 3), ["1:1", "2:2", "3:3"], "each poll from where the last left off");
  // While the voice speaks: held, then delivered once it is quiet.
  speaking = true;
  gate.modeChanged();
  u.deliver({ id: "q1", kind: "question", speak: true, text: "[vc:question] The agent asks Carl: all 12?" });
  await wait(30);
  assert.equal(c.spoken.length, 1, "held while it speaks");
  speaking = false;
  gate.modeChanged();
  await wait(40);
  assert.deepEqual(c.spoken.at(-1), "[vc:question] The agent asks Carl: all 12?");
  u.stop();
  assert.equal(u.delivered.length, 3);
});

test("a failed poll is retried, never fatal; a call that ended gets nothing", async () => {
  const gate = new QuietGate(() => false, 5);
  const c = conv();
  let n = 0;
  let live: typeof c | null = c;
  const u = new VoiceUpdates({
    cursor: null,
    gate,
    retryMs: 5,
    conv: () => live,
    fetch: async () => {
      n++;
      if (n === 1) throw new Error("box away");
      if (n === 2) return { cursor: "1:1", updates: [{ id: "a", kind: "result", speak: true, text: "[vc:result] ok" }] };
      await wait(10);
      return { cursor: "1:1", updates: [] };
    },
  }).start();
  await wait(40);
  assert.deepEqual(c.spoken, ["[vc:result] ok"]);
  live = null;
  u.deliver({ id: "b", kind: "result", speak: true, text: "[vc:result] late" });
  await wait(10);
  assert.deepEqual(c.spoken, ["[vc:result] ok"]);
  u.stop();
});

test("the start's images: the real one is uploaded with the earlier-in-this-conversation note; an empty one never (P17)", async () => {
  const uploads: Blob[] = [];
  const sent: { text?: string; fileId: string }[] = [];
  const sink = { uploadFile: async (b: Blob) => (uploads.push(b), { fileId: `f${uploads.length}` }), sendMultimodalMessage: (m: { text?: string; fileId: string }) => sent.push(m) };
  const pusher = new VoiceImagePusher(1_000_000, async () => null, async () => null);
  const r = await pushStartImages(sink, pusher, [
    { mime: "image/png", dataBase64: Buffer.from("pixels").toString("base64") },
    { mime: "image/png", dataBase64: "" },
  ]);
  assert.deepEqual(r, ["sent", "empty"]);
  assert.equal(uploads.length, 1);
  assert.match(sent[0]!.text!, /Earlier in this conversation \(before this call\), this image was shared in the chat/);
  // An empty image pushed any other way is refused too.
  assert.equal(await pusher.push(sink, "k", new Blob([], { type: "image/png" }), "note"), "empty");
});
