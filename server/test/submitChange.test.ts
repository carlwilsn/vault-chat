/** Request/scope wiring unit tests only. Real sandbox execution and UI recording are changeHost.test.ts. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reapJobs } from "../engine/pi/jobs";
const state = vi.hoisted(() => ({ messages: [] as { mid?: string; role: string; content: string; system?: boolean; hidden?: boolean }[], prove: vi.fn(), pin: vi.fn() }));
vi.mock("../engine/convs", () => ({ readConv: async () => ({ messages: state.messages }) }));
vi.mock("../projectFolders", () => ({ projectFolderOf: () => ({ abs: "/chosen/project" }) }));
vi.mock("../projectChanges", () => ({ cloneDirOf: () => "/service/agent-clone", isGatedProject: () => true }));
vi.mock("../changeHost", () => ({ pinChange: (...a: unknown[]) => state.pin(...a), proveAndAcceptChange: (...a: unknown[]) => state.prove(...a) }));
import { submitChangeJob, SUBMIT_CHANGE_SCHEMA, type SubmitChangeArgs } from "../submitChange";
const dirs: string[] = [];
const setup = () => { const dir = mkdtempSync(join(tmpdir(), "vc-submit-unit-")); dirs.push(dir); return { vault: dir, convId: "project-repo", byCarl: true, jobs: { logDir: join(dir, "jobs"), wrap: null, env: {} }, host: { shell: ["installed-bwrap", "--"], home: "/home/test", installedEntry: "/installed/service.mjs", dependencies: "/installed/deps", dependencyLock: "/installed/package-lock.json", node: "/installed/node", npm: "/installed/npm", path: "/installed/bin" } }; };
const args: SubmitChangeArgs = { title: "Requested change", assessment: "Explicit self-check", evidence: ["implementation location"], surface: "phone", ui: { steps: [{ click: "button" }, { waitFor: "main" }] } };
const settled = () => new Promise<void>(r => setImmediate(r));
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.clearAllMocks(); });
function prepare() {
  state.messages = [{ mid: "real-user-ask", role: "user", content: "Carl's actual request" }, { mid: "wake", role: "user", content: "not the ask", system: true }, { mid: "hidden", role: "user", content: "not Carl", hidden: true }];
  state.pin.mockResolvedValue({ source: { base: "base", head: "head" }, review: {} });
  state.prove.mockImplementation(async (_host, _pins, _ask, _check, assertRequest) => { await assertRequest(); return { accepted: true, text: "Accepted, not Shipped", proofDir: "/host/proof" }; });
}
describe("native submission request and scope boundary", () => {
  it("captures last actual user identity/text from the existing conversation, never model arguments", async () => {
    prepare(); const o = setup();
    const result = await submitChangeJob(o, { ...args, requestText: "model-invented ask", requestId: "invented" } as SubmitChangeArgs);
    expect(result.job?.kind).toBe("service"); await settled();
    expect(state.pin).toHaveBeenCalledWith(expect.objectContaining({ folder: "/chosen/project", clone: "/service/agent-clone", convId: o.convId, slug: "repo" }));
    expect(state.prove.mock.calls[0]?.[2]).toEqual({ requestId: "real-user-ask", requestText: "Carl's actual request", assessment: args.assessment, evidence: args.evidence });
    expect(reapJobs(o.jobs)[0]).toMatchObject({ state: "finished", exit: 0, tail: expect.stringContaining("not Shipped") });
  });
  it("fails when the last user request changes during gates, rather than accepting under a stale ask", async () => {
    prepare(); const o = setup(); let finish!: () => void;
    const held = new Promise<void>(r => { finish = r; });
    state.prove.mockImplementation(async (_host, _pins, _ask, _check, assertRequest) => { await held; await assertRequest(); throw new Error("must not accept"); });
    await submitChangeJob(o, args); await settled();
    state.messages.push({ mid: "new-user-request", role: "user", content: "Do something different" }); finish(); await settled();
    expect(reapJobs(o.jobs)[0]).toMatchObject({ state: "finished", exit: 1, tail: expect.stringContaining("last request changed") });
  });
  it("does not start two jobs for concurrent submissions, and rejects missing user identity", async () => {
    prepare(); const o = setup(); const result = await Promise.allSettled([submitChangeJob(o, args), submitChangeJob(o, args)]);
    expect(result.filter(r => r.status === "fulfilled")).toHaveLength(1); await settled(); reapJobs(o.jobs);
    state.messages = [{ role: "user", content: "unidentified" }];
    await expect(submitChangeJob(o, args)).rejects.toThrow("last user request");
  });
  it("does not expose host authority or source/request provenance fields as tool inputs", () => {
    expect(SUBMIT_CHANGE_SCHEMA.additionalProperties).toBe(false);
    for (const key of ["requestId", "requestText", "permit", "tests", "command", "shell", "folder", "head", "url", "proof"]) expect(Object.keys(SUBMIT_CHANGE_SCHEMA.properties)).not.toContain(key);
    expect(Object.keys(SUBMIT_CHANGE_SCHEMA.properties.ui.properties)).not.toContain("url");
  });
});
