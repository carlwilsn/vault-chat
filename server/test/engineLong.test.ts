// Long runs, in process on a fake pi: job control (StartJob's limits, the cap,
// JobList, JobStop, a wake turn when a job ends).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup } from "./helpers";
import { makeRig, until, type Rig } from "./longRig";

let rig: Rig;

beforeAll(async () => {
  rig = await makeRig();
});

afterAll(async () => {
  rig?.engine?.stop();
  await rig?.verifier.close();
  cleanup(rig?.root);
});

const out = (r: any) => String(r?.text ?? "");

describe("Job control", () => {
  it("argv: a time limit (24 h default, 7 d max), a memory ceiling, a low CPU and IO share", async () => {
    const { jobArgv, jobTimeoutS } = await import("../engine/pi/jobs");
    const env = { logDir: "/state/jobs", wrap: ["bwrap", "--ro-bind", "/", "/", "--"], env: { PATH: "/bin", HOME: "/home/c" } };
    const argv = jobArgv(env, "/vault", "train-abc", "(python train.py) > log", jobTimeoutS(undefined), "/run/user/1000/vault-chat/jobs/train-abc.env");
    expect(argv).toContain("--property=EnvironmentFile=/run/user/1000/vault-chat/jobs/train-abc.env");
    expect(argv).toContain("--property=Type=exec");
    expect(argv).not.toContain("-E");
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
