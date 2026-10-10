// The git commands the mission/agent paths reach (git.ts gitCommitAll,
// gitLogSubdir; store.ts gitRepoRootForFile).
import { realpathSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { runGit, git, withRepoLock, abortStuckMergeOrRebase, stageAllExceptLarge, reportSkipped, AGENT_GIT_NAME, AGENT_GIT_EMAIL } from "../git";
import type { CommandFn } from "./registry";

/** lib.rs:2500 human_identity — the repo's effective user.*, else the app's. */
async function humanIdentity(repo: string): Promise<[string, string]> {
  const get = async (k: string) => {
    const r = await runGit(repo, ["config", "--get", k]).catch(() => null);
    const v = r && r.code === 0 ? r.stdout.trim() : "";
    return v || null;
  };
  return [(await get("user.name")) ?? "vault-chat", (await get("user.email")) ?? "vault-chat@local"];
}

/** lib.rs:4016 git_commit_all, plus the server's 50 MB staging rule. */
export async function gitCommitAll(vault: string, message: string, agent: boolean): Promise<string | null> {
  return withRepoLock(vault, async () => {
    await abortStuckMergeOrRebase(vault);
    const st = await git(vault, ["status", "--porcelain", "--ignore-submodules=dirty"]);
    if (!st.trim()) return null;
    const [name, email] = agent ? [AGENT_GIT_NAME, AGENT_GIT_EMAIL] : await humanIdentity(vault);
    const id = ["-c", `user.name=${name}`, "-c", `user.email=${email}`];
    const skipped = await stageAllExceptLarge(vault, id);
    reportSkipped(skipped);
    const staged = await runGit(vault, ["diff", "--cached", "--quiet"]);
    if (staged.code === 0) return null; // only oversized files changed
    await git(vault, [...id, "commit", "-q", "-m", message]);
    return (await git(vault, ["rev-parse", "--short", "HEAD"])).trim();
  });
}

export const gitCommands: Record<string, CommandFn> = {
  // lib.rs:4016
  git_commit_all: ({ vault, message, agent }) => gitCommitAll(vault, String(message), !!agent),

  // lib.rs:3841 — read-only log, confined to the vault.
  git_log_subdir: async ({ vault, subdir, since, author, maxCount }) => {
    const rel = String(subdir ?? "").trim();
    const target = rel === "" || rel === "." ? vault : join(vault, rel);
    let canonRoot: string;
    let canonTarget: string;
    try {
      canonRoot = realpathSync(vault);
    } catch (e) {
      throw `vault path: ${(e as Error).message}`;
    }
    try {
      canonTarget = realpathSync(target);
    } catch (e) {
      throw `subdir ${subdir}: ${(e as Error).message}`;
    }
    const sep = canonRoot.endsWith("/") || canonRoot.endsWith("\\") ? "" : canonRoot.includes("\\") ? "\\" : "/";
    if (canonTarget !== canonRoot && !canonTarget.startsWith(canonRoot + sep)) throw "subdir escapes the vault";
    const args = ["log", "--oneline", "--no-color", `-n${Math.min(maxCount ?? 40, 500)}`];
    if (since && String(since).trim()) args.push(`--since=${String(since).trim()}`);
    if (author && String(author).trim()) args.push(`--author=${String(author).trim()}`);
    const r = await runGit(target, args);
    if (r.code !== 0) throw `git log ${subdir}: ${r.stderr.trim()}`;
    return r.stdout;
  },

  // lib.rs:4126 — nearest .git at or above the file, never above the vault.
  git_repo_root_for_file: ({ vault, path }) => {
    const v = resolve(vault);
    let cur = resolve(path);
    try {
      if (!statSync(cur).isDirectory()) cur = dirname(cur);
    } catch {
      cur = dirname(cur);
    }
    for (;;) {
      if (!cur.startsWith(v)) return null;
      if (existsSync(join(cur, ".git"))) return cur.replace(/\\/g, "/");
      if (cur === v) return null;
      const up = dirname(cur);
      if (up === cur) return null;
      cur = up;
    }
  },
};
