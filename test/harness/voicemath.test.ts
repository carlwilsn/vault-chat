// Voice transcripts with math: a local gate decides which lines are worth a
// model call, the box's fast model (a one-shot call, src/complete.ts) turns
// only the spoken math into $…$, and an answer that changed the words is
// thrown away. The message keeps its spoken text; `display` is what the
// bubble shows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

const vault = makeTempVault("vc-voicemath-");
installFakeTauri(vault);

const { useStore } = await import("../../src/store.ts");
const { setComplete } = await import("../../src/complete.ts");
const vm = await import("../../src/voiceMath.ts");

const ANSWERS: Record<string, string> = {
  "so alpha plus beta squared equals one": "so $\\alpha + \\beta^2 = 1$",
  "then take x sub i over n": "then take $x_i / n$",
  "the gradient of f with respect to theta": "Sure! The gradient is $\\nabla_\\theta f$, which tells you the slope.",
  "sigma is the standard deviation": "BOOM",
};
const requests: any[] = [];
setComplete(async (req) => {
  requests.push(req);
  if (req.text.includes("lambda")) throw new Error("HTTP 500");
  return ANSWERS[req.text] ?? req.text;
});
useStore.setState({ vaultPath: vault } as any);

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

test("the request: the box's fast model, the strict prompt, a short cap", async () => {
  const n = requests.length;
  const out = await vm.formatVoiceMath("so alpha plus beta squared equals one");
  assert.equal(out, "so $\\alpha + \\beta^2 = 1$");
  const req = requests[n];
  assert.equal(req.fast, true);
  assert.match(req.instructions, /Rewrite ONLY the spans that are mathematics/);
  assert.equal(req.text, "so alpha plus beta squared equals one");
  assert.ok(req.maxOutputTokens > 0 && req.maxOutputTokens <= 200, `short cap (${req.maxOutputTokens})`);
});

test("cached per line; no call for a line without math; failures leave the line", async () => {
  const n = requests.length;
  assert.equal(await vm.formatVoiceMath("so alpha plus beta squared equals one"), "so $\\alpha + \\beta^2 = 1$");
  assert.equal(await vm.formatVoiceMath("I'll meet you at three"), null);
  assert.equal(requests.length, n, "no new request");
  assert.equal(vm.cachedVoiceMath("so alpha plus beta squared equals one"), "so $\\alpha + \\beta^2 = 1$");
  // The model added prose / answered nonsense / the box failed: null.
  assert.equal(await vm.formatVoiceMath("the gradient of f with respect to theta"), null);
  assert.equal(await vm.formatVoiceMath("sigma is the standard deviation"), null);
  assert.equal(await vm.formatVoiceMath("lambda is the rate"), null);
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
