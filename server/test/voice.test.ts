// Voice on the box, in process: the voice agent's tools against the box's
// working copy (path guards, a write, refusals, the sandboxless Bash), the
// hand-off to the engine (AskAgent starts a real conversation on a fake pi,
// AgentStatus reads it back), and the session minted with the box's
// ElevenLabs key — ElevenLabs faked, no request leaves the process.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup, git } from "./helpers";
import { withPiSessions } from "./fakeSession";

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
mkdirSync(join(vault2, ".vault-chat", "tools", "lab"), { recursive: true });
writeFileSync(join(vault2, ".vault-chat", "tools", "lab", "TOOL.md"), "---\nname: LabTool\ndescription: The lab vault's own tool.\n---\n");
writeFileSync(join(vault2, ".vault-chat", "tools", "lab", "run.sh"), "echo lab\n");
git(vault2, "init", "-q");
writeFileSync(join(vault, "notes", "a.md"), "# A\nthe quick fox\n");
writeFileSync(join(vault, "private", "s.md"), "secret quick\n");
writeFileSync(join(vault, ".vaultchatdeny"), "private\n");
writeFileSync(join(root, "outside.md"), "outside\n");
process.env.VC_VAULT = vault;
process.env.VC_STATE_DIR = join(root, "state");
process.env.VC_LOCALSTORAGE = join(root, "ls.json");
process.env.VC_PUSH_SUBS = join(root, "subs.json");
process.env.VC_TOKEN_FILE = join(root, "token");
process.env.VC_SECRETS_DIR = join(root, "secrets");

class FakeBackend extends EventEmitter {
  readonly name = "pi";
  h: any = null;
  turns: any[] = [];
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
    return { threadId: "t1", ref: undefined };
  }
  async resumeThread() {}
  async startTurn(threadId: string, o: any) {
    this.turns.push({ threadId, ...o });
    return { turnId: "pt-1" };
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
}

let engine: any;
let backend: FakeBackend;
let store: any;
let voice: typeof import("../voice");
let writes = 0;
let deps: import("../voice").VoiceDeps;
let deps2: import("../voice").VoiceDeps;
const tool = async (name: string, args: Record<string, unknown>) => (await voice.voiceTool(deps, { name, args })).result;

beforeAll(async () => {
  await import("../shims/globals");
  const { registerAll } = await import("../commands/registry");
  registerAll((await import("../commands/fs")).fsCommands);
  registerAll((await import("../commands/conversations")).conversationCommands);
  const keys = await import("../keys");
  registerAll(keys.keychainCommands);
  // The keys the laptop synced (fake values): a vault tool gets only the ones it declares.
  await keys.saveKeys(join(root, "secrets"), { "user.DEMO_KEY": "demo-canary", "user.OTHER_KEY": "other-canary" });
  store = (await import("../../src/store")).useStore;
  store.setState({ vaultPath: vault, conversationsLoaded: true });
  const { configureContext } = await import("../context");
  configureContext({ vault, agentModel: "openai/gpt-6.1-sol", apiKey: () => null, verifierDeny: [] } as any);
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
  });
  engine.start();
  voice = await import("../voice");
  deps = { vault, name: "main", main: true, shell: null, message: (b) => engine.message(b), onWrite: () => writes++ };
  deps2 = { vault: vault2, name: "lab", main: false, shell: null, onWrite: () => writes++ };
});

afterAll(() => {
  engine?.stop();
  cleanup(root);
});

describe("POST /api/v1/voice/tool", () => {
  it("reads inside the vault, relative or absolute", async () => {
    expect(await tool("Read", { path: "notes/a.md" })).toContain("the quick fox");
    expect(await tool("Read", { path: join(vault, "notes", "a.md") })).toContain("the quick fox");
    expect(await tool("ListDir", { path: "." })).toContain("notes/");
  });

  it("refuses paths outside the vault, .git, and denied entries", async () => {
    expect(await tool("Read", { path: "../outside.md" })).toMatch(/^Refused: .*outside the vault/);
    expect(await tool("Read", { path: join(root, "outside.md") })).toMatch(/outside the vault/);
    expect(await tool("Write", { path: ".git/config", contents: "x" })).toMatch(/\.git/);
    expect(await tool("Read", { path: "private/s.md" })).toMatch(/restricted/);
    expect(await tool("GitLog", { subdir: ".." })).toMatch(/outside the vault/);
    // Grep never surfaces a denied file.
    const g = await tool("Grep", { pattern: "quick" });
    expect(g).toContain("notes/a.md:2: the quick fox");
    expect(g).not.toContain("private");
  });

  it("writes and edits land in the working copy, and ask for a sync", async () => {
    const before = writes;
    expect(await tool("Write", { path: "notes/new.md", contents: "hello box\n" })).toBe("Wrote notes/new.md");
    expect(readFileSync(join(vault, "notes", "new.md"), "utf8")).toBe("hello box\n");
    expect(await tool("Edit", { path: "notes/new.md", old_string: "hello", new_string: "hi" })).toContain("edited");
    expect(readFileSync(join(vault, "notes", "new.md"), "utf8")).toBe("hi box\n");
    expect(writes).toBe(before + 2);
  });

  it("never writes the server's own files", async () => {
    const r = await tool("Write", { path: ".vault-chat/conversations/x.jsonl", contents: "{}" });
    expect(r).toMatch(/^Refused/);
    expect(existsSync(join(vault, ".vault-chat", "conversations", "x.jsonl"))).toBe(false);
    expect(await tool("Write", { path: "../escape.md", contents: "x" })).toMatch(/outside the vault/);
    expect(existsSync(join(root, "escape.md"))).toBe(false);
  });

  it("ScrollTo is the client's; an unknown tool is an error", async () => {
    expect(await tool("ScrollTo", { page: 3 })).toMatch(/moves a screen/);
    expect(await tool("Nope", {})).toMatch(/not available/);
  });

  it("Bash runs in the vault", async () => {
    const r = await tool("Bash", { command: "cat notes/a.md" });
    expect(r).toMatch(/^exit: 0/);
    expect(r).toContain("the quick fox");
    expect(await tool("Bash", { command: "cat private/s.md" })).toMatch(/^Refused/);
  });

  it("AskAgent starts a box chat (tagged with its project) and AgentStatus reads it", async () => {
    const r = JSON.parse(await tool("AskAgent", { task: "Summarise notes/a.md into notes/summary.md", project: "Voice test" }));
    expect(r.started).toBe(true);
    expect(typeof r.conversationId).toBe("string");
    const { readConv } = await import("../engine/convs");
    const conv = await readConv(vault, r.conversationId);
    expect(conv?.messages.some((m: any) => m.role === "user" && m.content.includes("Summarise notes/a.md"))).toBe(true);
    expect(conv?.project).toBeTruthy();
    // The voice agent started it: a voice conversation, not a phone chat.
    expect(conv?.source).toBe("voice");
    for (let i = 0; i < 100 && backend.turns.length < 1; i++) await new Promise((r) => setTimeout(r, 50));
    expect(backend.turns.length).toBe(1);
    const st = JSON.parse(await tool("AgentStatus", { conversationId: r.conversationId }));
    expect(st.conversationId).toBe(r.conversationId);
    expect(st.state).toBe("working");
    expect(await tool("AgentStatus", { conversationId: "nope" })).toMatch(/No conversation/);
    // Continuing the same chat steers it, it is not a new one.
    const again = JSON.parse(await tool("AskAgent", { task: "Also add a title", conversationId: r.conversationId }));
    expect(again.conversationId).toBe(r.conversationId);
    expect(again.started).toBe(false);
  });

  it("without an engine AskAgent says so", async () => {
    const r = await voice.voiceTool({ vault }, { name: "AskAgent", args: { task: "x" } });
    expect(r.result).toMatch(/not running/);
    // While the engine starts, main.ts's ready() throws: the agent hears why.
    const starting = await voice.voiceTool(
      { vault, message: async () => { throw new Error("the agent engine is still starting — try again in a minute"); } },
      { name: "AskAgent", args: { task: "x" } },
    );
    expect(starting.result).toMatch(/still starting/);
  });
});

describe("the vault's own voice tools on the box", () => {
  it("run in the sandbox runner with the args on stdin and every key as an environment variable", async () => {
    const r = await tool("EchoKey", { word: "hello" });
    expect(r).toContain('"word":"hello"');
    expect(r).toContain("demo=demo-canary");
    // Carl's call: the keys he adds are the agent's — all of them, not only the declared.
    expect(r).toContain("other=other-canary");
    expect(r).toContain("pwd=echo");
  });

  it("voice's Bash has the keys as environment variables (names mapped), the key files still hidden", async () => {
    const r = await tool("Bash", { command: 'echo "d=${DEMO_KEY:-none} o=${OTHER_KEY:-none}"' });
    expect(r).toContain("d=demo-canary o=other-canary");
    // A key synced since is in the next command (read at each spawn).
    const keys = await import("../keys");
    await keys.saveKeys(join(root, "secrets"), { "user.DEMO_KEY": "demo-canary", "user.OTHER_KEY": "other-canary", "user.lambda_api_key": "lambda-canary", "api.openrouter": "or-canary" });
    try {
      const r2 = await tool("Bash", { command: 'echo "l=${LAMBDA_API_KEY:-none} or=${#OPENROUTER_API_KEY}"' });
      expect(r2).toContain("l=lambda-canary or=9");
      expect(keys.agentKeyEnvNames()).toEqual(["DEMO_KEY", "LAMBDA_API_KEY", "OPENROUTER_API_KEY", "OTHER_KEY"]);
    } finally {
      await keys.saveKeys(join(root, "secrets"), { "user.DEMO_KEY": "demo-canary", "user.OTHER_KEY": "other-canary" });
    }
  });
});

describe("per vault", () => {
  it("a vault's voice reads its own working copy, never the other's, and saves its lines in it", async () => {
    const r = await voice.voiceTool(deps2, { name: "Read", args: { path: "lab/plan.md" } });
    expect(r.result).toContain("second vault");
    expect((await voice.voiceTool(deps2, { name: "Read", args: { path: join(vault, "notes", "a.md") } })).result).toMatch(/outside the vault/);
    expect((await voice.voiceTool(deps2, { name: "EchoKey", args: {} })).result).toMatch(/not available/);
    const line = await voice.voiceTranscript(deps2, { role: "user", text: "plan for the lab?" });
    const { readConv } = await import("../engine/convs");
    expect((await readConv(vault2, String(line.body.convId)))?.source).toBe("voice");
    expect(await readConv(vault, String(line.body.convId))).toBeNull();
  });
});

describe("POST /api/v1/voice/transcript", () => {
  it("saves a session as a voice conversation of its own, tagged with the project it came from", async () => {
    const { readConv, createConv } = await import("../engine/convs");
    const chat = await createConv(vault, { project: "bitnet-160m" }, "an engine chat");
    // The first line names the laptop's local thread: the box makes its own.
    const a = await voice.voiceTranscript(deps, { convId: "local-123", fromConvId: chat.id, role: "user", text: "What does the writeup say?" });
    expect(a.status).toBe(200);
    const id = String(a.body.convId);
    expect(id).not.toBe("local-123");
    const b = await voice.voiceTranscript(deps, { convId: id, role: "assistant", text: "Read writeup.md · on the box", system: true });
    expect(b.body.convId).toBe(id);
    await voice.voiceTranscript(deps, { convId: id, role: "assistant", text: "About 3.2B tokens." });
    const c = await readConv(vault, id);
    expect(c?.source).toBe("voice");
    expect(c?.project).toBe("bitnet-160m");
    expect(c?.messages.map((m: any) => [m.role, m.content, !!m.system])).toEqual([
      ["user", "What does the writeup say?", false],
      ["assistant", "Read writeup.md · on the box", true],
      ["assistant", "About 3.2B tokens.", false],
    ]);
    // Never into an engine chat: naming one starts a voice conversation instead.
    const d = await voice.voiceTranscript(deps, { convId: chat.id, role: "user", text: "hi" });
    expect(d.body.convId).not.toBe(chat.id);
    expect((await readConv(vault, chat.id))?.messages.length).toBe(0);
    // It is in the list the clients read.
    const { conversationsSummary } = await import("../phoneData");
    const rows = (conversationsSummary(vault) as any).conversations;
    expect(rows.find((r: any) => r.id === id)?.source).toBe("voice");
    expect((await voice.voiceTranscript(deps, { role: "user", text: "  " })).status).toBe(400);
    // The agent's audio tags (an older client sends them) never reach the saved text.
    await voice.voiceTranscript(deps, { convId: id, role: "assistant", text: "[excited] Yes, it absolutely does!" });
    const bare = await voice.voiceTranscript(deps, { convId: id, role: "assistant", text: "[laughs]" });
    expect(bare.status).toBe(200);
    const after = await readConv(vault, id);
    expect(after?.messages.slice(-1).map((m: any) => m.content)).toEqual(["Yes, it absolutely does!"]);
    expect(after?.messages.length).toBe(4);
  });

  it("voice's tool calls are tool rows like the text agent's: consecutive ones share one group, a notice stays a notice", async () => {
    const { readConv } = await import("../engine/convs");
    const a = await voice.voiceTranscript(deps, { convId: "local-tools", role: "user", text: "jump to the MDP section" });
    const id = String(a.body.convId);
    await voice.voiceTranscript(deps, { convId: id, role: "assistant", text: "LookAtScreen", system: true, tool: { name: "LookAtScreen", args: {}, result: "course-notes.html, 3 headings" } });
    await voice.voiceTranscript(deps, { convId: id, role: "assistant", text: "Scrolled to end-to-end-mdp-concepts", system: true, tool: { name: "ScrollTo", args: { path: "notes.html", anchor: "end-to-end-mdp-concepts", big: "x".repeat(900) }, result: "Scrolled to end-to-end-mdp-concepts" } });
    await voice.voiceTranscript(deps, { convId: id, role: "assistant", text: "There it is." });
    await voice.voiceTranscript(deps, { convId: id, role: "assistant", text: "Voice session ended.", system: true });
    const msgs = (await readConv(vault, id))!.messages as any[];
    expect(msgs.map((m) => (m.toolCalls ? `tools:${m.toolCalls.map((t: any) => t.name).join(",")}` : m.system ? `notice:${m.content}` : `${m.role}:${m.content}`))).toEqual([
      "user:jump to the MDP section",
      "tools:LookAtScreen,ScrollTo",
      "assistant:There it is.",
      "notice:Voice session ended.",
    ]);
    const scroll = msgs[1].toolCalls[1];
    expect(scroll.input.anchor).toBe("end-to-end-mdp-concepts");
    expect(scroll.input.big.length).toBeLessThan(510);
    expect(scroll.result).toBe("Scrolled to end-to-end-mdp-concepts");
    expect(msgs[1].system).toBeFalsy();
  });

  it("an image Carl sent in the chat while voice was on is saved with his line (the text agent sees it later)", async () => {
    const { readConv } = await import("../engine/convs");
    const pngB64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString("base64");
    const a = await voice.voiceTranscript(deps, { convId: "local-img", role: "user", text: "this one", images: [{ mime: "image/png", dataBase64: pngB64 }, { mime: "text/html", dataBase64: "PGgxPg==" }] });
    const c = await readConv(vault, String(a.body.convId));
    const m = c?.messages[0] as any;
    expect(m.content).toBe("this one");
    expect(m.attachments).toHaveLength(1);
    expect(m.attachments[0].capturedFilePath).toMatch(/^\.vault-chat\/captures\/.+\.png$/);
    expect(readFileSync(join(vault, m.attachments[0].capturedFilePath)).toString("base64")).toBe(pngB64);
    expect(m.attachments[0].imageDataUrl).toBe(`data:image/png;base64,${pngB64}`);
  });
});

describe("GET /api/v1/voice/session (ElevenLabs faked)", () => {
  it("is 503 without the box's ElevenLabs key", async () => {
    store.setState({ serviceKeys: {} });
    const out = await voice.voiceSession(null, deps);
    expect(out.status).toBe(503);
  });

  it("provisions the agent with the hand-off tools and returns a signed URL, never the key", async () => {
    const calls: { url: string; body: any; key: string | null }[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(typeof input === "string" ? input : input.url);
      if (!url.startsWith("https://api.elevenlabs.io/")) return real(input, init);
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : null, key: init?.headers?.["xi-api-key"] ?? null });
      if (url.includes("/convai/agents/create")) return new Response(JSON.stringify({ agent_id: "agent_fake" }), { status: 200 });
      if (url.includes("/get_signed_url")) return new Response(JSON.stringify({ signed_url: "wss://fake.elevenlabs/x?sig=1" }), { status: 200 });
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    try {
      store.setState({ serviceKeys: { elevenlabs: "el-canary-key" } });
      const out = await voice.voiceSession(null, deps);
      expect(out.status).toBe(200);
      expect(out.body.signedUrl).toBe("wss://fake.elevenlabs/x?sig=1");
      // Minting a session makes the box busy until the session ends.
      expect(voice.activeVoiceSessions()).toBeGreaterThan(0);
      expect(out.body.toolNames).toEqual(expect.arrayContaining(["Read", "Write", "Bash", "AskAgent", "AgentStatus", "ScrollTo"]));
      expect(String(out.body.systemPrompt)).toContain("AskAgent");
      expect(String(out.body.systemPrompt)).toMatch(/SetProject {name} puts this chat into that project/);
      expect(out.body.toolNames).toContain("SetProject");
      expect(JSON.stringify(out.body)).not.toContain("el-canary-key");
      const create = calls.find((c) => c.url.includes("/agents/create"))!;
      expect(create.key).toBe("el-canary-key");
      const names = create.body.conversation_config.agent.prompt.tools.map((t: any) => t.name);
      expect(names).toEqual(expect.arrayContaining(["AskAgent", "AgentStatus", "EchoKey"]));
      expect(out.body.toolNames).toEqual(expect.arrayContaining(["EchoKey"]));
      // The vault index, from git's file list (the box has no file tree).
      expect(String(out.body.systemPrompt)).toContain("notes/a.md");
      expect(String(out.body.systemPrompt)).not.toContain("private/s.md");
      expect(out.body.vaultRoot).toBe(vault);
      expect(calls.some((c) => c.url.includes("agent_id=agent_fake"))).toBe(true);
      // A second session reuses the provisioned agent.
      const n = calls.length;
      expect((await voice.voiceSession(null, deps)).status).toBe(200);
      expect(calls.slice(n).some((c) => c.url.includes("/agents/create"))).toBe(false);

      // Another vault: its own working copy and index, its own agent (no EchoKey: that tool is the first vault's).
      const m = calls.length;
      const other = await voice.voiceSession(null, deps2);
      expect(other.status).toBe(200);
      expect(other.body.vaultRoot).toBe(vault2);
      expect(String(other.body.systemPrompt)).toContain("lab/plan.md");
      expect(String(other.body.systemPrompt)).not.toContain("notes/a.md");
      expect(other.body.toolNames).not.toContain("EchoKey");
      expect(other.body.toolNames).toContain("LabTool");
      expect(calls.slice(m).filter((c) => c.url.includes("/agents/create")).length).toBe(1);
      // …and the first vault's agent is still its own (no re-provision ping-pong).
      const k = calls.length;
      expect((await voice.voiceSession(null, deps)).status).toBe(200);
      expect(calls.slice(k).some((c) => c.url.includes("/agents/create"))).toBe(false);
    } finally {
      globalThis.fetch = real;
    }
  });

  it("a non-default voice is the session's and the agent's (overrides on; a voice change PATCHes the agent; a refusal says so)", async () => {
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
      localStorage.removeItem("vault_chat_elevenlabs_agent_id");
      // The laptop's pick (voiceBox sends ?voice=): a fresh agent speaks with it, and the session carries it.
      const a = await voice.voiceSession(null, deps, { voice: "LibVoiceJuniper0001" });
      expect(a.status).toBe(200);
      expect(a.body.voiceId).toBe("LibVoiceJuniper0001");
      const create = calls.find((c) => c.url.includes("/agents/create"))!;
      expect(create.body.conversation_config.tts.voice_id).toBe("LibVoiceJuniper0001");
      expect(create.body.conversation_config.tts.model_id).toBe("eleven_flash_v2");
      expect(create.body.platform_settings.overrides.conversation_config_override.tts.voice_id).toBe(true);
      // Another voice: the same agent, its voice PATCHed; no new agent.
      const n = calls.length;
      const b = await voice.voiceSession(null, deps, { voice: "LibVoiceRowan000002" });
      expect(b.body.voiceId).toBe("LibVoiceRowan000002");
      const after = calls.slice(n);
      expect(after.some((c) => c.url.includes("/agents/create"))).toBe(false);
      const patch = after.find((c) => c.method === "PATCH")!;
      expect(patch.url).toBe("https://api.elevenlabs.io/v1/convai/agents/agent_voice");
      expect(patch.body).toEqual({ conversation_config: { tts: { voice_id: "LibVoiceRowan000002" } } });
      // The same voice again: nothing to change.
      const m = calls.length;
      await voice.voiceSession(null, deps, { voice: "LibVoiceRowan000002" });
      expect(calls.slice(m).some((c) => c.method === "PATCH")).toBe(false);
      // A voice ElevenLabs refuses: no session with another voice, and the reason in words.
      refuse = true;
      const r = await voice.voiceSession(null, deps, { voice: "LibVoiceV3only00003" });
      expect(r.status).toBe(503);
      expect(String(r.body.error)).toContain("LibVoiceV3only00003");
      expect(String(r.body.error)).toContain("not available for eleven_flash_v2");
      refuse = false;
      expect((await voice.voiceSession(null, deps, { voice: "nPczCjzI2devNBz1zQrb" })).body.voiceId).toBe("nPczCjzI2devNBz1zQrb");
    } finally {
      globalThis.fetch = real;
    }
  });

  it("two vaults' sessions started at once each get only their own tools", async () => {
    const creates: { slotTools: string[] }[] = [];
    const real = globalThis.fetch;
    let slow = "EchoKey";
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(typeof input === "string" ? input : input.url);
      if (!url.startsWith("https://api.elevenlabs.io/")) return real(input, init);
      if (url.includes("/convai/agents/create")) {
        const b = JSON.parse(init.body);
        // One vault's provisioning answers late: the other vault's session is
        // built (and its tools loaded) while this one waits — both orders.
        if (b.conversation_config.agent.prompt.tools.some((x: any) => x.name === slow)) await new Promise((r) => setTimeout(r, 120));
        creates.push({ slotTools: b.conversation_config.agent.prompt.tools.map((x: any) => x.name) });
        return new Response(JSON.stringify({ agent_id: `agent_${creates.length}` }), { status: 200 });
      }
      if (url.includes("/get_signed_url")) return new Response(JSON.stringify({ signed_url: `wss://fake/${url.split("agent_id=")[1]}` }), { status: 200 });
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    try {
      store.setState({ serviceKeys: { elevenlabs: "el-canary-key" } });
      for (let round = 0; round < 4; round++) {
        slow = round % 2 ? "LabTool" : "EchoKey";
        // Fresh agents for both (a changed config version forces both to provision now).
        localStorage.setItem("vault_chat_elevenlabs_agent_config_version", "old");
        localStorage.setItem("vault_chat_elevenlabs_agent_config_version:vault:lab", "old");
        const [a, b] = await Promise.all([voice.voiceSession(null, deps), voice.voiceSession(null, deps2)]);
        expect(a.status).toBe(200);
        expect(b.status).toBe(200);
        expect(a.body.toolNames).toContain("EchoKey");
        expect(a.body.toolNames).not.toContain("LabTool");
        expect(b.body.toolNames).toContain("LabTool");
        expect(b.body.toolNames).not.toContain("EchoKey");
        expect(String(a.body.systemPrompt)).toContain("EchoKey");
        expect(String(a.body.systemPrompt)).not.toContain("LabTool");
        expect(String(b.body.systemPrompt)).toContain("LabTool");
        expect(String(b.body.systemPrompt)).not.toContain("EchoKey");
        expect(a.body.signedUrl).not.toBe(b.body.signedUrl);
      }
      // Each provisioned agent carries exactly its own vault's tool.
      expect(creates.length).toBe(8);
      for (const c of creates) expect(c.slotTools.includes("EchoKey") !== c.slotTools.includes("LabTool")).toBe(true);
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe("a live voice session keeps the box busy (the updater waits on busy.runs)", () => {
  it("from the session, a tool or a line until the end line, or VOICE_IDLE_MS of silence", async () => {
    // Clear whatever the earlier tests left live.
    voice.voiceActivity(vault, true);
    voice.voiceActivity(vault2, true);
    expect(voice.activeVoiceSessions()).toBe(0);
    await voice.voiceTool(deps, { name: "Read", args: { path: "notes/a.md" } });
    expect(voice.activeVoiceSessions()).toBe(1);
    const a = await voice.voiceTranscript(deps2, { role: "user", text: "lab question" });
    expect(voice.activeVoiceSessions()).toBe(2);
    // Ten minutes without a tool or a line: that client is gone.
    expect(voice.activeVoiceSessions(Date.now() + voice.VOICE_IDLE_MS + 1)).toBe(0);
    await voice.voiceTool(deps, { name: "Read", args: { path: "notes/a.md" } });
    await voice.voiceTranscript(deps2, { convId: a.body.convId, role: "user", text: "lab question again" });
    // The end line (the clients' "Voice session ended.", a system line) ends it.
    await voice.voiceTranscript(deps2, { convId: a.body.convId, role: "assistant", text: "Voice session ended.", system: true });
    expect(voice.activeVoiceSessions()).toBe(1);
    // Said by the agent (not a system line), the words don't end anything.
    await voice.voiceTranscript(deps, { role: "assistant", text: "Voice session ended is what the button says." });
    expect(voice.activeVoiceSessions()).toBe(1);
    await voice.voiceTranscript(deps, { role: "assistant", text: "x", ended: true });
    expect(voice.activeVoiceSessions()).toBe(0);
  });
});

describe("SetProject (voice files its chat under a project)", () => {
  it("puts the session's voice conversation into the project, creating it when new; before a line, the chat it started from", async () => {
    const { readConv, createConv } = await import("../engine/convs");
    const from = await createConv(vault, {}, "the chat voice started from");
    const line = await voice.voiceTranscript(deps, { convId: null, fromConvId: from.id, role: "user", text: "make this a project called Whiteboard" });
    const own = String(line.body.convId);
    const out = await voice.voiceTool(deps, { name: "SetProject", args: { name: "Whiteboard" }, convId: own, fromConvId: from.id });
    expect(out.result).toMatch(/now in the project "Whiteboard" \(a new project\)/);
    expect((await readConv(vault, own))?.project).toBe("whiteboard");
    expect(existsSync(join(vault, "agent-projects", "whiteboard"))).toBe(true);
    // Again: an existing project is joined, not made twice.
    expect((await voice.voiceTool(deps, { name: "SetProject", args: { name: "Whiteboard" }, convId: own })).result).not.toMatch(/new project/);
    // Nothing said yet (no voice conversation): the chat the session started from.
    await voice.voiceTool(deps, { name: "SetProject", args: { name: "Whiteboard" }, convId: null, fromConvId: from.id });
    expect((await readConv(vault, from.id))?.project).toBe("whiteboard");
    // An empty name takes it out.
    expect((await voice.voiceTool(deps, { name: "SetProject", args: { name: "" }, convId: own })).result).toMatch(/no longer in a project/);
    expect((await readConv(vault, own))?.project).toBeUndefined();
    expect((await voice.voiceTool(deps, { name: "SetProject", args: { name: "X" } })).result).toMatch(/^Error: there is no chat/);
  });

  it("is in the box's session: the tool, and the prompt says voice can make projects", async () => {
    const v = await import("../../src/voice-elevenlabs");
    expect(v.BUILTIN_VOICE_TOOL_NAMES).toContain("SetProject");
    const askAgent = v.CLIENT_TOOL_DEFINITIONS.find((t: any) => t.name === "AskAgent") as any;
    expect(askAgent.parameters.properties.project.description).toMatch(/starts the agent's work as a project/i);
  });
});
