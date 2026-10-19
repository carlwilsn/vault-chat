// Voice on the box, in process (D3: voice is the front of house of one
// conversation, one brain): its one tool that acts (Ask) hands Carl's request
// to the conversation's agent — the engine, on a fake pi — and returns at once;
// every line said goes into that conversation's pi session (vc-voice custom
// messages, in the agent's context); the agent's answers and what Carl did
// elsewhere come back through the updates; and the session is minted with the
// box's ElevenLabs key, one agent per device with that device's tools —
// ElevenLabs faked, no request leaves the process.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
mkdirSync(join(vault, "private"), { recursive: true });
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
writeFileSync(join(vault, "private", "s.md"), "secret quick\n");
writeFileSync(join(vault, ".vaultchatdeny"), "private\n");
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
  const out = await engine.message({ text, convId, client: "laptop" });
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
  deps = { vault, name: "main", main: true, message: (b) => engine.message(b), onWrite: () => writes++ };
  deps2 = { vault: vault2, name: "lab", main: false, onWrite: () => writes++ };
});

afterAll(() => {
  engine?.stop();
  cleanup(root);
});

describe("voice's one tool that acts: Ask, a request to the conversation's agent", () => {
  it("hands Carl's words to the agent as a turn in the attached conversation, and returns at once with a request id", async () => {
    const chat = await typed("Let's work on the fixed-point notes.", "Sure.");
    const n = backend.turns.length;
    const t0 = Date.now();
    const r = await voice.voiceTool(deps, { name: "Ask", args: { request: "Rename lemma 2 to the contraction lemma." }, convId: chat, device: "laptop" });
    const ms = Date.now() - t0;
    expect(r.convId).toBe(chat);
    expect(r.result).toMatch(/^The agent has it \(request ask-[a-z0-9-]+\)/);
    // It never says it is done: the answer comes as [vc:result].
    expect(r.result).toContain("[vc:result]");
    expect(r.result).toMatch(/don't say it is done/);
    expect(ms).toBeLessThan(1000);
    await until(() => backend.turns.length > n);
    const turn = backend.turns.at(-1)!;
    // The same conversation's thread: one brain, Carl's own words, told it came by voice.
    expect(turn.threadId).toBe(backend.turns[n - 1]!.threadId);
    expect(turn.texts.join("\n")).toContain("Rename lemma 2 to the contraction lemma.");
    expect(turn.texts.join("\n")).toContain(voice.ASK_CONTEXT);
    // The chat shows it as a request handed over by voice.
    const items = convs.pictureOf(vault, chat)!.items;
    expect(items.find((x) => x.kind === "user" && x.text === "Rename lemma 2 to the contraction lemma.")?.via).toBe("voice-ask");
    backend.reply("Done: lemma 2 is now called the contraction lemma (notes/fixed-point.md, line 3).");
    await idle(chat);
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

  it("without an engine (or while it starts) Ask says nothing was handed over", async () => {
    expect((await voice.voiceTool({ vault }, { name: "Ask", args: { request: "x" } })).result).toMatch(/not running on the box, so nothing was handed over/);
    const starting = await voice.voiceTool({ vault, message: async () => { throw new Error("the agent engine is still starting — try again in a minute"); } }, { name: "Ask", args: { request: "x" } });
    expect(starting.result).toMatch(/still starting.*Nothing was done/);
    expect((await voice.voiceTool(deps, { name: "Ask", args: {} })).result).toMatch(/^Error: Ask needs the request/);
  });

  it("an action never drops on a timeout: Ask returns while the agent still works, and its answer arrives later", async () => {
    const chat = await typed("Open the measure theory notes.", "Open.");
    const start = await voice.voiceUpdates(deps, { convId: chat });
    const n = backend.turns.length;
    const r = await voice.voiceTool(deps, { name: "Ask", args: { request: "Rewrite all of section 4 in plain words." }, convId: chat, device: "phone" });
    expect(r.result).toMatch(/is working on it/);
    await until(() => backend.turns.length > n);
    // The turn is still running (longer than ElevenLabs' 15 s cascade or 30 s tool timeout would allow): nothing yet.
    const none = await voice.voiceUpdates(deps, { convId: chat, cursor: start.cursor, waitMs: 300 });
    expect(none.updates.filter((u) => u.kind === "result")).toEqual([]);
    backend.reply("Section 4 is rewritten in plain words; I read it back: five paragraphs, no symbols left.");
    await idle(chat);
    const got = await voice.voiceUpdates(deps, { convId: chat, cursor: none.cursor, waitMs: 2000 });
    const res = got.updates.find((u) => u.kind === "result")!;
    expect(res.speak).toBe(true);
    expect(res.text).toMatch(/^\[vc:result\] The agent answered: Section 4 is rewritten/);
    // Once: the cursor moved past it.
    const again = await voice.voiceUpdates(deps, { convId: chat, cursor: got.cursor, waitMs: 200 });
    expect(again.updates.filter((u) => u.kind === "result")).toEqual([]);
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

  it("with no chat (or a new one the laptop named), the first line makes the conversation, under that id", async () => {
    const a = await voice.voiceTranscript(deps, { convId: "local-new-chat-1", role: "user", text: "What does the writeup say?" });
    expect(a.body.convId).toBe("local-new-chat-1");
    const b = await voice.voiceTranscript(deps, { role: "user", text: "a call with nothing open" });
    const c = await convs.readConv(vault, String(b.body.convId));
    expect(c?.source).toBe("voice");
    expect(c?.title).toBe("a call with nothing open");
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
    expect((await convs.readConv(vault2, String(line.body.convId)))?.source).toBe("voice");
    expect(await convs.readConv(vault, String(line.body.convId))).toBeNull();
  });

  it("a conversation with no pi thread yet hands its voice lines to the agent's first turn", async () => {
    const id = "voice-first-1";
    await voice.voiceTranscript(deps, { convId: id, role: "user", text: "Remind me what a sigma-algebra is." });
    await voice.voiceTranscript(deps, { convId: id, role: "assistant", text: "Closed under complements and countable unions." });
    const n = backend.turns.length;
    await voice.voiceTool(deps, { name: "Ask", args: { request: "Write that definition into notes/measure.md." }, convId: id });
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

  it("a typed turn while voice is live is answered by the agent; voice gets it as context it never answers aloud", async () => {
    const chat = await typed("Start of the homework chat.", "Ready.");
    const cur = (await voice.voiceUpdates(deps, { convId: chat })).cursor;
    await typed("Is 2(b) the epsilon-delta one?", "Yes: take delta = epsilon/3.", chat);
    const got = await voice.voiceUpdates(deps, { convId: chat, cursor: cur, waitMs: 2000 });
    const u = got.updates.find((x) => x.kind === "context")!;
    expect(u.speak).toBe(false);
    expect(u.text).toContain('Carl typed in the chat: "Is 2(b) the epsilon-delta one?"');
    expect(u.text).toContain("take delta = epsilon/3");
    expect(u.text).toMatch(/Already answered: don't answer it aloud/);
    expect(got.updates.some((x) => x.speak)).toBe(false);
  });

  it("the agent's question reaches the call to be asked aloud; Carl's spoken answer goes back as its answer", async () => {
    const chat = await typed("Clean up my notes folder.", "Looking.");
    const cur = (await voice.voiceUpdates(deps, { convId: chat })).cursor;
    const n = backend.turns.length;
    await voice.voiceTool(deps, { name: "Ask", args: { request: "And delete the old drafts." }, convId: chat });
    await until(() => backend.turns.length > n);
    const thread = backend.turns.at(-1)!.threadId;
    const answer = backend.h.toolCall(thread, "AskUser", { question: "Delete all 12 drafts, or only the ones older than a month?", options: ["all 12", "older than a month"] });
    const got = await voice.voiceUpdates(deps, { convId: chat, cursor: cur, waitMs: 3000 });
    const q = got.updates.find((u) => u.kind === "question")!;
    expect(q.speak).toBe(true);
    expect(q.text).toContain("Delete all 12 drafts, or only the ones older than a month?");
    const r = await voice.voiceTool(deps, { name: "Ask", args: { request: "Only the ones older than a month." }, convId: chat });
    expect(r.result).toMatch(/went to it as his answer/);
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
      expect(String(laptop.body.systemPrompt)).not.toContain("private/s.md");
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
