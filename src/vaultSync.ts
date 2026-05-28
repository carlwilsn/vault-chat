import { invoke } from "@tauri-apps/api/core";

// Per-vault auto-sync configuration. Persisted to
// `<vault>/.vault-chat/config.json`. Default: disabled — opting in is
// explicit per vault so a fresh open never starts pushing.
export type VaultSyncConfig = {
  enabled: boolean;
  // How often we poll the remote for new commits. Seconds.
  pullIntervalSec: number;
  // Quiet period after the last local change before we auto-commit + push.
  pushDebounceSec: number;
};

export const DEFAULT_SYNC_CONFIG: VaultSyncConfig = {
  enabled: false,
  pullIntervalSec: 30,
  pushDebounceSec: 5,
};

export type SyncStatus = {
  has_repo: boolean;
  remote: string | null;
  has_changes: boolean;
  nested_repos: string[];
};

export type SyncOpResult = {
  ok: boolean;
  message: string;
  error: boolean;
};

const CONFIG_DIR = ".vault-chat";
const CONFIG_FILE = "config.json";

type VaultConfigFile = {
  sync?: Partial<VaultSyncConfig>;
};

export async function readVaultConfig(vault: string): Promise<VaultConfigFile> {
  try {
    const path = `${vault}/${CONFIG_DIR}/${CONFIG_FILE}`;
    const raw = await invoke<string>("read_text_file", { path });
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed as VaultConfigFile;
    }
    return {};
  } catch {
    return {};
  }
}

export async function writeVaultConfig(
  vault: string,
  config: VaultConfigFile,
): Promise<void> {
  const path = `${vault}/${CONFIG_DIR}/${CONFIG_FILE}`;
  const contents = JSON.stringify(config, null, 2) + "\n";
  await invoke("write_text_file", { path, contents });
}

export async function readVaultSyncConfig(
  vault: string,
): Promise<VaultSyncConfig> {
  const cfg = await readVaultConfig(vault);
  return {
    ...DEFAULT_SYNC_CONFIG,
    ...(cfg.sync ?? {}),
  };
}

export async function writeVaultSyncConfig(
  vault: string,
  patch: Partial<VaultSyncConfig>,
): Promise<VaultSyncConfig> {
  const current = await readVaultConfig(vault);
  const merged: VaultSyncConfig = {
    ...DEFAULT_SYNC_CONFIG,
    ...(current.sync ?? {}),
    ...patch,
  };
  await writeVaultConfig(vault, { ...current, sync: merged });
  return merged;
}

export async function getVaultSyncStatus(vault: string): Promise<SyncStatus> {
  return await invoke<SyncStatus>("vault_sync_status", { vault });
}

export async function setVaultRemote(vault: string, url: string): Promise<void> {
  await invoke("vault_sync_set_remote", { vault, url });
}

export async function vaultCommitLocal(vault: string): Promise<SyncOpResult> {
  return await invoke<SyncOpResult>("vault_sync_commit_local", { vault });
}

export async function vaultPull(vault: string): Promise<SyncOpResult> {
  return await invoke<SyncOpResult>("vault_sync_pull", { vault });
}

export async function vaultPush(vault: string): Promise<SyncOpResult> {
  return await invoke<SyncOpResult>("vault_sync_push", { vault });
}

export async function vaultGhCreateRepo(
  vault: string,
  name: string,
  privateRepo: boolean,
): Promise<SyncOpResult> {
  return await invoke<SyncOpResult>("vault_sync_gh_create_repo", {
    vault,
    name,
    privateRepo,
  });
}

// ---- in-process sync loop ----
//
// One loop per opted-in vault. The loop polls the local working tree
// and the remote on independent timers. Switching vaults tears down
// the prior loop and starts a fresh one for the new vault if it's
// also opted in.

type SyncSnapshot = {
  lastSyncedAt: number | null;
  lastMessage: string;
  lastError: string | null;
  running: boolean;
  remote: string | null;
  hasChanges: boolean;
  nestedRepos: string[];
};

type SyncListener = (snapshot: SyncSnapshot) => void;

type Loop = {
  vault: string;
  cancel: () => void;
};

let activeLoop: Loop | null = null;
let snapshot: SyncSnapshot = {
  lastSyncedAt: null,
  lastMessage: "",
  lastError: null,
  running: false,
  remote: null,
  hasChanges: false,
  nestedRepos: [],
};
const listeners = new Set<SyncListener>();

function emit() {
  for (const l of listeners) l(snapshot);
}

export function subscribeSyncStatus(fn: SyncListener): () => void {
  listeners.add(fn);
  fn(snapshot);
  return () => listeners.delete(fn);
}

export function getSyncSnapshot(): SyncSnapshot {
  return snapshot;
}

function resetSnapshot() {
  snapshot = {
    lastSyncedAt: null,
    lastMessage: "",
    lastError: null,
    running: false,
    remote: null,
    hasChanges: false,
    nestedRepos: [],
  };
  emit();
}

export async function startVaultSyncLoop(vault: string): Promise<void> {
  stopVaultSyncLoop();
  resetSnapshot();
  const config = await readVaultSyncConfig(vault);
  if (!config.enabled) return;

  let cancelled = false;
  let pullTimer: number | null = null;
  let pushTimer: number | null = null;
  let lastChangeAt = 0;
  let lastChangeSig = "";

  const setStatus = (patch: Partial<SyncSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    emit();
  };

  const refreshStatus = async () => {
    if (cancelled) return null;
    try {
      const st = await getVaultSyncStatus(vault);
      setStatus({
        remote: st.remote,
        hasChanges: st.has_changes,
        nestedRepos: st.nested_repos,
      });
      return st;
    } catch (e) {
      console.warn("[vault-sync] status failed:", e);
      return null;
    }
  };

  const tickPull = async () => {
    if (cancelled) return;
    setStatus({ running: true });
    const result = await vaultPull(vault).catch((e) => ({
      ok: false,
      message: String(e),
      error: true,
    }));
    if (cancelled) return;
    if (result.ok) {
      setStatus({
        lastSyncedAt: Date.now(),
        lastMessage: result.message,
        lastError: null,
        running: false,
      });
    } else if (result.error) {
      setStatus({ lastError: result.message, running: false });
    } else {
      setStatus({ lastMessage: result.message, running: false });
    }
    await refreshStatus();
  };

  const tickPush = async () => {
    pushTimer = null;
    if (cancelled) return;
    const cur = await refreshStatus();
    if (!cur || !cur.has_changes) return;
    setStatus({ running: true });
    const commit = await vaultCommitLocal(vault).catch((e) => ({
      ok: false,
      message: String(e),
      error: true,
    }));
    if (cancelled) return;
    if (!commit.ok && commit.error) {
      setStatus({ lastError: commit.message, running: false });
      return;
    }
    const push = await vaultPush(vault).catch((e) => ({
      ok: false,
      message: String(e),
      error: true,
    }));
    if (cancelled) return;
    if (push.ok) {
      setStatus({
        lastSyncedAt: Date.now(),
        lastMessage: push.message,
        lastError: null,
        running: false,
      });
    } else if (push.error) {
      setStatus({ lastError: push.message, running: false });
    } else {
      setStatus({ lastMessage: push.message, running: false });
    }
    await refreshStatus();
  };

  // Watch for local changes via cheap polling (every 2s). When the
  // working tree signature changes, mark the time; if the user goes
  // quiet for `pushDebounceSec`, fire a push.
  const watchInterval = window.setInterval(async () => {
    if (cancelled) return;
    const st = await refreshStatus();
    if (!st) return;
    const sig = `${st.has_changes ? 1 : 0}`;
    if (st.has_changes) {
      if (sig !== lastChangeSig) {
        lastChangeSig = sig;
        lastChangeAt = Date.now();
      } else {
        // Even with same sig, treat ongoing dirty as a heartbeat — but
        // only update the timer if there were no recent edits. We use
        // a separate detection: if push is already scheduled, leave it.
        if (pushTimer === null) lastChangeAt = Date.now();
      }
      if (pushTimer === null) {
        const delay = Math.max(1000, config.pushDebounceSec * 1000);
        pushTimer = window.setTimeout(() => {
          void tickPush();
        }, delay);
      }
    } else {
      lastChangeSig = sig;
    }
  }, 2000);

  const pullEvery = Math.max(5000, config.pullIntervalSec * 1000);
  pullTimer = window.setInterval(() => {
    void tickPull();
  }, pullEvery) as unknown as number;

  // Initial pass: refresh status, do one pull so the user gets fresh
  // commits as soon as they open the vault.
  void (async () => {
    await refreshStatus();
    await tickPull();
  })();

  activeLoop = {
    vault,
    cancel: () => {
      cancelled = true;
      if (pullTimer !== null) window.clearInterval(pullTimer);
      if (pushTimer !== null) window.clearTimeout(pushTimer);
      window.clearInterval(watchInterval);
    },
  };

  // Silence the unused warning — lastChangeAt is set above and could
  // be used by future "idle since" UI.
  void lastChangeAt;
}

export function stopVaultSyncLoop(): void {
  if (activeLoop) {
    activeLoop.cancel();
    activeLoop = null;
  }
  resetSnapshot();
}

export function activeSyncVault(): string | null {
  return activeLoop?.vault ?? null;
}

// Restart the loop after the config changed for the active vault.
export async function restartVaultSyncIfActive(vault: string): Promise<void> {
  if (activeLoop?.vault === vault || activeLoop === null) {
    await startVaultSyncLoop(vault);
  }
}
