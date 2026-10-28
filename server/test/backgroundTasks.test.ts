// Long work runs in the background, as Claude Code's background tasks do (Carl, 2026-10-26: "I both could not
// speak to the agent and didn't see it running"). The real bundle and engine, the fake pi (fakePiCli.mjs, which
// calls the host-owned `subagent` tool over MCP; the server starts each child as a
// sibling pi), a fake OpenRouter. A child's model calls are those whose first user message starts "Task:".
//   - Delegate starts a worker and the turn ENDS; a message while it works is answered at once;
//   - the worker's row moves from its own pi events (its latest tool and target, steps);
//   - its report comes back as exactly one new turn; two workers both report;
//   - JobSteer / JobStop reach a running worker (pi's own steer / abort on the child);
//   - a blocking `subagent` call that Carl talks over moves to the background (he is answered now);
//   - a restart of the server mid-job reports the lost worker instead of dropping it.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup, makeVault, makeKeyStore, startServer, waitFor, type Running } from "./helpers";
import { fakeChat, lastUser, lastToolResult, type FakeChat, type ChatStep } from "./fakeChat";

let home: string, vault: string, secrets: string;
let or: FakeChat;
let srv: Running;
/** Worker ids the parent's JobSteer / JobStop calls name (the test reads them off the rows). */
const ids: Record<string, string> = {};

const firstUser = (body: any): string => {
  const m = (body?.messages ?? []).find((x: any) => x?.role === "user");
  if (!m) return "";
  return typeof m.content === "string" ? m.content : (m.content ?? []).map((c: any) => c?.text ?? "").join("\n");
};
const isChild = (body: any) => firstUser(body).startsWith("Task:");
/** Tool results since the last user message (the step a model call is at). */
const stepOf = (body: any): number => {
  const ms: any[] = body?.messages ?? [];
  let n = 0;
  for (let i = ms.length - 1; i >= 0 && ms[i]?.role !== "user"; i--) if (ms[i]?.role === "tool") n++;
  return n;
};
const allText = (body: any): string => (body?.messages ?? []).map((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");

function respondChild(body: any): ChatStep {
  const task = firstUser(body);
  const k = stepOf(body);
  if (task.includes("CHILDWORK")) {
    if (k === 0) return { call: { name: "write", args: { path: "physics.html", content: "<html></html>" } }, delayMs: 1500 };
    if (k === 1) return { call: { name: "bash", args: { command: "node check-physics.js" } }, delayMs: 1500 };
    return { text: `## Completed\nbuilt physics.html and checked it (${task.includes("block") ? "block" : "bg"})`, delayMs: 1500 };
  }
  if (task.includes("CHILDSTEER")) {
    if (allText(body).includes("kiwi")) return { text: "child saw the kiwi steer" };
    return { call: { name: "bash", args: { command: "sleep 1" } }, delayMs: 800 };
  }
  if (task.includes("CHILDFOREVER")) return { call: { name: "bash", args: { command: "train --epochs 9" } }, delayMs: 800 };
  if (task.includes("CHILDQUICK")) return { text: `quick report ${/CHILDQUICK (\w+)/.exec(task)?.[1] ?? ""}`, delayMs: 1200 };
  return { text: "child default" };
}

function respondParent(body: any): ChatStep {
  const u = lastUser(body);
  const out = lastToolResult(body);
  const k = stepOf(body);
  // (A first turn after a restart sends the turn sections before the input: its own line is the one to quote.)
  if (u.includes("Delegated work")) return { text: `REPORTED ${u.split("\n").find((l) => l.startsWith("Delegated work"))}` };
  if (/interrupted|restart/i.test(u) && !u.includes("RESTARTJOB")) return { text: "resumed" };
  if (u.includes("BGLONG")) return out === null ? { call: { name: "Delegate", args: { title: "physics animation", task: "CHILDWORK build a guided physics animation" } } } : { text: "BGLONG started: on it" };
  if (u.includes("MIDJOB")) return { text: "MIDJOB four" };
  if (u.includes("STEERIT")) return out === null ? { call: { name: "Delegate", args: { title: "steerable", task: "CHILDSTEER keep going" } } } : { text: "STEERIT started" };
  if (u.includes("STEERNOW")) return out === null ? { call: { name: "JobSteer", args: { id: ids.steer, message: "kiwi please" } } } : { text: `STEERNOW: ${out}` };
  if (u.includes("STOPIT")) return out === null ? { call: { name: "Delegate", args: { title: "long training", task: "CHILDFOREVER s" } } } : { text: "STOPIT started" };
  if (u.includes("STOPNOW")) return out === null ? { call: { name: "JobStop", args: { id: ids.stop } } } : { text: `STOPNOW: ${out}` };
  if (u.includes("LISTNOW")) return out === null ? { call: { name: "JobList", args: {} } } : { text: `LISTNOW: ${out}` };
  if (u.includes("TWOJOBS")) {
    if (k === 0) return { call: { name: "Delegate", args: { title: "job alpha", task: "CHILDQUICK alpha" } } };
    if (k === 1) return { call: { name: "Delegate", args: { title: "job beta", task: "CHILDQUICK beta" } } };
    return { text: "TWOJOBS started both" };
  }
  if (u.includes("BLOCKSUB")) return out === null ? { call: { name: "subagent", args: { agent: "worker", task: "CHILDWORK block it" } } } : { text: `BLOCKSUB got: ${out.slice(0, 200)}` };
  if (u.includes("DETACHQ")) return { text: "DETACHQ answered at once" };
  if (u.includes("RESTARTJOB")) return out === null ? { call: { name: "Delegate", args: { title: "restart victim", task: "CHILDFOREVER r" } } } : { text: "RESTARTJOB started" };
  return { text: "hello" };
}

const boot = async () => {
  srv = await startServer({
    home,
    vault,
    secrets,
    openrouter: or.url,
    extra: { VC_ENGINE_MODEL: "test/fake-model", VC_PI_SUBAGENT_TIMEOUT_MS: "60000", VC_PI_SUBAGENT_GRACE_MS: "1500" },
  });
  await waitFor(async () => ((await (await fetch(srv.base + "/api/v1/health")).json()).engine?.pi?.state === "up" ? true : null), 60_000);
};
const post = (p: string, body: unknown) => fetch(srv.base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const conv = async (id: string): Promise<any> => {
  const r = await fetch(`${srv.base}/conversation?id=${encodeURIComponent(id)}&full=1&n=400`);
  if (!r.ok) throw new Error(`conversation ${id}: HTTP ${r.status}`);
  const d = await r.json();
  return { ...d.meta, messages: d.messages };
};
const said = (c: any, re: RegExp) => c.messages.some((m: any) => m.role === "assistant" && re.test(String(m.content)));
const says = (id: string, re: RegExp, ms = 60_000) => waitFor(async () => ((c) => (said(c, re) ? c : null))(await conv(id)), ms);
const count = (c: any, re: RegExp) => c.messages.filter((m: any) => re.test(String(m.content))).length;
const running = (c: any) => (c.subagents ?? []).filter((s: any) => s.state === "running");
const newConv = () => `bg${Math.random().toString(36).slice(2, 10)}`;
const turnOver = (c: any) => !c.running && c.state !== "running";

beforeAll(async () => {
  home = tmp("vcbg-");
  vault = makeVault(join(home, "vault"));
  secrets = await makeKeyStore(join(home, "secrets"), { "api.openrouter": "sk-or-canary-BG-not-real" });
  mkdirSync(join(home, "state"), { recursive: true });
  or = await fakeChat();
  or.respond = (body) => (isChild(body) ? respondChild(body) : respondParent(body));
  await boot();
}, 120_000);

afterAll(async () => {
  if (process.env.VC_TEST_LOGS) console.log(srv?.logs());
  await srv?.stop();
  await or?.close();
  cleanup(home);
});

describe("background tasks (Delegate) on the real engine", () => {
  it("a long job ends the turn at once; a message mid-job is answered right away; the row moves from the worker's own events; the result arrives once", async () => {
    const id = newConv();
    await post("/message", { convId: id, text: "BGLONG make me a guided physics animation" });
    // The turn is over with the worker still running.
    const c1 = await waitFor(async () => {
      const c = await conv(id);
      return said(c, /BGLONG started/) && turnOver(c) && running(c).length === 1 ? c : null;
    }, 30_000);
    expect(running(c1)[0]).toMatchObject({ title: "physics animation", background: true });
    // He talks to it while it works: answered at once (the worker is still running).
    await post("/message", { convId: id, text: "MIDJOB what's 2+2" });
    const c2 = await says(id, /MIDJOB four/, 15_000);
    expect(running(c2).length).toBe(1);
    // Its row moves: the latest tool and its target, from the worker's own pi events.
    const moving = await waitFor(async () => {
      const s = running(await conv(id))[0];
      return s?.activity === "running node check-physics.js" && s.steps >= 1 ? s : null;
    }, 20_000);
    expect(moving.activityAt).toBeGreaterThan(moving.startedAt);
    // The report: one new turn, and the agent's own message about it.
    const c3 = await says(id, /REPORTED Delegated work finished: "physics animation"/, 30_000);
    expect(c3.subagents[0]).toMatchObject({ state: "completed", steps: 2 });
    await new Promise((r) => setTimeout(r, 3000));
    const c4 = await conv(id);
    expect(count(c4, /REPORTED Delegated work finished/)).toBe(1);
    expect(c4.messages.filter((m: any) => m.role === "user" && /Delegated work finished/.test(String(m.content))).length).toBeLessThanOrEqual(1);
    // The parent model was given the report once.
    const reports = or.calls.filter((b) => !isChild(b) && lastUser(b).includes("Delegated work finished"));
    expect(reports.length).toBe(1);
    expect(lastUser(reports[0])).toContain("built physics.html and checked it (bg)");
  }, 120_000);

  it("JobList shows the running worker and what it is doing; JobSteer reaches it (pi's steer on the child)", async () => {
    const id = newConv();
    await post("/message", { convId: id, text: "STEERIT go" });
    const c = await waitFor(async () => {
      const x = await conv(id);
      return said(x, /STEERIT started/) && running(x).length === 1 && running(x)[0].steps >= 1 ? x : null;
    }, 30_000);
    ids.steer = running(c)[0].threadId;
    await post("/message", { convId: id, text: "LISTNOW what's running" });
    const l = await says(id, /LISTNOW:/, 15_000);
    const list = l.messages.filter((m: any) => m.role === "assistant" && /LISTNOW:/.test(m.content)).pop().content;
    expect(list).toContain(ids.steer);
    expect(list).toContain('"steerable"');
    expect(list).toMatch(/now running sleep 1/);
    await post("/message", { convId: id, text: "STEERNOW make it kiwi" });
    await says(id, /STEERNOW: Passed to worker/, 15_000);
    await says(id, /REPORTED Delegated work finished: "steerable"/, 30_000);
    const report = or.calls.filter((b) => !isChild(b) && lastUser(b).includes('"steerable"')).pop();
    expect(lastUser(report)).toContain("child saw the kiwi steer");
  }, 90_000);

  it("JobStop stops a running worker; its stopped turn arrives once", async () => {
    const id = newConv();
    await post("/message", { convId: id, text: "STOPIT train" });
    const c = await waitFor(async () => {
      const x = await conv(id);
      return said(x, /STOPIT started/) && running(x).length === 1 ? x : null;
    }, 30_000);
    ids.stop = running(c)[0].threadId;
    await post("/message", { convId: id, text: "STOPNOW stop it" });
    await says(id, /STOPNOW: Stopping worker/, 15_000);
    const done = await says(id, /REPORTED Delegated work failed \(stopped\): "long training"/, 30_000);
    expect(done.subagents.find((s: any) => s.threadId === ids.stop).state).toBe("stopped");
    await new Promise((r) => setTimeout(r, 2500));
    expect(count(await conv(id), /REPORTED Delegated work failed \(stopped\)/)).toBe(1);
  }, 90_000);

  it("two jobs at once both report, each once", async () => {
    const id = newConv();
    await post("/message", { convId: id, text: "TWOJOBS alpha and beta" });
    await says(id, /TWOJOBS started both/, 30_000);
    const c = await waitFor(async () => {
      const x = await conv(id);
      return said(x, /REPORTED Delegated work finished: "job alpha"/) && said(x, /REPORTED Delegated work finished: "job beta"/) ? x : null;
    }, 40_000);
    await new Promise((r) => setTimeout(r, 2500));
    const after = await conv(id);
    expect(count(after, /REPORTED Delegated work finished: "job alpha"/)).toBe(1);
    expect(count(after, /REPORTED Delegated work finished: "job beta"/)).toBe(1);
    expect(c.subagents.filter((s: any) => s.state === "completed").length).toBe(2);
  }, 90_000);

  it("a blocking subagent call that Carl talks over moves to the background: he is answered now, the report comes later, once", async () => {
    const id = newConv();
    await post("/message", { convId: id, text: "BLOCKSUB build it inline" });
    await waitFor(async () => (running(await conv(id)).length === 1 ? true : null), 20_000);
    const t0 = Date.now();
    await post("/message", { convId: id, text: "DETACHQ are you there?" });
    const c = await says(id, /DETACHQ answered at once/, 10_000);
    expect(Date.now() - t0).toBeLessThan(10_000);
    // Answered while the child still works; the parent's call said it moved to the background.
    expect(running(c).length).toBe(1);
    expect(running(c)[0].background).toBe(true);
    const moved = or.calls.find((b) => !isChild(b) && allText(b).includes("moved to the background"));
    expect(moved).toBeTruthy();
    await says(id, /REPORTED Delegated work finished: "CHILDWORK block it"/, 30_000);
    await new Promise((r) => setTimeout(r, 2500));
    const after = await conv(id);
    expect(count(after, /REPORTED Delegated work finished/)).toBe(1);
    // Never twice: no BLOCKSUB answer quoting the child's report (the call answered "moved", not the report).
    expect(said(after, /BLOCKSUB got: .*built physics\.html/)).toBe(false);
  }, 90_000);

  it("a restart of the server mid-job reports the lost worker (never silently dropped)", async () => {
    const id = newConv();
    await post("/message", { convId: id, text: "RESTARTJOB go" });
    await waitFor(async () => {
      const x = await conv(id);
      return said(x, /RESTARTJOB started/) && turnOver(x) && running(x).length === 1 ? true : null;
    }, 30_000);
    await srv.stop();
    await boot();
    const c = await says(id, /REPORTED Delegated work failed \(killed\): "restart victim"/, 60_000);
    expect(c.subagents.find((s: any) => s.title === "restart victim").state).toBe("killed");
    await new Promise((r) => setTimeout(r, 2500));
    expect(count(await conv(id), /REPORTED Delegated work failed \(killed\)/)).toBe(1);
  }, 150_000);
});
