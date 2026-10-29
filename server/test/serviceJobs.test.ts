import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jobList, jobStatus, jobStop, probeJob, readJobs, reapJobs, startServiceJob, writeJobs, type PiJobEnv } from "../engine/pi/jobs";
const dirs: string[] = [];
const env = (): PiJobEnv => { const logDir = mkdtempSync(join(tmpdir(), "vc-service-job-")); dirs.push(logDir); return { logDir, wrap: null, env: {}, exec: () => { throw new Error("Host tasks must not invoke systemd or an agent shell"); } }; };
const args = { name: "submit-change", command: "Prove committed candidate", conv: "project-repo", byCarl: true };
const settled = () => new Promise<void>(r => setImmediate(r));
afterEach(() => { vi.useRealTimers(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("proof tasks reuse existing background-job lifecycle", () => {
  it("is durable before starting, outlives the caller, appears in status/list and reaps exactly once", async () => {
    const e = env(); let finish!: (s: string) => void;
    const run = new Promise<string>(r => { finish = r; });
    const started = startServiceJob(e, args, async (_signal, log) => { expect(readJobs(e)[0]?.id).toBe(started.job?.id); log("Running real host gates"); return run; });
    expect(started.job?.kind).toBe("service"); expect(readJobs(e)).toHaveLength(1);
    await settled();
    expect(jobList(e, args.conv)).toContain(started.job!.id);
    expect(jobStatus(e, { id: started.job!.id })).toContain("Running real host gates");
    expect(reapJobs(e)).toEqual([]);
    finish("Accepted; release/device health still pending, not Shipped"); await settled();
    const ended = reapJobs(e);
    expect(ended).toHaveLength(1); expect(ended[0]).toMatchObject({ state: "finished", exit: 0, conv: args.conv, byCarl: true });
    expect(ended[0]?.tail).toContain("not Shipped"); expect(reapJobs(e)).toEqual([]);
    expect(jobStatus(e, { id: started.job!.id })).toContain("finished (exit 0)");
  });
  it("reports a host failure rather than a fabricated successful result", async () => {
    const e = env(); startServiceJob(e, args, async () => { throw new Error("candidate gate failed"); }); await settled();
    expect(reapJobs(e)[0]).toMatchObject({ state: "finished", exit: 1, tail: "Host task failed: candidate gate failed" });
  });
  it("caps service and shell jobs together and stops through the same ownership check/abort controller", async () => {
    const e = { ...env(), max: 1 }; let aborted = false;
    const first = startServiceJob(e, args, signal => new Promise((_resolve, reject) => signal.addEventListener("abort", () => { aborted = true; reject(new Error("cancelled")); })));
    await settled();
    expect(startServiceJob(e, args, async () => "bad").job).toBeUndefined();
    expect(jobStop(e, first.job!.id, "other-conversation")).toContain("another conversation"); expect(aborted).toBe(false);
    expect(jobStop(e, first.job!.id, args.conv)).toContain("Stopped"); await settled(); expect(aborted).toBe(true);
    expect(reapJobs(e)[0]?.state).toBe("stopped"); expect(reapJobs(e)).toEqual([]);
  });
  it("a restart has no in-memory controller/permit and becomes gone, never resumed or successful", () => {
    const e = env(); const job = { id: "submit-change-before-restart", name: "submit-change", command: "prove", kind: "service" as const, startedAt: Date.now(), timeoutS: 60, state: "running" as const };
    writeJobs(e, [job]); expect(probeJob(e, job).state).toBe("gone"); expect(reapJobs(e)[0]?.state).toBe("gone"); expect(reapJobs(e)).toEqual([]);
  });
  it("timeout aborts the host runner and retains the honest terminal state", async () => {
    vi.useFakeTimers(); const e = env(); let aborted = false;
    startServiceJob(e, { ...args, timeout: 60 }, signal => new Promise((_resolve, reject) => signal.addEventListener("abort", () => { aborted = true; reject(new Error("timed out")); })));
    await Promise.resolve(); await vi.advanceTimersByTimeAsync(60_001);
    expect(aborted).toBe(true); expect(reapJobs(e)[0]?.state).toBe("timeout");
  });
});
