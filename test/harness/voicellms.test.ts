// The voice agent as ElevenLabs creates it (src/voice-elevenlabs.ts
// buildAgentCreateBody), its models and what each takes (src/voiceLlms.ts,
// from ElevenLabs' list — faked here, never called), the honesty rules in its
// prompt, and what the client sends a live conversation: contextual updates
// with a stable context id, files in the multimodal_message `files` shape.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const vault = makeTempVault("vc-voicellms-");
installFakeTauri(vault);

const L = await import("../../src/voiceLlms.ts");
const { checkVoiceModel } = await import("../../src/modelCaps.ts");
const { useStore } = await import("../../src/store.ts");
const voice = await import("../../src/voice-elevenlabs.ts");

const LIST = {
  llms: [
    { llm: "gpt-6-luna", supports_image_input: true, supports_document_input: false, available_reasoning_efforts: ["none", "low", "high"] },
    { llm: "gpt-6.1-sol", supports_image_input: true, supports_document_input: true, available_reasoning_efforts: ["low", "high"] },
    { llm: "claude-sonnet-4-6", supports_image_input: true, supports_document_input: true },
  ],
};
let listCalls = 0;
const fakeFetch = (async (url: string, init?: any) => {
  assert.equal(url, "https://api.elevenlabs.io/v1/convai/llm/list");
  assert.equal(init?.headers?.["xi-api-key"], "el-test");
  listCalls++;
  return new Response(JSON.stringify(LIST), { status: 200 });
}) as unknown as typeof fetch;

beforeEach(() => localStorage.removeItem("vault_chat_elevenlabs_llm_list"));

test("models: the default is GPT-6 Luna; old stored ids map to the nearest current one", () => {
  assert.equal(L.DEFAULT_VOICE_LLM, "gpt-6-luna");
  assert.equal(L.normalizeVoiceLlm(null), "gpt-6-luna");
  assert.equal(L.normalizeVoiceLlm("claude-sonnet-4-6"), "claude-sonnet-4-6");
  assert.equal(L.normalizeVoiceLlm("claude-haiku-4-5-20251001"), "claude-haiku-4-5");
  assert.equal(L.normalizeVoiceLlm("gemini-2.5-flash"), "gpt-6-luna");
  assert.equal(L.normalizeVoiceLlm("claude-3-7-sonnet"), "claude-sonnet-4-6");
  assert.equal(L.normalizeVoiceLlm("something-gone"), "gpt-6-luna");
  for (const id of ["claude-sonnet-5-5", "claude-sonnet-4-6", "claude-haiku-5-5", "claude-haiku-4-5", "gemini-3.8-flash", "gemini-3.5-flash", "gpt-6.1-sol", "gpt-6-luna", "glm-52"])
    assert.ok(L.VOICE_LLMS.some((m) => m.id === id), id);
});

test("ElevenLabs' list: fetched once a day, read for images, documents and reasoning", async () => {
  const a = await L.voiceLlmList("el-test", fakeFetch, 1_000);
  const b = await L.voiceLlmList("el-test", fakeFetch, 2_000);
  assert.equal(listCalls, 1, "cached");
  assert.deepEqual(a, b);
  await L.voiceLlmList("el-test", fakeFetch, 1_000 + 25 * 3600_000);
  assert.equal(listCalls, 2, "refetched after a day");
  const luna = L.llmInfo(a, "gpt-6-luna")!;
  assert.deepEqual([luna.images, luna.documents], [true, false]);
  assert.equal(L.reasoningEffortFor(luna), "none");
  assert.equal(L.reasoningEffortFor(L.llmInfo(a, "gpt-6.1-sol")), "low", "the lowest offered when none isn't");
  assert.equal(L.reasoningEffortFor(L.llmInfo(a, "claude-sonnet-4-6")), null);
  assert.equal(await L.voiceLlmList(null, fakeFetch, 1_000 + 50 * 3600_000), null, "no key, stale cache: nothing");
});

test("Settings' voice check comes from the list: Luna can't take a PDF and says so", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    assert.deepEqual(await checkVoiceModel("gpt-6-luna", "el-test"), { state: "missing", missing: ["pdf"] });
    assert.deepEqual(await checkVoiceModel("claude-sonnet-4-6", "el-test"), { state: "passed" });
    assert.equal((await checkVoiceModel("glm-52", "el-test")).state, "unknown");
    localStorage.removeItem("vault_chat_elevenlabs_llm_list");
    assert.equal((await checkVoiceModel("gpt-6-luna", null)).state, "unknown");
  } finally {
    globalThis.fetch = real;
  }
});

test("the agent ElevenLabs creates: natural TTS (no expressive mode), patient turns, low temperature, backup chain, file input", () => {
  const list = L.parseLlmList(LIST);
  const body: any = voice.buildAgentCreateBody({ llm: "gpt-6-luna", info: L.llmInfo(list, "gpt-6-luna"), customTools: [], voiceId: "v1" });
  const cc = body.conversation_config;
  assert.deepEqual(cc.tts, { model_id: "eleven_flash_v2", expressive_mode: false, voice_id: "v1" });
  assert.ok(!/eleven_v3/.test(JSON.stringify(body)));
  assert.equal(cc.turn.turn_eagerness, "patient");
  assert.equal(cc.turn.turn_model, "turn_v3");
  assert.equal(cc.turn.speculative_turn, true);
  assert.equal(cc.turn.merge_with_default_ignore_terms, true);
  assert.deepEqual(cc.turn.interruption_ignore_terms, ["yeah", "yep", "mm", "mhm", "mm-hm", "uh-huh", "ok", "okay", "right", "sure"]);
  assert.equal(cc.turn.soft_timeout_config.timeout_seconds, 3);
  assert.equal(cc.vad.background_voice_detection, true);
  assert.deepEqual(cc.conversation.file_input, { enabled: true, max_files_per_conversation: 10 });
  const p = cc.agent.prompt;
  assert.equal(p.llm, "gpt-6-luna");
  assert.equal(p.temperature, 0.4);
  assert.equal(p.reasoning_effort, "none");
  assert.deepEqual(p.backup_llm_config, { preference: "override", order: ["claude-haiku-4-5", "gpt-4.1-mini"] });
  const names = p.tools.map((t: any) => t.name);
  // Luna takes no documents: it keeps PdfExtract. A model that reads PDFs drops it.
  assert.ok(names.includes("PdfExtract") && names.includes("SetProject") && names.includes("skip_turn"));
  const sonnet: any = voice.buildAgentCreateBody({ llm: "claude-sonnet-4-6", info: L.llmInfo(list, "claude-sonnet-4-6"), customTools: [], voiceId: "v1" });
  assert.ok(!sonnet.conversation_config.agent.prompt.tools.some((t: any) => t.name === "PdfExtract"));
  assert.equal(sonnet.conversation_config.agent.prompt.reasoning_effort, undefined);
});

test("the prompt carries the honesty rules, under any header", () => {
  const st = { ...useStore.getState(), vaultPath: vault, files: [], messages: [] } as any;
  for (const header of ["", "You are my custom voice."]) {
    const prompt = voice.buildSystemPrompt(st, header, "", undefined, [], true, [], []);
    assert.ok(prompt.includes(voice.VOICE_HONESTY_RULES), "rules present");
  }
  const r = voice.VOICE_HONESTY_RULES;
  assert.match(r, /No flattery or hype/);
  assert.match(r, /"absolutely"/);
  assert.match(r, /If the user is wrong, say so plainly/);
  assert.match(r, /Never claim a tool or a capability you don't have/);
  assert.match(r, /SetProject/);
  assert.match(r, /AskAgent and AgentStatus/);
});

test("live session: contextual updates carry a stable context id; files go as files: [{type: file_input}]", async () => {
  const updates: [string, any][] = [];
  const sent: any[] = [];
  const conv: any = {
    connection: { sendMessage: (m: any) => sent.push(m) },
    async uploadFile() {
      return { fileId: "file_1" };
    },
    sendMultimodalMessage: () => assert.fail("the deprecated single-file shape"),
    sendContextualUpdate: (t: string, o: any) => updates.push([t, o]),
    setMicMuted() {},
    getInputByteFrequencyData: () => new Uint8Array(32),
    getOutputByteFrequencyData: () => new Uint8Array(32),
    endSession: async () => {},
  };
  voice.sendFilesMessage(conv, "[The user is looking at plot.png.]", ["file_1", "file_2"]);
  assert.deepEqual(sent, [
    { type: "multimodal_message", text: { type: "user_message", text: "[The user is looking at plot.png.]" }, files: [{ type: "file_input", file_id: "file_1" }, { type: "file_input", file_id: "file_2" }] },
  ]);
  useStore.setState({ vaultPath: vault, followAlong: true, voiceSpeaking: false } as any);
  voice.adoptVoiceSessionForPreview(conv);
  try {
    voice.sendVoiceTypingHint("opened");
    assert.equal(updates.at(-1)?.[1]?.contextId, "typing");
  } finally {
    voice.adoptVoiceSessionForPreview(null);
  }
});
