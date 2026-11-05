import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setFolderWalls } from "../projectFolders";
import { workerWorktree } from "../workerWorktree";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "vc-worktrees-")); roots.push(home);
  const vault = join(home, "vaults", "owner"), source = join(home, "source");
  mkdirSync(vault, { recursive: true }); mkdirSync(source);
  setFolderWalls(vault, { home, protect: () => [] });
  git(source, "init", "-q", "-b", "main"); writeFileSync(join(source, "same.txt"), "committed");
  git(source, "add", "."); git(source, "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-qm", "base");
  return { home, vault, source, slug: "code", parentCwd: source };
}
it("uses native git worktrees from committed source, without touching canonical/peer metadata or files", async () => {
  const o = fixture(); const config = readFileSync(join(o.source, ".git", "config"));
  writeFileSync(join(o.source, "same.txt"), "uncommitted source");
  const [a, b] = await Promise.all([workerWorktree(o), workerWorktree(o)]);
  expect(a).not.toBe(b); expect(a).toContain("/agent-work/owner/workers/code/agent/worker-");
  expect(readFileSync(join(a, "same.txt"), "utf8")).toBe("committed");
  writeFileSync(join(a, "same.txt"), "A"); writeFileSync(join(b, "same.txt"), "B");
  expect(readFileSync(join(a, "same.txt"), "utf8")).toBe("A");
  expect(readFileSync(join(b, "same.txt"), "utf8")).toBe("B");
  expect(git(a, "symbolic-ref", "--short", "HEAD")).not.toBe(git(b, "symbolic-ref", "--short", "HEAD"));
  expect(readFileSync(join(o.source, "same.txt"), "utf8")).toBe("uncommitted source");
  expect(readFileSync(join(o.source, ".git", "config"))).toEqual(config);
  expect(git(o.source, "branch", "--show-current")).toBe("main");
  mkdirSync(join(a, "nested"));
  expect(await workerWorktree({ ...o, cwd: join(a, "nested") })).toBe(join(a, "nested"));
  await expect(workerWorktree({ ...o, parentCwd: a, cwd: a })).rejects.toThrow("separate");
  await expect(workerWorktree({ ...o, cwd: o.source })).rejects.toThrow("separate");
  const other = fixture();
  const foreign = join(o.home, "agent-work", "owner", "foreign");
  git(o.source, "clone", "--quiet", "--no-local", other.source, foreign);
  git(foreign, "checkout", "-qb", "agent/foreign");
  await expect(workerWorktree({ ...o, cwd: foreign })).rejects.toThrow("another source");
  const alias = join(o.home, "agent-work", "owner", "alias"); symlinkSync(b, alias);
  await expect(workerWorktree({ ...o, cwd: alias })).rejects.toThrow("Unsafe");
});
