// The headless turn (scheduled runs, and the laptop's background turns), end to
// end under node against a scripted fake OpenRouter: cost recording, loud
// missing-key failures, provider rerouting and readable provider errors.
// (Replaces mission.test.ts: the missions system is gone — Phase 3.)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { installFakeTauri, makeTempVault, startFakeOpenRouter, type FakeOpenRouter } from "./fakes.ts";

const vault = makeTempVault();
const tauri = installFakeTauri(vault);
const providers = await import("../../src/providers.ts");
const { useStore } = await import("../../src/store.ts");
const ovr = await import("../../src/offVaultRun.ts");

const MAIN = "openai/gpt-6.1-sol";
const BG = "anthropic/claude-haiku-5.5";

const lastUserText = (body: any): string => {
  const m = [...(body.messages ?? [])].reverse().find((x: any) => x.role === "user");
  if (!m) return "";
  return typeof m.content === "string" ? m.content : (m.content ?? []).map((p: any) => p.text ?? "").join("");
};

let or: FakeOpenRouter;
before(async () => {
  or = await startFakeOpenRouter((body) => {
    if (body.model === BG) {
      // Background jobs (timeline/alert summaries) share one cheap model.
      return { text: JSON.stringify({ steps: [], reply: "ok" }), cost: 0.0001 };
    }
    if (lastUserText(body).includes("FAIL-WITH-BARE-OBJECT")) {
      // A provider error whose body has no message at all.
      return { status: 400, errorBody: { error: { code: 400, metadata: { provider_name: "Fake" } } } };
    }
    return { text: `ack: ${lastUserText(body).slice(-40)}`, cost: 0.02 };
  });
  providers.setOpenRouterBaseURL(or.url);
  useStore.setState({
    vaultPath: vault,
    apiKeys: { openrouter: "sk-canary" },
    modelId: providers.DEFAULT_MODEL_ID,
  } as any);
});
after(async () => {
  // Let fire-and-forget background work (timeline cleaning, summaries) finish
  // before the fake server goes away.
  let n = -1;
  while (n !== or.requests.length) {
    n = or.requests.length;
    await new Promise((r) => setTimeout(r, 800));
  }
  providers.setOpenRouterBaseURL(null);
  await or.close();
});

async function waitFor<T>(fn: () => Promise<T> | T, what: string, ms = 15000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

let seq = 0;
function seedConv(c: Record<string, any>): string {
  const id = c.id ?? `t${++seq}${Math.random().toString(36).slice(2, 6)}`;
  const now = Date.now();
  tauri.conversations.set(id, {
    id,
    title: c.title ?? id,
    messages: c.messages ?? [],
    status: "idle",
    createdAt: c.createdAt ?? now,
    lastActivityAt: c.lastActivityAt ?? now,
    source: c.source ?? "manual",
    unread: false,
    ...c,
  });
  return id;
}
const conv = (id: string) => tauri.conversations.get(id);
const mainRequests = () => or.requests.filter((b) => b.model !== BG);

test("a headless turn records its cost on the message and the thread", async () => {
  const c = seedConv({ source: "scheduled", title: "Cost run" });
  await ovr.runScheduledHeadlessTurn(vault, c, "first run", { modelId: MAIN });
  await ovr.runScheduledHeadlessTurn(vault, c, "second run", { modelId: MAIN });
  const assistants = conv(c).messages.filter((x: any) => x.role === "assistant");
  assert.equal(assistants.length, 2);
  assert.equal(assistants[0].costUsd, 0.02);
  assert.equal(conv(c).costUsd, 0.04);
  // The request asked OpenRouter for usage accounting.
  assert.deepEqual(mainRequests().at(-1).usage, { include: true });
});

test("no key: the turn fails loudly — a readable failed message in the thread and a notification", async () => {
  const c = seedConv({ source: "scheduled", title: "Keyless run" });
  useStore.setState({ apiKeys: {} } as any);
  const before = mainRequests().length;
  try {
    await ovr.runScheduledHeadlessTurn(vault, c, "go", { modelId: MAIN });
  } finally {
    useStore.setState({ apiKeys: { openrouter: "sk-canary" } } as any);
  }
  assert.equal(mainRequests().length, before, "no model call was made");
  const msgs = conv(c).messages;
  const last = msgs.at(-1);
  assert.equal(last.role, "assistant");
  assert.equal(last.failed, true);
  assert.match(last.content, /No OpenRouter API key/);
  assert.match(last.content, /api\.openrouter/);
  assert.equal(msgs.at(-2).content, "go", "the message that could not run is kept");
  const n = tauri.notifications.find((x) => /missing API key/i.test(x.title ?? ""));
  assert.ok(n, `a notification was raised: ${JSON.stringify(tauri.notifications.map((x) => x.title))}`);
});

test("a saved direct-provider pick runs through OpenRouter when only the OpenRouter key exists", async () => {
  const c = seedConv({ source: "scheduled", title: "Rerouted run" });
  await ovr.runScheduledHeadlessTurn(vault, c, "hello", { modelId: "claude-opus-4-8" });
  assert.equal(mainRequests().at(-1).model, "anthropic/claude-opus-4.8");
});

test("a provider failing with a message-less error object: readable, flagged failed, never [object Object]", async () => {
  const c = seedConv({ source: "scheduled", title: "Crash run" });
  await ovr.runScheduledHeadlessTurn(vault, c, "FAIL-WITH-BARE-OBJECT", { modelId: MAIN });
  const last = conv(c).messages.at(-1);
  assert.equal(last.failed, true);
  assert.ok(!String(last.content).includes("[object Object]"), last.content);
  assert.match(String(last.content), /400/);
});

test("no unknown Tauri commands were needed", () => {
  // Anything here is a command the harness calls that the fake doesn't model.
  const unexpected = [...new Set(tauri.unknown)].filter((c) => !["bash_shell_kind"].includes(c));
  assert.deepEqual(unexpected, []);
});
