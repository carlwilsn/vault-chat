// Chat details: the context dial's numbers, compaction as a transcript
// divider, the Ctrl+K / Ctrl+L role mapping, and the PDF tool's limits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeTauri, makeTempVault } from "./fakes.ts";

installFakeTauri(makeTempVault());
const p = await import("../../src/providers.ts");
const cc = await import("../../src/chatContext.ts");
const { contextFromUsage } = await import("../../src/agent.ts");
const roles = await import("../../src/roles.ts");

test("context = the last call's prompt (cache included once) + its reply, minus reasoning", () => {
  // AI SDK v6: inputTokens is the TOTAL prompt; cachedInputTokens is a subset.
  assert.equal(contextFromUsage({ inputTokens: 100_000, cachedInputTokens: 90_000, outputTokens: 500 }), 100_500);
  assert.equal(contextFromUsage({ inputTokens: 1000, outputTokens: 800, outputTokenDetails: { reasoningTokens: 600 } }), 1200);
  assert.equal(contextFromUsage(undefined), 0);
});

test("the window comes from the catalog, with variant and direct-id fallbacks", () => {
  p.setLiveCatalog([
    { provider: "openrouter", id: "anthropic/claude-sonnet-5.5", label: "Claude Sonnet 5.5", contextLength: 1_000_000 },
    { provider: "openrouter", id: "qwen/qwen3-32b", label: "Qwen3 32B", contextLength: 131_072 },
  ]);
  assert.equal(p.contextWindowFor("anthropic/claude-sonnet-5.5"), 1_000_000);
  assert.equal(p.contextWindowFor("qwen/qwen3-32b:nitro"), 131_072);
  assert.equal(p.contextWindowFor("claude-sonnet-5.5"), 1_000_000);
  assert.equal(p.contextWindowFor("auto"), null);
  assert.deepEqual(cc.windowFor("nobody/unknown"), { tokens: p.FALLBACK_CONTEXT_WINDOW, known: false });
  p.setLiveCatalog(null);
});

const msg = (role: "user" | "assistant", content: string, extra: object = {}) => ({ role, content, ...extra });

test("compaction inserts a divider before the kept tail and drops nothing", () => {
  const ms = Array.from({ length: 10 }, (_, i) => msg(i % 2 ? "assistant" : "user", `m${i}`));
  const out = cc.withCompactionDivider(ms as any, "SUMMARY", 4);
  assert.equal(out.length, 11);
  assert.equal(out[6].content, cc.COMPACTION_DIVIDER_TEXT);
  assert.ok(cc.isCompactionDivider(out[6]));
  const w = cc.activeWindow(out);
  assert.equal(w.summary, "SUMMARY");
  assert.deepEqual(w.messages.map((m) => m.content), ["m6", "m7", "m8", "m9"]);
  // A second compaction: the newest divider wins.
  const again = cc.withCompactionDivider([...out, msg("user", "m10"), msg("assistant", "m11")] as any, "SUMMARY2", 2);
  assert.equal(cc.activeWindow(again).summary, "SUMMARY2");
  assert.deepEqual(cc.activeWindow(again).messages.map((m) => m.content), ["m10", "m11"]);
  // No divider: everything, no summary.
  assert.deepEqual(cc.activeWindow(ms as any), { summary: null, messages: ms });
});

test("a reopened chat reports its newest turn's context, unknown after a compaction", () => {
  const ms = [msg("user", "a"), msg("assistant", "b", { usage: { prompt: 1, completion: 1, total: 2, context: 1234 } }), msg("user", "c")];
  assert.equal(cc.lastReportedContext(ms as any), 1234);
  assert.equal(cc.lastReportedContext(cc.withCompactionDivider(ms as any, "S", 1)), 0);
  assert.equal(cc.lastReportedContext([] as any), 0);
});

test("Ctrl+K / Ctrl+L run on Settings roles, per option; images move to Images & PDFs; auto resolves", () => {
  const keys = { openrouter: "k" };
  localStorage.setItem("vault_chat_model", "anthropic/claude-sonnet-5.5");
  localStorage.removeItem("vault_chat_inline_roles");
  // B (default): edit → Background, ask → Chat.
  assert.equal(roles.inlineModel("inlineEdit", { apiKeys: keys }).role, "background");
  assert.equal(roles.inlineModel("inlineEdit", { apiKeys: keys }).spec?.id, p.DEFAULT_BACKGROUND_MODEL_ID);
  assert.equal(roles.inlineModel("inlineAsk", { apiKeys: keys }).spec?.id, "anthropic/claude-sonnet-5.5");
  localStorage.setItem("vault_chat_inline_roles", "A");
  assert.equal(roles.inlineModel("inlineEdit", { apiKeys: keys }).role, "chat");
  localStorage.setItem("vault_chat_inline_roles", "C");
  assert.equal(roles.inlineModel("inlineAsk", { apiKeys: keys }).role, "background");
  // A role set in Settings wins over the default.
  localStorage.setItem("vault_chat_background_model", "google/gemini-3.5-flash");
  assert.equal(roles.inlineModel("inlineAsk", { apiKeys: keys }).spec?.id, "google/gemini-3.5-flash");
  // An image on a text-only role model → Images & PDFs.
  localStorage.setItem("vault_chat_background_model", "qwen/qwen3-32b");
  const img = roles.inlineModel("inlineAsk", { apiKeys: keys, hasImage: true });
  assert.equal(img.role, "vision");
  assert.equal(img.switchedFrom, "background");
  assert.equal(img.spec?.id, roles.DEFAULT_VISION_MODEL_ID);
  // "auto" (the chat pane's Auto) resolves instead of failing.
  localStorage.setItem("vault_chat_inline_roles", "A");
  localStorage.setItem("vault_chat_model", "auto");
  assert.equal(roles.inlineModel("inlineEdit", { apiKeys: keys }).spec?.id, p.AUTO_ROUTER_MODEL_ID);
  for (const k of ["vault_chat_model", "vault_chat_inline_roles", "vault_chat_background_model"]) localStorage.removeItem(k);
});
