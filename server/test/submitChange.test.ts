/** Thin adapter contracts only: host execution/gates are tested separately, never mocked as release proof. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const state = vi.hoisted(() => ({ spawn: vi.fn(), installed: true }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn: (...args: any[]) => state.spawn(...args) }));
vi.mock("node:fs", async original => { const real = await original<typeof import("node:fs")>(); return { ...real, existsSync: (p: string) => String(p).includes("/.local/lib/vault-chat/simple-ship/") ? state.installed : real.existsSync(p) }; });
vi.mock("../projectFolders", () => ({ projectFolderOf: () => ({ abs: "/registered/project" }) }));
vi.mock("../projectChanges", () => ({ isGatedProject: () => true }));
import { runInstalledShip, shipRetryingCapture, SUBMIT_CHANGE_SCHEMA, submitChangeJob } from "../submitChange";
import { waitKind } from "../engine/waiters";
import { readJobs, probeJob } from "../engine/jobs";
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
    expect(args).not.toContain("-c"); expect(args).not.toContain("-n"); expect(args.slice(0, 4)).toEqual(["-E", "75", "-w", "21600"]); expect(Object.keys(options.env).some(k => /KEY|TOKEN|SECRET/.test(k))).toBe(false);
    c.stdout.emit("data", "Accepted; not Shipped\n"); c.emit("close", 0);
    expect(await result).toContain("not Shipped");
  });
  it("waits for another lane's ship instead of failing; a lock still held after the wait says so", async () => {
    const c = child();
    const result = runInstalledShip("/registered/project", "--branch", "agent/change", "Title", "app", "project-app", new AbortController().signal, () => {});
    c.emit("close", 75);
    await expect(result).rejects.toThrow("Another ship held the ship lock");
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
  it.each(["--rollback", "--failed-release", "recover-published-release"])("rejects retired %s dispatch even from an untyped caller", mode => {
    expect(() => runInstalledShip("/registered/project", mode as "--branch", "id", "Title", "app", "project-app", new AbortController().signal, () => {})).toThrow("Only proven branch");
    expect(state.spawn).not.toHaveBeenCalled();
  });
  it("tries the live-data capture race again by itself, then writes a result WaitFor {branch} wakes on", async () => {
    const o = setup(), results = join(o.vault, "ship-results"), kids: any[] = [];
    state.spawn.mockImplementation(() => { const c = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() }); kids.push(c); return c; });
    const since = Date.now();
    const r = await submitChangeJob({ ...o, results, retry: { delayMs: 1, sleep: async () => {} } }, { title: "Change", branch: "agent/change" });
    await turn(); kids[0].stderr.emit("data", "Error: Fresh stable real-data capture failed; see x\n"); kids[0].emit("close", 1);
    for (let i = 0; i < 5 && kids.length < 2; i++) await turn();
    expect(kids).toHaveLength(2);
    kids[1].stdout.emit("data", "Accepted abc. not Shipped\n"); kids[1].emit("close", 0);
    for (let i = 0; i < 5 && probeJob(o.jobs, r.job!).state === "running"; i++) await turn();
    expect(probeJob(o.jobs, r.job!).exit).toBe(0);
    const ev = await waitKind("branch")!.check({ kind: "branch", args: { branch: "agent/change" }, since } as any, { shipResults: results } as any);
    expect(ev?.text).toMatch(/exit=0[\s\S]*branch=agent\/change[\s\S]*Accepted abc/);
  });
  it("does not retry other failures; their result says exit=1", async () => {
    const o = setup(), results = join(o.vault, "ship-results"), c = child();
    const r = await submitChangeJob({ ...o, results, retry: { sleep: async () => {} } }, { title: "Change", branch: "agent/change" });
    await turn(); c.stderr.emit("data", "new named failure\n"); c.emit("close", 1);
    for (let i = 0; i < 5 && probeJob(o.jobs, r.job!).state === "running"; i++) await turn();
    expect(state.spawn).toHaveBeenCalledTimes(1);
    const files = readdirSync(results);
    expect(files).toHaveLength(1);
    expect(readFileSync(join(results, files[0]!), "utf8")).toMatch(/^exit=1\nbranch=agent\/change\n/);
  });
  it("gives up on the capture race after its tries", async () => {
    let n = 0;
    await expect(shipRetryingCapture(async () => { n++; throw new Error("Fresh stable real-data capture failed"); }, { signal: new AbortController().signal, log: () => {}, tries: 3, sleep: async () => {} })).rejects.toThrow("capture failed");
    expect(n).toBe(3);
  });
});
