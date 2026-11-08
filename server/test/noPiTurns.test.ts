// No turn runs on pi, and no turn runs on nothing.
//
// Carl's chat filled with "The engine could not start this turn: No API key
// found for openrouter …", in bursts, every time a scheduled wake fired. The
// cause was not the missing key: it was that every conversation he already had
// carries `engine: "pi"` in its own meta, so each wake was routed to pi, which
// has no key and never will — "fall back to pi shouldn't be a concept because
// pi should not exist".
//
// So two things are pinned here: a conversation that says pi is still run on
// Claude Code, and a turn with nothing to run on does not start — quietly for
// a wake, which fires on a schedule, and once for something he typed.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup } from "./helpers";

const root = tmp("nopi-");
const vault = join(root, "vault");
mkdirSync(join(vault, ".vault-chat", "conversations"), { recursive: true });
process.env.VC_VAULT = vault;
process.env.VC_STATE_DIR = join(root, "state");
process.env.VC_LOCALSTORAGE = join(root, "ls.json");
process.env.VC_PUSH_SUBS = join(root, "subs.json");
process.env.VC_TOKEN_FILE = join(root, "token");
process.env.VC_SECRETS_DIR = join(root, "secrets");

/** A backend that can be told it has nothing to run a turn on. */
class Backend extends EventEmitter {
  readonly name = "claude";
  blocked: string | null = null;
  turns: unknown[] = [];
  private n = 0;
  setHandlers() {}
  async ready() {
    return true;
  }
  cannotRun() {
    return this.blocked;
  }
  health() {
    return {};
  }
  async startThread() {
    this.n += 1;
    return { threadId: `cc-${this.n}` };
  }
  async resumeThread() {}
  async startTurn(threadId: string, o: unknown) {
    this.turns.push({ threadId, o });
    return { turnId: `t-${this.turns.length}` };
  }
  async steer() {}
  async interrupt() {}
  usageCalls() {
    return [];
  }
  childUsageCalls() {
    return [];
  }
  async followUp() {}
}

let engine: any;
let backend: Backend;
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
  configureContext({ vault, agentModel: "sonnet" });
  const { Engine } = await import("../engine/engine");
  backend = new Backend();
  engine = new Engine({
    vault,
    backend: backend as any,
    ledger: { settle: async () => ({ calls: 0, usd: 0, missing: 0, byId: {} }), has: () => false } as any,
    jobEnv: { logDir: join(root, "jobs"), wrap: null, env: {} } as any,
    model: () => "sonnet",
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

describe("a turn with nothing to run on", () => {
  it("a wake waits quietly: no turn, and nothing added to the conversation", async () => {
    backend.blocked = null;
    const r = await engine.message({ text: "first" });
    await until(() => backend.turns.length === 1);
    const before = (await readConv(vault, r.convId))!.messages.length;

    backend.blocked = "Sign in with Claude to chat";
    await engine.run(r.convId, "Wake: look at the schedule", "wake");
    expect(backend.turns.length).toBe(1);
    expect((await readConv(vault, r.convId))!.messages.length).toBe(before);
  });

  it("something typed says so once, however many times it arrives", async () => {
    // The conversation exists first (as it does in the app: Carl types into one
    // that is open), then the sign-in goes.
    backend.blocked = null;
    const r = await engine.message({ text: "before" });
    await until(() => backend.turns.length >= 1);
    const turnsBefore = backend.turns.length;

    backend.blocked = "Sign in with Claude to chat";
    await engine.run(r.convId, "are you there", "user");
    await engine.run(r.convId, "still there?", "user");
    const said = (await readConv(vault, r.convId))!.messages.filter((m: any) => /Sign in with Claude to chat/.test(m.content ?? "")).length;
    expect(said).toBe(1);
    // And neither one started a turn.
    expect(backend.turns.length).toBe(turnsBefore);
  });

  it("once there is something to run on, turns run", async () => {
    backend.blocked = null;
    const r = await engine.message({ text: "now then" });
    await until(() => backend.turns.length >= 1);
  });
});
