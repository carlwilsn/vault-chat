// Cost metering: every OpenRouter call records the server-reported usage.cost.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { installFakeTauri, makeTempVault, startFakeOpenRouter, type FakeOpenRouter } from "./fakes.ts";

const vault = makeTempVault();
installFakeTauri(vault);
const providers = await import("../../src/providers.ts");
const { runAgent } = await import("../../src/agent.ts");
const { generateText, streamText } = await import("ai");

let or: FakeOpenRouter;
before(async () => {
  or = await startFakeOpenRouter((_body, n) => ({ text: `reply ${n}`, cost: 0.0125 }));
  providers.setOpenRouterBaseURL(or.url);
});
after(async () => {
  providers.setOpenRouterBaseURL(null);
  await or.close();
});

const spec = { provider: "openrouter" as const, id: "openai/gpt-6.1-sol", label: "x" };

test("generateText (JSON) asks for usage accounting and records usage.cost", async () => {
  const meter = providers.createCostMeter();
  const r = await generateText({ model: providers.buildModel(spec, "sk-canary", { meter }), prompt: "hi" });
  assert.match(r.text, /reply/);
  await meter.settle();
  assert.equal(meter.calls.length, 1);
  assert.equal(meter.totalUsd(), 0.0125);
  assert.equal(meter.calls[0]!.model, "openai/gpt-6.1-sol");
  assert.deepEqual(or.requests.at(-1).usage, { include: true });
});

test("streamText (SSE) records usage.cost from the final chunk", async () => {
  const meter = providers.createCostMeter();
  const r = streamText({ model: providers.buildModel(spec, "sk-canary", { meter }), prompt: "hi" });
  let text = "";
  for await (const t of r.textStream) text += t;
  assert.match(text, /reply/);
  await meter.settle();
  assert.equal(meter.calls.length, 1);
  assert.equal(meter.totalUsd(), 0.0125);
  assert.ok(meter.calls[0]!.generationId?.startsWith("gen-fake-"));
  const body = or.requests.at(-1);
  assert.equal(body.stream, true);
  assert.deepEqual(body.usage, { include: true });
  assert.equal(body.stream_options?.include_usage, true, "AI SDK must request the usage chunk");
});

test("a model built without a meter sends the request unchanged", async () => {
  await generateText({ model: providers.buildModel(spec, "sk-canary"), prompt: "hi" });
  assert.equal(or.requests.at(-1).usage, undefined);
});

test("runAgent: a multi-call turn reports the summed cost (cost event + done.usage.costUsd)", async () => {
  const or2 = await startFakeOpenRouter([
    { toolCalls: [{ name: "TodoWrite", input: { todos: [] } }], cost: 0.01 },
    { text: "all done", cost: 0.02 },
  ]);
  providers.setOpenRouterBaseURL(or2.url);
  try {
    const events: any[] = [];
    await runAgent({
      modelId: "openai/gpt-6.1-sol",
      apiKey: "sk-canary",
      vault,
      history: [],
      userMessage: "do it",
      onEvent: (e) => events.push(e),
    });
    const err = events.find((e) => e.kind === "error");
    assert.equal(err, undefined, err && err.message);
    const cost = events.find((e) => e.kind === "cost");
    assert.ok(cost, "cost event emitted");
    assert.equal(cost.cost.calls, 2);
    assert.equal(cost.cost.missing, 0);
    assert.equal(cost.cost.usd, 0.03);
    const done = events.find((e) => e.kind === "done");
    assert.equal(done.usage.costUsd, 0.03);
    // GPT-6.x gets the reasoning-effort option.
    assert.ok(or2.requests[0].reasoning_effort || or2.requests[0].reasoning, "reasoning effort passed for gpt-6");
  } finally {
    providers.setOpenRouterBaseURL(or.url);
    await or2.close();
  }
});

test("runAgent: a turn that errors after a paid call still reports what it cost", async () => {
  const or3 = await startFakeOpenRouter([
    { toolCalls: [{ name: "TodoWrite", input: { todos: [] } }], cost: 0.04 },
    { status: 400, errorBody: { error: { message: "context too long", code: 400 } } },
  ]);
  providers.setOpenRouterBaseURL(or3.url);
  try {
    const events: any[] = [];
    await runAgent({
      modelId: "openai/gpt-6.1-sol",
      apiKey: "sk-canary",
      vault,
      history: [],
      userMessage: "do it",
      onEvent: (e) => events.push(e),
    });
    const kinds = events.map((e) => e.kind);
    const ci = kinds.indexOf("cost");
    const ei = kinds.indexOf("error");
    assert.ok(ci >= 0 && ei > ci, `cost before error: ${kinds.join(",")}`);
    assert.equal(events[ci].cost.usd, 0.04);
    assert.match(events[ei].message, /context too long/);
    assert.ok(!events[ei].message.includes("[object Object]"));
  } finally {
    providers.setOpenRouterBaseURL(or.url);
    await or3.close();
  }
});

test("a response without usage.cost is counted as missing, not $0", async () => {
  const or4 = await startFakeOpenRouter([{ text: "x", cost: null }]);
  providers.setOpenRouterBaseURL(or4.url);
  try {
    const meter = providers.createCostMeter();
    await generateText({ model: providers.buildModel(spec, "k", { meter }), prompt: "hi" });
    await meter.settle();
    assert.equal(meter.missing(), 1);
    assert.equal(meter.totalUsd(), 0);
  } finally {
    providers.setOpenRouterBaseURL(or.url);
    await or4.close();
  }
});
