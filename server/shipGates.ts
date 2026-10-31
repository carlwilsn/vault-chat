/** Fixed seven gates and existing named-case comparison. No proof identities or permits. */
export const CHANGE_GATES = [
  "typecheck:desktop", "typecheck:phone", "typecheck:board", "typecheck:server",
  "test:harness", "test:server", "build:server",
] as const;
export type ChangeGate = typeof CHANGE_GATES[number];
export type TestCase = { file: string; name: string; status: "passed" | "failed" | "skipped" | "todo" };
export type GateExecution = { exitCode: number; logArtifact: string; tests?: TestCase[]; complete: boolean; timedOut?: boolean };
export type GateReceipt = GateExecution & { gate: ChangeGate };
const testKey = (t: TestCase) => JSON.stringify([t.file.replace(/\\/g, "/"), t.name]);
function cases(r: GateReceipt): Map<string, TestCase> {
  if (!r.tests?.length) throw new Error(`${r.gate}: missing or empty structured test report`);
  const out = new Map<string, TestCase>();
  for (const t of r.tests) {
    if (!t.file?.trim() || !t.name?.trim() || !["passed", "failed", "skipped", "todo"].includes(t.status)) throw new Error(`${r.gate}: malformed named test result`);
    const file = t.file.replace(/\\/g, "/");
    if (file.startsWith("/") || /^[A-Za-z]:/.test(file) || file.split("/").includes("..")) throw new Error(`${r.gate}: test identity outside pinned source`);
    const k = testKey(t);
    if (out.has(k)) throw new Error(`${r.gate}: ambiguous duplicate test identity ${k}`);
    out.set(k, t);
  }
  if (!r.tests.some((t) => t.status === "passed" || t.status === "failed")) throw new Error(`${r.gate}: no tests executed`);
  const failed = r.tests.some((t) => t.status === "failed");
  // Errors before/after test execution (or a runner crash) must not be laundered as known failures.
  if ((r.exitCode === 0) === failed || ![0, 1].includes(r.exitCode)) throw new Error(`${r.gate}: exit code does not match structured test report`);
  return out;
}

/** Same named failures ONLY. Equal failure counts are insufficient. Removed/passing→skipped tests regress.
 * Non-test commands must succeed on both sources; a broken baseline/build is never an allowance to ship.
 */
export function compareChangeGates(baseline: readonly GateReceipt[], candidate: readonly GateReceipt[]): void {
  for (const list of [baseline, candidate]) {
    if (list.length !== CHANGE_GATES.length || new Set(list.map((r) => r.gate)).size !== CHANGE_GATES.length) throw new Error("Missing or duplicate required gate");
  }
  for (const gate of CHANGE_GATES) {
    const b = baseline.find((r) => r.gate === gate), c = candidate.find((r) => r.gate === gate);
    if (!b || !c) throw new Error(`Missing gate ${gate}`);
    if ([b, c].some((r) => !r.complete || r.timedOut || !r.logArtifact?.trim() || !Number.isInteger(r.exitCode))) throw new Error(`${gate}: incomplete, unavailable or timed-out check`);
    if (!gate.startsWith("test:")) {
      if (b.exitCode !== 0 || c.exitCode !== 0) throw new Error(`${gate}: command must pass on baseline and candidate`);
      continue;
    }
    const before = cases(b), after = cases(c);
    for (const [key, test] of before) {
      const next = after.get(key);
      if (!next) {
        throw new Error(`${gate}: removed test ${key}`);
      }
      if (["passed", "failed"].includes(test.status) && ["skipped", "todo"].includes(next.status)) throw new Error(`${gate}: previously executed test no longer runs ${key}`);
    }
    for (const [key, test] of after) {
      if (test.status === "failed" && before.get(key)?.status !== "failed") throw new Error(`${gate}: new named failure ${key}`);
      if (["skipped", "todo"].includes(test.status) && before.get(key)?.status !== test.status) throw new Error(`${gate}: new skipped/todo test ${key}`);
    }
  }
}
