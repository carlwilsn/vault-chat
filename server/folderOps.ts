// Carl's Rename and Delete on a folder (the laptop's folder picker, the ⋯ on a row), done on the box, which owns the
// working copies; the laptop gets the result through its sync. Nothing is ever hard-deleted (Carl, 2026-10-29:
// "everything is recoverable through git"):
//
//   - a folder inside a repo (a vault's subfolder): what it holds is committed first, then `git rm -r` and a commit,
//     so git has every byte; whatever git does not track (ignored files) is moved to <repo>/.vault-chat/local/deleted/;
//   - a folder that is a repo of its own (a vault or a project repo under the vault-chat folder): moved aside whole to
//     <vault-chat folder>/.deleted/<name>-<stamp>/ (its hub keeps its history); never the box's main vault.
//
// Rename renames a subfolder in place (the sync commits the move); a repo of its own is not renamed here (its hub,
// its sync and the laptop's copy carry its name).
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { renameRetry as renameSync } from "./atomic";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { AGENT_IDENTITY_ARGS, git, withRepoLock } from "./git";

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

function under(p: string, dir: string): boolean {
  const r = relative(dir, p);
  return r === "" || (!!r && r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r));
}

/** The repo holding `abs` (the nearest folder up with a .git), or null. */
export function repoOf(abs: string): string | null {
  let cur = resolve(abs);
  for (;;) {
    if (existsSync(join(cur, ".git"))) return cur;
    const up = dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
}

function freeName(dir: string, name: string): string {
  let to = join(dir, name);
  for (let i = 2; existsSync(to); i++) to = join(dir, `${name}-${i}`);
  return to;
}

export type FolderWalls = {
  /** The vault-chat folder (VC_MASTER), or null. */
  master: string | null;
  /** The box's main vault: never deleted or renamed. */
  mainVault: string;
  /** Every vault's working copy (a folder may be inside one of them or under the vault-chat folder). */
  vaults: string[];
};

/** Whether Carl's ⋯ may act on `abs`: inside a vault or the vault-chat folder, never one of their own folders. */
export function checkTarget(abs: string, w: FolderWalls): { error: string } | null {
  const a = resolve(abs);
  if (!isDir(a)) return { error: `${basename(a)} is not a folder on the box` };
  const roots = [...w.vaults, ...(w.master ? [w.master] : [])].map((r) => resolve(r));
  if (!roots.some((r) => under(a, r))) return { error: `${a} is not in the vault-chat folder` };
  if (w.master && [resolve(w.master), join(resolve(w.master), "vaults"), join(resolve(w.master), "projects"), join(resolve(w.master), ".hub")].includes(a)) return { error: "that is the vault-chat folder's own layout" };
  if (a.split(sep).some((part) => part === ".git" || part === ".vault-chat" || part === ".hub")) return { error: "that folder is vault-chat's own" };
  if (resolve(w.mainVault) === a) return { error: `${basename(a)} is the box's main vault: it stays` };
  return null;
}

/** Delete a folder, recoverably (see the top of this file). */
export async function deleteFolder(abs: string, w: FolderWalls, now = new Date()): Promise<{ ok: true; how: "git" | "moved"; where: string; leftovers?: string } | { error: string }> {
  const bad = checkTarget(abs, w);
  if (bad) return bad;
  const a = resolve(abs);
  const repo = repoOf(a);
  if (!repo || repo === a) {
    // A repo of its own (or no git at all): moved aside whole.
    const base = w.master ? join(resolve(w.master), ".deleted") : join(dirname(a), ".deleted");
    mkdirSync(base, { recursive: true });
    const to = freeName(base, `${basename(a)}-${stamp(now)}`);
    renameSync(a, to);
    return { ok: true, how: "moved", where: to };
  }
  const rel = relative(repo, a).split(sep).join("/");
  return withRepoLock(repo, async () => {
    const id = AGENT_IDENTITY_ARGS;
    // What it holds now, committed first: git keeps every byte of it.
    await git(repo, ["add", "-A", "--", rel]);
    const staged = (await git(repo, ["diff", "--cached", "--name-only", "--", rel])).trim();
    if (staged) await git(repo, [...id, "commit", "-q", "-m", `vault-chat: ${rel} as it was before Carl deleted it`, "--", rel]);
    const tracked = (await git(repo, ["ls-files", "--", rel])).trim();
    if (tracked) {
      await git(repo, ["rm", "-r", "-q", "--", rel]);
      await git(repo, [...id, "commit", "-q", "-m", `vault-chat: Carl deleted ${rel} (git has it: git checkout HEAD~1 -- "${rel}")`]);
    }
    // What git does not track (ignored files) is not lost either.
    let leftovers: string | undefined;
    if (existsSync(a) && readdirSync(a).length) {
      const base = join(repo, ".vault-chat", "local", "deleted");
      mkdirSync(base, { recursive: true });
      leftovers = freeName(base, `${basename(a)}-${stamp(now)}`);
      renameSync(a, leftovers);
    } else if (existsSync(a)) {
      // An empty folder git never saw.
      const base = join(repo, ".vault-chat", "local", "deleted");
      mkdirSync(base, { recursive: true });
      renameSync(a, freeName(base, `${basename(a)}-${stamp(now)}`));
    }
    return { ok: true as const, how: "git" as const, where: rel, ...(leftovers ? { leftovers } : {}) };
  });
}

/** Rename a folder in place (a subfolder of a repo; never a repo of its own). Returns its new path. */
export function renameFolder(abs: string, name: string, w: FolderWalls): { ok: true; path: string } | { error: string } {
  const bad = checkTarget(abs, w);
  if (bad) return bad;
  const a = resolve(abs);
  const n = name
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 80);
  if (!n) return { error: "a folder needs a name" };
  if (n === basename(a)) return { ok: true, path: a };
  if (existsSync(join(a, ".git"))) return { error: `${basename(a)} is a repository of its own (its hub, its sync and the laptop's copy carry its name): rename it from the box's shell` };
  const to = join(dirname(a), n);
  if (existsSync(to)) return { error: `there is already a ${n} beside it` };
  renameSync(a, to);
  return { ok: true, path: to };
}

let wallsNow: (() => FolderWalls) | null = null;

/** The box's walls for the ⋯ (set at boot: server/main.ts). */
export function setFolderOpsWalls(fn: () => FolderWalls): void {
  wallsNow = fn;
}

export function folderOpsWalls(): FolderWalls | null {
  return wallsNow?.() ?? null;
}
