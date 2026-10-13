// The engine's guards against the failures that sank summer's missions, in
// process on a fake pi: a keep-going conversation whose turn fails ends
// blocked with a ping (never a silent idle), and the agent's Notify pings are
// capped per conversation per hour (no "still training normally" floods).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup } from "./helpers";

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
  it("a keep-going conversation whose turn fails ends blocked and pings Carl", async () => {
    const r = await engine.message({ text: "Train it and keep going." });
    await until(() => backend.turns.length === 1);
    const tid = backend.turns[0].threadId;
    const kw = await backend.h.toolCall(tid, "KeepWorking", { on: true });
    expect(kw.ok).toBe(true);
    backend.ev(tid, { kind: "textDelta", itemId: "pt-1:1:0", delta: "Provider error: no endpoints available." });
    backend.ev(tid, { kind: "turnCompleted", turnId: "pt-1", status: "failed", error: "upstream 503" });
    await until(async () => (await readConv(vault, r.convId))?.state === "blocked");
    const c = await readConv(vault, r.convId);
    expect(c.working).toBe(false);
    expect(pings.some((p) => p.convId === r.convId && /^Failed:/.test(p.title))).toBe(true);
    // No nudge turn was started for the failed turn.
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
});
