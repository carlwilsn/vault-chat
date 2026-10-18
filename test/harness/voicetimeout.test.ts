// "Voice session closed by ElevenLabs: LLM Cascade Error: TimeoutError — code
// 1002" (Carl, v0.6.41, 2026-10-17): every model in the cascade missed
// ElevenLabs' default 4 s cascade timeout on a turn whose answer was a long
// tool call (rewrite the note), twice in one conversation.
//   - The agent gets 15 s per model, keeps only the newest few files whole, and
//     is told to make big edits in small steps.
//   - The voice prompt stays small for a long conversation full of images;
//     images already in the session are not sent again; a look's images go as
//     one picture where the page can draw.
//   - A timeout close reconnects once, transparently, with a recap; a second
//     one ends the call with one plain-English line (never the raw error).
import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const vault = makeTempVault("vc-voicetimeout-");
installFakeTauri(vault);

const { useStore } = await import("../../src/store.ts");
const voice = await import("../../src/voice-elevenlabs.ts");
const L = await import("../../src/voiceLlms.ts");
const T = await import("../../src/voiceTimeout.ts");
const { VoiceImagePusher } = await import("../../src/voiceImages.ts");

function fakeConv() {
  const uploads: Blob[] = [];
  const sent: { text?: string; fileId: string }[] = [];
  const userMessages: string[] = [];
  return {
    uploads,
    sent,
    userMessages,
    async uploadFile(b: Blob) {
      uploads.push(b);
      return { fileId: `f${uploads.length}` };
    },
    sendMultimodalMessage(m: { text?: string; fileId: string }) {
      sent.push(m);
    },
    sendUserMessage(t: string) {
      userMessages.push(t);
    },
    sendContextualUpdate() {},
    setMicMuted() {},
    setVolume() {},
    getInputByteFrequencyData: () => new Uint8Array(32),
    getOutputByteFrequencyData: () => new Uint8Array(32),
    endSession: async () => {},
  };
}
const png = (n: number) => `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, n, n, n, n, n]).toString("base64")}`;
const tick = () => new Promise((r) => setTimeout(r, 20));
const TIMEOUT_CLOSE = {
  reason: "error",
  message: "LLM Cascade Error: TimeoutError",
  closeReason: "LLM Cascade Error: TimeoutError",
  closeCode: 1002,
};

test("the agent: 15 s per model in the cascade, a tool-capable backup chain, few files kept whole, the least reasoning", () => {
  const list = L.parseLlmList({ llms: [{ llm: "gpt-6-luna", supports_image_input: true, available_reasoning_efforts: ["low", "medium", "high"] }] });
  const body: any = voice.buildAgentCreateBody({ llm: "gpt-6-luna", info: L.llmInfo(list, "gpt-6-luna"), customTools: [], voiceId: "v" });
  const p = body.conversation_config.agent.prompt;
  assert.equal(p.cascade_timeout_seconds, 15);
  assert.ok(p.cascade_timeout_seconds >= 2 && p.cascade_timeout_seconds <= 15, "ElevenLabs' range");
  assert.deepEqual(p.backup_llm_config, { preference: "override", order: ["claude-haiku-4-5", "gpt-4.1-mini"] });
  assert.equal(p.reasoning_effort, "low", "the lowest the model offers");
  const fi = body.conversation_config.conversation.file_input;
  assert.equal(fi.max_files_in_memory, 4);
  assert.ok(fi.max_files_per_conversation >= fi.max_files_in_memory);
});

test("a 200-message conversation full of images: the prompt and its history stay under budget, no pixels in it", () => {
  const long = "Clear out the rest of the note except for the problem statement and build from there. ".repeat(30);
  const msgs = Array.from({ length: 200 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: `${i}: ${long}`,
    ...(i % 3 === 0 ? { attachments: [{ imageDataUrl: png(i % 250) }] } : {}),
  }));
  const st = { ...useStore.getState(), vaultPath: vault, files: [], messages: [] } as any;
  const p = voice.buildSystemPrompt(st, "", "", { sessionContext: "", memoryBlock: "", skillsIndex: "" }, msgs as any, true, [], []);
  const hist = p.split("Recent conversation context")[1] ?? "";
  assert.ok(hist.length > 0, "the history is there");
  assert.ok(hist.length <= voice.HISTORY_TOTAL_CHAR_BUDGET + 200, `history ${hist.length} chars`);
  assert.ok(p.length < 20_000, `prompt ${p.length} chars`);
  assert.ok(!p.includes("data:image"), "no image bytes in the prompt");
  assert.match(hist, /199: /, "the newest turn is kept");
  assert.ok(!hist.includes("\n0: ") && !/User: 0: /.test(hist), "the oldest dropped");
  // The guidance that keeps a turn's tool call short.
  assert.match(p, /Keep each Write or Edit short/);
});

test("images already in the session are not sent again; a look's several images go as one picture", async () => {
  const conv = fakeConv();
  voice.adoptVoiceSessionForPreview(conv);
  const thread = Array.from({ length: 10 }, (_, i) => ({ role: "user", content: `problem ${i}`, attachments: [{ imageDataUrl: png(i + 1) }] }));
  assert.deepEqual(await voice.pushThreadImages(thread as any, vault), ["sent", "sent", "sent"]);
  assert.equal(conv.uploads.length, 3);
  // A second push in the same session (a resume, a look at the same pictures): nothing new goes.
  assert.deepEqual(await voice.pushThreadImages(thread as any, vault), ["duplicate", "duplicate", "duplicate"]);
  const { imageKey } = await import("../../src/screenLook.ts");
  const again = await voice.pushVoiceImagesNow([{ key: imageKey(png(10)), dataUrl: png(10) }], "look");
  assert.deepEqual(again, ["duplicate"]);
  assert.equal(conv.uploads.length, 3, "no re-upload");
  voice.adoptVoiceSessionForPreview(null);

  // Where the page can draw: the new images of one look become one upload.
  const composed: number[] = [];
  const p = new VoiceImagePusher(1_000_000, async () => null, async (bs) => {
    composed.push(bs.length);
    return new Blob([new Uint8Array(10)], { type: "image/jpeg" });
  });
  const ids: string[][] = [];
  const notes: (string | undefined)[] = [];
  const sink = {
    uploads: 0,
    async uploadFile() {
      return { fileId: `u${++this.uploads}` };
    },
    sendMultimodalMessage() {},
    sendFiles(text: string | undefined, f: string[]) {
      notes.push(text);
      ids.push(f);
    },
  };
  const img = (n: number) => ({ key: `k${n}`, blob: new Blob([new Uint8Array(n)], { type: "image/png" }) });
  assert.deepEqual(await p.pushMany(sink, [img(1), img(2), img(3)], "look"), ["sent", "sent", "sent"]);
  assert.deepEqual(composed, [3]);
  assert.deepEqual(ids, [["u1"]], "one file for three images");
  assert.match(notes[0]!, /3 images are stacked top to bottom in one picture/);
  assert.equal(p.uploaded, 1);
  // The same look again, one image changed: only that one goes.
  assert.deepEqual(await p.pushMany(sink, [img(1), img(2), img(4)], "look"), ["duplicate", "duplicate", "sent"]);
  assert.deepEqual(ids.at(-1), ["u2"]);
});

test("a timeout close reconnects once with a recap; the plain line, never the raw error", async () => {
  useStore.getState().newConversation();
  const recaps: string[] = [];
  let next: ReturnType<typeof fakeConv> | null = null;
  voice.setVoiceRestartForTests(async (recap) => {
    recaps.push(recap);
    next = fakeConv();
    voice.adoptVoiceSessionForPreview(next);
  });
  try {
    const first = fakeConv();
    const s = voice.adoptVoiceSessionForPreview(first);
    s.line("user", "Clear out the rest of the note except for the problem statement and build from there. But also keep the definition of V.");
    s.line("agent", "One sec.");
    voice.voiceSessionClosed(TIMEOUT_CLOSE);
    await tick();
    assert.equal(recaps.length, 1, "one reconnect");
    assert.match(recaps[0]!, /The user's last request: "Clear out the rest of the note except for the problem statement/);
    assert.match(recaps[0]!, /several short Edits/);
    assert.ok(next, "a new session");
    assert.equal(useStore.getState().voiceMode, true, "the call stays on");
    const lines = useStore.getState().messages.map((m) => m.content);
    assert.ok(lines.includes(T.RECONNECTING_LINE));
    assert.ok(lines.includes("One sec."), "what was said lands first");
    assert.ok(lines.indexOf("One sec.") < lines.indexOf(T.RECONNECTING_LINE));
    assert.ok(!lines.some((l) => /closed by ElevenLabs|LLM Cascade|TimeoutError|1002/.test(l)), "no raw error");
    assert.ok(!lines.includes("Voice session ended."), "not ended");

    // The reconnected call times out too: no second reconnect, one plain line, the call ends.
    voice.voiceSessionClosed(TIMEOUT_CLOSE);
    await tick();
    assert.equal(recaps.length, 1, "only once");
    const after = useStore.getState().messages.map((m) => m.content);
    assert.ok(after.includes(T.couldntReconnectLine("the model timed out again")));
    assert.match(T.couldntReconnectLine("the model timed out again"), /^The voice model took too long to answer, and the call couldn't reconnect: the model timed out again\.$/);
    assert.ok(!after.some((l) => /LLM Cascade|TimeoutError/.test(l)));
    assert.equal(after.at(-1), "Voice session ended.");
    assert.equal(useStore.getState().voiceMode, false);
  } finally {
    voice.setVoiceRestartForTests(null);
    voice.adoptVoiceSessionForPreview(null);
  }
});

test("a reconnect that can't start says why in words; a hang-up resets the allowance; other closes unchanged", async () => {
  useStore.getState().newConversation();
  await voice.endElevenLabsSession(); // a deliberate end: the next timeout is a new incident
  voice.setVoiceRestartForTests(async () => {
    throw new Error("the box couldn't start voice: HTTP 503");
  });
  try {
    voice.adoptVoiceSessionForPreview(fakeConv()).line("user", "rewrite the note");
    voice.voiceSessionClosed(TIMEOUT_CLOSE);
    await tick();
    const lines = useStore.getState().messages.map((m) => m.content);
    assert.ok(lines.includes(T.RECONNECTING_LINE));
    assert.ok(lines.includes("The voice model took too long to answer, and the call couldn't reconnect: the box couldn't start voice: HTTP 503."));
    assert.equal(useStore.getState().voiceMode, false);

    // A close that isn't a timeout keeps its own line and no reconnect.
    useStore.getState().newConversation();
    voice.adoptVoiceSessionForPreview(fakeConv());
    voice.voiceSessionClosed({ reason: "error", message: "voice not found", closeCode: 1008 });
    await tick();
    const l2 = useStore.getState().messages.map((m) => m.content);
    assert.ok(l2.includes("Voice session closed by ElevenLabs: voice not found — code 1008"));
    assert.ok(!l2.includes(T.RECONNECTING_LINE));
  } finally {
    voice.setVoiceRestartForTests(null);
    voice.adoptVoiceSessionForPreview(null);
  }
});

test("timings: each turn's first response, the session's size and images, the timeout's wait", () => {
  const s = new T.VoiceTurnStats();
  s.startSession(20_000);
  // Carl stopped speaking at 600; the transcript landed at 1000 (with the reply under way).
  s.userTurn("rewrite the note", 1000, 600);
  s.fillerSpoken();
  assert.equal(s.firstResponse("tool:Write", 4500, 2000), null, "the turn is logged when audio plays");
  const r = s.audioPlaying(5100)!;
  assert.equal(r.firstResponseMs, 3900, "from the end of his speech, not the transcript");
  assert.equal(r.firstAudioMs, 4500);
  assert.equal(r.transcriptToAudioMs, 4100);
  assert.equal(r.from, "speech-end");
  assert.equal(r.via, "tool:Write");
  assert.equal(r.filler, true);
  assert.equal(s.audioPlaying(5200), null, "once a turn");
  s.toolResult("Write", 100);
  s.addImages(2);
  s.userTurn("and again", 10_000);
  const c = s.atClose(25_000);
  assert.equal(c.waitingMs, 15_000);
  // A reply that never plays ("waves but silence") is logged too, with no audio time.
  assert.equal(s.noAudio(25_000), null, "not before 20 s");
  const silent = s.noAudio(30_000)!;
  assert.equal(silent.firstAudioMs, null);
  assert.equal(silent.via, "none");
  assert.equal(silent.from, "transcript");
  assert.equal(c.images, 2);
  assert.equal(c.estTokens, Math.round((20_000 + "rewrite the note".length + 2000 + 100 + "and again".length) / 4));
  assert.equal(T.isLlmTimeoutClose(TIMEOUT_CLOSE), true);
  assert.equal(T.isLlmTimeoutClose({ reason: "user" }), false);
  assert.equal(T.isLlmTimeoutClose({ reason: "error", message: "voice not found" }), false);
  const retry = new T.TimeoutRetry(120_000);
  assert.equal(retry.take(0), true);
  assert.equal(retry.take(60_000), false);
  assert.equal(retry.take(200_000), true, "a later incident gets its own retry");
});
