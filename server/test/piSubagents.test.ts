// Subagents on the pi engine, end to end: real pi 1.1.0 parents and children
// (VC_TEST_PI_DIR), a fake chat-completions OpenRouter. A child's requests are
// the ones whose first user message starts with "Task:"; parents and children
// are keyed by marker words.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup, makeVault, makeKeyStore, startServer, waitFor, type Running } from "./helpers";
import { fakeChat, lastUser, lastToolResult, CHAT_COST, type FakeChat, type ChatStep } from "./fakeChat";

const PI_DIR = process.env.VC_TEST_PI_DIR;
const CANARY = "sk-or-canary-SUBAGENTS-not-real";
const PASS = "test-passphrase-not-a-secret";
const linux = process.platform === "linux";

const firstUser = (body: any): string => {
  const m = (body?.messages ?? []).find((x: any) => x?.role === "user");
  if (!m) return "";
  return typeof m.content === "string" ? m.content : (m.content ?? []).map((c: any) => c?.text ?? "").join("\n");
};
const toolNames = (body: any): string[] => (body?.tools ?? []).map((t: any) => t.function?.name);
const isChild = (body: any) => firstUser(body).startsWith("Task:");

describe.skipIf(!PI_DIR)("pi subagents (real pi children, fake OpenRouter)", () => {
  let home: string, vault: string, secrets: string, state: string;
  let or: FakeChat;
  let srv: Running;

  const respondChild = (body: any): ChatStep => {
    const task = firstUser(body);
    const out = lastToolResult(body);
    const user = lastUser(body);
    // Whole-word markers (CHILDC must not match CHILDCRASH).
    const has = (w: string) => task.split(/[^A-Z]+/).includes(w);
    if (has("CHILDA")) return { text: "child A reporting", delayMs: 1500 };
    if (has("CHILDB")) return { text: "child B reporting", delayMs: 1500 };
    if (has("CHILDC")) return { text: `C got: ${task.replace(/^Task: /, "")}` };
    if (has("CHILDSLOW")) {
      if (user.includes("kiwi steer")) return { text: "child saw the kiwi steer" };
      return out === null ? { call: { name: "bash", args: { command: "sleep 6; echo slowdone" } } } : { text: "child slow done" };
    }
    if (has("CHILDLONG")) return out === null ? { call: { name: "bash", args: { command: "sleep 60; echo late" } } } : { text: "child long done" };
    if (has("CHILDCRASH")) return out === null ? { call: { name: "bash", args: { command: "sleep 8; echo survived > child-crash.txt" } } } : { text: "child crash done" };
    if (has("CHILDKEY")) {
      if (out !== null) return { text: `KEYOUT ${out}` };
      return {
        call: {
          name: "bash",
          args: {
            command:
              "echo ENV=$(env | grep -c -e ^OPENROUTER -e API_KEY -e sk-or-); " +
              `echo STORE=$(cat ${secrets}/fallback.key ${secrets}/secrets.age 2>/dev/null | wc -c); ` +
              "echo PROCENV=$(cat /proc/*/environ 2>/dev/null | tr '\\0' '\\n' | grep -c canary); " +
              "echo SYSTEMD=$(systemd-run --user --quiet true 2>&1 >/dev/null; echo rc=$?); echo END-KEY",
          },
        },
      };
    }
    if (has("CHILDASK")) return out === null ? { call: { name: "AskUser", args: { question: "may I?" } } } : { text: `asked: ${out}` };
    return { text: "child default" };
  };

  const parentCalls: Record<string, unknown> = {
    SUB1: { agent: "worker", task: "CHILDA say hello" },
    SUB2: { tasks: [{ agent: "worker", task: "CHILDA part one" }, { agent: "worker", task: "CHILDB part two" }] },
    SUB3: { chain: [{ agent: "worker", task: "CHILDA first" }, { agent: "worker", task: "CHILDC with {previous}" }] },
    SUBSTEER: { agent: "worker", task: "CHILDSLOW take your time" },
    SUBSTOP: { agent: "worker", task: "CHILDLONG run long" },
    SUBTIMEOUT: { agent: "worker", task: "CHILDLONG run past the limit" },
    SUBCRASH: { agent: "worker", task: "CHILDCRASH and write" },
    SUBKEY: { agent: "worker", task: "CHILDKEY look around" },
    SUBASK: { agent: "worker", task: "CHILDASK try asking" },
    SUBMANY: { tasks: Array.from({ length: 9 }, (_, i) => ({ agent: "worker", task: `CHILDA n${i}` })) },
  };

  const respondParent = (body: any): ChatStep => {
    const user = lastUser(body);
    if (user.includes("box restarted")) return { text: "resumed after the crash" };
    const all = (body.messages ?? []).map((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
    const key = Object.keys(parentCalls).filter((k) => all.includes(k)).sort((a, b) => all.lastIndexOf(b) - all.lastIndexOf(a))[0];
    if (!key) return { text: "hello from the parent" };
    const out = lastToolResult(body);
    if (out === null) return { call: { name: "subagent", args: parentCalls[key] } };
    return { text: `${key} done: ${out.slice(0, 400)}` };
  };

  const boot = async () => {
    srv = await startServer({
      home,
      vault,
      secrets,
      openrouter: or.url,
      extra: { VC_ENGINE: "pi", VC_PI_DIR: PI_DIR!, VC_ENGINE_MODEL: "test/fake-model", VC_STATE_DIR: state, VC_PI_SUBAGENT_TIMEOUT_MS: "15000", VC_PI_SUBAGENT_GRACE_MS: "2000" },
    });
    await waitFor(async () => ((await (await fetch(srv.base + "/api/v1/health")).json()).engine?.pi?.state === "up" ? true : null), 60_000);
  };
  const post = (p: string, body: unknown) => fetch(srv.base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  const conv = (id: string) => {
    const lines = readFileSync(join(vault, ".vault-chat", "conversations", `${id}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const metas = lines.filter((l) => "id" in l);
    return { ...metas[metas.length - 1], messages: lines.filter((l) => "role" in l) };
  };
  const says = (id: string, re: RegExp, ms = 60_000) =>
    waitFor(() => {
      const c = conv(id);
      return c.messages.some((m: any) => m.role === "assistant" && re.test(String(m.content))) ? c : null;
    }, ms);
  const runningChild = (id: string) =>
    waitFor(() => {
      const c = conv(id);
      return (c.subagents ?? []).find((s: any) => s.state === "running") ?? null;
    }, 30_000);
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  beforeAll(async () => {
    home = tmp("vcsub-");
    vault = makeVault(join(home, "vault"));
    secrets = await makeKeyStore(join(home, "secrets"), { "api.openrouter": CANARY });
    state = join(home, "state");
    mkdirSync(state, { recursive: true });
    or = await fakeChat();
    or.respond = (body) => (isChild(body) ? respondChild(body) : respondParent(body));
    await boot();
  });

  afterAll(async () => {
    if (process.env.VC_TEST_LOGS) console.log(srv?.logs());
    await srv?.stop();
    await or?.close();
    cleanup(home);
  });

  it("single: the parent delegates, gets the report, and the child is on the meta with its cost", async () => {
    const r = await post("/message", { text: "SUB1 delegate one thing" });
    await says(r.convId, /SUB1 done: child A reporting/);
    const c = await waitFor(() => {
      const x = conv(r.convId);
      return x.costUsd >= CHAT_COST * 3 - 1e-9 && x.subagents?.[0]?.state === "completed" ? x : null;
    }, 30_000);
    const s = c.subagents[0];
    expect(s).toMatchObject({ agent: "worker", model: "test/fake-model", state: "completed" });
    expect(s.task).toContain("CHILDA");
    expect(s.costUsd).toBeCloseTo(CHAT_COST, 6);
    expect(s.endedAt).toBeGreaterThanOrEqual(s.startedAt);
    // The child's session is persisted in its own dir under the parent's.
    expect(s.sessionFile).toContain(join("sessions", "sub", c.threadId));
    expect(existsSync(s.sessionFile)).toBe(true);
    // Parent: 2 calls; child: 1 — all on the parent conversation's ledger.
    expect(c.costUsd).toBeCloseTo(CHAT_COST * 3, 6);
    const a = c.messages.find((m: any) => m.role === "assistant");
    expect(a.toolCalls.map((t: any) => t.name)).toContain("subagent");
  });

  it("parallel: two children run at once and both results come back", async () => {
    const r = await post("/message", { text: "SUB2 two at once" });
    const c = await says(r.convId, /SUB2 done: Parallel: 2\/2 succeeded/);
    const reply = c.messages.filter((m: any) => m.role === "assistant").pop().content;
    expect(reply).toContain("child A reporting");
    expect(reply).toContain("child B reporting");
    const subs = (await waitFor(() => (conv(r.convId).subagents?.length === 2 ? conv(r.convId) : null), 10_000)).subagents;
    // Overlap: the second started before the first ended (each child answers after 1.5 s).
    const [x, y] = subs.sort((p: any, q: any) => p.startedAt - q.startedAt);
    expect(y.startedAt).toBeLessThan(x.endedAt ?? Date.now());
  });

  it("chain: the second child gets the first one's output", async () => {
    const r = await post("/message", { text: "SUB3 one after the other" });
    await says(r.convId, /SUB3 done: C got: CHILDC with child A reporting/);
  });

  it("children get file/shell + Done/Notify, never AskUser or subagent; an AskUser attempt fails", async () => {
    const child = or.calls.find((b) => isChild(b));
    const names = toolNames(child);
    for (const t of ["bash", "read", "write", "edit", "Done", "Notify"]) expect(names).toContain(t);
    for (const t of ["AskUser", "subagent", "ScheduleWake", "KeepWorking", "Blocked", "StartJob"]) expect(names).not.toContain(t);
    const parent = or.calls.find((b) => !isChild(b) && lastUser(b).includes("SUB1"));
    expect(toolNames(parent)).toContain("subagent");
    const r = await post("/message", { text: "SUBASK try it" });
    const c = await says(r.convId, /SUBASK done:/);
    expect(c.state).not.toBe("waiting_user");
    expect(c.pendingAsk).toBeUndefined();
    expect(c.messages.filter((m: any) => m.role === "assistant").pop().content).toMatch(/AskUser|not found|Tool|tool/);
  });

  it("too many tasks in one call is refused (8 per call)", async () => {
    const r = await post("/message", { text: "SUBMANY nine" });
    await says(r.convId, /SUBMANY done: Too many parallel tasks \(9\)\. Max is 8\./);
  });

  it.skipIf(!linux)("the key is out of reach inside a child too", async () => {
    const r = await post("/message", { text: "SUBKEY probe in a child" });
    const c = await says(r.convId, /SUBKEY done:/);
    const o: string = c.messages.filter((m: any) => m.role === "assistant").pop().content;
    expect(o).toContain("END-KEY");
    expect(o).not.toContain(CANARY);
    expect(o).not.toContain(PASS);
    const line = (k: string) => o.split("\n").find((l) => l.startsWith(`${k}=`) || l.includes(` ${k}=`));
    expect(o).toMatch(/ENV=0\b/);
    expect(o).toMatch(/STORE=0\b/);
    expect(o).toMatch(/PROCENV=0\b/);
    expect(line("SYSTEMD") ?? o).toMatch(/rc=[1-9]/);
  });

  it("steer a running child through the host API", async () => {
    const r = await post("/message", { text: "SUBSTEER a slow child" });
    const s = await runningChild(r.convId);
    await waitFor(() => or.calls.some((b) => isChild(b) && firstUser(b).includes("CHILDSLOW")) || null, 20_000);
    const out = await post(`/api/v1/conversations/${r.convId}/subagents/${s.threadId}/steer`, { text: "kiwi steer: mention kiwi" });
    expect(out.ok).toBe(true);
    await says(r.convId, /SUBSTEER done: child saw the kiwi steer/, 60_000);
    const bad = await post(`/api/v1/conversations/${r.convId}/subagents/nope/steer`, { text: "x" });
    expect(bad.ok).toBe(false);
  });

  it("stop a running child through the host API; the parent gets a stopped result", async () => {
    const r = await post("/message", { text: "SUBSTOP a long child" });
    const s = await runningChild(r.convId);
    await waitFor(() => or.calls.some((b) => isChild(b) && firstUser(b).includes("CHILDLONG run long")) || null, 20_000);
    await new Promise((res) => setTimeout(res, 1000));
    const t0 = Date.now();
    const out = await post(`/api/v1/conversations/${r.convId}/subagents/${s.threadId}/stop`, {});
    expect(out.ok).toBe(true);
    await says(r.convId, /SUBSTOP done: .*stopped/s, 30_000);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(conv(r.convId).subagents[0].state).toBe("stopped");
  });

  it("a child past its wall-clock limit is stopped (timeout)", async () => {
    const r = await post("/message", { text: "SUBTIMEOUT a child that won't finish" });
    await says(r.convId, /SUBTIMEOUT done: .*ran out of time/s, 60_000);
    expect(conv(r.convId).subagents[0].state).toBe("timeout");
  });

  it("kill -9 the parent mid-child: the child's whole tree dies with it, the parent resumes", async () => {
    const r = await post("/message", { text: "SUBCRASH crash the parent" });
    const s = await runningChild(r.convId);
    await waitFor(() => or.calls.some((b) => isChild(b) && firstUser(b).includes("CHILDCRASH")) || null, 20_000);
    await new Promise((res) => setTimeout(res, 1000));
    const h = await (await fetch(srv.base + "/api/v1/health")).json();
    const childPid = h.engine.pi.subagents.children.find((x: any) => x.id === s.threadId)?.pid;
    const parentPid = h.engine.pi.procs.find((x: any) => x.threadId === conv(r.convId).threadId)?.pid;
    expect(childPid).toBeTruthy();
    expect(parentPid).toBeTruthy();
    process.kill(parentPid, "SIGKILL");
    await waitFor(() => (!alive(childPid) ? true : null), 10_000);
    await says(r.convId, /resumed after the crash/, 60_000);
    await new Promise((res) => setTimeout(res, 9000)); // the child's command would have written at 8 s
    expect(existsSync(join(vault, "child-crash.txt"))).toBe(false);
    expect(conv(r.convId).subagents[0].state).toBe("killed");
  });

  it("/api/v1/models reports subagents on where tools work", async () => {
    const { models } = await (await fetch(srv.base + "/api/v1/models")).json();
    expect(models.find((m: any) => m.id === "test/fake-model").capabilities.subagents).toBe(true);
  });
});
