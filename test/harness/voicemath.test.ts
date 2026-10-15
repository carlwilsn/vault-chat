// Voice transcripts with math: a local gate decides which lines are worth a
// model call, the Background role's model turns only the spoken math into
// $…$, and an answer that changed the words is thrown away. The message keeps
// its spoken text; `display` is what the bubble shows.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { installFakeTauri, makeTempVault, startFakeOpenRouter, type FakeOpenRouter } from "./fakes.ts";

const vault = makeTempVault("vc-voicemath-");
installFakeTauri(vault);

const { useStore } = await import("../../src/store.ts");
const { setOpenRouterBaseURL } = await import("../../src/providers.ts");
const vm = await import("../../src/voiceMath.ts");

const ANSWERS: Record<string, string> = {
  "so alpha plus beta squared equals one": "so $\\alpha + \\beta^2 = 1$",
  "then take x sub i over n": "then take $x_i / n$",
  "the gradient of f with respect to theta": "Sure! The gradient is $\\nabla_\\theta f$, which tells you the slope.",
  "sigma is the standard deviation": "BOOM",
};
let fake: FakeOpenRouter;

before(async () => {
  fake = await startFakeOpenRouter((body) => {
    const line = String(body.messages?.at(-1)?.content ?? "");
    if (line.includes("lambda")) return { status: 500 };
    return { text: ANSWERS[line] ?? line };
  });
  setOpenRouterBaseURL(fake.url);
  useStore.setState({ vaultPath: vault, apiKeys: { openrouter: "sk-or-test" } } as any);
});
after(async () => {
  setOpenRouterBaseURL(null);
  await fake.close();
});

test("the gate: spoken math, Greek and formulas pass; plain talk doesn't", () => {
  for (const yes of [
    "so alpha plus beta squared equals one",
    "then take x sub i over n",
    "what's the integral of that",
    "the derivative is zero there",
    "2 + 3 = 5",
    "a = b squared",
    "f of x is linear",
    "the value of θ here",
    "e to the power of minus x",
  ])
    assert.ok(vm.hasMathCues(yes), `cue: ${yes}`);
  for (const no of [
    "I'll meet you at three",
    "can you open the writeup",
    "I was over there yesterday",
    "plus I think the seminar is on Tuesday",
    "already has $\\alpha$ in it",
    "",
  ])
    assert.ok(!vm.hasMathCues(no), `no cue: ${no}`);
});

test("the guard: only math may change", () => {
  assert.equal(vm.acceptFormatted("so alpha plus beta squared equals one", "so $\\alpha + \\beta^2 = 1$"), "so $\\alpha + \\beta^2 = 1$");
  // Added prose, an unbalanced dollar, no math at all, the same line back: refused.
  assert.equal(vm.acceptFormatted("the gradient of f with respect to theta", "Sure! The gradient is $\\nabla f$, which tells you the slope."), null);
  assert.equal(vm.acceptFormatted("x squared", "$x^2"), null);
  assert.equal(vm.acceptFormatted("x squared", "x squared"), null);
  assert.equal(vm.acceptFormatted("x squared", "```\n$x^2$\n```"), "$x^2$");
});

test("the request: Background role's model, strict prompt, short cap, temperature 0", async () => {
  const n = fake.requests.length;
  const out = await vm.formatVoiceMath("so alpha plus beta squared equals one");
  assert.equal(out, "so $\\alpha + \\beta^2 = 1$");
  const req = fake.requests[n];
  assert.equal(req.model, "anthropic/claude-haiku-5.5");
  assert.match(req.messages[0].content, /Rewrite ONLY the spans that are mathematics/);
  assert.equal(req.messages.at(-1).content, "so alpha plus beta squared equals one");
  assert.equal(req.temperature, 0);
  assert.ok(req.max_tokens > 0 && req.max_tokens <= 200, `short cap (${req.max_tokens})`);
});

test("cached per line; no call for a line without math; failures leave the line", async () => {
  const n = fake.requests.length;
  assert.equal(await vm.formatVoiceMath("so alpha plus beta squared equals one"), "so $\\alpha + \\beta^2 = 1$");
  assert.equal(await vm.formatVoiceMath("I'll meet you at three"), null);
  assert.equal(fake.requests.length, n, "no new request");
  assert.equal(vm.cachedVoiceMath("so alpha plus beta squared equals one"), "so $\\alpha + \\beta^2 = 1$");
  // The model added prose / answered nonsense / the provider failed: null.
  assert.equal(await vm.formatVoiceMath("the gradient of f with respect to theta"), null);
  assert.equal(await vm.formatVoiceMath("sigma is the standard deviation"), null);
  assert.equal(await vm.formatVoiceMath("lambda is the rate"), null);
});

test("no key for the role's provider: no call", async () => {
  const n = fake.requests.length;
  useStore.setState({ apiKeys: {} } as any);
  assert.equal(await vm.formatVoiceMath("omega squared over k"), null);
  assert.equal(fake.requests.length, n);
  useStore.setState({ apiKeys: { openrouter: "sk-or-test" } } as any);
});

test("a voice line gets `display`, its spoken text stays", async () => {
  useStore.setState({ messages: [] } as any);
  useStore.getState().appendMessage({ role: "user", content: "then take x sub i over n" });
  const m = useStore.getState().messages[0]!;
  vm.displayVoiceMath(m);
  for (let i = 0; i < 50 && !useStore.getState().messages[0]!.display; i++) await new Promise((r) => setTimeout(r, 20));
  const after = useStore.getState().messages[0]!;
  assert.equal(after.display, "then take $x_i / n$");
  assert.equal(after.content, "then take x sub i over n");
});
