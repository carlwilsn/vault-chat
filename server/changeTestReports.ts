/** Parse machine reports produced by installed runner adapters. Never extract allowance names from prose. */
import { isAbsolute, relative } from "node:path";
import type { TestCase } from "./changeProof";

const fileName = (root: string, file: string) => (isAbsolute(file) ? relative(root, file) : file).replace(/\\/g, "/");
export type ParsedTestReport = { tests: TestCase[]; complete: boolean };

/** Vitest's JSON reporter, with full ancestor names. A crashed suite or unhandled error is not a named failure. */
export function parseVitestReport(raw: string, root: string): ParsedTestReport {
  try {
    const report = JSON.parse(raw);
    if (!Array.isArray(report.testResults) || !Number.isInteger(report.numTotalTests) || report.numTotalTests < 1) return { tests: [], complete: false };
    const tests: TestCase[] = [];
    let complete = !report.numRuntimeErrorTestSuites && !(report.unhandledErrors?.length);
    for (const suite of report.testResults) {
      if (!Array.isArray(suite.assertionResults) || !suite.assertionResults.length || !suite.name) { complete = false; continue; }
      for (const t of suite.assertionResults) {
        const status = t.status === "pending" ? "skipped" : t.status;
        if (!["passed", "failed", "skipped", "todo"].includes(status) || typeof t.fullName !== "string" || !t.fullName.trim()) { complete = false; continue; }
        tests.push({ file: fileName(root, suite.name), name: t.fullName, status });
      }
    }
    if (tests.length !== report.numTotalTests || tests.filter((t) => t.status === "failed").length !== report.numFailedTests || tests.filter((t) => t.status === "passed").length !== report.numPassedTests) complete = false;
    return { tests, complete };
  } catch { return { tests: [], complete: false }; }
}

/** NDJSON from the installed harness reporter. Truncation, cancellation and process crashes fail closed. */
export function parseHarnessReport(raw: string, root: string): ParsedTestReport {
  const tests: TestCase[] = [];
  let complete = true, ended = false;
  try {
    for (const line of raw.trim().split("\n")) {
      const e = JSON.parse(line);
      if (ended) return { tests, complete: false };
      if (e.type === "vc:complete") { ended = true; continue; }
      if (!["test:pass", "test:fail"].includes(e.type)) { complete = false; continue; }
      const d = e.data;
      if (!d?.name || !d.file || !d.details) { complete = false; continue; }
      // Parent suite/test aggregate failures are not distinct test failures. Their children carry the names.
      if (d.details.type === "suite" || d.failureType === "subtestsFailed") continue;
      if (d.failureType === "cancelledByParent" || d.processFailure) complete = false;
      tests.push({ file: fileName(root, d.file), name: d.name,
        status: d.skip ? "skipped" : d.todo ? "todo" : e.type === "test:fail" ? "failed" : "passed" });
    }
  } catch { complete = false; }
  return { tests, complete: complete && ended && tests.length > 0 };
}

/** Loaded by node --test-reporter=<host-owned-file>, NOT from the candidate worktree. The service writes this
 * installed literal into its private run directory, and captures the reporter's stdout separately from logs.
 * No imports of candidate code here. node:test wraps test stdout/stderr as events, which are not authority.
 */
export const HARNESS_REPORTER_SOURCE = `export default async function* (source) {
  const paths = new Map();
  for await (const e of source) {
    const d = e.data;
    // Node emits test:start in reporting order, including parent starts before child results, even when
    // execution is concurrent. Keep each file separate; leaf names alone alias tests in different suites.
    if (e.type === "test:start") {
      const path = (paths.get(d.file) || []).slice(0, d.nesting);
      path[d.nesting] = d.name; paths.set(d.file, path); continue;
    }
    if (!["test:pass", "test:fail"].includes(e.type)) continue;
    const path = (paths.get(d.file) || []).slice(0, d.nesting + 1);
    const name = path.length === d.nesting + 1 && path[d.nesting] === d.name
      ? (path.length === 1 ? d.name : JSON.stringify(path)) : null;
    yield JSON.stringify({type:e.type,data:{name,file:d.file,details:{type:d.details?.type},skip:d.skip,todo:d.todo,
      failureType:d.details?.error?.failureType,processFailure:d.details?.error?.exitCode !== undefined || !!d.details?.error?.signal}}) + "\\n";
  }
  yield JSON.stringify({type:"vc:complete"}) + "\\n";
}
`;

/** Runs in the real Vitest coordinator, not a candidate npm script or writable /tmp JSON file.
 * Test console output is worker data, not this reporter's result. Tests remain trusted for their intent;
 * this is not a security boundary against arbitrary hostile code inside the framework's own VM. */
export const VITEST_REPORT_PREFIX = "@@vc-vitest@@";
export const VITEST_REPORTER_SOURCE = `import { JsonReporter } from 'vitest/reporters';
export default class extends JsonReporter {
  errors = [];
  async onFinished(files, errors = [], coverage) {
    this.errors = errors;
    await super.onFinished(files, errors, coverage);
  }
  async writeReport(raw) {
    const report = JSON.parse(raw);
    report.unhandledErrors = this.errors.map(e => String(e?.message || e));
    process.stdout.write("${VITEST_REPORT_PREFIX}" + JSON.stringify(report) + "\\n");
  }
}
`;
