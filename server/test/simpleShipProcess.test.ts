/** Real native flock/job-stop private fixture, NOT installed host/application/device evidence. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const state = vi.hoisted(() => ({ home: "" }));
// Redirect only the installed-location lookup to a private fixture; no spawn, git, flock or kill mocks.
vi.mock("node:os", async original => ({ ...await original<typeof import("node:os")>(), homedir: () => state.home }));
import { runInstalledShip } from "../submitChange";
import { jobStop, reapJobs, startServiceJob } from "../engine/pi/jobs";
const roots: string[] = [], pids: number[] = [];
afterEach(() => { for (const pid of pids.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch {} } for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const waitFor = async (check: () => boolean) => { for (let i = 0; i < 300; i++) { if (check()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error("Private process fixture did not reach its barrier"); };
const alive = (pid: number) => { try { const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); return !["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3)); } catch { return false; } };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vc-ship-process-")); roots.push(root); state.home = root;
  const installed = join(root, ".local/lib/vault-chat/simple-ship"); mkdirSync(installed, { recursive: true });
  writeFileSync(join(installed, "config.json"), "{}");
  const ready = join(root, "ready.json");
  writeFileSync(join(installed, "simple-ship.mjs"), `import {spawn} from 'node:child_process';import fs from 'node:fs';
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});
fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({parent:process.pid,child:child.pid}));setInterval(()=>{},1000);`);
  const jobs = { logDir: join(root, "jobs"), wrap: null, env: {} };
  return { root, ready, jobs };
}
describe("native shipping process ownership (private fixture)", () => {
  it("rejects another conversation's stop, then cancels the actual flock process group through JobStop", async () => {
    const f = fixture(); const conv = "project-private-process";
    const started = startServiceJob(f.jobs, { name: "ship-private", command: "private native fixture", conv, byCarl: false }, (signal, log) => runInstalledShip(f.root, "--branch", "agent/private-fixture", "Private", "private", conv, signal, log));
    await waitFor(() => existsSync(f.ready)); const children = JSON.parse(readFileSync(f.ready, "utf8")); pids.push(children.parent, children.child);
    expect(jobStop(f.jobs, started.job!.id, "other-conversation")).toContain("another conversation");
    expect(alive(children.parent)).toBe(true); expect(alive(children.child)).toBe(true);
    expect(jobStop(f.jobs, started.job!.id, conv)).toContain("Stopped");
    await waitFor(() => !alive(children.parent) && !alive(children.child));
    const log = join(f.jobs.logDir, started.job!.id + ".log");
    await waitFor(() => existsSync(log) && readFileSync(log, "utf8").includes("Shipping cancelled"));
    expect(reapJobs(f.jobs)[0]).toMatchObject({ id: started.job!.id, state: "stopped" });
    expect(reapJobs(f.jobs)).toEqual([]);
  });
  it("rejects a pre-aborted invocation before launching a process", () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    expect(() => runInstalledShip(f.root, "--branch", "agent/private", "Private", "private", "private", controller.signal, () => {})).toThrow();
    expect(existsSync(f.ready)).toBe(false);
  });
});
