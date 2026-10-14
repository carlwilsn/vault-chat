// A git worktree per worker (RunWorkers on a code repo): each worker works on
// its own branch in <repo>.worktrees/<worker>, reset onto the repo's HEAD for
// every task; a task marked done is committed there and merged back into the
// repo (fast-forward, else a merge); a conflict aborts the merge and the task
// goes back to the queue. The server runs git itself, on paths it has checked.
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";

const ID = ["-c", "user.name=vault-chat worker", "-c", "user.email=worker@vault-chat.local", "-c", "commit.gpgsign=false"];

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", [...ID, ...args], { cwd, encoding: "utf8", timeout: 120_000, windowsHide: true });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

const under = (p: string, dir: string) => {
  const r = relative(dir, p);
  return r === "" || (!!r && !r.startsWith("..") && !isAbsolute(r));
};

/** The repo's top level, when `p` (absolute, or relative to the vault) is a git repo in the vault or its work area (~/agent-work/<vault>). */
export function resolveRepo(vault: string, p: string): { repo: string } | { error: string } {
  const full = isAbsolute(p) ? p : resolve(vault, p);
  if (!existsSync(full)) return { error: `${p} does not exist` };
  const real = realpathSync(full);
  const work = join(process.env.HOME || homedir(), "agent-work", basename(vault.replace(/[\\/]+$/, "")));
  const roots = [vault, work].filter(existsSync).map((d) => realpathSync(d));
  if (!roots.some((r) => under(real, r))) return { error: `${p} is outside the vault and its work area (${work})` };
  const top = git(real, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return { error: `${p} is not a git repo` };
  if (!git(real, ["rev-parse", "--verify", "HEAD"]).ok) return { error: `${p} has no commit yet` };
  return { repo: realpathSync(top.out.split("\n").pop()!.trim()) };
}

export const worktreeOf = (repo: string, worker: string) => ({ path: `${repo}.worktrees${repo.includes("\\") ? "\\" : "/"}${worker}`, branch: `vc-worker-${worker}` });

/** Create the worker's worktree (once), then put it on the repo's HEAD, clean, for the next task. */
export function prepareWorktree(repo: string, worker: string): { path: string; base: string } | { error: string } {
  const { path, branch } = worktreeOf(repo, worker);
  const head = git(repo, ["rev-parse", "HEAD"]);
  if (!head.ok) return { error: head.out };
  if (!existsSync(path)) {
    const r = git(repo, ["worktree", "add", "-B", branch, path, head.out]);
    if (!r.ok) return { error: `git worktree add: ${r.out.slice(0, 400)}` };
  } else {
    for (const args of [["reset", "-q", "--hard", head.out], ["clean", "-qfd"]]) {
      const r = git(path, args);
      if (!r.ok) return { error: `git ${args[0]}: ${r.out.slice(0, 400)}` };
    }
  }
  return { path, base: head.out };
}

/** Commit the worker's changes for a task and merge them into the repo's checked-out branch. */
export function mergeWorktree(repo: string, worker: string, message: string): { ok: true; merged: boolean; out: string } | { ok: false; conflict: boolean; out: string } {
  const { path, branch } = worktreeOf(repo, worker);
  if (!existsSync(path)) return { ok: false, conflict: false, out: "the worker has no worktree" };
  git(path, ["add", "-A"]);
  const dirty = !git(path, ["diff", "--cached", "--quiet"]).ok;
  if (dirty) {
    const c = git(path, ["commit", "-q", "-m", message]);
    if (!c.ok) return { ok: false, conflict: false, out: `commit: ${c.out.slice(0, 400)}` };
  }
  const ahead = git(repo, ["rev-list", "--count", `HEAD..${branch}`]);
  if (ahead.ok && ahead.out.trim() === "0") return { ok: true, merged: false, out: "nothing to merge" };
  const ff = git(repo, ["merge", "-q", "--ff-only", branch]);
  if (ff.ok) return { ok: true, merged: true, out: "fast-forward" };
  const m = git(repo, ["merge", "-q", "--no-edit", "-m", `Merge ${message}`, branch]);
  if (m.ok) return { ok: true, merged: true, out: "merged" };
  const files = git(repo, ["diff", "--name-only", "--diff-filter=U"]).out.split("\n").filter(Boolean);
  git(repo, ["merge", "--abort"]);
  return { ok: false, conflict: true, out: files.length ? `conflict in ${files.join(", ")}` : m.out.slice(0, 400) };
}

export function removeWorktree(repo: string, worker: string): void {
  const { path, branch } = worktreeOf(repo, worker);
  git(repo, ["worktree", "remove", "--force", path]);
  git(repo, ["branch", "-D", branch]);
}
