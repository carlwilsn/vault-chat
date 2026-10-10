// An in-memory git for the History modal (Ctrl+H), the per-file history, the
// autosave net and the agent's commits. Commits are full snapshots of the
// vault's text files; history is seeded by the scenario (oldest first, the
// first one tagged `vault-chat-start`), and every runtime commit/restore/revert
// really changes the in-memory working tree. Shapes follow lib.rs:4085–5900.

import * as fs from "../shims/memfs";
import { stat, unifiedPatch } from "./diff";

type Snapshot = Map<string, string>; // rel → content (binary: "\0bin:<size>")
export type Commit = {
  hash: string;
  short: string;
  subject: string;
  body: string;
  author: string;
  at: number;
  tree: Snapshot;
  parent: Commit | null;
};
type Repo = { commits: Commit[]; anchor: string | null };

export type SeedCommit = {
  subject: string;
  body?: string;
  author?: string;
  /** ms since epoch */
  at: number;
  /** rel → new content, null = delete, "@current" = the fixture's content */
  changes: Record<string, string | null>;
  anchor?: boolean;
};

const repos = new Map<string, Repo>();
let now: () => number = () => Date.now();
export function setGitClock(fn: () => number): void {
  now = fn;
}

const HUMAN = "Carl Wilson";
const AGENT = "vault-chat-agent";

function hashOf(seed: string): string {
  // FNV-1a over the seed, stretched to 40 hex chars. Deterministic per seed.
  let out = "";
  let h = 0x811c9dc5;
  for (let round = 0; out.length < 40; round++) {
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i) + round;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, "0");
  }
  return out.slice(0, 40);
}

function ignored(rel: string): boolean {
  return (
    rel.startsWith(".git/") ||
    rel === ".vault-chat/app-log.txt" ||
    rel === ".vault-chat/client-events.jsonl" ||
    rel.startsWith(".vault-chat/captures/") ||
    rel.endsWith(".tmp")
  );
}

function workingTree(vault: string): Snapshot {
  const snap: Snapshot = new Map();
  for (const rel of fs.listFiles(vault)) {
    if (ignored(rel)) continue;
    const full = `${vault}/${rel}`;
    if (fs.isLazyBinary(full) || /\.(pdf|png|jpe?g|gif|webp|mp4|zip)$/i.test(rel)) snap.set(rel, `\0bin:${fs.fileSize(full)}`);
    else snap.set(rel, fs.readText(full) ?? "");
  }
  return snap;
}

function writeTree(vault: string, from: Snapshot, to: Snapshot): void {
  for (const [rel, content] of to) {
    if (from.get(rel) === content) continue;
    if (content.startsWith("\0bin:")) continue; // binaries stay as they are
    fs.seedText(`${vault}/${rel}`, content, now());
  }
  for (const rel of from.keys()) if (!to.has(rel) && !from.get(rel)!.startsWith("\0bin:")) fs.rmSync(`${vault}/${rel}`, { force: true });
}

function repo(vault: string): Repo {
  let r = repos.get(vault);
  if (!r) {
    r = { commits: [], anchor: null };
    repos.set(vault, r);
  }
  return r;
}

function head(vault: string): Commit | null {
  const c = repo(vault).commits;
  return c.length ? c[c.length - 1] : null;
}

function makeCommit(vault: string, subject: string, tree: Snapshot, author: string, at: number, body = ""): Commit {
  const r = repo(vault);
  const parent = head(vault);
  const hash = hashOf(`${vault}|${r.commits.length}|${subject}|${at}`);
  const c: Commit = { hash, short: hash.slice(0, 7), subject, body, author, at, tree, parent };
  r.commits.push(c);
  return c;
}

/** Seed history oldest-first. The working tree must already hold the
 *  untouched files; each commit's changes are applied to it too, so HEAD and
 *  the working tree agree when seeding is done. */
export function seedHistory(vault: string, commits: SeedCommit[]): void {
  repos.delete(vault);
  // Paths a seed commit mentions are defined entirely by the commits (created
  // by the first one that mentions them); every other file of the working
  // tree is in the first commit as it is.
  const mentioned = new Set<string>();
  for (const c of commits) for (const rel of Object.keys(c.changes)) mentioned.add(rel);
  let tree = workingTree(vault);
  const orig = new Map(tree);
  for (const rel of mentioned) tree.delete(rel);
  for (const [i, c] of commits.entries()) {
    const next = new Map(tree);
    for (const [rel, v] of Object.entries(c.changes)) {
      const val = v === "@current" ? orig.get(rel) ?? null : v;
      if (val === null) next.delete(rel);
      else next.set(rel, val);
    }
    // The first commit carries the base tree plus its own changes.
    const commit = makeCommit(vault, c.subject, next, c.author ?? HUMAN, c.at, c.body ?? "");
    if (c.anchor || (i === 0 && !commits.some((x) => x.anchor))) repo(vault).anchor = commit.hash;
    tree = next;
  }
  // Working tree = HEAD for every path the commits mention.
  for (const rel of mentioned) {
    const v = tree.get(rel);
    if (v === undefined) fs.rmSync(`${vault}/${rel}`, { force: true });
    else if (!v.startsWith("\0bin:")) fs.seedText(`${vault}/${rel}`, v, c0Time(commits));
  }
}
function c0Time(commits: SeedCommit[]): number {
  return commits.length ? commits[commits.length - 1].at : now();
}

function find(vault: string, ref: string): Commit {
  const r = repo(vault);
  const h = String(ref).replace(/\^$/, "");
  const c = r.commits.find((x) => x.hash === h || x.short === h || x.hash.startsWith(h));
  if (!c) throw `fatal: bad revision '${ref}'`;
  return c;
}

function fmtDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function toGitCommit(vault: string, c: Commit) {
  return {
    hash: c.hash,
    short_hash: c.short,
    subject: c.subject,
    body: c.body,
    author: c.author,
    date: fmtDate(c.at),
    is_anchor: repo(vault).anchor === c.hash,
  };
}

function changed(c: Commit): Array<{ rel: string; before: string | null; after: string | null }> {
  const before = c.parent?.tree ?? new Map<string, string>();
  const out: Array<{ rel: string; before: string | null; after: string | null }> = [];
  const keys = new Set([...before.keys(), ...c.tree.keys()]);
  for (const rel of [...keys].sort()) {
    const a = before.get(rel) ?? null;
    const b = c.tree.get(rel) ?? null;
    if (a !== b) out.push({ rel, before: a, after: b });
  }
  return out;
}

function newestFirst(vault: string, includeAll: boolean, filter?: (c: Commit) => boolean): Commit[] {
  const r = repo(vault);
  const out: Commit[] = [];
  for (let i = r.commits.length - 1; i >= 0; i--) {
    const c = r.commits[i];
    if (!filter || filter(c)) out.push(c);
    if (c.hash === r.anchor && !includeAll) break;
  }
  return out;
}

function commitWorkingTree(vault: string, message: string, agent: boolean): string | null {
  const h = head(vault);
  const wt = workingTree(vault);
  if (h) {
    let same = h.tree.size === wt.size;
    if (same) for (const [k, v] of wt) if (h.tree.get(k) !== v) { same = false; break; }
    if (same) return null;
  }
  return makeCommit(vault, message, wt, agent ? AGENT : HUMAN, now()).short;
}

function asText(v: string | null): string | null {
  return v !== null && v.startsWith("\0bin:") ? `Binary file (${v.slice(5)} bytes)` : v;
}

export const gitCommands: Record<string, (a: Record<string, any>) => unknown> = {
  git_init_if_needed: ({ vault }) => {
    if (head(vault)) return false;
    makeCommit(vault, "vault-chat start", workingTree(vault), HUMAN, now());
    repo(vault).anchor = head(vault)!.hash;
    return true;
  },
  git_commit_all: ({ vault, message, agent }) => commitWorkingTree(vault, String(message ?? "autosave"), !!agent),
  git_recent_commits: ({ vault, n, includeBeforeStart }) =>
    newestFirst(vault, !!includeBeforeStart).slice(0, Math.min(n ?? 30, 500)).map((c) => toGitCommit(vault, c)),
  git_repo_root_for_file: ({ vault }) => (head(vault) ? vault : null),
  git_log_subdir: ({ vault, subdir, maxCount }) => {
    const pre = subdir ? String(subdir).replace(/\/$/, "") + "/" : "";
    const list = newestFirst(vault, true, (c) => !pre || changed(c).some((f) => f.rel.startsWith(pre))).slice(0, maxCount ?? 50);
    return list.map((c) => `${c.short} ${fmtDate(c.at)} ${c.author}: ${c.subject}`).join("\n");
  },
  git_revert_head: ({ vault }) => {
    const h = head(vault);
    if (!h || !h.parent) throw "nothing to undo yet";
    const wt = workingTree(vault);
    writeTree(vault, wt, h.parent.tree);
    return makeCommit(vault, `Revert "${h.subject}"`, new Map(h.parent.tree), HUMAN, now(), `This reverts commit ${h.hash}.`).short;
  },
  git_show_commit: ({ vault, hash, patch }) => {
    const c = find(vault, hash);
    const files = changed(c);
    const statLines = files.map((f) => {
      const s = stat(asText(f.before), asText(f.after));
      return ` ${f.rel} | ${s.additions + s.deletions} ${"+".repeat(Math.min(s.additions, 30))}${"-".repeat(Math.min(s.deletions, 30))}`;
    });
    let out = `${c.short} ${c.subject}\n\n${c.body}\n${statLines.join("\n")}\n ${files.length} file${files.length === 1 ? "" : "s"} changed\n`;
    if (patch) out += "\n" + files.map((f) => unifiedPatch(f.rel, asText(f.before), asText(f.after))).join("");
    return out.length > 80_000 ? out.slice(0, 80_000) + "\n… (truncated)" : out;
  },
  git_restore_to_commit: ({ vault, hash }) => {
    const c = find(vault, hash);
    const h = head(vault);
    if (h && h.hash === c.hash) throw "already at this commit";
    writeTree(vault, workingTree(vault), c.tree);
    const msg = c.subject ? `Restore: ${c.subject} (${c.short})` : `Restore to ${c.short}`;
    return makeCommit(vault, msg, new Map(c.tree), HUMAN, now()).short;
  },
  git_all_touched_files: ({ vault, includeBeforeStart }) => {
    const list = newestFirst(vault, !!includeBeforeStart).filter((c) => includeBeforeStart || c.hash !== repo(vault).anchor);
    const byPath = new Map<string, any>();
    for (const c of list) {
      for (const f of changed(c)) {
        const cur = byPath.get(f.rel);
        if (cur) cur.edits++;
        else
          byPath.set(f.rel, {
            path: f.rel,
            last_hash: c.hash,
            last_short_hash: c.short,
            last_subject: c.subject,
            last_date: fmtDate(c.at),
            edits: 1,
            status: head(vault)!.tree.has(f.rel) ? "exists" : "deleted",
          });
      }
    }
    return [...byPath.values()];
  },
  git_commit_files: ({ vault, hash }) =>
    changed(find(vault, hash)).map((f) => {
      const s = stat(asText(f.before), asText(f.after));
      return { path: f.rel, status: f.before === null ? "A" : f.after === null ? "D" : "M", additions: s.additions, deletions: s.deletions };
    }),
  git_file_history: ({ vault, relativePath, n, includeBeforeStart }) =>
    newestFirst(vault, !!includeBeforeStart, (c) => (c.parent?.tree.get(relativePath) ?? null) !== (c.tree.get(relativePath) ?? null))
      .slice(0, Math.min(n ?? 50, 500))
      .map((c) => toGitCommit(vault, c)),
  git_file_at: ({ vault, hash, relativePath }) => asText(find(vault, hash).tree.get(relativePath) ?? null) ?? "",
  git_diff_vs_current: ({ vault, hash, relativePath }) => {
    const h = head(vault);
    const c = find(vault, hash);
    return unifiedPatch(relativePath, asText(h?.tree.get(relativePath) ?? null), asText(c.tree.get(relativePath) ?? null));
  },
  git_restore_file_to: ({ vault, hash, relativePath }) => {
    const c = find(vault, hash);
    const v = c.tree.get(relativePath);
    const full = `${vault}/${relativePath}`;
    if (v === undefined) fs.rmSync(full, { force: true });
    else if (!v.startsWith("\0bin:")) fs.seedText(full, v, now());
    const leaf = String(relativePath).split("/").pop();
    return makeCommit(vault, `Restore ${leaf} to ${c.short}`, workingTree(vault), HUMAN, now()).short;
  },
};

export function gitHeadShort(vault: string): string | null {
  return head(vault)?.short ?? null;
}
export function gitDirty(vault: string): number {
  const h = head(vault);
  if (!h) return 0;
  const wt = workingTree(vault);
  let n = 0;
  for (const [k, v] of wt) if (h.tree.get(k) !== v) n++;
  for (const k of h.tree.keys()) if (!wt.has(k)) n++;
  return n;
}
