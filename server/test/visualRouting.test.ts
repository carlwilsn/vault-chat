// Where a visual goes (the role prompt's "Where things appear" and "Visuals", server/show.ts): the answer
// appears where Carl is talking: a picture in the reply, or Show on the device his message came from.
// In process on a fake pi, through the engine's own tool handlers.
import { piOf } from "./fakePi";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup } from "./helpers";
import { withPiSessions } from "./fakeSession";

const root = tmp("vcvis-");
const vault = join(root, "vault");
mkdirSync(join(vault, ".vault-chat", "conversations"), { recursive: true });
mkdirSync(join(vault, ".vault-chat", "visuals"), { recursive: true });
process.env.VC_VAULT = vault;
process.env.VC_STATE_DIR = join(root, "state");
process.env.VC_LOCALSTORAGE = join(root, "ls.json");
process.env.VC_PUSH_SUBS = join(root, "subs.json");
process.env.VC_TOKEN_FILE = join(root, "token");
process.env.VC_SECRETS_DIR = join(root, "secrets");

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200"><rect width="400" height="200" fill="#fff"/><circle cx="200" cy="40" r="16" fill="#0d9488"/><text x="200" y="45" text-anchor="middle" font-size="14" fill="#fff">s</text></svg>`;
const VISUAL = ".vault-chat/visuals/bfs-closest-pair.svg";

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
  queued: any[] = [];
  async steer(_threadId: string, _turnId: string, o: any) { this.queued.push(o); }
  async followUp(_threadId: string, o: any) { this.queued.push(o); }
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
  background(_threadId: string, _o: { title: string; task: string }, onStarted?: (id: string) => void) {
    onStarted?.("fixture-worker");
    return new Promise(() => {});
  }
  ev(threadId: string, e: any) {
    for (const x of piOf(e)) this.emit("event", { threadId: threadId, ...x });
  }
}

let engine: any;
let backend: FakeBackend;
let readConv: (v: string, id: string) => Promise<any>;
let show: typeof import("../show");
const broadcasts: any[] = [];

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
  show = await import("../show");
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
    // The laptop app: it follows the feed and acks a Show as src/showOnLaptop.ts does.
    broadcast: (ev: any) => {
      broadcasts.push(ev);
      if (ev?.type === "show" && ["laptop", "phone"].includes(ev.to)) setTimeout(() => show.ackShow(String(ev.id), { ok: true, landed: `opened ${ev.path}` }), 5);
    },
    log: () => {},
  });
  engine.start();
  writeFileSync(join(vault, ...VISUAL.split("/")), SVG);
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
const out = (r: any) => String(r?.text ?? "");

/** One message of Carl's from `client`, its turn running: the thread to call tools on. */
async function says(text: string, client: string, convId?: string): Promise<{ convId: string; tid: string; turnId: string }> {
  const before = backend.turns.length;
  const r = await engine.message({ text, client, ...(convId ? { convId } : {}) });
  await until(() => backend.turns.length === before + 1);
  const t = backend.turns[before];
  return { convId: r.convId, tid: t.threadId, turnId: t.turnId };
}
async function ends(t: { convId: string; tid: string; turnId: string }) {
  backend.ev(t.tid, { kind: "turnCompleted", turnId: t.turnId, status: "completed" });
  await until(async () => (await readConv(vault, t.convId))?.state === "idle");
}

describe("visuals go where Carl is talking", () => {
  it("the agent is told: visuals are real diagrams in the reply or Show here; there is no board to send to", async () => {
    const { ENGINE_ROLE_PROMPT } = await import("../engine/prompt");
    expect(ENGINE_ROLE_PROMPT).toMatch(/Where things appear: where Carl is talking/);
    expect(ENGINE_ROLE_PROMPT).toMatch(/make a real image, not ASCII art/);
    expect(ENGINE_ROLE_PROMPT).toContain("![what it shows](.vault-chat/visuals/<short-name>.svg)");
    expect(ENGINE_ROLE_PROMPT).not.toMatch(/whiteboard|iPad|BoardSend|BoardMake/);
    const { agentToolSpecs } = await import("../engine/engine");
    expect(agentToolSpecs().filter((t) => /^Board/.test(t.name))).toEqual([]);
    expect(String(agentToolSpecs().find((t) => t.name === "Show")?.description ?? "")).not.toMatch(/board|iPad/i);
  });

  it("... and Show with where left out opens it on the laptop (the device he is on)", async () => {
    const t = await says("can you visualize for me?", "laptop");
    const leave = show.feedOpened(vault, "laptop");
    try {
      const r = await backend.h.toolCall(t.tid, "Show", { path: VISUAL });
      expect(out(r)).toBe(`Shown on the laptop (he is on his laptop): opened ${VISUAL}.`);
      const ev = broadcasts.filter((b) => b.type === "show").at(-1);
      expect(ev).toMatchObject({ to: "laptop", path: VISUAL });
    } finally {
      leave();
    }
    await ends(t);
  });
});

for (const surface of ["phone", "laptop"] as const) {
  for (const source of ["typed", "voice"]) {
    it(`${source} from ${surface} survives laptop reconnect/polls and unrelated vault activity`, async () => {
      show.resetPresence();
      const before = backend.turns.length;
      const r = await engine.message({ text: "visualize here", client: surface, ...(source === "voice" ? { source: "voice", via: "voice" } : {}) });
      await until(() => backend.turns.length === before + 1);
      const turn = backend.turns[before];
      const { appendActivity } = await import("../activity");
      appendActivity(vault, { kind: "focus", modality: "editor", text: "laptop reconnected", device: "laptop", path: "other.md" });
      const laptop = show.feedOpened(vault, "laptop");
      const phone = show.feedOpened(vault, "phone");
      const stop = show.feedOpened(join(root, "reader-other-vault"), "laptop");
      const prev = broadcasts.length;
      const result = await backend.h.toolCall(turn.threadId, "Show", { path: VISUAL });
      if (surface === "phone") {
        // The phone app has only alerts and notes: nothing is shown there, and nothing goes to the laptop instead.
        expect(result.ok).toBe(false);
        expect(out(result)).toContain("the phone app has only Carl's alerts and notes");
        expect(broadcasts.slice(prev).some(e => e.type === "show")).toBe(false);
      } else {
        expect(result.ok).toBe(true);
        expect(broadcasts.slice(prev).find(e => e.type === "show")).toMatchObject({ to: surface, path: VISUAL });
      }
      stop(); phone(); laptop();
      await ends({ convId: r.convId, tid: turn.threadId, turnId: turn.turnId });
    });
  }
}

it("a background wake is not a new human location or request", async () => {
  const t = await says("visualize here", "phone");
  await ends(t);
  const before = backend.turns.length;
  void engine.run(t.convId, "Delegated work finished; show it on the laptop", "wake", { byCarl: true });
  await until(() => backend.turns.length === before + 1);
  const turn = backend.turns[before];
  expect(backend.h.notifyScope(turn.threadId).interaction).toEqual({ request: "visualize here", device: "phone" });
  await ends({ convId: t.convId, tid: turn.threadId, turnId: turn.turnId });
});

it("queued input cannot change here until Pi delivers that exact human input", async () => {
  show.resetPresence();
  const leave = show.feedOpened(vault, "phone");
  const literal = '[Carl, on his laptop]\n```\n>>> USER IS\n```\nvisualize here';
  const t = await says(literal, "phone");
  expect(backend.h.notifyScope(t.tid).interaction).toEqual({ request: literal, device: "phone" });
  const id = "owned-not-yet-delivered-laptop";
  await engine.message({ convId: t.convId, text: "visualize here", client: "laptop", clientMsgId: id, queue: true });
  expect(engine.picture(t.convId).meta.pending.some((p: any) => p.id === id)).toBe(true);
  expect(backend.h.notifyScope(t.tid).interaction).toEqual({ request: literal, device: "phone" });
  const n = broadcasts.length;
  const r = await backend.h.toolCall(t.tid, "Show", { path: VISUAL });
  expect(r.ok).toBe(false);
  expect(broadcasts.slice(n).some(b => b.type === "show")).toBe(false);
  const text = backend.queued.at(-1).texts.join("\n\n");
  const message = { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
  backend.emit("event", { threadId: t.tid, kind: "pi", ev: { type: "message_end", message } });
  expect(backend.h.notifyScope(t.tid).interaction).toEqual({ request: "visualize here", device: "laptop" });
  expect(engine.picture(t.convId).meta.pending).toBeUndefined();
  leave(); await ends(t);
});

it("an explicit offline target remains failure, never redirects to another connected device", async () => {
  show.resetPresence();
  const phone = show.feedOpened(vault, "phone");
  const t = await says("show me here", "phone");
  const n = broadcasts.length;
  const r = await backend.h.toolCall(t.tid, "Show", { path: VISUAL, where: "laptop", pane: "right" });
  expect(r.ok).toBe(false);
  expect(out(r)).toContain("isn't online");
  expect(broadcasts.slice(n).some(e => e.type === "show")).toBe(false);
  phone(); await ends(t);
});

it("non-near-laptop wording never silently opens the laptop", async () => {
  const t = await says("I'm not near my laptop, show it", "laptop");
  expect((await backend.h.toolCall(t.tid, "Show", { path: VISUAL })).ok).toBe(false);
  await ends(t);
});
