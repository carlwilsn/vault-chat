// Workspace allocation only. Pi still owns child sessions, events, stop and reports.
// Reuses the git-worktree approach from 33b1acf0, without its work/job/proof registry.
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { runGit, withRepoLock } from "./git";
import { agentWorkDir } from "./workArea";
import { wallsOf } from "./projectFolders";

const inside = (root: string, path: string) => {
  const r = relative(root, path);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};
function directory(path: string): void {
  for (let p = resolve(path);;) {
    if (existsSync(p)) {
      const st = lstatSync(p);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`Unsafe worker directory: ${p}`);
    }
    const up = dirname(p); if (up === p) return; p = up;
  }
}
async function git(cwd: string, args: string[]): Promise<string> {
  const r = await runGit(cwd, ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args]);
  if (r.code) throw new Error(`Worker git ${args[0]} failed: ${r.stderr.slice(0, 400)}`);
  return r.stdout.trim();
}

/** Only committed project source enters the seed. No vault copy, source-index write,
 * peer working-tree import, checkout/reset of the coordinator, or remote push. */
export async function workerWorktree(o: { vault: string; slug: string; source: string; parentCwd: string; cwd?: string }): Promise<string> {
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(o.slug)) throw new Error("Unsafe project slug");
  const area = agentWorkDir(wallsOf(o.vault).home, o.vault);
  if (o.cwd !== undefined) {
    const cwd = resolve(o.parentCwd, o.cwd);
    directory(cwd);
    if (!inside(area, cwd) || !existsSync(cwd) || realpathSync(cwd) === realpathSync(o.parentCwd)) throw new Error("Explicit code-worker cwd must be a separate existing checkout in this owner's work area");
    const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
    const common = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (!inside(area, realpathSync(root)) || !inside(area, realpathSync(common)) || !(await git(cwd, ["symbolic-ref", "--short", "HEAD"])).startsWith("agent/")) throw new Error("Explicit code-worker cwd must have an owned agent branch and git metadata");
    if (resolve(await git(cwd, ["remote", "get-url", "origin"])) !== resolve(o.source)) throw new Error("Explicit code-worker cwd belongs to another source project");
    return cwd; // Exact requested cwd, never replaced with a viewer root or another tree.
  }
  const seed = join(area, "worker-seeds", o.slug);
  const branch = `agent/worker-${randomUUID()}`;
  const cwd = join(area, "workers", o.slug, branch);
  directory(seed); directory(cwd);
  await withRepoLock(seed, async () => {
    mkdirSync(dirname(seed), { recursive: true });
    if (!existsSync(seed)) await git(dirname(seed), ["clone", "--quiet", "--no-local", "--no-checkout", "--", o.source, seed]);
    // Never reuse an alias to protected/source metadata.
    if (!lstatSync(join(seed, ".git")).isDirectory()) throw new Error("Worker seed must be an independent clone");
    const base = await git(o.source, ["rev-parse", "HEAD"]);
    await git(seed, ["fetch", "--quiet", "--no-tags", "--", o.source, base]);
    mkdirSync(dirname(cwd), { recursive: true });
    await git(seed, ["worktree", "add", "--quiet", "-b", branch, cwd, "FETCH_HEAD"]);
    await git(seed, ["config", "user.name", "vault-chat agent"]);
    await git(seed, ["config", "user.email", "agent@vault-chat.local"]);
  });
  return cwd;
}
