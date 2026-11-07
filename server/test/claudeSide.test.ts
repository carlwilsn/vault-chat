// Ctrl+K, Ctrl+L and the box's one-shots on Claude Code. The model is a
// scripted stand-in (./claudeFakeApi.ts) so the answers are fixed; the CLI, the
// forking and the /api/v1/side shape are real.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup } from "./helpers";
import { fakeAnthropic, type FakeApi } from "./claudeFakeApi";
import { findClaude } from "../engine/claude/install";
import { ClaudeSideRuns, isClaudeSide } from "../engine/claude/side";
import type { Handlers, SideStart, ToolSpec } from "../engine/backend";
import { McpRuntime } from "../mcp/runtime";

const root = tmp("vccsd-");
let api: FakeApi;
let side: ClaudeSideRuns;
let handlers: Handlers | null = null;
const toolCalls: string[] = [];

const READ_ONLY: ToolSpec[] = [
  { type: "function", name: "ReadConversation", description: "Read another chat.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, readOnly: true },
];

beforeAll(async () => {
  const found = findClaude({ stateDir: root, env: {} });
  if ("error" in found) throw new Error(`${found.error}: ${found.tried.join("; ")}`);
  api = await fakeAnthropic();
  mkdirSync(join(root, "cwd"), { recursive: true });
  mkdirSync(join(root, "cfg"), { recursive: true });
  handlers = {
    toolCatalog: async () => READ_ONLY,
    toolCall: async () => ({ ok: false, text: "not here" }),
    userInput: async () => "",
    sideTool: async (convId, name) => {
      toolCalls.push(`${name}@${convId ?? "none"}`);
      return { ok: true, text: "the other chat says hello" };
    },
    you: async () => ({ text: "<you>Carl renamed a note.</you>", until: 1 }),
  };
  side = new ClaudeSideRuns({
    cli: () => found.install.cli,
    env: () => ({
      PATH: process.env.PATH ?? "",
      HOME: join(root, "cfg"),
      CLAUDE_CONFIG_DIR: join(root, "cfg"),
      ANTHROPIC_BASE_URL: api.url,
      ANTHROPIC_API_KEY: "sk-ant-not-a-real-key",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    }),
    handlers: () => handlers,
    // Its read-only tools reach the run over the host's own loopback MCP server.
    mcp: new McpRuntime(),
    sessionOf: () => null,
    fastModel: "haiku",
    log: () => {},
  });
});

afterAll(async () => {
  await api?.close();
  cleanup(root);
});

const base = (o: Partial<SideStart> = {}): SideStart => ({
  kind: "ask",
  cwd: join(root, "cwd"),
  model: "haiku",
  tools: [],
  sessionDir: join(root, "sessions"),
  text: "what does this say?",
  ...o,
});

describe("a side thread on Claude Code", () => {
  it("answers a question beside the conversation, through the shape /api/v1/side already speaks", async () => {
    const started = await side.start(base({ text: "SIDE-ONE: what does this say?" }));
    expect(isClaudeSide(started.id)).toBe(true);
    expect(started.done).toBe(false);

    const done = await side.wait(started.id);
    expect(done.id).toBe(started.id);
    expect(done.done).toBe(true);
    expect(done.error).toBeNull();
    expect(done.text).toContain("SIDE-ONE");
    // Nothing of the conversation's own transcript: a side thread keeps no file.
    expect(done.file).toBeNull();
  }, 180_000);

  it("its next question remembers what it just said", async () => {
    const first = await side.start(base({ text: "SIDE-TWO: first question" }));
    await side.wait(first.id);
    const next = await side.start(base({ side: first.id, text: "SIDE-TWO: and the follow-up" }));
    expect(next.id).toBe(first.id);
    const done = await side.wait(first.id);
    expect(done.text).toContain("follow-up");
    // The session was resumed, so the model was handed the earlier exchange.
    const sent = JSON.stringify(api.requests[api.requests.length - 1].messages);
    expect(sent).toContain("first question");
  }, 180_000);

  it("gets vault-chat's read-only tools, and the engine answers them as of the chat it was opened from", async () => {
    toolCalls.length = 0;
    const r = await side.start(base({ text: 'CALL mcp__vault_chat__ReadConversation {}', hostTools: READ_ONLY, you: { convId: "the-chat" } }));
    const done = await side.wait(r.id);
    expect(done.error).toBeNull();
    expect(toolCalls).toEqual(["ReadConversation@the-chat"]);
    // It was told what Carl did elsewhere, as of that chat.
    expect(JSON.stringify(api.requests[api.requests.length - 1].messages)).toContain("renamed a note");
  }, 180_000);

  it("a one-shot has its own prompt, no tools and nothing kept", async () => {
    const r = await side.start(base({ kind: "title", system: "You name notes. Answer with the title only.", ephemeral: true, text: "ONE-SHOT: name this note" }));
    const done = await side.wait(r.id);
    expect(done.error).toBeNull();
    expect(done.text).toContain("ONE-SHOT");
    // Its own prompt, not Claude Code's, and no tools offered.
    const last = api.requests[api.requests.length - 1];
    expect(JSON.stringify(last.system)).toContain("You name notes");
    expect((last.tools ?? []).filter((t: any) => String(t.name).startsWith("mcp__vault_chat__"))).toEqual([]);
    // Dropped as soon as the caller is done with it.
    side.forget(r.id);
    expect(await side.poll(r.id, -1, 0)).toBeNull();
  }, 180_000);

  it("polling waits for something new, and says when it is gone", async () => {
    expect(await side.poll("cc-side-not-a-run", -1, 0)).toBeNull();
    const r = await side.start(base({ text: "SIDE-POLL: hello" }));
    // Already past `after`: answers at once rather than holding.
    const now = Date.now();
    const s = await side.poll(r.id, -1, 20_000);
    expect(Date.now() - now).toBeLessThan(10_000);
    expect(s?.id).toBe(r.id);
    await side.wait(r.id);
  }, 180_000);

  it("health counts its runs", () => {
    expect(side.health()).toMatchObject({ runs: expect.any(Number), busy: expect.any(Number) });
  });
});
