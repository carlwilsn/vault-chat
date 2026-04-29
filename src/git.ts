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

export async function gitCommitAll(
  vault: string,
  message: string,
): Promise<string | null> {
  try {
    return await invoke<string | null>("git_commit_all", { vault, message });
  } catch (e) {
    console.warn("[git] commit failed:", e);
    return null;
  }
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
