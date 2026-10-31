import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBranch, prepareRevert, promote } from "../simpleShipHost";
import { acceptedChanges, type AcceptedChange } from "../changeShipping";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vc-simple-")), repo = join(root, "repo"); roots.push(root); mkdirSync(repo);
  const g = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=test", "-c", "user.email=test@local", ...args], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  g("init", "-qb", "main"); writeFileSync(join(repo, "app.txt"), "base"); g("add", "."); g("commit", "-qm", "base");
  const base = g("rev-parse", "HEAD");
  g("switch", "-qc", "agent/change"); writeFileSync(join(repo, "app.txt"), "changed"); g("commit", "-qam", "change");
  const head = g("rev-parse", "HEAD"), tree = g("rev-parse", "HEAD^{tree}"); g("switch", "-q", "main");
  const change: AcceptedChange = { id: head, source: { base, head, tree, branch: "agent/change" }, preparedAt: new Date().toISOString(), proofDir: root, review: { convId: "project-app", slug: "app", folder: repo, clone: "untouched", base: "main", branch: "agent/change", sha: head, title: "Change", at: new Date().toISOString() } };
  return { root, repo, g, base, head, change };
}
describe("single box script: native git promotion and rollback", () => {
  it("fast-forwards exactly the pinned range and worktree, records acceptance but never Shipped or a push", async () => {
    const f = fixture(); await promote(f.repo, f.base, f.head, f.change);
    expect(f.g("rev-parse", "main")).toBe(f.head);
    expect(f.g("status", "--porcelain")).toBe("");
    expect(readFileSync(join(f.repo, "app.txt"), "utf8")).toBe("changed");
    const accepted = await acceptedChanges(f.repo);
    expect(accepted).toEqual([expect.objectContaining({ source: f.change.source, acceptedAt: expect.any(String) })]);
    expect(accepted[0].release).toBeUndefined();
  });
  it("rejects current main advancement rather than accepting stale gates or making a merge commit", async () => {
    const f = fixture(); writeFileSync(join(f.repo, "later.txt"), "later"); f.g("add", "."); f.g("commit", "-qm", "later");
    const current = f.g("rev-parse", "main");
    await expect(promote(f.repo, f.base, f.head, f.change)).rejects.toThrow("Main changed");
    expect(f.g("rev-parse", "main")).toBe(current); expect(await acceptedChanges(f.repo)).toEqual([]);
  });
  it("preserves uncommitted data and refuses dirty main", async () => {
    const f = fixture(); writeFileSync(join(f.repo, "app.txt"), "Carl's uncommitted edit");
    await expect(promote(f.repo, f.base, f.head, f.change)).rejects.toThrow("Main changed");
    expect(f.g("rev-parse", "main")).toBe(f.base);
    expect(readFileSync(join(f.repo, "app.txt"), "utf8")).toBe("Carl's uncommitted edit");
  });
  it("reverts the accepted source range while preserving later unrelated changes, through the same promotion", async () => {
    const f = fixture(); await promote(f.repo, f.base, f.head, f.change);
    writeFileSync(join(f.repo, "later.txt"), "later"); f.g("add", "."); f.g("commit", "-qm", "later");
    const base = f.g("rev-parse", "HEAD"), branch = "agent/rollback-test";
    const head = await prepareRevert(f.repo, f.change, base, f.root, branch), tree = f.g("rev-parse", `${head}^{tree}`);
    await promote(f.repo, base, head, { ...f.change, id: head, source: { base, head, tree, branch }, rollbackOf: f.head });
    expect(readFileSync(join(f.repo, "app.txt"), "utf8")).toBe("base");
    expect(readFileSync(join(f.repo, "later.txt"), "utf8")).toBe("later");
    expect((await acceptedChanges(f.repo)).at(-1)?.rollbackOf).toBe(f.head);
  });
  it("refuses unsafe refs before passing anything to git", () => {
    for (const branch of ["main", "--upload-pack=bad", "agent/../main", "agent/a//b", "agent/b.lock", "agent/x\nmain", "agent/x;touch /tmp/no"]) expect(() => checkBranch(branch)).toThrow();
    expect(() => checkBranch("agent/simple-ship-reset-1030")).not.toThrow();
  });
});
