import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHANGE_GATES, compareChangeGates, type GateExecution, type GateReceipt } from "../shipGates";
import { HARNESS_REPORTER_SOURCE, parseHarnessReport, parseVitestReport } from "../changeTestReports";
function fixture(): GateReceipt[] {
  return CHANGE_GATES.map(gate => ({ gate, exitCode: gate.startsWith("test:") ? 1 : 0,
    logArtifact: `/host/${gate}.log`, complete: true,
    ...(gate.startsWith("test:") ? { tests: [{ file: "test/file.test.ts", name: "known failing test", status: "failed" as const }, { file: "test/file.test.ts", name: "passing test", status: "passed" as const }] } : {}),
  }));
}
describe("same named failures, never just a count", () => {
  function changed(mutate: (r: GateExecution) => void) {
    const baseline = fixture(), candidate = structuredClone(baseline);
    mutate(candidate.find(r => r.gate === "test:server")!);
    return { check: () => compareChangeGates(baseline, candidate) };
  }
  it("allows fixes and additional passing tests", async () => {
    const f = changed((r) => { r.tests![0]!.status = "passed"; r.tests!.push({ file: "test/new.test.ts", name: "additional passing coverage", status: "passed" }); r.exitCode = 0; });
    expect(f.check).not.toThrow();
  });
  it("refuses a different named failure even at exactly the baseline failure count", async () => {
    const f = changed((r) => { r.tests![0]!.status = "passed"; r.tests![1]!.status = "failed"; });
    expect(f.check).toThrow("new named failure");
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
    expect(changed(mutation).check).toThrow();
  });
  it("only the internal native-revert comparison allows removals; all remaining checks stay strict", () => {
    const baseline = fixture(), candidate = fixture();
    candidate.find(r => r.gate === "test:server")!.tests!.pop();
    expect(() => compareChangeGates(baseline, candidate)).toThrow("removed test");
    expect(() => compareChangeGates(baseline, candidate, true)).not.toThrow();
    for (const mutate of [
      (r: GateReceipt) => { r.tests![0].status = "skipped"; r.exitCode = 0; },
      (r: GateReceipt) => { r.tests!.push({ file: "new.ts", name: "new failure", status: "failed" }); },
      (r: GateReceipt) => { r.tests!.push({ file: "new.ts", name: "new skip", status: "skipped" }); },
      (r: GateReceipt) => { r.tests!.push({ file: "new.ts", name: "new todo", status: "todo" }); },
      (r: GateReceipt) => { r.exitCode = 137; },
      (r: GateReceipt) => { r.timedOut = true; },
      (r: GateReceipt) => { r.complete = false; },
      (r: GateReceipt) => { r.tests = []; },
    ]) {
      const bad = structuredClone(candidate); mutate(bad.find(r => r.gate === "test:server")!);
      expect(() => compareChangeGates(baseline, bad, true)).toThrow();
    }
    for (const gate of CHANGE_GATES.filter(g => !g.startsWith("test:"))) {
      const bad = structuredClone(candidate); bad.find(r => r.gate === gate)!.exitCode = 1;
      expect(() => compareChangeGates(baseline, bad, true)).toThrow("must pass");
    }
  });
  it("requires build/typecheck success even when the same command failed on main", async () => {
    const baseline = fixture(), candidate = fixture();
    baseline.find(r => r.gate === "build:server")!.exitCode = 1;
    expect(() => compareChangeGates(baseline, candidate)).toThrow("must pass on baseline and candidate");
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
