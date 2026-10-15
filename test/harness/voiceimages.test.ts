// Ambient vision for voice, images: what Carl looks at is uploaded to the
// ElevenLabs conversation once a session (deduped by path, or path + page),
// size-capped, with a short note; ShowFile opens one and attaches it,
// LookAtScreen attaches what is open. Both stay on this machine in box mode.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const vault = makeTempVault("vc-voiceimg-");
const fake = installFakeTauri(vault);
fake.setHandler("read_binary_file", ({ path: p }) => [...fs.readFileSync(p)]);
fake.setHandler("git_repo_root_for_file", () => vault);

const { useStore } = await import("../../src/store.ts");
const voice = await import("../../src/voice-elevenlabs.ts");
const { VoiceImagePusher, voiceImageMime, lookingAtNote } = await import("../../src/voiceImages.ts");

type Sent = { text?: string; fileId: string };
function fakeConv() {
  const uploads: Blob[] = [];
  const sent: Sent[] = [];
  return {
    uploads,
    sent,
    async uploadFile(b: Blob) {
      uploads.push(b);
      return { fileId: `f${uploads.length}` };
    },
    sendMultimodalMessage(m: Sent) {
      sent.push(m);
    },
    sendContextualUpdate() {},
    setMicMuted() {},
    getInputByteFrequencyData: () => new Uint8Array(32),
    getOutputByteFrequencyData: () => new Uint8Array(32),
    endSession: async () => {},
  };
}

const PNG = `${vault}/figs/diagram.png`;
before(() => {
  fs.mkdirSync(path.join(vault, "figs"), { recursive: true });
  fs.writeFileSync(PNG, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
  fs.writeFileSync(`${vault}/figs/logo.svg`, "<svg/>");
  useStore.setState({ vaultPath: vault, currentFile: null, followAlong: true } as any);
});

test("the pusher: once per key, too-large skipped (and not retried), only images", async () => {
  const conv = fakeConv();
  const p = new VoiceImagePusher(10, async () => null);
  const img = new Blob([new Uint8Array(8)], { type: "image/png" });
  assert.equal(await p.push(conv, "a.png", img, "note"), "sent");
  assert.equal(await p.push(conv, "a.png", img, "note"), "duplicate");
  assert.equal(await p.push(conv, "big.png", new Blob([new Uint8Array(11)], { type: "image/png" }), "note"), "too-large");
  assert.equal(await p.push(conv, "big.png", new Blob([new Uint8Array(11)], { type: "image/png" }), "note"), "duplicate");
  assert.equal(await p.push(conv, "doc.pdf", new Blob(["x"], { type: "application/pdf" }), "note"), "unsupported");
  assert.equal(conv.uploads.length, 1);
  assert.deepEqual(conv.sent, [{ text: "note", fileId: "f1" }]);
  // Shrunk under the cap: the shrunk copy goes.
  const q = new VoiceImagePusher(10, async () => new Blob([new Uint8Array(5)], { type: "image/jpeg" }));
  assert.equal(await q.push(conv, "big.png", new Blob([new Uint8Array(11)], { type: "image/png" }), "n"), "sent");
  assert.equal(conv.uploads.at(-1)!.size, 5);
  // Two pushes of one key at once: one upload.
  const r = new VoiceImagePusher();
  const [x, y] = await Promise.all([r.push(conv, "k", img, "n"), r.push(conv, "k", img, "n")]);
  assert.deepEqual([x, y].sort(), ["duplicate", "sent"]);
  // A reset (a new session) sends again.
  r.reset();
  assert.equal(await r.push(conv, "k", img, "n"), "sent");
});

test("which images go, and the note", () => {
  assert.equal(voiceImageMime("a/b.JPG"), "image/jpeg");
  assert.equal(voiceImageMime("a/b.webp"), "image/webp");
  assert.equal(voiceImageMime("a/b.svg"), null);
  assert.equal(voiceImageMime("a/b.heic"), null);
  assert.match(lookingAtNote("diagram.png"), /^\[The user is looking at diagram\.png\. The image is attached/);
  assert.match(lookingAtNote("paper.pdf", "page 3"), /looking at paper\.pdf \(page 3\)/);
});

test("the open image goes to the session once; a new session sends it again", async () => {
  const conv = fakeConv();
  voice.adoptVoiceSessionForPreview(conv);
  assert.equal(await voice.pushVoiceImageFile(PNG), "sent");
  assert.equal(await voice.pushVoiceImageFile(PNG), "duplicate");
  assert.equal(await voice.pushVoiceImageFile(`${vault}/figs/logo.svg`), "unsupported");
  assert.equal(conv.uploads.length, 1);
  assert.equal(conv.uploads[0]!.type, "image/png");
  assert.match(conv.sent[0]!.text!, /looking at diagram\.png/);
  voice.adoptVoiceSessionForPreview(null);
  assert.equal(await voice.pushVoiceImageFile(PNG), "no-session");
  const next = fakeConv();
  voice.adoptVoiceSessionForPreview(next);
  assert.equal(await voice.pushVoiceImageFile(PNG), "sent");
  voice.adoptVoiceSessionForPreview(null);
});

test("ShowFile opens the image and attaches it; LookAtScreen sees what's open", async () => {
  const conv = fakeConv();
  voice.adoptVoiceSessionForPreview(conv);
  const h = voice.buildClientToolHandlers();
  assert.match(await h.LookAtScreen({}), /Nothing is open/);
  // A vault-relative path is joined to the vault.
  assert.match(await h.ShowFile({ path: "figs/diagram.png" }), /^Showing diagram\.png\. The image is attached/);
  assert.equal(useStore.getState().currentFile, PNG);
  assert.equal(conv.uploads.length, 1);
  assert.match(await h.LookAtScreen({}), /already in your context/);
  assert.equal(conv.uploads.length, 1, "deduped");
  // Text files: what's in view comes back as text.
  fs.writeFileSync(`${vault}/note.md`, "# Hi\n\nbody");
  assert.match(await h.ShowFile({ path: `${vault}/note.md` }), /^Opened note\.md/);
  voice.adoptVoiceSessionForPreview(null);
});

test("box mode: ShowFile and LookAtScreen stay here", async () => {
  const posts: string[] = [];
  const h = voice.buildClientToolHandlers(async (name) => {
    posts.push(name);
    return "box";
  });
  voice.adoptVoiceSessionForPreview(fakeConv());
  assert.notEqual(await h.ShowFile({ path: "figs/diagram.png" }), "box");
  assert.notEqual(await h.LookAtScreen({}), "box");
  assert.deepEqual(posts, []);
  assert.ok(voice.LOCAL_VOICE_TOOLS.has("ShowFile") && voice.LOCAL_VOICE_TOOLS.has("LookAtScreen"));
  voice.adoptVoiceSessionForPreview(null);
});
