// One agent across surfaces: does the NEXT surface's agent see what Carl just
// did on the previous one? (Carl, 2026-10-18: "I'm interacting with one agent
// but on many surfaces, and I should be able to seamlessly move around, and the
// agent can see and move with me.")
//
// Each scenario is one "move around" story, run through the real code: the
// engine on a fake pi (the turn's prompt and the "you" layer pi's extension
// adds after it, as the model gets them: fakeSession.ts), the box's voice
// (D3: voice is the front of house of one conversation — its prompt is that
// conversation's pi session plus the you layer, its lines go into that session,
// its one tool that acts is Ask, and a live call gets the box's updates), the
// shared activity stream, the board inbox and boards, and the board's voice
// client (board/src/voice.ts) on a fake ElevenLabs SDK. The assertion is always
// about what the next surface's agent context CONTAINS:
//   - a pi turn: the texts and images the engine hands pi (startTurn), and the
//     "you" layer the extension's before_agent_start adds (a vc-you message);
//   - a voice session on the box (phone, board, laptop): the session prompt,
//     built as GET /api/v1/voice/session builds it (server/voice.ts voicePrompt —
//     the ElevenLabs agent provisioning is the only part left out);
//   - a live board voice call: its contextual updates, the user messages the
//     box's updates send ([vc:result]), its uploads.
//
// One main conversation (2026-10-21, src/threads.ts): a message that names no conversation is Main's,
// on every surface, as the engine does it; a project's thread is "project-<slug>"; a separate chat
// only with its own id (the stories that need two conversations name one). Voice with no chat open
// still makes a conversation of its own (server/voice.ts attached()): a hole below (j).
//
// Today's holes are written as `hole(...)`: the check runs, and the test passes
// while the check FAILS (the build stays green). When a hole is closed the
// check holds and the test fails with "the hole is closed" — move it to `it`.
// Laptop-only pieces (the viewport update mid-voice, the editor's focus
// entries) are in test/harness/crosssurface.test.ts.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { piOf } from "./fakePi";
import { tmp, cleanup, git } from "./helpers";
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
  turns: { threadId: string; texts: string[]; images: string[]; turnId: string }[] = [];
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
    // What the model gets this turn: the prompt, then the "you" layer pi adds after it (the extension, fakeSession.ts).
    this.turns.push({ threadId, texts: o.you ? [...o.texts, o.you] : o.texts, images: o.images ?? [], turnId });
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
let voice: typeof import("../voice");
let convs: typeof import("../engine/convs");
const broadcasts: any[] = [];

const until = async (fn: () => Promise<boolean> | boolean, ms = 10_000) => {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new SetupError("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};

type Turn = { texts: string[]; images: string[]; instructions: string | null; convId: string; threadId: string; all: string };

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
  return { texts: t.texts, images: t.images, instructions, convId: String(out.convId), threadId: t.threadId, all: [instructions ?? "", ...t.texts].join("\n") };
}

/** Voice's Asks run as pi side threads (engine.sideStart, on the fake backend): each is answered by the test. */
const sideDone = new Map<string, { promise: Promise<{ text: string; error: string | null }>; resolve: (r: { text: string; error: string | null }) => void }>();
const sideOf = (id: string) => {
  let d = sideDone.get(id);
  if (!d) {
    let resolve!: (r: { text: string; error: string | null }) => void;
    const promise = new Promise<{ text: string; error: string | null }>((res) => (resolve = res));
    sideDone.set(id, (d = { promise, resolve }));
  }
  return d;
};

type AskedSide = { kind: string; fork: string | null; tools: string[]; hostTools: string[]; text: string };

/** Voice's Ask (any device): the side request it starts (forked from the conversation), its tools run with `during`
 * (through the engine, as pi's side thread calls them), answered `reply`; then the result the call gets. */
async function ask(
  request: string,
  convId: string | null,
  reply: string,
  during?: (call: (name: string, args: Record<string, unknown>) => Promise<string>) => Promise<void>,
  device = "phone",
  act = false,
): Promise<{ side: AskedSide; result: string; convId: string }> {
  const before = backend.sides.length;
  const turns = backend.turns.length;
  const cursor = (await voice.voiceUpdates(voiceDeps(), { convId })).cursor;
  const r = await voice.voiceTool(voiceDeps(), { name: "Ask", args: { request, ...(act ? { act: true } : {}) }, convId, device });
  if (!r.convId) throw new SetupError(`Ask: ${r.result}`);
  await until(() => backend.sides.length > before);
  const o = backend.sides.at(-1)!;
  const id = `side${backend.sides.length}`;
  const call = async (name: string, args: Record<string, unknown>) => (await need(backend.handlers, "handlers").sideTool!(r.convId!, name, args)).text;
  if (during) await during(call);
  sideOf(id).resolve({ text: reply, error: null });
  await voice.voiceAsksSettled();
  if (backend.turns.length !== turns) throw new SetupError("an Ask started a turn of the conversation");
  const up = await voice.voiceUpdates(voiceDeps(), { convId: r.convId, cursor, waitMs: 2000 });
  const result = up.updates.find((u) => u.kind === "result")?.text ?? "";
  return { side: { kind: o.kind, fork: o.fork ?? null, tools: o.tools ?? [], hostTools: (o.hostTools ?? []).map((t: any) => t.name), text: o.text }, result, convId: r.convId };
}

const voiceDeps = () =>
  ({ vault, name: "main", main: true, message: (b: any) => engine.message(b), side: { start: (b: any) => engine.sideStart(b), wait: (id: string) => sideOf(id).promise } }) as any;

/** The voice session prompt the box hands a `device` client for `convId` (server/voice.ts voiceSession builds it so). */
const boxVoicePrompt = (convId: string | null, device: "laptop" | "phone" | "board" = "phone") => voice.voicePrompt(voiceDeps(), convId, device);

// ---------------------------------------------------------------- the board's voice, on a fake SDK

type BoardRig = {
  ctl: import("../../board/src/voice").VoiceController;
  prompts: string[];
  updates: string[];
  spoken: string[];
  uploads: number;
  toolNames: string[];
  tools: Record<string, (p: unknown) => Promise<string>>;
  thread: { v: string | null };
};
const rigs: BoardRig[] = [];

async function boardVoice(thread: string | null = null): Promise<BoardRig> {
  const { VoiceController } = await import("../../board/src/voice");
  const { conversationsSummary } = await import("../phoneData");
  const { voiceToolNames } = await import("../../src/voicePrompt");
  const rig: BoardRig = { ctl: null as any, prompts: [], updates: [], spoken: [], uploads: 0, toolNames: voiceToolNames("board"), tools: {}, thread: { v: thread } };
  const conv = {
    endSession: async () => {},
    setMicMuted: () => {},
    sendContextualUpdate: (text: string) => rig.updates.push(text),
    sendUserMessage: (text: string) => rig.spoken.push(text),
    uploadFile: async () => ({ fileId: `f${++rig.uploads}` }),
    sendMultimodalMessage: () => {},
  };
  rig.ctl = new VoiceController({
    api: {
      listChats: async () => (conversationsSummary(vault) as any).conversations,
      // As GET /api/v1/voice/session?device=board answers (server/voice.ts voiceSession, ElevenLabs left out).
      voiceSession: async (id) => {
        const p = await import("../../src/convlog/reduce");
        const known = id && convs.pictureOf(vault, id) ? id : null;
        void p;
        return {
          conversationToken: "fake-token",
          signedUrl: null,
          systemPrompt: await boxVoicePrompt(known, "board"),
          toolNames: rig.toolNames,
          convId: known,
          cursor: (await voice.voiceUpdates(voiceDeps(), {})).cursor,
          images: voice.threadImages(vault, known).images,
        };
      },
      voiceTool: async (b) => voice.voiceTool(voiceDeps(), b),
      voiceTranscript: async (b) => (await voice.voiceTranscript(voiceDeps(), b)).body as any,
      voiceUpdates: (convId, cursor) => voice.voiceUpdates(voiceDeps(), { convId, cursor, waitMs: 200 }),
    },
    threadStore: { get: () => rig.thread.v, set: (id) => (rig.thread.v = id) },
    sdk: async () => ({
      Conversation: {
        startSession: async (o: any) => {
          rig.prompts.push(String(o.overrides?.agent?.prompt?.prompt ?? ""));
          rig.tools = o.clientTools;
          o.onConnect();
          return conv as any;
        },
      },
    }),
    mic: async () => ({ getTracks: () => [] }) as any,
    debounceMs: 10,
  });
  rigs.push(rig);
  return rig;
}

// ---------------------------------------------------------------- holes and the report

class SetupError extends Error {}
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
  (await import("../convlog/log")).setProjectsHomeLog(join(root, "projects-home"));
  ctx.configureContext({ vault, agentModel: "openai/gpt-6.1-sol", projectsHome: join(root, "projects-home") });
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
  voice = await import("../voice");
  convs = await import("../engine/convs");
});

afterAll(async () => {
  for (const r of rigs) await r.ctl.end().catch(() => {});
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
  let phoneVoice: string | null = null;
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
    phoneVoice = await boxVoicePrompt(phone.convId);
  });

  pass("a", "phone chat (pi turn)", "the you layer has the Ctrl+L question, the selection and the PDF page", () => {
    const t = need(phone, "phone turn").texts.join("\n");
    expect(t).toContain("<you>");
    expect(t).toContain("Why does this guarantee convergence?");
    expect(t).toContain("the spectral radius of T is below one");
    expect(t).toContain("papers/iterative.pdf");
  });
  pass("a", "phone voice (box session prompt)", "the voice prompt has the Ctrl+L question and its answer's gist", () => {
    const p = need(phoneVoice, "phone voice prompt");
    expect(p).toContain("Why does this guarantee convergence?");
    expect(p).toContain("the error shrinks by a factor");
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

describe("b. A chat on the laptop, then voice on the iPad board: \"continue that\"", () => {
  let chat: Turn | null = null;
  let fresh: BoardRig | null = null;
  let remembered: BoardRig | null = null;
  let oldVoice: string | null = null;

  it("setup: a three-turn laptop chat; one board that never talked, one that remembers an older call's chat", async () => {
    const r = await voice.voiceTranscript(voiceDeps(), { role: "user", text: "Let's warm up with limits." });
    oldVoice = String(r.body.convId);
    chat = await turn({ text: "Walk me through the Banach fixed point theorem.", client: "laptop" }, "Start with a contraction T with constant q < 1 on a complete metric space.");
    chat = await turn({ text: "Why does completeness matter?", convId: chat.convId, client: "laptop" }, "The iterates form a Cauchy sequence; completeness gives the limit.");
    chat = await turn({ text: "And uniqueness?", convId: chat.convId, client: "laptop" }, "Two fixed points x, y give d(x,y) <= q d(x,y), so d = 0.");
    fresh = await boardVoice(null);
    await fresh.ctl.start();
    remembered = await boardVoice(oldVoice);
    await remembered.ctl.start();
  });

  pass("b", "board voice, first start", "continues the most recent chat with its turns in the prompt", () => {
    const rig = need(fresh, "fresh board");
    expect(rig.ctl.state.chat?.id).toBe(need(chat, "chat").convId);
    expect(rig.prompts[0]).toContain("Banach fixed point theorem");
    expect(rig.prompts[0]).toContain("completeness gives the limit");
  });
  pass("b", "board voice, an older call remembered", "follows Carl to the chat he continued since (\"continue that\" is that chat)", () => {
    const rig = need(remembered, "remembered board");
    expect(rig.ctl.state.chat?.id).toBe(need(chat, "chat").convId);
    expect(rig.prompts[0]).toContain("And uniqueness?");
  });
  pass("b", "board voice, an older call remembered", "sees the laptop chat's earlier turns (\"continue that\" needs the thread, not one gist)", () => {
    expect(need(remembered, "remembered board").prompts[0]).toContain("completeness gives the limit");
  });
  // Carl, 2026-10-21 ("I thought we were a single model"): a typed turn during a call is answered by the agent in
  // the chat, and the call speaks that answer — a [vc:result] user message, once, never a silent context update.
  pass("b", "board voice, live", "a laptop chat turn made while the board's voice is live reaches it (the agent's answer, spoken once)", async () => {
    const rig = need(fresh, "fresh board");
    const updatesBefore = rig.updates.length;
    const spokenBefore = rig.spoken.length;
    await turn({ text: "Now do the contraction mapping on C[0,1].", convId: need(chat, "chat").convId, client: "laptop" }, "Use the sup norm; the integral operator has constant 1/2.");
    const mine = () => rig.spoken.slice(spokenBefore).filter((x) => x.includes("the integral operator has constant 1/2"));
    await until(() => mine().length > 0, 5000).catch(() => undefined);
    // Let any duplicate delivery (a second poll) land before counting.
    await new Promise((r) => setTimeout(r, 300));
    expect(mine()).toHaveLength(1);
    const said = mine()[0]!;
    expect(said).toMatch(/^\[vc:result\] Carl typed in the chat: "Now do the contraction mapping on C\[0,1\]\."/);
    expect(said).toMatch(/don't answer his message yourself/);
    // Not also a context update (the call would know it twice).
    expect(rig.updates.slice(updatesBefore).join("\n")).not.toContain("the integral operator has constant 1/2");
  });
  pass("b", "board voice, live", "what Carl says on the board goes into that chat's pi session (the agent hears it on its next turn)", async () => {
    const rig = need(fresh, "fresh board");
    const conv = need(chat, "chat").convId;
    (rig.ctl as any).saveLine("user", "So completeness is what makes the limit exist?");
    await (rig.ctl as any).lines;
    const p = convs.pictureOf(vault, conv)!;
    const file = String(p.meta.threadPath);
    const said = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === "custom_message" && e.customType === "vc-voice");
    expect(said.map((e) => e.content)).toContain("[voice call] Carl said: So completeness is what makes the limit exist?");
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

describe("d. Voice on the laptop asks for a file edit, then a typed chat: \"what did voice just change?\"", () => {
  let call = "";
  let asked: { side: AskedSide; result: string } | null = null;
  let after: Turn | null = null;
  let inCall: Turn | null = null;

  it("setup: a chat open on the laptop, voice on it: Carl's words, voice's Ask, the agent's edit; then typed turns", async () => {
    call = (await turn({ text: "Keep an eye on my fixed-point notes.", client: "laptop" }, "Will do.")).convId;
    const d = voiceDeps();
    await voice.voiceTranscript(d, { convId: call, role: "user", text: "Rename lemma 2 to the contraction lemma.", device: "laptop" });
    await voice.voiceTranscript(d, { convId: call, role: "assistant", text: "On it.", device: "laptop" });
    asked = await ask("Rename lemma 2 to the contraction lemma in notes/fixed-point.md.", call, "Done: notes/fixed-point.md now says \"Contraction lemma.\"; I read it back.", async () => {
      // pi's own edit tool in the side thread.
      writeFileSync(join(vault, "notes", "fixed-point.md"), "# Fixed points\n\nContraction lemma. Every contraction on a complete metric space has a unique fixed point.\n");
    }, "laptop", true);
    await voice.voiceTranscript(d, { convId: call, role: "assistant", text: "Done — it's called the contraction lemma now.", device: "laptop" });
    await voice.voiceTranscript(d, { convId: call, role: "assistant", text: "Voice session ended.", system: true, ended: true });
    after = await turn({ text: "what did voice just change?", convId: "sep-d-after", client: "laptop" }, "It renamed Lemma 2.");
    inCall = await turn({ text: "and what exactly did you change?", convId: call, client: "laptop" }, "The heading of lemma 2.");
  });

  pass("d", "voice → pi", "the edit is a side request forked from the same conversation (its file tools, no turn, no steer), and voice relays its confirmed result", () => {
    const a = need(asked, "ask");
    expect(a.side.kind).toBe("ask");
    expect(a.side.fork).toBe(backend.threadSource(String(convs.pictureOf(vault, call)!.meta.threadId)).file);
    expect(a.side.tools).toEqual(expect.arrayContaining(["edit", "write", "bash"]));
    expect(a.side.hostTools).toEqual(expect.arrayContaining(["Show", "BoardSend", "CreateNote"]));
    expect(a.side.text).toContain("Rename lemma 2 to the contraction lemma in notes/fixed-point.md.");
    expect(a.result).toMatch(/^\[vc:result\] The agent answered \(request ask-[^)]+\): Done: notes\/fixed-point.md now says/);
    // In the thread: one collapsed row, no bubble with the request.
    const items = convs.pictureOf(vault, call)!.items;
    expect(items.filter((x) => x.kind === "tool" && x.name === "VoiceAsk").length).toBe(1);
    expect(items.some((x) => x.kind === "user" && String(x.text).includes("in notes/fixed-point.md"))).toBe(false);
  });
  pass("d", "typed chat, another conversation (pi turn)", "the you layer points at what was said by voice, and in which chat", () => {
    const t = need(after, "after").texts.join("\n");
    expect(t).toContain("Rename lemma 2 to the contraction lemma.");
    expect(t).toContain(`(in chat ${call})`);
  });
  pass("d", "typed chat, the same conversation (pi's session)", "the voice lines are in the conversation's pi session before the typed turn", () => {
    expect(need(inCall, "in-call turn").convId).toBe(call);
    const file = String(convs.pictureOf(vault, call)!.meta.threadPath);
    const es = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const said = es.filter((e) => e.type === "custom_message" && e.customType === "vc-voice").map((e) => e.content);
    expect(said).toContain("[voice call] Carl said: Rename lemma 2 to the contraction lemma.");
    expect(said).toContain("[voice call] You said to Carl (spoken by your voice): Done — it's called the contraction lemma now.");
    const lastVoice = es.map((e) => e.customType).lastIndexOf("vc-voice");
    const typedAt = es.findIndex((e) => e.type === "message" && JSON.stringify(e.message?.content ?? "").includes("and what exactly did you change?"));
    expect(lastVoice).toBeLessThan(typedAt);
  });
});

describe("e. An image pasted into a chat, then voice: \"what's in the image I sent?\"", () => {
  let chat: Turn | null = null;
  let prompt = "";
  let rig: BoardRig | null = null;

  it("setup: a phone chat message with an image; then voice on that chat (phone / board path)", async () => {
    chat = await turn({ text: "here is the diagram from the lecture", images: [{ mime: "image/png", dataBase64: b64(png(200, 6, 6)) }], client: "phone" }, "Got it — a commutative square.");
    prompt = await boxVoicePrompt(chat.convId);
    rig = await boardVoice(null);
    await rig.ctl.start(chat.convId);
    await until(() => (rig?.uploads ?? 0) > 0, 3000).catch(() => undefined);
  });

  pass("e", "pi turn", "the image itself went to pi with the message", () => {
    expect(need(chat, "chat").images.length).toBe(1);
  });
  pass("e", "box voice (session prompt)", "the voice prompt says an image was sent with that line", () => {
    expect(prompt).toContain("here is the diagram from the lecture");
    expect(prompt).toMatch(/\[sent an image\]/);
  });
  pass("e", "box voice (phone / board client)", "the image's pixels reach the voice session at its start", () => {
    const r = need(rig, "board rig");
    expect(r.ctl.state.chat?.id).toBe(chat!.convId);
    expect(r.uploads).toBeGreaterThan(0);
    // The phone's session carries the same images (server/voice.ts threadImages).
    expect(voice.threadImages(vault, chat!.convId).images.length).toBe(1);
  });
  pass("e", "Ctrl+K / Ctrl+L, chat turns (\"this image\")", "an image pasted into a chat is in the stream, by path (the other chats' you layer lists it)", () => {
    const pasted = act.readActivity(vault).find((e) => e.kind === "capture" && e.modality === "chat" && e.convId === chat!.convId);
    expect(pasted?.path).toMatch(/^\.vault-chat\/captures\//);
    expect(act.youLayer(vault, { convId: null }).text).toContain(pasted!.path!);
  });
});

describe("f. The phone asks for a problem set, the board inbox shows it, board voice: \"what did the agent send me?\"", () => {
  let phone: Turn | null = null;
  let toolOut = "";
  let rig: BoardRig | null = null;
  let other: BoardRig | null = null;
  let asked = "";

  it("setup: the phone chat's turn sends to the inbox (BoardSend); then board voice", async () => {
    writeFileSync(join(vault, "papers", "cauchy.png"), png(60, 4, 4));
    phone = await turn({ text: "make me a problem set on Cauchy sequences for the iPad", client: "phone" }, "Sent — check your inbox.", async (threadId) => {
      // The agent's call, as pi runs it: its tool row in the transcript, the host's answer.
      const args = { title: "Cauchy sequences: three problems", parts: [{ kind: "image", path: "papers/cauchy.png", alt: "problem 1", label: "Problem 1" }] };
      for (const x of piOf({ kind: "tool", itemId: "call-bs", name: "BoardSend", input: args })) backend.emit("event", { threadId, ...x });
      toolOut = (await need(backend.handlers, "tool handlers").toolCall(threadId, "BoardSend", args)).text;
      for (const x of piOf({ kind: "tool", itemId: "call-bs", name: "BoardSend", input: args, result: toolOut })) backend.emit("event", { threadId, ...x });
    });
    rig = await boardVoice(null);
    await rig.ctl.start();
    // A board call on another chat (the series question, its own conversation, more recent).
    const r = await voice.voiceTranscript(voiceDeps(), { role: "user", text: "Quick question about series." });
    other = await boardVoice(String(r.body.convId));
    await other.ctl.start(String(r.body.convId));
  });

  pass("f", "engine → board (live voice)", "a landed entry is broadcast with a line for a live voice session to say", () => {
    expect(toolOut).toContain("in Carl's whiteboard inbox");
    expect(broadcasts.some((b) => b.type === "inbox" && /Cauchy sequences: three problems/.test(String(b.say)))).toBe(true);
  });
  pass("f", "board voice, first start", "continues the phone chat: it knows a problem set was asked for", () => {
    expect(need(rig, "board").prompts[0]).toContain("problem set on Cauchy sequences");
  });
  pass("f", "board voice, first start", "the prompt names what the agent sent to the inbox (its BoardSend, in the conversation)", () => {
    expect(need(rig, "board").prompts[0]).toContain('BoardSend "Cauchy sequences: three problems"');
  });
  pass("f", "board voice (tools)", "voice reaches the inbox through Ask: the conversation's agent reads it with its BoardInbox", async () => {
    const r = need(rig, "board");
    expect(r.toolNames).toEqual(["Ask", "LookAtScreen"]);
    const before = backend.sides.length;
    const turns = backend.turns.length;
    const out = await r.tools.Ask!({ request: "what did the agent send me?" });
    expect(out).toMatch(/^The agent is looking it up as a side request/);
    await until(() => backend.sides.length > before);
    // A side request forked from the phone chat's session (its context), with the read-only tools and Show.
    const o = backend.sides.at(-1)!;
    expect(o.fork).toBe(backend.threadSource(need(phone, "phone").threadId).file);
    expect(o.hostTools.map((x: any) => x.name)).toEqual(expect.arrayContaining(["BoardInbox", "Show"]));
    asked = (await backend.handlers!.sideTool!(need(phone, "phone").convId, "BoardInbox", {})).text;
    sideOf(`side${backend.sides.length}`).resolve({ text: "Your inbox has \"Cauchy sequences: three problems\", unread.", error: null });
    expect(asked).toContain("Cauchy sequences: three problems");
    await until(() => r.spoken.join("\n").includes("Cauchy sequences: three problems"), 5000).catch(() => undefined);
    expect(r.spoken.join("\n")).toMatch(/\[vc:result\] The agent answered \(request ask-[^)]+\): Your inbox has "Cauchy sequences: three problems"/);
    expect(backend.turns.length).toBe(turns);
  });
  pass("f", "board voice on another chat", "knows a problem set just landed in the inbox (the send is in the shared \"you\" stream)", () => {
    expect(need(other, "other board").prompts[0]).toContain('Board inbox: "Cauchy sequences: three problems" landed in the board inbox (1 part)');
  });
});

describe("g. Opening a different file on the laptop mid-voice: voice knows the new focus", () => {
  let before = "";
  let after = "";
  it("setup: a box voice session, then the editor's focus entry for another file", async () => {
    before = await boxVoicePrompt(null);
    act.activityPost(vault, { entry: { kind: "focus", modality: "editor", text: "opened the file", path: "notes/measure-theory.md" } });
    after = await boxVoicePrompt(null);
  });
  pass("g", "box voice (next session)", "a session started after the switch has the new file in its you layer", () => {
    expect(before).not.toContain("notes/measure-theory.md");
    expect(after).toContain("notes/measure-theory.md");
  });
  // A live call gets the switch as a [vc:context] update (server/test/voice.test.ts "pushed"); the laptop's own
  // voice also gets a viewport contextual update (test/harness/crosssurface.test.ts).
});

describe("h. Switching conversations: what carries over, what stays per conversation", () => {
  let a1: Turn | null = null;
  let b1: Turn | null = null;
  let a2: Turn | null = null;
  it("setup: A is a project's thread (Coconut), B is Main, back to A", async () => {
    mkdirSync(join(root, "projects-home", "coconut"), { recursive: true });
    writeFileSync(join(root, "projects-home", "coconut", "project.md"), "# Coconut\n");
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
  });
  pass("h", "back in chat A (pi turn)", "only what changed since A's last turn: B's exchange, not A's own", () => {
    const t = need(a2, "A again").texts.join("\n");
    expect(t).toContain("sigma-algebra");
    expect(t).not.toContain("Project Coconut: tile size?");
  });
});

describe("i. Notes made on one surface, visible to the agent on another", () => {
  let afterLaptopNote: Turn | null = null;
  let afterVoiceNote: Turn | null = null;
  let listed = "";
  let piListed = "";
  it("setup: a note from the laptop's note popup (synced file), a note asked for by voice, then chat turns", async () => {
    const { buildNote } = await import("../../src/notes");
    const note = buildNote({ anchors: [], userDraft: "Ask the TA about uniform convergence on the midterm." });
    appendFileSync(join(vault, ".vault-chat", "notes.jsonl"), JSON.stringify(note) + "\n");
    afterLaptopNote = await turn({ text: "what notes did I leave myself?", client: "phone" }, "Let me check.");
    // Voice: "what's in my notes?" — the agent's ListNotes, relayed.
    let notes = "";
    const r = await ask("What's in my notes?", afterLaptopNote.convId, "Your open note: ask the TA about uniform convergence on the midterm.", async (call) => {
      notes = await call("ListNotes", {});
    });
    listed = `${notes}\n${r.result}`;
    // Voice: "jot down: redo 4.2" — the agent's CreateNote.
    // An action: the side request has the note tools.
    await ask("Jot down: redo exercise 4.2 with the dominated convergence theorem.", afterLaptopNote.convId, "Saved as a note.", async (call) => {
      await call("CreateNote", { text: "Redo exercise 4.2 with the dominated convergence theorem." });
    }, "phone", true);
    afterVoiceNote = await turn({ text: "and the newest note?", convId: afterLaptopNote.convId, client: "phone" }, "Exercise 4.2.", async (tid) => {
      piListed = (await backend.handlers!.toolCall(tid, "ListNotes", {})).text;
    });
  });
  pass("i", "voice (through Ask: the agent's ListNotes)", "voice reads a laptop note when asked, and says what the agent found", () => {
    expect(listed).toContain("uniform convergence");
    expect(listed).toContain("[vc:result]");
  });
  pass("i", "phone chat (pi turn)", "a note made by a voice request is in the next turn's you layer", () => {
    expect(need(afterVoiceNote, "turn").texts.join("\n")).toContain("dominated convergence");
  });
  pass("i", "phone chat (pi turn)", "a note from the laptop's popup (or the phone's notes page) is in the you layer", () => {
    expect(need(afterLaptopNote, "turn").texts.join("\n")).toContain("uniform convergence");
  });
  pass("i", "any pi turn (instructions)", "the agent is told where notes live (.vault-chat/notes.jsonl)", () => {
    expect(backend.threads.map((x) => x.instructions).join("\n")).toContain("notes.jsonl");
  });
  pass("i", "phone chat (pull: pi's ListNotes)", "pi reads a laptop note and a voice-requested note itself (one notes tool set)", () => {
    expect(piListed).toContain("uniform convergence");
    expect(piListed).toContain("dominated convergence");
  });
});

// ================================================================ stories from Carl's own history (school2, 2026-10)

describe("j. Voice is asked for a small HTML edit and hands it to pi (IEMS 469 Course Notes Visuals, 2026-10-18)", () => {
  let convId = "";
  let instructions = "";
  let texts = "";
  it("setup: a call with no chat open: Carl's words, then voice's Ask (a model that still passes a project name)", async () => {
    const before = backend.sides.length;
    const line = await voice.voiceTranscript(voiceDeps(), { role: "user", text: "Can you make the section 7 figure in course-notes.html clearer?" });
    const r = await voice.voiceTool(voiceDeps(), { name: "Ask", args: { request: "Make the section 7 figure in course-notes.html clearer.", project: "IEMS 469 Course Notes Visuals", act: true }, convId: line.body.convId });
    convId = String(r.convId ?? "");
    if (!convId) throw new SetupError(`Ask: ${r.result}`);
    // A side request of the call's conversation: no session to fork yet, so the agent's own instructions and what was said.
    await until(() => backend.sides.length > before);
    const o = backend.sides.at(-1)!;
    // Main already has a session (earlier stories): the side request forks it, with that thread's instructions.
    const forked = o.fork ? backend.threads.find((x) => backend.threadSource(x.threadId)?.file === o.fork) : null;
    instructions = forked ? forked.instructions : o.instr ? readFileSync(o.instr, "utf8") : "";
    // What it sees: its prompt, and (forked) the conversation's session it continues, where his spoken line already is.
    texts = o.text + (o.fork ? JSON.stringify(convs.pictureOf(vault, String(line.body.convId))?.items ?? []) : "");
    sideOf(`side${backend.sides.length}`).resolve({ text: "Done: the figure's labels are larger.", error: null });
    await voice.voiceAsksSettled();
  });
  pass("j", "voice → pi", "the request reaches pi (a side request of the call's conversation), with Carl's own words before it", async () => {
    expect(texts).toContain("Can you make the section 7 figure in course-notes.html clearer?");
    expect(texts).toContain("Make the section 7 figure in course-notes.html clearer.");
  });
  // Voice with no chat open continues Main (one main conversation): server/voice.ts attached(), no convId → "main".
  pass("j", "voice, no chat open", "the call's conversation is Main", async () => {
    expect(convId).toBe("main");
  });
  pass("j", "voice → pi", "no tool creates or assigns a project: the hand-off is an ordinary message, no project made", async () => {
    const c = need(await convs.readConv(vault, convId), "conv");
    expect(c.project ?? null).toBeNull();
    const p = await import("../../src/voicePrompt");
    for (const d of ["laptop", "board", "phone"] as const) expect(p.voiceToolNames(d)).not.toContain("SetProject");
    expect(Object.keys(p.voiceToolDefs("phone")[0]!.parameters.properties)).toEqual(["request", "act"]);
  });
  pass("j", "pi (instructions)", "a small edit is done in place, in the real file: no copy, no plan files, no browser checks or hashes; git is the undo", () => {
    const i = need(instructions || null, "instructions");
    expect(i).toContain("done now, directly, in the real file, in place: no copy of the file, no sandbox, no plan or progress files, no test suite, browser checks or hashes");
    expect(i).toContain("git is the undo");
    expect(i).not.toMatch(/SetProject|ProjectMemory|Done means proved/);
  });
});

describe("k. Board voice: \"look at the mark again\" (d1c77940-651, 2026-10-18)", () => {
  let look = "";
  let phoneLook = "";
  let phonePrompt = "";
  let boardPrompt = "";
  it("setup: LookAtScreen on the board (the board answers it), on the phone (the box), and the two prompts", async () => {
    const rig = await boardVoice(null);
    await rig.ctl.start();
    rig.ctl.setBoard({ slug: "banach", name: () => "Banach proof", items: () => [], strokes: () => 3, snapshot: async () => new Blob([png(40, 4, 4)], { type: "image/jpeg" }) });
    look = await rig.tools.LookAtScreen!({});
    phoneLook = (await voice.voiceTool(voiceDeps(), { name: "LookAtScreen", args: {}, device: "phone" })).result;
    phonePrompt = await boxVoicePrompt(null, "phone");
    boardPrompt = await boxVoicePrompt(null, "board");
  });
  pass("k", "board voice", "LookAtScreen gives a fresh look (answered on the board, never \"not available\")", () => {
    expect(look).not.toMatch(/^Error|not available/);
    expect(look).toMatch(/Attached a picture of the part of his board in view|looks exactly as in the picture of his board you already have/);
    expect(look).toMatch(/now answer what Carl said, out loud/);
  });
  pass("k", "phone voice", "a look on the phone says plainly there is no screen there (never a guess)", () => {
    expect(phoneLook).toMatch(/this call is on Carl's phone: nothing was looked at/);
  });
  pass("k", "board / phone voice (prompt)", "the prompt does not promise a screen and an open PDF the phone and board don't have", () => {
    expect(phonePrompt).toContain("You have NO screen here");
    expect(phonePrompt).not.toContain("Don't claim you can't see the screen");
    expect(boardPrompt).toContain("You CAN see the board");
    expect(boardPrompt).not.toContain("full PDF");
  });
});

describe("l. Homework on the phone, then laptop voice from another chat: \"go over what I did on my phone\" (71ebf634-ff7)", () => {
  let phone: Turn | null = null;
  let p = "";
  let attached = "";
  it("setup: three phone turns in Main; laptop voice on a separate laptop chat, then on Main", async () => {
    const older = await turn({ text: "Quick check on lecture 4 notes.", convId: "sep-l-older", client: "laptop" }, "Sure.");
    phone = await turn({ text: "Fill in hw4 problem 2 in the same form as the others, don't answer everything.", client: "phone" }, "Filled in the setup for problem 2; parts (b) and (c) left for you.");
    phone = await turn({ text: "Hint for 2(b)?", convId: phone.convId, client: "phone" }, "Use the epsilon-delta definition with delta = epsilon/3.");
    phone = await turn({ text: "Thanks, I'll do (c) later.", convId: phone.convId, client: "phone" }, "Good plan.");
    p = await boxVoicePrompt(older.convId, "laptop");
    attached = await boxVoicePrompt(phone.convId, "laptop");
  });
  pass("l", "laptop voice on another chat (session prompt)", "sees a pointer to the phone chat: its title, Carl's words and its id to read it", () => {
    expect(p).toContain("I'll do (c) later");
    expect(p).toContain(`(id ${need(phone, "phone").convId})`);
  });
  pass("l", "laptop voice on another chat (session prompt)", "no bleed: the phone chat's replies stay in it (the conversation model)", () => {
    expect(p).not.toContain("delta = epsilon/3");
  });
  pass("l", "laptop voice on the phone chat (\"continue\" on another device)", "has its earlier turns, the hint among them", () => {
    expect(attached).toContain("delta = epsilon/3");
    expect(attached).toContain("Fill in hw4 problem 2");
  });
});

// ================================================================ parity: every action × every surface (report §6)

describe("parity. One tool set on every surface, by construction (voice hands every action to the conversation's agent)", () => {
  let tools: string[] = [];
  const results: Record<string, { tool: string; device: string; ok: boolean }> = {};
  it("setup: a chat; the agent's tool list; an Ask from each device", async () => {
    const t = await turn({ text: "Parity check chat.", client: "laptop" }, "OK.");
    tools = backend.threads.find((x) => x.threadId === t.threadId)!.tools;
    for (const device of ["laptop", "phone", "board"] as const) {
      let out = "";
      const a = await ask(`What's on my calendar today? (${device})`, t.convId, "Psych 221 at 2pm.", async (call) => {
        out = await call("CalendarToday", {});
      }, device);
      // Forked from the conversation's own session, with Carl's vault tool among its tools.
      const ok = a.side.fork === backend.threadSource(t.threadId).file && a.side.hostTools.includes("CalendarToday") && out.includes("Psych 221 at 2pm") && a.result.includes("Psych 221");
      results[device] = { tool: a.result, device, ok };
    }
  });
  for (const device of ["laptop", "phone", "board"] as const) {
    pass("parity", `${device} voice`, "Ask runs as a side request of the conversation (its session, the agent's tools): Carl's vault tool (a calendar) works from it", () => {
      expect(results[device]?.ok).toBe(true);
      expect(results[device]?.tool).toMatch(/^\[vc:result\] The agent answered/);
    });
  }
  pass("parity", "the agent (every surface)", "notes, the board inbox, the web, PDFs, conversations, projects (read) and Carl's own tools", () => {
    for (const name of ["ListNotes", "CreateNote", "UpdateNote", "ResolveNote", "ReopenNote", "DeleteNote", "BoardSend", "BoardMake", "BoardInbox", "WebSearch", "PdfRead", "ListConversations", "ReadConversation", "ListProjects", "CalendarToday"])
      expect(tools, name).toContain(name);
    expect(tools).not.toContain("SetProject");
  });
  pass("parity", "voice (every device)", "its own tools are only Ask and the device's screen; no voice tool writes, notes or projects", async () => {
    const p = await import("../../src/voicePrompt");
    const all = new Set([...p.voiceToolNames("laptop"), ...p.voiceToolNames("phone"), ...p.voiceToolNames("board")]);
    expect([...all].sort()).toEqual(["Ask", "LookAtScreen", "ScrollTo", "ShowFile"]);
  });
});

describe("m. Board voice: \"put problem 3 on my laptop\", then \"I'm not near my laptop\" (Show, one tool on every surface)", () => {
  let onLaptop = "";
  let toInbox = "";
  let here = "";
  let entryId = "";
  const shows: any[] = [];
  let leave: () => void = () => {};
  let laptopApp: ReturnType<typeof setInterval> | null = null;
  let showHostTools: string[] = [];

  it("setup: a problem set in the vault; the laptop app on the feed (it opens what it is sent and acks); three asks from the board", async () => {
    const S = await import("../show");
    mkdirSync(join(vault, "hw"), { recursive: true });
    writeFileSync(join(vault, "hw", "ps5.md"), "# Problem set 5\n\n## Problem 1\n\nShow $a_n \to 0$.\n\n## Problem 2\n\nBound $|x_n|$.\n\n## Problem 3\n\nProve the contraction has a unique fixed point.\n");
    // The laptop app: its feed is live (/poll?client=laptop), and it acks each show signal as src/showOnLaptop.ts does.
    leave = S.feedOpened(vault, "laptop");
    let seen = broadcasts.length;
    laptopApp = setInterval(() => {
      for (const ev of broadcasts.slice(seen)) {
        if (ev.type !== "show" || ev.to !== "laptop") continue;
        shows.push(ev);
        S.ackShow(ev.id, { ok: true, landed: `opened ${String(ev.path).split("/").pop()}; scrolled to heading "${ev.target?.heading}" in ${String(ev.path).split("/").pop()}` });
      }
      seen = broadcasts.length;
    }, 10);
    // Carl's words on the board, and board voice's Ask: a side request of the conversation, its Show call as pi runs it.
    const line = await voice.voiceTranscript(voiceDeps(), { role: "user", text: "put problem 3 on my laptop", device: "board" });
    const conv = String(line.body.convId);
    await ask("Put problem 3 of hw/ps5.md on my laptop.", conv, "It's on your laptop.", async (call) => {
      onLaptop = await call("Show", { path: "hw/ps5.md", where: "laptop", heading: "Problem 3" });
    }, "board");
    showHostTools = backend.sides.at(-1)!.hostTools.map((x: any) => x.name);
    await voice.voiceTranscript(voiceDeps(), { role: "user", text: "I'm not near my laptop, send it to my iPad", convId: conv, device: "board" });
    await ask("I'm not near my laptop: send problem 3 to my iPad.", conv, "It's in your inbox.", async (call) => {
      toInbox = await call("Show", { path: "hw/ps5.md", where: "board", heading: "Problem 3" });
    }, "board");
    // "Show me" with no device named: Carl is talking on the board (his lines there are in the "you" layer).
    await voice.voiceTranscript(voiceDeps(), { role: "user", text: "show me problem 1", convId: conv, device: "board" });
    await ask("Show me problem 1.", conv, "Sent.", async (call) => {
      here = await call("Show", { path: "hw/ps5.md", heading: "Problem 1" });
    }, "board");
    entryId = /entry (\S+?)\.$/.exec(toInbox)?.[1] ?? "";
  });

  afterAll(() => {
    if (laptopApp) clearInterval(laptopApp);
    leave();
  });

  pass("m", "board voice → the agent → laptop", "\"put problem 3 on my laptop\": a show signal for the laptop, and the result is the laptop's confirmation", () => {
    expect(shows[0]).toMatchObject({ type: "show", to: "laptop", path: "hw/ps5.md", target: { heading: "Problem 3" } });
    expect(onLaptop).toBe('Shown on the laptop: opened ps5.md; scrolled to heading "Problem 3" in ps5.md.');
  });
  pass("m", "board voice → the agent → board inbox", "\"I'm not near my laptop\": problem 3 lands in the board inbox (one part, labelled)", async () => {
    expect(toInbox).toMatch(/^In Carl's board inbox: "ps5\.md, "Problem 3"" \(1 part\)/);
    const { readEntry } = await import("../inbox");
    const e = readEntry(vault, entryId)!;
    expect(e.parts).toHaveLength(1);
    expect((e.parts[0] as any).label).toBe("Problem 3");
    expect(broadcasts.some((b) => b.type === "inbox" && b.id === entryId && b.landed)).toBe(true);
  });
  pass("m", "the agent (here)", "\"show me\" with no device named goes to the device he is talking on (the board), not the laptop", () => {
    expect(here).toMatch(/^In Carl's board inbox: "ps5\.md, "Problem 1""/);
    expect(shows).toHaveLength(1);
  });
  pass("m", "the agent (every surface)", "Show is one of the agent's own tools (typed chat, laptop / board / phone voice through Ask)", () => {
    expect(backend.threads.every((t) => t.tools.includes("Show"))).toBe(true);
    // And voice's Asks, questions too: every Ask has the action tools (Show, BoardSend …), pi decides what it needs.
    expect(showHostTools).toContain("Show");
    expect(showHostTools).toContain("BoardSend");
  });
});
