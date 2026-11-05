// Where a visual goes (server/boardGuard.ts, the role prompt's "Where things appear" and "Visuals"): the answer
// appears where Carl is talking. On the laptop, "can you visualize for me?" is a picture in the reply or Show on
// the laptop — the board inbox (BoardSend, BoardMake, Show "board") is refused with why and what to do instead.
// "Send it to my iPad" still lands in the inbox; at the board (his activity there, or a call there) it is the
// board's. In process on a fake pi, through the engine's own tool handlers.
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
  made: { title: string; task: string }[] = [];
  background(_threadId: string, o: { title: string; task: string }, onStarted?: (id: string) => void) {
    onStarted?.("fixture-worker");
    this.made.push({ title: o.title, task: o.task });
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
let guard: typeof import("../boardGuard");
let inbox: typeof import("../inbox");
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
  guard = await import("../boardGuard");
  inbox = await import("../inbox");
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
  let conv = "";

  it("the agent is told: visuals are real diagrams in the reply or Show here; the board only when he asks or is there", async () => {
    const { ENGINE_ROLE_PROMPT } = await import("../engine/prompt");
    expect(ENGINE_ROLE_PROMPT).toMatch(/Where things appear: where Carl is talking/);
    expect(ENGINE_ROLE_PROMPT).toMatch(/make a real image, not ASCII art/);
    expect(ENGINE_ROLE_PROMPT).toContain("![what it shows](.vault-chat/visuals/<short-name>.svg)");
    expect(ENGINE_ROLE_PROMPT).toMatch(/only send there when he asks for it/);
    // The old rule that sent every "graph to plot" to the board's maker is gone.
    expect(ENGINE_ROLE_PROMPT).not.toMatch(/Needs making → delegate: a problem set to write, a graph to plot/);
    const { agentToolSpecs } = await import("../engine/engine");
    const spec = (n: string) => String(agentToolSpecs().find((t) => t.name === n)?.description ?? "");
    expect(spec("BoardSend")).toMatch(/Only when Carl asks for the board or his iPad .* or is at the board now/);
    expect(spec("BoardMake")).toMatch(/never for "visualize this" while he is on his laptop or phone/);
    expect(spec("Show")).toMatch(/"board" only when he asks for the board or his iPad, or is at the board/);
  });

  it('on the laptop, "can you visualize for me?": BoardSend is refused with why (nothing in the inbox), BoardMake too (nothing made)', async () => {
    const t = await says("can you visualize for me?", "laptop");
    conv = t.convId;
    const sent = await backend.h.toolCall(t.tid, "BoardSend", { title: "Why BFS level differences miss the closest pair", parts: [{ kind: "image", path: VISUAL, alt: "counterexample" }] });
    const text = out(sent);
    expect(sent.ok).toBe(false);
    expect(text).toContain("Not sent to the board: Carl is on his laptop, not at the iPad, and his request didn't ask for the board. Nothing was sent.");
    expect(text).toContain("put it in your reply as ![what it shows](its/vault/path.svg)");
    expect(text).toContain('Show {path} (where "here": his laptop)');
    expect(text).toContain("send again with asked: true");
    expect(inbox.listEntries(vault).entries).toHaveLength(0);
    const made = await backend.h.toolCall(t.tid, "BoardMake", { title: "Why BFS level differences miss the closest pair", request: "One diagram of the counterexample." });
    expect(made.ok).toBe(false);
    expect(out(made)).toContain("Nothing was made or sent.");
    expect(backend.made).toHaveLength(0);
    expect(inbox.listEntries(vault).entries).toHaveLength(0);
    // Show to the board, named by the agent, the same.
    const toBoard = await backend.h.toolCall(t.tid, "Show", { path: VISUAL, where: "board" });
    expect(out(toBoard)).toMatch(/^Not sent to the board: Carl is on his laptop/);
    expect(inbox.listEntries(vault).entries).toHaveLength(0);
  });

  it("... and Show with where left out opens it on the laptop (the device he is on)", async () => {
    const leave = show.feedOpened(vault, "laptop");
    try {
      const t = { convId: conv, tid: backend.turns.at(-1)!.threadId };
      const r = await backend.h.toolCall(t.tid, "Show", { path: VISUAL });
      expect(out(r)).toBe(`Shown on the laptop (he is on his laptop): opened ${VISUAL}.`);
      const ev = broadcasts.filter((b) => b.type === "show").at(-1);
      expect(ev).toMatchObject({ to: "laptop", path: VISUAL });
    } finally {
      leave();
    }
    await ends({ convId: conv, tid: backend.turns.at(-1)!.threadId, turnId: backend.turns.at(-1)!.turnId });
  });

  it('"send it to my iPad" still lands in the inbox (BoardSend), from the laptop', async () => {
    const t = await says("send it to my iPad", "laptop", conv);
    const sent = await backend.h.toolCall(t.tid, "BoardSend", { title: "Why BFS level differences miss the closest pair", parts: [{ kind: "image", path: VISUAL, alt: "counterexample" }] });
    expect(sent.ok).toBe(true);
    expect(out(sent)).toContain("in Carl's whiteboard inbox");
    expect(inbox.listEntries(vault).entries.map((e) => e.title)).toEqual(["Why BFS level differences miss the closest pair"]);
    await ends(t);
  });

  it("asked: true sends when he asked earlier (the agent's say-so; the check only reads his latest words)", async () => {
    const t = await says("yes, that one too", "laptop", conv);
    const no = await backend.h.toolCall(t.tid, "BoardSend", { title: "Second", parts: [{ kind: "image", path: VISUAL, alt: "x" }] });
    expect(no.ok).toBe(false);
    const yes = await backend.h.toolCall(t.tid, "BoardSend", { title: "Second", asked: true, parts: [{ kind: "image", path: VISUAL, alt: "x" }] });
    expect(out(yes)).toContain("in Carl's whiteboard inbox");
    await ends(t);
  });

  it("at the board (his message from the board) the board is his: BoardMake goes ahead", async () => {
    const t = await says("can you visualize for me?", "board", conv);
    const made = await backend.h.toolCall(t.tid, "BoardMake", { title: "BFS layers", request: "One diagram." });
    expect(out(made)).toContain("Making it in the background");
    expect(backend.made).toHaveLength(1);
    await ends(t);
  });
});

describe("the guard uses only originating interaction", () => {
  it("does not infer a location from absent metadata or a different live call", () => {
    expect(guard.boardGuard({ vault, request: "draw it", tool: "BoardSend" })).toContain("Not sent");
    expect(guard.boardGuard({ vault, request: "draw it", tool: "BoardSend", device: "board" })).toBeNull();
    expect(guard.boardGuard({ vault, request: "draw it", tool: "BoardSend", device: "phone" })).toContain("Carl is on his phone");
    expect(guard.asksForBoard("I'm not near my laptop, send it")).toBe(false);
    expect(guard.asksForBoard("send it to my iPad")).toBe(true);
  });
});

for (const surface of ["phone", "board", "laptop"] as const) {
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
      expect(result.ok).toBe(true);
      if (surface === "board") {
        expect(out(result)).toContain("board inbox");
        expect(broadcasts.slice(prev).some(e => e.type === "show" && e.to === "laptop")).toBe(false);
      } else {
        expect(broadcasts.slice(prev).find(e => e.type === "show")).toMatchObject({ to: surface, path: VISUAL });
        const refused = await backend.h.toolCall(turn.threadId, "BoardMake", { title: "No iPad", request: "Make visual" });
        expect(refused.ok).toBe(false);
        expect(out(refused)).toContain(`Carl is on his ${surface}`);
      }
      stop(); phone(); laptop();
      await ends({ convId: r.convId, tid: turn.threadId, turnId: turn.turnId });
    });
  }
}

it("a deferred worker retains original permission, but follows the current delivered interaction", async () => {
  const t = await says("visualize here", "board");
  const scope = backend.h.notifyScope(t.tid);
  expect(scope.interaction).toEqual({ device: "board", request: "visualize here" });
  await ends(t);
  const later = await says("draw it here", "phone", t.convId);
  const r = await backend.h.toolCall(later.tid, "BoardSend", { title: "Unwanted", parts: [{ kind: "math", markdown: "$x$" }] }, undefined, scope);
  expect(r.ok).toBe(false);
  expect(out(r)).toContain("Carl is on his phone");
  const explicit = await backend.h.toolCall(later.tid, "BoardSend", { title: "Asked", asked: true, parts: [{ kind: "math", markdown: "$x$" }] }, undefined, scope);
  expect(explicit.ok).toBe(true);
  await ends(later);
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

it("non-near-laptop wording never silently opens the laptop or authorizes an iPad send", async () => {
  const t = await says("I'm not near my laptop, show it", "laptop");
  expect((await backend.h.toolCall(t.tid, "Show", { path: VISUAL })).ok).toBe(false);
  expect((await backend.h.toolCall(t.tid, "BoardSend", { title: "Not asked", parts: [{ kind: "math", markdown: "$x$" }] })).ok).toBe(false);
  await ends(t);
});
