import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeJob, readJobs, writeJobs } from "../engine/pi/jobs";
const state = vi.hoisted(() => ({ accepted: [] as any[], prepare: vi.fn() }));
vi.mock("../changeShipping", () => ({ acceptedChanges: async () => state.accepted }));
vi.mock("../sourceRollback", () => ({ prepareSourceRollback: (...a: any[]) => state.prepare(...a), ROLLBACK_CHECK: {} }));
import { requestRollback } from "../submitChange";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.clearAllMocks(); });
const turn = () => new Promise(r => setImmediate(r));
function setup() {
  const vault = mkdtempSync(join(tmpdir(), "vc-rollback-job-")); dirs.push(vault);
  const accepted = { id: "accepted-change", acceptedAt: "now", review: { folder: "/private/project", convId: "project-app" } } as any;
  state.accepted = [accepted]; state.prepare.mockRejectedValue(new Error("actual proof preparation failed"));
  return { vault, accepted, reason: "Health failed: restore the accepted source", jobs: { logDir: join(vault, "jobs"), wrap: null, env: {}, max: 1 }, host: {} as any };
}
describe("rollback job idempotency across health observations", () => {
  it("does not launch another proof after a failed/stopped/timed-out task", async () => {
    const o = setup(), first = await requestRollback(o); await turn();
    expect(probeJob(o.jobs, first.job!).exit).toBe(1);
    await expect(requestRollback(o)).rejects.toThrow("needs attention, not another automatic retry");
    expect(state.prepare).toHaveBeenCalledTimes(1); expect(readJobs(o.jobs)).toHaveLength(1);
  });
  it("re-proves after restart-lost service jobs without replaying their receipt or getting stuck on the job cap", async () => {
    const o = setup();
    writeJobs(o.jobs, [{ id: "previous-process", kind: "service", name: "source-rollback", command: `Source rollback ${o.accepted.id}`, conv: "project-app", state: "running", startedAt: 0, timeoutS: 100 }]);
    const next = await requestRollback(o); expect(next.job?.id).not.toBe("previous-process"); expect(next.job).toBeTruthy(); await turn();
    expect(state.prepare).toHaveBeenCalledTimes(1);
  });
  it("an accepted rollbackOf remains terminal across restart and duplicate requests", async () => {
    const o = setup(); state.accepted.push({ id: "revert", rollbackOf: o.accepted.id });
    const result = await requestRollback(o); expect(result.job).toBeUndefined(); expect(result.text).toContain("already accepted");
    expect(state.prepare).not.toHaveBeenCalled();
  });
});
