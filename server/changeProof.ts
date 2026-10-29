/** Service-owned shipping proof. Tool arguments (including test summaries and file paths) are NOT receipts.
 * The installed host supplies the isolated executor and recorder. Only executions observed here can mint a
 * single-use permit; restarting loses permits and requires a rerun. No model-authored attestation is accepted.
 * This foundation intentionally has no deployment/HTTP/tool entry point until the host adapters are wired.
 */
import { createHash, randomUUID } from "node:crypto";

export const CHANGE_GATES = [
  "typecheck:desktop", "typecheck:phone", "typecheck:board", "typecheck:server",
  "test:harness", "test:server", "build:server",
] as const;
export type ChangeGate = typeof CHANGE_GATES[number];
export const CHANGE_COMMANDS: Readonly<Record<ChangeGate, readonly string[]>> = Object.freeze({
  "typecheck:desktop": ["npx", "--no-install", "tsc", "--noEmit", "-p", "."],
  "typecheck:phone": ["npm", "run", "typecheck:phone"],
  "typecheck:board": ["npm", "run", "typecheck:board"],
  "typecheck:server": ["npm", "run", "typecheck:server"],
  "test:harness": ["npm", "run", "test:harness"],
  "test:server": ["npm", "run", "test:server"],
  "build:server": ["npm", "run", "build:server"],
});
for (const command of Object.values(CHANGE_COMMANDS)) Object.freeze(command);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const commit = (s: string) => /^[a-f0-9]{40}$/.test(s);
export type ProofSource = { base: string; head: string; tree: string; branch: string };
export type TestCase = { file: string; name: string; status: "passed" | "failed" | "skipped" | "todo" };
export type GateExecution = {
  exitCode: number; stdout: string; stderr: string;
  /** Host-owned durable full log, not a model-selected path or a clipped tool response. */
  logArtifact: string;
  /** The adapter derives cases from a complete structured runner report, NOT log regexes or agent input. */
  tests?: TestCase[];
  complete: boolean; timedOut?: boolean;
};
export type GateReceipt = {
  gate: ChangeGate; command: readonly string[]; source: string;
  startedAt: string; finishedAt: string; exitCode: number; logHash: string; logArtifact: string;
  tests?: TestCase[]; complete: boolean; timedOut: boolean;
};
export type AskCheck = {
  /** Verbatim request identity/text captured by the host from the conversation. */
  requestId: string; requestText: string;
  /** Explicit agent judgment, not a claim that a machine proved intent. */
  assessment: string; evidence: string[];
};
export type UIReceipt = {
  head: string; tree: string; artifact: string; artifactHash: string;
  /** Installed recorder result AND host-verified candidate instance provenance. */
  recorder: "RecordUI"; realServer: boolean; sourceVerified: boolean;
  stepsPassed: boolean; assertions: number; frames: number; bytes: number; pageErrors: string[];
};
export type ChangeReceipt = {
  id: string; source: ProofSource; runnerVersion: string; environment: string;
  baseline: GateReceipt[]; candidate: GateReceipt[]; ui: UIReceipt; ask: AskCheck;
};
/** Deliberately opaque and non-serializable authority: JSON read from disk cannot be a permit. */
export type ChangePermit = { readonly id: string };
export type RemovedTestAllowance = Partial<Record<ChangeGate, readonly Pick<TestCase, "file" | "name">[]>>;
/** Installed recovery policy verifies an exact service-generated revert and original receipt; never tool input. */
export type RollbackTestPolicy = (source: ProofSource, baseline: readonly GateReceipt[], candidate: readonly GateReceipt[]) => Promise<RemovedTestAllowance>;
export type ProofHost = {
  authorizeRemovedTests?: RollbackTestPolicy;
  /** Assert a clean immutable snapshot (including HEAD/tree) before AND after execution. */
  assertSource(source: string): Promise<void>;
  /** Same installed toolchain/dependencies/environment for both runs, sandboxed without live ports or secrets.
   * Keep complete raw command logs in host-owned storage; return only machine-parsed reports here. */
  execute(source: string, gate: ChangeGate, command: readonly string[]): Promise<GateExecution>;
  record(source: ProofSource): Promise<UIReceipt>;
  /** Re-hash/decode the actual artifact in host-owned storage immediately before acceptance. */
  assertArtifact(ui: UIReceipt): Promise<void>;
  persist(receipt: ChangeReceipt): Promise<void>;
  runnerVersion: string; environment: string;
};

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
export function compareChangeGates(baseline: readonly GateReceipt[], candidate: readonly GateReceipt[], removed: RemovedTestAllowance = {}): void {
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
        if (removed[gate]?.some(t => testKey({ ...t, status: "passed" }) === key)) continue;
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

function assertUI(ui: UIReceipt, source: ProofSource): void {
  if (ui.head !== source.head || ui.tree !== source.tree || ui.recorder !== "RecordUI" || !ui.realServer || !ui.sourceVerified || !ui.stepsPassed || !Number.isInteger(ui.assertions) || ui.assertions < 1 || !Number.isInteger(ui.frames) || ui.frames < 2 || !Number.isInteger(ui.bytes) || ui.bytes < 1 || ui.pageErrors.length || !ui.artifact || !/^[a-f0-9]{64}$/.test(ui.artifactHash)) throw new Error("Missing successful recorded real-UI proof bound to this source");
}

export function createChangeProofService(host: ProofHost) {
  const permits = new WeakMap<ChangePermit, ChangeReceipt>();
  async function run(source: string): Promise<GateReceipt[]> {
    await host.assertSource(source);
    const receipts: GateReceipt[] = [];
    for (const gate of CHANGE_GATES) {
      const startedAt = new Date().toISOString();
      // Freeze argument arrays too: a runner adapter must not be able to mutate the policy for later gates.
      const command = Object.freeze([...CHANGE_COMMANDS[gate]]);
      const r = await host.execute(source, gate, command);
      receipts.push({ gate, source, command, startedAt, finishedAt: new Date().toISOString(), exitCode: r.exitCode,
        logHash: sha(JSON.stringify([r.stdout, r.stderr])), logArtifact: r.logArtifact, complete: r.complete, timedOut: r.timedOut === true,
        ...(r.tests ? { tests: structuredClone(r.tests) } : {}), });
      await host.assertSource(source);
    }
    return receipts;
  }
  return {
    /** Host resolves these pins from git and the request from the conversation, not from tool-supplied claims. */
    async prove(source: ProofSource, ask: AskCheck): Promise<{ permit: ChangePermit; receipt: ChangeReceipt }> {
      if (![source.base, source.head, source.tree].every(commit) || source.base === source.head || !/^agent\/[a-z0-9][a-z0-9._/-]{0,60}$/.test(source.branch)) throw new Error("Expected pinned base/head/tree and an agent branch");
      if (!ask.requestId?.trim() || !ask.requestText?.trim() || !ask.assessment?.trim() || !ask.evidence.length || ask.evidence.some((s) => !s.trim())) throw new Error("Include the original ask and an explicit agent self-check with evidence; intent is not machine-provable");
      if (!host.runnerVersion.trim() || !host.environment.trim()) throw new Error("Missing installed runner/toolchain identity");
      // Copy immediately: callers cannot change pins while long gates run.
      source = structuredClone(source); ask = structuredClone(ask);
      const baseline = await run(source.base), candidate = await run(source.head);
      const removed = host.authorizeRemovedTests ? await host.authorizeRemovedTests(structuredClone(source), structuredClone(baseline), structuredClone(candidate)) : {};
      compareChangeGates(baseline, candidate, removed);
      const ui = structuredClone(await host.record(source));
      assertUI(ui, source);
      await host.assertArtifact(ui);
      await host.assertSource(source.head);
      const receipt: ChangeReceipt = { id: randomUUID(), source, runnerVersion: host.runnerVersion, environment: host.environment, baseline, candidate, ui, ask };
      await host.persist(structuredClone(receipt));
      const permit = Object.freeze({ id: receipt.id });
      permits.set(permit, structuredClone(receipt));
      return { permit, receipt: structuredClone(receipt) };
    },
    /** Call ONLY inside the existing project repo lock. Pins must still match immediately before ff-only.
     * A lost/stale permit cannot be retried. Recollect against the new main; never merge an unproved tree.
     */
    async consume(permit: ChangePermit, pins: ProofSource): Promise<ChangeReceipt> {
      const r = permits.get(permit);
      if (!r) throw new Error("Unknown, expired or already-used proof permit; rerun the host proof gates");
      permits.delete(permit);
      if (Object.keys(r.source).some((k) => r.source[k as keyof ProofSource] !== pins[k as keyof ProofSource])) throw new Error("Source/main moved since proof; rerun against current main");
      await host.assertSource(r.source.head);
      await host.assertArtifact(r.ui);
      return structuredClone(r);
    },
  };
}
export type ChangeProofService = ReturnType<typeof createChangeProofService>;
