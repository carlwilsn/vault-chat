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
  background(_threadId: string, o: { title: string; task: string }) {
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
      if (ev?.type === "show" && ev.to === "laptop") setTimeout(() => show.ackShow(String(ev.id), { ok: true, landed: `opened ${ev.path}` }), 5);
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

describe("the guard itself (server/boardGuard.ts)", () => {
  it("his words only: a PDF page's text that says 'board' in the laptop's context is not a request for the board", () => {
    const sent = [
      "[Carl, on his laptop]",
      ">>> USER IS CURRENTLY ON PAGE 1 of 3 of CS 336/Lectures/midterm_review.pdf <<<",
      'Any ambiguous reference ("this", "that") refers to PAGE 1, not other pages.',
      "Page 1 text content:",
      "Write your answer on the board. Bring a tablet.",
      "",
      "can you visualize for me?",
    ].join("\n");
    expect(guard.requestWords(sent).trim()).toBe("can you visualize for me?");
    expect(guard.asksForBoard(sent)).toBe(false);
    for (const yes of ["send it to my iPad", "put it on the board", "Put it in my inbox", "I'm not near my laptop, send it", "send to the whiteboard"]) expect(guard.asksForBoard(yes), yes).toBe(true);
    for (const no of ["can you visualize for me?", "draw the BFS tree", "show me a diagram", "onboarding"]) expect(guard.asksForBoard(no), no).toBe(false);
  });

  it("a call live on the board, or nothing that says where he is: the board is fine", () => {
    expect(guard.boardGuard({ vault, request: "draw it", tool: "BoardSend", callLive: () => true })).toBeNull();
    const empty = join(root, "empty-vault");
    mkdirSync(empty, { recursive: true });
    expect(guard.boardGuard({ vault: empty, request: "draw it", tool: "BoardSend", callLive: () => false })).toBeNull();
  });

  it("on the phone, not asked: refused, naming the phone", async () => {
    const { appendActivity } = await import("../activity");
    appendActivity(vault, { kind: "chat", modality: "chat", text: "draw it", device: "phone" });
    const why = guard.boardGuard({ vault, request: "draw it", tool: "BoardMake", callLive: () => false });
    expect(why).toContain("Carl is on his phone, not at the iPad");
    expect(why).toContain('(where "here": his phone)');
  });
});
