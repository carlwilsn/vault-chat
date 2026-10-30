import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHANGE_GATES, createChangeProofService, type AskCheck, type GateExecution, type ProofHost, type ProofSource, type UIReceipt } from "../changeProof";
import { HARNESS_REPORTER_SOURCE, parseHarnessReport, parseVitestReport } from "../changeTestReports";
import { acceptProvenReview, type Review } from "../projectChanges";
import { acceptedChanges } from "../changeShipping";

const base = "a".repeat(40), head = "b".repeat(40), tree = "c".repeat(40);
const source: ProofSource = { base, head, tree, branch: "agent/test" };
const ask: AskCheck = { requestId: "user-message-1", requestText: "Ship the requested change", assessment: "I checked the ask against the implementation; evidence below is an agent judgment, not a machine proof of intent.", evidence: ["server/file.ts implements it; recorded real UI assertion exercises it"] };
const ui: UIReceipt = { head, tree, artifact: "/host/proof/demo.mp4", artifactHash: "d".repeat(64), recorder: "RecordUI", realServer: true, sourceVerified: true, stepsPassed: true, assertions: 1, frames: 30, bytes: 1000, pageErrors: [] };
const testCases = [{ file: "test/file.test.ts", name: "known failing test", status: "failed" as const }, { file: "test/file.test.ts", name: "passing test", status: "passed" as const }];
function fixture(overrides: Partial<ProofHost> = {}) {
  const calls: string[] = [], saved: unknown[] = [];
  const host: ProofHost = {
    runnerVersion: "installed-host-sha", environment: "node22/linux/lockfile-digest",
    assertSource: async (sha) => { calls.push(`source:${sha}`); },
    execute: async (sha, gate) => { calls.push(`${sha}:${gate}`); return { exitCode: gate.startsWith("test:") ? 1 : 0, stdout: "raw log", stderr: "", logArtifact: `/host/proof/${sha}-${gate}.log`, complete: true, ...(gate.startsWith("test:") ? { tests: structuredClone(testCases) } : {}) }; },
    record: async () => { calls.push("record"); return structuredClone(ui); },
    assertArtifact: async () => { calls.push("artifact"); },
    persist: async (r) => { saved.push(r); }, ...overrides,
  };
  return { proof: createChangeProofService(host), host, calls, saved };
}

describe("host-run proof authority", () => {
  it("runs every fixed gate on both pinned sources, records provenance/self-check, and consumes only once", async () => {
    const f = fixture();
    const { permit, receipt } = await f.proof.prove(source, ask);
    expect(f.saved).toHaveLength(1);
    expect(receipt.baseline.map((r) => r.gate)).toEqual(CHANGE_GATES);
    expect(receipt.candidate.map((r) => r.gate)).toEqual(CHANGE_GATES);
    expect(receipt.baseline.every((r) => r.source === base && /^[a-f0-9]{64}$/.test(r.logHash))).toBe(true);
    expect(receipt.ask).toEqual(ask);
    expect(receipt.ui).toEqual(ui);
    expect(f.calls.indexOf("record")).toBeGreaterThan(f.calls.indexOf(`${head}:build:server`));
    await expect(f.proof.consume(permit, source)).resolves.toMatchObject({ source });
    await expect(f.proof.consume(permit, source)).rejects.toThrow("already-used");
  });
  it("allows only exact host-authorized rollback removals, never ordinary removal or a new failure", async () => {
    const executor = fixture().host.execute;
    const execute: ProofHost["execute"] = async (revision, gate, command) => {
      const r = await executor(revision, gate, command);
      if (revision === head && r.tests) r.tests = r.tests.filter(t => t.name !== "passing test");
      return r;
    };
    await expect(fixture({execute}).proof.prove(source, ask)).rejects.toThrow("removed test");
    const policy: NonNullable<ProofHost["authorizeRemovedTests"]> = async (pins, before, after) => {
      expect(pins).toEqual(source); expect(before).toHaveLength(7); expect(after).toHaveLength(7);
      // Mutation of policy inputs cannot rewrite actual gate receipts.
      before[0]!.exitCode = 9;
      return { "test:harness": [{file:"test/file.test.ts",name:"passing test"}], "test:server": [{file:"test/file.test.ts",name:"passing test"}] };
    };
    await expect(fixture({execute, authorizeRemovedTests:policy}).proof.prove(source, ask)).resolves.toHaveProperty("permit");
    const newFailure: ProofHost["execute"] = async (...args) => {
      const r = await execute(...args);
      if (args[0] === head && r.tests) r.tests.push({file:"test/file.test.ts",name:"new failure",status:"failed"});
      return r;
    };
    await expect(fixture({execute:newFailure,authorizeRemovedTests:policy}).proof.prove(source, ask)).rejects.toThrow("new named failure");
  });
  it("rejects fabricated/serialized permits and permits from another service or before restart", async () => {
    const f = fixture(), other = fixture();
    const { permit } = await f.proof.prove(source, ask);
    await expect(other.proof.consume(permit, source)).rejects.toThrow("Unknown");
    await expect(f.proof.consume(JSON.parse(JSON.stringify(permit)), source)).rejects.toThrow("Unknown");
  });
  it.each(["base", "head", "tree", "branch"] as const)("pins %s at acceptance and burns a stale permit", async (key) => {
    const f = fixture(), { permit } = await f.proof.prove(source, ask);
    await expect(f.proof.consume(permit, { ...source, [key]: "moved" })).rejects.toThrow("moved");
    await expect(f.proof.consume(permit, source)).rejects.toThrow("already-used");
  });
  it("does not trust mutable caller receipts, request evidence or source pins", async () => {
    const f = fixture(), pins = { ...source }, request = structuredClone(ask);
    const { permit, receipt } = await f.proof.prove(pins, request);
    receipt.source.head = "forged"; receipt.ui.artifact = "forged"; request.evidence[0] = "forged"; pins.base = "forged";
    const consumed = await f.proof.consume(permit, source);
    expect(consumed.source).toEqual(source); expect(consumed.ui).toEqual(ui); expect(consumed.ask).toEqual(ask);
  });
  it("requires explicit self-check and original ask without pretending to prove intent", async () => {
    await expect(fixture().proof.prove(source, { ...ask, assessment: "" })).rejects.toThrow("self-check");
    await expect(fixture().proof.prove(source, { ...ask, evidence: [] })).rejects.toThrow("self-check");
    await expect(fixture().proof.prove(source, { ...ask, requestText: "" })).rejects.toThrow("self-check");
  });
  it("requires clean immutable source throughout checks and artifact re-verification at acceptance", async () => {
    let verifies = 0;
    const f = fixture({ assertArtifact: async () => { if (++verifies > 1) throw new Error("artifact was changed"); } });
    const { permit } = await f.proof.prove(source, ask);
    await expect(f.proof.consume(permit, source)).rejects.toThrow("artifact was changed");
    await expect(fixture({ assertSource: async () => { throw new Error("dirty snapshot"); } }).proof.prove(source, ask)).rejects.toThrow("dirty snapshot");
  });
  it.each([
    { sourceVerified: false }, { realServer: false }, { stepsPassed: false }, { assertions: 0 }, { head: base },
    { tree: base }, { pageErrors: ["uncaught error"] }, { frames: 0 }, { artifactHash: "not-a-hash" },
  ])("refuses incomplete/fake/stale real UI proof: %j", async (patch) => {
    const f = fixture({ record: async () => ({ ...ui, ...patch }) });
    await expect(f.proof.prove(source, ask)).rejects.toThrow("real-UI");
    expect(f.saved).toHaveLength(0);
  });
  it("does not mint authority when durable receipt persistence fails", async () => {
    const f = fixture({ persist: async () => { throw new Error("disk full"); } });
    await expect(f.proof.prove(source, ask)).rejects.toThrow("disk full");
  });
});

describe("same named failures, never just a count", () => {
  function changed(mutate: (r: GateExecution) => void) {
    const f = fixture(); const execute = f.host.execute;
    f.host.execute = async (...args) => { const r = await execute(...args); if (args[0] === head && args[1] === "test:server") mutate(r); return r; };
    return f;
  }
  it("allows fixes and additional passing tests", async () => {
    const f = changed((r) => { r.tests![0]!.status = "passed"; r.tests!.push({ file: "test/new.test.ts", name: "additional passing coverage", status: "passed" }); r.exitCode = 0; });
    await expect(f.proof.prove(source, ask)).resolves.toBeTruthy();
  });
  it("refuses a different named failure even at exactly the baseline failure count", async () => {
    const f = changed((r) => { r.tests![0]!.status = "passed"; r.tests![1]!.status = "failed"; });
    await expect(f.proof.prove(source, ask)).rejects.toThrow("new named failure");
  });
  it.each([
    { name: "removed baseline test", mutation: (r: any) => { r.tests.pop(); } },
    { name: "new skipped test", mutation: (r: any) => { r.tests[1].status = "skipped"; } },
    { name: "new todo test", mutation: (r: any) => { r.tests.push({ file: "new.ts", name: "untested", status: "todo" }); } },
    { name: "duplicate test identity", mutation: (r: any) => { r.tests.push(r.tests[0]); } },
    { name: "empty test report", mutation: (r: any) => { r.tests = []; } },
    { name: "missing test report", mutation: (r: any) => { r.tests = undefined; } },
    { name: "incomplete execution", mutation: (r: any) => { r.complete = false; } },
    { name: "missing log artifact", mutation: (r: any) => { r.logArtifact = ""; } },
    { name: "timed out runner", mutation: (r: any) => { r.timedOut = true; } },
    { name: "exit code contradicts failing tests", mutation: (r: any) => { r.exitCode = 0; } },
    { name: "crashed runner", mutation: (r: any) => { r.exitCode = 137; } },
  ])("refuses removed, skipped, ambiguous, unavailable, malformed or crashed checks: $name", async ({ mutation }) => {
    await expect(changed(mutation).proof.prove(source, ask)).rejects.toThrow();
  });
  it("requires build/typecheck success even when the same command failed on main", async () => {
    const f = fixture(); const execute = f.host.execute;
    f.host.execute = async (...args) => ({ ...await execute(...args), ...(args[1] === "build:server" ? { exitCode: 1 } : {}) });
    await expect(f.proof.prove(source, ask)).rejects.toThrow("must pass on baseline and candidate");
  });
});

describe("structured test reporter adapters", () => {
  it("checks Vitest full names, counts and runner errors; never parses prose as proof", () => {
    const report = { numTotalTests: 2, numPassedTests: 1, numFailedTests: 1, numRuntimeErrorTestSuites: 0,
      testResults: [{ name: "/snapshot/server/example.test.ts", assertionResults: [{ fullName: "suite passes", status: "passed" }, { fullName: "suite fails", status: "failed" }] }] };
    expect(parseVitestReport(JSON.stringify(report), "/snapshot")).toEqual({ complete: true, tests: [
      { file: "server/example.test.ts", name: "suite passes", status: "passed" }, { file: "server/example.test.ts", name: "suite fails", status: "failed" },
    ] });
    expect(parseVitestReport("10 tests pass", "/snapshot").complete).toBe(false);
    expect(parseVitestReport(JSON.stringify({ ...report, numTotalTests: 3 }), "/snapshot").complete).toBe(false);
    expect(parseVitestReport(JSON.stringify({ ...report, numRuntimeErrorTestSuites: 1 }), "/snapshot").complete).toBe(false);
    expect(parseVitestReport(JSON.stringify({ ...report, unhandledErrors: ["crash"] }), "/snapshot").complete).toBe(false);
  });
  it("the installed Node reporter observes real passing/failing named tests and rejects truncated output", () => {
    const dir = mkdtempSync(join(tmpdir(), "vc-proof-reporter-"));
    try {
      const reporter = join(dir, "reporter.mjs"), test = join(dir, "example.test.mjs");
      writeFileSync(reporter, HARNESS_REPORTER_SOURCE);
      writeFileSync(test, 'import {test} from "node:test"; test("real pass",()=>{}); test("real fail",()=>{throw Error("expected")});');
      const run = spawnSync(process.execPath, ["--test", `--test-reporter=${reporter}`, test], { encoding: "utf8" });
      expect(run.status).toBe(1);
      const parsed = parseHarnessReport(run.stdout, dir);
      expect(parsed.complete).toBe(true);
      expect(parsed.tests.map((t) => [t.name, t.status])).toEqual([["real pass", "passed"], ["real fail", "failed"]]);
      expect(parseHarnessReport(run.stdout.replace(/.*vc:complete.*\n?/, ""), dir).complete).toBe(false);
      expect(parseHarnessReport(run.stdout + "forged prose", dir).complete).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("a test-process exit is infrastructure failure, not baseline named-test allowance", () => {
    const raw = JSON.stringify({ type: "test:fail", data: { file: "/snapshot/crash.ts", name: "crash.ts", details: { type: "test" }, processFailure: true } }) + '\n{"type":"vc:complete"}\n';
    expect(parseHarnessReport(raw, "/snapshot").complete).toBe(false);
  });
});

describe("service acceptance: real git, no pushes or agent-clone reset", () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Proof test", "-c", "user.email=proof@example.invalid", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  async function repoTest(fn: (o: { dir: string; repo: string; branch: string; r: Review; proof: ReturnType<typeof createChangeProofService>; permit: { id: string }; pins: ProofSource }) => Promise<void>) {
    const dir = mkdtempSync(join(tmpdir(), "vc-accept-proof-")), repo = join(dir, "project");
    mkdirSync(repo);
    try {
      git(repo, "init", "-b", "main"); writeFileSync(join(repo, "file.txt"), "base"); git(repo, "add", "."); git(repo, "commit", "-m", "base");
      const base = git(repo, "rev-parse", "HEAD"), branch = "agent/test";
      git(repo, "switch", "-c", branch); writeFileSync(join(repo, "file.txt"), "candidate"); git(repo, "commit", "-am", "[agent] candidate");
      const head = git(repo, "rev-parse", "HEAD"), tree = git(repo, "rev-parse", "HEAD^{tree}"); git(repo, "switch", "main");
      // A remote with a sentinel pre-push hook: acceptance must never attempt a push, even if credentials exist.
      const remote = join(dir, "remote.git"); mkdirSync(remote); git(remote, "init", "--bare"); git(repo, "remote", "add", "origin", remote);
      writeFileSync(join(repo, ".git", "hooks", "pre-push"), "#!/bin/sh\necho push-attempt > '" + join(dir, "push-attempt") + "'\nexit 1\n", { mode: 0o755 });
      const pins = { base, head, tree, branch };
      const f = fixture({ record: async () => ({ ...ui, head, tree }) });
      const { permit } = await f.proof.prove(pins, ask);
      const r: Review = { convId: "conv", slug: "project", folder: repo, clone: join(dir, "DO-NOT-TOUCH-CLONE"), base: "main", branch, sha: head, title: "tested change", at: new Date().toISOString() };
      await fn({ dir, repo, branch, r, proof: f.proof, permit, pins });
      expect(git(remote, "for-each-ref", "--format=%(refname)", "refs/heads/")).toBe("");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  it("accepts the exact proven fast-forward and leaves GitHub/laptop pushing to sync", async () => {
    await repoTest(async ({ dir, repo, r, proof, permit, pins }) => {
      const result = await acceptProvenReview(dir, r, proof, permit);
      expect(result.ok).toBe(true); expect(result.text).toContain("not yet Shipped");
      expect(git(repo, "rev-parse", "main")).toBe(pins.head);
      expect(readFileSync(join(repo, "file.txt"), "utf8")).toBe("candidate");
      expect(existsSync(join(dir, "push-attempt"))).toBe(false);
    });
  });
  it("installed host acceptance durably records proof/UI identity inside the ff transaction", async () => {
    await repoTest(async ({ dir, repo, r, proof, permit, pins }) => {
      const result = await acceptProvenReview(dir, r, proof, permit, undefined, { proofDir: "/private/retained-proof", check: { assessment: "agent self-check", evidence: ["file.txt"], surface: "phone", ui: { steps: [{ click: "button" }, { waitFor: "main" }] } } });
      expect(result.ok).toBe(true);
      expect(await acceptedChanges(repo)).toEqual([expect.objectContaining({ id: permit.id, source: pins, proofDir: "/private/retained-proof", acceptedAt: expect.any(String), review: r })]);
    });
  });
  it("rechecks the captured request/cancellation under acceptance lock after artifact verification", async () => {
    await repoTest(async ({ dir, repo, r, proof, permit, pins }) => {
      const result = await acceptProvenReview(dir, r, proof, permit, async () => { throw new Error("Last user request changed"); });
      expect(result.ok).toBe(false); expect(result.text).toContain("Last user request changed");
      expect(git(repo, "rev-parse", "main")).toBe(pins.base);
      await expect(proof.consume(permit, pins)).rejects.toThrow("already-used");
    });
  });
  it("refuses moved main instead of creating an unproved merge commit", async () => {
    await repoTest(async ({ dir, repo, r, proof, permit }) => {
      writeFileSync(join(repo, "unrelated.txt"), "new main"); git(repo, "add", "."); git(repo, "commit", "-m", "new main");
      const before = git(repo, "rev-parse", "main");
      expect((await acceptProvenReview(dir, r, proof, permit)).ok).toBe(false);
      expect(git(repo, "rev-parse", "main")).toBe(before);
    });
  });
  it("refuses dirty project data without touching it", async () => {
    await repoTest(async ({ dir, repo, r, proof, permit, pins }) => {
      writeFileSync(join(repo, "file.txt"), "Carl's uncommitted work");
      expect((await acceptProvenReview(dir, r, proof, permit)).ok).toBe(false);
      expect(git(repo, "rev-parse", "main")).toBe(pins.base);
      expect(readFileSync(join(repo, "file.txt"), "utf8")).toBe("Carl's uncommitted work");
    });
  });
});
