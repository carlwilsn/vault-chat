import { invoke } from "@tauri-apps/api/core";
import { useStore, type FileEntry } from "./store";

// After a pull pulls in commits from another machine, the file tree
// should reflect new/renamed/deleted files without a manual refresh. We
// re-list on each successful pull but only push to the store when the
// file set actually changed, so an unchanged 30s pull doesn't re-render.
let lastFileTreeSig = "";

async function refreshFileTreeIfChanged(vault: string): Promise<void> {
  // Only touch the tree for the vault that's actually open.
  if (useStore.getState().vaultPath !== vault) return;
  try {
    const listed = await invoke<FileEntry[]>("list_markdown_files", { vault });
    const sig = listed
      .map((f) => `${f.path} ${f.is_dir ? 1 : 0} ${f.hidden ? 1 : 0}`)
      .join("\n");
    if (sig !== lastFileTreeSig) {
      lastFileTreeSig = sig;
      useStore.getState().setFiles(listed);
    }
  } catch (e) {
    console.warn("[vault-sync] file-tree refresh failed:", e);
  }
}

// Force a file-tree re-list and push to the store unconditionally. The
// signature check in refreshFileTreeIfChanged only tracks the file SET, not
// per-repo git dirty counts — so after a local commit clears a nested repo's
// changes, the dot won't disappear until something forces a fresh list. Used
// right after a successful local commit.
async function forceRefreshFileTree(vault: string): Promise<void> {
  if (useStore.getState().vaultPath !== vault) return;
  try {
    const listed = await invoke<FileEntry[]>("list_markdown_files", { vault });
    lastFileTreeSig = listed
      .map((f) => `${f.path} ${f.is_dir ? 1 : 0} ${f.hidden ? 1 : 0}`)
      .join("\n");
    useStore.getState().setFiles(listed);
  } catch (e) {
    console.warn("[vault-sync] force file-tree refresh failed:", e);
  }
}

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
  // Local commits not yet pushed to the upstream.
  ahead: number;
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
    // A vault whose sync.json names a box always syncs (with the box).
    ...((await readBoxConfig(vault)) ? { enabled: true } : {}),
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

// Commit-only: root + nested repos, no remote operation. Powers the always-on
// local-commit loop so a vault without sync still earns version history and its
// nested-repo dots clear.
export async function vaultCommitLocalOnly(vault: string): Promise<SyncOpResult> {
  return await invoke<SyncOpResult>("vault_commit_local", { vault });
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

// ---- durable sync-failure log ----
//
// The red sync-status banner is transient: `lastError` is overwritten on the
// next tick, so a failed merge/push flashes once and vanishes with no history —
// which makes "why does it fail, and is there a pattern?" unanswerable. So every
// failure, the recovery that follows it, and every divergence-merge is appended
// as a JSONL line to `<vault>/.vault-chat/sync-log.jsonl`. That file is
// machine-local + gitignored (mirroring app-log.txt), so recording a failure
// never perturbs the very sync it's measuring. Each line is hostname-stamped so
// a failure can be pinned to a specific machine when correlating across boxes.

let hostCache: string | null = null;
async function syncLogHost(): Promise<string> {
  if (hostCache !== null) return hostCache;
  try {
    hostCache = await invoke<string>("machine_host");
  } catch {
    hostCache = "unknown";
  }
  return hostCache;
}

type SyncLogLevel = "error" | "recovered" | "merge";

// Fire-and-forget: logging must never throw into or stall the sync loop.
function appendSyncLog(
  vault: string,
  level: SyncLogLevel,
  op: string,
  message: string,
  extra?: Record<string, unknown>,
): void {
  void (async () => {
    try {
      const line = JSON.stringify({
        t: new Date().toISOString(),
        host: await syncLogHost(),
        level,
        op,
        message,
        ...(extra ?? {}),
      });
      await invoke("append_sync_log", { vaultPath: vault, line });
    } catch {
      // best-effort
    }
  })();
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
  ahead: number;
  nestedRepos: string[];
};

type SyncListener = (snapshot: SyncSnapshot) => void;

type Loop = {
  vault: string;
  cancel: () => void;
};

// One loop PER vault, like the scheduler — so a sync-enabled vault keeps
// pushing/pulling in the background even when you've switched to a different
// vault. (Previously a single global loop meant only the foreground vault ever
// synced; opening another vault silently stranded the first.) The Rust side
// serializes git per repo with its own lock, and each loop has its own
// single-flight guard, so distinct vaults' loops never collide.
const loops = new Map<string, Loop>();

const EMPTY_SNAPSHOT: SyncSnapshot = {
  lastSyncedAt: null,
  lastMessage: "",
  lastError: null,
  running: false,
  remote: null,
  hasChanges: false,
  ahead: 0,
  nestedRepos: [],
};

// Per-vault status. The UI only ever shows the *open* vault's snapshot, but we
// keep one per vault so switching back to a synced vault shows its real state
// immediately instead of a blank until its next tick.
const snapshots = new Map<string, SyncSnapshot>();
const listeners = new Set<SyncListener>();

function openVault(): string | null {
  return useStore.getState().vaultPath;
}

function snapOf(vault: string): SyncSnapshot {
  return snapshots.get(vault) ?? { ...EMPTY_SNAPSHOT };
}

function emitOpen() {
  const v = openVault();
  const s = v ? snapOf(v) : { ...EMPTY_SNAPSHOT };
  for (const l of listeners) l(s);
  const b = v ? boxStates.get(v) ?? null : null;
  for (const l of boxListeners) l(b);
}

export function subscribeSyncStatus(fn: SyncListener): () => void {
  listeners.add(fn);
  const v = openVault();
  fn(v ? snapOf(v) : { ...EMPTY_SNAPSHOT });
  return () => listeners.delete(fn);
}

export function getSyncSnapshot(): SyncSnapshot {
  const v = openVault();
  return v ? snapOf(v) : { ...EMPTY_SNAPSHOT };
}

// Re-broadcast the (now-)open vault's snapshot. Call when the open vault
// changes so the status row reflects the vault you just switched to.
export function focusVaultSync(): void {
  emitOpen();
}

// Per-vault start serialization. Without it, two concurrent starts for the same
// vault (e.g. the launch effect and the open-vault effect both firing on mount)
// could each pass the `loops.has` check during the `await readVaultSyncConfig`
// gap and leave TWO live loops for one vault — the resource race the old
// single-loop design existed to prevent. Every start/ensure for a vault runs to
// completion before the next begins (mirrors git.ts's commit chain).
const startChains = new Map<string, Promise<void>>();

function serializeStart(vault: string, fn: () => Promise<void>): Promise<void> {
  const prev = startChains.get(vault) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  startChains.set(
    vault,
    next.catch(() => {}),
  );
  return next;
}

// Idempotent: start a loop for `vault` only if one isn't already running.
// Used on launch (every tracked sync-enabled vault) and on vault open.
export function ensureVaultSyncLoop(vault: string): Promise<void> {
  return serializeStart(vault, async () => {
    if (loops.has(vault)) return;
    await doStartVaultSyncLoop(vault);
  });
}

// Start (or restart) the loop for `vault`. Restart semantics so a config change
// (enable/disable, remote, intervals) takes effect immediately.
export function startVaultSyncLoop(vault: string): Promise<void> {
  return serializeStart(vault, () => doStartVaultSyncLoop(vault));
}

async function doStartVaultSyncLoop(vault: string): Promise<void> {
  stopVaultSyncLoop(vault);
  // sync.json names a box → the per-machine-branch sync with the merge gate
  // instead of the origin loop below.
  const box = await readBoxConfig(vault);
  if (box) {
    startBoxSyncLoop(vault, box);
    return;
  }
  const config = await readVaultSyncConfig(vault);

  let cancelled = false;
  let pullTimer: number | null = null;
  let pushTimer: number | null = null;
  let lastChangeAt = 0;
  let lastChangeSig = "";

  const setStatus = (patch: Partial<SyncSnapshot>) => {
    snapshots.set(vault, { ...snapOf(vault), ...patch });
    if (openVault() === vault) emitOpen();
  };

  // Failure-dedup for the durable log: a persistent error (network down, a
  // wedged remote) would otherwise write an identical line every tick. We log a
  // failure once when it first appears and once when it clears, so the file
  // reads as a timeline of distinct incidents — not per-tick noise. `null` =
  // currently healthy; otherwise the `op|message` signature of the last failure.
  let lastFailSig: string | null = null;

  const recordResult = (op: string, r: SyncOpResult) => {
    if (!r.ok && r.error) {
      const sig = `${op}|${r.message}`;
      if (sig !== lastFailSig) {
        lastFailSig = sig;
        appendSyncLog(vault, "error", op, r.message, { ahead: snapOf(vault).ahead });
      }
      return;
    }
    if (r.ok) {
      // A divergence reconciliation (a merge, or an auto-resolved conflict) is
      // worth recording even when nothing failed — it's the event that tends to
      // precede a push race, so it's the other half of any pattern.
      if (r.message.includes("merged")) {
        appendSyncLog(vault, "merge", op, r.message);
      }
      if (lastFailSig !== null) {
        appendSyncLog(vault, "recovered", op, r.message, { from: lastFailSig });
        lastFailSig = null;
      }
    }
  };

  // Single-flight guard: only one git invocation runs at a time for this vault.
  // Without it the 2s watch tick fired a fresh `git status` even while a prior
  // one was still blocked — on a slow repo (big submodules, a held index lock)
  // they stacked into dozens of orphaned git processes all contending for the
  // index lock, which is exactly what wedged the summer sync (status timing out
  // at 90s, over and over). Every git-spawning step now checks this flag and
  // bows out if one is already running.
  let gitOpInFlight = false;

  // Unguarded status — the real work. Callers that already hold the in-flight
  // guard (tickPull/tickPush/commitPass) use this so they don't deadlock
  // against their own guard.
  const rawStatus = async () => {
    if (cancelled) return null;
    try {
      const st = await getVaultSyncStatus(vault);
      setStatus({
        remote: st.remote,
        hasChanges: st.has_changes,
        ahead: st.ahead,
        nestedRepos: st.nested_repos,
      });
      return st;
    } catch (e) {
      console.warn("[vault-sync] status failed:", e);
      return null;
    }
  };

  // Guarded status for the cheap 2s watch tick: skip entirely if any git op
  // (pull / push / commit / another status) is already in flight, so ticks
  // never pile up behind a slow one.
  const refreshStatus = async () => {
    if (cancelled || gitOpInFlight) return null;
    gitOpInFlight = true;
    try {
      return await rawStatus();
    } finally {
      gitOpInFlight = false;
    }
  };

  // Local-commit-only mode. When remote sync isn't enabled, the vault still
  // earns version history: the root and every nested repo get committed
  // LOCALLY on a quiet interval, so work is captured and the file-tree dirty
  // dots clear — with no remote, no push, no fork. (Opting into sync layers
  // pull/push on top — the full loop below.)
  if (!config.enabled) {
    const commitPass = async () => {
      if (cancelled || gitOpInFlight) return;
      gitOpInFlight = true;
      try {
        const res = await vaultCommitLocalOnly(vault).catch(() => null);
        if (cancelled || !res) return;
        recordResult("commit-local", res);
        if (res.ok && res.message !== "no local changes") {
          // Something committed — clear the now-stale dirty dots in the tree.
          await forceRefreshFileTree(vault);
        }
        await rawStatus();
      } finally {
        gitOpInFlight = false;
      }
    };
    const commitInterval = window.setInterval(() => {
      void commitPass();
    }, 12000) as unknown as number;
    void commitPass(); // initial pass on open
    loops.set(vault, {
      vault,
      cancel: () => {
        cancelled = true;
        window.clearInterval(commitInterval);
      },
    });
    return;
  }

  const tickPull = async () => {
    if (cancelled || gitOpInFlight) return;
    gitOpInFlight = true;
    try {
      setStatus({ running: true });
      const result = await vaultPull(vault).catch((e) => ({
        ok: false,
        message: String(e),
        error: true,
      }));
      if (cancelled) return;
      recordResult("pull", result);
      if (result.ok) {
        setStatus({
          lastSyncedAt: Date.now(),
          lastMessage: result.message,
          lastError: null,
          running: false,
        });
        // Surface any files the pull brought in from another machine.
        void refreshFileTreeIfChanged(vault);
        // Same for conversations: a chat updated on another machine (e.g. a
        // reply written on the phone) should appear here without an app
        // restart. Non-destructive — never clobbers a locally-running chat.
        void useStore.getState().refreshConversationsFromDisk(vault);
      } else if (result.error) {
        setStatus({ lastError: result.message, running: false });
      } else {
        setStatus({ lastMessage: result.message, running: false });
      }
      const st = await rawStatus();
      // Flush commits that were made but never pushed. The dirty-tree push
      // trigger only fires while the working tree has uncommitted changes;
      // a commit landed when the remote had advanced (or made out-of-band)
      // leaves a clean tree that nothing re-pushes, so it strands silently
      // while the status still reads "synced". Pulling first, then pushing
      // any remaining `ahead`, closes that gap each cycle.
      //
      // Critically, attempt the flush when `ahead > 0` OR when status is
      // UNKNOWN (st === null, e.g. a slow `git status`): the old `st && ...`
      // guard meant a single failed status silently skipped the flush, so a
      // stranded commit waited indefinitely for a clean status that a wedged
      // repo never produced. vault_sync_push is a cheap no-op ("Everything
      // up-to-date") when there's actually nothing ahead, so over-attempting
      // is safe; under-attempting is what strands work.
      if ((st === null || st.ahead > 0) && !cancelled) {
        const flush = await vaultPush(vault).catch(() => null);
        if (flush) recordResult("push-flush", flush);
        if (flush?.ok) {
          setStatus({ lastSyncedAt: Date.now(), lastError: null });
        }
        await rawStatus();
      }
    } finally {
      gitOpInFlight = false;
    }
  };

  const tickPush = async () => {
    pushTimer = null;
    if (cancelled || gitOpInFlight) return;
    gitOpInFlight = true;
    try {
      const cur = await rawStatus();
      if (!cur || !cur.has_changes) return;
      setStatus({ running: true });
      const commit = await vaultCommitLocal(vault).catch((e) => ({
        ok: false,
        message: String(e),
        error: true,
      }));
      if (cancelled) return;
      recordResult("commit", commit);
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
      recordResult("push", push);
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
      await rawStatus();
    } finally {
      gitOpInFlight = false;
    }
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

  loops.set(vault, {
    vault,
    cancel: () => {
      cancelled = true;
      if (pullTimer !== null) window.clearInterval(pullTimer);
      if (pushTimer !== null) window.clearTimeout(pushTimer);
      window.clearInterval(watchInterval);
    },
  });

  // Silence the unused warning — lastChangeAt is set above and could
  // be used by future "idle since" UI.
  void lastChangeAt;
}

// Stop one vault's loop, or ALL of them when called with no argument (app
// unmount). Stopping a vault clears its snapshot; if it was the open vault, the
// UI status row clears too.
export function stopVaultSyncLoop(vault?: string): void {
  if (vault === undefined) {
    for (const l of loops.values()) l.cancel();
    loops.clear();
    snapshots.clear();
    boxStates.clear();
    emitOpen();
    return;
  }
  const l = loops.get(vault);
  if (l) {
    l.cancel();
    loops.delete(vault);
  }
  snapshots.delete(vault);
  boxStates.delete(vault);
  if (openVault() === vault) emitOpen();
}

// Vaults with a live sync loop right now.
export function activeSyncVaults(): string[] {
  return [...loops.keys()];
}

// ---- box sync (sync.json names a box) ----
//
// The laptop side of the per-machine-branch model: every cycle the engine
// commits local edits on master, fetches the box's branch, merges it only if
// the merge is clean (the gate), pushes master, and backs up to GitHub. See
// src-tauri/src/box_sync.rs. This loop only schedules cycles, keeps the
// attention state for the Titlebar chip, and sends the one phone alert.

export type BoxConfig = { box: string; vault: string };

export type BoxSyncReport = {
  configured: boolean;
  ok: boolean;
  message: string;
  committed: boolean;
  merged: boolean;
  conflict: { files: string[]; since: number } | null;
  error: string | null;
  error_kind: "unreachable" | "git" | null;
  changes_waiting: number;
  big_files: { path: string; size: number }[];
  github_warning: string | null;
  github_pushed_at: number | null;
};

export type BoxAttention = {
  kind: "conflict" | "offline" | "error" | "big" | "github";
  level: "amber" | "red";
  /** One line for the chip. */
  text: string;
  /** Full details for the popover (full git stderr where there is one). */
  detail: string;
  since: number;
};

export type BoxSyncState = {
  vault: string;
  box: string;
  running: boolean;
  lastCycleAt: number | null;
  lastOkAt: number | null;
  report: BoxSyncReport | null;
  /** First failed cycle of the current failure streak. */
  failingSince: number | null;
  bigSince: number | null;
  githubFailingSince: number | null;
  attention: BoxAttention | null;
};

const BOX_CYCLE_MS = 15_000;
/** A failure must last this long before the chip shows (no blips). */
const BOX_SHOW_FAILURE_AFTER_MS = 60_000;
/** Amber turns red, and the phone gets its one alert, after this long. */
const BOX_RED_AFTER_MS = 10 * 60_000;

const boxStates = new Map<string, BoxSyncState>();
type BoxListener = (s: BoxSyncState | null) => void;
const boxListeners = new Set<BoxListener>();
const boxConfigCache = new Map<string, { cfg: BoxConfig | null; at: number }>();
const boxKick = new Map<string, () => Promise<void>>();

/** The box this vault syncs with (from `.vault-chat/sync.json`), or null. */
export async function readBoxConfig(vault: string): Promise<BoxConfig | null> {
  const hit = boxConfigCache.get(vault);
  if (hit && Date.now() - hit.at < 30_000) return hit.cfg;
  let cfg: BoxConfig | null = null;
  try {
    cfg = (await invoke<BoxConfig | null>("vault_box_config", { vault })) ?? null;
  } catch {
    cfg = null;
  }
  boxConfigCache.set(vault, { cfg, at: Date.now() });
  return cfg;
}

export function subscribeBoxSync(fn: BoxListener): () => void {
  boxListeners.add(fn);
  const v = openVault();
  fn(v ? boxStates.get(v) ?? null : null);
  return () => boxListeners.delete(fn);
}

/** Run one cycle now (Settings' "Sync now"). */
export async function boxSyncNow(vault: string): Promise<void> {
  const k = boxKick.get(vault);
  if (k) await k();
}

function plural(n: number, w: string): string {
  return `${n} ${w}${n === 1 ? "" : "s"}`;
}

export function fmtSize(bytes: number): string {
  return bytes >= 1024 * 1024 * 1024
    ? `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
    : `${Math.round(bytes / (1024 * 1024))} MB`;
}

// The line of git's stderr that says what went wrong (skipping our own
// "git … failed (exit n)" header and git's generic trailer).
function firstLine(s: string): string {
  const lines = s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const meaningful = lines.find(
    (l) => !/^git .* failed \(exit -?\d+\):?$/.test(l) && !/^error: failed to push some refs/.test(l),
  );
  return (meaningful ?? lines[0] ?? s).replace(/^(fatal|error): /, "").slice(0, 120);
}

/** What (if anything) needs Carl's attention, most important first. */
export function boxAttentionOf(st: BoxSyncState, now = Date.now()): BoxAttention | null {
  const r = st.report;
  if (!r) return null;
  const level = (since: number): BoxAttention["level"] => (now - since >= BOX_RED_AFTER_MS ? "red" : "amber");
  if (r.conflict && r.conflict.files.length) {
    const f = r.conflict.files;
    const names = f.length === 1 ? f[0] : `${f[0]} +${f.length - 1}`;
    return {
      kind: "conflict",
      level: level(r.conflict.since),
      text: `Sync: conflict in ${names}`,
      detail:
        `The box's changes conflict with this laptop's in:\n${f.map((x) => `  ${x}`).join("\n")}\n\n` +
        "Nothing was merged and master is untouched. This laptop's edits still reach the box; " +
        "the box's come in once the conflict is resolved.",
      since: r.conflict.since,
    };
  }
  if (st.failingSince !== null && now - st.failingSince >= BOX_SHOW_FAILURE_AFTER_MS && r.error) {
    const text =
      r.error_kind === "unreachable"
        ? `Box unreachable · ${plural(r.changes_waiting, "change")} waiting`
        : `Sync failing: ${firstLine(r.error)}`;
    return {
      kind: r.error_kind === "unreachable" ? "offline" : "error",
      level: level(st.failingSince),
      text,
      detail: r.error,
      since: st.failingSince,
    };
  }
  if (r.big_files.length && st.bigSince !== null) {
    const b = r.big_files[0];
    const more = r.big_files.length > 1 ? ` +${r.big_files.length - 1}` : "";
    return {
      kind: "big",
      level: level(st.bigSince),
      text: `File too large: ${b.path.split("/").pop()}${more}`,
      detail:
        "Kept out of git (over 50 MB), so the box and GitHub don't have:\n" +
        r.big_files.map((x) => `  ${x.path} (${fmtSize(x.size)})`).join("\n"),
      since: st.bigSince,
    };
  }
  if (r.github_warning && st.githubFailingSince !== null && now - st.githubFailingSince >= BOX_RED_AFTER_MS) {
    return {
      kind: "github",
      level: "amber",
      text: "GitHub backup failing",
      detail: r.github_warning,
      since: st.githubFailingSince,
    };
  }
  return null;
}

// One alert per incident, remembered across restarts (best-effort).
const ALERTED_KEY = "vault-chat:box-sync-alerted";
function alertedSet(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(ALERTED_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}
function markAlerted(key: string): void {
  try {
    const keys = [...alertedSet(), key].slice(-50);
    localStorage.setItem(ALERTED_KEY, JSON.stringify(keys));
  } catch {
    /* best-effort */
  }
}

async function postBoxAlert(box: string, title: string, body: string, tag: string): Promise<boolean> {
  try {
    const token = useStore.getState().missionHostToken || null;
    const r = await invoke<{ status: number; body: string }>("box_post_json", {
      url: `${box}/api/v1/alert`,
      body: JSON.stringify({ title, body, tag }),
      token,
    });
    return r.status >= 200 && r.status < 300;
  } catch {
    return false;
  }
}

function startBoxSyncLoop(vault: string, cfg: BoxConfig): void {
  let cancelled = false;
  let inFlight = false;
  let lastFailSig: string | null = null;
  const vaultName = vault.split("/").filter(Boolean).pop() ?? cfg.vault;

  const set = (patch: Partial<BoxSyncState>) => {
    const prev: BoxSyncState = boxStates.get(vault) ?? {
      vault,
      box: cfg.box,
      running: false,
      lastCycleAt: null,
      lastOkAt: null,
      report: null,
      failingSince: null,
      bigSince: null,
      githubFailingSince: null,
      attention: null,
    };
    const next: BoxSyncState = { ...prev, ...patch };
    next.attention = boxAttentionOf(next);
    boxStates.set(vault, next);
    // Keep the old snapshot shape fed too, so anything that reads it still works.
    const r = next.report;
    snapshots.set(vault, {
      ...snapOf(vault),
      running: next.running,
      lastSyncedAt: next.lastOkAt,
      lastMessage: r?.message ?? "",
      lastError: r?.error ?? null,
      remote: `${cfg.box}/git/${cfg.vault}.git`,
      ahead: r?.changes_waiting ?? 0,
    });
    if (openVault() === vault) emitOpen();
  };

  const maybeAlert = async (st: BoxSyncState) => {
    const r = st.report;
    if (!r) return;
    const sent = alertedSet();
    if (r.conflict) {
      const key = `${vault}|conflict|${r.conflict.since}`;
      if (!sent.has(key)) {
        const ok = await postBoxAlert(
          cfg.box,
          `Sync conflict in ${vaultName}`,
          `The laptop can't merge the box's changes (${r.conflict.files.join(", ")}). On the laptop, ask the agent to resolve the sync conflict.`,
          `vc-sync-conflict-${cfg.vault}`,
        );
        if (ok) markAlerted(key);
      }
    }
    if (st.failingSince !== null && Date.now() - st.failingSince >= BOX_RED_AFTER_MS && r.error) {
      const key = `${vault}|fail|${st.failingSince}`;
      if (!sent.has(key)) {
        const ok = await postBoxAlert(
          cfg.box,
          `Laptop sync failing (${vaultName})`,
          `${firstLine(r.error)} · ${plural(r.changes_waiting, "change")} waiting on the laptop.`,
          `vc-sync-laptop-${cfg.vault}`,
        );
        if (ok) markAlerted(key);
      }
    }
  };

  const cycle = async () => {
    if (cancelled || inFlight) return;
    inFlight = true;
    set({ running: true });
    try {
      const r = await invoke<BoxSyncReport>("vault_box_sync", { vault }).catch(
        (e): BoxSyncReport => ({
          configured: true,
          ok: false,
          message: "sync failed",
          committed: false,
          merged: false,
          conflict: null,
          error: String(e),
          error_kind: "git",
          changes_waiting: 0,
          big_files: [],
          github_warning: null,
          github_pushed_at: null,
        }),
      );
      if (cancelled) return;
      if (!r.configured) {
        // sync.json lost its box: fall back to the ordinary loop.
        boxConfigCache.delete(vault);
        void startVaultSyncLoop(vault);
        return;
      }
      const prev = boxStates.get(vault);
      const now = Date.now();
      set({
        running: false,
        report: r,
        lastCycleAt: now,
        lastOkAt: r.ok ? now : prev?.lastOkAt ?? null,
        failingSince: r.error ? prev?.failingSince ?? now : null,
        bigSince: r.big_files.length ? prev?.bigSince ?? now : null,
        githubFailingSince: r.github_warning ? prev?.githubFailingSince ?? now : null,
      });
      // Durable log: one line per distinct incident (full stderr), one on recovery.
      const sig = r.error ? `error|${r.error}` : r.conflict ? `conflict|${r.conflict.files.join(",")}` : null;
      if (sig !== lastFailSig) {
        if (sig) {
          appendSyncLog(vault, "error", r.error ? "box-sync" : "box-gate", r.error ?? r.message, {
            files: r.conflict?.files,
            ahead: r.changes_waiting,
          });
        } else if (lastFailSig) {
          appendSyncLog(vault, "recovered", "box-sync", r.message, { from: lastFailSig });
        }
        lastFailSig = sig;
      }
      if (r.merged) {
        appendSyncLog(vault, "merge", "box-sync", r.message);
        void refreshFileTreeIfChanged(vault);
        void useStore.getState().refreshConversationsFromDisk(vault);
      } else if (r.committed) {
        void forceRefreshFileTree(vault);
      }
      const st = boxStates.get(vault);
      if (st) await maybeAlert(st);
    } finally {
      inFlight = false;
      if (!cancelled && boxStates.get(vault)?.running) set({ running: false });
    }
  };

  const timer = window.setInterval(() => void cycle(), BOX_CYCLE_MS);
  // Re-evaluate amber → red even while a cycle is stuck.
  const clock = window.setInterval(() => {
    if (boxStates.has(vault)) set({});
  }, 30_000);
  boxKick.set(vault, cycle);
  loops.set(vault, {
    vault,
    cancel: () => {
      cancelled = true;
      window.clearInterval(timer);
      window.clearInterval(clock);
      boxKick.delete(vault);
    },
  });
  void cycle();
}
