// StartJob without systemd (a Mac): the job is a detached process group whose pid is in the registry; the
// poll sees it end ("[exit N]" in its log) and reports it once, JobStop takes the whole group, and the time
// limit is the poll's kill. Runs for real on Linux with runner "portable" (the same code path a Mac takes).
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup } from "./helpers";
import { jobRunner, jobStatus, jobStop, memoryKiB, portableShell, readJobs, reapJobs, startJobWith, writeJobs, type JobEnv } from "../engine/jobs";

const root = mkdtempSync(join(tmpdir(), "vc-portjob-"));
afterAll(() => cleanup(root));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
};
// Built at runtime: no key-like literal in the source.
const fakeKey = "sk-ant-" + "z".repeat(40);

function envFor(name: string): JobEnv {
  return { logDir: join(root, name, "logs"), wrap: null, env: { PATH: process.env.PATH ?? "/bin:/usr/bin", HOME: root, VC_TEST_KEY: fakeKey }, runner: "portable" };
}

async function until<T>(f: () => T | undefined, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await sleep(100);
  }
}

describe("portable jobs (no systemd)", () => {
  it("picks the runner by platform: systemd on Linux, portable on a Mac, none on Windows", () => {
    const saved = process.env.VC_JOB_RUNNER;
    delete process.env.VC_JOB_RUNNER;
    try {
      expect(jobRunner({}, "linux")).toBe("systemd");
      expect(jobRunner({}, "darwin")).toBe("portable");
      expect(jobRunner({}, "freebsd")).toBe("portable");
      expect(jobRunner({}, "win32")).toBe("none");
      expect(jobRunner({ exec: () => ({ status: 0, stdout: "", stderr: "" }) }, "darwin")).toBe("systemd");
      process.env.VC_JOB_RUNNER = "portable";
      expect(jobRunner({}, "linux")).toBe("portable");
    } finally {
      if (saved === undefined) delete process.env.VC_JOB_RUNNER;
      else process.env.VC_JOB_RUNNER = saved;
    }
  });

  it("memory ceiling and CPU share in the shell, best effort", () => {
    expect(memoryKiB("6G")).toBe(6 * 1024 * 1024);
    expect(memoryKiB("512M")).toBe(512 * 1024);
    expect(memoryKiB("50%", 8 * 1024 ** 3)).toBe(4 * 1024 * 1024);
    expect(memoryKiB("lots")).toBeNull();
    const sh = portableShell("echo hi", 1024);
    expect(sh).toContain("renice -n 10");
    expect(sh).toContain("ulimit -v 1024 2>/dev/null");
    expect(portableShell("echo hi", null)).not.toContain("ulimit");
  });

  it("starts detached in the working folder with its env, survives as its own group, and its end is reported once", async () => {
    const env = envFor("ends");
    const cwd = join(root, "ends");
    const r = startJobWith(env, root, { command: `cd ${JSON.stringify(cwd)} && pwd && [ -n "$VC_TEST_KEY" ] && echo has-key; echo "host=$HOST"; sleep 1; echo done-here`, name: "mac job" }, "conv-1");
    expect(r.text).toMatch(/^Started job mac-job-/);
    const job = r.job!;
    expect(job.pid).toBeGreaterThan(0);
    expect(readJobs(env)[0]!.pid).toBe(job.pid);
    // The env reached it through spawn's env, never the registry.
    expect(readFileSync(join(env.logDir, "jobs.json"), "utf8")).not.toContain(fakeKey);
    expect(reapJobs(env)).toEqual([]);
    const ended = await until(() => reapJobs(env)[0]);
    expect(ended.id).toBe(job.id);
    expect(ended.state).toBe("finished");
    expect(ended.exit).toBe(0);
    expect(ended.conv).toBe("conv-1");
    expect(ended.tail).toContain("has-key");
    expect(ended.tail).toContain("host=127.0.0.1");
    expect(ended.tail).toContain("done-here");
    expect(ended.tail).not.toContain(fakeKey);
    expect(reapJobs(env)).toEqual([]);
    expect(jobStatus(env, { id: job.id })).toMatch(/finished \(exit 0\)/);
  });

  it("a failing command reports its exit code", async () => {
    const env = envFor("fails");
    const r = startJobWith(env, root, { command: "echo nope; exit 3", name: "fails" });
    const ended = await until(() => reapJobs(env)[0]);
    expect(ended.id).toBe(r.job!.id);
    expect(ended.state).toBe("finished");
    expect(ended.exit).toBe(3);
  });

  it("JobStop takes the whole group, children included", async () => {
    const env = envFor("stop");
    const r = startJobWith(env, root, { command: "sleep 60 & sleep 60 & wait", name: "stopme" }, "c");
    const pid = r.job!.pid!;
    await sleep(300);
    expect(alive(pid)).toBe(true);
    expect(jobStatus(env, { id: r.job!.id })).toMatch(/running/);
    expect(jobStop(env, r.job!.id, "c")).toMatch(/^Stopped job/);
    await until(() => (!alive(pid) ? true : undefined), 5000);
    expect(readJobs(env)[0]!.state).toBe("stopped");
  });

  it("its time limit: the poll kills the group and says timeout", async () => {
    const env = envFor("timeout");
    const r = startJobWith(env, root, { command: "sleep 60", name: "slow", timeout: "1m" });
    const pid = r.job!.pid!;
    await sleep(200);
    // Pretend it started over its limit ago.
    writeJobs(env, readJobs(env).map((j) => ({ ...j, startedAt: Date.now() - 61_000 })));
    const ended = await until(() => reapJobs(env)[0]);
    expect(ended.state).toBe("timeout");
    await until(() => (!alive(pid) ? true : undefined), 5000);
  });

  it("a job whose process vanished without an exit line is gone", async () => {
    const env = envFor("gone");
    const r = startJobWith(env, root, { command: "sleep 60", name: "killed" });
    await sleep(200);
    process.kill(-r.job!.pid!, "SIGKILL");
    const ended = await until(() => reapJobs(env)[0]);
    expect(ended.state).toBe("gone");
  });

  it("a missing working folder fails to start, and the cap holds", () => {
    const env = { ...envFor("cap"), max: 1 };
    expect(startJobWith(env, join(root, "no-such-dir"), { command: "true" }).text).toMatch(/^StartJob failed: its working folder/);
    const a = startJobWith(env, root, { command: "sleep 30", name: "one" });
    expect(a.job).toBeTruthy();
    expect(startJobWith(env, root, { command: "true" }).text).toMatch(/^Not started/);
    jobStop(env, a.job!.id);
  });
});
