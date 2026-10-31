import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBranch, checkNativeRevert, prepareRevert, promote } from "../simpleShipHost";
import { acceptedChanges, acceptedFailedRelease, updateShippingJournal, type AcceptedChange } from "../changeShipping";
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
    const { head, tree } = await prepareRevert(f.repo, (await acceptedChanges(f.repo))[0], base, f.root, branch);
    await promote(f.repo, base, head, { ...f.change, id: head, source: { base, head, tree, branch }, rollbackOf: f.head });
    expect(readFileSync(join(f.repo, "app.txt"), "utf8")).toBe("base");
    expect(readFileSync(join(f.repo, "later.txt"), "utf8")).toBe("later");
    expect((await acceptedChanges(f.repo)).at(-1)?.rollbackOf).toBe(f.head);
  });
  it("rejects unaccepted/altered ranges and extra edits or parents on a generated native revert", async () => {
    const f = fixture();
    await expect(prepareRevert(f.repo, f.change, f.head, f.root, "agent/rollback-test")).rejects.toThrow("Original accepted range");
    await promote(f.repo, f.base, f.head, f.change);
    const original = (await acceptedChanges(f.repo))[0];
    await expect(prepareRevert(f.repo, { ...original, source: { ...original.source, tree: f.base } }, f.head, f.root, "agent/rollback-test")).rejects.toThrow("tree no longer matches");
    const native = await prepareRevert(f.repo, original, f.head, f.root, "agent/rollback-test");
    await checkNativeRevert(f.repo, f.head, native.head, native.tree);
    await expect(checkNativeRevert(f.repo, f.head, native.head, f.change.source.tree)).rejects.toThrow("tree/parent changed");
    const extra = f.g("commit-tree", f.change.source.tree, "-p", f.head, "-m", "Extra edit disguised as rollback");
    await expect(checkNativeRevert(f.repo, f.head, extra, native.tree)).rejects.toThrow("tree/parent changed");
    const extraParent = f.g("commit-tree", native.tree, "-p", f.head, "-p", f.base, "-m", "Extra parent");
    await expect(checkNativeRevert(f.repo, f.head, extraParent, native.tree)).rejects.toThrow("tree/parent changed");
  });
  it("leaves main and local edits untouched when later work conflicts with the accepted-range revert", async () => {
    const f = fixture(); await promote(f.repo, f.base, f.head, f.change);
    writeFileSync(join(f.repo, "app.txt"), "later conflicting change"); f.g("commit", "-qam", "later conflicting work");
    const current = f.g("rev-parse", "HEAD"), accepted = await acceptedChanges(f.repo);
    writeFileSync(join(f.repo, "local-note.txt"), "uncommitted user fixture");
    await expect(prepareRevert(f.repo, accepted[0], current, f.root, "agent/rollback-conflict")).rejects.toThrow();
    expect(f.g("rev-parse", "main")).toBe(current);
    expect(readFileSync(join(f.repo, "app.txt"), "utf8")).toBe("later conflicting change");
    expect(readFileSync(join(f.repo, "local-note.txt"), "utf8")).toBe("uncommitted user fixture");
    expect(await acceptedChanges(f.repo)).toEqual(accepted);
    expect(f.g("status", "--porcelain")).toBe("?? local-note.txt");
  });
  it("does not move main when the private acceptance journal cannot be persisted", async () => {
    const f = fixture(); const dir = join(f.repo, ".git/vault-chat-shipping"); mkdirSync(dir);
    writeFileSync(join(dir, "journal.lock"), ""); chmodSync(dir, 0o500);
    try { await expect(promote(f.repo, f.base, f.head, f.change)).rejects.toThrow(); }
    finally { chmodSync(dir, 0o700); }
    expect(f.g("rev-parse", "main")).toBe(f.base); expect(f.g("status", "--porcelain")).toBe("");
    expect(readFileSync(join(f.repo, "app.txt"), "utf8")).toBe("base");
  });
  it("does not advance main or record acceptance when native git cannot lock its index", async () => {
    const f = fixture(); writeFileSync(join(f.repo, ".git/index.lock"), "owned concurrent git writer fixture");
    await expect(promote(f.repo, f.base, f.head, f.change)).rejects.toThrow();
    expect(f.g("rev-parse", "main")).toBe(f.base);
    expect(readFileSync(join(f.repo, "app.txt"), "utf8")).toBe("base");
    expect(await acceptedChanges(f.repo)).toEqual([]);
    expect(readFileSync(join(f.repo, ".git/index.lock"), "utf8")).toContain("owned concurrent git writer");
  });
  it("does not record acceptance when native git cannot take main's expected-old ref lock", async () => {
    const f = fixture(); writeFileSync(join(f.repo, ".git/refs/heads/main.lock"), "owned native ref writer fixture");
    await expect(promote(f.repo, f.base, f.head, f.change)).rejects.toThrow();
    expect(f.g("rev-parse", "main")).toBe(f.base); expect(await acceptedChanges(f.repo)).toEqual([]);
    expect(readFileSync(join(f.repo, ".git/refs/heads/main.lock"), "utf8")).toContain("owned native ref writer");
    // Git's checkout and ref storage are not a multi-file atomic transaction. Do NOT promise
    // automatic worktree recovery after a ref write fails; the unchanged main is not accepted.
  });
  it("holds the exact expected-old native ref lock throughout checkout against an independent git writer", async () => {
    const f = fixture(), bin = join(f.root, "bin"); mkdirSync(bin);
    const competitor = f.g("commit-tree", f.g("rev-parse", `${f.base}^{tree}`), "-p", f.base, "-m", "competing writer");
    const realGit = realpathSync(process.env.PATH!.split(":").map(p => join(p, "git")).find(existsSync)!);
    const marker = join(f.root, "competitor-status");
    writeFileSync(join(bin, "git"), `#!${process.execPath}
const {spawnSync}=require('node:child_process'),fs=require('node:fs');
const args=process.argv.slice(2);
if(args.includes('read-tree')){const r=spawnSync(${JSON.stringify(realGit)},['update-ref','refs/heads/main',${JSON.stringify(competitor)},${JSON.stringify(f.base)}],{cwd:process.cwd(),encoding:'utf8'});fs.writeFileSync(${JSON.stringify(marker)},String(r.status));}
const r=spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});process.exit(r.status??1);`, { mode: 0o700 });
    vi.stubEnv("PATH", bin + ":" + process.env.PATH);
    try { await promote(f.repo, f.base, f.head, f.change); } finally { vi.unstubAllEnvs(); }
    expect(readFileSync(marker, "utf8")).toBe("128");
    expect(f.g("rev-parse", "main")).toBe(f.head); expect(f.g("status", "--porcelain")).toBe("");
  });
  it("reverts two recorded failed-release ranges newest-first through native git while preserving later work", async () => {
    const f = fixture(); await promote(f.repo, f.base, f.head, f.change);
    f.g("switch", "-qc", "agent/second"); writeFileSync(join(f.repo, "second.txt"), "second accepted change"); f.g("add", "."); f.g("commit", "-qm", "second");
    const second = f.g("rev-parse", "HEAD"), tree = f.g("rev-parse", "HEAD^{tree}"); f.g("switch", "-q", "main");
    await promote(f.repo, f.head, second, { ...f.change, id: second, source: { base: f.head, head: second, tree, branch: "agent/second" } });
    await updateShippingJournal(f.repo, j => { for (const c of j.changes) c.release = { id: "failed-private-release", revision: second, version: "1.0.1", tag: "v1.0.1", publishedAt: new Date().toISOString() }; });
    writeFileSync(join(f.repo, "later.txt"), "unrelated later work"); f.g("add", "."); f.g("commit", "-qm", "later");
    const selection = await acceptedFailedRelease(f.repo, "failed-private-release", second);
    expect(selection.map(c => c.id)).toEqual([second, f.head]);
    for (const [i, original] of selection.entries()) {
      const base = f.g("rev-parse", "main"), root = join(f.root, `range-${i}`), branch = `agent/rollback-${i}`; mkdirSync(root);
      const native = await prepareRevert(f.repo, original, base, root, branch);
      await promote(f.repo, base, native.head, { ...f.change, id: native.head, source: { base, ...native, branch }, rollbackOf: original.id });
    }
    expect(readFileSync(join(f.repo, "app.txt"), "utf8")).toBe("base"); expect(existsSync(join(f.repo, "second.txt"))).toBe(false);
    expect(readFileSync(join(f.repo, "later.txt"), "utf8")).toBe("unrelated later work");
    expect((await acceptedChanges(f.repo)).filter(c => c.rollbackOf).map(c => c.rollbackOf)).toEqual([second, f.head]);
  });
  it("refuses unsafe refs before passing anything to git", () => {
    for (const branch of ["main", "--upload-pack=bad", "agent/../main", "agent/a//b", "agent/b.lock", "agent/x\nmain", "agent/x;touch /tmp/no"]) expect(() => checkBranch(branch)).toThrow();
    expect(() => checkBranch("agent/simple-ship-reset-1030")).not.toThrow();
  });
});
