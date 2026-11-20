// Everything the box sync asks of the machine, behind one interface: the shell's narrow git bridge
// (src-tauri/src/git_bridge.rs: git_run, repo_hold, repo_release, file_sizes) and a few file commands. Tests hand the
// cycle a Node implementation that spawns real git (server/test/boxSyncTs.test.ts).
import { invoke } from "@tauri-apps/api/core";

export type GitOut = { out: string; err: string; code: number };
export type RunOpts = { timeoutSecs?: number; input?: string; lease?: string };

export interface Git {
  /** One git process in `cwd`. Rejects when it could not run or timed out (git's own failures are a non-zero code).
   *  `lease`: inside that hold of the repo lock (without one, the shell serializes it with every other git writer). */
  run(cwd: string, args: string[], o?: RunOpts): Promise<GitOut>;
  /** Hold `cwd`'s repo lock until released or `ms` pass (at most 120 s): the lease. */
  hold(cwd: string, ms: number): Promise<string>;
  release(lease: string): Promise<void>;
  /** Sizes of files under `root` (null: not a file). */
  sizes(root: string, paths: string[]): Promise<(number | null)[]>;
  /** A text file, or null (missing, unreadable). */
  readText(path: string): Promise<string | null>;
  /** Write a text file; `repo` names the repo it lies in (a file in its .git goes through the shell's git_dir_write,
   *  which the app's file commands refuse). True when written. */
  writeText(path: string, contents: string, o?: { repo?: string; lease?: string }): Promise<boolean>;
  exists(path: string): Promise<boolean>;
}

/** Whether `path` lies in a repo's .git folder (the shell's write_text_file refuses those). */
export const inDotGit = (path: string): boolean => /(^|[\\/])\.git([\\/]|$)/.test(path);

/** `path` relative to `repo`'s .git folder ("info/exclude"), or null when it is not inside it. */
export function dotGitRel(repo: string, path: string): string | null {
  const norm = (x: string) => x.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = norm(repo) + "/.git/";
  const p = norm(path);
  const win = /^[A-Za-z]:\//.test(base);
  const hit = win ? p.toLowerCase().startsWith(base.toLowerCase()) : p.startsWith(base);
  return hit ? p.slice(base.length) : null;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The installed shell's bridge. */
export const tauriGit: Git = {
  async run(cwd, args, o = {}) {
    try {
      return await invoke<GitOut>("git_run", { cwd, args, timeoutSecs: o.timeoutSecs ?? null, input: o.input ?? null, lease: o.lease ?? null });
    } catch (e) {
      throw new Error(errText(e));
    }
  },
  async hold(cwd, ms) {
    try {
      return await invoke<string>("repo_hold", { cwd, ms });
    } catch (e) {
      throw new Error(errText(e));
    }
  },
  async release(lease) {
    await invoke("repo_release", { lease }).catch(() => {});
  },
  async sizes(root, paths) {
    if (!paths.length) return [];
    try {
      return await invoke<(number | null)[]>("file_sizes", { root, paths });
    } catch {
      return paths.map(() => null);
    }
  },
  async readText(path) {
    try {
      return await invoke<string>("read_text_file", { path });
    } catch {
      return null;
    }
  },
  async writeText(path, contents, o = {}) {
    if (inDotGit(path)) {
      const rel = o.repo ? dotGitRel(o.repo, path) : null;
      if (!o.repo || !rel) return false;
      return invoke("git_dir_write", { cwd: o.repo, rel, contents }).then(() => true, () => false);
    }
    try {
      await invoke("write_text_file", { path, contents });
      return true;
    } catch {
      return false;
    }
  },
  async exists(path) {
    try {
      return await invoke<boolean>("path_exists", { path });
    } catch {
      return false;
    }
  },
};

let bridge: Promise<boolean> | null = null;
/** The installed shell has the git bridge (its core_status lists git_run). Asked once; a failure is "no". */
export function shellHasGitBridge(): Promise<boolean> {
  bridge ??= invoke<{ commands?: unknown }>("core_status")
    .then((s) => Array.isArray(s?.commands) && s.commands.includes("git_run") && s.commands.includes("repo_hold") && s.commands.includes("git_dir_write"))
    .catch(() => false);
  return bridge;
}
