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
import { withPiSessions } from "./fakeSession";
import { pendingOf } from "../../src/convlog/reduce";

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
  interrupts: string[] = [];
  async interrupt(threadId: string) {
    this.interrupts.push(threadId);
  }
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
/** The turn log's lines (engine/turnLog.ts). */
const turnLines: any[] = [];
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
  configureContext({ vault, agentModel: "openai/gpt-6.1-sol" });
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
    notify: async () => "sent",
    broadcast: () => {},
    log: () => {},
    vaultName: "school2",
    turnLog: (l: any) => turnLines.push(l),
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
    const r = await engine.message({ text: "Write the section.", convId: "sep-queue1" });
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
    // Carl's steer and queued messages are not in the transcript until pi delivers them; the turn's own message is, once pi took it.
    await until(async () => (await userTexts(r.convId)).length === 1);
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
    backend.pi(tid, [...assistant([{ text: "Drafting." }]), ...userMsg("Keep it under a page."), ...assistant([{ text: "Short then." }])]);
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

    // The turn's log line: its conversation and turn (the ids the feed's `running` carried), pi's figures,
    // and every steer / queued message / take-back / delivery by the client's id, in order.
    const line = turnLines.find((l) => l.conv === r.convId);
    expect(line).toMatchObject({ ev: "turn", vault: "school2", mode: "user", status: "completed", outcome: "ok", state: "idle", calls: 4, stop: "stop", tokens: { in: 4000, out: 200 } });
    expect(line.turn).toMatch(/\S/);
    expect(line.session).toBe(tid);
    expect(line.queue.map((q: any) => `${q.ev}:${q.cmid}`)).toEqual(["steer:c-steer", "queue:c-q1", "queue:c-q2", "queue:c-q3", "unqueue:c-q3", "delivered:c-steer", "delivered:c-q1", "delivered:c-q2"]);
    expect(JSON.stringify(line)).not.toMatch(/Write the section|Keep it under|Drafting/);
  });

  it("a steer lands where pi delivers it: after the tool calls in flight, in the log's order", async () => {
    const r = await engine.message({ text: "Go through the three chapters." });
    await until(() => backend.turns.some((t) => t.texts?.join(" ").includes("three chapters")));
    const turn = backend.turns.length;
    const tid = backend.turns[turn - 1].threadId;
    backend.pi(tid, [
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

  it("Send now: a waiting message cuts the agent's current step and starts the next turn at once; the others still waiting follow it; no Stopped line", async () => {
    const r = await engine.message({ text: "Read all five chapters.", convId: "sep-now1" });
    await until(() => backend.turns.some((t) => t.texts?.join(" ").includes("five chapters")));
    const turnsBefore = backend.turns.length;
    const tid = backend.turns[turnsBefore - 1].threadId;
    backend.pi(tid, [...assistant([{ text: "Reading chapter one." }])]);
    expect((await engine.message({ convId: r.convId, text: "Only chapter two.", clientMsgId: "c-now" })).steered).toBe(true);
    expect((await engine.message({ convId: r.convId, text: "And keep it short.", clientMsgId: "c-after" })).steered).toBe(true);
    const waiting = () => pendingOf(engine.picture(r.convId)).map((q: any) => q.id);
    expect(waiting()).toEqual(["c-now", "c-after"]);
    // Send now on the first: pi's stop (its queue is cleared), then the turn ends as interrupted…
    const p = engine.intent({ type: "now", convId: r.convId, id: "c-now" });
    await until(() => backend.interrupts.includes(tid));
    backend.ev(tid, { kind: "turnCompleted", turnId: `pt-${turnsBefore}`, status: "interrupted" });
    const out = await p;
    expect(out).toMatchObject({ ok: true, now: "c-now" });
    // …and the message starts the next turn, in pi's thread (the same conversation), as Carl's own message.
    await until(() => backend.turns.length === turnsBefore + 1);
    const next = backend.turns[turnsBefore];
    expect(next.threadId).toBe(tid);
    expect(next.texts.join("\n")).toContain("Only chapter two.");
    // The other waiting message follows it (pi's steer into the new turn), still pending until pi takes it.
    await until(() => backend.steers.filter((x) => x.texts.join() === "And keep it short.").length === 2);
    await until(() => waiting().join() === "c-after");
    backend.pi(tid, [...userMsg("Only chapter two."), ...assistant([{ text: "Chapter two, then." }]), ...userMsg("And keep it short."), ...assistant([{ text: "Short." }])]);
    backend.ev(tid, { kind: "turnCompleted", turnId: `pt-${turnsBefore + 1}`, status: "completed" });
    await until(async () => (await readConv(vault, r.convId))?.state === "idle");
    const c = await readConv(vault, r.convId);
    expect(c.messages.some((m: any) => m.system && /Stopped/.test(m.content))).toBe(false);
    expect(c.messages.filter((m: any) => !m.system).map((m: any) => [m.role, m.content])).toEqual([
      ["user", "Read all five chapters."],
      ["assistant", "Reading chapter one."],
      ["user", "Only chapter two."],
      ["assistant", "Chapter two, then."],
      ["user", "And keep it short."],
      ["assistant", "Short."],
    ]);
    expect(c.messages.filter((m: any) => m.role === "user").map((m: any) => m.mid).slice(1)).toEqual(["c-now", "c-after"]);
    // Already taken: Send now says so.
    expect((await engine.intent({ type: "now", convId: r.convId, id: "c-now" })).ok).toBe(false);
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
