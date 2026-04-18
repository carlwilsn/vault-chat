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
