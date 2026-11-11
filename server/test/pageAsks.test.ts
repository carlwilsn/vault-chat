// A live page's vc.ask (src/liveBridge.ts, server/liveProxy.ts → engine.sideStart) is recorded in the shared
// activity stream that RecentActivity reads: one entry per ask (page path, prompt, reply, time, modality "page"),
// with no chat or conversation created, the ask still read-only and the per-page rate limit unchanged.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup, git } from "./helpers";
import { withPiSessions } from "./fakeSession";

const root = tmp("vcpa-");
const vault = join(root, "vault");
mkdirSync(join(vault, ".vault-chat", "conversations"), { recursive: true });
git(vault, "init", "-q");
process.env.VC_VAULT = vault;
process.env.VC_STATE_DIR = join(root, "state");
process.env.VC_LOCALSTORAGE = join(root, "ls.json");
process.env.VC_PUSH_SUBS = join(root, "subs.json");
process.env.VC_TOKEN_FILE = join(root, "token");
process.env.VC_SECRETS_DIR = join(root, "secrets");

class FakeBackend extends EventEmitter {
  readonly name = "pi";
  async ready() {
    return true;
  }
  health() {
    return {};
  }
  setHandlers() {}
  async resumeThread() {}
  usageCalls() {
    return [];
  }
  childUsageCalls() {
    return [];
  }
  async subagentControl() {
    return { ok: true };
  }
  sides: any[] = [];
  answers = new Map<string, { text: string; done: boolean }>();
  paths = { sessionsDir: join(root, "pi", "sessions"), instrDir: join(root, "pi", "instr") };
  side = {
    start: async (o: any) => {
      this.sides.push(o);
      const id = `side${this.sides.length}`;
      this.answers.set(id, { text: "", done: false });
      return { id, text: "", v: 0, done: false, error: null, file: null };
    },
    wait: async (id: string) => {
      for (;;) {
        const a = this.answers.get(id)!;
        if (a.done) return { id, text: a.text, v: 1, done: true, error: null, file: null };
        await new Promise((r) => setTimeout(r, 20));
      }
    },
  };
  threadSource() {
    return null;
  }
  finish(id: string, text: string) {
    this.answers.set(id, { text, done: true });
  }
}

let engine: any;
let backend: FakeBackend;
let act: typeof import("../activity");
let convs: typeof import("../engine/convs");

const until = async (fn: () => boolean, ms = 10_000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};
const entries = () => {
  try {
    return readFileSync(join(vault, ".vault-chat", "local", "activity.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const pageEntries = () => entries().filter((e) => e.modality === "page");

beforeAll(async () => {
  await import("../shims/globals");
  const { registerAll } = await import("../commands/registry");
  registerAll((await import("../commands/fs")).fsCommands);
  registerAll((await import("../commands/conversations")).conversationCommands);
  const store = (await import("../../src/store")).useStore;
  store.setState({ vaultPath: vault, conversationsLoaded: true });
  (await import("../context")).configureContext({ vault, agentModel: "openai/gpt-6.1-sol" });
  const { Engine } = await import("../engine/engine");
  backend = withPiSessions(new FakeBackend(), join(root, "pi")) as any;
  engine = new Engine({
    vault,
    backend: backend as any,
    ledger: { settle: async () => ({ calls: 0, usd: 0, missing: 0, byId: {} }), has: () => false } as any,
    jobEnv: { logDir: join(root, "jobs"), wrap: null, env: {} } as any,
    model: () => "openai/gpt-6.1-sol",
    webSearchModel: "x",
    apiKey: () => null,
    notify: async () => null,
    log: () => {},
    shell: () => null,
  } as any);
  engine.start();
  act = await import("../activity");
  convs = await import("../engine/convs");
});

afterAll(() => {
  engine?.stop();
  cleanup(root);
});

describe("live page asks in the activity stream", () => {
  it("records page, prompt and reply, makes no conversation, stays read-only, and RecentActivity finds it", async () => {
    const before = (await convs.allConvs(vault)).length;
    const r = await engine.sideStart({ kind: "ask", text: "What is 2+2 on my flashcard?", system: "Be brief.", page: "pages/cards.html", persist: true, tools: "act", convId: "x" });
    expect(r.ok).toBe(true);
    // Read-only ask: the page's request cannot widen it.
    expect(backend.sides[0].tools).not.toContain("bash");
    expect(pageEntries()).toHaveLength(0); // recorded when the reply is complete
    backend.finish(String(r.id), "It is 4.");
    await until(() => pageEntries().length === 1);
    const e = pageEntries()[0];
    expect(e).toMatchObject({ kind: "ask", modality: "page", path: "pages/cards.html", prompt: "What is 2+2 on my flashcard?", reply: "It is 4." });
    expect(typeof e.ts).toBe("number");
    expect(e.text).toContain("live page");
    expect((await convs.allConvs(vault)).length).toBe(before);
    const found = act.searchActivity(vault, { query: "flashcard" });
    expect(found).toContain("pages/cards.html");
    expect(found).toContain("It is 4.");
    expect(act.searchActivity(vault, { query: "4" })).toContain("What is 2+2");
  });

  it("clips a long prompt and reply to 4000 characters each", async () => {
    const long = "word ".repeat(2000);
    const r = await engine.sideStart({ kind: "ask", text: long.slice(0, 7000), page: "pages/long.html" });
    backend.finish(String(r.id), long);
    await until(() => pageEntries().length === 2);
    const e = pageEntries()[1];
    expect(e.prompt.length).toBeLessThanOrEqual(4000);
    expect(e.prompt.length).toBeGreaterThan(3900);
    expect(e.reply.length).toBeLessThanOrEqual(4000);
    expect(e.reply.length).toBeGreaterThan(3900);
  });

  it("keeps the per-page rate limit: a refused ask records nothing", async () => {
    const { LIVE_LIMITS } = await import("../../src/liveBridge");
    let refused = 0;
    for (let i = 0; i < LIVE_LIMITS.asksPerMinute + 3; i++) {
      const r = await engine.sideStart({ kind: "ask", text: `q${i}`, page: "pages/rate.html" });
      if (r.error) refused++;
      else backend.finish(String(r.id), `a${i}`);
    }
    expect(refused).toBeGreaterThan(0);
    await until(() => pageEntries().filter((e) => e.path === "pages/rate.html").length === LIVE_LIMITS.asksPerMinute);
  });

  it("an ordinary Ctrl+L ask is not recorded as a page ask", async () => {
    const n = pageEntries().length;
    const r = await engine.sideStart({ kind: "ask", text: "plain ask" });
    backend.finish(String(r.id), "ok");
    await new Promise((r) => setTimeout(r, 200));
    expect(pageEntries().length).toBe(n);
  });
});
