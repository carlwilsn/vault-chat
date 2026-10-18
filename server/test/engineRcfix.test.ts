// What the box's end-to-end runs found, in process on a fake pi:
//  B  Done/Blocked cancel the conversation's wakes, a wake of a done/blocked
//     conversation never runs a turn, and after ScheduleWake every further call
//     but Done/Blocked is refused (and the turn is ended if the model keeps going);
//  C  one restart → one interrupted marker, one resume (the dying server does nothing);
//  E  a conversation the voice agent starts is tagged "voice";
//  F  answering an AskUser marks its ask notification answered (no notifId needed);
//  G  the AskUser call is stored once, with its answer on it;
//  and a failed keep-going turn goes straight to blocked (never "idle" on the way).
import { piOf } from "./fakePi";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup } from "./helpers";
import { withPiSessions } from "./fakeSession";

const root = tmp("vcr-");
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
  interrupts: string[] = [];
  private n = 0;
  constructor(private prefix: string) {
    super();
  }
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
    return { threadId: `${this.prefix}${this.n}`, ref: undefined };
  }
  async resumeThread() {}
  async startTurn(threadId: string, o: any) {
    this.turns.push({ threadId, ...o });
    return { turnId: `pt-${this.prefix}-${this.turns.length}` };
  }
  async steer() {}
  async followUp() {}
  async clearQueue() {
    return { steering: [], followUp: [] };
  }
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

let Engine: any;
let engineShuttingDown: (on?: boolean) => void;
let readConv: (v: string, id: string) => Promise<any>;
let readWakes: (v: string) => any[];
let addWake: (v: string, w: any) => any;
const notifs = join(vault, ".vault-chat", "notifications.jsonl");
const logs: string[] = [];
const engines: any[] = [];

/** An engine on its own fake pi; notify writes the feed the way engineNotify does. */
function makeEngine(prefix: string, stallMs?: number) {
  const backend = withPiSessions(new FakeBackend(prefix), join(root, `pi-${prefix}`));
  const engine = new Engine({
    vault,
    backend: backend as any,
    ledger: { settle: async () => ({ calls: 0, usd: 0, missing: 0, byId: {} }), has: () => false } as any,
    jobEnv: { logDir: join(root, "jobs"), wrap: null, env: {} } as any,
    model: () => "openai/gpt-6.1-sol",
    webSearchModel: "x",
    apiKey: () => null,
    notify: async (n: any) => {
      const id = `n-${Math.random().toString(36).slice(2, 10)}`;
      appendFileSync(notifs, JSON.stringify({ id, ts: Date.now(), kind: n.kind, title: n.title, body: n.body, convId: n.convId }) + "\n");
      return id;
    },
    broadcast: () => {},
    log: (m: string) => logs.push(m),
    ...(stallMs ? { stallMs } : {}),
  });
  engines.push(engine);
  return { engine, backend };
}

let engine: any;
let backend: FakeBackend;

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
  ({ readWakes, addWake } = await import("../engine/wakes"));
  const { configureContext } = await import("../context");
  configureContext({ vault, agentModel: "openai/gpt-6.1-sol", apiKey: () => null, verifierDeny: [] } as any);
  ({ Engine, engineShuttingDown } = await import("../engine/engine"));
  ({ engine, backend } = makeEngine("t"));
  engine.start();
});

afterAll(() => {
  for (const e of engines) e.stop();
  engineShuttingDown?.(false);
  cleanup(root);
});

const until = async (fn: () => Promise<boolean> | boolean, ms = 10_000) => {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const text = (r: any) => String(r?.text ?? "");

/** A new conversation with one running turn on `be`; returns its id and thread. */
async function startTurn(e: any, be: FakeBackend, msg: string) {
  const before = be.turns.length;
  const r = await e.message({ text: msg });
  await until(() => be.turns.length === before + 1);
  return { convId: r.convId as string, tid: be.turns[before].threadId as string, turnId: `pt-${(be as any).prefix}-${before + 1}` };
}

describe("B: wakes end with the work, and ScheduleWake ends the turn", () => {
  it("Done cancels the conversation's pending wakes and clears nextWakeAt", async () => {
    const { convId, tid, turnId } = await startTurn(engine, backend, "Check the run later, then finish.");
    expect((await backend.h.toolCall(tid, "ScheduleWake", { in: "1h", reason: "check" })).ok).toBe(true);
    expect(readWakes(vault).some((w) => w.conv === convId)).toBe(true);
    expect((await readConv(vault, convId)).nextWakeAt).toBeGreaterThan(Date.now());
    // Done is still allowed after ScheduleWake (it ends the work differently).
    const done = await backend.h.toolCall(tid, "Done", { summary: "finished", evidence: [] });
    expect(text(done)).toMatch(/Recorded as done/);
    expect(readWakes(vault).some((w) => w.conv === convId)).toBe(false);
    expect((await readConv(vault, convId)).nextWakeAt).toBeUndefined();
    backend.ev(tid, { kind: "turnCompleted", turnId, status: "completed", error: null });
    await until(async () => (await readConv(vault, convId))?.state === "done");
    expect((await readConv(vault, convId)).nextWakeAt).toBeUndefined();
  });

  it("Blocked cancels the wakes too", async () => {
    const { convId, tid } = await startTurn(engine, backend, "Try, and wake later.");
    await backend.h.toolCall(tid, "ScheduleWake", { in: "2h", reason: "again" });
    expect(readWakes(vault).some((w) => w.conv === convId)).toBe(true);
    await backend.h.toolCall(tid, "Blocked", { reason: "needs a key" });
    expect(readWakes(vault).some((w) => w.conv === convId)).toBe(false);
    const c = await readConv(vault, convId);
    expect(c.state).toBe("blocked");
    expect(c.nextWakeAt).toBeUndefined();
  });

  it("a wake that fires for a done or blocked conversation is dropped, never a turn", async () => {
    const { convId, tid, turnId } = await startTurn(engine, backend, "Do the thing.");
    const done = { id: convId };
    backend.ev(tid, { kind: "turnCompleted", turnId, status: "completed", error: null });
    await until(async () => (await readConv(vault, done.id))?.state === "idle");
    // Done as an older build left it: the conversation done, its wake still pending.
    const { patchMeta } = await import("../engine/convs");
    await patchMeta(vault, done.id, { state: "done" });
    const turns = backend.turns.length;
    addWake(vault, { conv: done.id, at: Date.now() - 1000, reason: "stale wake" });
    await until(() => !readWakes(vault).some((w) => w.conv === done.id), 8_000);
    await sleep(500);
    expect(backend.turns.length).toBe(turns);
    expect(logs.some((l) => l.includes(done.id) && /dropped: the conversation is done/.test(l))).toBe(true);
    expect((await readConv(vault, done.id)).messages.some((m: any) => /stale wake/.test(m.content))).toBe(false);
  });

  it("after ScheduleWake every further call but Done/Blocked is refused; a model that keeps going is ended", async () => {
    const { convId, tid, turnId } = await startTurn(engine, backend, "Start the check.");
    backend.ev(tid, { kind: "tool", itemId: "c-wake", name: "ScheduleWake", input: { in: "30m", reason: "look" } });
    const w = await backend.h.toolCall(tid, "ScheduleWake", { in: "30m", reason: "look" });
    expect(text(w)).toMatch(/Stop now: do not call any more tools this turn\.$/);
    const at = /Wake set for (\S+) /.exec(text(w))![1];
    backend.ev(tid, { kind: "tool", itemId: "c-wake", name: "ScheduleWake", input: undefined, result: text(w) });
    const n = await backend.h.toolCall(tid, "Notify", { title: "still here" });
    expect(n.ok).toBe(false);
    expect(text(n)).toBe(`You scheduled a wake for ${at}. End your turn now; you'll be woken then.`);
    const again = await backend.h.toolCall(tid, "ScheduleWake", { in: "5m", reason: "sooner" });
    expect(text(again)).toMatch(/You scheduled a wake for/);
    expect(readWakes(vault).filter((x) => x.conv === convId)).toHaveLength(1);
    // pi's own tools (refused by the extension's gate): the engine counts them and ends the turn.
    expect(backend.interrupts).not.toContain(tid);
    backend.ev(tid, { kind: "tool", itemId: "c-b1", name: "Bash", input: { command: "sleep 5" } });
    expect(backend.interrupts).not.toContain(tid);
    backend.ev(tid, { kind: "tool", itemId: "c-b2", name: "Bash", input: { command: "date" } });
    await until(() => backend.interrupts.includes(tid));
    backend.ev(tid, { kind: "turnCompleted", turnId, status: "interrupted", error: null });
    await until(async () => (await readConv(vault, convId))?.state === "sleeping");
    const last = (await readConv(vault, convId)).messages.filter((m: any) => m.role === "assistant").pop();
    expect(String(last?.content ?? "")).not.toMatch(/stopped/);
  });

  it("the extension's gate (pi's own tools) gives the same refusal, lets Done/Blocked through, and resets per turn", async () => {
    // @ts-expect-error plain JS module
    const { wakeGate } = await import("../engine/pi/ext/policy.mjs");
    const g = wakeGate();
    expect(g.check("bash")).toBeNull();
    g.onResult("ScheduleWake", "ScheduleWake needs `in`", false);
    expect(g.check("bash")).toBeNull();
    g.onResult("ScheduleWake", 'Wake scheduled for 2026-10-14T09:00:00.000Z ("x"). End your turn now; you\'ll be woken then.', false);
    expect(g.check("bash")).toBe("You scheduled a wake for 2026-10-14T09:00:00.000Z. End your turn now; you'll be woken then.");
    expect(g.check("read")).toMatch(/End your turn now/);
    expect(g.check("ScheduleWake")).toMatch(/End your turn now/);
    expect(g.check("Done")).toBeNull();
    expect(g.check("Blocked")).toBeNull();
    g.reset();
    expect(g.check("bash")).toBeNull();
  });
});

describe("F + G: one AskUser entry, and its notification answered", () => {
  it("the answer lands on the asking message's AskUser entry; the ask card is answered without a notifId", async () => {
    const { convId, tid, turnId } = await startTurn(engine, backend, "Pick a fruit with me.");
    backend.ev(tid, { kind: "textDelta", itemId: `${turnId}:1:0`, delta: "Let me ask." });
    backend.ev(tid, { kind: "tool", itemId: "c-ask", name: "AskUser", input: { question: "apple or pear?", options: ["apple", "pear"] } });
    const asked = backend.h.toolCall(tid, "AskUser", { question: "apple or pear?", options: ["apple", "pear"] });
    await until(async () => !!(await readConv(vault, convId))?.pendingAsk);
    const askId = readFileSync(notifs, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((v) => v.kind === "ask" && v.convId === convId).pop()?.id;
    expect(askId).toBeTruthy();
    // A plain /message answers the open question (no notifId).
    const r = await engine.message({ convId, text: "pear" });
    expect(r.answered).toBe(true);
    expect(text(await asked)).toBe("Carl answered: pear");
    const rows = readFileSync(notifs, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows.filter((v) => v.type === "answered" && v.id === askId)).toHaveLength(1);
    const { notificationsFeed } = await import("../phoneData");
    const card = (notificationsFeed(vault) as any).notifications.find((n: any) => n.id === askId);
    expect(card.answeredWith).toBe("pear");
    // pi reports the call's end (no input), then the turn goes on and ends.
    backend.ev(tid, { kind: "tool", itemId: "c-ask", name: "AskUser", input: undefined, result: "Carl answered: pear" });
    backend.ev(tid, { kind: "textDelta", itemId: `${turnId}:2:0`, delta: "Pear it is." });
    backend.ev(tid, { kind: "turnCompleted", turnId, status: "completed", error: null });
    await until(async () => (await readConv(vault, convId))?.state === "idle");
    await sleep(200);
    const c = await readConv(vault, convId);
    const calls = c.messages.flatMap((m: any) => (m.toolCalls ?? []).filter((t: any) => t.name === "AskUser"));
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toEqual({ question: "apple or pear?", options: ["apple", "pear"] });
    expect(calls[0].result).toBe("Carl answered: pear");
    // The question is an item of its own (its options as cards), answered by Carl's message right after it.
    const at = c.messages.findIndex((m: any) => /apple or pear/.test(m.content ?? "") && m.askOptions);
    expect(c.messages[at].askOptions.map((o: any) => o.answer)).toEqual(["apple", "pear"]);
    expect(c.messages[at + 1]).toMatchObject({ role: "user", content: "pear", decision: true });
    expect(c.messages.filter((m: any) => m.askOptions)).toHaveLength(1);
  });

  it("an answer after a restart (no live ask) marks the card too", async () => {
    const { convId, tid } = await startTurn(engine, backend, "Ask me later.");
    void backend.h.toolCall(tid, "AskUser", { question: "now or later?" });
    await until(async () => !!(await readConv(vault, convId))?.pendingAsk);
    const askId = readFileSync(notifs, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((v) => v.kind === "ask" && v.convId === convId).pop()?.id;
    // The parked turn is gone (as after a restart); the conversation still has its pendingAsk.
    (engine as any).live.delete(convId);
    const r = await engine.answerRoute({ convId, text: "later" });
    expect(r.answered).toBe(true);
    const rows = readFileSync(notifs, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows.some((v) => v.type === "answered" && v.id === askId && v.answer === "later")).toBe(true);
  });
});

describe("E: the voice agent's conversations", () => {
  it("a conversation started with source voice is tagged voice; a phone one stays phone", async () => {
    const before = backend.turns.length;
    const v = await engine.message({ text: "From voice", source: "voice" });
    const p = await engine.message({ text: "From the phone" });
    await until(() => backend.turns.length === before + 2);
    expect((await readConv(vault, v.convId)).source).toBe("voice");
    expect((await readConv(vault, p.convId)).source).toBe("phone");
  });
});

describe("finishTurn decides the final state once", () => {
  it("a failed keep-going turn is written blocked directly (the log never says idle)", async () => {
    const { convId, tid, turnId } = await startTurn(engine, backend, "Keep training.");
    await backend.h.toolCall(tid, "KeepWorking", { on: true });
    logs.length = 0;
    backend.ev(tid, { kind: "turnCompleted", turnId, status: "failed", error: "upstream 503" });
    await until(async () => (await readConv(vault, convId))?.state === "blocked");
    const line = logs.find((l) => l.includes(convId) && /^turn /.test(l));
    expect(line).toMatch(/failed → blocked$/);
    expect(logs.some((l) => l.includes(convId) && /→ idle/.test(l))).toBe(false);
    expect((await readConv(vault, convId)).working).toBe(false);
  });
});

describe("the watchdog: a running tool is not a stall", () => {
  it("an open Bash call waits for its own timeout; streamed progress and a job's log count as liveness", async () => {
    const { utimesSync } = await import("node:fs");
    const w = makeEngine("w", 200);
    w.engine.start();
    w.engine.stop(); // no timer: the test ticks the watchdog itself
    const tick = () => (w.engine as any).tickWatchdog();
    const live = (id: string) => (w.engine as any).live.get(id);

    // 1. A silent Bash command (timeout 1 s → 1 s + 5 min margin) outlives the 200 ms stall limit.
    const a = await startTurn(w.engine, w.backend, "Run the long build.");
    w.backend.ev(a.tid, { kind: "tool", itemId: "b-long", name: "Bash", input: { command: "make", timeout: 1 } });
    expect(w.engine.stallLimit(live(a.convId))).toBe(1000 + 5 * 60_000);
    await sleep(400);
    tick();
    expect(w.backend.interrupts).not.toContain(a.tid);
    // Without a timeout of its own: the extension's default (1800 s), not the stall limit.
    w.backend.ev(a.tid, { kind: "tool", itemId: "b-def", name: "Bash", input: { command: "sleep 3600" } });
    expect(w.engine.stallLimit(live(a.convId))).toBe(1800_000 + 5 * 60_000);
    // Both finish: silence is a stall again.
    w.backend.ev(a.tid, { kind: "tool", itemId: "b-long", name: "Bash", input: undefined, result: "ok" });
    w.backend.ev(a.tid, { kind: "tool", itemId: "b-def", name: "Bash", input: undefined, result: "ok" });
    expect(w.engine.stallLimit(live(a.convId))).toBe(200);
    await sleep(400);
    tick();
    await until(() => w.backend.interrupts.includes(a.tid));

    // 2. A tool streaming progress (pi's tool_execution_update) keeps the turn alive.
    const b = await startTurn(w.engine, w.backend, "Download the data.");
    w.backend.ev(b.tid, { kind: "tool", itemId: "r-1", name: "WebSearch", input: { query: "x" } });
    for (let i = 0; i < 5; i++) {
      await sleep(100);
      w.backend.ev(b.tid, { kind: "toolProgress", itemId: "r-1" });
      tick();
    }
    expect(w.backend.interrupts).not.toContain(b.tid);

    // 3. A StartJob log growing counts as progress for its conversation.
    const c = await startTurn(w.engine, w.backend, "Train in the background.");
    const log = join(root, "jobs-c.log");
    writeFileSync(log, "epoch 1\n");
    (w.engine as any).jobLogs.set(c.convId, [log]);
    for (let i = 0; i < 4; i++) {
      await sleep(120);
      appendFileSync(log, `epoch ${i + 2}\n`);
      const t = new Date();
      utimesSync(log, t, t);
      tick();
    }
    expect(w.backend.interrupts).not.toContain(c.tid);
    for (const id of [b.convId, c.convId]) live(id).finished = true;
  });
});

describe("C: one restart, one resume", () => {
  it("a crash (not a shutdown) still cuts the turn and resumes it", async () => {
    const { convId, tid } = await startTurn(engine, backend, "Long command.");
    const turns = backend.turns.length;
    backend.ev(tid, { kind: "threadLost" });
    await until(() => backend.turns.length === turns + 1, 8_000);
    const c = await readConv(vault, convId);
    expect(c.messages.filter((m: any) => /Interrupted by a restart/.test(m.content ?? ""))).toHaveLength(1);
  });

  it("pi dying with the server's shutdown does nothing; the next boot marks it once and resumes once", async () => {
    const { convId, tid } = await startTurn(engine, backend, "Run the build.");
    const turns = backend.turns.length;
    engineShuttingDown();
    backend.ev(tid, { kind: "threadLost" });
    backend.ev(tid, { kind: "turnCompleted", turnId: null, status: "interrupted", error: null });
    await sleep(2000);
    expect(backend.turns.length).toBe(turns);
    let c = await readConv(vault, convId);
    expect(c.state).toBe("running");
    expect(c.messages.some((m: any) => /Interrupted by a restart/.test(m.content ?? ""))).toBe(false);
    engine.stop();
    // The next process: a fresh engine on the same vault.
    engineShuttingDown(false);
    const next = makeEngine("n");
    next.engine.start();
    next.backend.emit("up");
    await until(() => next.backend.turns.some((t) => t.threadId === c.threadId), 8_000);
    await sleep(500);
    c = await readConv(vault, convId);
    expect(c.messages.filter((m: any) => /Interrupted by a restart/.test(m.content ?? ""))).toHaveLength(1);
    expect(next.backend.turns.filter((t) => t.threadId === c.threadId)).toHaveLength(1);
    // The resume turn is cut by the next restart too: one more marker (one per cut), one more resume.
    engineShuttingDown();
    next.engine.stop();
    engineShuttingDown(false);
    const third = makeEngine("m");
    third.engine.start();
    third.backend.emit("up");
    await until(() => third.backend.turns.some((t) => t.threadId === c.threadId), 8_000);
    await sleep(300);
    c = await readConv(vault, convId);
    expect(c.messages.filter((m: any) => /Interrupted by a restart/.test(m.content ?? ""))).toHaveLength(2);
    expect(third.backend.turns.filter((t) => t.threadId === c.threadId)).toHaveLength(1);
    third.engine.stop();
  });
});
