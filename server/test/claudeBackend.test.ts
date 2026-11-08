// A conversation running on Claude Code, end to end: the engine starts a turn,
// the real CLI answers, and what the three clients read is a pi-shaped feed.
// The model is a scripted stand-in (./claudeFakeApi.ts); the engine, the
// backend, the CLI, the session file and the one reducer are all real.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup, patient } from "./helpers";
import { readEntries } from "../convlog/piSession";
import { fakeAnthropic, type FakeApi } from "./claudeFakeApi";
import { findClaude, type ClaudeInstall } from "../engine/claude/install";
import { claudePaths } from "../engine/claude/paths";
import { APP_ONLY_TOOLS, ClaudeCodeBackend, isClaudeThread } from "../engine/claude/backend";
import { McpRuntime } from "../mcp/runtime";
import { makeChatView } from "../../src/convlog/view";
import { claudeOf, defaultEngineOf } from "../../src/engineHealth";
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

/** A policy host for the backend's optional `policy` hook (the host's own file
 *  tools were pi's; this is the test's stand-in for one). */
class StubPolicy extends EventEmitter implements EngineBackend {
  readonly name = "stub";
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
  /** No file tools in this test; the point here is the host catalog over MCP. */
  async filesystem(): Promise<BoundTools> {
    return { specs: [], call: async () => ({ ok: false, text: "no file tools in this test" }) };
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
let claudeOpts: () => Omit<ConstructorParameters<typeof ClaudeCodeBackend>[0], "log">;
let readConv: (v: string, id: string) => Promise<any>;
let patchMeta: (v: string, id: string, patch: Record<string, unknown>) => Promise<unknown>;
const turnLines: any[] = [];

/** Set while the `slow` tool is waiting; calling it lets that tool return. */
let release: (() => void) | null = null;
/** Wait until the turn is sitting inside `slow`. */
const inSlowTool = async () => {
  const t0 = Date.now();
  while (!release) {
    if (Date.now() - t0 > 60_000) throw new Error("the held tool was never reached");
    await new Promise((r) => setTimeout(r, 25));
  }
};

const testTools = () =>
  createSdkMcpServer({
    name: "test_tools",
    version: "1.0.0",
    // As vault-chat's own server is: tool search is off, so nothing may be deferred.
    alwaysLoad: true,
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
  patchMeta = (await import("../engine/convs")).patchMeta;
  const { configureContext } = await import("../context");
  configureContext({ vault, agentModel: "haiku" });

  const paths = claudePaths(join(root, "state"));
  claudeOpts = () => ({
    install: (found as { install: ClaudeInstall }).install,
    paths,
    vault,
    feedSessionsDir: join(vault, ".vault-chat", "events", "sessions"),
    env: () => ({
      PATH: process.env.PATH ?? "",
      HOME: paths.configDir,
      CLAUDE_CONFIG_DIR: paths.configDir,
      ANTHROPIC_BASE_URL: api.url,
      ANTHROPIC_API_KEY: "sk-ant-not-a-real-key",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    }),
    policy: new StubPolicy(),
    // vault-chat's own tools come from the engine, bound over the host's MCP
    // runtime; this one is only the test's way to hold a turn open.
    mcp: new McpRuntime(),
    fileTools: [],
    mcpServers: () => ({ test_tools: testTools() }),
    // The tests run many conversations; without room for them all the session
    // cap would evict one mid-test and a later turn would mean something else.
    maxSessions: 16,
  });
  claude = new ClaudeCodeBackend({ ...claudeOpts(), log: () => {} });

  const { Engine } = await import("../engine/engine");
  engine = new Engine({
    vault,
    backend: claude,
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
});

afterAll(async () => {
  engine?.stop();
  claude?.stop();
  await api?.close();
  cleanup(root);
});

/**
 * Everything the model was sent on a request, as plain text. Stringifying the
 * request instead would escape every quote, so a check for text carrying one
 * (`changed="true"`) would pass whatever happened.
 */
const sentText = (n = 1): string => {
  const r = api.requests[api.requests.length - n];
  const sys = Array.isArray(r?.system) ? r.system.map((b: any) => String(b?.text ?? "")).join("\n") : String(r?.system ?? "");
  const msgs = (r?.messages ?? []).map((m: any) =>
    typeof m.content === "string" ? m.content : (m.content ?? []).map((b: any) => String(b?.text ?? "")).join("\n"),
  );
  return [sys, ...msgs].join("\n");
};

/** Its own wait, scaled like the shared one (helpers.ts patient). */
const until = async (fn: () => Promise<boolean> | boolean, ms = patient(60_000)) => {
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

  it("vault-chat's own tools are there, and one the agent calls is answered by the engine", async () => {
    // The session's tools are the engine's host catalog, bound over vault-chat's
    // loopback MCP server with a bearer that lives only in the session's headers.
    const r = await engine.message({ text: 'CALL mcp__vault_chat__JobList {}', convId: "cc-conv-2" });
    await answered(r.convId, 'CALL mcp__vault_chat__JobList {}');

    // What the MODEL was given, which is the thing that matters: vault-chat's
    // tools, not deferred behind tool search.
    const offered: string[] = (api.requests[api.requests.length - 1].tools ?? []).map((x: any) => x.name);
    for (const want of ["AskUser", "Notify", "StartJob", "JobList", "SearchHistory"]) {
      expect(offered).toContain(`mcp__vault_chat__${want}`);
    }
    // Of Claude Code's own: everything (Carl: "no bounds on the agent") but the
    // tools that only work inside Anthropic's own apps and the few vault-chat
    // has its own of (APP_ONLY_TOOLS). The shell and subagents above all.
    for (const t of ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "Agent", "ToolSearch"]) expect(offered).toContain(t);
    for (const t of APP_ONLY_TOOLS) expect(offered).not.toContain(t);
    expect(offered).toContain("mcp__vault_chat__WebFetch");
    expect(offered).toContain("DeferredToolPlaceholder");

    // The row says the tool's own name: the clients strip vault-chat's prefix.
    const p = engine.picture(r.convId);
    const tools = p.items.filter((i: any) => i.kind === "tool");
    expect(tools.map((t: any) => [t.name, t.status])).toEqual([["JobList", "done"]]);
    // It really ran: the engine answered it, so the row carries its result.
    expect(String(tools[0].result ?? "")).not.toBe("");
    expect(p.items.filter((i: any) => i.kind === "assistant").length).toBeGreaterThan(0);
  }, 180_000);

  it("a queued message is pending in the chat until its own turn takes it", async () => {
    // A turn that sits in a tool call, so there is a window to queue into.
    release = null;
    const r = await engine.message({ text: 'CALL mcp__test_tools__slow {}', convId: "cc-conv-queue" });
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
    const r = await engine.message({ text: 'CALL mcp__test_tools__slow {}', convId: "cc-conv-unqueue" });
    await inSlowTool();
    const q = await engine.message({ convId: r.convId, text: "NEVER-SENT-KIWI", queue: true, clientMsgId: "c-u1" });
    expect((await engine.message({ convId: r.convId, unqueue: q.qid })).ok).toBe(true);
    release!();
    await until(async () => (await readConv(vault, r.convId))?.state === "idle");
    const conv = await readConv(vault, r.convId);
    expect(conv.messages.some((m: any) => m.content === "NEVER-SENT-KIWI")).toBe(false);
    expect(JSON.stringify(api.requests)).not.toContain("NEVER-SENT-KIWI");
  }, 180_000);

  it("a turn the engine adopted says nothing, so it consumes none of the turn's context", async () => {
    // Something Carl did that the agent must hear once. An adopted turn sends no
    // prompt, so it must not swallow it: the next real turn still carries it.
    release = null;
    const r = await engine.message({ text: 'CALL mcp__test_tools__slow {}', convId: "cc-conv-adopt" });
    await inSlowTool();
    await patchMeta(vault, r.convId, { tellAgent: ["Carl deleted the physics project."] });
    const q = await engine.message({ convId: r.convId, text: "the queued one", queue: true, clientMsgId: "c-a1" });
    expect(q.queued).toBe(true);
    release!();
    await answered(r.convId, "the queued one");

    // The queued message ran as its own turn, which the engine adopted: still unsaid.
    expect(engine.picture(r.convId)?.meta.tellAgent).toEqual(["Carl deleted the physics project."]);

    // A real turn takes it, once.
    release = null;
    await engine.message({ text: "now say something", convId: r.convId });
    await answered(r.convId, "now say something");
    expect(engine.picture(r.convId)?.meta.tellAgent ?? null).toBeNull();
    expect(JSON.stringify(api.requests[api.requests.length - 1].messages)).toContain("deleted the physics project");
  }, 180_000);

  it('what Carl did elsewhere reaches the model once, and only what is new', async () => {
    // The engine answers the "you" layer; pi's extension asks for it before each
    // prompt, and here the host does. It must advance: the same thing is not
    // told twice.
    const asked: (number | null)[] = [];
    let layer = "<you>Carl renamed the physics note.</you>";
    const engineHandlers = claude.handlers!;
    claude.setHandlers({
      ...engineHandlers,
      you: async (q) => {
        asked.push(q.since ?? null);
        return { text: layer, until: 5_000 + asked.length };
      },
    });

    const r = await engine.message({ text: "first with a layer", convId: "cc-conv-you" });
    await answered(r.convId, "first with a layer");
    expect(JSON.stringify(api.requests[api.requests.length - 1].messages)).toContain("renamed the physics note");
    // Carl's own row shows his words, not the layer.
    expect(await shown(r.convId)).toEqual([
      ["user", "first with a layer"],
      ["assistant", "REPLY to: first with a layer"],
    ]);

    layer = "";
    await engine.message({ text: "second with none", convId: r.convId });
    await answered(r.convId, "second with none");
    // The second ask carried the point the first one reached.
    expect(asked.length).toBe(2);
    expect(asked[0]).toBeNull();
    expect(asked[1]).toBe(5_001);
    claude.setHandlers(engineHandlers);
  }, 180_000);

  it("the vault's memory reaches a session natively, and a change reaches it after", async () => {
    // Memory is Carl's own file; Claude Code is given it by importing it in the
    // session's CLAUDE.md, so it is NOT repeated in front of every turn.
    const memFile = join(vault, ".vault-chat", "MEMORY.md");
    writeFileSync(memFile, "# Memory\n\n- MEM-CANARY-FIRST-8811\n");

    const r = await engine.message({ text: "first with memory", convId: "cc-conv-mem" });
    await answered(r.convId, "first with memory");

    // The import is in the config dir Claude Code reads, and names the real file.
    const claudeMd = readFileSync(join(claudePaths(join(root, "state")).configDir, "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain(`@${memFile}`);
    // The model was given the memory (through the import), and NOT a <memory> section.
    const first = sentText();
    expect(first).toContain("MEM-CANARY-FIRST-8811");
    expect(first).not.toContain('<memory file=".vault-chat/MEMORY.md">');

    // Carl edits it while the session is up: its CLAUDE.md was read at the start,
    // so the change arrives through the prompt hook instead. (If the session had
    // been evicted the new import would carry it, which is why liveness is
    // asserted rather than assumed — the two paths are not the same claim.)
    expect(claude.holds((await readConv(vault, r.convId)).threadId)).toBe(true);
    writeFileSync(memFile, "# Memory\n\n- MEM-CANARY-SECOND-9922\n");
    await engine.message({ text: "second after the edit", convId: r.convId });
    await answered(r.convId, "second after the edit");
    const second = sentText();
    expect(second).toContain("MEM-CANARY-SECOND-9922");
    const said = (t: string) => t.split('changed="true"').length - 1;
    expect(said(second)).toBe(1);

    // Unchanged since: it is not said AGAIN. The session replays its history, so
    // what counts is that no new one is added, not that the old one is gone.
    await engine.message({ text: "third with no edit", convId: r.convId });
    await answered(r.convId, "third with no edit");
    expect(said(sentText())).toBe(1);
  }, 180_000);

  it("a restart resumes the thread from box state: same session, same transcript file", async () => {
    const convId = "cc-conv-1";
    const before = await readConv(vault, convId);
    const threadId = before.threadId as string;
    const file = before.threadPath as string;
    const sessionBefore = JSON.parse(readFileSync(claudePaths(join(root, "state")).threadsFile, "utf8"))[threadId].sessionId;
    const entriesBefore = readEntries(file).length;

    // A fresh backend over the same state dir is what the next boot has.
    const restarted = new ClaudeCodeBackend({ ...claudeOpts(), log: () => {} });
    restarted.start();
    try {
      // It knows the thread, and takes it back without starting a new one.
      await restarted.resumeThread(threadId, { model: "haiku", subagents: false });
      expect(restarted.holds(threadId)).toBe(true);
      expect(restarted.threadSource(threadId)).toMatchObject({ file, cwd: vault });

      const done = new Promise<void>((r) => restarted.once("event", function wait(e: any) {
        if (e.kind === "turnCompleted") r();
        else restarted.once("event", wait);
      }));
      await restarted.startTurn(threadId, { texts: ["after the restart"], images: [], model: "haiku" });
      await done;

      // Same Claude Code session, and the transcript went on in the same file.
      expect(JSON.parse(readFileSync(claudePaths(join(root, "state")).threadsFile, "utf8"))[threadId].sessionId).toBe(sessionBefore);
      const entries = readEntries(file);
      expect(entries.length).toBeGreaterThan(entriesBefore);
      expect(entries.some((x) => x.message?.role === "user" && JSON.stringify(x.message.content).includes("after the restart"))).toBe(true);
      // The model was given the earlier conversation, not a blank session.
      expect(JSON.stringify(api.requests[api.requests.length - 1].messages)).toContain("say something");
    } finally {
      restarted.stop();
    }
  }, 180_000);

  it("a thread this engine never started is not its to resume", async () => {
    await expect(claude.resumeThread("cc-not-a-thread", { model: "haiku", subagents: false })).rejects.toMatchObject({ threadUnknown: true });
  });

  it("one chat can hand work to another, and it shows there as a handoff, not as Carl", async () => {
    // The chat that will be handed the work has to exist first.
    const to = await engine.message({ text: "I own the physics work", convId: "cc-conv-target" });
    await answered(to.convId, "I own the physics work");

    const r = await engine.message({ text: 'CALL mcp__vault_chat__PostToConversation {"conversation_id":"cc-conv-target","text":"Finish the physics set"}', convId: "cc-conv-from" });
    await answered(r.convId, 'CALL mcp__vault_chat__PostToConversation {"conversation_id":"cc-conv-target","text":"Finish the physics set"}');

    // The target took its own turn on the handed-over words. Wait on the feed's
    // own item, not on readConv's messages: those are already rendered, and a
    // handoff renders as the quiet system line asserted below, never the bare words.
    await until(async () => engine.picture("cc-conv-target").items.some((i: any) => i.text === "Finish the physics set" && i.via === "handoff"));
    await until(async () => (await readConv(vault, "cc-conv-target"))?.state === "idle");

    // It is NOT shown as something Carl typed there: the clients' own view turns
    // a handoff into a quiet system line.
    const p = engine.picture("cc-conv-target");
    const row = p.items.find((i: any) => i.text === "Finish the physics set");
    expect(row).toMatchObject({ kind: "user", via: "handoff" });
    const view = makeChatView()(p);
    const line = view.messages.find((m: any) => String(m.content ?? "").includes("Finish the physics set"));
    expect(line).toMatchObject({ role: "user", system: true });
    expect(line.direct).toBeUndefined();

    // The chat that posted was told it does not wait, and its own turn ended.
    const tools = engine.picture(r.convId).items.filter((i: any) => i.kind === "tool");
    expect(tools.map((t: any) => t.name)).toEqual(["PostToConversation"]);
    expect(String(tools[0].result ?? "")).toMatch(/taking its own turn|take it when its current turn ends/);
  }, 240_000);

  it("a handoff refuses this chat itself and a chat that is not there", async () => {
    const r = await engine.message({ text: 'CALL mcp__vault_chat__PostToConversation {"conversation_id":"cc-conv-self","text":"loop"}', convId: "cc-conv-self" });
    await answered(r.convId, 'CALL mcp__vault_chat__PostToConversation {"conversation_id":"cc-conv-self","text":"loop"}');
    expect(String(engine.picture(r.convId).items.filter((i: any) => i.kind === "tool")[0]?.result ?? "")).toContain("posting to yourself");

    const r2 = await engine.message({ text: 'CALL mcp__vault_chat__PostToConversation {"conversation_id":"no-such-chat","text":"hello"}', convId: "cc-conv-missing" });
    await answered(r2.convId, 'CALL mcp__vault_chat__PostToConversation {"conversation_id":"no-such-chat","text":"hello"}');
    expect(String(engine.picture(r2.convId).items.filter((i: any) => i.kind === "tool")[0]?.result ?? "")).toContain("No chat with id");
  }, 240_000);

  it("an old conversation whose thread is not Claude Code's continues on it, with what was said handed over", async () => {
    // The world Carl asked for: Claude Code is the only engine, so there is no
    // router and no pi. His conversations from the pi days still carry a thread
    // id that is not Claude Code's, and he must be able to open one and keep
    // talking — nothing he had disappears.
    //
    // Nothing new is needed for that: Claude Code refuses a thread it never
    // started (threadUnknown), and the engine answers that by starting a fresh
    // thread and handing the earlier conversation over. This pins that pairing,
    // against the engine wired STRAIGHT to Claude Code, the way it will be.
    const convId = "cc-old-pi";
    await engine.message({ text: "earlier question KIWIWORD", convId });
    await answered(convId, "earlier question KIWIWORD");
    // As the pi days left it: a thread of pi's, which Claude Code knows nothing of.
    await patchMeta(vault, convId, { threadId: "t-oldpi-mw6r-zzzzz", threadPath: undefined });

    const { Engine } = await import("../engine/engine");
    const solo = new Engine({
      vault,
      backend: claude,
      ledger: { settle: async () => ({ calls: 0, usd: 0, missing: 0, byId: {} }), has: () => false } as any,
      jobEnv: { logDir: join(root, "jobs"), wrap: null, env: {} } as any,
      model: () => "haiku",
      webSearchModel: "x",
      apiKey: () => null,
      notify: async () => "sent",
      broadcast: () => {},
      log: () => {},
      vaultName: "vault-chat",
      turnLog: () => {},
    });
    solo.start();
    try {
      await solo.message({ text: "and now?", convId });
      await answered(convId, "and now?");
      // What the model was actually sent carries the earlier conversation.
      const sent = sentText();
      expect(sent).toContain("<earlier_conversation>");
      expect(sent).toContain("KIWIWORD");
      // And it is a Claude Code thread now, not the pi id it had.
      const after = (await readConv(vault, convId)).threadId as string;
      expect(isClaudeThread(after)).toBe(true);
      // The transcript Carl can read still holds both halves.
      expect(await shown(convId)).toEqual(expect.arrayContaining([["user", "earlier question KIWIWORD"], ["user", "and now?"]]));
    } finally {
      solo.stop();
    }
  }, 240_000);

  it("Delegate runs a real worker: its own Claude Code session, whose report comes back", async () => {
    // Carl's agent said "this engine has no workers of its own" and could not
    // delete a file. A worker is its own session in the same sandbox, with the
    // shell; it runs to one answer, and that answer is the report.
    let seen: string | null = null;
    const ended = claude.background("cc-no-such-parent", {
      agent: { name: "worker", systemPrompt: "You are a background worker. Do the task, then report." },
      task: "WORKER-TASK-7 please report back",
      title: "A test worker",
      model: "haiku",
    }, (id) => (seen = id));
    const r = (await ended) as { ok: boolean; state: string; text: string };
    expect(seen).toMatch(/^cc-worker-/);
    expect(r).toMatchObject({ ok: true, state: "done" });
    expect(r.text).toContain("WORKER-TASK-7");
    // Ended, so no longer a live child; its end is on record.
    expect(claude.liveChild(seen!)).toBeNull();
    expect(claude.endedChild(seen!)).toMatchObject({ state: "done" });
    // It was offered the shell, like its conversation.
    const tools: string[] = (api.requests.find((q: any) => JSON.stringify(q.messages).includes("WORKER-TASK-7"))?.tools ?? []).map((x: any) => x.name);
    expect(tools).toContain("Bash");
  }, 180_000);

  it("health names the engine, and the backend says which one it is", () => {
    const h = claude.health();
    expect(h).toMatchObject({ state: "up", source: expect.any(String), signedIn: expect.any(Boolean) });
    expect(claude.name).toBe("claude");
  });

  it("the health the clients actually read says Claude Code is there and signed in", () => {
    // The bug this pins, in the shape it has now: a client asks whether Claude
    // Code is signed in (Settings → Agent, and the one inline chat state). It
    // used to read that out of the router's `engines` record; with one engine
    // there is no record, and the reader must find it under the engine's own
    // name instead — or Carl is told to sign in while he is signed in. Read off
    // the REAL Engine.health(), never a hand-made object.
    const h = engine.health();
    expect(h.backend).toBe("claude");
    expect(h.claude).toMatchObject({ state: "up", signedIn: expect.any(Boolean) });
    // The one reader every client goes through takes this shape and the two the
    // router used to produce, so a client works against any box version.
    expect(claudeOf({ engine: h })).toMatchObject({ signedIn: expect.any(Boolean) });
    expect(defaultEngineOf({ engine: h })).toBe("claude");
    expect(claudeOf({ engine: { engines: { default: "claude", claude: { signedIn: true } } } })).toMatchObject({ signedIn: true });
    expect(claudeOf({ engine: { pi: { engines: { default: "claude", claude: { signedIn: true } } } } })).toMatchObject({ signedIn: true });
    // A box with no Claude Code at all: nothing to offer, and no crash.
    expect(claudeOf({ engine: { backend: "pi", pi: { state: "up" } } })).toBeNull();
    expect(claudeOf(null)).toBeNull();
  });
});
