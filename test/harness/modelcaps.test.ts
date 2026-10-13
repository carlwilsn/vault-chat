// Settings' model check: the catalog first, then one remembered request for
// what it can't say (two tools at once, thinking returned, usage and cost),
// sent with tool_choice "auto" — "required" is refused by some reasoning
// models, which then read as "can't use tools".
import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

installFakeTauri(makeTempVault());
const mc = await import("../../src/modelCaps.ts");

const CATALOG = {
  data: [
    { id: "a/full", context_length: 1_000_000, supported_parameters: ["tools", "tool_choice", "reasoning"], architecture: { input_modalities: ["text", "image", "file"] } },
    { id: "a/short", context_length: 32_000, supported_parameters: ["tools", "tool_choice"], architecture: { input_modalities: ["text"] } },
    { id: "a/serial", context_length: 128_000, supported_parameters: ["tools", "tool_choice"], architecture: { input_modalities: ["text", "image"] } },
  ],
};

const requests: any[] = [];
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url);
  if (u.endsWith("/models")) return new Response(JSON.stringify(CATALOG), { status: 200 });
  const body = JSON.parse(init.body);
  requests.push(body);
  const both = body.model !== "a/serial";
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: null, ...(body.reasoning ? { reasoning: "both at once" } : {}), tool_calls: (both ? ["vc_check_a", "vc_check_b"] : ["vc_check_a"]).map((name, i) => ({ id: `t${i}`, type: "function", function: { name, arguments: '{"ok":true}' } })) } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.0003 },
    }),
    { status: 200 },
  );
}) as any;

test("the catalog's facts: tools, tool_choice, images, files, context, reasoning", () => {
  assert.deepEqual(mc.catalogRowCaps(CATALOG.data[0] as any), { tools: true, toolChoice: true, images: true, pdf: true, reasoning: true, contextLength: 1_000_000, context: true });
  assert.equal(mc.catalogRowCaps(CATALOG.data[1] as any).context, false);
});

test("without a key: what the catalog can't confirm stays unchecked, not failed", async () => {
  const c = await mc.checkModel("chat", "a/full");
  assert.equal(c.state, "unknown");
  assert.equal(requests.length, 0);
});

test("one request per model, ever: tool_choice auto, two tools, usage on; the result is remembered", async () => {
  assert.deepEqual(await mc.checkModel("chat", "a/full", "sk-or-test"), { state: "passed" });
  assert.equal(requests.length, 1);
  const r = requests[0];
  assert.equal(r.tool_choice, "auto");
  assert.deepEqual(r.tools.map((t: any) => t.function.name), ["vc_check_a", "vc_check_b"]);
  assert.deepEqual(r.usage, { include: true });
  assert.deepEqual(r.reasoning, { effort: "low" });
  assert.ok(!JSON.stringify(r.messages).includes("image_url"), "the catalog knows its images: no image sent");
  const { caps } = await mc.modelCaps("a/full", "sk-or-test");
  assert.equal(caps.reasoningReturned, true);
  assert.deepEqual(await mc.checkModel("background", "a/full", "sk-or-test"), { state: "passed" });
  assert.equal(requests.length, 1, "remembered");
});

test("what's missing is named: a short context, one tool at a time", async () => {
  assert.deepEqual(await mc.checkModel("background", "a/short", "sk-or-test"), { state: "missing", missing: ["context"] });
  assert.deepEqual(await mc.checkModel("chat", "a/serial", "sk-or-test"), { state: "missing", missing: ["parallel"] });
  assert.match(mc.NEED_LABEL.context, /64k/);
});
