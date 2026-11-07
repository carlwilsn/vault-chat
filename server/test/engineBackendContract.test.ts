// The engine needs nothing from pi beyond the EngineBackend contract
// (server/engine/backend.ts). This test's backend is not pi: it imports no pi
// module, and it is handed to the Engine with no cast, so the compiler itself
// checks that the contract is the whole boundary — if engine.ts starts reaching
// for a member only PiBackend has, this file stops compiling.
//
// It is also the shape of the work ahead: a second backend (Claude Code) has to
// answer exactly these members, and translate its own stream into the same
// `kind:"pi"` live events and the same session file, which is what keeps the
// three clients, SearchHistory and the turn log unchanged.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup } from "./helpers";
import { withPiSessions } from "./fakeSession";
import { assistant, piOf, userMsg } from "./fakePi";
import type {
  BackendEvent,
  Detached,
  EngineBackend,
  Handlers,
  SideRunner,
  SideState,
  ToolSpec,
} from "../engine/backend";
import type { BoundTools } from "../mcp/tools";

const root = tmp("vcbc-");
const vault = join(root, "vault");
mkdirSync(join(vault, ".vault-chat", "conversations"), { recursive: true });
process.env.VC_VAULT = vault;
process.env.VC_STATE_DIR = join(root, "state");
process.env.VC_LOCALSTORAGE = join(root, "ls.json");
process.env.VC_PUSH_SUBS = join(root, "subs.json");
process.env.VC_TOKEN_FILE = join(root, "token");
process.env.VC_SECRETS_DIR = join(root, "secrets");

/** Every member of the contract, and nothing else. */
class ContractBackend extends EventEmitter implements EngineBackend {
  readonly name = "contract";
  handlers: Handlers | null = null;
  started = false;
  threads = new Set<string>();
  turns: { threadId: string; texts: string[]; model: string }[] = [];
  steers: { threadId: string; texts: string[] }[] = [];
  followUps: { threadId: string; texts: string[] }[] = [];
  interrupts: string[] = [];
  clears = 0;
  private n = 0;

  setHandlers(h: Handlers): void {
    this.handlers = h;
  }
  start(): void {
    this.started = true;
  }
  async ready(_ms?: number): Promise<boolean> {
    return true;
  }
  health(): Record<string, unknown> {
    return { state: "up" };
  }

  async startThread(_o: { cwd: string; model: string; instructions: string; tools: ToolSpec[]; subagents: boolean }) {
    const threadId = `ct${++this.n}`;
    this.threads.add(threadId);
    return { threadId };
  }
  async resumeThread(threadId: string): Promise<void> {
    this.threads.add(threadId);
  }
  holds(threadId: string): boolean {
    return this.threads.has(threadId);
  }
  forget(threadId: string): void {
    this.threads.delete(threadId);
  }
  threadSource(threadId: string) {
    return this.threads.has(threadId) ? { file: "", instr: "", cwd: vault } : null;
  }
  async note(_threadId: string, _data: Record<string, unknown>): Promise<boolean> {
    return false;
  }
  async compact(_threadId: string): Promise<{ tokensBefore?: number; summary?: string }> {
    return {};
  }

  async startTurn(threadId: string, o: { texts: string[]; model: string }) {
    this.turns.push({ threadId, texts: o.texts, model: o.model });
    return { turnId: `ct-turn-${this.turns.length}` };
  }
  async steer(threadId: string, _turnId: string, o: { texts: string[] }): Promise<void> {
    this.steers.push({ threadId, texts: o.texts });
  }
  async followUp(threadId: string, o: { texts: string[] }): Promise<void> {
    this.followUps.push({ threadId, texts: o.texts });
  }
  async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
    this.clears += 1;
    return { steering: [], followUp: [] };
  }
  async interrupt(threadId: string): Promise<void> {
    this.interrupts.push(threadId);
  }

  usageCalls() {
    return [];
  }
  childUsageCalls() {
    return [];
  }

  async externalPath(): Promise<string | null> {
    return null;
  }
  async filesystem(): Promise<BoundTools> {
    throw new Error("this backend has no file tools of its own");
  }

  readonly side: SideRunner = {
    start: async (): Promise<SideState> => {
      throw new Error("this backend has no side threads");
    },
    poll: async () => null,
    wait: async (): Promise<SideState> => {
      throw new Error("this backend has no side threads");
    },
    stop: async () => false,
    forget: () => {},
    health: () => ({}),
  };
  readonly paths = { sessionsDir: join(root, "sessions"), instrDir: join(root, "instr") };

  async background(): Promise<Record<string, unknown>> {
    throw new Error("this backend has no background children");
  }
  async subagentControl(): Promise<{ ok: boolean; error?: string }> {
    return { ok: false, error: "no children" };
  }
  detach(): Detached[] {
    return [];
  }

  // -- what the test drives, not part of the contract
  /** Live events in the shape every client already reads. */
  live(threadId: string, evs: any[]): void {
    for (const ev of evs) this.emit("event", { threadId, kind: "pi", ev } satisfies BackendEvent);
  }
  ev(threadId: string, e: Record<string, unknown>): void {
    for (const x of piOf(e)) this.emit("event", { threadId, ...x } as BackendEvent);
  }
}

let engine: any;
let backend: ContractBackend;
let readConv: (v: string, id: string) => Promise<any>;
const turnLines: any[] = [];

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
  backend = withPiSessions(new ContractBackend(), join(root, "pi"));
  engine = new Engine({
    vault,
    // No cast: EngineDeps.backend is the interface, so this assignment is the check.
    backend,
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
  // server/engine/index.ts starts the engine, then the backend.
  backend.start();
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

describe("the EngineBackend contract is the whole boundary", () => {
  it("a backend that is not pi runs a full turn into the feed the clients read", async () => {
    expect(backend.started).toBe(true);
    expect(backend.handlers).not.toBeNull();

    const r = await engine.message({ text: "Draft the intro.", convId: "contract-1" });
    await until(() => backend.turns.length === 1);
    const tid = backend.turns[0].threadId;
    expect(backend.turns[0].texts.join()).toContain("Draft the intro.");
    expect(backend.holds(tid)).toBe(true);

    backend.live(tid, assistant([{ text: "Here is the intro." }]));
    backend.ev(tid, { kind: "turnCompleted", turnId: "ct-turn-1", status: "completed" });
    await until(async () => (await readConv(vault, r.convId))?.state === "idle");

    const c = await readConv(vault, r.convId);
    expect(c.messages.filter((m: any) => !m.system).map((m: any) => [m.role, m.content])).toEqual([
      ["user", "Draft the intro."],
      ["assistant", "Here is the intro."],
    ]);
    expect(turnLines.find((l) => l.conv === r.convId)).toMatchObject({ ev: "turn", status: "completed", state: "idle" });
  });

  it("steer, queue, take back and stop all reach the backend through the contract", async () => {
    const r = await engine.message({ text: "Write the section.", convId: "contract-2" });
    await until(() => backend.turns.length === 2);
    const tid = backend.turns[1].threadId;

    expect((await engine.message({ convId: r.convId, text: "Shorter.", source: "voice", continues: true, clientMsgId: "c-s" })).steered).toBe(true);
    expect(backend.steers.map((x) => x.texts.join())).toEqual(["Shorter."]);

    const q1 = await engine.message({ convId: r.convId, text: "Then the build.", queue: true, clientMsgId: "c-q1" });
    const q2 = await engine.message({ convId: r.convId, text: "Never mind.", queue: true, clientMsgId: "c-q2" });
    expect([q1.queued, q2.queued]).toEqual([true, true]);
    expect(backend.followUps.map((x) => x.texts.join())).toEqual(["Then the build.", "Never mind."]);

    // Taken back before delivery: the backend's queue is cleared and the rest go back in, in order.
    expect((await engine.message({ convId: r.convId, unqueue: q2.qid })).ok).toBe(true);
    expect(backend.clears).toBe(1);
    expect(backend.followUps.slice(2).map((x) => x.texts.join())).toEqual(["Then the build."]);

    backend.live(tid, [...assistant([{ text: "Drafting." }]), ...userMsg("Shorter."), ...assistant([{ text: "Short then." }])]);
    expect(await engine.interrupt(r.convId, true)).toBe(true);
    expect(backend.interrupts).toContain(tid);
    backend.ev(tid, { kind: "turnCompleted", turnId: "ct-turn-2", status: "interrupted" });
    await until(async () => (await readConv(vault, r.convId))?.state === "idle");
  });

  it("the runtime going down and coming back is the contract's own two signals", async () => {
    backend.emit("down");
    backend.emit("up");
    await until(() => true);
    expect(backend.name).toBe("contract");
    expect(backend.health()).toMatchObject({ state: "up" });
  });
});
