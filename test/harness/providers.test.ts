// Model defaults, the seed list, and turn-model resolution (no silent no-key runs).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

installFakeTauri(makeTempVault());
const p = await import("../../src/providers.ts");
const { pickFastModel } = await import("../../src/eta-estimator.ts");

const fixture = JSON.parse(
  fs.readFileSync(new URL("./fixtures/openrouter-models-2026-10-10.json", import.meta.url), "utf8"),
).models as { id: string; tools: boolean; ctx: number }[];
const live = new Map(fixture.map((m) => [m.id, m]));

test("role defaults exist on OpenRouter and support tools", () => {
  for (const id of [p.DEFAULT_MISSION_MODEL_ID, p.DEFAULT_WORKER_MODEL_ID, p.DEFAULT_MODEL_ID, p.DEFAULT_BACKGROUND_MODEL_ID]) {
    const m = live.get(id);
    assert.ok(m, `${id} is listed by OpenRouter`);
    assert.ok(m!.tools, `${id} supports tools`);
  }
  assert.equal(p.DEFAULT_MISSION_MODEL_ID, "openai/gpt-6.1-sol");
  assert.equal(p.DEFAULT_WORKER_MODEL_ID, "openai/gpt-6.1-sol");
});

test("every OpenRouter seed id is a live model (the :nitro routing suffix aside)", () => {
  for (const s of p.MODELS.filter((m) => m.provider === "openrouter")) {
    assert.ok(live.has(s.id.replace(/:nitro$/, "")), `seed ${s.id} is listed`);
  }
});

test("hidden jobs pick the current cheap model on an OpenRouter-only machine", () => {
  const picked = pickFastModel({ openrouter: "k" });
  assert.equal(picked?.spec.id, p.DEFAULT_BACKGROUND_MODEL_ID);
  // compactor.ts uses the same rule (first seed of the provider matching haiku|mini|flash).
  const compact = p.MODELS.find((m) => m.provider === "openrouter" && /haiku|mini|flash/i.test(m.id));
  assert.equal(compact?.id, p.DEFAULT_BACKGROUND_MODEL_ID);
});

test("findModel resolves any vendor/model id as OpenRouter before the catalog loads", () => {
  assert.deepEqual(p.findModel("x-ai/grok-9"), { provider: "openrouter", id: "x-ai/grok-9", label: "x-ai/grok-9" });
  assert.equal(p.findModel("no-such-model"), undefined);
});

test("resolveTurnModel: direct key, reroute to OpenRouter, reroute to direct, loud failure", () => {
  p.setLiveCatalog(null);
  const a = p.resolveTurnModel(["claude-opus-4-8"], { anthropic: "ka" });
  assert.equal(a.modelId, "claude-opus-4-8");
  assert.equal(a.apiKey, "ka");

  const b = p.resolveTurnModel(["claude-opus-4-8"], { openrouter: "ko" });
  assert.equal(b.modelId, "anthropic/claude-opus-4.8");
  assert.equal(b.spec.provider, "openrouter");
  assert.equal(b.routedFrom, "claude-opus-4-8");
  assert.equal(p.resolveTurnModel(["claude-haiku-4-5-20251001"], { openrouter: "ko" }).modelId, "anthropic/claude-haiku-4.5");
  assert.equal(p.resolveTurnModel(["gpt-5.5"], { openrouter: "ko" }).modelId, "openai/gpt-5.5");

  const c = p.resolveTurnModel(["anthropic/claude-sonnet-5.5"], { anthropic: "ka" });
  assert.equal(c.modelId, "claude-sonnet-5-5");
  assert.equal(c.spec.provider, "anthropic");

  // First candidate without a key, second has one → the second.
  const d = p.resolveTurnModel(["claude-opus-4-8", "openai/gpt-6.1-sol"], { openai: "x", openrouter: "ko" });
  assert.equal(d.modelId, "anthropic/claude-opus-4.8");

  assert.throws(
    () => p.resolveTurnModel(["openai/gpt-6.1-sol"], {}),
    (e: any) => e instanceof p.MissingKeyError && /No OpenRouter API key/.test(e.message) && e.provider === "openrouter",
  );
  assert.throws(() => p.resolveTurnModel([undefined, "auto"], { openrouter: "k" }), p.MissingKeyError);
});

test("rerouting to OpenRouter only targets ids the loaded catalog lists", () => {
  p.setLiveCatalog([{ provider: "openrouter", id: "anthropic/claude-sonnet-5.5", label: "x" }]);
  try {
    assert.throws(() => p.resolveTurnModel(["claude-opus-4-8"], { openrouter: "k" }), p.MissingKeyError);
    assert.equal(p.resolveTurnModel(["claude-opus-4-8", "anthropic/claude-sonnet-5.5"], { openrouter: "k" }).modelId, "anthropic/claude-sonnet-5.5");
  } finally {
    p.setLiveCatalog(null);
  }
});
