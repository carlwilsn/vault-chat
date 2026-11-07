// The real Claude Code CLI, driven the way the box will drive it: one warm
// session per conversation, with vault-chat's four controls mapped onto the
// SDK's streaming input. The model is a scripted stand-in (./claudeFakeApi.ts)
// so the replies are fixed and nothing leaves the box; everything about what
// the CLI does is genuine.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { tmp, cleanup } from "./helpers";
import { fakeAnthropic, type FakeApi } from "./claudeFakeApi";
import { ClaudeSession } from "../engine/claude/session";
import { findClaude } from "../engine/claude/install";

const root = tmp("vccs-");
let api: FakeApi;
let cli: string;

/** A tool that blocks until the test lets it go: the window a steer lands in. */
let release: (() => void) | null = null;
let blocking: Promise<void> | null = null;
const blocker = () =>
  createSdkMcpServer({
    name: "vault_chat",
    version: "1.0.0",
    tools: [
      tool("block", "Wait until the host releases it", {}, async () => {
        blocking = new Promise<void>((r) => (release = r));
        await blocking;
        return { content: [{ type: "text" as const, text: "released" }] };
      }),
      // A call long enough to be stopped, the way the spike measured interrupt().
      tool("slow", "Take a long time", {}, async () => {
        await new Promise((r) => setTimeout(r, 20_000));
        return { content: [{ type: "text" as const, text: "finished anyway" }] };
      }),
    ],
  });

beforeAll(async () => {
  const found = findClaude({ stateDir: root, env: {} });
  if ("error" in found) throw new Error(`${found.error}: ${found.tried.join("; ")}`);
  cli = found.install.cli;
  api = await fakeAnthropic();
});

afterAll(async () => {
  await api?.close();
  cleanup(root);
});

type Run = { session: ClaudeSession; messages: any[]; results: any[]; waitForResult: (n: number) => Promise<void>; waitForReply: (text: string) => Promise<void> };

function open(o: { cwd: string; configDir: string; resume?: string; mcp?: boolean } ): Run {
  const messages: any[] = [];
  const results: any[] = [];
  const session = new ClaudeSession({
    cli,
    cwd: o.cwd,
    model: "haiku",
    configDir: o.configDir,
    ...(o.resume ? { resume: o.resume } : {}),
    ...(o.mcp ? { mcpServers: { vault_chat: blocker() }, allowedTools: ["mcp__vault_chat__block"] } : {}),
    env: {
      PATH: process.env.PATH ?? "",
      HOME: o.configDir,
      CLAUDE_CONFIG_DIR: o.configDir,
      ANTHROPIC_BASE_URL: api.url,
      ANTHROPIC_API_KEY: "sk-ant-not-a-real-key",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    },
    onMessage: (m: any) => {
      messages.push(m);
      if (m.type === "result") results.push(m);
    },
    onClosed: () => {},
  });
  session.start();
  const waitForResult = async (n: number) => {
    const t0 = Date.now();
    while (results.length < n) {
      if (Date.now() - t0 > 90_000) throw new Error(`timed out waiting for result ${n} (have ${results.length})`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  const waitForReply = async (text: string) => {
    const t0 = Date.now();
    while (!results.some((x) => String(x.result ?? "").includes(text))) {
      if (Date.now() - t0 > 90_000) throw new Error(`timed out waiting for a reply containing ${JSON.stringify(text)}; got ${JSON.stringify(results.map((x) => String(x.result ?? "")))}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  return { session, messages, results, waitForResult, waitForReply };
}

const replies = (r: Run) => r.results.map((x) => String(x.result ?? ""));

describe("one warm Claude Code session per conversation", () => {
  it("answers message after message on the same session, and resumes it by id", async () => {
    const cwd = join(root, "warm");
    const cfg = join(root, "warm-cfg");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(cfg, { recursive: true });
    const run = open({ cwd, configDir: cfg });

    run.session.send({ text: "first question" });
    await run.waitForResult(1);
    const id = run.session.sessionId;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    // The session is still up: the next message does not start a process.
    const t0 = Date.now();
    run.session.send({ text: "second question" });
    await run.waitForResult(2);
    const warmMs = Date.now() - t0;
    expect(replies(run)[1]).toContain("second question");
    expect(run.results.every((x) => x.session_id === id)).toBe(true);
    run.session.close();
    await run.session.finished();

    // Resumed by that id, the history is there: the CLI sends the earlier turns again.
    const again = open({ cwd, configDir: cfg, resume: id! });
    again.session.send({ text: "third question" });
    await again.waitForResult(1);
    expect(again.session.sessionId).toBe(id);
    const sent = api.requests[api.requests.length - 1].messages.map((m: any) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((b: any) => b.text ?? "").join("")));
    expect(sent.join("\n")).toContain("first question");
    expect(sent.join("\n")).toContain("third question");
    again.session.close();
    await again.session.finished();
    // A warm turn is far cheaper than a cold start; it is never the slower path.
    expect(warmMs).toBeLessThan(90_000);
  }, 180_000);

  it("steer folds into the running turn, queue runs as its own, take back withdraws it, stop ends it", async () => {
    const cwd = join(root, "ctl");
    const cfg = join(root, "ctl-cfg");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(cfg, { recursive: true });
    const run = open({ cwd, configDir: cfg, mcp: true });
    release = null;

    // A turn that stops inside a tool, so there is a window to talk into.
    run.session.send({ text: 'CALL mcp__vault_chat__block {}' });
    const t0 = Date.now();
    while (!release) {
      if (Date.now() - t0 > 90_000) throw new Error("the blocking tool was never reached");
      await new Promise((r) => setTimeout(r, 25));
    }

    // A steer: no priority, so it is folded into the turn that is running.
    run.session.send({ text: "STEER-TEXT" });
    // A follow-up: its own next turn.
    run.session.send({ text: "QUEUED-KEPT", priority: "later" });
    // One more, then taken back before it is delivered.
    const dropped = randomUUID();
    run.session.send({ text: "QUEUED-WITHDRAWN", uuid: dropped, priority: "later" });
    expect(await run.session.withdraw(dropped)).toBe(true);

    release!();
    await run.waitForResult(2);
    const all = JSON.stringify(api.requests);
    // The steer reached the model inside the first turn, not as a turn of its own.
    expect(all).toContain("STEER-TEXT");
    expect(all).toContain("QUEUED-KEPT");
    // The withdrawn one never reached the model.
    expect(all).not.toContain("QUEUED-WITHDRAWN");
    expect(replies(run)[1]).toContain("QUEUED-KEPT");

    // Stop: a turn sitting in a long tool call is cut short, and the session still takes input.
    const before = run.results.length;
    run.session.send({ text: 'CALL mcp__vault_chat__slow {}' });
    await new Promise((r) => setTimeout(r, 2_000));
    const t1 = Date.now();
    await run.session.interrupt();
    // interrupt() answers at once; the spike measured ~5 ms.
    expect(Date.now() - t1).toBeLessThan(10_000);
    await run.waitForResult(before + 1);
    // The tool never finished, so the turn carries no answer from it.
    expect(String(run.results[before].result ?? "")).not.toContain("finished anyway");
    // The session is still up and still takes input.
    expect(run.session.closed).toBe(false);
    run.session.send({ text: "after the stop" });
    await run.waitForReply("after the stop");
    run.session.close();
    await run.session.finished();
  }, 240_000);

  it("no Claude Code built-in is on: only vault-chat's own tools are there", async () => {
    const cwd = join(root, "tools");
    const cfg = join(root, "tools-cfg");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(cfg, { recursive: true });
    const run = open({ cwd, configDir: cfg, mcp: true });
    run.session.send({ text: "what can you do" });
    await run.waitForResult(1);
    const init = run.messages.find((m) => m.type === "system" && m.subtype === "init");
    // Not just Read/Write/Edit/Bash: Glob, Grep and WebFetch read the box too,
    // and vault-chat has one path policy, enforced only by its own tools.
    expect(init.tools.filter((t: string) => !t.startsWith("mcp__vault_chat__"))).toEqual([]);
    expect(init.tools).toContain("mcp__vault_chat__block");
    // Carl's own plugins and skills are not in vault-chat's sessions.
    expect(init.mcp_servers.map((s: any) => s.name)).toEqual(["vault_chat"]);
    run.session.close();
    await run.session.finished();
  }, 180_000);
});
