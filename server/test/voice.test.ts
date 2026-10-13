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
  backend = new FakeBackend();
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
  it("run in the sandbox runner with the args on stdin and only their declared keys", async () => {
    const r = await tool("EchoKey", { word: "hello" });
    expect(r).toContain('"word":"hello"');
    expect(r).toContain("demo=demo-canary");
    expect(r).toContain("other=none");
    expect(r).toContain("pwd=echo");
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
      expect(out.body.toolNames).toEqual(expect.arrayContaining(["Read", "Write", "Bash", "AskAgent", "AgentStatus", "ScrollTo"]));
      expect(String(out.body.systemPrompt)).toContain("AskAgent");
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
      expect(calls.slice(m).filter((c) => c.url.includes("/agents/create")).length).toBe(1);
      // …and the first vault's agent is still its own (no re-provision ping-pong).
      const k = calls.length;
      expect((await voice.voiceSession(null, deps)).status).toBe(200);
      expect(calls.slice(k).some((c) => c.url.includes("/agents/create"))).toBe(false);
    } finally {
      globalThis.fetch = real;
    }
  });
});
