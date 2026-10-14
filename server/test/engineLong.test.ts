// Long runs, in process on a fake pi: Done gated by a check the agent cannot
// edit, budget caps, the progress metric and its plateau alert, job control,
// the task queue with fresh worker sessions, worktrees per worker, model tiering.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup } from "./helpers";
import { inputText } from "../context/test/helpers";
import { makeRig, until, type Rig } from "./longRig";

let rig: Rig;
let verifierSaw: string[] = [];

beforeAll(async () => {
  rig = await makeRig({
    verifier: (req) => {
      verifierSaw.push(inputText(req));
      return { text: '{"verdict":"pass","notes":["checked"]}' };
    },
  });
});

afterAll(async () => {
  rig?.engine?.stop();
  await rig?.verifier.close();
  cleanup(rig?.root);
});

const out = (r: any) => String(r?.text ?? "");

/** A project with a check script in the vault, declared in project.md's "Done when". */
async function projectWithCheck(name: string, script: string, block?: string): Promise<{ convId: string; tid: string; slug: string }> {
  const s = await rig.start(`Work on ${name} and keep going.`);
  const r = await rig.backend.call(s.tid, "SetProject", { name });
  expect(r.ok).toBe(true);
  const slug = name.toLowerCase();
  writeFileSync(join(rig.vault, `${slug}-check.js`), script);
  const pmd = join(rig.vault, ".vault-chat", "projects", slug, "project.md");
  const cur = readFileSync(pmd, "utf8");
  writeFileSync(pmd, cur.replace("(not decided yet)", `All functions match.\n\n\`\`\`sh\n${block ?? `node ${slug}-check.js`}\n\`\`\`\n\n# a comment line in the section is fine`));
  await rig.backend.call(s.tid, "KeepWorking", { on: true });
  return { ...s, slug };
}

describe("1. Done is gated by an executable check the agent cannot edit", () => {
  it("a passing check: Done goes through, and the verifier reads the server's own check output", async () => {
    verifierSaw = [];
    const p = await projectWithCheck("Alpha", `console.log("matched 412/412 functions CHECKMARK-7731"); process.exit(0);`);
    const r = await rig.backend.call(p.tid, "Done", { summary: "All 412 functions match.", evidence: ["ran the check"] });
    expect(r.ok).toBe(true);
    expect(out(r)).toMatch(/check passed/);
    rig.backend.end(p.tid);
    await until(async () => (await rig.readConv(p.convId))?.state === "done");
    const c = await rig.readConv(p.convId);
    expect(c.working).toBe(false);
    expect(c.verdict.verdict).toBe("pass");
    expect(c.long.lastCheck.ok).toBe(true);
    // The verifier was given the check's real output (not the agent's quote), and where its log is.
    expect(verifierSaw.join("\n")).toMatch(/CHECKMARK-7731/);
    expect(verifierSaw.join("\n")).toMatch(/run by the server itself/);
    expect(readFileSync(join(rig.vault, ".vault-chat", "local", "projects", "alpha", "check-last.log"), "utf8")).toMatch(/CHECKMARK-7731/);
  });

  it("a failing check refuses Done: keep-going stays on, the agent gets the output tail, the turn is nudged on", async () => {
    const p = await projectWithCheck("Beta", `console.log("matched 300/412 functions"); console.error("mismatch in fn_8001c0"); process.exit(1);`);
    const turns = rig.backend.turns.length;
    const r = await rig.backend.call(p.tid, "Done", { summary: "All done.", evidence: [] });
    expect(r.ok).toBe(false);
    expect(out(r)).toMatch(/Done refused: the project's check failed \(exit 1\)/);
    expect(out(r)).toMatch(/mismatch in fn_8001c0/);
    rig.backend.end(p.tid);
    // Not done: still keep-going, so the unended turn gets the nudge turn.
    await until(() => rig.backend.turns.length === turns + 1);
    const c = await rig.readConv(p.convId);
    expect(c.state).not.toBe("done");
    expect(c.working).toBe(true);
    expect(c.long.lastCheck.ok).toBe(false);
    expect(c.verdict).toBeUndefined();
    expect(rig.pings.some((x) => x.convId === p.convId && /^Done:/.test(x.title))).toBe(false);
    rig.backend.end(p.tid);
  });

  it("a script edited after the check was set (or the command in project.md) refuses Done without running it; only Carl can re-set it", async () => {
    const p = await projectWithCheck("Gamma", `console.log("ok"); process.exit(0);`);
    // First sight pins it (the agent's own SetCheck is refused from now on).
    const sc = await rig.backend.call(p.tid, "SetCheck", { command: "node -e \"process.exit(0)\"" });
    expect(sc.ok).toBe(false);
    expect(out(sc)).toMatch(/Only Carl can change it/);
    // The agent "fixes" the oracle instead of the work.
    writeFileSync(join(rig.vault, "gamma-check.js"), `console.log("ok, trust me"); process.exit(0);`);
    const r = await rig.backend.call(p.tid, "Done", { summary: "Done.", evidence: [] });
    expect(r.ok).toBe(false);
    expect(out(r)).toMatch(/gamma-check\.js changed since the check was set/);
    // Put the script back but swap the command in project.md: refused too.
    writeFileSync(join(rig.vault, "gamma-check.js"), `console.log("ok"); process.exit(0);`);
    const pmd = join(rig.vault, ".vault-chat", "projects", "gamma", "project.md");
    writeFileSync(pmd, readFileSync(pmd, "utf8").replace("node gamma-check.js", "node -e 0"));
    const r2 = await rig.backend.call(p.tid, "Done", { summary: "Done.", evidence: [] });
    expect(r2.ok).toBe(false);
    expect(out(r2)).toMatch(/command in project\.md changed/);
    // Carl re-sets it through the API: Done passes.
    const ctl = await rig.engine.control({ project: "gamma" }, "check", { command: "node gamma-check.js" });
    expect(ctl.ok).toBe(true);
    const r3 = await rig.backend.call(p.tid, "Done", { summary: "Done.", evidence: [] });
    expect(r3.ok).toBe(true);
    rig.backend.end(p.tid);
    await until(async () => (await rig.readConv(p.convId))?.state === "done");
  });

  it("SetCheck: the agent may set a project's first check (pass_regex), once", async () => {
    const s = await rig.start("Delta work");
    await rig.backend.call(s.tid, "SetProject", { name: "Delta" });
    mkdirSync(join(rig.vault, "tools"), { recursive: true });
    writeFileSync(join(rig.vault, "tools", "score.js"), `console.log("score: 97%")`);
    const a = await rig.backend.call(s.tid, "SetCheck", { command: "node tools/score.js", pass_regex: "score: (9\\d|100)%" });
    expect(a.ok).toBe(true);
    expect(out(a)).toMatch(/score\.js/);
    const b = await rig.backend.call(s.tid, "SetCheck", { command: "node -e 0" });
    expect(b.ok).toBe(false);
    const r = await rig.backend.call(s.tid, "Done", { summary: "97%.", evidence: [] });
    expect(r.ok).toBe(true);
    rig.backend.end(s.tid);
  });
});

describe("2. Budget caps", () => {
  it("80%: the agent is told before its turn; 100%: the conversation ends blocked with one push, its wake never runs", async () => {
    const s = await rig.start("Grind through it, keep going.");
    const set = await rig.engine.control({ convId: s.convId }, "budget", { usd: 10 });
    expect(set.ok).toBe(true);
    rig.backend.end(s.tid);
    await until(async () => (await rig.readConv(s.convId))?.state !== "running");
    // $8.50 spent: the next turn's input carries the 80% line.
    const { mutateConv } = await import("../engine/convs");
    await mutateConv(rig.vault, s.convId, (c) => {
      c.costUsd = 8.5;
    });
    const n = rig.backend.turns.length;
    await rig.engine.run(s.convId, "Wake: next step", "wake");
    await until(() => rig.backend.turns.length === n + 1);
    const t = rig.backend.turns[n].texts.join("\n");
    expect(t).toMatch(/Budget: \$8\.50 of the conversation's \$10\.00 spent \(85%\)/);
    await rig.backend.call(s.tid, "KeepWorking", { on: true });
    await rig.backend.call(s.tid, "ScheduleWake", { in: "1h", reason: "next step" });
    rig.backend.end(s.tid);
    await until(async () => (await rig.readConv(s.convId))?.state === "sleeping");
    // $10.20: the wake fires but runs no turn; blocked, one push.
    await mutateConv(rig.vault, s.convId, (c) => {
      c.costUsd = 10.2;
    });
    await rig.engine.run(s.convId, "Wake: next step", "wake");
    const c = await rig.readConv(s.convId);
    expect(rig.backend.turns.length).toBe(n + 1);
    expect(c.state).toBe("blocked");
    expect(c.working).toBe(false);
    expect(c.nextWakeAt).toBeUndefined();
    expect(c.messages.at(-1).content).toMatch(/Budget reached/);
    await rig.engine.run(s.convId, "Wake: again", "wake");
    expect(rig.pings.filter((p) => p.convId === s.convId && /^Budget reached/.test(p.title))).toHaveLength(1);
    // Carl's own message still runs a turn, told the budget is spent.
    await rig.engine.message({ convId: s.convId, text: "What's the state?" });
    await until(() => rig.backend.turns.length === n + 2);
    expect(rig.backend.turns[n + 1].texts.join("\n")).toMatch(/Budget reached: \$10\.20/);
    rig.backend.end(s.tid);
  });

  it("a project budget counts every conversation of the project; SetBudget needs Carl's approval", async () => {
    const s = await rig.start("Project budget");
    await rig.backend.call(s.tid, "SetProject", { name: "Epsilon" });
    const pending = rig.backend.call(s.tid, "SetBudget", { usd: 5, scope: "project", reason: "a long grind" });
    await until(async () => !!(await rig.readConv(s.convId))?.pendingAsk);
    expect((await rig.readConv(s.convId)).pendingAsk.question).toMatch(/\$5\.00 budget on this project \(epsilon\)/);
    await rig.engine.answerRoute({ convId: s.convId, text: "Approve" });
    const r = await pending;
    expect(out(r)).toMatch(/Budget set/);
    // A second conversation in the project spends $4.20: the first one is past 80%.
    const s2 = await rig.start("Other work", { project: "Epsilon" });
    const { mutateConv } = await import("../engine/convs");
    await mutateConv(rig.vault, s2.convId, (c) => {
      c.costUsd = 4.2;
    });
    const b = rig.engine.budgetOf(await rig.readConv(s.convId));
    expect(b.scope).toBe("project");
    expect(b.frac).toBeCloseTo(0.84, 2);
    // Declined: nothing set.
    const p2 = rig.backend.call(s2.tid, "SetBudget", { usd: 50 });
    await until(async () => !!(await rig.readConv(s2.convId))?.pendingAsk);
    await rig.engine.answerRoute({ convId: s2.convId, text: "Decline" });
    expect(out(await p2)).toMatch(/did not approve/);
    expect((await rig.readConv(s2.convId)).long?.budgetUsd).toBeUndefined();
    rig.backend.end(s.tid);
    rig.backend.end(s2.tid);
  });
});

describe("3. Progress metric and the plateau alert", () => {
  it("samples the pinned metric into a series, shows \"62.4% · +1.8 today\", alerts once on a plateau, tells the agent, and puts it in the Blocked push", async () => {
    const s = await rig.start("Decompile it, keep going.");
    await rig.backend.call(s.tid, "SetProject", { name: "Zeta" });
    await rig.backend.call(s.tid, "KeepWorking", { on: true });
    const val = join(rig.vault, "zeta-value.txt");
    writeFileSync(join(rig.vault, "zeta-metric.js"), `const v = require("fs").readFileSync(${JSON.stringify(val)}, "utf8").trim(); console.log("functions: 4120; matched " + v + "%");`);
    writeFileSync(val, "60.6");
    const set = await rig.engine.control({ project: "zeta" }, "metric", { command: "node zeta-metric.js", every_min: 15, window_h: 1 });
    expect(set.ok).toBe(true);
    // The agent can't replace it.
    const sm = await rig.backend.call(s.tid, "SetMetric", { command: "node -e \"console.log(100)\"" });
    expect(sm.ok).toBe(false);
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const now = Math.max(Date.now(), midnight.getTime() + 2 * 3_600_000);
    expect((await rig.engine.sampleMetric("zeta", midnight.getTime() - 3_600_000)).value).toBe(60.6);
    writeFileSync(val, "62.4");
    await rig.engine.sampleMetric("zeta", now);
    await until(async () => (await rig.readConv(s.convId))?.long?.metric === "62.4% · +1.8 today");
    // Flat for 5 samples 15 min apart (75 min of work ≥ the 1 h window): one push.
    for (let i = 1; i <= 5; i++) await rig.engine.sampleMetric("zeta", now + i * 15 * 60_000);
    const plateauPings = () => rig.pings.filter((p) => p.convId === s.convId && /^No progress in 1 h/.test(p.title));
    expect(plateauPings()).toHaveLength(1);
    expect(plateauPings()[0].body).toMatch(/not risen past 62\.4%/);
    await rig.engine.sampleMetric("zeta", now + 6 * 15 * 60_000);
    expect(plateauPings()).toHaveLength(1);
    expect(rig.engine.turnNotes(await rig.readConv(s.convId))).toMatch(/No progress: the project's metric has not risen past 62\.4%/);
    // A rise clears the note.
    writeFileSync(val, "63");
    await rig.engine.sampleMetric("zeta", now + 7 * 15 * 60_000);
    expect(rig.engine.turnNotes(await rig.readConv(s.convId))).not.toMatch(/No progress/);
    // The Blocked push carries the line.
    await rig.backend.call(s.tid, "Blocked", { reason: "need the symbols file" });
    expect(rig.pings.find((p) => p.convId === s.convId && /^Blocked:/.test(p.title)).body).toMatch(/Progress: 63%/);
    rig.backend.end(s.tid);
    // An edited metric script is not run.
    writeFileSync(join(rig.vault, "zeta-metric.js"), `console.log("matched 100%")`);
    expect(await rig.engine.sampleMetric("zeta", now + 8 * 15 * 60_000)).toBeNull();
  });

  it("the series math: last number, today's change, plateau counted in active time only", async () => {
    const { parseMetric, metricLine, plateauOf } = await import("../engine/long");
    expect(parseMetric("built 3 files\nmatched 1203/4120 = 29.2%\n")).toEqual({ value: 29.2, unit: "%" });
    expect(parseMetric("no numbers here")).toBeNull();
    const t = new Date();
    t.setHours(12, 0, 0, 0);
    const day = t.getTime();
    expect(metricLine([{ at: day - 86_400_000, value: 10 }, { at: day, value: 12.5 }], day)).toBe("12.5 · +2.5 today");
    expect(metricLine([{ at: day, value: 7 }], day)).toBe("7");
    // A 10 h gap overnight counts as 30 min of work (2 × 15 min).
    const flat = [0, 15, 600].map((m) => ({ at: day + m * 60_000, value: 5 }));
    expect(plateauOf(flat, 15, 1)).toBeNull(); // 15 + 30 min
    expect(plateauOf([...flat, { at: day + 615 * 60_000, value: 5 }], 15, 1)?.best).toBe(5); // + 15 = 1 h
    expect(plateauOf([...flat, { at: day + 615 * 60_000, value: 6 }], 15, 1)).toBeNull(); // it rose
  });
});

describe("4. Job control", () => {
  it("argv: a time limit (24 h default, 7 d max), a memory ceiling, a low CPU and IO share", async () => {
    const { jobArgv, jobTimeoutS } = await import("../engine/pi/jobs");
    const env = { logDir: "/state/jobs", wrap: ["bwrap", "--ro-bind", "/", "/", "--"], env: { PATH: "/bin", HOME: "/home/c" } };
    const argv = jobArgv(env, "/vault", "train-abc", "(python train.py) > log", jobTimeoutS(undefined));
    expect(argv).toContain("--property=RuntimeMaxSec=86400");
    expect(argv).toContain("--property=MemoryMax=75%");
    expect(argv).toContain("--property=CPUWeight=20");
    expect(argv).toContain("--property=IOWeight=20");
    expect(argv).toContain("--unit=vc-job-train-abc");
    // The sandbox, with the log dir writable, then the shell.
    expect(argv.slice(argv.indexOf("bwrap"))).toEqual(["bwrap", "--ro-bind", "/", "/", "--bind", "/state/jobs", "/state/jobs", "--", "sh", "-c", "(python train.py) > log"]);
    expect(jobTimeoutS("36h")).toBe(129_600);
    expect(jobTimeoutS("10d")).toBe(7 * 86_400);
    expect(jobTimeoutS("1h30m")).toBe(5400);
    expect(jobTimeoutS(5)).toBe(60);
  });

  it("the state machine: a cap of 4 running, JobList, JobStop, and a wake turn when a job finishes or hits its time limit (once)", async () => {
    const logDir = join(rig.root, "jobs4");
    const units = new Map<string, string>();
    const calls: string[][] = [];
    const jobEnv = {
      logDir,
      wrap: ["bwrap", "--"],
      env: {},
      max: 4,
      exec: (cmd: string, args: string[]) => {
        calls.push([cmd, ...args]);
        const unit = (args.find((x) => x.startsWith("--unit=")) ?? args.at(-1) ?? "").replace("--unit=", "");
        if (cmd === "systemd-run") units.set(unit, "active");
        if (cmd === "systemctl" && args[1] === "stop") units.set(unit, "inactive");
        return { status: 0, stdout: cmd === "systemctl" && args[1] === "is-active" ? (units.get(unit) ?? "inactive") + "\n" : "", stderr: "" };
      },
    };
    const saved = rig.engine.d.jobEnv;
    rig.engine.d.jobEnv = jobEnv;
    try {
      const s = await rig.start("Run the four trainings.");
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) {
        const r = await rig.backend.call(s.tid, "StartJob", { command: `python train.py --seed ${i}`, name: `seed ${i}`, ...(i === 1 ? { timeout: "2h" } : {}) });
        ids.push(/Started job (\S+) /.exec(out(r))![1]!);
        await new Promise((ok) => setTimeout(ok, 5)); // distinct ids
      }
      expect(calls.find((c) => c.includes(`--unit=vc-job-${ids[1]}`))).toContain("--property=RuntimeMaxSec=7200");
      const fifth = await rig.backend.call(s.tid, "StartJob", { command: "sleep 1" });
      expect(out(fifth)).toMatch(/Not started: 4 jobs are already running in this vault \(the cap is 4\)/);
      expect(out(await rig.backend.call(s.tid, "JobList", {}))).toMatch(new RegExp(`${ids[0]}: running`));
      const stop = await rig.backend.call(s.tid, "JobStop", { id: ids[3] });
      expect(out(stop)).toMatch(/Stopped job/);
      expect(calls.some((c) => c[0] === "systemctl" && c[2] === "stop" && c[3] === `vc-job-${ids[3]}`)).toBe(true);
      expect(out(await rig.backend.call(s.tid, "JobList", {}))).toMatch(new RegExp(`${ids[3]}: stopped`));
      rig.backend.end(s.tid);
      await until(async () => (await rig.readConv(s.convId))?.state === "idle");
      // Job 0 finishes (its log's exit line); job 1's unit is gone past its time limit.
      writeFileSync(join(logDir, `${ids[0]}.log`), "epoch 1 loss 0.9\nepoch 2 loss 0.4\n[exit 0]\n");
      units.set(`vc-job-${ids[1]}`, "inactive");
      const reg = JSON.parse(readFileSync(join(logDir, "jobs.json"), "utf8"));
      reg.find((j: any) => j.id === ids[1]).startedAt -= 3 * 3_600_000;
      writeFileSync(join(logDir, "jobs.json"), JSON.stringify(reg));
      const n = rig.backend.turns.length;
      await rig.engine.tickJobs();
      await until(() => rig.backend.turns.length >= n + 1);
      const wake = rig.backend.turns[n].texts.join("\n");
      expect(wake).toMatch(new RegExp(`Job ${ids[0]} finished: exit 0`));
      expect(wake).toMatch(/epoch 2 loss 0\.4/);
      // The second end arrived while that wake turn ran: it went into the turn as a follow-up.
      const both = [...rig.backend.turns.slice(n), ...rig.backend.followUps].map((t) => t.texts.join("\n")).join("\n");
      expect(both).toMatch(new RegExp(`Job ${ids[1]} was stopped by its time limit`));
      rig.backend.end(s.tid);
      await until(async () => (await rig.readConv(s.convId))?.state === "idle");
      // Each end wakes once; job 2 still runs; the cap has room again.
      await rig.engine.tickJobs();
      await new Promise((ok) => setTimeout(ok, 300));
      expect(rig.backend.turns.length).toBe(n + 1);
      const st = JSON.parse(readFileSync(join(logDir, "jobs.json"), "utf8")).map((j: any) => j.state);
      expect(st).toEqual(["finished", "timeout", "running", "stopped"]);
    } finally {
      rig.engine.d.jobEnv = saved;
    }
  });
});

/** A worker conversation's current thread and the input of its latest turn. */
async function workerTurn(id: string): Promise<{ tid: string; text: string }> {
  const c = await rig.readConv(id);
  const t = [...rig.backend.turns].reverse().find((x) => x.threadId === c.threadId);
  return { tid: c.threadId, text: t ? t.texts.join("\n") : "" };
}
const workersOf = async (parent: string) => (await rig.allConvs()).filter((c) => c.parent === parent).sort((a, b) => a.title.localeCompare(b.title));

describe("5. Task queue with fresh worker sessions", () => {
  it("workers claim tasks, each in a fresh session; learnings are shared; failures retry then give up; the parent sees the count and is woken at the end", async () => {
    const s = await rig.start("Decompile the overlay functions in parallel.");
    await rig.backend.call(s.tid, "SetProject", { name: "Eta" });
    const add = await rig.backend.call(s.tid, "TaskAdd", { tasks: [{ title: "fn_a" }, { title: "fn_b", notes: "tricky jump table" }, { title: "fn_c" }] });
    expect(out(add)).toMatch(/Added 3 task\(s\): t1, t2, t3/);
    const threads0 = rig.backend.threads.length;
    const rw = await rig.backend.call(s.tid, "RunWorkers", { count: 2 });
    expect(out(rw)).toMatch(/Started 2 worker\(s\) on 3 task\(s\)/);
    rig.backend.end(s.tid);
    const [A, B] = await workersOf(s.convId);
    expect(A.source).toBe("worker");
    expect(A.project).toBe("eta");
    await until(async () => !!(await workerTurn(A.id)).text && !!(await workerTurn(B.id)).text);
    expect(rig.backend.threads.length).toBe(threads0 + 2);
    const a1 = await workerTurn(A.id);
    const b1 = await workerTurn(B.id);
    expect(a1.text).toMatch(/Task t1 \(attempt 1 of 3; deadline 60 min\): fn_a/);
    expect(b1.text).toMatch(/Task t2 .*fn_b[\s\S]*tricky jump table/);
    expect((await rig.readConv(s.convId)).long.workers).toBe("2 workers · 0/3 done");
    // A worker may not call Done.
    expect(out(await rig.backend.call(a1.tid, "Done", { summary: "x" }))).toMatch(/TaskUpdate/);
    // A finishes t1 with a learning; its next task starts in a fresh thread that carries it.
    expect(out(await rig.backend.call(a1.tid, "TaskUpdate", { id: "t1", status: "done", note: "matched", learning: "the overlay is compiled with -O2" }))).toMatch(/t1: done. Stop now/);
    rig.backend.end(a1.tid);
    await until(async () => (await workerTurn(A.id)).tid !== a1.tid);
    const a2 = await workerTurn(A.id);
    expect(a2.text).toMatch(/Task t3/);
    expect(a2.text).toMatch(/the overlay is compiled with -O2/);
    expect(readFileSync(join(rig.vault, ".vault-chat", "projects", "eta", "learnings.md"), "utf8")).toMatch(/- \[t1\] the overlay is compiled with -O2/);
    // B ends without TaskUpdate: one nudge, then the attempt fails and t2 goes back to the queue.
    const n = rig.backend.turns.length;
    rig.backend.end(b1.tid);
    await until(() => rig.backend.turns.length > n);
    expect((await workerTurn(B.id)).text).toMatch(/Task t2 is still open/);
    rig.backend.end(b1.tid);
    await until(async () => (await workerTurn(B.id)).tid !== b1.tid);
    const b2 = await workerTurn(B.id);
    expect(b2.text).toMatch(/Task t2 \(attempt 2 of 3/);
    expect(b2.text).toMatch(/ended twice without TaskUpdate/);
    // A finishes t3 and, with nothing left to claim, ends.
    await rig.backend.call(a2.tid, "TaskUpdate", { status: "done" });
    rig.backend.end(a2.tid);
    await until(async () => (await rig.readConv(A.id)).state === "done");
    expect((await rig.readConv(A.id)).working).toBe(false);
    // B fails t2 twice more (Blocked counts as a failed attempt): given up; B ends; the parent wakes.
    await rig.backend.call(b2.tid, "TaskUpdate", { id: "t2", status: "failed", note: "jump table unresolved" });
    rig.backend.end(b2.tid);
    await until(async () => (await workerTurn(B.id)).tid !== b2.tid);
    const b3 = await workerTurn(B.id);
    expect(b3.text).toMatch(/attempt 3 of 3/);
    const pTurns = rig.backend.turns.length;
    await rig.backend.call(b3.tid, "Blocked", { reason: "needs the symbol map" });
    rig.backend.end(b3.tid);
    await until(async () => (await rig.readConv(B.id)).state === "done");
    await until(() => rig.backend.turns.some((t, i) => i >= pTurns && t.threadId === s.tid));
    const wake = rig.backend.turns.filter((t) => t.threadId === s.tid).at(-1).texts.join("\n");
    expect(wake).toMatch(/Workers finished \(the queue is empty\): 2\/3 done, 1 given up, 0 left to do/);
    expect((await rig.readConv(s.convId)).long.workers).toBe("workers done · 2/3 done · 1 given up");
    const { readTasks } = await import("../engine/tasks");
    const t2 = readTasks(rig.vault, "eta").find((t) => t.id === "t2")!;
    expect(t2.status).toBe("gave_up");
    expect(t2.attempts).toBe(3);
    expect(t2.notes).toMatch(/blocked: needs the symbol map/);
    // Workers are not chats of their own in the phone's list.
    const { conversationsSummary } = await import("../phoneData");
    const rows = (conversationsSummary(rig.vault) as any).conversations.map((r: any) => r.id);
    expect(rows).toContain(s.convId);
    expect(rows).not.toContain(A.id);
    rig.backend.end(s.tid);
  });

  it("the per-task check gates done; a task past its deadline is stopped and fails the attempt", async () => {
    const s = await rig.start("Theta tasks");
    await rig.backend.call(s.tid, "SetProject", { name: "Theta" });
    writeFileSync(join(rig.vault, "theta-check.js"), `process.exit(process.argv[2] === "t1" ? 0 : 1)`);
    await rig.engine.control({ project: "theta" }, "check", { command: "node theta-check.js {task}" });
    const { writeLong } = await import("../engine/long");
    writeLong(rig.vault, "theta", (st) => ({ ...st, maxAttempts: 1 }));
    await rig.backend.call(s.tid, "TaskAdd", { tasks: [{ title: "good" }, { title: "slow", deadline_min: 0.01 }, { title: "bad" }] });
    await rig.backend.call(s.tid, "RunWorkers", { count: 1 });
    rig.backend.end(s.tid);
    const [W] = await workersOf(s.convId);
    await until(async () => /Task t1/.test((await workerTurn(W.id)).text));
    const w1 = await workerTurn(W.id);
    expect(out(await rig.backend.call(w1.tid, "TaskUpdate", { status: "done" }))).toMatch(/t1: done/);
    rig.backend.end(w1.tid);
    // t2 runs out of time: the watchdog stops the turn; the attempt fails (given up at 1 attempt).
    await until(async () => /Task t2/.test((await workerTurn(W.id)).text));
    await new Promise((ok) => setTimeout(ok, 800));
    rig.engine.tickWatchdog();
    await until(async () => /Task t3/.test((await workerTurn(W.id)).text));
    const { readTasks } = await import("../engine/tasks");
    const t2 = readTasks(rig.vault, "theta").find((t) => t.id === "t2")!;
    expect(t2.status).toBe("gave_up");
    expect(t2.notes).toMatch(/deadline \(0\.01 min\) passed/);
    // t3: the check fails for it, so done is refused and the task stays in progress.
    const w3 = await workerTurn(W.id);
    const r = await rig.backend.call(w3.tid, "TaskUpdate", { status: "done" });
    expect(r.ok).toBe(false);
    expect(out(r)).toMatch(/Not done: the project's check failed \(exit 1\) for t3/);
    expect(readTasks(rig.vault, "theta").find((t) => t.id === "t3")!.status).toBe("doing");
    await rig.backend.call(w3.tid, "TaskUpdate", { status: "failed", note: "check fails" });
    rig.backend.end(w3.tid);
    await until(async () => (await rig.readConv(W.id)).state === "done");
    rig.backend.end(s.tid);
  });
});

describe("6. A git worktree per worker", () => {
  it("each worker works in its own worktree; done merges back (fast-forward or merge); a conflict sends the task back to the queue; the next attempt starts on the new HEAD", async () => {
    const { sh } = await import("./helpers");
    const repo = join(rig.vault, "code");
    mkdirSync(repo, { recursive: true });
    sh(repo, "git", ["init", "-q", "-b", "main"]);
    sh(repo, "git", ["config", "core.autocrlf", "false"]);
    writeFileSync(join(repo, "shared.txt"), "base\n");
    sh(repo, "git", ["add", "-A"]);
    sh(repo, "git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base"]);
    const s = await rig.start("Port the functions.");
    await rig.backend.call(s.tid, "SetProject", { name: "Iota" });
    await rig.backend.call(s.tid, "TaskAdd", { tasks: [{ title: "edit shared one way" }, { title: "edit shared another way" }, { title: "add a file" }] });
    const bad = await rig.backend.call(s.tid, "RunWorkers", { count: 2, repo: "../.." });
    expect(out(bad)).toMatch(/Not started: .* (outside|not a git repo)/);
    const rw = await rig.backend.call(s.tid, "RunWorkers", { count: 2, repo: "code" });
    expect(out(rw)).toMatch(/own git worktree/);
    rig.backend.end(s.tid);
    const [A, B] = await workersOf(s.convId);
    await until(async () => !!(await workerTurn(A.id)).text && !!(await workerTurn(B.id)).text);
    const a = await rig.readConv(A.id);
    const b = await rig.readConv(B.id);
    expect(a.long.cwd).not.toBe(b.long.cwd);
    expect(a.long.cwd).toMatch(/code\.worktrees/);
    // The fresh thread opened in the worktree, and the prompt says so.
    expect(rig.backend.threads.find((t) => t.threadId === a.threadId).cwd).toBe(a.long.cwd);
    expect((await workerTurn(A.id)).text).toMatch(/your own git worktree/);
    // Both edit the same line.
    writeFileSync(join(a.long.cwd, "shared.txt"), "A was here\n");
    writeFileSync(join(b.long.cwd, "shared.txt"), "B was here\n");
    const ra = await rig.backend.call(a.threadId, "TaskUpdate", { status: "done" });
    expect(out(ra)).toMatch(/t1: done/);
    expect(readFileSync(join(repo, "shared.txt"), "utf8")).toBe("A was here\n");
    const rb = await rig.backend.call(b.threadId, "TaskUpdate", { status: "done" });
    expect(out(rb)).toMatch(/t2 could not be merged: conflict in shared\.txt\. It is back in the queue/);
    // The repo is clean (the merge was aborted) and still has A's change.
    expect(sh(repo, "git", ["status", "--porcelain"]).trim()).toBe("");
    expect(readFileSync(join(repo, "shared.txt"), "utf8")).toBe("A was here\n");
    const { readTasks } = await import("../engine/tasks");
    const t2 = readTasks(rig.vault, "iota").find((t) => t.id === "t2")!;
    expect(t2.status).toBe("todo");
    expect(t2.notes).toMatch(/merge conflict/);
    // A takes t2 next (the first to do), on the new HEAD: its worktree shows A's change; this time it merges.
    rig.backend.end(a.threadId);
    await until(async () => /Task t2/.test((await workerTurn(A.id)).text));
    const a2 = await rig.readConv(A.id);
    expect(readFileSync(join(a2.long.cwd, "shared.txt"), "utf8")).toBe("A was here\n");
    writeFileSync(join(a2.long.cwd, "shared.txt"), "A was here\nand B's idea too\n");
    expect(out(await rig.backend.call(a2.threadId, "TaskUpdate", { status: "done" }))).toMatch(/t2: done/);
    expect(readFileSync(join(repo, "shared.txt"), "utf8")).toBe("A was here\nand B's idea too\n");
    // B takes t3 and adds a file while main moved on: a real merge.
    rig.backend.end(b.threadId);
    await until(async () => /Task t3/.test((await workerTurn(B.id)).text));
    const b2 = await rig.readConv(B.id);
    writeFileSync(join(b2.long.cwd, "new.txt"), "new\n");
    expect(out(await rig.backend.call(b2.threadId, "TaskUpdate", { status: "done" }))).toMatch(/t3: done/);
    expect(readFileSync(join(repo, "new.txt"), "utf8")).toBe("new\n");
    expect(sh(repo, "git", ["log", "--oneline"])).toMatch(/task t1: edit shared one way/);
    // Queue empty: the workers end and their worktrees are removed.
    rig.backend.end(a2.threadId);
    rig.backend.end(b2.threadId);
    await until(async () => (await rig.readConv(A.id)).state === "done" && (await rig.readConv(B.id)).state === "done");
    expect(sh(repo, "git", ["worktree", "list"]).trim().split("\n")).toHaveLength(1);
    rig.backend.end(s.tid);
  });
});
