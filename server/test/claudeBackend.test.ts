// A conversation running on Claude Code, end to end: the engine starts a turn,
// the real CLI answers, and what the three clients read is a pi-shaped feed.
// The model is a scripted stand-in (./claudeFakeApi.ts); the engine, the
// backend, the CLI, the session file and the one reducer are all real.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup } from "./helpers";
import { fakeAnthropic, type FakeApi } from "./claudeFakeApi";
import { findClaude } from "../engine/claude/install";
import { claudePaths } from "../engine/claude/paths";
import { ClaudeCodeBackend, isClaudeThread } from "../engine/claude/backend";
import { BackendRouter, type EngineName } from "../engine/router";
import type { BoundTools } from "../mcp/tools";
import type { Detached, EngineBackend, Handlers, SideRunner, ToolSpec } from "../engine/backend";

const root = tmp("vccb-");
const vault = join(root, "vault");
mkdirSync(join(vault, ".vault-chat", "conversations"), { recursive: true });
mkdirSync(join(vault, ".vault-chat", "events", "sessions"), { recursive: true });
process.env.VC_VAULT = vault;
process.env.VC_STATE_DIR = join(root, "state");
process.env.VC_LOCALSTORAGE = join(root, "ls.json");
process.env.VC_PUSH_SUBS = join(root, "subs.json");
process.env.VC_TOKEN_FILE = join(root, "token");
process.env.VC_SECRETS_DIR = join(root, "secrets");

/** Enough of pi for the router to lean on for path policy and side threads. */
class StubPi extends EventEmitter implements EngineBackend {
  readonly name = "pi";
  setHandlers(_h: Handlers): void {}
  start(): void {}
  async ready(): Promise<boolean> {
    return true;
  }
  health(): Record<string, unknown> {
    return { state: "up" };
  }
  async startThread() {
    return { threadId: `pi-${Math.random().toString(36).slice(2, 8)}` };
  }
  async resumeThread(): Promise<void> {}
  holds(): boolean {
    return false;
  }
  forget(): void {}
  threadSource() {
    return null;
  }
  async note(): Promise<boolean> {
    return false;
  }
  async compact() {
    return {};
  }
  async startTurn() {
    return { turnId: "pi-turn" };
  }
  async steer(): Promise<void> {}
  async followUp(): Promise<void> {}
  async clearQueue() {
    return { steering: [], followUp: [] };
  }
  async interrupt(): Promise<void> {}
  usageCalls() {
    return [];
  }
  childUsageCalls() {
    return [];
  }
  async externalPath(): Promise<string | null> {
    return null;
  }
  async nativePath(): Promise<string | null> {
    return null;
  }
  async filesystem(): Promise<BoundTools> {
    throw new Error("no file tools in this test");
  }
  readonly side: SideRunner = {
    start: async () => {
      throw new Error("no side threads in this test");
    },
    poll: async () => null,
    wait: async () => {
      throw new Error("no side threads in this test");
    },
    stop: async () => false,
    forget: () => {},
    health: () => ({}),
  };
  readonly paths = { sessionsDir: join(root, "pi-sessions"), instrDir: join(root, "pi-instr") };
  async background(): Promise<Record<string, unknown>> {
    throw new Error("no workers in this test");
  }
  async subagentControl(): Promise<{ ok: boolean }> {
    return { ok: false };
  }
  detach(): Detached[] {
    return [];
  }
}

let api: FakeApi;
let engine: any;
let claude: ClaudeCodeBackend;
let router: BackendRouter;
let readConv: (v: string, id: string) => Promise<any>;
let choice: EngineName = "claude";
const turnLines: any[] = [];

/** Set while the `slow` tool is waiting; calling it lets that tool return. */
let release: (() => void) | null = null;
/** Wait until the turn is sitting inside `slow`. */
const inSlowTool = async () => {
  const t0 = Date.now();
  while (!release) {
    if (Date.now() - t0 > 120_000) throw new Error("the held tool was never reached");
    await new Promise((r) => setTimeout(r, 25));
  }
};

const echo = () =>
  createSdkMcpServer({
    name: "vault_chat",
    version: "1.0.0",
    tools: [
      tool("echo", "Echo back a word", {}, async () => ({ content: [{ type: "text" as const, text: "echo: ok" }] })),
      // Held until the test lets go, so the window to queue into is as long as
      // the test needs and never closes early on a loaded box.
      tool("slow", "Wait until the host releases it", {}, async () => {
        await new Promise<void>((r) => (release = r));
        return { content: [{ type: "text" as const, text: "slow: done" }] };
      }),
    ],
  });

beforeAll(async () => {
  const found = findClaude({ stateDir: join(root, "state"), env: {} });
  if ("error" in found) throw new Error(`${found.error}: ${found.tried.join("; ")}`);
  api = await fakeAnthropic();

  await import("../shims/globals");
  const { registerAll } = await import("../commands/registry");
  const { conversationCommands } = await import("../commands/conversations");
  const { fsCommands } = await import("../commands/fs");
  registerAll(fsCommands);
  registerAll(conversationCommands);
  const store = (await import("../../src/store")).useStore;
  store.setState({ vaultPath: vault, conversationsLoaded: true });
  readConv = (await import("../engine/convs")).readConv;
  const { configureContext } = await import("../context");
  configureContext({ vault, agentModel: "haiku" });

  const paths = claudePaths(join(root, "state"));
  claude = new ClaudeCodeBackend({
    install: found.install,
    paths,
    feedSessionsDir: join(vault, ".vault-chat", "events", "sessions"),
    env: () => ({
      PATH: process.env.PATH ?? "",
      HOME: paths.configDir,
      CLAUDE_CONFIG_DIR: paths.configDir,
      ANTHROPIC_BASE_URL: api.url,
      ANTHROPIC_API_KEY: "sk-ant-not-a-real-key",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    }),
    policy: new StubPi(),
    mcpServers: () => ({ vault_chat: echo() }),
    allowedTools: () => ["mcp__vault_chat__echo", "mcp__vault_chat__slow"],
    log: () => {},
  });
  router = new BackendRouter({ pi: new StubPi(), claude, engineOf: () => choice, log: () => {} });

  const { Engine } = await import("../engine/engine");
  engine = new Engine({
    vault,
    backend: router,
    ledger: { settle: async () => ({ calls: 0, usd: 0, missing: 0, byId: {} }), has: () => false } as any,
    jobEnv: { logDir: join(root, "jobs"), wrap: null, env: {} } as any,
    model: () => "haiku",
    webSearchModel: "x",
    apiKey: () => null,
    notify: async () => "sent",
    broadcast: () => {},
    log: () => {},
    vaultName: "vault-chat",
    turnLog: (l: any) => turnLines.push(l),
  });
  engine.start();
  router.start();
});

afterAll(async () => {
  engine?.stop();
  claude?.stop();
  await api?.close();
  cleanup(root);
});

const until = async (fn: () => Promise<boolean> | boolean, ms = 120_000) => {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};
/** The turn carrying `text` has been taken and has finished. */
const answered = async (convId: string, text: string) => {
  await until(async () => ((await readConv(vault, convId))?.messages ?? []).some((m: any) => m.role === "user" && m.content === text));
  await until(async () => (await readConv(vault, convId))?.state === "idle");
};
const shown = async (convId: string) =>
  ((await readConv(vault, convId))?.messages ?? []).filter((m: any) => !m.system).map((m: any) => [m.role, m.content]);

describe("a conversation on Claude Code", () => {
  it("answers a message, and the feed the clients read is the one a pi turn gives", async () => {
    const r = await engine.message({ text: "say something", convId: "cc-conv-1" });
    await answered(r.convId, "say something");

    const conv = await readConv(vault, r.convId);
    expect(isClaudeThread(conv.threadId)).toBe(true);
    expect(await shown(r.convId)).toEqual([
      ["user", "say something"],
      ["assistant", "REPLY to: say something"],
    ]);
    // Its transcript is a pi-format session file in the feed's own sessions folder.
    expect(conv.threadPath).toContain(join(".vault-chat", "events", "sessions"));
    expect(existsSync(conv.threadPath)).toBe(true);
    // One turn, logged like any other.
    const line = turnLines.find((l) => l.conv === r.convId);
    expect(line).toMatchObject({ ev: "turn", vault: "vault-chat", mode: "user", status: "completed", state: "idle" });
  }, 180_000);

  it("keeps the same session for the next message, and remembers its id across a restart", async () => {
    const convId = "cc-conv-1";
    const conv = await readConv(vault, convId);
    const threadId = conv.threadId;
    await engine.message({ text: "and again", convId });
    await answered(convId, "and again");
    expect((await readConv(vault, convId)).threadId).toBe(threadId);
    expect(await shown(convId)).toEqual([
      ["user", "say something"],
      ["assistant", "REPLY to: say something"],
      ["user", "and again"],
      ["assistant", "REPLY to: and again"],
    ]);
    // The thread's Claude Code session id is on disk, so a turn after a restart resumes it.
    const threadsFile = claudePaths(join(root, "state")).threadsFile;
    const threads = JSON.parse(existsSync(threadsFile) ? readFileSync(threadsFile, "utf8") : "{}");
    expect(threads[threadId]?.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    // The model saw the first exchange again: the session was resumed, not restarted blank.
    const last = api.requests[api.requests.length - 1];
    expect(JSON.stringify(last.messages)).toContain("say something");
  }, 180_000);

  it("a tool call shows as a tool row with its result, through vault-chat's own MCP server", async () => {
    const r = await engine.message({ text: 'CALL mcp__vault_chat__echo {}', convId: "cc-conv-2" });
    await answered(r.convId, 'CALL mcp__vault_chat__echo {}');
    const p = engine.picture(r.convId);
    const tools = p.items.filter((i: any) => i.kind === "tool");
    expect(tools.map((t: any) => [t.name, t.status, t.result])).toEqual([["echo", "done", "echo: ok"]]);
    // The reply is still the reply, and the commentary is not in it.
    expect(p.items.filter((i: any) => i.kind === "assistant").length).toBeGreaterThan(0);
  }, 180_000);

  it("a queued message is pending in the chat until its own turn takes it", async () => {
    // A turn that sits in a tool call, so there is a window to queue into.
    release = null;
    const r = await engine.message({ text: 'CALL mcp__vault_chat__slow {}', convId: "cc-conv-queue" });
    await inSlowTool();

    const q = await engine.message({ convId: r.convId, text: "the queued one", queue: true, clientMsgId: "c-q1" });
    expect(q.queued).toBe(true);
    // Shown as waiting, and NOT in the transcript: the entry is the delivery.
    let conv = await readConv(vault, r.convId);
    expect(conv.queued.map((x: any) => x.text)).toEqual(["the queued one"]);
    expect(conv.messages.some((m: any) => m.content === "the queued one")).toBe(false);

    // Its own turn takes it: now it is in the transcript, under the client's id.
    release!();
    await answered(r.convId, "the queued one");
    conv = await readConv(vault, r.convId);
    expect(conv.queued ?? []).toEqual([]);
    const row = conv.messages.find((m: any) => m.content === "the queued one");
    expect(row.mid).toBe("c-q1");
    expect(conv.messages.filter((m: any) => m.content === "the queued one")).toHaveLength(1);
  }, 180_000);

  it("a queued message taken back before delivery never reaches the model", async () => {
    release = null;
    const r = await engine.message({ text: 'CALL mcp__vault_chat__slow {}', convId: "cc-conv-unqueue" });
    await inSlowTool();
    const q = await engine.message({ convId: r.convId, text: "NEVER-SENT-KIWI", queue: true, clientMsgId: "c-u1" });
    expect((await engine.message({ convId: r.convId, unqueue: q.qid })).ok).toBe(true);
    release!();
    await until(async () => (await readConv(vault, r.convId))?.state === "idle");
    const conv = await readConv(vault, r.convId);
    expect(conv.messages.some((m: any) => m.content === "NEVER-SENT-KIWI")).toBe(false);
    expect(JSON.stringify(api.requests)).not.toContain("NEVER-SENT-KIWI");
  }, 180_000);

  it("a conversation set to pi does not get a Claude Code thread", async () => {
    choice = "pi";
    try {
      const conv = await engine.setEngine("cc-conv-3", "pi");
      expect(conv.ok).toBe(false); // no such conversation yet
      const r = await engine.message({ text: "on pi", convId: "cc-conv-3" });
      await until(async () => !!(await readConv(vault, r.convId))?.threadId);
      expect(isClaudeThread((await readConv(vault, r.convId)).threadId)).toBe(false);
    } finally {
      choice = "claude";
    }
  }, 120_000);

  it("the setting names the engine a conversation's next thread runs on", async () => {
    expect(await engine.setEngine("cc-conv-1", "pi")).toMatchObject({ ok: true, engine: "pi", appliesTo: "the next thread" });
    expect(await engine.setEngine("cc-conv-1", "elsewhere")).toMatchObject({ ok: false });
    // Put it back, so nothing is left pointing at an engine the test did not set up.
    expect(await engine.setEngine("cc-conv-1", "claude")).toMatchObject({ ok: true, engine: "claude" });
  });

  it("health names the engine in charge, with the other one beside it", () => {
    // The test's conversations run on Claude Code, so it is the engine in charge.
    const h = router.health();
    expect(h).toMatchObject({ state: "up", source: expect.any(String), pi: { state: "up" } });
    expect(router.name).toBe("claude");
  });
});
