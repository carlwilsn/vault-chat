// Carl's usage limit, in process on a fake runtime: what fails on it is held
// (one limit wake per conversation, in wakes.json) and taken up as ONE turn
// after the reset — across a restart, never in a loop, and Stop cancels it.
import { piOf } from "./fakePi";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup } from "./helpers";
import { withPiSessions } from "./fakeSession";

const root = tmp("vcul-");
const vault = join(root, "vault");
mkdirSync(join(vault, ".vault-chat", "conversations"), { recursive: true });
process.env.VC_VAULT = vault;
process.env.VC_STATE_DIR = join(root, "state");
process.env.VC_LOCALSTORAGE = join(root, "ls.json");
process.env.VC_PUSH_SUBS = join(root, "subs.json");
process.env.VC_TOKEN_FILE = join(root, "token");
process.env.VC_SECRETS_DIR = join(root, "secrets");

const WORDS = "You've hit your 5-hour limit · resets 1:30am (America/Chicago)";

class FakeBackend extends EventEmitter {
  readonly name = "pi";
  h: any = null;
  turns: any[] = [];
  /** What usageLimit() says (claude/backend.ts: a rejected rate_limit_event's reset, in ms). */
  limit: { resetsAt: number | null; kind: string | null } | null = null;
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
  usageLimit() {
    return this.limit;
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
  followUps: any[] = [];
  async followUp(threadId: string, o: any) {
    this.followUps.push({ threadId, ...o });
  }
  async clearQueue() {
    return { steering: [], followUp: [] };
  }
  async interrupt() {}
  liveChildren() {
    return [];
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
    for (const x of piOf(e)) this.emit("event", { threadId, ...x });
  }
  /** The runtime refused the turn for the usage limit (claude/translate.ts's done, limited). */
  refuse(threadId: string) {
    this.ev(threadId, { kind: "turnCompleted", turnId: null, status: "failed", error: WORDS, limited: true });
  }
  complete(threadId: string) {
    this.ev(threadId, { kind: "turnCompleted", turnId: null, status: "completed", error: null });
  }
}

let Engine: any;
let readConv: (v: string, id: string) => Promise<any>;
let readWakes: (v: string) => any[];
let wakesPath: (v: string) => string;
let addWake: (v: string, w: any) => any;
const engines: any[] = [];
const logs: string[] = [];

function makeEngine(prefix: string) {
  const backend = withPiSessions(new FakeBackend(prefix), join(root, `pi-${prefix}`));
  const engine = new Engine({
    vault,
    backend: backend as any,
    ledger: { settle: async () => ({ calls: 0, usd: 0, missing: 0, byId: {} }), has: () => false } as any,
    jobEnv: { logDir: join(root, "jobs"), wrap: null, env: {} } as any,
    model: () => "openai/gpt-6.1-sol",
    webSearchModel: "x",
    apiKey: () => null,
    notify: async () => "sent",
    broadcast: () => {},
    log: (m: string) => logs.push(m),
  });
  engines.push(engine);
  engine.start();
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
  ({ readWakes, wakesPath, addWake } = await import("../engine/wakes"));
  const { configureContext } = await import("../context");
  configureContext({ vault, agentModel: "openai/gpt-6.1-sol" });
  ({ Engine } = await import("../engine/engine"));
  ({ engine, backend } = makeEngine("t"));
});

afterAll(() => {
  for (const e of engines) e.stop();
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
const holds = (convId: string) => readWakes(vault).filter((w) => w.conv === convId && w.limit);
/** The reset has come: the hold is due now (the tick fires it within ~2 s). */
const due = (convId: string) =>
  writeFileSync(wakesPath(vault), JSON.stringify(readWakes(vault).map((w) => (w.conv === convId && w.limit ? { ...w, at: Date.now() - 1 } : w))));

/** Carl sends a message; the runtime refuses it for the limit at once. Returns the turn's index. */
async function refused(e: any, be: FakeBackend, convId: string, text: string): Promise<{ tid: string; n: number }> {
  const before = be.turns.length;
  await e.message({ text, convId });
  await until(() => be.turns.length === before + 1);
  const tid = be.turns[before].threadId;
  be.refuse(tid);
  await until(async () => (await readConv(vault, convId))?.state === "sleeping");
  return { tid, n: before };
}

describe("Carl's usage limit", () => {
  it("three messages at the limit: one hold at the reset, no red line, then ONE turn — kept across a restart", async () => {
    const reset = Date.now() + 2 * 3600_000;
    backend.limit = { resetsAt: reset, kind: "five_hour" };
    const convId = `sep-${Math.random().toString(36).slice(2, 10)}`;
    const { tid } = await refused(engine, backend, convId, "First question.");
    let h = holds(convId);
    expect(h).toHaveLength(1);
    expect(h[0].at).toBe(reset + 60_000);
    expect(h[0].limit.tries).toBe(1);
    await refused(engine, backend, convId, "Second.");
    await refused(engine, backend, convId, "Third.");
    // Still one hold, at the same time; the chat has his three lines and no error.
    h = holds(convId);
    expect(h).toHaveLength(1);
    expect(h[0].at).toBe(reset + 60_000);
    let c = await readConv(vault, convId);
    expect(c.nextWakeAt).toBe(reset + 60_000);
    expect(c.messages.filter((m: any) => m.role === "user" && !m.system).map((m: any) => m.content)).toEqual(["First question.", "Second.", "Third."]);
    expect(c.messages.some((m: any) => /failed|Couldn't get a reply/.test(m.content ?? ""))).toBe(false);

    // A box update between the limit and the reset: a new process on the same vault.
    engine.stop();
    ({ engine, backend } = makeEngine("r"));
    backend.limit = null;
    expect(holds(convId)).toHaveLength(1);
    due(convId);
    await until(() => backend.turns.length === 1, 8_000);
    expect(backend.turns[0].texts.join("\n")).toMatch(/usage limit has reset/);
    expect(holds(convId)).toHaveLength(0);
    await sleep(2500);
    expect(backend.turns).toHaveLength(1); // one turn for all three
    backend.complete(backend.turns[0].threadId);
    await until(async () => (await readConv(vault, convId))?.state === "idle");
    expect(holds(convId)).toHaveLength(0);
    void tid;
  });

  it("the retry failing on the limit again waits for the next reset, never in a loop; unknown reset backs off", async () => {
    const convId = `sep-${Math.random().toString(36).slice(2, 10)}`;
    backend.limit = null; // no reset named
    const t0 = Date.now();
    await refused(engine, backend, convId, "Hello?");
    let [h] = holds(convId);
    expect(h.at - t0).toBeGreaterThanOrEqual(5 * 60_000 - 1000);
    expect(h.at - t0).toBeLessThan(6 * 60_000);
    const before = backend.turns.length;
    due(convId);
    await until(() => backend.turns.length === before + 1, 8_000);
    const t1 = Date.now();
    backend.refuse(backend.turns[before].threadId);
    await until(() => holds(convId).length === 1);
    [h] = holds(convId);
    expect(h.limit.tries).toBe(2);
    expect(h.at - t1).toBeGreaterThanOrEqual(10 * 60_000 - 1000); // doubled
    await sleep(2500);
    expect(backend.turns.length).toBe(before + 1); // nothing fired again
    // With a reset named, the next retry is at that reset.
    const reset = Date.now() + 3600_000;
    backend.limit = { resetsAt: reset, kind: "five_hour" };
    due(convId);
    // ...but the tick holds every wake while the limit stands (the limit still says no).
    await sleep(2500);
    expect(backend.turns.length).toBe(before + 1);
    backend.limit = null;
    await until(() => backend.turns.length === before + 2, 8_000);
    backend.limit = { resetsAt: reset, kind: "five_hour" };
    backend.refuse(backend.turns[before + 1].threadId);
    await until(() => holds(convId).length === 1);
    expect(holds(convId)[0].at).toBe(reset + 60_000);
    expect(holds(convId)[0].limit.tries).toBe(3);
    backend.limit = null;
  });

  it("a wake that fires into the limit is held, not lost; a wake due while the limit stands waits", async () => {
    const convId = `sep-${Math.random().toString(36).slice(2, 10)}`;
    // A conversation with a thread.
    const before = backend.turns.length;
    await engine.message({ text: "Watch the run.", convId });
    await until(() => backend.turns.length === before + 1);
    backend.complete(backend.turns[before].threadId);
    await until(async () => (await readConv(vault, convId))?.state === "idle");
    // Due while the limit stands: it stays in wakes.json and nothing runs.
    backend.limit = { resetsAt: Date.now() + 3600_000, kind: "five_hour" };
    addWake(vault, { conv: convId, at: Date.now() - 1, reason: "check the run" });
    await sleep(2500);
    expect(backend.turns.length).toBe(before + 1);
    expect(readWakes(vault).some((w) => w.conv === convId && w.reason === "check the run")).toBe(true);
    // The runtime had not said so yet: the wake fires and is refused — and is held, not lost.
    backend.limit = null;
    await until(() => backend.turns.length === before + 2, 8_000);
    expect(backend.turns[before + 1].texts.join("\n")).toMatch(/Wake: check the run/);
    backend.limit = { resetsAt: Date.now() + 3600_000, kind: "five_hour" };
    backend.refuse(backend.turns[before + 1].threadId);
    await until(() => holds(convId).length === 1);
    expect((await readConv(vault, convId)).state).toBe("sleeping");
    backend.limit = null;
    due(convId);
    await until(() => backend.turns.length === before + 3, 8_000);
    expect(backend.turns[before + 2].texts.join("\n")).toMatch(/usage limit has reset/);
    backend.complete(backend.turns[before + 2].threadId);
    await until(async () => (await readConv(vault, convId))?.state === "idle");
  });

  it("Stop cancels the held retry; a message after the reset just runs and takes it up", async () => {
    backend.limit = { resetsAt: Date.now() + 3600_000, kind: "five_hour" };
    const convId = `sep-${Math.random().toString(36).slice(2, 10)}`;
    await refused(engine, backend, convId, "Are you there?");
    expect(holds(convId)).toHaveLength(1);
    await engine.kill({ convId });
    expect(holds(convId)).toHaveLength(0);
    let c = await readConv(vault, convId);
    expect(c.state).toBe("idle");
    expect(c.nextWakeAt).toBeUndefined();
    expect(c.messages.some((m: any) => /not picked up when the limit resets/.test(m.content ?? ""))).toBe(true);

    // Held again, then Carl writes after the reset (before the hold fires): his turn runs, the hold goes.
    await refused(engine, backend, convId, "Once more.");
    expect(holds(convId)).toHaveLength(1);
    backend.limit = null;
    const before = backend.turns.length;
    await engine.message({ text: "Back now?", convId });
    await until(() => backend.turns.length === before + 1);
    expect(backend.turns[before].texts.join("\n")).toMatch(/Back now\?/);
    due(convId); // due while his turn runs: it waits, and his turn takes it all
    await sleep(2500);
    expect(backend.turns.length).toBe(before + 1);
    backend.complete(backend.turns[before].threadId);
    await until(async () => (await readConv(vault, convId))?.state === "idle");
    expect(holds(convId)).toHaveLength(0);
    await sleep(2500);
    expect(backend.turns.length).toBe(before + 1);
    c = await readConv(vault, convId);
    expect(c.messages.some((m: any) => /failed/.test(m.content ?? ""))).toBe(false);
  });
});
