// Voice on the box, in process: the voice agent's tools against the box's
// working copy (path guards, a write, refusals, the sandboxless Bash), the
// hand-off to the engine (AskAgent starts a real conversation on a fake pi,
// AgentStatus reads it back), and the session minted with the box's
// ElevenLabs key — ElevenLabs faked, no request leaves the process.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup } from "./helpers";

const root = tmp("vcv-");
const vault = join(root, "vault");
mkdirSync(join(vault, ".vault-chat", "conversations"), { recursive: true });
mkdirSync(join(vault, "notes"), { recursive: true });
mkdirSync(join(vault, "private"), { recursive: true });
mkdirSync(join(vault, ".git"), { recursive: true });
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
const tool = async (name: string, args: Record<string, unknown>) => (await voice.voiceTool(deps, { name, args })).result;

beforeAll(async () => {
  await import("../shims/globals");
  const { registerAll } = await import("../commands/registry");
  registerAll((await import("../commands/fs")).fsCommands);
  registerAll((await import("../commands/conversations")).conversationCommands);
  registerAll((await import("../keys")).keychainCommands);
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
  deps = { vault, shell: null, message: (b) => engine.message(b), onWrite: () => writes++ };
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
  });
});

describe("GET /api/v1/voice/session (ElevenLabs faked)", () => {
  it("is 503 without the box's ElevenLabs key", async () => {
    store.setState({ serviceKeys: {} });
    const out = await voice.voiceSession(null);
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
      const out = await voice.voiceSession(null);
      expect(out.status).toBe(200);
      expect(out.body.signedUrl).toBe("wss://fake.elevenlabs/x?sig=1");
      expect(out.body.toolNames).toEqual(expect.arrayContaining(["Read", "Write", "Bash", "AskAgent", "AgentStatus", "ScrollTo"]));
      expect(String(out.body.systemPrompt)).toContain("AskAgent");
      expect(JSON.stringify(out.body)).not.toContain("el-canary-key");
      const create = calls.find((c) => c.url.includes("/agents/create"))!;
      expect(create.key).toBe("el-canary-key");
      const names = create.body.conversation_config.agent.prompt.tools.map((t: any) => t.name);
      expect(names).toEqual(expect.arrayContaining(["AskAgent", "AgentStatus"]));
      expect(calls.some((c) => c.url.includes("agent_id=agent_fake"))).toBe(true);
      // A second session reuses the provisioned agent.
      const n = calls.length;
      expect((await voice.voiceSession(null)).status).toBe(200);
      expect(calls.slice(n).some((c) => c.url.includes("/agents/create"))).toBe(false);
    } finally {
      globalThis.fetch = real;
    }
  });
});
