import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareSourceRollback, ROLLBACK_CHECK, BOOTSTRAP_BASE, BOOTSTRAP_FIXTURE, sourceRollbackCommits } from "../sourceRollback";
import type { AcceptedChange } from "../changeShipping";
const dirs: string[] = [];
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=test", "-c", "user.email=test@local", ...args], { cwd, encoding: "utf8" }).trim();
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "vc-source-revert-")); dirs.push(dir);
  const repo = join(dir, "repo"); mkdirSync(repo); git(repo, "init", "-qb", "main");
  writeFileSync(join(repo, "feature.txt"), "before\n"); git(repo, "add", "."); git(repo, "commit", "-qm", "baseline");
  const base = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "feature.txt"), "after one\n"); git(repo, "commit", "-qam", "change one");
  writeFileSync(join(repo, "second.txt"), "accepted second commit\n"); git(repo, "add", "."); git(repo, "commit", "-qm", "change two");
  const head = git(repo, "rev-parse", "HEAD"), tree = git(repo, "rev-parse", "HEAD^{tree}");
  const accepted: AcceptedChange = { id: "specific-accepted-change", preparedAt: "2026-01-01", acceptedAt: "2026-01-01", proofDir: "/not-used", check: ROLLBACK_CHECK, source: { base, head, tree, branch: "agent/original" }, review: { convId: "project-repo", slug: "repo", folder: repo, clone: "/agent/untouched", base: "main", branch: "agent/original", sha: head, title: "Two-commit change", at: "2026-01-01" } };
  return { dir, repo, accepted, vault: join(dir, "vault"), privateRoot: join(dir, "private") };
}
describe("service-owned specific source recovery", () => {
  it("reverts the complete accepted range, keeps unrelated later work, pins proof, and never merges/pushes", async () => {
    const o = setup(); writeFileSync(join(o.repo, "later.txt"), "must survive\n"); git(o.repo, "add", "."); git(o.repo, "commit", "-qm", "unrelated later work");
    const before = git(o.repo, "rev-parse", "HEAD");
    const r = await prepareSourceRollback(o);
    try {
      expect(git(o.repo, "rev-parse", "HEAD")).toBe(before);
      expect(r.pinned.source.base).toBe(before);
      expect(readFileSync(join(r.pinned.review.clone, "feature.txt"), "utf8")).toBe("before\n");
      expect(existsSync(join(r.pinned.review.clone, "second.txt"))).toBe(false);
      expect(readFileSync(join(r.pinned.review.clone, "later.txt"), "utf8")).toBe("must survive\n");
      expect(git(o.repo, "rev-parse", r.pinned.source.branch)).toBe(r.pinned.source.head);
      expect(git(o.repo, "remote")).toBe("");
      expect(git(r.pinned.review.clone, "log", "-1", "--format=%s")).toContain("[agent] Roll back specific-accepted-change");
    } finally { r.close(); }
  });
  it("fails visibly on a later conflicting change, leaving main and local edits untouched", async () => {
    const o = setup(); writeFileSync(join(o.repo, "feature.txt"), "later conflicting change\n"); git(o.repo, "commit", "-qam", "conflict");
    const before = git(o.repo, "rev-parse", "HEAD");
    await expect(prepareSourceRollback(o)).rejects.toThrow("conflicts with later work");
    expect(git(o.repo, "rev-parse", "HEAD")).toBe(before);
    expect(readFileSync(join(o.repo, "feature.txt"), "utf8")).toBe("later conflicting change\n");
  });
  it("never reverts a revert or overwrites a dirty project", async () => {
    const o = setup();
    await expect(prepareSourceRollback({ ...o, accepted: { ...o.accepted, rollbackOf: "original" } })).rejects.toThrow("never another automatic revert");
    writeFileSync(join(o.repo, "local.txt"), "Carl's work");
    await expect(prepareSourceRollback(o)).rejects.toThrow("clean and checked out");
    expect(readFileSync(join(o.repo, "local.txt"), "utf8")).toBe("Carl's work");
  });
  it("only the exact host bootstrap preserves the pinned fixture; ordinary selection is forbidden", async () => {
    const o = setup();
    await expect(sourceRollbackCommits(o.repo, { ...o.accepted, revertCommits: [] })).rejects.toThrow("only valid");
    await expect(sourceRollbackCommits(o.repo, { ...o.accepted, basis: "legacy-bootstrap", revertCommits: [] })).rejects.toThrow("identity");
    // Real historical objects, private actual refs/worktree. No live branch, journal or conversation write.
    const real = resolve("."), head = git(real, "rev-parse", "HEAD");
    const repo = join(o.dir, "bootstrap"); mkdirSync(repo); git(repo, "init", "-qb", "main");
    writeFileSync(join(repo, ".git", "objects", "info", "alternates"), resolve(real, git(real, "rev-parse", "--git-common-dir"), "objects") + "\n");
    git(repo, "reset", "--hard", head);
    const commits = git(repo, "rev-list", "--topo-order", head, `^${BOOTSTRAP_BASE}`).split("\n");
    const accepted: AcceptedChange = { ...o.accepted, basis: "legacy-bootstrap", bootstrap: { proofId: "auto_ship_bootstrap_A_6fcc7f68", toolCallId: "native-bootstrap-call", fixtureCommit: BOOTSTRAP_FIXTURE, media: [] },
      source: { base: BOOTSTRAP_BASE, head, tree: git(repo, "rev-parse", "HEAD^{tree}"), branch: "agent/auto-ship" },
      review: { ...o.accepted.review, folder: repo, branch: "agent/auto-ship", sha: head, proofId: "auto_ship_bootstrap_A_6fcc7f68", toolCallId: "native-bootstrap-call" }, revertCommits: commits.filter(c => c !== BOOTSTRAP_FIXTURE) };
    expect(await sourceRollbackCommits(repo, accepted)).toEqual(accepted.revertCommits);
    await expect(sourceRollbackCommits(repo, { ...accepted, revertCommits: commits })).rejects.toThrow("preserving only");
    await expect(sourceRollbackCommits(repo, { ...accepted, revertCommits: accepted.revertCommits!.slice(1) })).rejects.toThrow("preserving only");
    const r = await prepareSourceRollback({ ...o, repo, accepted });
    try {
      expect(git(repo, "rev-parse", "HEAD")).toBe(head);
      expect(git(repo, "diff", "--name-only", BOOTSTRAP_BASE, r.pinned.source.head)).toBe("test/harness/voicemic.test.ts");
      expect(git(repo, "show", `${r.pinned.source.head}:test/harness/voicemic.test.ts`)).toBe(git(repo, "show", `${BOOTSTRAP_FIXTURE}:test/harness/voicemic.test.ts`));
    } finally { r.close(); }
  }, 120_000);
  it("uses host-owned actual input and assertions without replaying the feature being removed", () => {
    expect(ROLLBACK_CHECK.ui.steps?.some(s => "click" in s)).toBe(true);
    expect(ROLLBACK_CHECK.ui.steps?.some(s => "waitFor" in s)).toBe(true);
    expect(ROLLBACK_CHECK.ui.steps?.some(s => "run" in s || "goto" in s)).toBe(false);
  });
});
