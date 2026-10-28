// The engine's guards against the failures that sank summer's missions, in
// process on a fake pi: a failed turn says why in the transcript and starts no
// turn of its own, and the agent's Notify pings are capped per conversation per
// hour (no "still training normally" floods).
import { piOf } from "./fakePi";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup } from "./helpers";
import { withPiSessions } from "./fakeSession";

const root = tmp("vcg-");
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
  async steer() {}
  async interrupt() {}
  usageCalls() {
    return [];
  }
  childUsageCalls() {
    return [];
  }
  stopped: string[] = [];
  steered: { threadId: string; text?: string }[] = [];
  background_: { title: string; task: string }[] = [];
  async subagentControl(threadId: string, op: string, text?: string) {
    if (op === "stop") this.stopped.push(threadId);
    if (op === "steer") this.steered.push({ threadId, text });
    return { ok: true };
  }
  background(_threadId: string, o: { title: string; task: string }) {
    this.background_.push({ title: o.title, task: o.task });
    return new Promise(() => {});
  }
  ev(threadId: string, e: any) {
    for (const x of piOf(e)) this.emit("event", { threadId: threadId, ...x });
  }
}

let engine: any;
let backend: FakeBackend;
let readConv: (v: string, id: string) => Promise<any>;
const pings: any[] = [];

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
    notify: async (n: any) => {
      pings.push(n);
      return "sent";
    },
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

describe("engine guards", () => {
  it("a turn that fails (pi's own retries spent) says why and starts no turn of its own", async () => {
    const r = await engine.message({ text: "Train it." });
    await until(() => backend.turns.length === 1);
    const tid = backend.turns[0].threadId;
    backend.ev(tid, { kind: "textDelta", itemId: "pt-1:1:0", delta: "Provider error: no endpoints available." });
    backend.ev(tid, { kind: "turnCompleted", turnId: "pt-1", status: "failed", error: "upstream 503" });
    await until(async () => (await readConv(vault, r.convId))?.state === "idle");
    await until(async () => (await readConv(vault, r.convId))!.messages.some((m: any) => /The turn failed: upstream 503/.test(m.content ?? "")));
    expect(backend.turns.length).toBe(1);
  });

  it("caps the agent's Notify pings at 4 an hour per conversation", async () => {
    const before = backend.turns.length;
    const r = await engine.message({ text: "Watch the run." });
    await until(() => backend.turns.length === before + 1);
    const tid = backend.turns[before].threadId;
    const out: string[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await backend.h.toolCall(tid, "Notify", { title: `ping ${i}`, body: "still training normally" });
      out.push(JSON.stringify(res));
    }
    const sent = pings.filter((p) => p.convId === r.convId && /^ping /.test(p.title));
    expect(sent).toHaveLength(4);
    expect(out[4]).toMatch(/Not sent/);
    expect(out[5]).toMatch(/Not sent/);
  });
  it("'never mind' stops the work started since his previous line, not older work he didn't mention", async () => {
    const r = await engine.message({ text: "Make me a midterm guide." });
    await until(() => backend.turns.length >= 1);
    const tid = backend.turns[backend.turns.length - 1].threadId;
    const turnId = backend.turns[backend.turns.length - 1].turnId;
    backend.ev(tid, { kind: "turnCompleted", turnId, status: "completed" });
    await until(async () => (await readConv(vault, r.convId))?.state === "idle");
    const { patchMeta } = await import("../engine/convs");
    const t = Date.now();
    const sub = (threadId: string, startedAt: number) => ({ threadId, title: threadId, state: "running", startedAt });
    await patchMeta(vault, r.convId, { subagents: [sub("guide", t - 120_000), sub("flashcards", t - 2_000)] });
    await until(() => (engine.picture(r.convId)?.meta.subagents ?? []).length === 2);
    backend.stopped = [];
    // "Oh, and make flashcards" (t - 5 s) … "actually, never mind, forget the flashcards"
    expect(await engine.stopWork(r.convId, t - 5_000)).toBe(1);
    expect(backend.stopped).toEqual(["flashcards"]);
    // Nothing new since his previous line and no turn running: the newest work ("how's it going?" … "never mind").
    backend.stopped = [];
    await patchMeta(vault, r.convId, { subagents: [sub("guide", t - 120_000), sub("report", t - 60_000)] });
    await until(() => (engine.picture(r.convId)?.meta.subagents ?? []).some((x: any) => x.threadId === "report"));
    expect(await engine.stopWork(r.convId, t - 1_000)).toBe(1);
    expect(backend.stopped).toEqual(["report"]);
    // No previous line (the call's first words): everything, as before.
    backend.stopped = [];
    expect(await engine.stopWork(r.convId)).toBe(2);
  });

  it("he adds to a request mid-turn (his steer delivered) and it delegates again: the running worker gets the addition, no second worker", async () => {
    const before = backend.turns.length;
    const r = await engine.message({ text: "Make me a full midterm study guide for CS 336." });
    await until(() => backend.turns.length === before + 1);
    const tid = backend.turns[before].threadId;
    const first = await backend.h.toolCall(tid, "Delegate", { title: "Midterm guide", task: "A study guide, as a PDF." });
    expect(JSON.stringify(first)).toContain("Started in the background");
    expect(backend.background_.map((b) => b.title)).toEqual(["Midterm guide"]);
    const { patchMeta } = await import("../engine/convs");
    await patchMeta(vault, r.convId, { subagents: [{ threadId: "w-guide", title: "Midterm guide", state: "running", startedAt: Date.now() }] });
    await until(() => (engine.picture(r.convId)?.meta.subagents ?? []).some((x: any) => x.threadId === "w-guide"));
    // A second job he asked for (not the rest of his line): its own worker.
    await new Promise((res) => setTimeout(res, 5));
    await backend.h.toolCall(tid, "Delegate", { title: "Flashcards", task: "Flashcards for lecture 7." });
    expect(backend.background_).toHaveLength(2);
    // The last worker is the flashcards now; the rest of his first line refines the guide, so make it the last again.
    await backend.h.toolCall(tid, "Delegate", { title: "Midterm guide", task: "A study guide, as a PDF." });
    expect(backend.background_).toHaveLength(3);
    // "… all seven lectures, one section per lecture" arrives as a steer; the turn delegates the same request again.
    await engine.message({ convId: r.convId, text: "All seven lectures, one section per lecture.", continues: true });
    const again = await backend.h.toolCall(tid, "Delegate", { title: "Midterm guide, one section per lecture", task: "All seven lectures, one section per lecture." });
    expect(JSON.stringify(again), JSON.stringify(again)).toContain("no second worker");
    expect(backend.background_).toHaveLength(3);
    expect(backend.steered).toEqual([{ threadId: "w-guide", text: "Carl added to this request: All seven lectures, one section per lecture." }]);
  });

  it("native parallel questions cannot replace each other and SDK cancellation clears only its own question", async () => {
    const before = backend.turns.length;
    const r = await engine.message({ convId: "question-cancel", text: "Choose one." });
    await until(() => backend.turns.length === before + 1);
    const tid = backend.turns[before].threadId;
    const abort = new AbortController();
    const first = backend.h.toolCall(tid, "AskUser", { question: "First?" }, abort.signal);
    const second = await backend.h.toolCall(tid, "AskUser", { question: "Second?" });
    expect(second.text).toContain("already waiting");
    abort.abort();
    expect((await first).ok).toBe(false);
    await until(async () => !(await readConv(vault, r.convId))?.asking);
    backend.ev(tid, { kind: "turnCompleted", status: "completed" });
  });
});
