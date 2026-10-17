// Messages sent while the agent works, local mode (this laptop runs the turn):
// a steer is taken between two steps of the running turn and the model sees it
// right after the tool result it arrived during; what the agent said before it
// closes as its own reply and Carl's message follows in the thread. A queued
// message waits for the turn to end and runs as the next turn. Both can be
// taken back until then.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { installFakeTauri, makeTempVault, startFakeOpenRouter, type FakeOpenRouter } from "./fakes.ts";

const vault = makeTempVault("vc-steer-");
installFakeTauri(vault);
const providers = await import("../../src/providers.ts");
const { useStore } = await import("../../src/store.ts");
const pending = await import("../../src/pendingInput.ts");
const cc = await import("../../src/chat-controller.ts");

const MAIN = "openai/gpt-6.1-sol";
const textOf = (m: any): string => (typeof m?.content === "string" ? m.content : (m?.content ?? []).map((p: any) => p.text ?? "").join(""));
let or: FakeOpenRouter;
let convId = "";
const onRequest: Array<(body: any) => void> = [];

before(async () => {
  or = await startFakeOpenRouter((body, n) => {
    if (body.model !== MAIN) return { text: "ok", cost: 0 };
    onRequest.shift()?.(body);
    const last = body.messages.at(-1);
    if (last.role === "user" && /Find the notes/.test(textOf(last))) return { text: "Looking.", toolCalls: [{ name: "Glob", input: { pattern: "**/*.md" } }] };
    if (last.role === "user") return { text: `ack: ${textOf(last)}` };
    return { text: n < 3 ? "Found nothing yet." : "ok" };
  });
  providers.setOpenRouterBaseURL(or.url);
  useStore.setState({ vaultPath: vault, apiKeys: { openrouter: "sk-test" }, modelId: MAIN, conversationsLoaded: true } as any);
  convId = useStore.getState().newConversation();
});
after(async () => {
  providers.setOpenRouterBaseURL(null);
  await or.close();
});

async function until(fn: () => boolean, what: string, ms = 15_000): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 30));
  }
}

const thread = () =>
  useStore
    .getState()
    .messages.filter((m) => !m.hidden && !m.system)
    .map((m) => `${m.role}: ${m.content || (m.toolCalls?.length ? `[${m.toolCalls.map((t) => t.name).join()}]` : "")}`);

test("steer into the running turn, queue after it; a taken-back one never goes", async () => {
  // While the first model call is answered (the turn is running), Carl sends:
  // a steer (Enter), a queued follow-up (Tab), and one more he takes back.
  // All of it happens inside that call, before its answer goes out: the turn
  // takes the steer at its very next step, a few milliseconds later, so a test
  // polling from outside could miss the moment the three are pending.
  const seen: { running?: string; sent?: string[][]; kept?: string[][] } = {};
  const kinds = () => pending.pendingFor(convId).map((p) => [p.kind, p.text]);
  onRequest.push(() => {
    seen.running = useStore.getState().conversations.find((c) => c.id === convId)?.status;
    void cc.sendMidTurn("steer", "Only look in courses/.");
    void cc.sendMidTurn("queue", "Then summarise them.");
    void cc.sendMidTurn("queue", "And email it.");
    seen.sent = kinds();
    const takeBack = pending.pendingFor(convId).find((p) => p.text === "And email it.");
    if (takeBack) void cc.cancelPending(takeBack.id);
    seen.kept = kinds();
  });
  const first = cc.sendMessage("Find the notes about eigenvectors.");
  await until(() => seen.kept !== undefined, "the first model call");
  assert.equal(seen.running, "running");
  assert.deepEqual(seen.sent, [["steer", "Only look in courses/."], ["queue", "Then summarise them."], ["queue", "And email it."]]);
  assert.deepEqual(seen.kept, [["steer", "Only look in courses/."], ["queue", "Then summarise them."]]);

  await first;
  await until(() => thread().some((l) => l === "assistant: ack: Then summarise them."), "the queued turn ran");
  await until(() => useStore.getState().conversations.find((c) => c.id === convId)?.status !== "running", "idle");

  // The model saw the steer right after the tool result, in the same turn.
  const second = or.requests.filter((b) => b.model === MAIN)[1];
  const roles = second.messages.map((m: any) => m.role);
  const iSteer = second.messages.findIndex((m: any) => m.role === "user" && textOf(m) === "Only look in courses/.");
  assert.ok(iSteer > 0, "the steer is in the second call");
  assert.equal(roles[iSteer - 1], "tool", "right after the tool result");

  assert.deepEqual(thread(), [
    "user: Find the notes about eigenvectors.",
    "assistant: Looking.",
    "user: Only look in courses/.",
    "assistant: ack: Only look in courses/.",
    "user: Then summarise them.",
    "assistant: ack: Then summarise them.",
  ]);
  assert.equal(pending.pendingFor(convId).length, 0);
  assert.ok(!or.requests.some((b) => b.messages?.some((m: any) => textOf(m) === "And email it.")), "the taken-back one never reached the model");
});

test("nothing running: a steer or a queue is an ordinary send", async () => {
  const n = thread().length;
  await cc.sendMidTurn("queue", "Hello again.");
  await until(() => thread().length === n + 2, "a plain turn");
  assert.deepEqual(thread().slice(-2), ["user: Hello again.", "assistant: ack: Hello again."]);
});
