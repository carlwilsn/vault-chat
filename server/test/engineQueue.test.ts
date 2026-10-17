// Messages sent while a turn runs are pi's own: a plain /message is pi's steer
// (delivered after the current tool calls), /message {queue: true} is pi's
// follow_up (delivered when the agent would stop); until pi delivers one it is
// pending in the log, and it enters the transcript where pi puts it (its user
// message_start), under the client's id. {unqueue: id} takes one back: pi's
// clear_queue, then the others go back in, in order.
import { piOf, userMsg, assistant, toolStart, toolEnd } from "./fakePi";
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
  followUps: any[] = [];
  clears = 0;
  async followUp(threadId: string, o: any) {
    this.followUps.push({ threadId, ...o });
  }
  async clearQueue() {
    this.clears++;
    return { steering: [], followUp: [] };
  }
  /** Raw pi events. */
  pi(threadId: string, evs: any[]) {
    for (const ev of evs) this.emit("event", { threadId, kind: "pi", ev });
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
    for (const x of piOf(e)) this.emit("event", { threadId: threadId, ...x });
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
  it("steers a running turn; queued messages are pi's follow-ups, pending until pi delivers them, in order; one can be taken back", async () => {
    const r = await engine.message({ text: "Write the section." });
    await until(() => backend.turns.length === 1);
    const tid = backend.turns[0].threadId;

    // Enter while it runs: pi's steer. Pending (a chip), not in the transcript yet.
    const s1 = await engine.message({ convId: r.convId, text: "Keep it under a page.", clientMsgId: "c-steer" });
    expect(s1.steered).toBe(true);
    expect(backend.steers.map((x) => x.texts.join())).toEqual(["Keep it under a page."]);

    // Tab: pi's follow-ups.
    const q1 = await engine.message({ convId: r.convId, text: "Then check the build.", queue: true, clientMsgId: "c-q1" });
    const q2 = await engine.message({ convId: r.convId, text: "And open a PR.", queue: true, clientMsgId: "c-q2" });
    const q3 = await engine.message({ convId: r.convId, text: "Never mind this one.", queue: true, clientMsgId: "c-q3" });
    expect([q1.queued, q2.queued, q3.queued]).toEqual([true, true, true]);
    expect(backend.followUps.map((x) => x.texts.join())).toEqual(["Then check the build.", "And open a PR.", "Never mind this one."]);
    let c = await readConv(vault, r.convId);
    expect(c.queued.map((q: any) => q.text)).toEqual(["Then check the build.", "And open a PR.", "Never mind this one."]);
    expect(await userTexts(r.convId)).toEqual(["Write the section."]);
    // The same message again (a retry): nothing new.
    expect((await engine.message({ convId: r.convId, text: "And open a PR.", queue: true, clientMsgId: "c-q2" })).duplicate).toBe(true);

    // Taken back before delivery: pi's queue is cleared and the others go back in, in order.
    expect((await engine.message({ convId: r.convId, unqueue: q3.qid })).ok).toBe(true);
    expect(backend.clears).toBe(1);
    expect(backend.steers.map((x) => x.texts.join())).toEqual(["Keep it under a page.", "Keep it under a page."]);
    expect(backend.followUps.slice(3).map((x) => x.texts.join())).toEqual(["Then check the build.", "And open a PR."]);
    c = await readConv(vault, r.convId);
    expect(c.queued.map((q: any) => q.id)).toEqual(["c-q1", "c-q2"]);

    // pi delivers: the steer after the current step, the follow-ups when the agent would stop.
    backend.pi(tid, [...userMsg("Write the section."), ...assistant([{ text: "Drafting." }]), ...userMsg("Keep it under a page."), ...assistant([{ text: "Short then." }])]);
    backend.pi(tid, [...userMsg("Then check the build."), ...assistant([{ text: "Build is green." }])]);
    await new Promise((res) => setTimeout(res, 200));
    c = await readConv(vault, r.convId);
    expect(c.queued.map((q: any) => q.text)).toEqual(["And open a PR."]);
    // Already delivered: can't be taken back.
    expect((await engine.message({ convId: r.convId, unqueue: q1.qid })).ok).toBe(false);
    backend.pi(tid, [...userMsg("And open a PR."), ...assistant([{ text: "PR opened." }])]);
    backend.ev(tid, { kind: "turnCompleted", turnId: "pt-1", status: "completed" });
    await until(async () => (await readConv(vault, r.convId))?.state === "idle");
    c = await readConv(vault, r.convId);
    expect(c.queued ?? []).toEqual([]);
    // One turn, in pi's order, each message under its client's id.
    expect(backend.turns).toHaveLength(1);
    expect(c.messages.filter((m: any) => !m.system).map((m: any) => [m.role, m.content])).toEqual([
      ["user", "Write the section."],
      ["assistant", "Drafting."],
      ["user", "Keep it under a page."],
      ["assistant", "Short then."],
      ["user", "Then check the build."],
      ["assistant", "Build is green."],
      ["user", "And open a PR."],
      ["assistant", "PR opened."],
    ]);
    expect(c.messages.filter((m: any) => m.role === "user").map((m: any) => m.mid).slice(1)).toEqual(["c-steer", "c-q1", "c-q2"]);
  });

  it("a steer lands where pi delivers it: after the tool calls in flight, in the log's order", async () => {
    const r = await engine.message({ text: "Go through the three chapters." });
    await until(() => backend.turns.some((t) => t.texts?.join(" ").includes("three chapters")));
    const turn = backend.turns.length;
    const tid = backend.turns[turn - 1].threadId;
    backend.pi(tid, [
      ...userMsg("Go through the three chapters."),
      ...assistant([{ text: "Reading chapter one" }, { toolCall: { id: "c1", name: "read", arguments: { path: "ch1.md" } } }, { toolCall: { id: "c2", name: "subagent", arguments: { task: "ch2" } } }]),
      toolStart("c1", "read", { path: "ch1.md" }),
      toolStart("c2", "subagent", { task: "ch2" }),
      toolEnd("c1", "read", "text"),
    ]);
    await new Promise((res) => setTimeout(res, 50));
    const s1 = await engine.message({ convId: r.convId, text: "still working?", clientMsgId: "c-still" });
    expect(s1.steered).toBe(true);
    backend.ev(tid, { kind: "subagents", itemId: "c2", children: ["sa1"], op: "spawnAgent", done: true, ok: true });
    backend.pi(tid, [
      toolEnd("c2", "subagent", "spawned"),
      ...userMsg("still working?"),
      ...assistant([{ text: "Yes — on chapter three now." }, { toolCall: { id: "c3", name: "read", arguments: { path: "ch3.md" } } }]),
      toolStart("c3", "read", { path: "ch3.md" }),
      toolEnd("c3", "read", "text"),
    ]);
    backend.ev(tid, { kind: "turnCompleted", turnId: "x", status: "completed" });
    await until(async () => (await readConv(vault, r.convId))?.state === "idle");
    const msgs = ((await readConv(vault, r.convId))?.messages ?? []).filter((m: any) => !m.system);
    expect(msgs.map((m: any) => [m.role, m.content, (m.toolCalls ?? []).map((t: any) => t.id)])).toEqual([
      ["user", "Go through the three chapters.", []],
      ["assistant", "Reading chapter one", []],
      ["assistant", "", ["c1", "c2"]],
      ["user", "still working?", []],
      ["assistant", "Yes — on chapter three now.", []],
      ["assistant", "", ["c3"]],
    ]);
    expect(msgs[2].toolCalls.map((t: any) => [t.name, t.result])).toEqual([["Read", "text"], ["subagent", "spawned"]]);
    expect(msgs[2].toolCalls[1].subagents).toEqual(["sa1"]);
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
