// Messages sent while a turn runs: a plain /message steers the running turn
// (pi's steer, at its next step); /message {queue: true} is held by the engine
// and runs as the next turn when this one ends, in order; {unqueue: qid} takes
// one back. The conversation's `queued` mirrors what waits, for the clients.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup } from "./helpers";

const root = tmp("vcq-");
const vault = join(root, "vault");
mkdirSync(join(vault, ".vault-chat", "conversations"), { recursive: true });
process.env.VC_VAULT = vault;
process.env.VC_STATE_DIR = join(root, "state");
process.env.VC_LOCALSTORAGE = join(root, "ls.json");
process.env.VC_PUSH_SUBS = join(root, "subs.json");
process.env.VC_TOKEN_FILE = join(root, "token");
process.env.VC_SECRETS_DIR = join(root, "secrets");

class FakeBackend extends EventEmitter {
  readonly name = "pi";
  h: any = null;
  turns: any[] = [];
  steers: any[] = [];
  private n = 0;
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
    this.n += 1;
    return { threadId: `t${this.n}`, ref: undefined };
  }
  async resumeThread() {}
  async startTurn(threadId: string, o: any) {
    this.turns.push({ threadId, ...o });
    return { turnId: `pt-${this.turns.length}` };
  }
  async steer(threadId: string, turnId: string, o: any) {
    this.steers.push({ threadId, turnId, ...o });
  }
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
  ev(threadId: string, e: any) {
    this.emit("event", { threadId, ...e });
  }
}

let engine: any;
let backend: FakeBackend;
let readConv: (v: string, id: string) => Promise<any>;

beforeAll(async () => {
  await import("../shims/globals");
  const { registerAll } = await import("../commands/registry");
  const { conversationCommands } = await import("../commands/conversations");
  const { fsCommands } = await import("../commands/fs");
  registerAll(fsCommands);
  registerAll(conversationCommands);
  const store = (await import("../../src/store")).useStore;
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
    notify: async () => "sent",
    broadcast: () => {},
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

const userTexts = async (id: string) => ((await readConv(vault, id))?.messages ?? []).filter((m: any) => m.role === "user" && !m.system).map((m: any) => m.content);

describe("steer and queue", () => {
  it("steers a running turn; queued messages wait for the end, then run in order; one can be taken back", async () => {
    const r = await engine.message({ text: "Write the section." });
    await until(() => backend.turns.length === 1);
    const tid = backend.turns[0].threadId;

    // Enter while it runs: a steer into the turn, shown at once.
    const s = await engine.message({ convId: r.convId, text: "Keep it under a page." });
    expect(s.steered).toBe(true);
    expect(backend.steers.map((x) => x.texts.join())).toEqual(["Keep it under a page."]);

    // Tab: held, listed on the conversation, not in the thread yet.
    const q1 = await engine.message({ convId: r.convId, text: "Then check the build.", queue: true });
    const q2 = await engine.message({ convId: r.convId, text: "And open a PR.", queue: true });
    const q3 = await engine.message({ convId: r.convId, text: "Never mind this one.", queue: true });
    expect([q1.queued, q2.queued, q3.queued]).toEqual([true, true, true]);
    let c = await readConv(vault, r.convId);
    expect(c.queued.map((q: any) => q.text)).toEqual(["Then check the build.", "And open a PR.", "Never mind this one."]);
    expect(await userTexts(r.convId)).toEqual(["Write the section.", "Keep it under a page."]);

    // Taken back before delivery.
    expect((await engine.message({ convId: r.convId, unqueue: q3.qid })).ok).toBe(true);
    c = await readConv(vault, r.convId);
    expect(c.queued.map((q: any) => q.id)).toEqual([q1.qid, q2.qid]);

    // The turn ends: the first queued message runs as the next turn.
    backend.ev(tid, { kind: "turnCompleted", turnId: "pt-1", status: "completed" });
    await until(() => backend.turns.length === 2);
    expect(backend.turns[1].texts.join("\n")).toMatch(/Then check the build\./);
    c = await readConv(vault, r.convId);
    expect(c.queued.map((q: any) => q.text)).toEqual(["And open a PR."]);

    // Already delivered: can't be taken back.
    expect((await engine.message({ convId: r.convId, unqueue: q1.qid })).ok).toBe(false);

    backend.ev(tid, { kind: "turnCompleted", turnId: "pt-2", status: "completed" });
    await until(() => backend.turns.length === 3);
    expect(backend.turns[2].texts.join("\n")).toMatch(/And open a PR\./);
    backend.ev(tid, { kind: "turnCompleted", turnId: "pt-3", status: "completed" });
    await until(async () => (await readConv(vault, r.convId))?.state === "idle");
    c = await readConv(vault, r.convId);
    expect(c.queued ?? []).toEqual([]);
    expect(await userTexts(r.convId)).toEqual(["Write the section.", "Keep it under a page.", "Then check the build.", "And open a PR."]);
  });

  it("a steer lands after what the turn already showed: the reply so far closes as its own message, the rest follows", async () => {
    const r = await engine.message({ text: "Go through the three chapters." });
    await until(() => backend.turns.some((t) => t.texts?.join(" ").includes("three chapters")));
    const turn = backend.turns.length;
    const tid = backend.turns[turn - 1].threadId;
    const turnId = `pt-${turn}`;
    backend.ev(tid, { kind: "turnStarted", turnId });
    backend.ev(tid, { kind: "textDelta", itemId: "x1", delta: "Reading chapter one" });
    backend.ev(tid, { kind: "tool", itemId: "c1", name: "Read", input: { path: "ch1.md" }, result: "text" });
    backend.ev(tid, { kind: "tool", itemId: "c2", name: "subagent", input: { task: "ch2" } }); // in flight
    await new Promise((res) => setTimeout(res, 50));
    const s = await engine.message({ convId: r.convId, text: "still working?" });
    expect(s.steered).toBe(true);
    // The in-flight call finishes on the message it was closed into; its children too.
    backend.ev(tid, { kind: "subagents", itemId: "c2", children: ["sa1"], op: "spawnAgent", done: true, ok: true });
    backend.ev(tid, { kind: "tool", itemId: "c2", name: "subagent", result: "spawned" });
    // The rest of the turn: the same text item finishes (whole), then more.
    backend.ev(tid, { kind: "text", itemId: "x1", text: "Reading chapter one, then two." });
    backend.ev(tid, { kind: "textDelta", itemId: "x2", delta: "Yes — on chapter three now." });
    backend.ev(tid, { kind: "tool", itemId: "c3", name: "Read", input: { path: "ch3.md" }, result: "text" });
    backend.ev(tid, { kind: "turnCompleted", turnId, status: "completed" });
    await until(async () => (await readConv(vault, r.convId))?.state === "idle");
    const msgs = ((await readConv(vault, r.convId))?.messages ?? []).filter((m: any) => !m.system);
    expect(msgs.map((m: any) => [m.role, m.content])).toEqual([
      ["user", "Go through the three chapters."],
      ["assistant", "Reading chapter one"],
      ["user", "still working?"],
      ["assistant", ", then two.\n\nYes — on chapter three now."],
    ]);
    expect(msgs[1].toolCalls.map((t: any) => [t.id, t.result])).toEqual([["c1", "text"], ["c2", "spawned"]]);
    expect(msgs[1].toolCalls[1].subagents).toEqual(["sa1"]);
    expect(msgs[3].toolCalls.map((t: any) => t.id)).toEqual(["c3"]);
  });

  it("queue with nothing running is an ordinary message", async () => {
    const before = backend.turns.length;
    const r = await engine.message({ text: "Hello" });
    await until(() => backend.turns.length === before + 1);
    backend.ev(backend.turns[before].threadId, { kind: "turnCompleted", turnId: `pt-${before + 1}`, status: "completed" });
    await until(async () => (await readConv(vault, r.convId))?.state === "idle");
    const q = await engine.message({ convId: r.convId, text: "Again", queue: true });
    expect(q.queued).toBeUndefined();
    await until(() => backend.turns.length === before + 2);
  });
});
