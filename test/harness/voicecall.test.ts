// The laptop connector on fake Tauri HTTP and an inert BrainConversation: no media or vendor calls.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { installFakeTauri, makeTempVault } from "./fakes.ts";
import { BrainConversation } from "../../src/voiceBrainClient.ts";

const vault = makeTempVault("vc-voicecall-");
const fake = installFakeTauri(vault);
fake.setHandler("vault_box_config", () => ({ box: "http://127.0.0.1:19347", vault: "School2" }));
const gets: string[] = [];
const posts: string[] = [];
let ready = true;
fake.setHandler("box_get_json", ({ url }) => {
  gets.push(url);
  return { status: 200, body: JSON.stringify({ engine: "new", pipeline: ready, error: ready ? null : "Voice port is occupied" }) };
});
fake.setHandler("box_post_json", ({ url }) => {
  posts.push(url);
  return { status: 200, body: '{"ok":true}' };
});
const { useStore } = await import("../../src/store.ts");
const voice = await import("../../src/voiceCall.ts");
const realStart = BrainConversation.start;
let starts: any[] = [];
let ended = 0;
BrainConversation.start = async (o) => {
  starts.push(o);
  // Exercise the connector's only route with an inert response; never construct a real PC or media element.
  await o.post("/api/v1/brain/call", { convId: o.convId, device: o.device });
  o.onConnect?.();
  return { setMicMuted() {}, endSession: async () => { ended++; } } as unknown as BrainConversation;
};
after(async () => { await voice.endVoiceCall(); BrainConversation.start = realStart; await voice.voiceShipperForTests().flush(); });

test("persisted Classic is inert: the laptop starts only New on the selected thread, keeping other preferences and mic OFF", async () => {
  localStorage.setItem("vault_chat_voice_engine", "classic");
  localStorage.setItem("vault_chat_microphone", "off");
  localStorage.setItem("unrelated", "keep");
  useStore.setState({ vaultPath: vault, activeConversationId: "project-original", voiceMode: true });
  await voice.startVoiceCall();
  assert.equal(starts.length, 1);
  assert.equal(starts[0].convId, "project-original");
  assert.equal(starts[0].device, "laptop");
  assert.ok(gets.every((p) => new URL(p).pathname === "/api/v1/brain/engine"));
  assert.ok(posts.some((p) => new URL(p).pathname === "/api/v1/brain/call"));
  assert.ok([...gets, ...posts].every((p) => !p.includes("/voice/session")));
  assert.equal(localStorage.getItem("vault_chat_voice_engine"), "classic", "no migration writes");
  assert.equal(localStorage.getItem("vault_chat_microphone"), "off");
  assert.equal(localStorage.getItem("unrelated"), "keep");
  await voice.endVoiceCall();
  assert.equal(ended, 1);
});

test("unavailable New refuses before opening media; no Classic fallback or second connector", async () => {
  ready = false;
  starts = [];
  gets.length = posts.length = 0;
  useStore.setState({ voiceMode: true });
  await voice.startVoiceCall();
  assert.equal(starts.length, 0);
  assert.equal(posts.length, 0);
  assert.equal(useStore.getState().voiceMode, false);
  assert.equal(useStore.getState().voiceError, "Voice port is occupied");
  assert.equal(gets.length, 1);
});
