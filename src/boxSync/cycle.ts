// The laptop side of the box sync, in the swappable bundle: a port of src-tauri/src/box_sync.rs's cycle (box_sync_cycle,
// box_pull_cycle). The model, the files on disk and the report are the Rust one's (read its header): `master` is
// written only here and the only branch pushed; `box` is fetched into refs/remotes/box/box and merged only when the
// merge is clean (a conflict closes the gate: {files, since}); the mission zone is the box's; a file over 50 MB goes
// through Git LFS with the box as its server; a `github` remote gets a debounced backup in the background.
//
// Git runs through the shell's narrow bridge (./git.ts): every phase the Rust ran under with_repo_lock runs inside a
// repo_hold lease here (every Rust git writer waits), released in `finally`. The per-process caches (UP_TO_DATE,
// UNTRACK_SEEN, …) are this module's state: a new bundle starts them afresh, as a new process did.
import type { Git, GitOut } from "./git";
import { boxConfig, isMasterProject, joinPath, remoteUrl, type BoxConfig } from "./config";
import {
  BOX_MAX_FILE_BYTES,
  BOX_REF,
  BOX_REMOTE,
  GIT_TIMEOUT_SECS,
  GITHUB_DEBOUNCE_MS,
  GITHUB_REMOTE,
  githubOriginToAdopt,
  GITHUB_STEP_BYTES,
  GITHUB_STEP_TIMEOUT_SECS,
  GITHUB_UPLOAD_BRANCH,
  HOOK_NAMES,
  LFS_BLOCK_BEGIN,
  LFS_MERGE_TIMEOUT_SECS,
  NET_TIMEOUT_SECS,
  NEVER_STAGED,
  PUSH_VERIFY_EVERY_MS,
  REPO_CONFIG_RE,
  RepoConfig,
  STATE_FILE,
  classifyError,
  excludeWithBlock,
  fnv,
  fullErr,
  githubProblem,
  githubSteps,
  isLfsHook,
  isZonePath,
  lfsAttributesText,
  lfsBlockOf,
  lfsSecs,
  lines,
  neverStaged,
  nothingToCommit,
  parseConfigZ,
  parseStatusV2,
  readExcludeBlockText,
  vaultGitattributesText,
  vaultGitignoreText,
  withExcludeLine,
  type GithubProblem,
  type WorkStatus,
} from "./rules";

export type BigFile = { path: string; size: number };
export type ConflictState = { files: string[]; since: number };

/** The report the frontend reads (the Rust BoxSyncReport, field for field). */
export type BoxSyncReport = {
  configured: boolean;
  ok: boolean;
  message: string;
  committed: boolean;
  merged: boolean;
  merged_paths: string[];
  conflict: ConflictState | null;
  error: string | null;
  error_kind: "unreachable" | "git" | null;
  changes_waiting: number;
  big_files: BigFile[];
  big_upload_error: string | null;
  github_warning: string | null;
  github_pushed_at: number | null;
  github_problem: GithubProblem | null;
  github_pending: number | null;
  github_uploading: boolean;
  github_next_try_at: number | null;
  origin_push: string | null;
  origin_warning: string | null;
};

const emptyReport = (): BoxSyncReport => ({
  configured: false,
  ok: false,
  message: "",
  committed: false,
  merged: false,
  merged_paths: [],
  conflict: null,
  error: null,
  error_kind: null,
  changes_waiting: 0,
  big_files: [],
  big_upload_error: null,
  github_warning: null,
  github_pushed_at: null,
  github_problem: null,
  github_pending: null,
  github_uploading: false,
  github_next_try_at: null,
  origin_push: null,
  origin_warning: null,
});

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- per-process state (box_sync.rs's statics) ----------

/** Per vault: does any config scope set core.hooksPath? Unknown = yes (the hooks then always run). */
const HOOKS_PATH_SET = new Map<string, boolean>();
const UNTRACK_SEEN = new Map<string, string>();
/** Per vault: the last (box/box, master) pair known to need no merge. */
const UP_TO_DATE = new Map<string, string>();
/** When this process last pushed master to the box (per vault). */
const LAST_PUSH = new Map<string, number>();

// ---------- the repo, and git as the sync runs it ----------

/** A hold lasts at most 120 s in the shell: renew it before then (a long phase, an LFS merge). */
const HOLD_MS = 120_000;
const RENEW_AFTER_MS = 90_000;

function isIndexLockError(stderr: string): boolean {
  return stderr.includes("index.lock") || stderr.includes("unable to write new index file");
}

export class Repo {
  /** The hold this cycle has now (inside `locked`). */
  private lease: string | null = null;
  private leaseAt = 0;
  /** The vault's hooks are skipped for the sync's own git (syncHooksSkippable, read once a cycle). */
  hooksOff = false;

  constructor(
    readonly git: Git,
    readonly vault: string,
    readonly gitDir: string,
  ) {}

  /** The repo's git dir: `<vault>/.git` for an ordinary checkout (no process), else git's answer. */
  static async open(git: Git, vault: string): Promise<Repo> {
    const dot = joinPath(vault, ".git");
    if (await git.exists(joinPath(dot, "HEAD"))) return new Repo(git, vault, dot);
    try {
      const r = await git.run(vault, ["rev-parse", "--absolute-git-dir"], { timeoutSecs: GIT_TIMEOUT_SECS });
      if (r.code === 0 && r.out.trim()) return new Repo(git, vault, r.out.trim());
    } catch {
      /* not a repo */
    }
    return new Repo(git, vault, dot);
  }

  path(...rel: string[]): string {
    return joinPath(this.vault, ...rel);
  }
  inGitDir(...rel: string[]): string {
    return joinPath(this.gitDir, ...rel);
  }

  private async hold(): Promise<string> {
    let last: unknown = null;
    for (let i = 0; i < 3; i++) {
      try {
        return await this.git.hold(this.vault, HOLD_MS);
      } catch (e) {
        last = e;
      }
    }
    throw new Error(`the repo stayed busy: ${errText(last)}`);
  }

  private async renew(): Promise<void> {
    const old = this.lease;
    this.lease = null;
    if (old) await this.git.release(old);
    this.lease = await this.hold();
    this.leaseAt = Date.now();
  }

  /** `fn` under the repo lock (with_repo_lock): every git call in it runs inside the hold. */
  async locked<T>(fn: () => Promise<T>): Promise<T> {
    this.lease = await this.hold();
    this.leaseAt = Date.now();
    try {
      return await fn();
    } finally {
      const l = this.lease;
      this.lease = null;
      if (l) await this.git.release(l);
    }
  }

  /** run_git_timeout: one git process (inside the hold when there is one). */
  async run(args: string[], secs = GIT_TIMEOUT_SECS, input?: string): Promise<GitOut> {
    if (this.lease && Date.now() - this.leaseAt > RENEW_AFTER_MS) await this.renew();
    const go = () => this.git.run(this.vault, args, { timeoutSecs: secs, input, lease: this.lease ?? undefined });
    try {
      return await go();
    } catch (e) {
      if (!this.lease || !/hold has ended/.test(errText(e))) throw e;
      await this.renew();
      return go();
    }
  }

  /** run_git_mut: a writer, retried while a foreign git holds the index. */
  async mut(args: string[], secs = GIT_TIMEOUT_SECS): Promise<GitOut> {
    for (let attempt = 0; ; attempt++) {
      const r = await this.run(args, secs);
      if (r.code !== 0 && isIndexLockError(r.err) && attempt < 4) {
        await sleep(150 * (attempt + 1));
        continue;
      }
      return r;
    }
  }

  /** `args` with the hooks switched off when they are Git LFS's alone. */
  syncArgs(args: string[]): string[] {
    if (!this.hooksOff) return args;
    return ["-c", `core.hooksPath=${this.inGitDir("vault-chat-no-hooks").replace(/\\/g, "/")}`, ...args];
  }
  sg(args: string[]) {
    return this.run(this.syncArgs(args));
  }
  sgMut(args: string[]) {
    return this.mut(this.syncArgs(args));
  }
  sgAs(name: string, email: string, args: string[]) {
    return this.mut(["-c", `user.name=${name}`, "-c", `user.email=${email}`, ...this.syncArgs(args)]);
  }
  sgNet(args: string[]) {
    return this.run(this.syncArgs(args), NET_TIMEOUT_SECS);
  }
  sgAsLong(name: string, email: string, args: string[], secs: number) {
    return this.run(this.syncArgs(["-c", `user.name=${name}`, "-c", `user.email=${email}`, ...args]), secs);
  }

  readText(path: string): Promise<string | null> {
    return this.git.readText(path);
  }
  writeText(path: string, contents: string): Promise<boolean> {
    return this.git.writeText(path, contents, { repo: this.vault, lease: this.lease ?? undefined });
  }
  /** Sizes of vault-relative files (null: not a file). */
  async sizes(paths: string[]): Promise<Map<string, number | null>> {
    const uniq = [...new Set(paths)];
    const got = uniq.length ? await this.git.sizes(this.vault, uniq) : [];
    return new Map(uniq.map((p, i) => [p, got[i] ?? null]));
  }
}

const isBig = (sizes: Map<string, number | null>, p: string) => (sizes.get(p) ?? 0) > BOX_MAX_FILE_BYTES;

// ---------- hooks ----------

/** The vault's hooks may be skipped for the sync's own git: no core.hooksPath anywhere (known from this process's
 *  config read) and every hook in .git/hooks is Git LFS's. A few file reads. */
export async function syncHooksSkippable(git: Git, vault: string, repo?: Repo): Promise<boolean> {
  if (HOOKS_PATH_SET.get(vault) !== false) return false;
  const r = repo ?? (await Repo.open(git, vault));
  const bodies = await Promise.all(HOOK_NAMES.map((n) => git.readText(r.inGitDir("hooks", n))));
  let any = false;
  for (const body of bodies) {
    if (body === null) continue;
    if (!isLfsHook(body)) return false;
    any = true;
  }
  return any;
}

// ---------- reads ----------

async function readRepoConfig(repo: Repo): Promise<RepoConfig> {
  try {
    const r = await repo.run(["config", "-z", "--get-regexp", REPO_CONFIG_RE]);
    return r.code === 0 ? parseConfigZ(r.out) : new RepoConfig();
  } catch {
    return new RepoConfig();
  }
}

async function readStatus(repo: Repo): Promise<WorkStatus> {
  const r = await repo.sg(["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--ignore-submodules=dirty"]);
  if (r.code !== 0) throw new Error(fullErr(r.out, r.err, r.code, "git status"));
  return parseStatusV2(r.out);
}

type Refs = { master?: string; box_box?: string; box_master?: string; github_master?: string; github_box?: string };

async function readRefs(repo: Repo, branch: string): Promise<Refs> {
  const refs: Refs = {};
  const head = `refs/heads/${branch}`;
  const boxHead = `refs/remotes/box/${branch}`;
  try {
    const r = await repo.run(["for-each-ref", "--format=%(objectname) %(refname)", head, BOX_REF, boxHead, "refs/remotes/github/master", "refs/remotes/github/box"]);
    if (r.code !== 0) return refs;
    for (const l of lines(r.out)) {
      const t = l.trim();
      const i = t.indexOf(" ");
      if (i < 0) continue;
      const oid = t.slice(0, i);
      const name = t.slice(i + 1);
      if (name === head) refs.master = oid;
      else if (name === boxHead) refs.box_master = oid;
      else if (name === "refs/remotes/box/box") refs.box_box = oid;
      else if (name === "refs/remotes/github/master") refs.github_master = oid;
      else if (name === "refs/remotes/github/box") refs.github_box = oid;
    }
  } catch {
    /* no refs */
  }
  return refs;
}

/** HEAD's branch from the HEAD file (no process); null = detached or unknown. */
async function headBranchFs(repo: Repo): Promise<string | null> {
  const head = await repo.readText(repo.inGitDir("HEAD"));
  const t = head?.trim() ?? "";
  return t.startsWith("ref: refs/heads/") ? t.slice("ref: refs/heads/".length) : null;
}

// ---------- persisted machine-local state (.git/vault-chat-box-sync.json) ----------

type Persisted = { conflict: ConflictState | null; origin_owed: boolean; lfs_owed: string[] };

const statePath = (repo: Repo) => repo.inGitDir(STATE_FILE);

/** The state file as the Rust cycle reads it: anything malformed is the default. */
export function parseState(raw: string | null): Persisted {
  const d: Persisted = { conflict: null, origin_owed: false, lfs_owed: [] };
  if (raw === null) return d;
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) return d;
    let conflict: ConflictState | null = null;
    if (v.conflict != null) {
      const c = v.conflict;
      if (!c || !Array.isArray(c.files) || !c.files.every((f: unknown) => typeof f === "string") || typeof c.since !== "number") return d;
      conflict = { files: c.files, since: c.since };
    }
    if (v.origin_owed !== undefined && typeof v.origin_owed !== "boolean") return d;
    if (v.lfs_owed !== undefined && !(Array.isArray(v.lfs_owed) && v.lfs_owed.every((f: unknown) => typeof f === "string"))) return d;
    return { conflict, origin_owed: v.origin_owed ?? false, lfs_owed: v.lfs_owed ?? [] };
  } catch {
    return d;
  }
}

export const stateText = (st: Persisted): string =>
  JSON.stringify({ conflict: st.conflict ? { files: st.conflict.files, since: st.conflict.since } : null, origin_owed: st.origin_owed, lfs_owed: st.lfs_owed });

async function loadState(repo: Repo): Promise<Persisted> {
  return parseState(await repo.readText(statePath(repo)));
}

async function saveState(repo: Repo, st: Persisted): Promise<void> {
  const next = stateText(st);
  // Unchanged: no write (the Rust cycle wrote the same bytes every cycle).
  if ((await repo.readText(statePath(repo))) === next) return;
  await repo.writeText(statePath(repo), next);
}

// ---------- remote setup ----------

/** Remote `box` points at the box's git URL and fetches only the `box` branch. Idempotent. */
async function ensureBoxRemote(repo: Repo, cfg: BoxConfig, rc: RepoConfig): Promise<void> {
  const url = remoteUrl(cfg);
  const cur = rc.get("remote.box.url");
  if (cur === undefined) {
    const r = await repo.run(["remote", "add", BOX_REMOTE, url]);
    if (r.code !== 0) throw new Error(fullErr(r.out, r.err, r.code, "git remote add box"));
  } else if (cur.trim() !== url) {
    const r = await repo.run(["remote", "set-url", BOX_REMOTE, url]);
    if (r.code !== 0) throw new Error(fullErr(r.out, r.err, r.code, "git remote set-url box"));
  }
  const want = `+refs/heads/box:${BOX_REF}`;
  const fetch = rc.all("remote.box.fetch");
  if (!(fetch.length === 1 && fetch[0] === want)) await repo.run(["config", "--replace-all", "remote.box.fetch", want]).catch(() => null);
}

/** git-lfs as the repo's `lfs` filter, its endpoint the box (never GitHub's), no lock checks. A write only for a
 *  value that differs. */
async function ensureLfsConfig(repo: Repo, cfg: BoxConfig, rc: RepoConfig): Promise<void> {
  const want: [string, string][] = [
    ["filter.lfs.clean", "git-lfs clean -- %f"],
    ["filter.lfs.smudge", "git-lfs smudge -- %f"],
    ["filter.lfs.process", "git-lfs filter-process"],
    ["filter.lfs.required", "true"],
    ["lfs.locksverify", "false"],
  ];
  if (cfg.boxUrl.startsWith("http://") || cfg.boxUrl.startsWith("https://")) want.push(["lfs.url", `${remoteUrl(cfg)}/info/lfs`]);
  for (const [k, v] of want) if (rc.get(k.toLowerCase())?.trim() !== v) await repo.mut(["config", k, v]).catch(() => null);
}

/** Before `add` turns a file into a pointer: some `lfs` filter must exist (else git would store the bytes). */
async function ensureLfsFilter(repo: Repo): Promise<void> {
  const r = await repo.run(["config", "--get", "filter.lfs.clean"]);
  if (r.out.trim() !== "") return;
  for (const [k, v] of [
    ["filter.lfs.clean", "git-lfs clean -- %f"],
    ["filter.lfs.smudge", "git-lfs smudge -- %f"],
    ["filter.lfs.process", "git-lfs filter-process"],
    ["filter.lfs.required", "true"],
  ] as const)
    await repo.mut(["config", k, v]).catch(() => null);
}

// ---------- repo hygiene (lib.rs prepare_vault_repo, from the config already read) ----------

async function ensureVaultGitattributes(repo: Repo): Promise<void> {
  const next = vaultGitattributesText((await repo.readText(repo.path(".gitattributes"))) ?? "");
  if (next !== null) await repo.writeText(repo.path(".gitattributes"), next);
}

async function ensureVaultGitignore(repo: Repo): Promise<void> {
  const next = vaultGitignoreText((await repo.readText(repo.path(".gitignore"))) ?? "");
  if (next !== null) await repo.writeText(repo.path(".gitignore"), next);
}

/** lib.rs untrack_ignored_files: drop tracked-but-ignored files from the index (the working copy stays). */
async function untrackIgnoredFiles(repo: Repo): Promise<number> {
  let listed: GitOut;
  try {
    listed = await repo.run(["ls-files", "-i", "-c", "--exclude-standard"]);
  } catch {
    return 0;
  }
  if (listed.code !== 0) return 0;
  const paths = lines(listed.out)
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = 0; i < paths.length; i += 64) await repo.mut(["rm", "--cached", "--quiet", "--ignore-unmatch", "--", ...paths.slice(i, i + 64)]).catch(() => null);
  return paths.length;
}

/** What decides whether the tracked-but-ignored sweep can find anything new: the root ignore rules,
 *  .git/info/exclude, and the index (its size and the commit HEAD names; the Rust key read the index's mtime, which no
 *  shell command gives). */
async function untrackKey(repo: Repo): Promise<string> {
  const head = (await repo.readText(repo.inGitDir("HEAD"))) ?? "";
  const ref = head.trim().startsWith("ref: ") ? head.trim().slice(5) : "";
  const [ignore, exclude, refText, idx] = await Promise.all([
    repo.readText(repo.path(".gitignore")),
    repo.readText(repo.inGitDir("info", "exclude")),
    ref ? repo.readText(repo.inGitDir(...ref.split("/"))) : Promise.resolve(head),
    repo.git.sizes(repo.gitDir, ["index"]),
  ]);
  return fnv([ignore ?? "", exclude ?? "", head, refText ?? "", String(idx[0] ?? "")].join("\0"));
}

/** prepare_vault_repo for the box cycle: submodule recursion off (a write only when it isn't), the managed
 *  .gitattributes/.gitignore, and the tracked-but-ignored sweep only when its inputs changed in this process. */
async function prepareBoxRepo(repo: Repo, rc: RepoConfig, project: boolean): Promise<void> {
  for (const key of ["fetch.recurseSubmodules", "submodule.recurse"]) {
    if (rc.get(key.toLowerCase())?.trim() !== "false") await repo.mut(["config", key, "false"]).catch(() => null);
  }
  // A project's own .gitignore/.gitattributes and index are its own.
  if (project) return;
  await ensureVaultGitattributes(repo);
  await ensureVaultGitignore(repo);
  const key = await untrackKey(repo);
  if (UNTRACK_SEEN.get(repo.vault) !== key) {
    await untrackIgnoredFiles(repo);
    // Keyed after the sweep (its `rm --cached` rewrites the index).
    UNTRACK_SEEN.set(repo.vault, await untrackKey(repo));
  }
}

// ---------- mission zone ----------

/** Reset every mission-zone path that differs from `authority` (box/box) back to the authority's version, in index
 *  and working tree. Only paths the authority has are touched. */
async function sanitizeZoneTo(repo: Repo, authority: string): Promise<string[]> {
  let r: GitOut;
  try {
    r = await repo.run(["diff", "--no-renames", "--name-status", "-z", authority, "--", ".vault-chat"]);
  } catch {
    return [];
  }
  if (r.code !== 0) return [];
  const it = r.out.split("\0");
  const reset: string[] = [];
  for (let i = 0; i < it.length; i += 2) {
    const status = it[i]!;
    if (status === "") break;
    const path = it[i + 1];
    if (path === undefined) break;
    // "A" = exists here but not in the authority: nothing to restore from.
    if (status.startsWith("A")) continue;
    if (isZonePath(path)) reset.push(path);
  }
  for (let i = 0; i < reset.length; i += 50) await repo.sgMut(["checkout", authority, "--", ...reset.slice(i, i + 50)]).catch(() => null);
  return reset;
}

// ---------- files over 50 MB ----------

async function ensureExcludeLine(repo: Repo, line: string): Promise<void> {
  const file = repo.inGitDir("info", "exclude");
  const next = withExcludeLine((await repo.readText(file)) ?? "", line);
  if (next !== null) await repo.writeText(file, next);
}

async function writeExcludeBlock(repo: Repo, paths: string[]): Promise<void> {
  const file = repo.inGitDir("info", "exclude");
  const cur = (await repo.readText(file)) ?? "";
  const next = excludeWithBlock(cur, paths);
  if (next !== cur) await repo.writeText(file, next);
}

async function readExcludeBlock(repo: Repo): Promise<string[]> {
  return readExcludeBlockText((await repo.readText(repo.inGitDir("info", "exclude"))) ?? "");
}

/** Rewrite the managed block of `.gitattributes`: the files it named that are still over 50 MB (in their order), then
 *  `big`. Untouched when that list is what it already says. Returns whether it changed. */
export async function syncLfsAttributes(git: Git, vault: string, big: string[]): Promise<boolean> {
  const repo = new Repo(git, vault, joinPath(vault, ".git"));
  return syncLfsAttrs(repo, big);
}

async function syncLfsAttrs(repo: Repo, big: string[]): Promise<boolean> {
  const file = repo.path(".gitattributes");
  const cur = (await repo.readText(file)) ?? "";
  const sizes = await repo.sizes(lfsBlockOf(cur).named);
  const next = lfsAttributesText(cur, (p) => isBig(sizes, p), big);
  return next !== null && (await repo.writeText(file, next));
}

async function lfsInUse(repo: Repo): Promise<boolean> {
  return ((await repo.readText(repo.path(".gitattributes"))) ?? "").includes(LFS_BLOCK_BEGIN);
}

/** Stage everything a box-mode commit may carry, from one `git status`: mission zone reset to the box, files over
 *  50 MB as LFS pointers (each with its .gitattributes line first; the old exclude block's files freed into LFS too),
 *  the conversations never staged. Under the lock. Returns the files over 50 MB it staged and whether anything was. */
async function stageFromStatus(repo: Repo, st: WorkStatus, name: string, email: string, project: boolean): Promise<[string[], boolean]> {
  const zoneReset = project ? [] : await sanitizeZoneTo(repo, BOX_REF);
  if (!project) await ensureExcludeLine(repo, "/.vault-chat/events/");
  // Files the old rule kept out of git go through LFS now.
  const freed = await readExcludeBlock(repo);
  if (freed.length) await writeExcludeBlock(repo, []);
  const candidates = st.entries.filter((e) => !neverStaged(e.path));
  const sizes = await repo.sizes([...freed, ...candidates.map((e) => e.path)]);
  const big = freed.filter((p) => isBig(sizes, p));
  for (const e of candidates) if (isBig(sizes, e.path) && !big.includes(e.path)) big.push(e.path);
  const attrsChanged = await syncLfsAttrs(repo, big);
  if (big.length) await ensureLfsFilter(repo);
  const stageable = attrsChanged || big.length > 0 || candidates.length > 0;
  if (stageable) {
    const bytes = big.reduce((n, p) => n + (sizes.get(p) ?? 0), 0);
    const r = await repo.sgAsLong(name, email, ["add", "-A"], big.length ? lfsSecs(bytes) : 90);
    if (r.code !== 0) throw new Error(fullErr(r.out, r.err, r.code, "git add -A"));
  }
  // The conversations never go through git in box mode: whatever `add -A` (or anyone before it) staged there is
  // unstaged again, run only when there is something to undo.
  if (st.entries.some((e) => neverStaged(e.path) && (stageable || (!e.untracked && e.x !== ".")))) {
    await repo.sgMut(["reset", "-q", "--", ...NEVER_STAGED]).catch(() => null);
  }
  if (big.length) {
    const ps = await loadState(repo);
    for (const p of big) if (!ps.lfs_owed.includes(p)) ps.lfs_owed.push(p);
    await saveState(repo, ps);
  }
  return [big, stageable || zoneReset.length > 0];
}

const mergeInProgress = (repo: Repo) => repo.git.exists(repo.inGitDir("MERGE_HEAD"));

async function worktreeDirty(repo: Repo): Promise<boolean> {
  try {
    return (await repo.sg(["status", "--porcelain", "--ignore-submodules=dirty"])).out.trim() !== "";
  } catch {
    return false;
  }
}

/** Commit local edits on the branch (no nested repos). Under the lock. Steady state: nothing changed and no big file
 *  to re-check, done after one `git status`. */
async function commitLocal(repo: Repo, rc: RepoConfig, project: boolean): Promise<[boolean, string[]]> {
  const st = await readStatus(repo);
  if (st.entries.length === 0 && (await readExcludeBlock(repo)).length === 0) return [false, []];
  const [hn, he] = rc.identity();
  const [big, staged] = await stageFromStatus(repo, st, hn, he, project);
  if (!staged) return [false, big];
  const r = await repo.sgAs(hn, he, ["commit", "-q", "--no-verify", "-m", "vault-chat: sync"]);
  if (r.code !== 0) {
    if (nothingToCommit(r.out, r.err)) return [false, big];
    throw new Error(fullErr(r.out, r.err, r.code, "git commit"));
  }
  return [true, big];
}

// ---------- the merge gate ----------

type Gate = { kind: "up" } | { kind: "merged" } | { kind: "conflict"; files: string[] };

async function boxUsesLfs(repo: Repo): Promise<boolean> {
  try {
    const r = await repo.run(["cat-file", "-p", `${BOX_REF}:.gitattributes`]);
    return r.code === 0 && r.out.includes(LFS_BLOCK_BEGIN);
  } catch {
    return false;
  }
}

/** Under the lock, after local edits were committed; `refs` read after those commits. */
async function mergeGate(repo: Repo, rc: RepoConfig, refs: Refs, project: boolean): Promise<Gate> {
  const boxo = refs.box_box;
  if (!boxo) return { kind: "up" };
  const head = refs.master ?? "";
  const pair = `${boxo} ${head}`;
  if (boxo === head || UP_TO_DATE.get(repo.vault) === pair) return { kind: "up" };
  const anc = await repo.sg(["merge-base", "--is-ancestor", BOX_REF, "HEAD"]).catch(() => null);
  if (anc?.code === 0) {
    UP_TO_DATE.set(repo.vault, pair);
    return { kind: "up" };
  }
  // Dry run first: merge-tree merges in memory and touches neither the index nor the working tree.
  const dry = await repo.sg(["merge-tree", "--write-tree", "--name-only", "--no-messages", "HEAD", BOX_REF]);
  let conflicted: string[] = [];
  if (dry.code === 1) {
    for (const l of lines(dry.out).slice(1)) {
      const t = l.trim();
      if (t && conflicted[conflicted.length - 1] !== t) conflicted.push(t);
    }
  } else if (dry.code !== 0) throw new Error(fullErr(dry.out, dry.err, dry.code, "git merge-tree"));
  const zoneOnly = conflicted.length > 0 && !project && conflicted.every(isZonePath);
  if (conflicted.length && !zoneOnly) return { kind: "conflict", files: conflicted };
  // Clean (or only the box's own zone): merge for real, in place. A file edited since our commit would block it.
  if (await worktreeDirty(repo)) await commitLocal(repo, rc, project);
  const [hn, he] = rc.identity();
  const mergeArgs = ["merge", "--no-edit", "--no-verify", "-m", "vault-chat: merge box", BOX_REF];
  let m = (await lfsInUse(repo)) ? await repo.sgAsLong(hn, he, mergeArgs, LFS_MERGE_TIMEOUT_SECS) : await repo.sgAs(hn, he, mergeArgs);
  if (m.code !== 0 && !(await lfsInUse(repo)) && (await boxUsesLfs(repo))) {
    // The box's first file over 50 MB: its download may have outrun the short leash. Once more, long.
    if (await mergeInProgress(repo)) await repo.sgMut(["merge", "--abort"]).catch(() => null);
    m = await repo.sgAsLong(hn, he, mergeArgs, LFS_MERGE_TIMEOUT_SECS);
  }
  if (m.code === 0) return { kind: "merged" };
  if (zoneOnly && (await mergeInProgress(repo))) {
    // The mission zone is the box's: take its side of every conflict.
    const u = await repo.sg(["ls-files", "-u", "-z"]);
    const unmerged: [string, boolean][] = [];
    for (const rec of u.out.split("\0").filter(Boolean)) {
      // "<mode> <sha> <stage>\t<path>"
      const tab = rec.indexOf("\t");
      if (tab < 0) continue;
      const path = rec.slice(tab + 1);
      const stage3 = rec.slice(0, tab).split(/\s+/)[2] === "3";
      const hit = unmerged.find(([p]) => p === path);
      if (hit) hit[1] ||= stage3;
      else unmerged.push([path, stage3]);
    }
    if (unmerged.every(([p]) => isZonePath(p))) {
      for (const [p, theirs] of unmerged) {
        if (theirs) {
          await repo.sgMut(["checkout", "--theirs", "--", p]).catch(() => null);
          await repo.sgMut(["add", "--", p]).catch(() => null);
        } else await repo.sgMut(["rm", "-q", "--", p]).catch(() => null);
      }
      const c = await repo.sgAs(hn, he, ["commit", "-q", "--no-edit", "--no-verify"]);
      if (c.code === 0) return { kind: "merged" };
      await repo.sgMut(["merge", "--abort"]).catch(() => null);
      throw new Error(fullErr(c.out, c.err, c.code, "git commit (merge box, mission zone)"));
    }
  }
  // Anything else: leave master exactly as it was.
  if (await mergeInProgress(repo)) await repo.sgMut(["merge", "--abort"]).catch(() => null);
  throw new Error(fullErr(m.out, m.err, m.code, "git merge box/box"));
}

/** What the merge just made changed: `git merge` left the pre-merge HEAD in ORIG_HEAD. */
async function mergedPaths(repo: Repo): Promise<string[]> {
  try {
    const r = await repo.run(["-c", "core.quotePath=false", "diff", "--name-only", "ORIG_HEAD", "HEAD"]);
    return r.code === 0
      ? lines(r.out)
          .map((l) => l.trim())
          .filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

async function changesWaiting(repo: Repo): Promise<number> {
  try {
    const r = await repo.run(["rev-list", "--count", "HEAD", "--not", "--remotes=box"]);
    const n = Number(r.out.trim());
    return r.code === 0 && r.out.trim() !== "" && Number.isInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

// ---------- the GitHub backup ----------

type GithubState = {
  attempted: number | null;
  pushedAt: number | null;
  warning: string | null;
  problem: GithubProblem | null;
  pending: number | null;
  running: boolean;
  /** Bytes one upload may carry: halved when an upload is cut off, back up after one that went through. */
  stepBudget: number;
};
const GITHUB_LAST = new Map<string, GithubState>();
const GITHUB_RUNS = new Map<string, Promise<void>>();

/** Run git with `input` on stdin (local plumbing). */
async function gitWithInput(repo: Repo, args: string[], input: string): Promise<string> {
  const r = await repo.run(args, GITHUB_STEP_TIMEOUT_SECS, input);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.err.trim()}`);
  return r.out;
}

/** The commits GitHub lacks, oldest first, with the bytes of the files each adds. */
async function githubMissing(repo: Repo, withBox: boolean): Promise<[string, number][]> {
  const args = ["rev-list", "--reverse", "--topo-order", "refs/heads/master", ...(withBox ? [BOX_REF] : []), "--not", "--remotes=github"];
  const r = await repo.sg(args);
  if (r.code !== 0) throw new Error(fullErr(r.out, r.err, r.code, "git rev-list"));
  const commits = lines(r.out)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!commits.length) return [];
  // The blobs each commit adds (a merge adds none of its own: its sides come first).
  const raw = await gitWithInput(repo, ["diff-tree", "--stdin", "-r", "--root", "--no-renames", "--no-abbrev"], commits.join("\n") + "\n");
  const added = new Map<string, string[]>();
  let cur = "";
  for (const l of lines(raw)) {
    if (l.startsWith(":")) {
      const f = l.slice(1).trim().split(/\s+/);
      if (f.length >= 4 && /[^0]/.test(f[3]!)) {
        const list = added.get(cur) ?? [];
        list.push(f[3]!);
        added.set(cur, list);
      }
    } else if (l.trim()) cur = l.trim();
  }
  const blobs = [...new Set([...added.values()].flat())].sort();
  const size = new Map<string, number>();
  if (blobs.length) {
    const out = await gitWithInput(repo, ["cat-file", "--batch-check=%(objectname) %(objectsize)"], blobs.join("\n") + "\n");
    for (const l of lines(out)) {
      const i = l.indexOf(" ");
      if (i < 0) continue;
      const n = Number(l.slice(i + 1).trim());
      size.set(l.slice(0, i), Number.isFinite(n) ? n : 0);
    }
  }
  const seen = new Set<string>();
  return commits.map((c): [string, number] => {
    let bytes = 0;
    for (const b of added.get(c) ?? []) {
      if (seen.has(b)) continue;
      seen.add(b);
      bytes += size.get(b) ?? 0;
    }
    return [c, bytes];
  });
}

/** Push to GitHub, bounded: null, or the full error. */
async function githubPush(repo: Repo, args: string[], what: string): Promise<string | null> {
  try {
    const r = await repo.run(repo.syncArgs(args), GITHUB_STEP_TIMEOUT_SECS);
    return r.code === 0 ? null : fullErr(r.out, r.err, r.code, what);
  } catch (e) {
    return `${what} failed: ${errText(e)}`;
  }
}

type Upload = { ok: true; budget: number } | { ok: false; err: string; budget: number };

/** One backup: what GitHub lacks in one push when under `budget` bytes; otherwise (or when that push is cut off) in
 *  steps of at most `budget` bytes to a scratch branch, then master and box, then the scratch branch is deleted. */
async function githubUpload(repo: Repo, first: boolean, budget0: number, pending: { n: number | null }): Promise<Upload> {
  let budget = budget0;
  const refs = await readRefs(repo, "master");
  const current = !first && refs.master !== undefined && refs.github_master === refs.master && (refs.box_box === undefined || refs.github_box === refs.box_box);
  if (current) {
    pending.n = 0;
    return { ok: true, budget };
  }
  const withBox = refs.box_box !== undefined;
  let missing: [string, number][];
  try {
    missing = await githubMissing(repo, withBox);
  } catch (e) {
    return { ok: false, err: errText(e), budget };
  }
  pending.n = missing.length;
  const total = missing.reduce((n, m) => n + m[1], 0);
  const args = ["push", "--porcelain", GITHUB_REMOTE, "refs/heads/master:refs/heads/master", ...(withBox ? [`${BOX_REF}:refs/heads/box`] : [])];
  const pushRefs = () => githubPush(repo, args, "GitHub backup (git push github)");
  // Small enough for one upload: try that first; cut off, it goes up in steps.
  let stepped = total > budget;
  if (!stepped) {
    const e = await pushRefs();
    if (e !== null) {
      if (githubProblem(e) === "too_big" && missing.length > 1) {
        budget = Math.max(1, Math.floor(total / 2));
        stepped = true;
      } else return { ok: false, err: e, budget };
    }
  }
  if (stepped) {
    let done = 0;
    let tries = 0;
    while (done < missing.length) {
      tries++;
      const rest = missing.slice(done);
      const target = githubSteps(rest, budget)[0]!;
      const pos = rest.findIndex((m) => m[0] === target);
      const e = await githubPush(repo, ["push", "--porcelain", GITHUB_REMOTE, `+${target}:refs/heads/${GITHUB_UPLOAD_BRANCH}`], "GitHub backup (git push github, one step)");
      if (e === null) {
        done += pos >= 0 ? pos + 1 : missing.length - done;
        pending.n = missing.length - done;
        continue;
      }
      const n = pos >= 0 ? pos + 1 : 1;
      // Cut off: try again at once with half of what that step carried, down to one commit a step.
      if (githubProblem(e) === "too_big" && n > 1 && tries < 40) {
        const carried = missing.slice(done, done + n).reduce((s, m) => s + m[1], 0);
        budget = Math.max(1, Math.floor(carried / 2));
        continue;
      }
      const one = missing[done]![1];
      const err = n === 1 && githubProblem(e) === "too_big" ? `${e}\n\n(one change alone adds ${Math.floor(one / (1024 * 1024))} MB)` : e;
      return { ok: false, err, budget: Math.max(1, budget) };
    }
    const e = await pushRefs();
    if (e !== null) return { ok: false, err: e, budget };
  }
  pending.n = 0;
  // The scratch branch, if a backup made one.
  const scratch = await repo.sg(["rev-parse", "--verify", "-q", `refs/remotes/${GITHUB_REMOTE}/${GITHUB_UPLOAD_BRANCH}`]).catch(() => null);
  if (scratch?.code === 0) await githubPush(repo, ["push", "--porcelain", GITHUB_REMOTE, `:refs/heads/${GITHUB_UPLOAD_BRANCH}`], "GitHub backup (delete the upload branch)");
  return { ok: true, budget: Math.min(budget * 2, GITHUB_STEP_BYTES) };
}

/** Back up master + the box branch to the `github` remote, off the critical path: in the background, at most every 10
 *  minutes (attempts too), a push only when GitHub's refs are behind (the first backup in a session always pushes).
 *  Every cycle reports the last outcome. */
function githubBackup(repo: Repo, rc: RepoConfig, report: BoxSyncReport, project: boolean): void {
  const adopt = githubOriginToAdopt(rc, project);
  if (rc.get("remote.github.url") === undefined && adopt === null) return;
  const vault = repo.vault;
  let st = GITHUB_LAST.get(vault);
  if (!st) GITHUB_LAST.set(vault, (st = { attempted: null, pushedAt: null, warning: null, problem: null, pending: null, running: false, stepBudget: GITHUB_STEP_BYTES }));
  const now = Date.now();
  report.github_pushed_at = st.pushedAt;
  report.github_warning = st.warning;
  report.github_problem = st.problem;
  report.github_pending = st.pending;
  report.github_uploading = st.running;
  if (st.warning !== null) report.github_next_try_at = st.attempted === null ? null : now + Math.max(0, GITHUB_DEBOUNCE_MS - (now - st.attempted));
  if (st.running || (st.attempted !== null && now - st.attempted < GITHUB_DEBOUNCE_MS)) return;
  const first = st.attempted === null;
  st.running = true;
  st.attempted = now;
  const budget = st.stepBudget;
  report.github_uploading = true;
  // Its own handle on the repo: never inside a cycle's hold.
  const bg = new Repo(repo.git, vault, repo.gitDir);
  bg.hooksOff = repo.hooksOff;
  const s = st;
  const run = (async () => {
    const pending = { n: null as number | null };
    let outcome: Upload;
    try {
      if (adopt !== null) {
        // Adopt origin as `github`, then learn what GitHub already has, so the upload sends only what it lacks.
        const a = await bg.run(["remote", "add", GITHUB_REMOTE, adopt]);
        if (a.code !== 0 && !/already exists/i.test(a.err)) throw new Error(fullErr(a.out, a.err, a.code, "git remote add github (from origin)"));
        await bg.run(bg.syncArgs(["fetch", "-q", GITHUB_REMOTE]), GITHUB_STEP_TIMEOUT_SECS).catch(() => null);
      }
      outcome = await githubUpload(bg, first, budget, pending);
    } catch (e) {
      outcome = { ok: false, err: errText(e), budget };
    }
    s.running = false;
    s.pending = pending.n ?? s.pending;
    s.stepBudget = outcome.budget;
    if (outcome.ok) {
      s.pushedAt = Date.now();
      s.warning = null;
      s.problem = null;
    } else {
      s.problem = githubProblem(outcome.err);
      s.warning = outcome.err;
    }
  })();
  GITHUB_RUNS.set(vault, run);
  void run.finally(() => {
    if (GITHUB_RUNS.get(vault) === run) GITHUB_RUNS.delete(vault);
  });
}

/** Tests: wait until no GitHub backup is running for `vault`. */
export async function waitGithubBackup(vault: string): Promise<void> {
  await GITHUB_RUNS.get(vault);
}

// ---------- the cycle ----------

/** One full sync cycle. */
export function boxSyncCycle(git: Git, vault: string): Promise<BoxSyncReport> {
  return cycle(git, vault, true);
}

/** The box just published an edit: commit, fetch, merge, and stop there (the pushes wait for the next full cycle). */
export function boxPullCycle(git: Git, vault: string): Promise<BoxSyncReport> {
  return cycle(git, vault, false);
}

async function cycle(git: Git, vault: string, push: boolean): Promise<BoxSyncReport> {
  const r = emptyReport();
  const cfg = await boxConfig(git, vault);
  if (!cfg) {
    r.message = "no box configured";
    return r;
  }
  r.configured = true;
  const fail = (msg: string) => {
    r.error_kind = classifyError(msg);
    r.error = msg;
  };
  const repo = await Repo.open(git, vault);
  const project = await isMasterProject(git, vault);

  // 1. Local: config (one read), hygiene, commit. Under the repo lock.
  let rc = new RepoConfig();
  let handMerge: boolean;
  try {
    handMerge = await repo.locked(async () => {
      if (!(await git.exists(joinPath(vault, ".git")))) throw new Error("this vault is not a git repository");
      const b = (await headBranchFs(repo)) ?? "";
      if (b !== cfg.branch) {
        throw new Error(`box sync works on branch ${cfg.branch}, but this ${cfg.project ? "project" : "vault"} is on '${b || "a detached HEAD"}'`);
      }
      rc = await readRepoConfig(repo);
      HOOKS_PATH_SET.set(vault, rc.get("core.hookspath") !== undefined);
      repo.hooksOff = await syncHooksSkippable(git, vault, repo);
      await ensureBoxRemote(repo, cfg, rc);
      await ensureLfsConfig(repo, cfg, rc);
      // Someone is resolving by hand: never abort their merge, never commit over it.
      if (await mergeInProgress(repo)) return true;
      await prepareBoxRepo(repo, rc, project);
      const [committed] = await commitLocal(repo, rc, project);
      // Our own `add -A` never stages an ignored file: the sweep that just ran still holds for this index.
      if (committed) UNTRACK_SEEN.set(vault, await untrackKey(repo));
      r.committed = committed;
      return false;
    });
  } catch (e) {
    fail(errText(e));
    r.changes_waiting = await changesWaiting(repo);
    return r;
  }

  // 2. Fetch the box branch (no lock: it only writes remote refs + objects).
  const fetchFailed = async (msg: string) => {
    fail(msg);
    r.changes_waiting = await changesWaiting(repo);
    r.conflict = (await loadState(repo)).conflict;
    return r;
  };
  try {
    const f = await repo.sgNet(["fetch", "--no-tags", "--no-write-fetch-head", "--no-auto-maintenance", "--no-recurse-submodules", "--prune", BOX_REMOTE]);
    // The box has not created its branch yet: nothing to merge, still push.
    if (f.code !== 0 && !f.err.includes("couldn't find remote ref refs/heads/box")) return fetchFailed(fullErr(f.out, f.err, f.code, "git fetch box"));
  } catch (e) {
    return fetchFailed(errText(e));
  }

  // 3. The merge gate (the refs read once, under the same lock).
  const st = await loadState(repo);
  let refs: Refs = {};
  let masterMoved = r.committed;
  if (handMerge) {
    r.message = "a merge is in progress (being resolved by hand); waiting";
    refs = await repo.locked(() => readRefs(repo, cfg.branch)).catch((): Refs => ({}));
  } else {
    let gate: Gate | { kind: "error"; error: string };
    try {
      gate = await repo.locked(async () => {
        refs = await readRefs(repo, cfg.branch);
        return mergeGate(repo, rc, refs, project);
      });
    } catch (e) {
      gate = { kind: "error", error: errText(e) };
    }
    if (gate.kind === "up") st.conflict = null;
    else if (gate.kind === "merged") {
      st.conflict = null;
      r.merged = true;
      masterMoved = true;
      r.merged_paths = await mergedPaths(repo);
    } else if (gate.kind === "conflict") {
      st.conflict = { files: gate.files, since: st.conflict?.since ?? Date.now() };
    } else {
      // It may have committed before failing: the push decides by itself.
      masterMoved = true;
      fail(gate.error);
    }
    await saveState(repo, st);
  }
  r.conflict = st.conflict;
  // The box already has this master: our record of its master equals ours, and nothing moved master since.
  const boxHasMaster = !masterMoved && refs.master !== undefined && refs.master === refs.box_master;

  const finalMessage = (lfsBlocked: boolean): string => {
    if (r.error !== null) return "sync failed";
    if (lfsBlocked) return "a file over 50 MB could not be sent to the box; retrying";
    if (r.conflict) return `merge gate closed: conflict in ${r.conflict.files.join(", ")}`;
    if (r.merged) return push ? "merged box into master; pushed" : "merged box into master";
    if (handMerge) return r.message;
    return "synced";
  };

  if (!push) {
    r.ok = r.error === null;
    r.changes_waiting = boxHasMaster ? 0 : await changesWaiting(repo);
    r.message = finalMessage(false);
    return r;
  }

  // 4. Push the branch, and only it: when the box is behind, and every few minutes anyway.
  const last = LAST_PUSH.get(vault);
  const verifyDue = last === undefined || Date.now() - last >= PUSH_VERIFY_EVERY_MS;
  // 4a. Files over 50 MB staged since the last upload: their bytes go to the box's LFS store first, and the commits
  // pointing at them wait until they have.
  const owed = (await loadState(repo)).lfs_owed;
  let lfsBlocked = false;
  if (owed.length) {
    const sizes = await repo.sizes(owed);
    const bytes = owed.reduce((n, p) => n + (sizes.get(p) ?? 0), 0);
    let res: GitOut | string;
    try {
      res = await repo.run(repo.syncArgs(["lfs", "push", BOX_REMOTE, cfg.branch]), lfsSecs(bytes));
    } catch (e) {
      res = errText(e);
    }
    if (typeof res !== "string" && res.code === 0) {
      const ps = await loadState(repo);
      ps.lfs_owed = ps.lfs_owed.filter((p) => !owed.includes(p));
      await saveState(repo, ps);
    } else {
      lfsBlocked = true;
      r.big_upload_error = typeof res === "string" ? res : fullErr(res.out, res.err, res.code, `git lfs push box ${cfg.branch}`);
      r.big_files = owed.map((p) => ({ path: p, size: sizes.get(p) ?? 0 }));
    }
  }
  if (lfsBlocked) r.changes_waiting = await changesWaiting(repo);
  else if (boxHasMaster && !verifyDue) {
    if (r.error === null) r.ok = true;
    r.changes_waiting = 0;
  } else {
    LAST_PUSH.set(vault, Date.now());
    const spec = `refs/heads/${cfg.branch}:refs/heads/${cfg.branch}`;
    try {
      const p = await repo.sgNet(["push", "--porcelain", BOX_REMOTE, spec]);
      if (p.code === 0) {
        await repo.run(["update-ref", `refs/remotes/box/${cfg.branch}`, `refs/heads/${cfg.branch}`]).catch(() => null);
        if (r.error === null) r.ok = true;
        // The branch is now box/<branch>: nothing waits.
        r.changes_waiting = 0;
      } else {
        fail(fullErr(p.out, p.err, p.code, `git push box ${cfg.branch}`));
        r.changes_waiting = await changesWaiting(repo);
      }
    } catch (e) {
      fail(errText(e));
      r.changes_waiting = await changesWaiting(repo);
    }
  }

  // 5. GitHub backup, after a good cycle only, in the background.
  if (r.ok) githubBackup(repo, rc, r, cfg.project);
  // 6. A project with its own remote: the box has no credentials, so after this laptop pulls a change from the box it
  // pushes the branch to `origin` itself. Owed until it succeeds.
  if (cfg.project && rc.get("remote.origin.url") !== undefined) {
    // What the LFS upload just cleared stays cleared (the Rust cycle wrote its older list back here).
    st.lfs_owed = (await loadState(repo)).lfs_owed;
    if (r.merged) {
      st.origin_owed = true;
      await saveState(repo, st);
    }
    if (st.origin_owed && r.error === null && r.conflict === null) {
      const spec = `refs/heads/${cfg.branch}:refs/heads/${cfg.branch}`;
      try {
        const p = await repo.sgNet(["push", "--porcelain", "origin", spec]);
        if (p.code === 0) {
          st.origin_owed = false;
          await saveState(repo, st);
          r.origin_push = p.out.includes("[up to date]") ? `origin already had ${cfg.branch}` : `pushed ${cfg.branch} to origin (the box has no credentials)`;
        } else r.origin_warning = fullErr(p.out, p.err, p.code, `git push origin ${cfg.branch}`);
      } catch (e) {
        r.origin_warning = errText(e);
      }
    }
  }
  r.message = finalMessage(lfsBlocked);
  return r;
}
