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

/** A commit carries at most this much new content: a bigger set of new files is spread over the next
 * commits (the laptop uploads the history to GitHub a few commits at a time, so no commit may be huge). */
export const COMMIT_MAX_BYTES = 100 * 1024 * 1024;
/** A board being drawn on is committed once it has been still this long… */
export const BOARD_QUIET_MS = 2 * 60_000;
/** …or this long after its first uncommitted change, whichever comes first. */
export const BOARD_MAX_HOLD_MS = 10 * 60_000;
/** Archives and compressed backups (by name). The box never commits a new one: bulk output a job makes belongs
 * in the vault's work area (`~/agent-work/<vault>/`), not in the synced, backed-up vault. */
export const ARCHIVE_RE = /\.(zip|tar|tgz|tbz2?|txz|gz|bz2|xz|zst|7z|rar)$/i;
const BOARD_PATH_RE = /^boards\/([^./][^/]*)\//;

export type StageResult = {
  /** Over 50 MB: never staged (an untracked one is excluded for good). */
  tooLarge: string[];
  /** New archives: never staged (excluded for good); they belong in the work area. */
  archives: string[];
  /** Board folders (`boards/<slug>`) being drawn on: held out of this commit. */
  heldBoards: string[];
  /** Files left for the next commit so this one stays under COMMIT_MAX_BYTES of new content. */
  deferred: string[];
};

export type StageOpts = {
  /** Hold boards that are being drawn on (the sync's autosave). Off: commit them now. */
  holdBoards?: boolean;
  now?: number;
  quietMs?: number;
  maxHoldMs?: number;
  commitMaxBytes?: number;
};

/** When each held board was first seen with uncommitted changes (key: repo + board folder). */
const boardPendingSince = new Map<string, number>();

/** Stage what the box commits, by these rules (caller holds the repo lock):
 * - a file over 50 MB is never staged (an untracked one goes to .git/info/exclude);
 * - a new archive (.zip, .tar.gz, …) is never staged and is excluded for good: backups and exports go in the
 *   work area outside the vault;
 * - with `holdBoards`, a board folder whose files changed in the last 2 min is held back, at most 10 min from
 *   its first held change: an evening's drawing is a commit per pause (or per 10 min), not one per 15 s
 *   autosave (each a whole board.json and overview.png);
 * - the commit's new content stays under 100 MB: the rest waits for the next commit;
 * - the conversation log is never staged. */
export async function stageForCommit(repo: string, gitArgs: string[] = [], opts: StageOpts = {}): Promise<StageResult> {
  const now = opts.now ?? Date.now();
  const quietMs = opts.quietMs ?? BOARD_QUIET_MS;
  const maxHoldMs = opts.maxHoldMs ?? BOARD_MAX_HOLD_MS;
  const budget = opts.commitMaxBytes ?? COMMIT_MAX_BYTES;
  const res: StageResult = { tooLarge: [], archives: [], heldBoards: [], deferred: [] };
  const excludes: string[] = [];
  // The conversations are the server's event log, never synced by git: the log stays out of it
  // for good, and the older conversation files (tracked from before) are never staged (nor deleted).
  excludeLocally(repo, CONV_LOG_DIR + "/", true);
  const changes = await changedPaths(repo);
  const sizes = new Map<string, { size: number; mtime: number }>();
  for (const c of changes) {
    if (c.deleted) continue;
    try {
      const st = statSync(join(repo, c.path));
      if (st.isFile()) sizes.set(c.path, { size: st.size, mtime: st.mtimeMs });
    } catch {
      /* vanished */
    }
  }
  const out = new Set<string>();
  for (const c of changes) {
    const st = sizes.get(c.path);
    if (!st) continue;
    if (st.size > MAX_FILE_BYTES) {
      res.tooLarge.push(c.path);
      // Untracked: ignore it for good (then `add -A` skips it). Tracked and
      // grown past the cap: leave the change unstaged via a pathspec.
      if (c.untracked) excludeLocally(repo, c.path);
      else excludes.push(c.path);
      out.add(c.path);
    } else if (c.untracked && ARCHIVE_RE.test(c.path)) {
      res.archives.push(c.path);
      excludeLocally(repo, c.path);
      out.add(c.path);
    }
  }
  // Boards being drawn on.
  const boards = new Map<string, { last: number; live: boolean }>();
  for (const c of changes) {
    const m = BOARD_PATH_RE.exec(c.path);
    if (!m || out.has(c.path)) continue;
    const dir = `boards/${m[1]}`;
    const b = boards.get(dir) ?? { last: 0, live: false };
    const st = sizes.get(c.path);
    if (st) {
      b.last = Math.max(b.last, st.mtime);
      b.live = true;
    }
    boards.set(dir, b);
  }
  const key = lockKey(repo);
  for (const [dir, b] of boards) {
    const k = `${key}|${dir}`;
    // A board that was deleted or moved away (only removals) is committed at once.
    if (!opts.holdBoards || !b.live) {
      boardPendingSince.delete(k);
      continue;
    }
    const since = boardPendingSince.get(k) ?? now;
    if (now - b.last < quietMs && now - since < maxHoldMs) {
      boardPendingSince.set(k, since);
      res.heldBoards.push(dir);
      excludes.push(dir);
    } else {
      boardPendingSince.delete(k);
    }
  }
  const held = (p: string) => res.heldBoards.some((d) => p.startsWith(d + "/"));
  // The commit's budget of new content, in path order; at least one file always goes.
  let total = 0;
  let any = false;
  for (const c of [...changes].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const st = sizes.get(c.path);
    if (!st || out.has(c.path) || held(c.path)) continue;
    if (any && total + st.size > budget) {
      res.deferred.push(c.path);
      excludes.push(c.path);
      continue;
    }
    total += st.size;
    any = true;
  }
  // Pathspecs on stdin (a deferred set can be thousands of paths).
  const pathspecs = excludes.map((p) => `:(exclude,literal)${p}`).join("\0");
  if (pathspecs) await git(repo, [...gitArgs, "add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], { input: pathspecs });
  else await git(repo, [...gitArgs, "add", "-A", "--", "."]);
  // Unstaged again, whatever ignore rules say about them (a pathspec naming an ignored path makes `add` fail).
  await runGit(repo, ["reset", "-q", "--", ...NEVER_STAGED]);
  return res;
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

/** Listeners told what a commit left out (the sync status + its alerts). Registered by server/sync.ts. */
type StageListener = (repo: string, r: StageResult) => void;
const stageListeners: StageListener[] = [];
export function onStageResult(fn: StageListener): void {
  stageListeners.push(fn);
}
export function reportStageResult(repo: string, r: StageResult): void {
  if (!r.tooLarge.length && !r.archives.length) return;
  for (const fn of stageListeners) {
    try {
      fn(repo, r);
    } catch {
      /* listener bug must not break a commit */
    }
  }
}

/** The same repository (paths compared as the repo lock does). */
export function sameRepo(a: string, b: string): boolean {
  return lockKey(a) === lockKey(b);
}
