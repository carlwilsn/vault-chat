import { invoke } from "@tauri-apps/api/core";

export type GitCommit = {
  hash: string;
  short_hash: string;
  subject: string;
  body: string;
  author: string;
  date: string;
  is_anchor: boolean;
};

export async function gitInitIfNeeded(vault: string): Promise<boolean> {
  try {
    return await invoke<boolean>("git_init_if_needed", { vault });
  } catch (e) {
    console.warn("[git] init failed:", e);
    return false;
  }
}

// Process-wide commit mutex. Now that agents can run in parallel (the
// foreground vault agent plus background Telegram/scheduled runs), two
// runs can finish at nearly the same instant and each tries to commit.
// Concurrent `git add`/`git commit` in one repo races on `index.lock` and
// can drop or corrupt a commit. Serialize every commit through one chain
// so they apply one at a time, in arrival order.
let commitChain: Promise<unknown> = Promise.resolve();

export async function gitCommitAll(
  vault: string,
  message: string,
): Promise<string | null> {
  const run = commitChain.then(async () => {
    try {
      return await invoke<string | null>("git_commit_all", { vault, message });
    } catch (e) {
      console.warn("[git] commit failed:", e);
      return null;
    }
  });
  // Keep the chain alive regardless of this commit's outcome (already
  // caught above, so this never actually rejects).
  commitChain = run.catch(() => {});
  return run;
}

export async function gitRecentCommits(
  vault: string,
  n = 30,
  includeBeforeStart = false,
): Promise<GitCommit[]> {
  try {
    return await invoke<GitCommit[]>("git_recent_commits", {
      vault,
      n,
      includeBeforeStart,
    });
  } catch (e) {
    console.warn("[git] log failed:", e);
    return [];
  }
}

// Read-only `git log` for a repo at a vault-relative subdirectory —
// including nested work repos (e.g. `DeepDL/bitnet-repro`) that the
// vault-root-only gitRecentCommits can't see. Always works regardless of
// the Bash tool being enabled; used by the GitLog agent tool.
export async function gitLogSubdir(
  vault: string,
  subdir: string,
  opts: { since?: string; author?: string; maxCount?: number } = {},
): Promise<string> {
  try {
    return await invoke<string>("git_log_subdir", {
      vault,
      subdir,
      since: opts.since ?? null,
      author: opts.author ?? null,
      maxCount: opts.maxCount ?? null,
    });
  } catch (e) {
    return `(git log failed for ${subdir || "."}: ${String(e)})`;
  }
}

export async function gitRevertHead(vault: string): Promise<string> {
  return await invoke<string>("git_revert_head", { vault });
}

export async function gitShowCommit(
  vault: string,
  hash: string,
  patch = false,
): Promise<string> {
  return await invoke<string>("git_show_commit", { vault, hash, patch });
}

export async function gitRestoreToCommit(vault: string, hash: string): Promise<string> {
  return await invoke<string>("git_restore_to_commit", { vault, hash });
}

export type TouchedFile = {
  path: string;
  last_hash: string;
  last_short_hash: string;
  last_subject: string;
  last_date: string;
  edits: number;
  status: "exists" | "deleted";
};

export async function gitAllTouchedFiles(
  vault: string,
  includeBeforeStart = false,
): Promise<TouchedFile[]> {
  try {
    return await invoke<TouchedFile[]>("git_all_touched_files", {
      vault,
      includeBeforeStart,
    });
  } catch (e) {
    console.warn("[git] all touched files failed:", e);
    return [];
  }
}

export type CommitFile = {
  path: string;
  status: string;
  additions: number;
  deletions: number;
};

export async function gitCommitFiles(
  vault: string,
  hash: string,
): Promise<CommitFile[]> {
  try {
    return await invoke<CommitFile[]>("git_commit_files", { vault, hash });
  } catch (e) {
    console.warn("[git] commit files failed:", e);
    return [];
  }
}

export async function gitFileHistory(
  vault: string,
  relativePath: string,
  n = 50,
  includeBeforeStart = false,
): Promise<GitCommit[]> {
  try {
    return await invoke<GitCommit[]>("git_file_history", {
      vault,
      relativePath,
      n,
      includeBeforeStart,
    });
  } catch (e) {
    console.warn("[git] file history failed:", e);
    return [];
  }
}

export async function gitFileAt(
  vault: string,
  hash: string,
  relativePath: string,
): Promise<string> {
  return await invoke<string>("git_file_at", { vault, hash, relativePath });
}

export async function gitDiffVsCurrent(
  vault: string,
  hash: string,
  relativePath: string,
): Promise<string> {
  return await invoke<string>("git_diff_vs_current", { vault, hash, relativePath });
}

export async function gitRestoreFileTo(
  vault: string,
  hash: string,
  relativePath: string,
): Promise<string> {
  return await invoke<string>("git_restore_file_to", { vault, hash, relativePath });
}
