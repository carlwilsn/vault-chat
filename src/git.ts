import { invoke } from "@tauri-apps/api/core";

/// Find the git repository root for a given file path, capped at the vault
/// boundary. Returns the repo root path, or null if the file is not in any
/// sub-repo. The result falls back to vaultPath when null.
export async function gitRepoRootForFile(
  vault: string,
  path: string,
): Promise<string | null> {
  try {
    return await invoke<string | null>("git_repo_root_for_file", { vault, path });
  } catch (e) {
    console.warn("[git] repo root for file failed:", e);
    return null;
  }
}

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

/// Rust appends the attribution trailers (Vault-Chat-Actor / -Machine and,
/// for an agent turn, its Conversation) that History reads.
export async function gitCommitAll(
  vault: string,
  message: string,
  agent = false,
  conversation?: string | null,
): Promise<string | null> {
  const run = commitChain.then(async () => {
    try {
      return await invoke<string | null>("git_commit_all", { vault, message, agent, conversation: conversation ?? null });
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

// Read-only `git log` for a repo at a vault-relative subdirectory —
// including nested work repos (e.g. `DeepDL/bitnet-repro`) that the
// vault-root history timeline doesn't cover. Always works regardless of
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
