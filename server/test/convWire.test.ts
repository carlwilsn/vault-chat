// The box's side of the full conversation, in process (no pi, no network): the
// engine on a fake backend — one entry per subagent spawn, the whole streamed
// text, thinking kept, the live context with the model's window, TodoWrite on
// the conversation, pi's compaction as the summarized divider — the phone's
// shape of it, the stream's pieces, and the box's model checks.
import { piOf } from "./fakePi";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup } from "./helpers";
import { withPiSessions } from "./fakeSession";

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
    for (const x of piOf(e)) this.emit("event", { threadId: "t1", ...x });
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
  const { setLegacySource } = await import("../convlog/log");
  setLegacySource((await import("../convlog/importer")).legacySource);
  const { configureContext } = await import("../context");
  configureContext({ vault, agentModel: "openai/gpt-6.1-sol", apiKey: () => null, verifierDeny: [] } as any);
  const { Engine } = await import("../engine/engine");
  backend = withPiSessions(new FakeBackend(), join(root, "pi"));
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
  const pi = (...evs: any[]) => {
    for (const ev of evs) backend.emit("event", { threadId: "t1", kind: "pi", ev });
  };
  const upd = (e: any) => ({ type: "message_update", assistantMessageEvent: e });

  it("runs a turn: one entry per spawn, thinking and text streamed whole into the log, the window, the plan, the divider", async () => {
    const r = await engine.message({ text: "Write the KV-cache section." });
    convId = r.convId;
    await until(() => backend.turns.length === 1);
    const { pictureOf } = await import("../engine/convs");
    const { shown } = await import("../../src/convlog/reduce");

    // Two children from ONE `subagent` call (parallel mode): the call carries both.
    backend.ev({ kind: "tool", itemId: "call_sub", name: "subagent", input: { tasks: [{ agent: "researcher", task: "one" }, { agent: "researcher", task: "two" }] } });
    backend.ev({ kind: "subagents", itemId: "call_sub", children: ["c1"], op: "spawnAgent", prompt: "one", model: "m", done: false, ok: false });
    backend.ev({ kind: "subagentStatus", child: "c1", status: "running", patch: { task: "one", state: "running", toolCallId: "call_sub" } });
    backend.ev({ kind: "subagents", itemId: "call_sub", children: ["c2"], op: "spawnAgent", prompt: "two", model: "m", done: false, ok: false });
    backend.ev({ kind: "subagentStatus", child: "c2", status: "running", patch: { task: "two", state: "running", toolCallId: "call_sub" } });
    backend.ev({ kind: "subagents", itemId: "call_sub", children: ["c1"], op: "spawnAgent", prompt: "one", model: "m", done: true, ok: true });
    backend.ev({ kind: "subagentStatus", child: "c1", status: "completed", patch: { state: "completed", costUsd: 0.09, summary: "six methods" } });
    backend.ev({ kind: "tool", itemId: "call_sub", name: "subagent", input: undefined, result: "Parallel: 2/2 succeeded" });

    // Thinking as it streams: in the log while it streams, then final.
    pi({ type: "message_start", message: { role: "assistant", content: [] } }, upd({ type: "thinking_start", contentIndex: 0 }), upd({ type: "thinking_delta", contentIndex: 0, delta: "Check the memory " }), upd({ type: "thinking_delta", contentIndex: 0, delta: "factors." }));
    await until(() => !!shown(pictureOf(vault, convId)!).some((x) => x.kind === "thinking" && x.status === "streaming" && x.text === "Check the memory factors."));

    pi(upd({ type: "thinking_end", contentIndex: 0, content: "Check the memory factors." }), { type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "Check the memory factors." }], stopReason: "toolUse" } });

    // The plan: pi's TodoWrite call (the transcript carries it), answered by the host tool.
    const todos = [{ content: "Read", status: "completed" }, { content: "Write", status: "in_progress", activeForm: "Writing" }];
    backend.ev({ kind: "tool", itemId: "call_todo", name: "TodoWrite", input: { todos } });
    const todo = await backend.h.toolCall("t1", "TodoWrite", { todos });
    expect(todo.ok).toBe(true);
    backend.ev({ kind: "tool", itemId: "call_todo", name: "TodoWrite", input: undefined, result: todo.text });

    // The live context and the model's window.
    backend.ev({ kind: "usage", usage: { last: { inputTokens: 182_000, outputTokens: 10, totalTokens: 182_010 }, modelContextWindow: 200_000 } });
    // A long reply: the log holds every character while it streams.
    pi({ type: "message_start", message: { role: "assistant", content: [] } }, upd({ type: "text_start", contentIndex: 0 }), upd({ type: "text_delta", contentIndex: 0, delta: LONG.slice(0, 3000) }), upd({ type: "text_delta", contentIndex: 0, delta: LONG.slice(3000) }));
    expect(LONG.length).toBeGreaterThan(6000);
    await until(() => !!shown(pictureOf(vault, convId)!).some((x) => x.kind === "assistant" && x.status === "streaming" && x.text === LONG));
    pi(upd({ type: "text_end", contentIndex: 0, content: LONG }), { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: LONG }], stopReason: "stop", usage: { input: 182_000, output: 10 } } });
    await until(() => pictureOf(vault, convId)!.usage?.context === 182_000);
    expect(pictureOf(vault, convId)!.meta.contextWindow).toBe(200_000);

    // pi compacted its context mid-turn: the summarized divider, not a tool step.
    backend.ev({ kind: "compaction", summary: "Earlier: the survey's section 4." });
    await new Promise((r) => setTimeout(r, 200));

    backend.ev({ kind: "turnCompleted", turnId: "pt-1", status: "completed", error: null });
    await until(async () => (await readConv(vault, convId))?.state === "idle");

    const c = await readConv(vault, convId);
    const replies = c.messages.filter((m: any) => m.role === "assistant" && !m.system && m.content);
    expect(replies.pop().content).toBe(LONG);
    expect(c.messages.find((m: any) => m.thinking).thinking).toBe("Check the memory factors.");
    // In the log's order: the call, the thinking, the reply, the divider.
    const order = c.messages.filter((m: any) => m.role === "assistant").map((m: any) => (m.toolCalls ? "tools" : m.thinking ? "thinking" : m.compaction || m.rollover ? "divider" : m.system ? "notice" : "text"));
    // pi's compaction, then the roll-over the full context (182k of 200k) triggers at the turn's end.
    expect(order).toEqual(["tools", "thinking", "tools", "text", "divider", "divider"]);
    const calls = c.messages.flatMap((m: any) => m.toolCalls ?? []);
    expect(calls.filter((t: any) => t.name === "subagent")).toHaveLength(1);
    expect(calls.filter((t: any) => t.name === "TodoWrite")).toHaveLength(1);
    expect(calls.some((t: any) => t.name === "Subagent")).toBe(false);
    const sub = calls.find((t: any) => t.name === "subagent");
    expect(sub.subagents).toEqual(["c1", "c2"]);
    expect(sub.input.tasks).toHaveLength(2); // tool_execution_end's empty input never wipes it
    expect(sub.result).toMatch(/2\/2/);
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
    await until(async () => (await readConv(vault, convId))?.messages.some((m: any) => m.content === "ok"));
    const c = await readConv(vault, convId);
    const call = c.messages.flatMap((m: any) => m.toolCalls ?? []).find((t: any) => t.id === "call_sub2");
    expect(call).toMatchObject({ name: "subagent", subagents: ["c3"] });
  });

  it("the phone's shape carries thinking, cost, the divider, the spawns, the plan and the subagents; an older file reads the same, no legacy duplicates", async () => {
    const { conversationDetail } = await import("../phoneData");
    // A legacy turn (before 2026-10-13) with the per-child "Subagent" records, in an older file: imported on first read.
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
    const file = join(vault, ".vault-chat", "conversations", "legacy1.jsonl");
    const raw = [JSON.stringify({ ...legacy, messages: undefined }), ...legacy.messages.map((m) => JSON.stringify(m))].join("\n") + "\n";
    writeFileSync(file, raw);
    const { logOf } = await import("../engine/convs");
    logOf(vault).rescanLegacy();
    const old: any = conversationDetail(vault, "legacy1", 50);
    expect(old.messages.map((m: any) => [m.role, m.content, m.tools])).toEqual([
      ["user", "go", []],
      ["assistant", "done", []],
      ["assistant", "", ["subagent"]],
      ["assistant", "Earlier conversation summarized", []],
    ]);
    expect((await readConv(vault, "legacy1")).costUsd).toBe(0.2);
    expect(old.messages[3].divider).toBe("## Where we are");
    expect(old.verdict.verdict).toBe("pass");
    // The older file is never touched.
    expect(readFileSync(file, "utf8")).toBe(raw);

    const d: any = conversationDetail(vault, convId, 50);
    expect(d.messages.find((m: any) => m.thinking).thinking).toBe("Check the memory factors.");
    expect(d.messages.find((m: any) => m.spawns?.length).spawns).toEqual(["c1", "c2"]);
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
