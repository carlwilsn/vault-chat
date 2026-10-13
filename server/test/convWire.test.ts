// The box's side of the full conversation, in process (no pi, no network): the
// engine on a fake backend — one entry per subagent spawn, the whole streamed
// text, thinking kept, the live context with the model's window, TodoWrite on
// the conversation, pi's compaction as the summarized divider — the phone's
// shape of it, the stream's pieces, and the box's model checks.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup } from "./helpers";

const root = tmp("vcw-");
const vault = join(root, "vault");
mkdirSync(join(vault, ".vault-chat", "conversations"), { recursive: true });
process.env.VC_VAULT = vault;
process.env.VC_STATE_DIR = join(root, "state");
process.env.VC_LOCALSTORAGE = join(root, "ls.json");
process.env.VC_PUSH_SUBS = join(root, "subs.json");
process.env.VC_TOKEN_FILE = join(root, "token");
process.env.VC_SECRETS_DIR = join(root, "secrets");

/** pi, faked: the engine sees only BackendEvents and its two handlers. */
class FakeBackend extends EventEmitter {
  readonly name = "pi";
  h: any = null;
  turns: any[] = [];
  setHandlers(h: any) {
    this.h = h;
  }
  async ready() {
    return true;
  }
  health() {
    return {};
  }
  async startThread() {
    return { threadId: "t1", ref: undefined };
  }
  async resumeThread() {}
  async startTurn(threadId: string, o: any) {
    this.turns.push({ threadId, ...o });
    return { turnId: "pt-1" };
  }
  async steer() {}
  async interrupt() {}
  usageCalls() {
    return [];
  }
  childUsageCalls() {
    return [];
  }
  async subagentControl() {
    return { ok: true };
  }
  ev(e: any) {
    this.emit("event", { threadId: "t1", ...e });
  }
}

let engine: any;
let backend: FakeBackend;
let store: any;
let readConv: (v: string, id: string) => Promise<any>;
const broadcasts: any[] = [];

beforeAll(async () => {
  await import("../shims/globals");
  const { registerAll } = await import("../commands/registry");
  const { conversationCommands } = await import("../commands/conversations");
  const { fsCommands } = await import("../commands/fs");
  registerAll(fsCommands);
  registerAll(conversationCommands);
  store = (await import("../../src/store")).useStore;
  store.setState({ vaultPath: vault, conversationsLoaded: true });
  readConv = (await import("../engine/convs")).readConv;
  const { configureContext } = await import("../context");
  configureContext({ vault, agentModel: "openai/gpt-6.1-sol", apiKey: () => null, verifierDeny: [] } as any);
  const { Engine } = await import("../engine/engine");
  backend = new FakeBackend();
  engine = new Engine({
    vault,
    backend: backend as any,
    ledger: { settle: async () => ({ calls: 0, usd: 0, missing: 0, byId: {} }), has: () => false } as any,
    jobEnv: { logDir: join(root, "jobs"), wrap: null, env: {} } as any,
    model: () => "openai/gpt-6.1-sol",
    webSearchModel: "x",
    apiKey: () => null,
    notify: async () => null,
    broadcast: (ev) => broadcasts.push(ev),
    log: () => {},
  });
  engine.start();
});

afterAll(() => {
  engine?.stop();
  cleanup(root);
});

const until = async (fn: () => Promise<boolean> | boolean, ms = 10_000) => {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};

const LONG = Array.from({ length: 120 }, (_, i) => `Line ${i}: the KV cache at 4 bits is a quarter of fp16, $\\alpha$ per channel.`).join("\n");

describe("the box's full conversation (engine on a fake pi)", () => {
  let convId = "";

  it("runs a turn: one entry per spawn, thinking, the whole text, the window, the plan, the divider", async () => {
    const r = await engine.message({ text: "Write the KV-cache section." });
    convId = r.convId;
    await until(() => backend.turns.length === 1);

    // Two children from ONE `subagent` call (parallel mode): the call carries both.
    backend.ev({ kind: "tool", itemId: "call_sub", name: "subagent", input: { tasks: [{ agent: "researcher", task: "one" }, { agent: "researcher", task: "two" }] } });
    backend.ev({ kind: "subagents", itemId: "call_sub", children: ["c1"], op: "spawnAgent", prompt: "one", model: "m", done: false, ok: false });
    backend.ev({ kind: "subagentStatus", child: "c1", status: "running", patch: { task: "one", state: "running", toolCallId: "call_sub" } });
    backend.ev({ kind: "subagents", itemId: "call_sub", children: ["c2"], op: "spawnAgent", prompt: "two", model: "m", done: false, ok: false });
    backend.ev({ kind: "subagentStatus", child: "c2", status: "running", patch: { task: "two", state: "running", toolCallId: "call_sub" } });
    backend.ev({ kind: "subagents", itemId: "call_sub", children: ["c1"], op: "spawnAgent", prompt: "one", model: "m", done: true, ok: true });
    backend.ev({ kind: "subagentStatus", child: "c1", status: "completed", patch: { state: "completed", costUsd: 0.09, summary: "six methods" } });
    backend.ev({ kind: "tool", itemId: "call_sub", name: "subagent", input: undefined, result: "Parallel: 2/2 succeeded" });

    // Thinking as it streams, then final.
    backend.ev({ kind: "reasoningDelta", delta: "Check the memory " });
    backend.ev({ kind: "reasoningDelta", delta: "factors." });
    await until(() => (store.getState().convRuntime[convId]?.streamingReasoning ?? "").includes("Check the memory factors."));
    backend.ev({ kind: "reasoning", text: "Check the memory factors." });

    // The plan, through the host tool.
    const todo = await backend.h.toolCall("t1", "TodoWrite", { todos: [{ content: "Read", status: "completed" }, { content: "Write", status: "in_progress", activeForm: "Writing" }] });
    expect(todo.ok).toBe(true);

    // The live context and the model's window.
    backend.ev({ kind: "usage", usage: { last: { inputTokens: 182_000, outputTokens: 10, totalTokens: 182_010 }, modelContextWindow: 200_000 } });
    // A long reply: the runtime mirror holds all of it.
    backend.ev({ kind: "textDelta", itemId: "pt-1:1:0", delta: LONG.slice(0, 3000) });
    backend.ev({ kind: "textDelta", itemId: "pt-1:1:0", delta: LONG.slice(3000) });
    const rt = store.getState().convRuntime[convId];
    expect(LONG.length).toBeGreaterThan(6000);
    expect(rt.streamingText).toBe(LONG);
    expect(rt.lastContext).toBe(182_000);
    expect(rt.contextWindow).toBe(200_000);

    // pi compacted its context mid-turn: the summarized divider, not a tool step.
    backend.ev({ kind: "compaction", summary: "Earlier: the survey's section 4." });
    await new Promise((r) => setTimeout(r, 200));

    backend.ev({ kind: "turnCompleted", turnId: "pt-1", status: "completed", error: null });
    await until(async () => (await readConv(vault, convId))?.messages.some((m: any) => m.role === "assistant" && !m.system));

    const c = await readConv(vault, convId);
    const reply = c.messages.filter((m: any) => m.role === "assistant" && !m.system).pop();
    expect(reply.content).toBe(LONG);
    expect(reply.thinking).toBe("Check the memory factors.");
    expect(reply.usage.window).toBe(200_000);
    expect(reply.usage.context).toBe(182_000);
    const calls = reply.toolCalls ?? [];
    expect(calls.filter((t: any) => t.name === "subagent")).toHaveLength(1);
    expect(calls.some((t: any) => t.name === "Subagent")).toBe(false);
    const sub = calls.find((t: any) => t.name === "subagent");
    expect(sub.subagents).toEqual(["c1", "c2"]);
    expect(sub.input.tasks).toHaveLength(2); // tool_execution_end's empty input never wipes it
    expect(sub.result).toMatch(/2\/2/);
    expect(calls.some((t: any) => t.name === "Compaction")).toBe(false);
    const divider = c.messages.find((m: any) => m.system && m.compaction);
    expect(divider.content).toBe("Earlier conversation summarized");
    expect(divider.compaction.summary).toMatch(/section 4/);
    expect(c.todos).toEqual([{ content: "Read", status: "completed" }, { content: "Write", status: "in_progress", activeForm: "Writing" }]);
    const subs = c.subagents ?? [];
    expect(subs.map((s: any) => s.threadId).sort()).toEqual(["c1", "c2"]);
    expect(subs.find((s: any) => s.threadId === "c1")).toMatchObject({ state: "completed", costUsd: 0.09, summary: "six methods", toolCallId: "call_sub" });
  });

  it("an older extension without the toolCallId: the child still joins the running subagent call", async () => {
    await engine.message({ convId, text: "Again, single." });
    await until(() => backend.turns.length === 2);
    backend.ev({ kind: "tool", itemId: "call_sub2", name: "subagent", input: { agent: "researcher", task: "three" } });
    backend.ev({ kind: "subagents", itemId: "sub-c3", children: ["c3"], op: "spawnAgent", prompt: "three", model: "m", done: false, ok: false });
    backend.ev({ kind: "tool", itemId: "call_sub2", name: "subagent", input: undefined, result: "done" });
    backend.ev({ kind: "textDelta", itemId: "pt-1:2:0", delta: "ok" });
    backend.ev({ kind: "turnCompleted", turnId: "pt-1", status: "completed", error: null });
    await until(async () => (await readConv(vault, convId))?.messages.filter((m: any) => m.role === "assistant" && !m.system).length === 2);
    const c = await readConv(vault, convId);
    const reply = c.messages.filter((m: any) => m.role === "assistant" && !m.system).pop();
    expect(reply.toolCalls).toHaveLength(1);
    expect(reply.toolCalls[0]).toMatchObject({ name: "subagent", subagents: ["c3"] });
  });

  it("the phone's shape carries thinking, cost, the divider, the spawns, the plan and the subagents; no legacy duplicates", async () => {
    const { conversationDetail } = await import("../phoneData");
    // A legacy turn (before 2026-10-13) with the per-child "Subagent" records.
    const legacy = {
      id: "legacy1",
      title: "old",
      source: "manual",
      createdAt: 1,
      lastActivityAt: 2,
      verdict: { verdict: "pass", notes: ["ok"], at: 3 },
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: "done", costUsd: 0.2, toolCalls: [{ id: "call_x", name: "subagent", input: {} }, { id: "sub-a", name: "Subagent", input: {} }, { id: "sub-b", name: "Subagent", input: {} }] },
        { role: "assistant", system: true, content: "Rolled over to a fresh session", rollover: { at: 4, recap: "## Where we are" } },
      ],
    };
    writeFileSync(join(vault, ".vault-chat", "conversations", "legacy1.jsonl"), [JSON.stringify({ ...legacy, messages: undefined }), ...legacy.messages.map((m) => JSON.stringify(m))].join("\n") + "\n");
    const old: any = conversationDetail(vault, "legacy1", 50);
    expect(old.messages[1].tools).toEqual(["subagent"]);
    expect(old.messages[1].costUsd).toBe(0.2);
    expect(old.messages[2].divider).toBe("## Where we are");
    expect(old.verdict.verdict).toBe("pass");

    const d: any = conversationDetail(vault, convId, 50);
    const reply = d.messages.find((m: any) => m.thinking);
    expect(reply.thinking).toBe("Check the memory factors.");
    expect(reply.spawns).toEqual(["c1", "c2"]);
    expect(reply.context).toBe(182_000);
    expect(reply.window).toBe(200_000);
    expect(d.messages.some((m: any) => m.divider && /section 4/.test(m.divider))).toBe(true);
    expect(d.todos).toHaveLength(2);
    expect(d.subagents.map((s: any) => s.threadId).sort()).toEqual(["c1", "c2", "c3"]);
  });
});

describe("the stream's pieces (src/streamWire.ts)", () => {
  it("a client that saw the start has the whole text; one that joined late waits for a keyframe", async () => {
    const { StreamWire, applyStream } = await import("../../src/streamWire");
    const w = new StreamWire(1_000);
    const text = "x".repeat(9_000);
    const sent = [1500, 4000, 7000, 9000].map((n, i) => w.next("c", text.slice(0, n), 1000 + i * 100));
    expect(sent.map((e) => e.offset)).toEqual([0, 1500, 4000, 7000]);
    let st: any = null;
    for (const e of sent) st = applyStream(st, e);
    expect(st).toEqual({ text, whole: true });
    // Joined at the third event: only the tail, flagged.
    const late = applyStream(null, sent[2]!);
    expect(late.whole).toBe(false);
    expect(late.text.length).toBe(6000);
    // The next keyframe (after keyframeMs) makes it whole again.
    const key = w.next("c", text + "y", 5000);
    expect(key.offset).toBe(0);
    expect(applyStream(late, key)).toEqual({ text: text + "y", whole: true });
  });
});

describe("the box's own models (Settings → Models, box mode)", () => {
  it("checks the chat, vision and subagent models from the catalog", async () => {
    const { setCatalogForTests } = await import("../engine/catalog");
    const { initCapabilities, boxModelChecks } = await import("../engine/capabilities");
    initCapabilities(join(root, "caps.json"), "pi-test");
    setCatalogForTests([
      { id: "a/chat", contextLength: 1_000_000, supportedParameters: ["tools", "tool_choice"], inputModalities: ["text"] },
      { id: "a/vision", contextLength: 200_000, supportedParameters: ["tools", "tool_choice"], inputModalities: ["text", "image"] },
      { id: "a/small", contextLength: 32_000, supportedParameters: ["tools"], inputModalities: ["text"] },
    ]);
    const r = boxModelChecks({ chat: "a/chat", vision: "a/vision", subagent: "a/small" });
    expect(r.chat.state).toBe("passed");
    expect(r.vision.state).toBe("passed");
    expect(r.subagent).toMatchObject({ state: "missing", missing: ["context"] });
    expect(boxModelChecks({ chat: "a/chat", vision: "a/chat", subagent: "nope/unknown" }).vision).toMatchObject({ state: "missing", missing: ["images"] });
  });
});
