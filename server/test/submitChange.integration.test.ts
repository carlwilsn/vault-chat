/** Real native submission core → service job → sandbox gates → existing real app/RecordUI → locked ff.
 * Gates use tiny actual runner fixtures to test orchestration cheaply; build and UI are the actual tracked
 * vault-chat application, not a fake server. This is NOT the coordinator's final seven application gates. */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { submitChangeJob, requestRollback } from "../submitChange";
import { buildSandbox } from "../engine/index";
import { findBwrap } from "../engine/pi/install";
import { findBrowser } from "../headless";
import { cloneDirOf, ensureClone } from "../projectChanges";
import { registerFolder, setFolderWalls } from "../projectFolders";
import { appendNotes, ensureProjectThread, readConv } from "../engine/convs";
import { probeJob, readJobs, reapJobs, type PiJobEnv, type JobRec } from "../engine/pi/jobs";
import { acceptedChanges } from "../changeShipping";
import { ROLLBACK_CHECK } from "../sourceRollback";
const root = resolve(".");
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=test", "-c", "user.email=test@local", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }).trim();
async function finish(jobs: PiJobEnv, job: JobRec) {
  const end = Date.now() + 240_000;
  while (Date.now() < end) {
    const p = probeJob(jobs, job);
    if (p.state !== "running") { expect(p.exit, p.tail).toBe(0); reapJobs(jobs); return; }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`Real submission job timed out: ${probeJob(jobs, job).tail}`);
}

describe("unmocked installed submission orchestration", () => {
  it("runs one request-bound host job, accepts with actual app UI proof, and proves a specific source rollback without a Keep wait", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vc-native-submit-"));
    try {
      const repo = join(dir, "project"), vault = join(dir, "vault"), home = join(dir, "home");
      for (const d of [repo, vault, home, join(vault, "agent-projects", "app")]) mkdirSync(d, { recursive: true });
      // Immutable committed source, not the shared working tree another agent may still be editing.
      const archive = execFileSync("git", ["archive", "HEAD"], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
      execFileSync("tar", ["-x", "-C", repo], { input: archive });
      writeFileSync(join(repo, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler", skipLibCheck: true, jsx: "react-jsx", types: [] }, files: ["proof.fixture.ts"] }));
      writeFileSync(join(repo, "proof.fixture.ts"), "export const source: number = 1;\n");
      for (const app of ["phone", "board", "server"]) writeFileSync(join(repo, app, "tsconfig.json"), JSON.stringify({ compilerOptions: { target:"ES2022",module:"ESNext",moduleResolution:"bundler",skipLibCheck:true,types:[] }, files:["../proof.fixture.ts"] }));
      for (const name of execFileSync("find", [join(repo,"test/harness"), "-maxdepth", "1", "-name", "*.test.ts"], {encoding:"utf8"}).trim().split("\n").filter(Boolean)) rmSync(name);
      writeFileSync(join(repo, "test/harness/proof.fixture.test.ts"), "import {it} from 'node:test'; import assert from 'node:assert/strict'; it('actual Node runner',()=>assert.equal(2+2,4));\n");
      writeFileSync(join(repo, "server/vitest.config.ts"), 'export default {test:{include:["proof.*.test.ts"],fileParallelism:false}};');
      writeFileSync(join(repo, "proof.fixture.test.ts"), "import {it,expect} from 'vitest'; it('actual Vitest runner',()=>expect(2+2).toBe(4));\n");
      git(repo, "init", "-qb", "main"); git(repo, "add", "."); git(repo, "commit", "-qm", "Real application, lightweight runner fixtures");
      const base = git(repo, "rev-parse", "HEAD");
      setFolderWalls(vault, { home, protect: () => [] });
      const registered = registerFolder(vault, "app", repo); if ("error" in registered) throw new Error(registered.error);
      const cloned = await ensureClone(vault, "app", repo); if ("error" in cloned) throw new Error(cloned.error);
      const clone = cloneDirOf(vault, "app"); git(clone, "switch", "-qc", "agent/submission");
      writeFileSync(join(clone, "proof.fixture.ts"), "export const source: number = 2;\n");
      writeFileSync(join(clone, "test/harness/added.test.ts"), "import {it} from 'node:test'; import assert from 'node:assert/strict'; it('accepted new Node case',()=>assert.equal(3+3,6));\n");
      writeFileSync(join(clone, "proof.added.test.ts"), "import {it,expect} from 'vitest'; it('accepted new Vitest case',()=>expect(3+3).toBe(6));\n");
      git(clone, "add", "."); git(clone, "commit", "-qm", "[agent] requested fixture source and new tests");
      const head = git(clone, "rev-parse", "HEAD");
      await ensureProjectThread(vault, "app", "App");
      appendNotes(vault, "project-app", [{ kind: "line", role: "user", text: "Change fixture source to 2 and verify the real app remains usable.", clientId: "native-actual-ask" }]);
      const bwrap = findBwrap(), browser = findBrowser(); if (!bwrap || !browser) throw new Error("Actual bubblewrap and Chromium are required");
      const shell = buildSandbox({ bwrap, home: homedir(), stateDir: join(dir, "state"), secretsDir: join(dir, "hidden"), hideFiles: [], sessionsDir: join(dir, "sessions"), agentDir: join(dir, "agent"), vault, uid: process.getuid!() }).shell!;
      const host = { shell, home: homedir(), installedEntry: join(root, "dist-server", "vault-chat-server.mjs"), dependencies: join(root, "node_modules"), dependencyLock: join(root, "package-lock.json"), node: process.execPath, npm: execFileSync("sh", ["-c", "command -v npm"], { encoding: "utf8" }).trim(), path: process.env.PATH!, browser, timeoutMs: 120_000 };
      const jobs: PiJobEnv = { logDir: join(dir, "jobs"), wrap: null, env: {} };
      const opts = { vault, convId: "project-app", byCarl: true, jobs, host };
      const submitted = await submitChangeJob(opts, { title: "Requested source change", ...ROLLBACK_CHECK, assessment: "The committed fixture source is 2; actual app Notes input/persistence is checked by the host.", evidence: ["proof.fixture.ts"] });
      expect(submitted.job?.name).toBe("submit-change");
      expect(readJobs(jobs)).toHaveLength(1);
      await expect(submitChangeJob(opts, { title: "Duplicate", ...ROLLBACK_CHECK })).rejects.toThrow("already belongs");
      expect(git(repo, "rev-parse", "HEAD")).toBe(base);
      await finish(jobs, submitted.job!);
      expect(git(repo, "rev-parse", "HEAD")).toBe(head);
      expect(git(clone, "branch", "--show-current")).toBe("agent/submission");
      const accepted = await acceptedChanges(repo); expect(accepted).toHaveLength(1);
      expect(accepted[0].review.title).toBe("Requested source change");
      const receipt = JSON.parse(readFileSync(join(accepted[0].proofDir, "receipt.json"), "utf8"));
      expect(receipt.ui).toMatchObject({ sourceVerified: true, stepsPassed: true, recorder: "RecordUI" });
      expect(receipt.candidate.find((r: any) => r.gate === "test:harness").tests.some((t: any) => t.name === "accepted new Node case")).toBe(true);
      expect(receipt.candidate.find((r: any) => r.gate === "test:server").tests.some((t: any) => t.name === "accepted new Vitest case")).toBe(true);
      expect(receipt.ask.requestText).toContain("Change fixture source to 2");
      expect((await readConv(vault, "project-app"))?.pendingAsk).toBeFalsy();
      const reverted = await requestRollback({ vault, accepted: accepted[0], reason: "Restore the specific accepted source change", jobs, host });
      const duplicate = await requestRollback({ vault, accepted: accepted[0], reason: "Duplicate recovery", jobs, host });
      expect(duplicate.job?.id).toBe(reverted.job?.id);
      await finish(jobs, reverted.job!);
      expect(readFileSync(join(repo, "proof.fixture.ts"), "utf8")).toContain("= 1");
      const final = await acceptedChanges(repo); expect(final).toHaveLength(2);
      const recoveryReceipt = JSON.parse(readFileSync(join(final[1].proofDir, "receipt.json"), "utf8"));
      expect(recoveryReceipt.candidate.find((r: any) => r.gate === "test:harness").tests.some((t: any) => t.name === "accepted new Node case")).toBe(false);
      expect(recoveryReceipt.candidate.find((r: any) => r.gate === "test:server").tests.some((t: any) => t.name === "accepted new Vitest case")).toBe(false);
      expect(final[1].rollbackOf).toBe(accepted[0].id);
      expect((await requestRollback({ vault, accepted: accepted[0], reason: "Already recovered", jobs, host })).job).toBeUndefined();
      expect(git(repo, "remote")).toBe("");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 480_000);
});
