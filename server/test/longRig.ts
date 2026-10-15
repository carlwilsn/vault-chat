// In-process rig for the long-run tests: a fake pi backend (threads, turns and
// tool calls driven by the test), the engine on a temp vault, and a fake
// OpenRouter for the Done verifier.
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmp } from "./helpers";
import { startFakeModel, type FakeModel, type FakeReq, type FakeReply } from "../context/test/helpers";

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
    this.emit("event", { threadId, ...e });
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
  verifier: FakeModel;
  readConv: (id: string) => Promise<any>;
  allConvs: () => Promise<any[]>;
  /** Start a conversation and wait for its first turn; returns its id and thread. */
  start: (text: string, extra?: Record<string, unknown>) => Promise<{ convId: string; tid: string }>;
  /** The agent's SetProject, and Carl's answer to its card (default "Yes"). */
  setProject: (s: { convId: string; tid: string }, name: string, answer?: string) => Promise<any>;
  costs: Map<string, number>;
};

export async function makeRig(opts: { verifier?: (req: FakeReq, n: number) => FakeReply; deps?: Record<string, unknown> } = {}): Promise<Rig> {
  const root = tmp("vcl-");
  const vault = join(root, "vault");
  mkdirSync(join(vault, ".vault-chat", "conversations"), { recursive: true });
  process.env.VC_VAULT = vault;
  process.env.VC_STATE_DIR = join(root, "state");
  process.env.VC_LOCALSTORAGE = join(root, "ls.json");
  process.env.VC_PUSH_SUBS = join(root, "subs.json");
  process.env.VC_TOKEN_FILE = join(root, "token");
  process.env.VC_SECRETS_DIR = join(root, "secrets");
  process.env.VC_PI_UNSAFE = "1"; // the check runs unwrapped here (no bubblewrap in tests)
  const verifier = await startFakeModel(opts.verifier ?? (() => ({ text: '{"verdict":"pass","notes":["ok"]}' })));
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
  configureContext({ vault, agentModel: "openai/gpt-6.1-sol", apiKey: () => "sk-test", baseUrl: verifier.base, verifierDeny: [] } as any);
  const { Engine } = await import("../engine/engine");
  const backend = new FakeBackend();
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
    verifier,
    costs,
    readConv: (id) => convs.readConv(vault, id),
    allConvs: () => convs.allConvs(vault),
    start: async (text, extra = {}) => {
      const before = backend.turns.length;
      const r = await engine.message({ text, ...extra });
      await until(() => backend.turns.length > before);
      return { convId: r.convId, tid: backend.turns[before].threadId };
    },
    setProject: async (s, name, answer = "Yes") => {
      const call = backend.call(s.tid, "SetProject", { name });
      await until(async () => !!(await convs.readConv(vault, s.convId))?.pendingAsk);
      const r = await engine.message({ convId: s.convId, text: answer });
      if (!r?.answered) throw new Error(`the SetProject card was not answered: ${JSON.stringify(r)}`);
      return call;
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
