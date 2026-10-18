// One agent across surfaces: does the NEXT surface's agent see what Carl just
// did on the previous one? (Carl, 2026-10-18: "I'm interacting with one agent
// but on many surfaces, and I should be able to seamlessly move around, and the
// agent can see and move with me.")
//
// Each scenario is one "move around" story, run through the real code: the
// engine on a fake pi (the turn's prefix exactly as pi would get it), the box's
// voice routes (voiceTool / voiceTranscript), the shared activity stream, the
// board inbox and boards, and the board's voice client (board/src/voice.ts) on
// a fake ElevenLabs SDK. The assertion is always about what the next surface's
// agent context CONTAINS:
//   - a pi turn: the texts and images the engine hands pi (startTurn);
//   - a voice session on the box (phone, board, laptop in box mode): the
//     session prompt, built as GET /api/v1/voice/session builds it
//     (boxVoicePrompt below mirrors server/voice.ts voiceSession: the
//     builder's prompt from the thread's turns, then voiceContextBlock, then
//     VOICE_TRUTH — the ElevenLabs agent provisioning is the only part left out);
//   - a live board voice session: its contextual updates and uploads.
//
// Today's holes are written as `hole(...)`: the check runs, and the test passes
// while the check FAILS (the build stays green). When a hole is closed the
// check holds and the test fails with "the hole is closed" — move it to `it`.
// Laptop-only pieces (the viewport update mid-voice, the editor's focus
// entries) are in test/harness/crosssurface.test.ts.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
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
  threads: { threadId: string; instructions: string }[] = [];
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
    this.threads.push({ threadId, instructions: o.instructions });
    return { threadId, ref: undefined };
  }
  async resumeThread() {}
  async startTurn(threadId: string, o: any) {
    const turnId = `${threadId}-turn${this.turns.length + 1}`;
    this.turns.push({ threadId, texts: o.texts, images: o.images ?? [], turnId });
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

const voiceDeps = () => ({ vault, name: "main", main: true, message: (b: any) => engine.message(b) }) as any;

/**
 * The voice session prompt the box hands a phone / board / laptop client for
 * `convId`, built as server/voice.ts voiceSession builds it.
 */
async function boxVoicePrompt(convId: string | null): Promise<string> {
  const v = await import("../../src/voice-elevenlabs");
  const meta = await import("../../src/meta");
  const store = (await import("../../src/store")).useStore;
  const history = convId ? (((await convs.readConv(vault, convId).catch(() => null))?.messages ?? []) as any[]) : [];
  const base = v.buildSystemPrompt(
    { ...store.getState(), vaultPath: vault } as any,
    await meta.loadVaultVoicePrompt(vault),
    await meta.loadVaultNorthStar(vault),
    await v.loadVoicePromptContext(vault),
    history as any,
    true,
    await voice.fileIndex(vault),
    [],
  );
  const shared = await voice.voiceContextBlock(voiceDeps(), convId, { exchange: !voice.hasThreadHistory(base) }).catch(() => "");
  return voice.composeVoicePrompt(base, shared);
}

// ---------------------------------------------------------------- the board's voice, on a fake SDK

type BoardRig = {
  ctl: import("../../board/src/voice").VoiceController;
  prompts: string[];
  updates: string[];
  uploads: number;
  toolNames: string[];
  thread: { v: string | null };
};

async function boardVoice(thread: string | null = null): Promise<BoardRig> {
  const { VoiceController } = await import("../../board/src/voice");
  const { conversationsSummary } = await import("../phoneData");
  const v = await import("../../src/voice-elevenlabs");
  const rig: BoardRig = { ctl: null as any, prompts: [], updates: [], uploads: 0, toolNames: [...v.BUILTIN_VOICE_TOOL_NAMES], thread: { v: thread } };
  const conv = {
    endSession: async () => {},
    setMicMuted: () => {},
    sendContextualUpdate: (text: string) => rig.updates.push(text),
    uploadFile: async () => ({ fileId: `f${++rig.uploads}` }),
    sendMultimodalMessage: () => {},
  };
  rig.ctl = new VoiceController({
    api: {
      listChats: async () => (conversationsSummary(vault) as any).conversations,
      voiceSession: async (id) => ({ conversationToken: "fake-token", signedUrl: null, systemPrompt: await boxVoicePrompt(id), toolNames: rig.toolNames }),
      voiceTool: async (b) => voice.voiceTool(voiceDeps(), b),
      voiceTranscript: async (b) => (await voice.voiceTranscript(voiceDeps(), b)).body as any,
    },
    threadStore: { get: () => rig.thread.v, set: (id) => (rig.thread.v = id) },
    sdk: async () => ({
      Conversation: {
        startSession: async (o: any) => {
          rig.prompts.push(String(o.overrides?.agent?.prompt?.prompt ?? ""));
          o.onConnect();
          return conv as any;
        },
      },
    }),
    mic: async () => ({ getTracks: () => [] }) as any,
    debounceMs: 10,
  });
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
  ctx.configureContext({ vault, agentModel: "openai/gpt-6.1-sol", apiKey: () => null, verifierDeny: [] } as any);
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
  } as any);
  engine.start();
  act = await import("../activity");
  voice = await import("../voice");
  convs = await import("../engine/convs");
});

afterAll(() => {
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
    // The laptop: the open PDF page and the selection (startActivityWatch), then Ctrl+L.
    act.activityPost(vault, { entry: { kind: "focus", modality: "editor", text: "reading", path: "papers/iterative.pdf", where: "page 7 of 20" } });
    act.activityPost(vault, { entry: { kind: "focus", modality: "editor", text: 'selected "the spectral radius of T is below one"', path: "papers/iterative.pdf", where: "selection" } });
    const side = await engine.sideStart({ kind: "ask", convId: laptop.convId, text: "Why does this guarantee convergence?" });
    expect(side.ok).toBe(true);
    expect(backend.sides.at(-1).fork).toMatch(/\.jsonl$/); // a fork of the laptop chat's pi session
    // What InlineEditPrompt records once the answer is in (the box writes nothing for a side thread itself).
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

  pass("a", "phone chat (pi turn)", "the prefix has the Ctrl+L question, the selection and the PDF page", () => {
    const t = need(phone, "phone turn").texts.join("\n");
    expect(t).toContain("<recent_activity>");
    expect(t).toContain("Why does this guarantee convergence?");
    expect(t).toContain("the spectral radius of T is below one");
    expect(t).toContain("papers/iterative.pdf");
  });
  pass("a", "phone voice (box session prompt)", "the voice prompt has the Ctrl+L question and its answer's gist", () => {
    const p = need(phoneVoice, "phone voice prompt");
    expect(p).toContain("Why does this guarantee convergence?");
    expect(p).toContain("the error shrinks by a factor");
  });
  hole("a", "phone chat (pi turn)", "an ask older than the 30-minute window is still known (it is in no pi session)", async () => {
    // The same story, but the Ctrl+L was 45 minutes ago (lunch in between).
    act.appendActivity(vault, { kind: "ask", modality: "ctrl-l", text: 'asked "what is Gauss-Seidel splitting?"', detail: "answer: L+D and U." }, Date.now() - 45 * 60_000);
    late = await turn({ text: "what did I ask about before lunch?", client: "phone" }, "I don't know.");
    expect(need(late, "late turn").texts.join("\n")).toContain("Gauss-Seidel");
  });
});

describe("b. A chat on the laptop, then voice on the iPad board: \"continue that\"", () => {
  let chat: Turn | null = null;
  let fresh: BoardRig | null = null;
  let remembered: BoardRig | null = null;
  let oldVoice: string | null = null;

  it("setup: a three-turn laptop chat; one board that never talked, one that has its own voice thread", async () => {
    // The board's own thread from an earlier session (the board remembers it: board/src/voice.ts threadStore).
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
  pass("b", "board voice, remembered thread", "sees the laptop chat's latest exchange (a 200-character gist, via the stream)", () => {
    const p = need(remembered, "remembered board").prompts[0]!;
    expect(remembered!.ctl.state.chat?.id).toBe(oldVoice);
    expect(p).toContain("And uniqueness?");
  });
  hole("b", "board voice, remembered thread", "sees the laptop chat's earlier turns (\"continue that\" needs the thread, not one gist)", () => {
    const p = need(remembered, "remembered board").prompts[0]!;
    // (The chat's title, its first line, is in the gist: the middle turn is the test.)
    expect(p).toContain("completeness gives the limit");
  });
  hole("b", "board voice, live", "a laptop chat turn made while the board's voice is live reaches it (a contextual update)", async () => {
    const rig = need(fresh, "fresh board");
    await turn({ text: "Now do the contraction mapping on C[0,1].", convId: need(chat, "chat").convId, client: "laptop" }, "Use the sup norm; the integral operator has constant 1/2.");
    await new Promise((r) => setTimeout(r, 100));
    expect(rig.updates.join("\n")).toContain("contraction mapping on C[0,1]");
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
      // The agent can pull the inbox (BoardInbox) — it never pushes into the prefix.
      inboxText = (await need(backend.handlers, "tool handlers").toolCall(threadId, "BoardInbox", {})).text;
    });
  });

  pass("c", "laptop chat (agent's pull: BoardInbox)", "the placed inbox part shows as added to that board, still on it", () => {
    expect(inboxText).toContain("Contraction lemma");
    expect(inboxText).toContain(slug);
    expect(inboxText).toContain("still on the board");
  });
  hole("c", "laptop chat (pi turn)", "the turn's prefix says a board was just written on (its name / path)", () => {
    const all = need(t, "turn").all;
    expect(all).toMatch(/Banach proof|boards\//);
  });
  hole("c", "laptop chat (pi turn)", "the board's overview picture goes with the turn (\"what I just wrote\" is ink)", () => {
    expect(need(t, "turn").images.some((p) => /overview\.png$/.test(p))).toBe(true);
  });
  hole("c", "laptop chat (pi instructions)", "the agent is told boards live at boards/<slug>/ with an overview.png it can read", () => {
    expect(backend.threads.map((x) => x.instructions).join("\n")).toContain("overview.png");
  });
});

describe("d. Voice on the laptop says something and edits a file, then a typed chat: \"what did voice just change?\"", () => {
  let earlier: Turn | null = null;
  let after: Turn | null = null;
  let inVoiceConv: Turn | null = null;
  let voiceConv = "";

  it("setup: a chat that saw the stream; then a voice session (box mode) with an Edit; then typed turns", async () => {
    earlier = await turn({ text: "Keep an eye on my fixed-point notes.", client: "laptop" }, "Will do.");
    const d = voiceDeps();
    const l1 = await voice.voiceTranscript(d, { role: "user", text: "Rename lemma 2 to the contraction lemma.", fromConvId: earlier.convId });
    voiceConv = String(l1.body.convId);
    const r = await voice.voiceTool(d, { name: "Edit", args: { path: "notes/fixed-point.md", old_string: "Lemma 2.", new_string: "Contraction lemma." }, convId: voiceConv, fromConvId: earlier.convId });
    expect(r.result).not.toMatch(/^Error|^Refused/);
    await voice.voiceTranscript(d, { convId: voiceConv, role: "assistant", text: "Done, it's called the contraction lemma now." });
    await voice.voiceTranscript(d, { convId: voiceConv, role: "assistant", text: "Voice session ended.", system: true, ended: true });
    after = await turn({ text: "what did voice just change?", convId: earlier.convId, client: "laptop" }, "It renamed Lemma 2.");
    // After voice ends the laptop shows the voice conversation; a typed message goes on in it.
    inVoiceConv = await turn({ text: "and what exactly did you change?", convId: voiceConv, client: "laptop" }, "The heading of lemma 2.");
  });

  pass("d", "typed chat, another conversation (pi turn)", "the prefix has what voice heard, said and edited (file and old → new)", () => {
    const t = need(after, "after").texts.join("\n");
    expect(t).toContain("Rename lemma 2 to the contraction lemma.");
    expect(t).toContain("Voice edited notes/fixed-point.md");
    expect(t).toContain("Contraction lemma.");
  });
  pass("d", "typed chat, the voice conversation itself (pi turn)", "the new pi thread gets the voice lines and the edit", () => {
    const t = need(inVoiceConv, "voice conv turn").texts.join("\n");
    expect(t).toContain("Rename lemma 2");
    expect(t).toContain("notes/fixed-point.md");
  });
});

describe("e. An image pasted into a chat, then voice: \"what's in the image I sent?\"", () => {
  let chat: Turn | null = null;
  let prompt = "";
  let rig: BoardRig | null = null;

  it("setup: a phone chat message with an image; then voice from that chat (phone / board path)", async () => {
    chat = await turn({ text: "here is the diagram from the lecture", images: [{ mime: "image/png", dataBase64: b64(png(200, 6, 6)) }], client: "phone" }, "Got it — a commutative square.");
    prompt = await boxVoicePrompt(chat.convId);
    rig = await boardVoice(null);
    await rig.ctl.start(chat.convId);
  });

  pass("e", "pi turn", "the image itself went to pi with the message", () => {
    expect(need(chat, "chat").images.length).toBe(1);
  });
  pass("e", "box voice (session prompt)", "the voice prompt says an image was sent with that line", () => {
    expect(prompt).toContain("here is the diagram from the lecture");
    expect(prompt).toMatch(/\[sent an image\]/);
  });
  hole("e", "box voice (phone / board client)", "the image's pixels reach the voice session at its start (the laptop has pushThreadImages; the box path has none)", () => {
    const r = need(rig, "board rig");
    expect(r.ctl.state.chat?.id).toBe(chat!.convId);
    expect(r.uploads).toBeGreaterThan(0);
  });
  hole("e", "Ctrl+K / Ctrl+L, chat turns (\"this image\")", "an image pasted into a chat is a capture in the stream (only marquee captures are)", () => {
    expect(act.readActivity(vault).some((e) => e.kind === "capture")).toBe(true);
  });
});

describe("f. The phone asks for a problem set, the board inbox shows it, board voice: \"what did the agent send me?\"", () => {
  let phone: Turn | null = null;
  let toolOut = "";
  let rig: BoardRig | null = null;
  let other: BoardRig | null = null;

  it("setup: the phone chat's turn sends to the inbox (BoardSend); then board voice", async () => {
    writeFileSync(join(vault, "papers", "cauchy.png"), png(60, 4, 4));
    phone = await turn({ text: "make me a problem set on Cauchy sequences for the iPad", client: "phone" }, "Sent — check your inbox.", async (threadId) => {
      toolOut = (await need(backend.handlers, "tool handlers").toolCall(threadId, "BoardSend", {
        title: "Cauchy sequences: three problems",
        parts: [{ kind: "image", path: "papers/cauchy.png", alt: "problem 1", label: "Problem 1" }],
      })).text;
    });
    rig = await boardVoice(null);
    await rig.ctl.start();
    // A board that already had its own voice thread.
    const r = await voice.voiceTranscript(voiceDeps(), { role: "user", text: "Quick question about series." });
    other = await boardVoice(String(r.body.convId));
    await other.ctl.start();
  });

  pass("f", "engine → board (live voice)", "a landed entry is broadcast with a line for a live voice session to say", () => {
    expect(toolOut).toContain("in Carl's whiteboard inbox");
    expect(broadcasts.some((b) => b.type === "inbox" && /Cauchy sequences: three problems/.test(String(b.say)))).toBe(true);
  });
  pass("f", "board voice, first start", "continues the phone chat: it knows a problem set was asked for", () => {
    const p = need(rig, "board").prompts[0]!;
    expect(p).toContain("problem set on Cauchy sequences");
  });
  hole("f", "board voice, first start", "the prompt names what is in the inbox (the entry's title)", () => {
    expect(need(rig, "board").prompts[0]).toContain("Cauchy sequences: three problems");
  });
  hole("f", "board voice (tools)", "voice can read the inbox itself (a BoardInbox tool)", () => {
    expect(need(rig, "board").toolNames).toContain("BoardInbox");
  });
  hole("f", "board voice, remembered thread", "the inbox send is in the shared stream (a remembered thread sees only the chat's gist)", () => {
    expect(need(other, "other board").prompts[0]).toContain("Cauchy sequences: three problems");
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
  pass("g", "box voice (next session)", "a session started after the switch has the new file in its stream block", () => {
    expect(before).not.toContain("notes/measure-theory.md");
    expect(after).toContain("notes/measure-theory.md");
  });
  // The laptop's own voice gets the switch as a viewport contextual update (test/harness/crosssurface.test.ts).
  // A live phone or board session gets nothing mid-session: the same missing reader as b's live check.
});

describe("h. Switching conversations: what carries over, what stays per conversation", () => {
  let a1: Turn | null = null;
  let b1: Turn | null = null;
  let a2: Turn | null = null;
  it("setup: chat A (project), chat B, back to A", async () => {
    a1 = await turn({ text: "Project Coconut: tile size?", project: "Coconut", client: "laptop" }, "1024 with 128 overlap.");
    act.activityPost(vault, { entry: { kind: "focus", modality: "editor", text: "opened the file", path: "papers/yolo.pdf", project: "coconut" } });
    b1 = await turn({ text: "Unrelated: what's a sigma-algebra?", client: "laptop" }, "A family of sets closed under complements and countable unions.");
    a2 = await turn({ text: "Back to tiles: is 128 enough?", convId: a1.convId, client: "laptop" }, "Yes for 40 px coconuts.");
  });
  pass("h", "chat B (pi turn)", "carries over: the open file and chat A's latest exchange (the vault-wide stream)", () => {
    const t = need(b1, "B").texts.join("\n");
    expect(t).toContain("papers/yolo.pdf");
    expect(t).toContain("tile size?");
  });
  pass("h", "chat B (pi thread)", "stays per conversation: B is its own pi thread, without A's project memory or turns", () => {
    expect(need(b1, "B").threadId).not.toBe(need(a1, "A").threadId);
    expect(b1!.instructions ?? "").not.toContain("This conversation is tagged with project");
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
  it("setup: a note from the laptop's note popup (synced file), a note by voice, then chat turns", async () => {
    const { buildNote } = await import("../../src/notes");
    const note = buildNote({ anchors: [], userDraft: "Ask the TA about uniform convergence on the midterm." });
    appendFileSync(join(vault, ".vault-chat", "notes.jsonl"), JSON.stringify(note) + "\n");
    afterLaptopNote = await turn({ text: "what notes did I leave myself?", client: "phone" }, "Let me check.");
    listed = (await voice.voiceTool(voiceDeps(), { name: "ListNotes", args: {} })).result;
    await voice.voiceTool(voiceDeps(), { name: "CreateNote", args: { text: "Redo exercise 4.2 with the dominated convergence theorem." } });
    afterVoiceNote = await turn({ text: "and the newest note?", convId: afterLaptopNote.convId, client: "phone" }, "Exercise 4.2.");
  });
  pass("i", "voice (pull: ListNotes)", "voice reads a laptop note when asked", () => {
    expect(listed).toContain("uniform convergence");
  });
  pass("i", "phone chat (pi turn)", "a note voice saved is in the next turn's prefix", () => {
    expect(need(afterVoiceNote, "turn").texts.join("\n")).toContain("dominated convergence");
  });
  hole("i", "phone chat (pi turn)", "a note from the laptop's popup (or the phone's notes page) is in the prefix", () => {
    expect(need(afterLaptopNote, "turn").texts.join("\n")).toContain("uniform convergence");
  });
  hole("i", "any pi turn (instructions)", "the agent is told where notes live (.vault-chat/notes.jsonl) — it has no notes tool", () => {
    expect(backend.threads.map((x) => x.instructions).join("\n")).toContain("notes.jsonl");
  });
});

// ================================================================ stories from Carl's own history (school2, 2026-10)

describe("j. Voice is asked for a small HTML edit; it hands it to pi as a project (IEMS 469 Course Notes Visuals, 2026-10-18)", () => {
  let convId = "";
  let result = "";
  it("setup: voice's AskAgent with a project name, as the voice prompt invites", async () => {
    const before = backend.turns.length;
    result = (await voice.voiceTool(voiceDeps(), { name: "AskAgent", args: { task: "Make the section 7 figure in course-notes.html clearer.", project: "IEMS 469 Course Notes Visuals" } })).result;
    convId = String(JSON.parse(result).conversationId ?? "");
    if (!convId) throw new SetupError(`AskAgent: ${result}`);
    await until(() => backend.turns.length > before);
    backend.reply("On it.");
    await until(async () => (await convs.readConv(vault, convId))?.state !== "running");
  });
  pass("j", "voice → pi hand-off", "the task reaches pi in a conversation of its own (source voice)", async () => {
    const c = need(await convs.readConv(vault, convId), "conv");
    expect(c.source).toBe("voice");
  });
  hole("j", "voice → pi hand-off", "a project needs Carl's yes, as in chat (pi's SetProject proposes; voice's AskAgent project creates it at once)", async () => {
    const c = need(await convs.readConv(vault, convId), "conv");
    expect(c.project ?? null).toBeNull();
  });
});

describe("k. Board voice: \"look at the mark again\" (d1c77940-651, 2026-10-18)", () => {
  let out = "";
  let prompt = "";
  it("setup: LookAtScreen through the box, and the box's voice prompt", async () => {
    out = (await voice.voiceTool(voiceDeps(), { name: "LookAtScreen", args: {} })).result;
    prompt = await boxVoicePrompt(null);
  });
  hole("k", "board / phone voice", "LookAtScreen gives a fresh look (on the box it is \"not available\")", () => {
    expect(out).not.toMatch(/^Error/);
  });
  hole("k", "board / phone voice (prompt)", "the prompt does not promise a screen and an open PDF the phone and board don't have", () => {
    expect(prompt).not.toContain("Don't claim you can't see the screen");
  });
});

describe("l. Homework on the phone, then laptop voice from another chat: \"go over what I did on my phone\" (71ebf634-ff7)", () => {
  let phone: Turn | null = null;
  let p = "";
  it("setup: a three-turn phone homework chat; laptop voice started from an older laptop chat", async () => {
    const older = await turn({ text: "Quick check on lecture 4 notes.", client: "laptop" }, "Sure.");
    phone = await turn({ text: "Fill in hw4 problem 2 in the same form as the others, don't answer everything.", client: "phone" }, "Filled in the setup for problem 2; parts (b) and (c) left for you.");
    phone = await turn({ text: "Hint for 2(b)?", convId: phone.convId, client: "phone" }, "Use the epsilon-delta definition with delta = epsilon/3.");
    phone = await turn({ text: "Thanks, I'll do (c) later.", convId: phone.convId, client: "phone" }, "Good plan.");
    p = await boxVoicePrompt(older.convId);
  });
  pass("l", "laptop voice (session prompt)", "sees the phone chat's latest exchange", () => {
    expect(p).toContain("I'll do (c) later");
  });
  hole("l", "laptop voice (session prompt)", "sees the phone chat's earlier turns (the hint it gave)", () => {
    expect(p).toContain("delta = epsilon/3");
  });
});
