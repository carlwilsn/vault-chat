// An update never loses running agent work. On 2026-11-17 22:28 the updater waited 2 h for six background workers
// (Agent-tool subagents of live chats), then stopped the old server: every Claude Code process exited 143 and the
// workers were gone with nothing said. Now the old server hands over with workers running: its shutdown saves them
// as a durable wake per chat (Engine.saveCutWork), and the next server, right after it takes over, takes each cut
// worker up in a FRESH work session (its ask in the ledger, what it was asked and what its transcript shows) and
// says so in one line in the chat, without a model turn there (reports/19-stateless: the old way, the chat
// resuming each worker by SendMessage, re-read the whole long chat and every worker's context cold).
//
// This runs the real thing: two real servers in the blue-green slots, the real Claude Code CLI against the scripted
// API, a real background worker in the middle of a long command when the old server goes.
import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup, makeVault, makeKeyStore, startServer, waitFor, freePort, type Running } from "./helpers";
import { fakeAnthropic, chatText, lastToolResult, type FakeApi } from "./claudeFakeApi";
import { cutShown, cutText } from "../engine/engine";
import { readLedger } from "../engine/ledger";

const UNIT = (port: number) => `/user.slice/user-1000.slice/user@1000.service/app.slice/vault-chat-server@${port}.service`;
const descendants = (pid: number): number[] => {
  const kids = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).stdout.split("\n").map(Number).filter((n) => n > 0);
  return kids.flatMap((k) => [k, ...descendants(k)]);
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const MARK = `vc-cut-worker-${process.pid}`;

/** The text of a request's first user message: whose request it is (the chat's, or the worker's own). */
const firstUser = (body: any): string => chatText({ messages: (body?.messages ?? []).filter((m: any) => m.role === "user").slice(0, 1) });

/** The request's history already holds a call of this tool (a retried or re-asked request never calls it twice). */
const called = (body: any, tool: string): boolean =>
  (body?.messages ?? []).some((m: any) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((b: any) => b?.type === "tool_use" && b.name === tool));

/** Every file under `dir` whose name matches. */
function find(dir: string, re: RegExp): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let names: import("node:fs").Dirent[] = [];
    try {
      names = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(d, n.name);
      if (n.isDirectory()) walk(p);
      else if (re.test(n.name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

describe("what the chat is told", () => {
  it("one line, and a resume per worker with what could not be resumed named", () => {
    const work = { workers: [{ id: "a1b2-c3", title: "Fix the updater" }], commands: [{ id: "b9", title: "npm run dev" }] };
    expect(cutShown(work)).toBe('The box restarted (an update) while background work ran: resuming 1 background worker ("Fix the updater"); 1 background command ended ("npm run dev")');
    const text = cutText(work);
    expect(text).toContain('SendMessage {to: "a1b2-c3", message: ');
    expect(text).toContain('"npm run dev"');
    expect(text).not.toContain("BoardMake");
  });
});

describe.skipIf(process.platform !== "linux")("a hand-over with a background worker running", () => {
  let home = "";
  const running: Running[] = [];
  let api: FakeApi | null = null;
  afterAll(async () => {
    for (const s of running) await s.stop().catch(() => {});
    await api?.close().catch(() => {});
    if (home) cleanup(home);
  });

  it("the old server hands over at once; the next one takes the worker up in a fresh work session, and the chat gets a line, no turn", async () => {
    home = tmp();
    const vault = makeVault(join(home, "vault"));
    const secrets = await makeKeyStore(join(home, "secrets"), { "service.claude-code": "sk-ant-oat01-canary-not-real" });
    mkdirSync(join(home, "state"), { recursive: true });
    api = await fakeAnthropic();
    let freshWith = "";
    let chatCallsAtRestart = -1;
    /** What the worker got back from its long step, when that ended before the hand-over (never expected). */
    let workerEarly = "";
    api.respond = (body) => {
      const mine = firstUser(body);
      const result = lastToolResult(body);
      if (chatText(body).includes("A fresh work session")) {
        freshWith = chatText(body);
        return { text: "Taken up: checked the branch, finished the step." };
      }
      if (mine.includes("WORKER-TASK")) {
        if (!called(body, "Bash")) return { toolCall: { name: "Bash", args: { command: `'${process.execPath}' -e 'setTimeout(() => {}, 600000)' ${MARK}`, description: "a long step", timeout: 600000 } } };
        workerEarly = result ?? chatText({ messages: body.messages.slice(-1) });
        return { text: "WORKER DONE early (never expected)." };
      }
      if (mine.includes("Start the slow worker") && !called(body, "Agent")) {
        return { toolCall: { name: "Agent", args: { description: "slow worker", prompt: "WORKER-TASK: run the long step, then report.", subagent_type: "general-purpose", run_in_background: true } } };
      }
      return { text: "Started it." };
    };
    // The chat's own requests (a fresh session's "you" layer also names Carl's message, so it is told apart by its brief).
    const chatCalls = () => api!.calls.filter((c) => firstUser(c).includes("Start the slow worker") && !chatText(c).includes("A fresh work session")).length;

    // Slot A serves, as the unit's own server (systemd started it, on its own port): its hand-over ends its unit's
    // processes, Claude Code and the worker's command with them, exactly as on the box.
    const [pub, pa, pb] = [await freePort(), await freePort(), await freePort()];
    const fs = join(home, "cgroup");
    mkdirSync(join(fs, UNIT(pa)), { recursive: true });
    const selfCgroup = join(home, "self-cgroup");
    writeFileSync(selfCgroup, `0::${UNIT(pa)}\n`);
    const slot = (port: number, own: boolean) => ({
      home,
      vault,
      secrets,
      anthropic: api!.url,
      extra: {
        VC_PORT: String(pub),
        VC_BACKEND_PORT: String(port),
        ...(own ? { VC_TEST_CGROUP_FS: fs, VC_TEST_SELF_CGROUP: selfCgroup, VC_TEST_PARENT_COMM: "systemd" } : {}),
      },
    });
    const a = await startServer(slot(pa, true));
    running.push(a);
    const A = `http://127.0.0.1:${pa}`;

    const sent = await (await fetch(A + "/message", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Start the slow worker." }) })).json();
    expect(sent.ok).toBe(true);
    // The chat's turn ends; its worker runs on, in the middle of its long command.
    let sleeper = 0;
    await waitFor(async () => {
      const h = await (await fetch(A + "/api/v1/health")).json();
      sleeper = Number(spawnSync("pgrep", ["-f", `setTimeout.*${MARK}`], { encoding: "utf8" }).stdout.split("\n").find((p) => p && descendants(a.proc.pid!).includes(Number(p))) ?? 0);
      return h.busy.runs === 0 && h.busy.workers > 0 && h.busy.resumesWork === true && sleeper > 0;
    }, 90_000, 200).catch(async (e) => {
      throw new Error(`${e.message}\n${a.logs().slice(-4000)}\nworker's step ended early: ${workerEarly.slice(0, 1500)}\n${api!.calls.length} calls; last: ${JSON.stringify(api!.calls.slice(-4).map((c) => [firstUser(c).slice(-120), chatText({ messages: c.messages.slice(-1) }).slice(0, 600)]))}`);
    });

    // The next server stands by; the old one is asked to hand over and does at once, worker and all.
    const nextP = startServer(slot(pb, false));
    await waitFor(() => existsSync(join(home, "state", "standby")), 60_000, 50);
    writeFileSync(join(fs, UNIT(pa), "cgroup.procs"), [a.proc.pid!, ...descendants(a.proc.pid!)].join("\n") + "\n");
    a.proc.kill("SIGUSR2");
    expect(await a.exited).toBe(0);
    expect(a.logs()).not.toContain("hand-over declined");
    expect(a.logs()).toMatch(/1 background task\(s\) running: saved for the next server to resume/);
    await waitFor(() => !alive(sleeper), 5000, 50);
    const b = await nextP;
    running.push(b);
    expect(b.logs()).toContain("[owner] took over");

    chatCallsAtRestart = chatCalls();
    // Right after it takes over, B takes the worker up in a fresh session: what it was asked, from its transcript.
    await waitFor(() => !!freshWith, 90_000, 200).catch((e) => {
      throw new Error(`${e.message}\n${b.logs().slice(-4000)}`);
    });
    expect(freshWith).toContain('cut the background worker "slow worker"');
    expect(freshWith).toContain("WORKER-TASK: run the long step");
    expect(freshWith).toContain(`Its last tool call: Bash`);
    // The ledger holds the ask; the chat got one line and no model turn.
    const ledger = readLedger(join(home, "state", "work", "work.jsonl"));
    expect(ledger).toEqual([expect.objectContaining({ words: "slow worker", origin: expect.objectContaining({ conv: "main" }), sessions: ["work-slow-worker-1"] })]);
    expect(b.logs()).toMatch(/wake w-[\w-]+ → main: The box restarted \(an update\) while background work ran/);
    expect(b.logs()).toMatch(/cut work of main: 1 fresh session\(s\) work-slow-worker-1/);
    expect(a.logs()).toMatch(/1 background task\(s\) of main ended with their process: wake w-[\w-]+ takes them up/);
    await new Promise((r) => setTimeout(r, 1500));
    expect(chatCalls()).toBe(chatCallsAtRestart);
  }, 240_000);
});
