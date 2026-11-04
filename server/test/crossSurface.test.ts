// One agent across surfaces: does the NEXT surface's agent see what Carl just
// did on the previous one? (Carl, 2026-10-18: "I'm interacting with one agent
// but on many surfaces, and I should be able to seamlessly move around, and the
// agent can see and move with me.")
//
// Each scenario is one "move around" story, run through the real code: the
// engine on a fake pi (the turn's prompt and the "you" layer pi's extension
// adds after it, as the model gets them: fakeSession.ts), the shared activity stream, the board inbox and
// boards. The assertion is always about what the next surface's agent context CONTAINS: a pi turn's texts and
// images (startTurn), and the "you" layer the extension's before_agent_start adds (a vc-you message). The voice
// is the conversation's own pi turn (server/voiceBrain.ts), so a call sees exactly what a typed turn sees; its own
// cross-surface rules (one context, each surface its own exchange) are in server/test/voiceBrain.test.ts.
//
// One main conversation (2026-10-21, src/threads.ts): a message that names no conversation is Main's,
// on every surface, as the engine does it; a project's thread is "project-<slug>".
//
// Today's holes are written as `hole(...)`: the check runs, and the test passes
// while the check FAILS (the build stays green). When a hole is closed the
// check holds and the test fails with "the hole is closed" — move it to `it`.
// The editor's shared focus entries are in test/harness/crosssurface.test.ts.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { piOf } from "./fakePi";
import { tmp, cleanup, git, seedProject } from "./helpers";
import { withPiSessions } from "./fakeSession";

const root = tmp("vccross-");
const vault = join(root, "vault");
mkdirSync(join(vault, ".vault-chat", "conversations"), { recursive: true });
mkdirSync(join(vault, "papers"), { recursive: true });
mkdirSync(join(vault, "notes"), { recursive: true });
// One of Carl's own vault tools (a calendar, say): the agent's on every surface.
mkdirSync(join(vault, ".vault-chat", "tools", "cal"), { recursive: true });
writeFileSync(join(vault, ".vault-chat", "tools", "cal", "TOOL.md"), "---\nname: CalendarToday\ndescription: Today's events.\n---\n");
writeFileSync(join(vault, ".vault-chat", "tools", "cal", "run.sh"), "echo 'Psych 221 at 2pm'\n");
git(vault, "init", "-q");
writeFileSync(join(vault, "notes", "fixed-point.md"), "# Fixed points\n\nLemma 2. Every contraction on a complete metric space has a unique fixed point.\n");
process.env.VC_VAULT = vault;
process.env.VC_STATE_DIR = join(root, "state");
process.env.VC_LOCALSTORAGE = join(root, "ls.json");
process.env.VC_PUSH_SUBS = join(root, "subs.json");
process.env.VC_TOKEN_FILE = join(root, "token");
process.env.VC_SECRETS_DIR = join(root, "secrets");

// ---------------------------------------------------------------- a PNG, built (no opaque literals in the source)

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** A w×h grey PNG; `shade` makes pictures differ. */
function png(shade = 128, w = 2, h = 2): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  const rows = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rows[y * (w + 1) + 1 + x] = shade;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
const b64 = (b: Buffer) => b.toString("base64");

// ---------------------------------------------------------------- the fake pi (as server/test/contextAudit.test.ts)

type Handlers = { toolCall: (threadId: string, name: string, args: any) => Promise<{ ok: boolean; text: string }> };

class FakeBackend extends EventEmitter {
  readonly name = "pi";
  threads: { threadId: string; instructions: string; tools: string[] }[] = [];
  turns: { threadId: string; texts: string[]; context: string | null; images: string[]; turnId: string }[] = [];
  handlers: Handlers | null = null;
  setHandlers(h: Handlers) {
    this.handlers = h;
  }
  async ready() {
    return true;
  }
  health() {
    return {};
  }
  async startThread(o: any) {
    const threadId = `t${this.threads.length + 1}`;
    this.threads.push({ threadId, instructions: o.instructions, tools: (o.tools ?? []).map((t: any) => t.name) });
    return { threadId, ref: undefined };
  }
  async resumeThread() {}
  async startTurn(threadId: string, o: any) {
    const turnId = `${threadId}-turn${this.turns.length + 1}`;
    // Preserve the backend's separate typed context input; native pi persists
    // it before the prompt, then adds the "you" layer (fakeSession.ts).
    this.turns.push({ threadId, texts: o.you ? [...o.texts, o.you] : o.texts, context: o.context ?? null, images: o.images ?? [], turnId });
    return { turnId };
  }
  async steer() {}
  async followUp() {}
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
  sides: any[] = [];
  paths = { sessionsDir: join(root, "pi", "sessions"), instrDir: join(root, "pi", "instr") };
  side = {
    start: async (o: any) => {
      this.sides.push(o);
      return { id: `side${this.sides.length}`, text: "", v: 0, done: false, error: null, file: null };
    },
  };
  threadSource(threadId: string) {
    return { file: join(root, "pi", `${threadId}.jsonl`), instr: join(root, "pi", `${threadId}.md`), cwd: vault };
  }
  reply(text: string) {
    const t = this.turns[this.turns.length - 1]!;
    for (const x of piOf({ kind: "text", text })) this.emit("event", { threadId: t.threadId, ...x });
    this.emit("event", { threadId: t.threadId, kind: "turnCompleted", turnId: t.turnId, status: "completed", error: null });
  }
}

let engine: any;
let backend: FakeBackend;
let act: typeof import("../activity");
let convs: typeof import("../engine/convs");
const broadcasts: any[] = [];

const until = async (fn: () => Promise<boolean> | boolean, ms = 10_000) => {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new SetupError("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};

type Turn = { texts: string[]; context: string | null; images: string[]; instructions: string | null; convId: string; threadId: string; all: string };

/** One user turn through the engine (any client: laptop, phone, board): what pi got, then the reply. */
async function turn(body: Record<string, unknown>, reply: string, during?: (threadId: string) => Promise<void>): Promise<Turn> {
  const before = backend.turns.length;
  const threadsBefore = backend.threads.length;
  const out = await engine.message(body);
  if (!out?.ok) throw new SetupError(`message refused: ${JSON.stringify(out)}`);
  await until(() => backend.turns.length > before);
  const t = backend.turns.at(-1)!;
  const instructions = backend.threads.length > threadsBefore ? backend.threads.at(-1)!.instructions : null;
  if (during) await during(t.threadId);
  backend.reply(reply);
  await until(async () => (await convs.readConv(vault, String(out.convId)))?.state !== "running");
  return { texts: t.texts, context: t.context, images: t.images, instructions, convId: String(out.convId), threadId: t.threadId, all: [instructions ?? "", t.context ?? "", ...t.texts].join("\n") };
}

/** Voice's Asks run as pi side threads (engine.sideStart, on the fake backend): each is answered by the test. */
const need = <T>(x: T | null | undefined, what: string): T => {
  if (x === null || x === undefined) throw new SetupError(`setup missing: ${what}`);
  return x;
};

type Row = { scenario: string; surface: string; check: string; status: "PASS" | "HOLE" };
const rows: Row[] = [];

/** A check that holds today. */
function pass(scenario: string, surface: string, check: string, fn: () => Promise<void> | void) {
  it(`${scenario} · ${surface}: ${check}`, async () => {
    await fn();
    rows.push({ scenario, surface, check, status: "PASS" });
  });
}

/** A check that FAILS today (a hole): the test passes while it fails, and fails once it holds. */
function hole(scenario: string, surface: string, check: string, fn: () => Promise<void> | void) {
  it(`HOLE ${scenario} · ${surface}: ${check}`, async () => {
    let failed: unknown = null;
    try {
      await fn();
    } catch (e) {
      if (e instanceof SetupError) throw e;
      failed = e;
    }
    if (!failed) throw new Error(`"${check}" now holds — the hole is closed: make it a pass() check`);
    rows.push({ scenario, surface, check, status: "HOLE" });
  });
}

// ---------------------------------------------------------------- setup

beforeAll(async () => {
  await import("../shims/globals");
  const { registerAll } = await import("../commands/registry");
  registerAll((await import("../commands/fs")).fsCommands);
  registerAll((await import("../commands/conversations")).conversationCommands);
  const store = (await import("../../src/store")).useStore;
  store.setState({ vaultPath: vault, conversationsLoaded: true });
  const ctx = await import("../context");
  ctx.configureContext({ vault, agentModel: "openai/gpt-6.1-sol" });
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
    notify: async () => null,
    broadcast: (ev: any) => broadcasts.push(ev),
    log: () => {},
    shell: () => null,
  } as any);
  engine.start();
  act = await import("../activity");
  convs = await import("../engine/convs");
});

afterAll(async () => {
  engine?.stop();
  // The table the report quotes.
  console.log("\nscenario | surface | check | today");
  for (const r of rows) console.log(`${r.scenario} | ${r.surface} | ${r.check} | ${r.status}`);
  cleanup(root);
});

// ================================================================ the stories

describe("a. Ctrl+L on the laptop about a PDF selection, then the phone: \"what did I just ask about?\"", () => {
  let laptop: Turn | null = null;
  let phone: Turn | null = null;
  let late: Turn | null = null;

  it("setup: a laptop chat, a Ctrl+L side thread forked from it, the laptop's ask entry", async () => {
    laptop = await turn({ text: "I'm reading the iterative methods paper.", client: "laptop" }, "Good — ask me anything about it.");
    act.activityPost(vault, { entry: { kind: "focus", modality: "editor", text: "reading", path: "papers/iterative.pdf", where: "page 7 of 20" } });
    act.activityPost(vault, { entry: { kind: "focus", modality: "editor", text: 'selected "the spectral radius of T is below one"', path: "papers/iterative.pdf", where: "selection" } });
    const side = await engine.sideStart({ kind: "ask", convId: laptop.convId, text: "Why does this guarantee convergence?" });
    expect(side.ok).toBe(true);
    expect(backend.sides.at(-1).fork).toMatch(/\.jsonl$/);
    act.activityPost(vault, {
      entry: {
        kind: "ask",
        modality: "ctrl-l",
        text: 'asked "Why does this guarantee convergence?" about "the spectral radius of T is below one"',
        detail: "answer: the error shrinks by a factor of the spectral radius each step, so it goes to zero.",
        path: "papers/iterative.pdf",
        where: "page 7",
      },
    });
    phone = await turn({ text: "what did I just ask about?", client: "phone" }, "You asked why a spectral radius below one makes the iteration converge.");
  });

  pass("a", "phone chat (pi turn)", "the you layer has the Ctrl+L question, the selection and the PDF page", () => {
    const t = need(phone, "phone turn").texts.join("\n");
    expect(t).toContain("<you>");
    expect(t).toContain("Why does this guarantee convergence?");
    expect(t).toContain("the spectral radius of T is below one");
    expect(t).toContain("papers/iterative.pdf");
  });
  // Decided (2026-10-18): the you layer is "what Carl just did" (a 45-minute window, plus his last action whatever
  // its age), so an old Ctrl+L ask is not pushed into every turn of every chat. Older activity is the agent's to
  // search when he asks about it: RecentActivity (read-only, on every surface pi runs, Ctrl+K / Ctrl+L included).
  let found = "";
  pass("a", "phone chat (pi turn)", "an ask older than the window is not pushed into the turn (no bleed of old activity)", async () => {
    act.appendActivity(vault, { kind: "ask", modality: "ctrl-l", text: 'asked "what is Gauss-Seidel splitting?"', detail: "answer: L+D and U." }, Date.now() - 50 * 60_000);
    late = await turn({ text: "what did I ask about before lunch?", client: "phone" }, "You asked what Gauss-Seidel splitting is.", async (threadId) => {
      found = (await need(backend.handlers, "tool handlers").toolCall(threadId, "RecentActivity", { query: "asked", hours: 4 })).text;
    });
    expect(need(late, "late turn").texts.join("\n")).not.toContain("Gauss-Seidel");
  });
  pass("a", "phone chat (agent's pull: RecentActivity)", "the agent finds the older ask, with its answer, when Carl asks about it", () => {
    expect(found).toContain('Ctrl+L ask: asked "what is Gauss-Seidel splitting?"');
    expect(found).toContain("answer: L+D and U.");
    expect(found).toContain("Why does this guarantee convergence?"); // the recent one too: the search spans the window
    expect(backend.threads.at(-1)!.tools).toContain("RecentActivity");
  });
});

describe("c. Writing a proof on the board, then the laptop chat: \"check what I just wrote on the iPad\"", () => {
  let slug = "";
  let entryId = "";
  let t: Turn | null = null;
  let inboxText = "";

  it("setup: an inbox entry placed on a board, ink, an overview picture; then a laptop chat turn", async () => {
    const boards = await import("../boards");
    const inbox = await import("../inbox");
    slug = String((boards.createBoard(vault, "Banach proof").body as any).slug);
    writeFileSync(join(vault, "papers", "lemma.png"), png(90, 4, 4));
    const sent = await inbox.sendEntry(vault, { title: "Contraction lemma", parts: [{ kind: "image", path: "papers/lemma.png", alt: "the lemma", label: "Lemma 1" }] });
    if (!sent.ok) throw new SetupError(`inbox send refused: ${sent.refusals.join("; ")}`);
    entryId = sent.id;
    const asset = boards.addAsset(vault, slug, { data: b64(png(90, 4, 4)) }).body as any;
    if (!asset?.src) throw new SetupError("asset refused");
    const board = {
      v: 2,
      name: "Banach proof",
      created: Date.now(),
      updated: Date.now(),
      rev: 0,
      grid: "plain",
      strokes: [
        { id: "s1", tool: "pen", color: "#000", w: 2, xy: [10, 10, 200, 40, 380, 60] },
        { id: "s2", tool: "pen", color: "#000", w: 2, xy: [10, 90, 300, 95] },
      ],
      items: [{ id: "it1", kind: "image", x: 0, y: 200, w: 300, h: 300, src: asset.src, label: "Lemma 1", inbox: { id: entryId, part: 0 } }],
    };
    const saved = await boards.saveBoard(vault, slug, { board, base: 0, overview: b64(png(30, 8, 8)) });
    if (saved.status !== 200) throw new SetupError(`board save: ${JSON.stringify(saved.body)}`);
    inbox.markAdded(vault, entryId, { part: 0, board: slug, items: ["it1"] });
    t = await turn({ text: "check what I just wrote on the iPad", client: "laptop" }, "Looking.", async (threadId) => {
      inboxText = (await need(backend.handlers, "tool handlers").toolCall(threadId, "BoardInbox", {})).text;
    });
  });

  pass("c", "laptop chat (agent's pull: BoardInbox)", "the placed inbox part shows as added to that board, still on it", () => {
    expect(inboxText).toContain("Contraction lemma");
    expect(inboxText).toContain(slug);
    expect(inboxText).toContain("still on the board");
  });
  pass("c", "laptop chat (pi turn)", "the you layer says a board was just written on (its name, path, items and the picture to read)", () => {
    const all = need(t, "turn").all;
    expect(all).toContain(`Board: "Banach proof" (boards/${slug}/)`);
    expect(all).toContain("Lemma 1 (image)");
    expect(all).toContain(`read boards/${slug}/overview.png`);
  });
  // The picture is pointed at, not pushed: the you layer names the saved overview.png, and the agent looks with
  // pi's read (an image file comes back as an image), only when the turn is about the board.
  pass("c", "laptop chat (pi turn)", "the board's overview picture is in reach: the you layer points at the overview.png the board saved, a real PNG", () => {
    const m = /read (boards\/[^\s]+\/overview\.png)/.exec(need(t, "turn").all);
    expect(m).not.toBeNull();
    const bytes = readFileSync(join(vault, ...m![1]!.split("/")));
    expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(need(t, "turn").images).toEqual([]); // not attached to every turn
  });
  pass("c", "laptop chat (pi instructions)", "the agent is told boards live at boards/<slug>/ with an overview.png it can read", () => {
    const instr = backend.threads.map((x) => x.instructions).join("\n");
    expect(instr).toContain("boards/<slug>/");
    expect(instr).toContain("BoardLook {board?} shows a board as last saved");
  });
});

describe("h. Switching conversations: what carries over, what stays per conversation", () => {
  let a1: Turn | null = null;
  let b1: Turn | null = null;
  let a2: Turn | null = null;
  it("setup: A is a project's thread (Coconut), B is Main, back to A", async () => {
    seedProject(vault, "coconut", { folder: "Coconut", memory: "# Coconut: memory\n" });
    a1 = await turn({ text: "Project Coconut: tile size?", convId: "project-coconut", client: "laptop" }, "1024 with 128 overlap.");
    act.activityPost(vault, { entry: { kind: "focus", modality: "editor", text: "opened the file", path: "papers/yolo.pdf", project: "coconut" } });
    b1 = await turn({ text: "Unrelated: what's a sigma-algebra?", client: "laptop" }, "A family of sets closed under complements and countable unions.");
    a2 = await turn({ text: "Back to tiles: is 128 enough?", convId: a1.convId, client: "laptop" }, "Yes for 40 px coconuts.");
  });
  pass("h", "chat B (pi turn)", "carries over: the open file and chat A's latest exchange (the vault-wide stream)", () => {
    const t = need(b1, "B").texts.join("\n");
    expect(t).toContain("papers/yolo.pdf");
    expect(t).toContain("tile size?");
  });
  pass("h", "Main (pi thread)", "stays per conversation: Main is its own pi thread, without the project's file or turns", () => {
    expect(need(b1, "B").convId).toBe("main");
    expect(need(a1, "A").convId).toBe("project-coconut");
    expect(need(b1, "B").threadId).not.toBe(need(a1, "A").threadId);
    expect(need(a1, "A").all).toContain(`This is the thread of Carl's project "Coconut"`);
    expect(need(a1, "A").all).toContain(`<project name="Coconut"`);
    expect(b1!.all).not.toContain(`<project name="Coconut"`);
    expect(need(a1, "A").context).toContain(`<project name="Coconut"`);
    expect(need(a1, "A").texts.join("\n")).not.toContain(`<project name="Coconut"`);
  });
  pass("h", "back in chat A (pi turn)", "only what changed since A's last turn: B's exchange, not A's own", () => {
    const t = need(a2, "A again").texts.join("\n");
    expect(t).toContain("sigma-algebra");
    expect(t).not.toContain("Project Coconut: tile size?");
  });
});

describe("i. Notes made on one surface, visible to the agent on another", () => {
  let afterLaptopNote: Turn | null = null;
  let piListed = "";
  it("setup: a note from the laptop's note popup (synced file), then chat turns", async () => {
    const { buildNote } = await import("../../src/notes");
    const note = buildNote({ anchors: [], userDraft: "Ask the TA about uniform convergence on the midterm." });
    appendFileSync(join(vault, ".vault-chat", "notes.jsonl"), JSON.stringify(note) + "\n");
    afterLaptopNote = await turn({ text: "what notes did I leave myself?", client: "phone" }, "Let me check.");
    await turn({ text: "and the newest note?", convId: afterLaptopNote.convId, client: "phone" }, "Exercise 4.2.", async (tid) => {
      piListed = (await backend.handlers!.toolCall(tid, "ListNotes", {})).text;
    });
  });
  pass("i", "phone chat (pi turn)", "a note from the laptop's popup (or the phone's notes page) is in the you layer", () => {
    expect(need(afterLaptopNote, "turn").texts.join("\n")).toContain("uniform convergence");
  });
  pass("i", "any pi turn (instructions)", "the agent is told where notes live (.vault-chat/notes.jsonl)", () => {
    expect(backend.threads.map((x) => x.instructions).join("\n")).toContain("notes.jsonl");
  });
  pass("i", "phone chat (pull: pi's ListNotes)", "pi reads a laptop note itself (one notes tool set)", () => {
    expect(piListed).toContain("uniform convergence");
  });
});

// ================================================================ stories from Carl's own history (school2, 2026-10)

// ================================================================ parity: every action × every surface (report §6)

