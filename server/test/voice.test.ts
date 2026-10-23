// Voice on the box, in process (D3: voice is the front of house of one
// conversation, one brain): its one tool that acts (Ask) hands Carl's request
// to the conversation's agent — the engine, on a fake pi — and returns at once;
// every line said goes into that conversation's pi session (vc-voice custom
// messages, in the agent's context); the agent's answers and what Carl did
// elsewhere come back through the updates; and the session is minted with the
// box's ElevenLabs key, one agent per device with that device's tools —
// ElevenLabs faked, no request leaves the process.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup, git } from "./helpers";
import { withPiSessions } from "./fakeSession";
import { piOf } from "./fakePi";

const root = tmp("vcv-");
const vault = join(root, "vault");
mkdirSync(join(vault, ".vault-chat", "conversations"), { recursive: true });
mkdirSync(join(vault, "notes"), { recursive: true });
// A vault tool that needs one key (and must not see another).
mkdirSync(join(vault, ".vault-chat", "tools", "echo"), { recursive: true });
writeFileSync(
  join(vault, ".vault-chat", "tools", "echo", "TOOL.md"),
  "---\nname: EchoKey\ndescription: Echo the args and say which keys it sees.\nrequires_keys: [DEMO_KEY]\ninput_schema:\n  word:\n    type: string\n    description: a word\n---\n",
);
writeFileSync(join(vault, ".vault-chat", "tools", "echo", "run.sh"), 'cat\necho\necho "demo=${DEMO_KEY:-none} other=${OTHER_KEY:-none} pwd=$(basename "$PWD")"\n');
git(vault, "init", "-q");
// A second vault on the box.
const vault2 = join(root, "vault2");
mkdirSync(join(vault2, ".vault-chat", "conversations"), { recursive: true });
mkdirSync(join(vault2, "lab"), { recursive: true });
writeFileSync(join(vault2, "lab", "plan.md"), "# Plan\nsecond vault\n");
git(vault2, "init", "-q");
writeFileSync(join(vault, "notes", "a.md"), "# A\nthe quick fox\n");
process.env.VC_VAULT = vault;
process.env.VC_STATE_DIR = join(root, "state");
process.env.VC_LOCALSTORAGE = join(root, "ls.json");
process.env.VC_PUSH_SUBS = join(root, "subs.json");
process.env.VC_TOKEN_FILE = join(root, "token");
process.env.VC_SECRETS_DIR = join(root, "secrets");

class FakeBackend extends EventEmitter {
  readonly name = "pi";
  h: any = null;
  threads: { threadId: string; tools: any[] }[] = [];
  turns: { threadId: string; texts: string[]; turnId: string }[] = [];
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
    const threadId = `t${this.threads.length + 1}`;
    this.threads.push({ threadId, tools: o.tools });
    return { threadId, ref: undefined };
  }
  async resumeThread() {}
  async startTurn(threadId: string, o: any) {
    const turnId = `${threadId}-turn${this.turns.length + 1}`;
    this.turns.push({ threadId, texts: o.texts, turnId });
    return { turnId };
  }
  steers = 0;
  async steer() {
    this.steers++;
  }
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
  /** The model answers the newest turn. */
  reply(text: string) {
    const t = this.turns[this.turns.length - 1]!;
    for (const x of piOf({ kind: "text", text })) this.emit("event", { threadId: t.threadId, ...x });
    this.emit("event", { threadId: t.threadId, kind: "turnCompleted", turnId: t.turnId, status: "completed", error: null });
  }
}

let engine: any;
let backend: FakeBackend;
let store: any;
let voice: typeof import("../voice");
let convs: typeof import("../engine/convs");
let writes = 0;
let deps: import("../voice").VoiceDeps;
let deps2: import("../voice").VoiceDeps;

/** pi side threads, faked (the engine's sideStart forks the conversation; here each is answered by the test). */
type FakeSideRun = { id: string; kind: string; convId: string; text: string; tools?: string; answer: (text: string, error?: string | null) => void; done: Promise<{ text: string; error: string | null }> };
const sides: FakeSideRun[] = [];
const fakeSide = {
  async start(b: { kind: string; convId: string; text: string; tools?: "act" }) {
    let answer!: FakeSideRun["answer"];
    const done = new Promise<{ text: string; error: string | null }>((res) => (answer = (text, error = null) => res({ text, error })));
    const run: FakeSideRun = { id: `side-${sides.length + 1}`, ...b, answer, done };
    sides.push(run);
    return { id: run.id };
  },
  wait: (id: string) => sides.find((x) => x.id === id)!.done,
};
const lastSide = () => sides[sides.length - 1]!;

const until = async (fn: () => Promise<boolean> | boolean, ms = 10_000) => {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};
const idle = (id: string) => until(async () => (await convs.readConv(vault, id))?.state !== "running");

/** A typed chat turn (the laptop's composer): what pi got, then the reply. */
async function typed(text: string, reply: string, convId?: string): Promise<string> {
  const n = backend.turns.length;
  // No convId: a chat of its own (a separate chat; a message naming none would be Main's).
  const out = await engine.message({ text, convId: convId ?? `sep-${Math.random().toString(36).slice(2, 10)}`, client: "laptop" });
  await until(() => backend.turns.length > n);
  backend.reply(reply);
  await idle(String(out.convId));
  return String(out.convId);
}

/** The vc-voice custom messages in a conversation's pi session (what the agent reads), in order. */
function voiceEntries(id: string): any[] {
  const p = convs.pictureOf(vault, id)!;
  const file = String(p.meta.threadPath ?? convs.logOf(vault).ownSession(id));
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === "custom_message" && e.customType === "vc-voice");
}

beforeAll(async () => {
  await import("../shims/globals");
  const { registerAll } = await import("../commands/registry");
  registerAll((await import("../commands/fs")).fsCommands);
  registerAll((await import("../commands/conversations")).conversationCommands);
  const keys = await import("../keys");
  registerAll(keys.keychainCommands);
  // The keys the laptop synced (fake values): a vault tool gets them as environment variables.
  await keys.saveKeys(join(root, "secrets"), { "user.DEMO_KEY": "demo-canary", "user.OTHER_KEY": "other-canary" });
  store = (await import("../../src/store")).useStore;
  store.setState({ vaultPath: vault, conversationsLoaded: true });
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
    notify: async () => null,
    log: () => {},
    shell: () => null,
  });
  engine.start();
  voice = await import("../voice");
  convs = await import("../engine/convs");
  deps = { vault, name: "main", main: true, message: (b) => engine.message(b), side: fakeSide, onWrite: () => writes++ };
  deps2 = { vault: vault2, name: "lab", main: false, onWrite: () => writes++ };
});

afterAll(() => {
  engine?.stop();
  cleanup(root);
});

describe("voice's one tool that acts: Ask, a request to the conversation's agent", () => {
  it("runs Carl's words as a background side request forked from the conversation: no turn, no steer, no bubble; returns at once", async () => {
    const chat = await typed("Let's work on the fixed-point notes.", "Sure.");
    const n = backend.turns.length;
    const t0 = Date.now();
    const r = await voice.voiceTool(deps, { name: "Ask", args: { request: "What does lemma 2 say?" }, convId: chat, device: "laptop" });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.convId).toBe(chat);
    expect(r.result).toMatch(/^The agent is looking it up as a side request \(request ask-[a-z0-9-]+\)/);
    // It never says it is done: the answer comes as [vc:result].
    expect(r.result).toContain("[vc:result]");
    expect(r.result).toMatch(/don't say it is done/);
    // A side thread of this conversation, told it came by voice; not a turn of it. A question has the action tools too
    // (Carl, 2026-10-21: a read-only Ask told him four times it could not make an image): pi decides what it needs.
    const side = lastSide();
    expect(side).toMatchObject({ kind: "voice-ask", convId: chat, tools: "act" });
    expect(side.text).toMatch(/with the agent's tools .*If he asked for something to be made, changed or sent, do it now/);
    expect(side.text).toContain(voice.ASK_CONTEXT);
    expect(side.text).toContain("What does lemma 2 say?");
    await new Promise((res) => setTimeout(res, 100));
    expect(backend.turns.length).toBe(n);
    // No bubble: the request is not a message in the thread.
    const items = () => convs.pictureOf(vault, chat)!.items;
    expect(items().some((x) => x.kind === "user" && String(x.text).includes("What does lemma 2 say?"))).toBe(false);
    side.answer("Lemma 2: a contraction on a complete metric space has exactly one fixed point.");
    await voice.voiceAsksSettled();
    // One collapsed row: what voice asked and what came back.
    const rows = items().filter((x) => x.kind === "tool" && x.name === "VoiceAsk");
    expect(rows.length).toBe(1);
    expect(rows[0]!.args).toMatchObject({ request: "What does lemma 2 say?" });
    expect(typeof rows[0]!.args.ms).toBe("number");
    expect(rows[0]!.result).toBe("Lemma 2: a contraction on a complete metric space has exactly one fixed point.");
    const { messagesOf } = await import("../../src/convlog/view");
    const msgs = messagesOf(convs.pictureOf(vault, chat)!);
    expect(msgs.filter((m) => m.voiceAsk).map((m) => ({ ...m.voiceAsk, ms: undefined }))).toEqual([{ request: "What does lemma 2 say?", result: "Lemma 2: a contraction on a complete metric space has exactly one fixed point.", failed: false, ms: undefined }]);
    expect(msgs.some((m) => m.role === "user" && m.content.includes("lemma 2 say"))).toBe(false);
    expect(msgs.some((m) => m.toolCalls?.some((t) => t.name === "VoiceAsk"))).toBe(false);
  });

  it("one context, each surface its own exchange: a phone call never reads out a reply typed on the laptop; a laptop call does", async () => {
    const chat = await typed("What's on the board?", "Three problems from lecture 7.");
    const cur = { at: 0, you: Date.now() };
    const phone = voice.voiceUpdatesSince(deps, chat, cur, { you: false, device: "phone" });
    expect(phone.updates.some((u) => u.speak)).toBe(false);
    const laptop = voice.voiceUpdatesSince(deps, chat, cur, { you: false, device: "laptop" });
    expect(laptop.updates.some((u) => u.speak && u.text.includes("Three problems from lecture 7."))).toBe(true);
  });

  it("an answer that lands after the call ended is the agent's line in the conversation, never lost (10-22: 3 of 6 calls ended while he waited)", async () => {
    const chat = await typed("Lecture 7.", "Ready.");
    const sid = voice.startVoiceSessionForTests(vault, "phone", chat);
    await voice.voiceTool(deps, { name: "Ask", args: { request: "Summarise lecture 7 in two lines.", act: true }, convId: chat, device: "phone", sessionId: sid });
    // He hangs up before it is done.
    await voice.voiceTranscript(deps, { convId: chat, role: "assistant", text: "Voice session ended.", system: true, ended: true, sessionId: sid });
    lastSide().answer("Lecture 7: completeness, and the approximation property of the supremum.");
    await voice.voiceAsksSettled();
    const items = convs.pictureOf(vault, chat)!.items;
    expect(items.some((x) => x.kind === "assistant" && String(x.text).includes("approximation property of the supremum"))).toBe(true);
    voice.resetVoiceSessionsForTests();
  });

  it("an Ask shows at once as working (its row, its start), says one named line for real work, and a status question gets its status — never a second job (Carl, 10-22)", async () => {
    const chat = await typed("Checkpoint time.", "Ready.");
    const items = () => convs.pictureOf(vault, chat)!.items.filter((x) => x.kind === "tool" && x.name === "VoiceAsk");
    const r = await voice.voiceTool(deps, { name: "Ask", args: { request: "Make a board checkpoint and a sectioned PDF.", act: true }, convId: chat, device: "laptop" });
    // Real work: one short line naming it, now; a lookup gets none.
    expect(r.result).toMatch(/Now say ONE short plain line naming the work/);
    await new Promise((res) => setTimeout(res, 100));
    // The row is there while it works, with when it started.
    expect(items()).toHaveLength(1);
    expect(items()[0]!.status).toBe("pending");
    const { messagesOf } = await import("../../src/convlog/view");
    const ask = messagesOf(convs.pictureOf(vault, chat)!).find((m) => m.voiceAsk)!.voiceAsk!;
    expect(ask).toMatchObject({ running: true, act: true, request: "Make a board checkpoint and a sectioned PDF." });
    expect(typeof ask.startedAt).toBe("number");
    // "Are you working on that?": the running request's status, nothing new started.
    const before = sides.length;
    const s = await voice.voiceTool(deps, { name: "Ask", args: { request: "Are you working on that?" }, convId: chat, device: "laptop" });
    expect(s.result).toMatch(/^Still working on it: "Make a board checkpoint and a sectioned PDF\.", started \d+ seconds ago, nothing back yet/);
    expect(sides.length).toBe(before);
    expect(voice.isStatusQuestion("is it done yet?")).toBe(true);
    expect(voice.isStatusQuestion("what's the derivative of x squared?")).toBe(false);
    // The answer lands in the same row (one row, in place).
    lastSide().answer("Checkpoint saved and the PDF is in your inbox.");
    await voice.voiceAsksSettled();
    expect(items()).toHaveLength(1);
    expect(items()[0]!.status).toBe("done");
    expect(items()[0]!.result).toBe("Checkpoint saved and the PDF is in your inbox.");
  });

  it("the voice is told every Ask has the full tools (it never refuses before asking); act only orders a change after the running work", async () => {
    const { voiceToolDefs } = await import("../../src/voicePrompt");
    const ask = voiceToolDefs("laptop").find((t) => t.name === "Ask")!;
    expect(ask.description).toMatch(/Every Ask has all those tools — it can make files and images, render, and send to his inbox — so never tell Carl something can't be done before you Ask/);
    expect(ask.parameters.properties.act!.description).toMatch(/waits for the agent's own running work .* Every Ask has the full tools either way/);
  });

  it("an Ask during a running turn: no steer, the running turn and its queue untouched; an action waits for the turn to end", async () => {
    const chat = await typed("Build lecture three's notes.", "Starting.");
    const n = backend.turns.length;
    await engine.message({ text: "Add lecture three and render the HTML.", convId: chat, client: "laptop" });
    await until(() => backend.turns.length > n);
    const running = () => !!convs.pictureOf(vault, chat)!.meta.running;
    expect(running()).toBe(true);
    const pending = JSON.stringify(convs.pictureOf(vault, chat)!.meta.pending ?? []);
    const steers = backend.steers;
    const turns = backend.turns.length;
    const sidesBefore = sides.length;
    // A question: answered beside the running turn, at once.
    const q = await voice.voiceTool(deps, { name: "Ask", args: { request: "What's J of theta in my policy-gradient notes?" }, convId: chat, device: "laptop" });
    expect(q.result).toMatch(/looking it up as a side request/);
    expect(sides.length).toBe(sidesBefore + 1);
    // An action: queued until the turn ends (it would edit the same files), never steered in.
    const a = await voice.voiceTool(deps, { name: "Ask", args: { request: "Add a line to the TODO note: check lecture 3's figures.", act: true }, convId: chat, device: "laptop" });
    expect(a.result).toMatch(/once its current work in this conversation finishes/);
    await new Promise((res) => setTimeout(res, 300));
    expect(sides.length).toBe(sidesBefore + 1);
    expect(backend.steers).toBe(steers);
    expect(backend.turns.length).toBe(turns);
    expect(JSON.stringify(convs.pictureOf(vault, chat)!.meta.pending ?? [])).toBe(pending);
    expect(running()).toBe(true);
    sides[sidesBefore]!.answer("J of theta is the expected return of the policy with parameters theta.");
    // The turn ends: now the action runs, forked after it, with the file tools.
    backend.reply("Lecture three is added and rendered.");
    await idle(chat);
    await until(() => sides.length > sidesBefore + 1, 5000);
    expect(lastSide()).toMatchObject({ kind: "voice-act", convId: chat, tools: "act" });
    expect(lastSide().text).toContain(voice.ACT_CONTEXT);
    lastSide().answer("Added the line to notes/TODO.md and read it back.");
    await voice.voiceAsksSettled();
    expect(backend.steers).toBe(steers);
    const rows = convs.pictureOf(vault, chat)!.items.filter((x) => x.kind === "tool" && x.name === "VoiceAsk");
    expect(rows.map((x) => (x.args as any).act ?? false)).toEqual([false, true]);
    expect(convs.pictureOf(vault, chat)!.items.some((x) => x.kind === "user" && /J of theta|TODO note/.test(String(x.text)))).toBe(false);
  });

  it("the filler and the Ask's acknowledgement are spoken, never written; the voice's real replies are", async () => {
    const chat = await typed("Policy gradients.", "Ready.");
    for (const line of ["One sec.", "One sec—I'm checking the objective in your notes.", "Okay, let me check that.", "On it."]) {
      const r = await voice.voiceTranscript(deps, { convId: chat, role: "assistant", text: line, device: "laptop" });
      expect(r.body.filler, line).toBe(true);
    }
    await voice.voiceTool(deps, { name: "Ask", args: { request: "Which lecture defines the baseline?" }, convId: chat, device: "laptop" });
    // Its acknowledgement, whatever the words.
    expect((await voice.voiceTranscript(deps, { convId: chat, role: "assistant", text: "Sure, the agent's looking that up for you.", device: "laptop" })).body.filler).toBe(true);
    lastSide().answer("Lecture 7 defines the baseline.");
    await voice.voiceAsksSettled();
    await voice.voiceTranscript(deps, { convId: chat, role: "assistant", text: "Lecture seven defines the baseline.", device: "laptop" });
    expect(voiceEntries(chat).map((e) => e.content)).toEqual(["[voice call] You said to Carl (spoken by your voice): Lecture seven defines the baseline."]);
  });

  it("a silent Ask (v32-quiet: no holding line), then Carl speaks: the voice's short reply to him is written, not taken for an acknowledgement", async () => {
    const chat = await typed("Policy gradients.", "Ready.");
    const r = await voice.voiceTool(deps, { name: "Ask", args: { request: "Which lecture defines the baseline?" }, convId: chat, device: "laptop" });
    expect(r.result).toMatch(/Say nothing now \(no "on it", no holding line\)/);
    await voice.voiceTranscript(deps, { convId: chat, role: "user", text: "And what's a baseline again?", device: "laptop" });
    expect((await voice.voiceTranscript(deps, { convId: chat, role: "assistant", text: "A value subtracted from the return to cut variance.", device: "laptop" })).body.filler).toBeUndefined();
    expect(voiceEntries(chat).map((e) => e.content)).toContain("[voice call] You said to Carl (spoken by your voice): A value subtracted from the return to cut variance.");
    lastSide().answer("Lecture 7.");
    await voice.voiceAsksSettled();
  });

  it("no voice-local tools remain: files, notes, shell, projects, the web and the old hand-off are the agent's", async () => {
    const before = readFileSync(join(vault, "notes", "a.md"), "utf8");
    const notes = existsSync(join(vault, ".vault-chat", "notes.jsonl"));
    for (const [name, args] of [
      ["Read", { path: "notes/a.md" }],
      ["Write", { path: "notes/a.md", contents: "x" }],
      ["Edit", { path: "notes/a.md", old_string: "quick", new_string: "slow" }],
      ["Bash", { command: "echo hi > notes/b.md" }],
      ["CreateNote", { text: "x" }],
      ["ListNotes", {}],
      ["UpdateNote", { id: "x", text: "y" }],
      ["ListProjects", {}],
      ["WebSearch", { query: "x" }],
      ["WebFetch", { url: "https://example.org" }],
      ["PdfExtract", { path: "x.pdf" }],
      ["Glob", { pattern: "**/*.md" }],
      ["ListConversations", {}],
      ["ReadConversation", { conversation_id: "x" }],
      ["AskAgent", { task: "x" }],
      ["AgentStatus", { conversationId: "x" }],
      ["BoardSend", { title: "x", parts: [] }],
      ["EchoKey", { word: "x" }],
      ["SetProject", { name: "Whiteboard" }],
    ] as const) {
      const r = (await voice.voiceTool(deps, { name, args })).result;
      expect(r, name).toMatch(/^Error: ".+" is not one of your tools\. Hand it to the agent with Ask — it has every tool\. Nothing was done\.$/);
    }
    expect(readFileSync(join(vault, "notes", "a.md"), "utf8")).toBe(before);
    expect(existsSync(join(vault, "notes", "b.md"))).toBe(false);
    expect(existsSync(join(vault, ".vault-chat", "notes.jsonl"))).toBe(notes);
    expect(existsSync(join(vault, "agent-projects", "whiteboard"))).toBe(false);
    // And the client side has no definitions of them either: the device's tools, exactly.
    const p = await import("../../src/voicePrompt");
    expect(p.voiceToolNames("laptop")).toEqual(["Ask", "LookAtScreen", "ShowFile", "ScrollTo"]);
    expect(p.voiceToolNames("board")).toEqual(["Ask", "LookAtScreen"]);
    expect(p.voiceToolNames("phone")).toEqual(["Ask"]);
    const v: any = await import("../../src/voice-elevenlabs");
    expect(v.CLIENT_TOOL_DEFINITIONS).toBeUndefined();
    expect(v.BUILTIN_VOICE_TOOL_NAMES).toBeUndefined();
    const src = readFileSync(join(__dirname, "..", "voice.ts"), "utf8");
    for (const gone of ["fsCommands.write_text_file", "edit_text_file", "noteTool(", "runShell", "webSearch(", "agentStatus("]) expect(src, gone).not.toContain(gone);
  });

  it("a screen tool that reached the box says what didn't happen, honestly per device", async () => {
    expect((await voice.voiceTool(deps, { name: "LookAtScreen", args: {}, device: "phone" })).result).toMatch(/^Error: LookAtScreen needs a screen, and this call is on Carl's phone: nothing was looked at or moved/);
    expect((await voice.voiceTool(deps, { name: "ScrollTo", args: { page: 3 }, device: "laptop" })).result).toMatch(/runs on Carl's laptop itself, and it did not answer: nothing was looked at or moved/);
  });

  it("without an engine Ask says nothing was handed over; a side request that fails is said as such", async () => {
    expect((await voice.voiceTool({ vault }, { name: "Ask", args: { request: "x" } })).result).toMatch(/not running on the box, so nothing was handed over/);
    expect((await voice.voiceTool(deps, { name: "Ask", args: {} })).result).toMatch(/^Error: Ask needs the request/);
    const chat = await typed("A chat for a failing ask.", "OK.");
    const start = await voice.voiceUpdates(deps, { convId: chat });
    const starting = { vault, side: { start: async () => ({ error: "the agent engine is still starting — try again in a minute" }), wait: fakeSide.wait } };
    expect((await voice.voiceTool(starting, { name: "Ask", args: { request: "x" }, convId: chat })).result).toMatch(/side request/);
    await voice.voiceAsksSettled();
    const got = await voice.voiceUpdates(deps, { convId: chat, cursor: start.cursor, waitMs: 1000 });
    expect(got.updates.find((u) => u.kind === "result")?.text).toMatch(/could not do it .*still starting.*Tell Carl it didn't happen/);
    // The same failure again, and again: one red row in the thread, not a stack; voice hears each.
    for (const r of ["y", "z"]) await voice.voiceTool(starting, { name: "Ask", args: { request: r }, convId: chat });
    await voice.voiceAsksSettled();
    const rows = convs.pictureOf(vault, chat)!.items.filter((x) => x.kind === "tool" && x.name === "VoiceAsk");
    expect(rows.map((x) => x.result)).toEqual(["Error: the agent engine is still starting — try again in a minute"]);
    const again = await voice.voiceUpdates(deps, { convId: chat, cursor: got.cursor, waitMs: 1000 });
    expect(again.updates.filter((u) => u.kind === "result")).toHaveLength(2);
  });

  it("an Ask never drops on a timeout: it returns while the side request still works, and its answer reaches the call once", async () => {
    const chat = await typed("Open the measure theory notes.", "Open.");
    const start = await voice.voiceUpdates(deps, { convId: chat });
    const r = await voice.voiceTool(deps, { name: "Ask", args: { request: "Summarise section 4 in plain words." }, convId: chat, device: "phone" });
    expect(r.result).toMatch(/side request/);
    // Still working (longer than ElevenLabs' 15 s cascade or 30 s tool timeout would allow): nothing yet.
    const none = await voice.voiceUpdates(deps, { convId: chat, cursor: start.cursor, waitMs: 300 });
    expect(none.updates.filter((u) => u.kind === "result")).toEqual([]);
    lastSide().answer("Section 4 says every measurable function is a limit of simple functions.");
    await voice.voiceAsksSettled();
    const got = await voice.voiceUpdates(deps, { convId: chat, cursor: none.cursor, waitMs: 2000 });
    const res = got.updates.find((u) => u.kind === "result")!;
    expect(res.speak).toBe(true);
    expect(res.text).toMatch(/^\[vc:result\] The agent answered \(request ask-[a-z0-9-]+\): Section 4 says every measurable function/);
    // Said briefly, and not at all once Carl said he has it or moved on ("Slowpoke, I found it already").
    expect(res.text).toContain(voice.TELL_RESULT);
    expect(voice.TELL_RESULT).toMatch(/if he has since said he has it, found it, moved on or no longer needs it, say nothing \(skip your turn\) or one word at most: never the result/);
    // Once: the cursor moved past it.
    const again = await voice.voiceUpdates(deps, { convId: chat, cursor: got.cursor, waitMs: 200 });
    expect(again.updates.filter((u) => u.kind === "result")).toEqual([]);
    // And while a turn of the conversation runs, a result still reaches the call (it is not that turn's).
    const n = backend.turns.length;
    await engine.message({ text: "Now render the notes.", convId: chat, client: "laptop" });
    await until(() => backend.turns.length > n);
    const cur = (await voice.voiceUpdates(deps, { convId: chat })).cursor;
    await voice.voiceTool(deps, { name: "Ask", args: { request: "How many sections are there?" }, convId: chat, device: "phone" });
    lastSide().answer("Six sections.");
    await voice.voiceAsksSettled();
    const mid = await voice.voiceUpdates(deps, { convId: chat, cursor: cur, waitMs: 1000 });
    expect(mid.updates.filter((u) => u.kind === "result").map((u) => u.text)).toEqual([expect.stringContaining("Six sections.")]);
    backend.reply("Rendered.");
    await idle(chat);
  });

  it("an answer with LaTeX reaches the call as words (server/speakMath.ts); the row keeps the LaTeX", async () => {
    const chat = await typed("Real analysis homework.", "Ready.");
    const start = await voice.voiceUpdates(deps, { convId: chat });
    await voice.voiceTool(deps, { name: "Ask", args: { request: "What does Cauchy mean, and what's the series?" }, convId: chat, device: "laptop" });
    const latex = String.raw`Cauchy: for every $\epsilon > 0$ there is $N$ with $|x_m - x_n| < \epsilon$ for $m, n > N$. The series is $$\sum_{k=1}^n \frac{(-1)^k}{k}$$ and the field is $\frac{1}{4\pi\epsilon_0}\frac{q}{r^2}$, a drop of 5 mV.`;
    lastSide().answer(latex);
    await voice.voiceAsksSettled();
    const got = await voice.voiceUpdates(deps, { convId: chat, cursor: start.cursor, waitMs: 2000 });
    const res = got.updates.find((u) => u.kind === "result")!;
    // Into the session: words, never LaTeX or its symbols.
    expect(res.text).toContain("the absolute value of x sub m minus x sub n is less than epsilon");
    expect(res.text).toContain("the sum from k equals 1 to n of the fraction with numerator open paren negative 1 close paren to the k-th power and denominator k");
    expect(res.text).toContain("1 over 4 pi epsilon sub 0 the fraction with numerator q and denominator r squared");
    expect(res.text).toContain("a drop of 5 millivolts");
    expect(res.text).not.toMatch(/[$\\^_{}]|\bfrac\b/);
    // The row (what the chat renders) keeps the LaTeX as the agent wrote it.
    const row = convs.pictureOf(vault, chat)!.items.find((x) => x.kind === "tool" && x.name === "VoiceAsk")!;
    expect(row.result).toBe(latex);
  });
});

describe("Carl's own vault tools are the agent's (one tool set on every surface)", () => {
  it("a new thread has them, and they run in the sandbox runner with the args on stdin and the keys as environment variables", async () => {
    const chat = await typed("Echo something with my tool.", "OK.");
    const thread = backend.threads.at(-1)!;
    expect(thread.tools.map((t: any) => t.name)).toContain("EchoKey");
    const r = await backend.h.toolCall(thread.threadId, "EchoKey", { word: "hello" });
    expect(r.ok).toBe(true);
    expect(r.text).toContain('"word":"hello"');
    expect(r.text).toContain("demo=demo-canary");
    expect(r.text).toContain("other=other-canary");
    expect(r.text).toContain("pwd=echo");
    expect(chat).toBeTruthy();
  });
});

describe("POST /api/v1/voice/transcript: every line goes into the attached conversation's pi session", () => {
  it("into the chat voice is attached to (never a conversation of its own), as vc-voice messages the agent reads, in order", async () => {
    const chat = await typed("Walk me through the Banach fixed point theorem.", "Start with a contraction.");
    const a = await voice.voiceTranscript(deps, { convId: chat, role: "user", text: "And why does completeness matter?", device: "board" });
    expect(a.body.convId).toBe(chat);
    await voice.voiceTranscript(deps, { convId: chat, role: "assistant", text: "[excited] The iterates are Cauchy; completeness gives the limit. [skip_turn]" });
    await voice.voiceTranscript(deps, { convId: chat, role: "assistant", text: "LookAtScreen", system: true, tool: { name: "LookAtScreen", args: {}, result: "the board, 2 items" } });
    // What vault-chat itself sent into the call is never Carl's line.
    const ctl = await voice.voiceTranscript(deps, { convId: chat, role: "user", text: "[vc:result] The agent answered: done." });
    expect(ctl.body.skipped).toBe(true);
    // The pi session holds the spoken lines as custom messages (in the agent's context), tags gone.
    const es = voiceEntries(chat);
    expect(es.map((e) => e.content)).toEqual(["[voice call] Carl said: And why does completeness matter?", "[voice call] You said to Carl (spoken by your voice): The iterates are Cauchy; completeness gives the limit."]);
    expect(es[0].details).toMatchObject({ kind: "line", role: "user", via: "voice", device: "board" });
    // The chat shows one thread: typed and spoken, in order, the tool row too.
    const msgs = (await convs.readConv(vault, chat))!.messages as any[];
    expect(msgs.map((m) => (m.toolCalls ? `tools:${m.toolCalls.map((t: any) => t.name).join(",")}` : `${m.role}:${m.content}`))).toEqual([
      "user:Walk me through the Banach fixed point theorem.",
      "assistant:Start with a contraction.",
      "user:And why does completeness matter?",
      "assistant:The iterates are Cauchy; completeness gives the limit.",
      "tools:LookAtScreen",
    ]);
    expect(JSON.stringify(msgs)).not.toContain("skip_turn");
    expect(JSON.stringify(msgs)).not.toContain("[vc:");
    // The chat stays a chat (its source is not changed to "voice").
    expect((await convs.readConv(vault, chat))?.source).not.toBe("voice");
  });

  it("with no chat open the call is Main's (never a new chat per call); a new chat the laptop named is made under that id", async () => {
    const a = await voice.voiceTranscript(deps, { convId: "local-new-chat-1", role: "user", text: "What does the writeup say?" });
    expect(a.body.convId).toBe("local-new-chat-1");
    const b = await voice.voiceTranscript(deps, { role: "user", text: "a call with nothing open" });
    expect(b.body.convId).toBe("main");
    const c = await convs.readConv(vault, "main");
    expect(c?.messages.some((m: any) => m.content === "a call with nothing open")).toBe(true);
    // The end of a call where nothing was said makes no conversation.
    expect((await voice.voiceTranscript(deps, { role: "assistant", text: "Voice session ended.", system: true, ended: true })).body.convId).toBeNull();
    expect((await voice.voiceTranscript(deps, { role: "user", text: "  " })).status).toBe(400);
  });

  it("an image Carl sent while voice was on is saved with his line", async () => {
    const pngB64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString("base64");
    const a = await voice.voiceTranscript(deps, { convId: "local-img-1", role: "user", text: "this one", images: [{ mime: "image/png", dataBase64: pngB64 }, { mime: "text/html", dataBase64: "PGgxPg==" }] });
    const m = (await convs.readConv(vault, String(a.body.convId)))?.messages[0] as any;
    expect(m.content).toBe("this one");
    expect(m.attachments).toHaveLength(1);
    expect(readFileSync(join(vault, m.attachments[0].capturedFilePath)).toString("base64")).toBe(pngB64);
  });

  it("per vault: a vault's lines land in its own conversations, never the other's", async () => {
    const line = await voice.voiceTranscript(deps2, { role: "user", text: "plan for the lab?" });
    expect(line.body.convId).toBe("main");
    expect((await convs.readConv(vault2, "main"))?.messages.length).toBeGreaterThan(0);
    // Each vault has its own Main: this line is in vault2's, never in vault's.
    expect(((await convs.readConv(vault, "main"))?.messages ?? []).some((m: any) => m.content === "plan for the lab?")).toBe(false);
  });

  it("a conversation with no pi thread yet: an Ask's side request gets its voice lines, and so does the agent's first turn", async () => {
    const id = "voice-first-1";
    await voice.voiceTranscript(deps, { convId: id, role: "user", text: "Remind me what a sigma-algebra is." });
    await voice.voiceTranscript(deps, { convId: id, role: "assistant", text: "Closed under complements and countable unions." });
    // No session to fork yet: the side request is told what was said.
    await voice.voiceTool(deps, { name: "Ask", args: { request: "Which lecture defines it?" }, convId: id });
    expect(lastSide().text).toContain("Remind me what a sigma-algebra is.");
    expect(lastSide().text).toContain("Closed under complements and countable unions.");
    lastSide().answer("Lecture 2.");
    await voice.voiceAsksSettled();
    const n = backend.turns.length;
    await engine.message({ text: "Write that definition into notes/measure.md.", convId: id, client: "laptop" });
    await until(() => backend.turns.length > n);
    const t = backend.turns.at(-1)!.texts.join("\n");
    expect(t).toContain("Remind me what a sigma-algebra is.");
    expect(t).toContain("Closed under complements and countable unions.");
    expect(t).toContain("Write that definition into notes/measure.md.");
    backend.reply("Written.");
    await idle(id);
  });
});

describe("GET /api/v1/voice/updates: the live call hears what happened, and only one brain answers", () => {
  it("a voice turn starts no agent turn: the voice answers it, alone", async () => {
    const chat = await typed("Quick check on lecture 4.", "Sure.");
    const n = backend.turns.length;
    await voice.voiceTranscript(deps, { convId: chat, role: "user", text: "what's lemma 3 again?" });
    await new Promise((r) => setTimeout(r, 200));
    expect(backend.turns.length).toBe(n);
  });

  // Carl, 2026-10-21: "I thought we were a single model": a typed turn during a call is answered by the agent in
  // the chat AND spoken by the call — the agent's answer, in full; the voice never answers the typed message itself.
  it("a typed turn while voice is live: one agent reply in the thread, spoken by the call once, in full", async () => {
    const chat = await typed("Start of the homework chat.", "Ready.");
    const cur = (await voice.voiceUpdates(deps, { convId: chat })).cursor;
    const n = backend.turns.length;
    await typed("Is 2(b) the epsilon-delta one?", "Yes: take delta = epsilon/3.", chat);
    expect(backend.turns.length).toBe(n + 1);
    const got = await voice.voiceUpdates(deps, { convId: chat, cursor: cur, waitMs: 2000 });
    const spoken = got.updates.filter((x) => x.speak);
    expect(spoken).toHaveLength(1);
    expect(spoken[0]!.kind).toBe("result");
    expect(spoken[0]!.text).toMatch(/^\[vc:result\] Carl typed in the chat: "Is 2\(b\) the epsilon-delta one\?"/);
    expect(spoken[0]!.text).toContain("Yes: take delta = epsilon/3.");
    expect(spoken[0]!.text).toMatch(/don't answer his message yourself/);
    expect(got.updates.some((x) => x.kind === "context" && /typed/.test(x.text))).toBe(false);
    // Delivered once: the next poll from its cursor has nothing more.
    const again = await voice.voiceUpdates(deps, { convId: chat, cursor: got.cursor, waitMs: 50 });
    expect(again.updates.filter((x) => x.speak)).toHaveLength(0);
  });

  it("a long typed reply is spoken in full; its code blocks and tables are skipped", async () => {
    const chat = await typed("Start.", "Ready.");
    const cur = (await voice.voiceUpdates(deps, { convId: chat })).cursor;
    const long = [
      "First, the sequence is Cauchy because the tail terms shrink geometrically.",
      "Second, completeness of the reals gives the limit.",
      "```python\nprint('never read aloud')\n```",
      "| n | a_n |\n|---|-----|\n| 1 | 0.5 |",
      "Third, the limit is unique. Fourth, it equals one half. Fifth, that closes part (b).",
    ].join("\n\n");
    await typed("Explain 3(a) fully.", long, chat);
    const got = await voice.voiceUpdates(deps, { convId: chat, cursor: cur, waitMs: 2000 });
    const u = got.updates.find((x) => x.speak)!;
    expect(u.text).toContain("First, the sequence is Cauchy");
    expect(u.text).toContain("Fifth, that closes part (b).");
    expect(u.text).not.toContain("never read aloud");
    expect(u.text).not.toContain("a_n");
  });

  it("the agent's question reaches the call to be asked aloud; Carl's spoken answer goes back as its answer", async () => {
    const chat = await typed("Clean up my notes folder.", "Looking.");
    const cur = (await voice.voiceUpdates(deps, { convId: chat })).cursor;
    const n = backend.turns.length;
    await engine.message({ text: "And delete the old drafts.", convId: chat, client: "laptop" });
    await until(() => backend.turns.length > n);
    const thread = backend.turns.at(-1)!.threadId;
    const answer = backend.h.toolCall(thread, "AskUser", { question: "Delete all 12 drafts, or only the ones older than a month?", options: ["all 12", "older than a month"] });
    const got = await voice.voiceUpdates(deps, { convId: chat, cursor: cur, waitMs: 3000 });
    const q = got.updates.find((u) => u.kind === "question")!;
    expect(q.speak).toBe(true);
    expect(q.text).toContain("Delete all 12 drafts, or only the ones older than a month?");
    const r = await voice.voiceTool(deps, { name: "Ask", args: { request: "Only the ones older than a month." }, convId: chat });
    expect(r.result).toMatch(/went to the agent as Carl's answer to its question/);
    expect((await answer).text).toBe("Carl answered: Only the ones older than a month.");
    backend.reply("Deleted 5 drafts older than a month.");
    await idle(chat);
  });

  it("what Carl did on another surface reaches a live call as context (the you layer, pushed)", async () => {
    const chat = await typed("A chat for the push test.", "OK.");
    const cur = (await voice.voiceUpdates(deps, { convId: chat })).cursor;
    const { activityPost } = await import("../activity");
    activityPost(vault, { entry: { kind: "focus", modality: "editor", text: "opened the file", path: "notes/measure-theory.md", device: "laptop" } });
    const got = await voice.voiceUpdates(deps, { convId: chat, cursor: cur, waitMs: 4000 });
    const u = got.updates.find((x) => x.kind === "you")!;
    expect(u.speak).toBe(false);
    expect(u.text).toMatch(/^\[vc:context\] What Carl just did on his other surfaces/);
    expect(u.text).toContain("notes/measure-theory.md");
  });
});

describe("GET /api/v1/voice/session (ElevenLabs faked)", () => {
  // Each start here is a fresh call (no other device's call live: that hand-off is tested on its own, below).
  beforeEach(() => voice.resetVoiceSessionsForTests());
  const fake = (calls: { url: string; method: string; body: any; key: string | null }[], agent = "agent_fake") => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(typeof input === "string" ? input : input.url);
      if (!url.startsWith("https://api.elevenlabs.io/")) return real(input, init);
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : null, key: init?.headers?.["xi-api-key"] ?? null });
      if (url.includes("/convai/agents/create")) return new Response(JSON.stringify({ agent_id: `${agent}_${calls.length}` }), { status: 200 });
      if (url.includes("/get_signed_url")) return new Response(JSON.stringify({ signed_url: `wss://fake.elevenlabs/${url.split("agent_id=")[1]}` }), { status: 200 });
      if (url.includes("/conversation/token")) return new Response(JSON.stringify({ token: "fake-webrtc" }), { status: 200 });
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    return () => (globalThis.fetch = real);
  };

  it("is 503 without the box's ElevenLabs key", async () => {
    store.setState({ serviceKeys: {} });
    expect((await voice.voiceSession(null, deps)).status).toBe(503);
  });

  it("one agent per device with exactly that device's tools (Ask, the screen tools there are, skip_turn); never the key", async () => {
    const calls: any[] = [];
    const restore = fake(calls);
    try {
      store.setState({ serviceKeys: { elevenlabs: "el-canary-key" } });
      const want = { laptop: ["Ask", "LookAtScreen", "ShowFile", "ScrollTo", "skip_turn"], board: ["Ask", "LookAtScreen", "skip_turn"], phone: ["Ask", "skip_turn"] } as const;
      for (const device of ["laptop", "board", "phone"] as const) {
        const n = calls.length;
        const out = await voice.voiceSession(null, deps, { device });
        expect(out.status).toBe(200);
        expect(out.body.device).toBe(device);
        expect(out.body.toolNames).toEqual(want[device].filter((x) => x !== "skip_turn"));
        const create = calls.slice(n).find((c) => c.url.includes("/agents/create"))!;
        expect(create.key).toBe("el-canary-key");
        expect(create.body.conversation_config.agent.prompt.tools.map((t: any) => t.name)).toEqual(want[device]);
        expect(JSON.stringify(out.body)).not.toContain("el-canary-key");
        expect(voice.activeVoiceSessions()).toBeGreaterThan(0);
        expect(typeof out.body.cursor).toBe("string");
      }
      // A second session per device reuses its agent.
      const n = calls.length;
      expect((await voice.voiceSession(null, deps, { device: "board" })).status).toBe(200);
      expect(calls.slice(n).some((c) => c.url.includes("/agents/create"))).toBe(false);
      // Another vault: its own agents.
      const m = calls.length;
      expect((await voice.voiceSession(null, deps2, { device: "board" })).status).toBe(200);
      expect(calls.slice(m).filter((c) => c.url.includes("/agents/create")).length).toBe(1);
    } finally {
      restore();
    }
  });

  it("the prompt is honest per device: the phone has no screen; the laptop gets the file index; no device is promised the old tools", async () => {
    const calls: any[] = [];
    const restore = fake(calls);
    try {
      store.setState({ serviceKeys: { elevenlabs: "el-canary-key" } });
      const phone = String((await voice.voiceSession(null, deps, { device: "phone" })).body.systemPrompt);
      expect(phone).toContain("This call is on Carl's phone. You have NO screen here");
      expect(phone).not.toContain("LookAtScreen");
      expect(phone).not.toContain("You can see the full PDF");
      expect(phone).not.toContain("Don't claim you can't see the screen");
      const board = String((await voice.voiceSession(null, deps, { device: "board" })).body.systemPrompt);
      expect(board).toContain("This call is on Carl's iPad whiteboard. You CAN see the board");
      expect(board).not.toContain("ShowFile");
      const laptop = await voice.voiceSession(null, deps, { device: "laptop" });
      expect(String(laptop.body.systemPrompt)).toContain("notes/a.md");
      expect(String(laptop.body.systemPrompt)).toContain("{{viewport_context}}");
      expect(laptop.body.vaultRoot).toBe(vault);
      for (const p of [phone, board, String(laptop.body.systemPrompt)]) {
        for (const old of ["AskAgent", "AgentStatus", "CreateNote", "Write creates", "Bash runs", "PdfExtract", "Tavily"]) expect(p, old).not.toContain(old);
        // Arithmetic and actions go to the agent; voice says only what it confirmed.
        expect(p).toContain("Never do arithmetic in your head: Ask");
        expect(p).toContain("ONLY when a [vc:result] says the agent did it");
      }
    } finally {
      restore();
    }
  });

  it("the prompt is the attached conversation (its compaction summary, typed and spoken lines) and nothing of another's", async () => {
    const calls: any[] = [];
    const restore = fake(calls);
    try {
      store.setState({ serviceKeys: { elevenlabs: "el-canary-key" } });
      const other = await typed("Secret plan for the other chat: tile size 1024.", "Noted: 1024 with 128 overlap.");
      const chat = await typed("Put the six essay questions on my board, please.", "Sent them to your board inbox: six questions.");
      convs.appendNotes(vault, chat, [{ kind: "divider", text: "Carl is preparing Psych 221; the essay questions are on the board." }]);
      await voice.voiceTranscript(deps, { convId: chat, role: "user", text: "Which one is hardest?" });
      await voice.voiceTranscript(deps, { convId: chat, role: "assistant", text: "Question four, on memory consolidation." });
      const p = String((await voice.voiceSession(chat, deps, { device: "phone" })).body.systemPrompt);
      expect(p).toContain("Carl is preparing Psych 221");
      expect(p).toContain("Carl (voice): Which one is hardest?");
      expect(p).toContain("You (voice): Question four, on memory consolidation.");
      // Content from before the summary is left to the summary; the other chat's content never bleeds in
      // (it is pointed at by title and Carl's words only: the you layer).
      expect(p).not.toContain("Noted: 1024 with 128 overlap.");
      expect(p).not.toContain("Start with a contraction.");
      expect(other).toBeTruthy();
    } finally {
      restore();
    }
  });

  it("an image that arrived empty is said, never sent or guessed at; a real one goes with a phone or board call's start", async () => {
    const calls: any[] = [];
    const restore = fake(calls);
    try {
      store.setState({ serviceKeys: { elevenlabs: "el-canary-key" } });
      const pngB64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]).toString("base64");
      const n0 = backend.turns.length;
      const real = await engine.message({ text: "the diagram", images: [{ mime: "image/png", dataBase64: pngB64 }], client: "phone" });
      await until(() => backend.turns.length > n0);
      backend.reply("A commutative square.");
      await idle(String(real.convId));
      const out = await voice.voiceSession(String(real.convId), deps, { device: "board" });
      expect((out.body.images as any[]).map((i) => i.dataBase64)).toEqual([pngB64]);
      expect(String(out.body.systemPrompt)).toContain("Carl: the diagram [sent an image]");
      // Empty: the agent is told it has not seen it; voice's prompt says so; nothing is sent.
      const n = backend.turns.length;
      const empty = await engine.message({ text: "what's in this one?", images: [{ mime: "image/png", dataBase64: "" }], client: "phone" });
      await until(() => backend.turns.length > n);
      expect(backend.turns.at(-1)!.texts.join("\n")).toContain("arrived empty (no data): you have NOT seen it");
      backend.reply("It arrived empty: I can't see it.");
      await idle(String(empty.convId));
      // A big photo (kept by path only), whose capture is empty on disk by the time voice starts.
      const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(500_000, 7)]).toString("base64");
      const id = await voice.voiceTranscript(deps, { convId: "img-empty-1", role: "user", text: "look at this", images: [{ mime: "image/png", dataBase64: big }] });
      const path = convs.pictureOf(vault, String(id.body.convId))!.items.find((x) => x.kind === "user")!.images![0]!.path;
      writeFileSync(join(vault, path), "");
      const blk = voice.conversationBlock(vault, String(id.body.convId));
      expect(blk).toContain("arrived empty: you have NOT seen it");
      expect(voice.threadImages(vault, String(id.body.convId)).empty).toBe(1);
    } finally {
      restore();
    }
  });

  it("a non-default voice is the session's and the agent's (a voice change PATCHes the agent; a refusal says so)", async () => {
    const calls: { url: string; method: string; body: any }[] = [];
    let refuse = false;
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(typeof input === "string" ? input : input.url);
      if (!url.startsWith("https://api.elevenlabs.io/")) return real(input, init);
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : null });
      if (url.includes("/convai/agents/create")) return new Response(JSON.stringify({ agent_id: "agent_voice" }), { status: 200 });
      if (method === "PATCH" && url.endsWith("/convai/agents/agent_voice"))
        return refuse ? new Response(JSON.stringify({ detail: "voice is not available for eleven_flash_v2" }), { status: 422 }) : new Response("{}", { status: 200 });
      if (url.includes("/get_signed_url")) return new Response(JSON.stringify({ signed_url: "wss://fake.elevenlabs/v" }), { status: 200 });
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    try {
      store.setState({ serviceKeys: { elevenlabs: "el-canary-key" } });
      localStorage.removeItem("vault_chat_elevenlabs_agent_id:main:laptop");
      const a = await voice.voiceSession(null, deps, { voice: "LibVoiceJuniper0001", device: "laptop" });
      expect(a.status).toBe(200);
      expect(a.body.voiceId).toBe("LibVoiceJuniper0001");
      const create = calls.find((c) => c.url.includes("/agents/create"))!;
      expect(create.body.conversation_config.tts.voice_id).toBe("LibVoiceJuniper0001");
      expect(create.body.platform_settings.overrides.conversation_config_override.tts.voice_id).toBe(true);
      const n = calls.length;
      const b = await voice.voiceSession(null, deps, { voice: "LibVoiceRowan000002", device: "laptop" });
      expect(b.body.voiceId).toBe("LibVoiceRowan000002");
      expect(calls.slice(n).some((c) => c.url.includes("/agents/create"))).toBe(false);
      expect(calls.slice(n).find((c) => c.method === "PATCH")!.body).toEqual({ conversation_config: { tts: { voice_id: "LibVoiceRowan000002" } } });
      refuse = true;
      const r = await voice.voiceSession(null, deps, { voice: "LibVoiceV3only00003", device: "laptop" });
      expect(r.status).toBe(503);
      expect(String(r.body.error)).toContain("LibVoiceV3only00003");
      refuse = false;
      expect((await voice.voiceSession(null, deps, { voice: "nPczCjzI2devNBz1zQrb", device: "laptop" })).body.voiceId).toBe("nPczCjzI2devNBz1zQrb");
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe("a live voice session keeps the box busy (the updater waits on busy.runs)", () => {
  it("from the session, a tool or a line until the end line, or VOICE_IDLE_MS of silence", async () => {
    voice.voiceActivity(vault, true);
    voice.voiceActivity(vault2, true);
    expect(voice.activeVoiceSessions()).toBe(0);
    await voice.voiceTool(deps, { name: "LookAtScreen", args: {}, device: "phone" });
    expect(voice.activeVoiceSessions()).toBe(1);
    const a = await voice.voiceTranscript(deps2, { role: "user", text: "lab question" });
    expect(voice.activeVoiceSessions()).toBe(2);
    expect(voice.activeVoiceSessions(Date.now() + voice.VOICE_IDLE_MS + 1)).toBe(0);
    await voice.voiceTranscript(deps2, { convId: a.body.convId, role: "user", text: "lab question again" });
    await voice.voiceTranscript(deps2, { convId: a.body.convId, role: "assistant", text: "Voice session ended.", system: true });
    expect(voice.activeVoiceSessions()).toBe(1);
    await voice.voiceTranscript(deps, { convId: a.body.convId, role: "assistant", text: "Voice session ended is what the button says." });
    expect(voice.activeVoiceSessions()).toBe(1);
    await voice.voiceTranscript(deps, { role: "assistant", text: "x", ended: true });
    expect(voice.activeVoiceSessions()).toBe(0);
  });
});

// Carl: "can I technically have 2 voices in the same conversation thread? That sounds like an inconsistency."
describe("one voice at a time: starting voice on another device hands off (ElevenLabs faked)", () => {
  const fakeEl = () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(typeof input === "string" ? input : input.url);
      if (!url.startsWith("https://api.elevenlabs.io/")) return real(input, init);
      if (url.includes("/convai/agents/create")) return new Response(JSON.stringify({ agent_id: "agent_handoff" }), { status: 200 });
      if (url.includes("/get_signed_url")) return new Response(JSON.stringify({ signed_url: "wss://fake.elevenlabs/x" }), { status: 200 });
      if (url.includes("/conversation/token")) return new Response(JSON.stringify({ token: "fake-webrtc" }), { status: 200 });
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    return () => (globalThis.fetch = real);
  };

  it("the second device's start ends the first: one thread, its lines in order, and only the live call hears or speaks", async () => {
    const restore = fakeEl();
    try {
      voice.resetVoiceSessionsForTests();
      store.setState({ serviceKeys: { elevenlabs: "el-canary-key" } });
      const chat = await typed("Let's go over problem 3 of the set.", "Sure: problem 3, the separable ODE.");
      const lap = await voice.voiceSession(chat, deps, { device: "laptop" });
      expect(lap.status).toBe(200);
      const sid1 = String(lap.body.sessionId);
      expect(sid1).toMatch(/^vs-/);
      expect(lap.body.handoff).toBeUndefined();
      await voice.voiceTranscript(deps, { convId: chat, role: "user", text: "What's the first step?", device: "laptop", sessionId: sid1 });
      await voice.voiceTranscript(deps, { convId: chat, role: "assistant", text: "Separate the variables.", device: "laptop", sessionId: sid1 });
      // The laptop's call is waiting on its updates when Carl starts voice on the iPad (another chat picked there).
      const t0 = Date.now();
      const laptopPoll = voice.voiceUpdates(deps, { convId: chat, cursor: String(lap.body.cursor), waitMs: 15_000, session: sid1 });
      const other = await typed("A different chat on the iPad.", "Okay.");
      const pad = await voice.voiceSession(other, deps, { device: "board" });
      expect(pad.status).toBe(200);
      const sid2 = String(pad.body.sessionId);
      expect(sid2).not.toBe(sid1);
      // It continues the live conversation, with its full context.
      expect(pad.body.convId).toBe(chat);
      expect(pad.body.handoff).toEqual({ from: "laptop", convId: chat });
      expect(String(pad.body.systemPrompt)).toContain("Separate the variables.");
      expect(String(pad.body.systemPrompt)).toContain("What's the first step?");
      // The laptop is told at once, and ends its call.
      const moved = await laptopPoll;
      expect(moved.moved).toEqual({ to: "board", line: "Voice moved to iPad" });
      expect(moved.updates).toEqual([]);
      expect(Date.now() - t0).toBeLessThan(5_000);
      // Whatever the old call still sends is refused: no second voice in the thread.
      const late = await voice.voiceTranscript(deps, { convId: chat, role: "assistant", text: "A late line from the laptop.", device: "laptop", sessionId: sid1 });
      expect(late.status).toBe(409);
      expect(late.body.moved).toEqual({ to: "board", line: "Voice moved to iPad" });
      const n = backend.turns.length;
      const tool = await voice.voiceTool(deps, { name: "Ask", args: { request: "do it from the laptop" }, convId: chat, device: "laptop", sessionId: sid1 });
      expect(tool.result).toMatch(/voice moved to Carl's iPad; this call is over and nothing was done/);
      expect(backend.turns.length).toBe(n);
      // Its end line does not end the live call's hold on the box.
      await voice.voiceTranscript(deps, { convId: chat, role: "assistant", text: "Voice session ended.", system: true, ended: true, device: "laptop", sessionId: sid1 });
      expect(voice.liveVoiceSession()?.id).toBe(sid2);
      expect(voice.activeVoiceSessions()).toBeGreaterThan(0);
      // The iPad's lines go on in the same thread, after the laptop's, in order.
      await voice.voiceTranscript(deps, { convId: chat, role: "user", text: "And the second step?", device: "board", sessionId: sid2 });
      expect(voiceEntries(chat).map((e) => e.content)).toEqual([
        "[voice call] Carl said: What's the first step?",
        "[voice call] You said to Carl (spoken by your voice): Separate the variables.",
        "[voice call] Carl said: And the second step?",
      ]);
      // The thread says where voice went (a note, shown in the chat).
      const msgs = JSON.stringify((await convs.readConv(vault, chat))!.messages);
      expect(msgs).toContain("Voice moved from the laptop to the iPad.");
      expect(msgs).not.toContain("A late line from the laptop.");
      // No double speaking: the agent's answer to an iPad request reaches only the iPad's call.
      const cur2 = String(pad.body.cursor);
      const ask = await voice.voiceTool(deps, { name: "Ask", args: { request: "check step two" }, convId: chat, device: "board", sessionId: sid2 });
      expect(ask.result).toMatch(/\[vc:result\]/);
      lastSide().answer("Step two: integrate both sides.");
      await voice.voiceAsksSettled();
      const padGot = await voice.voiceUpdates(deps, { convId: chat, cursor: cur2, waitMs: 3000, session: sid2 });
      expect(padGot.updates.filter((u) => u.speak).map((u) => u.kind)).toEqual(["result"]);
      const lapGot = await voice.voiceUpdates(deps, { convId: chat, cursor: String(lap.body.cursor), waitMs: 3000, session: sid1 });
      expect(lapGot.updates).toEqual([]);
      expect(lapGot.moved?.to).toBe("board");
      // And back to the laptop: the iPad is told in turn.
      const back = await voice.voiceSession(null, deps, { device: "laptop" });
      expect(back.body.convId).toBe(chat);
      expect(back.body.handoff).toEqual({ from: "board", convId: chat });
      expect((await voice.voiceUpdates(deps, { convId: chat, cursor: cur2, session: sid2 })).moved).toEqual({ to: "laptop", line: "Voice moved to laptop" });
    } finally {
      restore();
      voice.resetVoiceSessionsForTests();
    }
  });

  it("the same device starting again (a reconnect, a switched chat) keeps the chat it asked for; a client without a session id is never refused", async () => {
    const restore = fakeEl();
    try {
      voice.resetVoiceSessionsForTests();
      store.setState({ serviceKeys: { elevenlabs: "el-canary-key" } });
      const a = await typed("Chat A.", "A.");
      const b = await typed("Chat B.", "B.");
      const one = await voice.voiceSession(a, deps, { device: "board" });
      const two = await voice.voiceSession(b, deps, { device: "board" });
      expect(two.body.convId).toBe(b);
      expect(two.body.handoff).toBeUndefined();
      expect((await voice.voiceUpdates(deps, { convId: a, cursor: String(one.body.cursor), session: String(one.body.sessionId) })).moved?.to).toBe("board");
      // An older client (no session id): its lines land as before.
      const old = await voice.voiceTranscript(deps, { convId: b, role: "user", text: "from an older phone build", device: "phone" });
      expect(old.status).toBe(200);
    } finally {
      restore();
      voice.resetVoiceSessionsForTests();
    }
  });
});
