// The box sync's pure rules: parsers, the managed files' texts, the error words. No I/O (cycle.ts does it).
// A port of src-tauri/src/box_sync.rs (and the lib.rs pieces it uses); the same names, values and texts, so the Rust
// and the TypeScript cycles can take turns on one vault.

/** Never auto-commit a file larger than this (it goes through Git LFS). */
export const BOX_MAX_FILE_BYTES = 50 * 1024 * 1024;
/** The fetched box branch. */
export const BOX_REF = "refs/remotes/box/box";
export const BOX_REMOTE = "box";
export const GITHUB_REMOTE = "github";
export const GITHUB_DEBOUNCE_MS = 600_000;
/** Even when the refs say the box has master, push again this often. */
export const PUSH_VERIFY_EVERY_MS = 300_000;
/** Network ops (fetch/push) get a longer leash than local git, but bounded. */
export const NET_TIMEOUT_SECS = 120;
/** lib.rs GIT_TIMEOUT_SECS: every other git call. */
export const GIT_TIMEOUT_SECS = 90;
export const EXCLUDE_BEGIN = "# >>> vault-chat: files over 50 MB, kept out of git";
export const EXCLUDE_END = "# <<< vault-chat";
export const LFS_ATTRS = "filter=lfs diff=lfs merge=lfs -text";
/** The managed block of `.gitattributes`; the same lines as server/lfsAttrs.ts writes on the box. */
export const LFS_BLOCK_BEGIN = "# >>> vault-chat: files over 50 MB, stored with Git LFS on the box";
export const LFS_BLOCK_END = "# <<< vault-chat: files over 50 MB";
export const LFS_SELF_UNION = "/.gitattributes merge=union";
/** A merge that checks out files over 50 MB downloads them (git-lfs smudge). */
export const LFS_MERGE_TIMEOUT_SECS = 1800;
/** One upload to GitHub carries at most about this much (see box_sync.rs GITHUB_STEP_BYTES). */
export const GITHUB_STEP_BYTES = 32 * 1024 * 1024;
export const GITHUB_UPLOAD_BRANCH = "vault-chat-upload";
export const GITHUB_STEP_TIMEOUT_SECS = 600;
/** lib.rs APP_GIT_*: the identity of a repo with none configured. */
export const APP_GIT_NAME = "vault-chat";
export const APP_GIT_EMAIL = "vault-chat@local";
/** The vault-chat folder's own file (src/master.ts). */
export const MASTER_FILE = ".vault-chat-master.json";
/** In a repo's .git: never sync it (a copy being brought in). */
export const NO_SYNC_MARK = "vault-chat-no-sync";
/** The machine-local state, in the repo's git dir. */
export const STATE_FILE = "vault-chat-box-sync.json";

/** lib.rs MISSION_ZONE_PATHS: paths only the box authors. */
export const MISSION_ZONE_PATHS = [
  ".vault-chat/supervisor",
  ".vault-chat/selftest",
  ".vault-chat/schedules.jsonl",
  ".vault-chat/notifications.jsonl",
  ".vault-chat/jobs.jsonl",
] as const;

/** Never committed from this laptop in box mode (the box's conversation log and the conversations before it). */
export const NEVER_STAGED = [".vault-chat/conversations", ".vault-chat/events"] as const;

const under = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);
export const isZonePath = (rel: string): boolean => MISSION_ZONE_PATHS.some((z) => under(rel, z));
export const neverStaged = (path: string): boolean => NEVER_STAGED.some((n) => under(path, n));

/** Rust's `str::lines`: split on \n, drop one \r before it, no empty last line. */
export function lines(s: string): string[] {
  if (s === "") return [];
  const parts = s.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

/** Combine stdout+stderr of a failed git call into one honest message. */
export function fullErr(out: string, err: string, code: number, what: string): string {
  let s = `${what} failed (exit ${code})`;
  const e = err.trim();
  const o = out.trim();
  if (e) s += `:\n${e}`;
  if (o) s += `\n${o}`;
  return s;
}

const NET_WORDS = [
  "could not resolve host",
  "failed to connect",
  "couldn't connect",
  "connection refused",
  "connection timed out",
  "timed out",
  "operation timed out",
  "network is unreachable",
  "no route to host",
  "could not read from remote",
  "502",
  "503",
  "504",
  "does not appear to be a git repository",
  "unable to access",
];

/** Network failure (box asleep, off the tailnet, DNS) vs. a real git problem. */
export function classifyError(stderr: string): "unreachable" | "git" {
  const e = stderr.toLowerCase();
  return NET_WORDS.some((n) => e.includes(n)) ? "unreachable" : "git";
}

export type GithubProblem = "too_big" | "offline" | "auth" | "rejected" | "other";

/** What a failed push to GitHub means, for the plain-words status. */
export function githubProblem(stderr: string): GithubProblem {
  const e = stderr.toLowerCase();
  const has = (xs: string[]) => xs.some((x) => e.includes(x));
  if (has(["could not resolve host", "failed to connect", "couldn't connect", "network is unreachable", "no route to host", "connection refused"])) return "offline";
  if (has(["authentication failed", "could not read username", "could not read password", "permission denied", "the requested url returned error: 403", "repository not found"])) return "auth";
  if (has(["[rejected]", "non-fast-forward", "fetch first"])) return "rejected";
  if (
    has([
      "rpc failed",
      "remote end hung up",
      "send failure",
      "connection was aborted",
      "connection was reset",
      "connection reset",
      "early eof",
      "pack exceeds maximum allowed size",
      "unpacker error",
      "unpack failed",
      "returned error: 413",
      "returned error: 500",
      "returned error: 502",
      "returned error: 503",
      "returned error: 504",
      "git timed out after",
      "timed out",
    ])
  )
    return "too_big";
  return "other";
}

/** Cut `missing` (commit, bytes it adds; oldest first) into upload steps of at most `budget` bytes (a commit bigger
 *  than that is a step of its own). Returns the last commit of each step. */
export function githubSteps(missing: readonly (readonly [string, number])[], budget: number): string[] {
  const steps: string[] = [];
  let acc = 0;
  missing.forEach(([c, n], i) => {
    if (acc > 0 && acc + n > budget) {
      steps.push(missing[i - 1]![0]);
      acc = 0;
    }
    acc += n;
    if (i + 1 === missing.length) steps.push(c);
  });
  return steps;
}

/** "Nothing to commit" from `git commit`: not an error, just no commit. */
export function nothingToCommit(out: string, err: string): boolean {
  const t = `${out}\n${err}`;
  return t.includes("nothing to commit") || t.includes("nothing added to commit") || t.includes("no changes added to commit");
}

// ---------- the repo's config, read in one process ----------

export class RepoConfig {
  constructor(readonly values: [string, string][] = []) {}
  /** The effective value (the last one wins, as in `git config --get`). */
  get(key: string): string | undefined {
    for (let i = this.values.length - 1; i >= 0; i--) if (this.values[i]![0] === key) return this.values[i]![1];
    return undefined;
  }
  all(key: string): string[] {
    return this.values.filter(([k]) => k === key).map(([, v]) => v);
  }
  /** The user's real identity (what a bare `git commit` would use). */
  identity(): [string, string] {
    const pick = (k: string, d: string) => {
      const v = this.get(k)?.trim();
      return v ? v : d;
    };
    return [pick("user.name", APP_GIT_NAME), pick("user.email", APP_GIT_EMAIL)];
  }
}

/** `git config -z --get-regexp` output: `key\nvalue\0` per entry. */
export function parseConfigZ(out: string): RepoConfig {
  return new RepoConfig(
    out
      .split("\0")
      .filter((r) => r !== "")
      .map((r): [string, string] => {
        const i = r.indexOf("\n");
        return i < 0 ? [r, ""] : [r.slice(0, i), r.slice(i + 1)];
      }),
  );
}

export const REPO_CONFIG_RE =
  "^(remote\\.(box|github|origin)\\.(url|fetch)|fetch\\.recursesubmodules|submodule\\.recurse|user\\.(name|email)|core\\.hookspath|lfs\\.(url|locksverify)|filter\\.lfs\\.(clean|smudge|process|required))$";

/** Hook body that is Git LFS's own (`git lfs post-commit "$@"` …). */
export function isLfsHook(body: string): boolean {
  return lines(body)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"))
    .every((l) => l.startsWith("command -v git-lfs") || l.startsWith("git lfs ") || l.startsWith("git-lfs "));
}

/** The hooks git runs (githooks(5)): what the hooks folder is read for. */
export const HOOK_NAMES = [
  "applypatch-msg",
  "pre-applypatch",
  "post-applypatch",
  "pre-commit",
  "pre-merge-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "pre-rebase",
  "post-checkout",
  "post-merge",
  "pre-push",
  "pre-receive",
  "update",
  "proc-receive",
  "post-receive",
  "post-update",
  "reference-transaction",
  "push-to-checkout",
  "pre-auto-gc",
  "post-rewrite",
  "sendemail-validate",
  "fsmonitor-watchman",
  "p4-changelist",
  "p4-prepare-changelist",
  "p4-post-changelist",
  "p4-pre-submit",
  "post-index-change",
] as const;

// ---------- git status --porcelain=v2 -z ----------

export type StatusEntry = { x: string; path: string; untracked: boolean };
export type WorkStatus = { branch: string | null; entries: StatusEntry[] };

export function parseStatusV2(out: string): WorkStatus {
  const st: WorkStatus = { branch: null, entries: [] };
  const recs = out.split("\0");
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i]!;
    if (rec === "") continue;
    if (rec.startsWith("# branch.head ")) {
      const b = rec.slice("# branch.head ".length);
      st.branch = b === "(detached)" ? null : b;
      continue;
    }
    const kind = rec[0];
    const fields = kind === "1" ? 9 : kind === "2" ? 10 : kind === "u" ? 11 : kind === "?" ? 0 : -1;
    if (fields < 0) continue;
    if (kind === "?") {
      st.entries.push({ x: "?", path: rec.slice(2), untracked: true });
      continue;
    }
    const parts = splitN(rec, " ", fields);
    if (parts.length < fields) continue;
    st.entries.push({ x: parts[1]![0] ?? ".", path: parts[fields - 1]!, untracked: false });
    // A rename/copy: its original path follows as its own field.
    if (kind === "2") i++;
  }
  return st;
}

/** Rust's `splitn`: at most `n` parts, the last one the rest. */
function splitN(s: string, sep: string, n: number): string[] {
  const out: string[] = [];
  let rest = s;
  while (out.length < n - 1) {
    const i = rest.indexOf(sep);
    if (i < 0) break;
    out.push(rest.slice(0, i));
    rest = rest.slice(i + sep.length);
  }
  out.push(rest);
  return out;
}

// ---------- the old exclude block (files over 50 MB kept out of git) ----------

export function escapeExclude(path: string): string {
  let s = "/";
  for (const ch of path) s += ("*?[\\ !#".includes(ch) ? "\\" : "") + ch;
  return s;
}

/** The exclude file with its managed block rewritten to exactly `paths`. */
export function excludeWithBlock(cur: string, paths: readonly string[]): string {
  const kept: string[] = [];
  let inside = false;
  for (const l of lines(cur)) {
    if (l === EXCLUDE_BEGIN) {
      inside = true;
      continue;
    }
    if (inside) {
      if (l === EXCLUDE_END) inside = false;
      continue;
    }
    kept.push(l);
  }
  let next = kept.join("\n");
  if (next !== "" && !next.endsWith("\n")) next += "\n";
  if (paths.length) next += [EXCLUDE_BEGIN, ...paths.map(escapeExclude), EXCLUDE_END].join("\n") + "\n";
  return next;
}

export function readExcludeBlockText(cur: string): string[] {
  const out: string[] = [];
  let inside = false;
  for (const l of lines(cur)) {
    if (l === EXCLUDE_BEGIN) {
      inside = true;
      continue;
    }
    if (!inside) continue;
    if (l === EXCLUDE_END) break;
    // Undo escapeExclude: drop the leading "/" and the backslashes.
    let p = "";
    let esc = false;
    for (const ch of l.replace(/^\/+/, "")) {
      if (!esc && ch === "\\") {
        esc = true;
        continue;
      }
      esc = false;
      p += ch;
    }
    out.push(p);
  }
  return out;
}

/** The exclude file with `line` in it (outside the managed block); null when it is there already. */
export function withExcludeLine(cur: string, line: string): string | null {
  if (lines(cur).some((l) => l === line)) return null;
  let next = cur;
  if (next !== "" && !next.endsWith("\n")) next += "\n";
  return `${next}${line}\n`;
}

// ---------- files over 50 MB: Git LFS lines in .gitattributes ----------

/** The `.gitattributes` line that sends exactly `path` through LFS. */
export function lfsAttrLine(path: string): string {
  let p = "/";
  for (const ch of path) p += ("\\*?[".includes(ch) ? "\\" : "") + ch;
  if ([...p].some((c) => /\s/.test(c) || c === '"')) {
    let q = '"';
    for (const ch of p) q += ch === "\\" ? "\\\\" : ch === '"' ? '\\"' : ch === "\t" ? "\\t" : ch;
    p = q + '"';
  }
  return `${p} ${LFS_ATTRS}`;
}

/** The path an `lfsAttrLine` names. */
export function parseLfsAttrLine(line: string): string | null {
  const suffix = ` ${LFS_ATTRS}`;
  if (!line.endsWith(suffix)) return null;
  const pat = line.slice(0, -suffix.length).trim();
  let unq = pat;
  if (pat.length >= 2 && pat.startsWith('"') && pat.endsWith('"')) {
    unq = "";
    const it = [...pat.slice(1, -1)];
    for (let i = 0; i < it.length; i++) {
      const c = it[i]!;
      if (c !== "\\") {
        unq += c;
        continue;
      }
      const n = it[++i];
      unq += n === undefined ? "\\" : n === "t" ? "\t" : n === "n" ? "\n" : n;
    }
  }
  if (!unq.startsWith("/")) return null;
  let out = "";
  const it = [...unq.slice(1)];
  for (let i = 0; i < it.length; i++) {
    const c = it[i]!;
    out += c === "\\" ? (it[++i] ?? "\\") : c;
  }
  return out === "" ? null : out;
}

/** The managed block of `.gitattributes` as it stands: the text outside it (its raw lines) and the files it names. */
export function lfsBlockOf(cur: string): { kept: string[]; named: string[]; hasBlock: boolean } {
  const kept: string[] = [];
  const named: string[] = [];
  let hasBlock = false;
  let inside = false;
  for (const raw of cur.split("\n")) {
    const l = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (l === LFS_BLOCK_BEGIN) {
      inside = hasBlock = true;
      continue;
    }
    if (l === LFS_BLOCK_END) {
      inside = false;
      continue;
    }
    if (inside) {
      const p = parseLfsAttrLine(l);
      if (p !== null) named.push(p);
      continue;
    }
    kept.push(raw);
  }
  return { kept, named, hasBlock };
}

/** `.gitattributes` with its managed block naming `want` (null: unchanged, the block already says that). */
export function lfsAttributesText(cur: string, stillBig: (p: string) => boolean, big: readonly string[]): string | null {
  const { kept, named, hasBlock } = lfsBlockOf(cur);
  const want: string[] = [];
  for (const p of [...named.filter(stillBig), ...big]) if (!p.includes("\n") && !p.includes("\r") && !want.includes(p)) want.push(p);
  if (want.length === named.length && want.every((p, i) => p === named[i]) && (hasBlock || want.length === 0)) return null;
  let next = kept.join("\n").replace(/\n+$/, "");
  if (next !== "") next += "\n";
  if (want.length) next += [LFS_BLOCK_BEGIN, LFS_SELF_UNION, ...want.map(lfsAttrLine), LFS_BLOCK_END].join("\n") + "\n";
  return next === cur ? null : next;
}

/** Seconds for moving `bytes` (at least ~1 MB/s, never under the network leash). */
export const lfsSecs = (bytes: number): number => NET_TIMEOUT_SECS + Math.floor(bytes / (1024 * 1024));

// ---------- lib.rs: the vault's managed .gitattributes / .gitignore ----------

export const VAULT_GITATTRIBUTES = `# Managed by vault-chat. Keeps cross-machine git sync conflict-free.
* text=auto eol=lf
*.jsonl merge=union
*.pdf binary
*.png binary
*.jpg binary
*.jpeg binary
*.gif binary
*.webp binary
*.ico binary
*.zip binary
*.gz binary
*.bundle binary
`;

export const VAULT_GITIGNORE = `# Managed by vault-chat. Ephemeral machine-local state — never synced.
.vault-chat/run-heartbeat.json
.vault-chat/firer-heartbeat.json
.vault-chat/*heartbeat*.conflict
.vault-chat/app-log.txt
.vault-chat/app-log.1.txt
.vault-chat/client-events.jsonl
.vault-chat/client-events.1.jsonl
.vault-chat/diag/
.vault-chat/sync-log.jsonl
.vault-chat/pending-wakes.json
.vault-chat/*.bak
.vault-chat/*.tmp
__pycache__/
*.pyc
`;

export const VAULT_GITIGNORE_REQUIRED = [
  ".vault-chat/run-heartbeat.json",
  ".vault-chat/firer-heartbeat.json",
  ".vault-chat/*heartbeat*.conflict",
  ".vault-chat/app-log.txt",
  ".vault-chat/app-log.1.txt",
  ".vault-chat/client-events.jsonl",
  ".vault-chat/client-events.1.jsonl",
  ".vault-chat/diag/",
  ".vault-chat/sync-log.jsonl",
  ".vault-chat/pending-wakes.json",
  ".vault-chat/*.bak",
  ".vault-chat/*.tmp",
  "__pycache__/",
  "*.pyc",
];

/** lib.rs ensure_vault_gitattributes: the new text, or null when the managed block is there. */
export function vaultGitattributesText(current: string): string | null {
  if (current.includes("Managed by vault-chat")) return null;
  return current.trim() === "" ? VAULT_GITATTRIBUTES : `${VAULT_GITATTRIBUTES}\n${current}`;
}

/** lib.rs ensure_vault_gitignore: the new text, or null when nothing is missing. */
export function vaultGitignoreText(current: string): string | null {
  const hasMarker = current.includes("Managed by vault-chat");
  const have = lines(current).map((l) => l.trim());
  const missing = VAULT_GITIGNORE_REQUIRED.filter((line) => !have.includes(line));
  if (hasMarker && missing.length === 0) return null;
  if (!hasMarker) return current.trim() === "" ? VAULT_GITIGNORE : `${VAULT_GITIGNORE}\n${current}`;
  let s = current.endsWith("\n") ? current : `${current}\n`;
  for (const line of missing) s += `${line}\n`;
  return s;
}

/** A small stable hash (FNV-1a, 32 bit) for the untrack sweep's key. */
export function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}
