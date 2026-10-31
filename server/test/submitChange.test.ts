/** Thin adapter contracts only: host execution/gates are tested separately, never mocked as release proof. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const state = vi.hoisted(() => ({ spawn: vi.fn(), installed: true, accepted: [] as any[] }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn: (...args: any[]) => state.spawn(...args) }));
vi.mock("node:fs", async original => { const real = await original<typeof import("node:fs")>(); return { ...real, existsSync: (p: string) => String(p).includes("/.local/lib/vault-chat/simple-ship/") ? state.installed : real.existsSync(p) }; });
vi.mock("../projectFolders", () => ({ projectFolderOf: () => ({ abs: "/registered/project" }) }));
vi.mock("../projectChanges", () => ({ isGatedProject: () => true }));
vi.mock("../changeShipping", () => ({ acceptedChanges: async () => state.accepted }));
import { requestRollback, runInstalledShip, SUBMIT_CHANGE_SCHEMA, submitChangeJob } from "../submitChange";
import { readJobs, probeJob } from "../engine/pi/jobs";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.clearAllMocks(); state.installed = true; });
function child() { const c = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() }); state.spawn.mockReturnValue(c); return c; }
function setup() { const vault = mkdtempSync(join(tmpdir(), "vc-submit-")); dirs.push(vault); return { vault, convId: "project-app", byCarl: true, jobs: { logDir: join(vault, "jobs"), wrap: null, env: {} } }; }
const turn = () => new Promise(r => setImmediate(r));
describe("pushed branch to one installed box script", () => {
  it("exposes only branch/title, never permits, UI proof identity or host commands", () => {
    expect(SUBMIT_CHANGE_SCHEMA.required).toEqual(["title", "branch"]);
    expect(Object.keys(SUBMIT_CHANGE_SCHEMA.properties)).toEqual(["title", "branch"]);
    expect(SUBMIT_CHANGE_SCHEMA.additionalProperties).toBe(false);
  });
  it("passes argument vectors through native flock without inherited provider/key environment", async () => {
    const c = child(), signal = new AbortController().signal;
    const result = runInstalledShip("/registered/project", "--branch", "agent/change", "A title; not shell text", "app", "project-app", signal, () => {});
    const [command, args, options] = state.spawn.mock.calls[0];
    expect(command).toBe("flock"); expect(args.slice(-6)).toEqual(["/registered/project", "--branch", "agent/change", "A title; not shell text", "app", "project-app"]);
    expect(args).not.toContain("-c"); expect(Object.keys(options.env).some(k => /KEY|TOKEN|SECRET/.test(k))).toBe(false);
    c.stdout.emit("data", "Accepted; not Shipped\n"); c.emit("close", 0);
    expect(await result).toContain("not Shipped");
  });
  it("fails visibly before launch if Claude has not installed the script; no old acceptance fallback", async () => {
    state.installed = false;
    expect(() => runInstalledShip("/registered/project", "--branch", "agent/change", "Title", "app", "project-app", new AbortController().signal, () => {})).toThrow("one-time host installation");
    expect(state.spawn).not.toHaveBeenCalled();
  });
  it("uses the existing service-job lifecycle and does not start a second concurrent submission", async () => {
    const o = setup(), c = child(); const first = await submitChangeJob(o, { title: "Change", branch: "agent/change" });
    await expect(submitChangeJob(o, { title: "Duplicate", branch: "agent/change" })).rejects.toThrow("already running");
    c.emit("close", 1); await turn();
    expect(readJobs(o.jobs)).toHaveLength(1); expect(probeJob(o.jobs, first.job!).exit).toBe(1);
  });
  it("deduplicates an accepted card rollback without launching another host process", async () => {
    const o = setup(); const accepted = { id: "source", acceptedAt: "now", review: { folder: "/registered/project" } } as any;
    state.accepted = [accepted, { id: "revert", rollbackOf: "source" }];
    expect((await requestRollback({ ...o, accepted, reason: "Card click" })).text).toContain("already accepted");
    expect(state.spawn).not.toHaveBeenCalled();
  });
});
