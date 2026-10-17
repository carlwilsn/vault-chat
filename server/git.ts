// Git plumbing shared by the app's git commands and the box sync loop: one
// async mutex per repo (lib.rs:2549 repo_lock_for / 2599 with_repo_lock), a
// hard timeout that kills the whole child tree (lib.rs:3528 run_git_timeout),
// never-prompt env, and the "no file over 50 MB" staging rule.
import { spawn } from "node:child_process";
import { realpathSync, statSync, rmSync, readFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { killTree } from "./commands/proc";

export const GIT_TIMEOUT_MS = 90_000; // lib.rs:2464
const STALE_LOCK_MS = 10_000; // lib.rs:2465
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const AGENT_GIT_NAME = "vault-chat-agent"; // lib.rs:2480
export const AGENT_GIT_EMAIL = "agent@vault-chat.local"; // lib.rs:2481

export type GitResult = { stdout: string; stderr: string; code: number };

export function runGit(
  cwd: string,
  args: string[],
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv; input?: string } = {},
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      GIT_OPTIONAL_LOCKS: "0",
      ...(opts.env ?? {}),
    };
    const child = spawn("git", ["-c", "credential.interactive=false", ...args], {
      cwd,
      env,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: [opts.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (d) => (stdout += d));
    child.stderr!.on("data", (d) => (stderr += d));
    if (opts.input !== undefined) child.stdin!.end(opts.input);
    const t = opts.timeoutMs ?? GIT_TIMEOUT_MS;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, t);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e.message);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(`git timed out after ${Math.round(t / 1000)}s: git ${args.join(" ")}`);
      else resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}

/** Like runGit but rejects with the full stderr on a non-zero exit. */
export async function git(cwd: string, args: string[], opts: Parameters<typeof runGit>[2] = {}): Promise<string> {
  const r = await runGit(cwd, args, opts);
  if (r.code !== 0) {
    throw new Error(`git ${args.join(" ")} (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`);
  }
  return r.stdout;
}

// ---- per-repo mutex ----

const locks = new Map<string, Promise<unknown>>();

function lockKey(repo: string): string {
  try {
    return realpathSync(repo).toLowerCase();
  } catch {
    return repo.replace(/[\\/]+$/, "").toLowerCase();
  }
}

/** lib.rs:2566 clear_stale_index_lock. */
function clearStaleIndexLock(repo: string): void {
  const lock = join(repo, ".git", "index.lock");
  try {
    const st = statSync(lock);
    if (Date.now() - st.mtimeMs >= STALE_LOCK_MS) rmSync(lock, { force: true });
  } catch {
    /* no lock */
  }
}

/** Serialize every mutating git sequence on `repo` in this process — the app's
 * end-of-turn commits and the sync loop share it. */
export function withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const key = lockKey(repo);
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(
    () => {
      clearStaleIndexLock(repo);
      return fn();
    },
    () => {
      clearStaleIndexLock(repo);
      return fn();
    },
  );
  const tail = run.catch(() => undefined);
  locks.set(key, tail);
  void tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return run;
}

/** lib.rs:2587 abort_stuck_merge_or_rebase. */
export async function abortStuckMergeOrRebase(repo: string): Promise<void> {
  const g = join(repo, ".git");
  if (existsSync(join(g, "rebase-merge")) || existsSync(join(g, "rebase-apply"))) {
    await runGit(repo, ["rebase", "--abort"]).catch(() => {});
  }
  if (existsSync(join(g, "MERGE_HEAD"))) await runGit(repo, ["merge", "--abort"]).catch(() => {});
}

/** Paths git would stage with `add -A`, from `status --porcelain -z`. */
async function changedPaths(repo: string): Promise<{ path: string; deleted: boolean; untracked: boolean }[]> {
  const out = await git(repo, ["status", "--porcelain", "-z", "--untracked-files=all", "--ignore-submodules=dirty"]);
  const items = out.split("\0");
  const res: { path: string; deleted: boolean; untracked: boolean }[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    if (it.length < 4) continue;
    const xy = it.slice(0, 2);
    const path = it.slice(3);
    if (xy[0] === "R" || xy[0] === "C") i++; // rename: next item is the source
    res.push({ path, deleted: xy.includes("D"), untracked: xy === "??" });
  }
  return res;
}

/** Stage everything except files over 50 MB. An oversized untracked file is
 * also written to .git/info/exclude so it stays out for good. Returns the
 * skipped paths. Caller holds the repo lock. */
export async function stageAllExceptLarge(repo: string, gitArgs: string[] = []): Promise<string[]> {
  const skipped: string[] = [];
  const trackedSkips: string[] = [];
  // The conversations are the server's event log, never synced by git: the log stays out of it
  // for good, and the older conversation files (tracked from before) are never staged (nor deleted).
  excludeLocally(repo, CONV_LOG_DIR + "/", true);
  for (const c of await changedPaths(repo)) {
    if (c.deleted) continue;
    try {
      const st = statSync(join(repo, c.path));
      if (st.isFile() && st.size > MAX_FILE_BYTES) {
        skipped.push(c.path);
        // Untracked: ignore it for good (then `add -A` skips it). Tracked and
        // grown past the cap: leave the change unstaged via a pathspec.
        if (c.untracked) excludeLocally(repo, c.path);
        else trackedSkips.push(c.path);
      }
    } catch {
      /* vanished */
    }
  }
  const pathspec = ["--", ".", ...trackedSkips.map((p) => `:(exclude,literal)${p}`)];
  await git(repo, [...gitArgs, "add", "-A", ...pathspec]);
  // Unstaged again, whatever ignore rules say about them (a pathspec naming an ignored path makes `add` fail).
  await runGit(repo, ["reset", "-q", "--", ...NEVER_STAGED]);
  return skipped;
}

/** The conversation event log (server/convlog). */
export const CONV_LOG_DIR = ".vault-chat/events";
/** Never committed by the box: the log, and the conversation files from before it. */
export const NEVER_STAGED = [CONV_LOG_DIR, ".vault-chat/conversations"];

function excludeLocally(repo: string, rel: string, dir = false): void {
  if (dir) {
    const p = join(repo, ".git", "info", "exclude");
    let cur = "";
    try {
      cur = readFileSync(p, "utf8");
    } catch {
      mkdirSync(dirname(p), { recursive: true });
    }
    const line = "/" + rel.replace(/\\/g, "/");
    if (!cur.split(/\r?\n/).includes(line)) appendFileSync(p, (cur && !cur.endsWith("\n") ? "\n" : "") + line + "\n");
    return;
  }
  const p = join(repo, ".git", "info", "exclude");
  let cur = "";
  try {
    cur = readFileSync(p, "utf8");
  } catch {
    mkdirSync(dirname(p), { recursive: true });
  }
  const line = "/" + rel.replace(/\\/g, "/").replace(/([*?[\]!#\\])/g, "\\$1");
  if (!cur.split(/\r?\n/).includes(line)) {
    appendFileSync(p, (cur && !cur.endsWith("\n") ? "\n" : "") + line + "\n");
  }
}

/** Identity flags (lib.rs:2532 run_git_as) for the agent. */
export const AGENT_IDENTITY_ARGS = ["-c", `user.name=${AGENT_GIT_NAME}`, "-c", `user.email=${AGENT_GIT_EMAIL}`];

/** Listeners told about files the 50 MB rule refused (the sync status + an
 * alert). Registered by server/sync.ts. */
type SkipListener = (paths: string[]) => void;
const skipListeners: SkipListener[] = [];
export function onLargeFilesSkipped(fn: SkipListener): void {
  skipListeners.push(fn);
}
export function reportSkipped(paths: string[]): void {
  if (!paths.length) return;
  for (const fn of skipListeners) {
    try {
      fn(paths);
    } catch {
      /* listener bug must not break a commit */
    }
  }
}
