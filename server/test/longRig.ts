// In-process rig for the long-run tests: a fake pi backend (threads, turns and
// tool calls driven by the test) and the engine on a temp vault.
import { piOf } from "./fakePi";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmp } from "./helpers";
import { withPiSessions } from "./fakeSession";

export class FakeBackend extends EventEmitter {
  readonly name = "pi";
  h: any = null;
  turns: any[] = [];
  threads: any[] = [];
  interrupts: string[] = [];
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
  async startThread(o: any) {
    this.n += 1;
    this.threads.push({ threadId: `t${this.n}`, ...o });
    return { threadId: `t${this.n}`, ref: undefined };
  }
  async resumeThread() {}
  async startTurn(threadId: string, o: any) {
    this.turns.push({ threadId, ...o });
    return { turnId: `pt-${this.turns.length}` };
  }
  async steer() {}
  followUps: any[] = [];
  async followUp(threadId: string, o: any) {
    this.followUps.push({ threadId, ...o });
  }
  async interrupt(threadId: string, turnId: string) {
    this.interrupts.push(threadId);
    this.ev(threadId, { kind: "turnCompleted", turnId, status: "interrupted" });
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
  /** End a turn of a thread. */
  end(threadId: string, status = "completed") {
    const t = [...this.turns].reverse().find((x) => x.threadId === threadId);
    this.ev(threadId, { kind: "turnCompleted", turnId: `pt-${this.turns.indexOf(t) + 1}`, status });
  }
  call(threadId: string, name: string, args: any = {}) {
    return this.h.toolCall(threadId, name, args);
  }
}

export type Rig = {
  root: string;
  vault: string;
  engine: any;
  backend: FakeBackend;
  pings: any[];
  readConv: (id: string) => Promise<any>;
  allConvs: () => Promise<any[]>;
  /** Start a conversation and wait for its first turn; returns its id and thread. */
  start: (text: string, extra?: Record<string, unknown>) => Promise<{ convId: string; tid: string }>;
  costs: Map<string, number>;
};

export async function makeRig(opts: { deps?: Record<string, unknown> } = {}): Promise<Rig> {
  const root = tmp("vcl-");
  const vault = join(root, "vault");
  mkdirSync(join(vault, ".vault-chat", "conversations"), { recursive: true });
  process.env.VC_VAULT = vault;
  process.env.VC_STATE_DIR = join(root, "state");
  process.env.VC_LOCALSTORAGE = join(root, "ls.json");
  process.env.VC_PUSH_SUBS = join(root, "subs.json");
  process.env.VC_TOKEN_FILE = join(root, "token");
  process.env.VC_SECRETS_DIR = join(root, "secrets");
  process.env.VC_PI_UNSAFE = "1"; // no bubblewrap in tests
  await import("../shims/globals");
  const { registerAll } = await import("../commands/registry");
  const { conversationCommands } = await import("../commands/conversations");
  const { fsCommands } = await import("../commands/fs");
  registerAll(fsCommands);
  registerAll(conversationCommands);
  const store = (await import("../../src/store")).useStore;
  store.setState({ vaultPath: vault, conversationsLoaded: true });
  const convs = await import("../engine/convs");
  const { configureContext } = await import("../context");
  configureContext({ vault });
  const { Engine } = await import("../engine/engine");
  const backend = withPiSessions(new FakeBackend(), join(root, "pi"));
  const pings: any[] = [];
  const costs = new Map<string, number>();
  const engine = new Engine({
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
    ...(opts.deps ?? {}),
  } as any);
  engine.start();
  const rig: Rig = {
    root,
    vault,
    engine,
    backend,
    pings,
    costs,
    readConv: (id) => convs.readConv(vault, id),
    allConvs: () => convs.allConvs(vault),
    start: async (text, extra = {}) => {
      const before = backend.turns.length;
      // No convId: a new separate chat (Main is the engine's default; these tests each want a chat of their own).
      const r = await engine.message({ text, ...(extra.convId || extra.project ? {} : { convId: `sep-${Math.random().toString(36).slice(2, 10)}` }), ...extra });
      await until(() => backend.turns.length > before);
      return { convId: r.convId, tid: backend.turns[before].threadId };
    },
  };
  return rig;
}

export const until = async (fn: () => Promise<boolean> | boolean, ms = 10_000) => {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 40));
  }
};
