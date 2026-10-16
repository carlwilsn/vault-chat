import { invoke } from "@tauri-apps/api/core";
import { useStore, type FileEntry } from "./store";
import { prepareVaultProjects } from "./projects";
import { refreshOpenFiles } from "./liveReload";
import { afterVaultReady, bootMark } from "./bootTiming";

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

// Two things run per vault, and neither is a setting:
// - autosave for history: every open vault's root and nested repos are
//   committed LOCALLY on a quiet interval (the history Ctrl+H reads). Nothing
//   is pushed or pulled.
// - box sync: only when `.vault-chat/sync.json` names a box. The box cycle
//   (box_sync.rs) commits locally first, then syncs with the box and backs up
//   to GitHub. There is no other remote sync: a vault without a box never
//   pushes or pulls anywhere (an old `sync` block in config.json — enabled,
//   intervals — is ignored, and a git remote the user set stays in their git
//   config untouched).
export type VaultSyncConfig = {
  /** True when the vault syncs with a box (sync.json names one). */
  enabled: boolean;
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

/** How often the autosave-for-history pass commits a vault without a box. */
export const AUTOSAVE_INTERVAL_MS = 12_000;

const CONFIG_DIR = ".vault-chat";
const CONFIG_FILE = "config.json";

type VaultConfigFile = Record<string, unknown>;

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

/** Whether this vault syncs (with its box). Used on launch to start box vaults'
 *  loops in the background; an open vault always gets its loop. */
export async function readVaultSyncConfig(
  vault: string,
): Promise<VaultSyncConfig> {
  return { enabled: (await readBoxConfig(vault)) !== null };
}

export async function getVaultSyncStatus(vault: string): Promise<SyncStatus> {
  return await invoke<SyncStatus>("vault_sync_status", { vault });
}

// Commit-only: root + nested repos, no remote operation. The autosave-for-
// history pass for a vault without a box.
export async function vaultCommitLocalOnly(vault: string): Promise<SyncOpResult> {
  return await invoke<SyncOpResult>("vault_commit_local", { vault });
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
// One loop per vault: the box cycle when sync.json names a box, otherwise the
// local autosave pass. Switching vaults keeps the other loops running.

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
  // Vault open: projects move out of .vault-chat/ into agent-projects/ (hidden
  // by default) before the first sync commits, so the move rides that commit.
  await prepareVaultProjects(vault);
  // sync.json names a box → the per-machine-branch sync with the merge gate
  // (its cycle commits locally first, so autosave continues while the box is
  // unreachable).
  const box = await readBoxConfig(vault);
  if (box) {
    startBoxSyncLoop(vault, box);
    return;
  }
  startAutosaveLoop(vault);
}

// Autosave for history: no box, so no remote. The root and every nested repo
// are committed locally on a quiet interval, so work is captured for Ctrl+H
// and the file-tree dirty dots clear. Nothing is pushed or pulled.
function startAutosaveLoop(vault: string): void {
  let cancelled = false;

  const setStatus = (patch: Partial<SyncSnapshot>) => {
    snapshots.set(vault, { ...snapOf(vault), ...patch });
    if (openVault() === vault) emitOpen();
  };

  // Failure-dedup for the durable log: a persistent error would otherwise
  // write an identical line every tick. Log a failure once when it first
  // appears and once when it clears.
  let lastFailSig: string | null = null;
  const recordResult = (op: string, r: SyncOpResult) => {
    if (!r.ok && r.error) {
      const sig = `${op}|${r.message}`;
      if (sig !== lastFailSig) {
        lastFailSig = sig;
        appendSyncLog(vault, "error", op, r.message);
      }
      return;
    }
    if (r.ok && lastFailSig !== null) {
      appendSyncLog(vault, "recovered", op, r.message, { from: lastFailSig });
      lastFailSig = null;
    }
  };

  // Single-flight: a slow repo (big submodules, a held index lock) must never
  // stack git processes behind each other.
  let inFlight = false;
  const commitPass = async () => {
    if (cancelled || inFlight) return;
    inFlight = true;
    try {
      const res = await vaultCommitLocalOnly(vault).catch((e): SyncOpResult => ({ ok: false, message: String(e), error: true }));
      if (cancelled) return;
      recordResult("commit-local", res);
      if (res.ok && res.message !== "no local changes") {
        // Something committed — clear the now-stale dirty dots in the tree.
        await forceRefreshFileTree(vault);
      }
      try {
        const st = await getVaultSyncStatus(vault);
        if (!cancelled) setStatus({ hasChanges: st.has_changes, nestedRepos: st.nested_repos });
      } catch {
        /* status is cosmetic here */
      }
    } finally {
      inFlight = false;
    }
  };
  const commitInterval = window.setInterval(() => {
    void commitPass();
  }, AUTOSAVE_INTERVAL_MS);
  // Initial pass on open — at launch once the vault is on screen (≤ 4 s), so its
  // git runs don't compete with the file walk and the chats load.
  void afterVaultReady()
    .then(commitPass)
    .finally(() => markSyncIdle(vault, "autosave"));
  loops.set(vault, {
    vault,
    cancel: () => {
      cancelled = true;
      window.clearInterval(commitInterval);
    },
  });
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

export type BoxConfig = { box: string; vault: string; name?: string | null };

/** The box's short name: sync.json's name, else the first label of its host. */
export function boxName(cfg: { box: string; name?: string | null }): string {
  if (cfg.name) return cfg.name;
  try {
    return new URL(cfg.box).hostname.split(".")[0] || cfg.box;
  } catch {
    return cfg.box;
  }
}

export type BoxSyncReport = {
  configured: boolean;
  ok: boolean;
  message: string;
  committed: boolean;
  merged: boolean;
  /** The files the merge changed (vault-relative); open panes showing them reload. */
  merged_paths?: string[];
  conflict: { files: string[]; since: number } | null;
  error: string | null;
  error_kind: "unreachable" | "git" | null;
  changes_waiting: number;
  big_files: { path: string; size: number }[];
  github_warning: string | null;
  github_pushed_at: number | null;
};

export type BoxAttention = {
  kind: "conflict" | "tailscale" | "offline" | "error" | "big" | "github";
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
  /** Asked only after a cycle found the box unreachable: this laptop's
   *  Tailscale is installed but not connected. Null = not asked / connected. */
  tailscale: TailscaleState | null;
  attention: BoxAttention | null;
};

/** `tailscale status --json` on this laptop (src-tauri box_sync.rs). */
export type TailscaleState = { installed: boolean; connected: boolean; state: string; canOpen: boolean };

/** Ask Tailscale whether this laptop is on the tailnet. Cheap (one CLI run),
 *  and only called after a box request failed — never on a timer. */
export async function tailscaleCheck(): Promise<TailscaleState | null> {
  try {
    return await invoke<TailscaleState>("tailscale_check");
  } catch {
    return null;
  }
}

/** The chip's "Open Tailscale" (Windows / macOS). */
export async function openTailscale(): Promise<void> {
  await invoke("tailscale_open");
}

const BOX_CYCLE_MS = 15_000;
/** A failure must last this long before the chip shows (no blips). */
const BOX_SHOW_FAILURE_AFTER_MS = 60_000;
/** Amber turns red, and the phone gets its one alert, after this long. */
const BOX_RED_AFTER_MS = 10 * 60_000;

const boxStates = new Map<string, BoxSyncState>();
type BoxListener = (s: BoxSyncState | null) => void;
const boxListeners = new Set<BoxListener>();
const boxConfigCache = new Map<string, { cfg: BoxConfig | null; at: number }>();
const boxKick = new Map<string, (o?: { pull?: boolean }) => Promise<void>>();

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

/** A machine on the tailnet that answers as a vault-chat server. */
export type FoundBox = { name: string; url: string; version: string | null; online: boolean; hasKey: boolean };

const KNOWN_BOXES_KEY = "vault-chat:known-boxes";

function knownBoxes(): FoundBox[] {
  try {
    const v = JSON.parse(localStorage.getItem(KNOWN_BOXES_KEY) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Boxes on the tailnet: the ones answering now, plus ones seen before that
 * don't answer (shown offline; an offline machine can't say what it is). */
export async function discoverBoxes(): Promise<FoundBox[]> {
  const live = await invoke<FoundBox[]>("box_discover");
  const seen = new Set(live.map((b) => b.url));
  const merged = [...live, ...knownBoxes().filter((b) => !seen.has(b.url)).map((b) => ({ ...b, online: false }))];
  try {
    localStorage.setItem(KNOWN_BOXES_KEY, JSON.stringify(merged.map((b) => ({ ...b, online: false }))));
  } catch {
    /* storage full / blocked */
  }
  return merged.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
}

/** The vault's name on a box: its folder name, made safe for `/git/<name>.git`. */
export function boxVaultName(vault: string): string {
  const base = vault.split(/[\\/]/).filter(Boolean).pop() ?? "vault";
  const n = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "").replace(/\.git$/, "").slice(0, 64);
  return n || "vault";
}

/** Point this vault at a box (sync.json) and run the first sync now; chat moves
 * to the box. The box must already have the vault (POST /api/v1/vaults). */
export async function connectBox(vault: string, url: string, name: string): Promise<void> {
  await invoke("vault_box_connect", { vault, boxUrl: url, boxVault: boxVaultName(vault), name });
  boxConfigCache.delete(vault);
  await startVaultSyncLoop(vault);
}

/** Back to this laptop: sync.json loses its box (the box keeps its copy). */
export async function disconnectBox(vault: string): Promise<void> {
  await invoke("vault_box_disconnect", { vault });
  boxConfigCache.delete(vault);
  await startVaultSyncLoop(vault);
}

export function subscribeBoxSync(fn: BoxListener): () => void {
  boxListeners.add(fn);
  const v = openVault();
  fn(v ? boxStates.get(v) ?? null : null);
  return () => boxListeners.delete(fn);
}

/** Run one cycle now (Settings' "Sync now"; the box's "vault_changed" on /poll).
 *  A cycle already running gets one follow-up, so a box commit made during it still comes in.
 *  `pull`: the box just published an edit — commit, fetch, merge, and leave the
 *  pushes to the next full cycle (the edit lands here seconds sooner). */
export async function boxSyncNow(vault: string, o: { pull?: boolean } = {}): Promise<void> {
  const k = boxKick.get(vault) ?? boxKick.get(vaultKey(vault));
  if (k) await k(o);
}

const vaultKey = (v: string) => v.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

// One box cycle at a time per repo, whichever loop asks (a vault tracked under
// two spellings must not run two cycles over one working copy). Git itself is
// serialized per repo in Rust (lib.rs git_serialized); this keeps whole cycles
// from interleaving.
const cycleTails = new Map<string, Promise<unknown>>();
function oneCycleAtATime<T>(vault: string, fn: () => Promise<T>): Promise<T> {
  const key = vaultKey(vault);
  const prev = cycleTails.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  cycleTails.set(key, tail);
  void tail.then(() => {
    if (cycleTails.get(key) === tail) cycleTails.delete(key);
  });
  return run;
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
  // The box is unreachable because this laptop is off the tailnet: say that
  // at once (it is no blip, and it is the one thing to do), not "Box unreachable".
  const ts = st.tailscale;
  if (r.error && r.error_kind === "unreachable" && st.failingSince !== null && ts && ts.installed && !ts.connected) {
    return {
      kind: "tailscale",
      level: level(st.failingSince),
      text: "Tailscale isn't connected",
      detail:
        `Tailscale on this laptop is ${ts.state === "NoService" ? "not running" : `“${ts.state}”`}, so the box can't be reached.\n` +
        `Edits are still saved here (${plural(r.changes_waiting, "change")} waiting) and sync on their own once Tailscale is connected.`,
      since: st.failingSince,
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
    const token = useStore.getState().boxToken || null;
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
  // Tailscale is asked only when a cycle finds the box unreachable, and at
  // most every 30 s while it stays so.
  let tsAskedAt = 0;
  let tsLast: TailscaleState | null = null;
  const tailscaleAfter = async (r: BoxSyncReport): Promise<TailscaleState | null> => {
    if (!(r.error && r.error_kind === "unreachable")) {
      tsAskedAt = 0;
      return (tsLast = null);
    }
    if (Date.now() - tsAskedAt < 30_000) return tsLast;
    tsAskedAt = Date.now();
    const t = await tailscaleCheck();
    return (tsLast = t && t.installed && !t.connected ? t : null);
  };

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
      tailscale: null,
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

  // A follow-up after the running cycle: null = none; true = a pull is enough.
  let again: boolean | null = null;
  // `o` may be anything a promise hands on (`.then(cycle)`): only `{pull: true}` pulls.
  const cycle = async (o?: unknown) => {
    if (cancelled || inFlight) return;
    const pull = !!o && typeof o === "object" && (o as { pull?: unknown }).pull === true;
    inFlight = true;
    set({ running: true });
    try {
      const r = await oneCycleAtATime(vault, () => invoke<BoxSyncReport>("vault_box_sync", { vault, pull })).catch(
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
      const tailscale = await tailscaleAfter(r);
      if (cancelled) return;
      const prev = boxStates.get(vault);
      const now = Date.now();
      set({
        running: false,
        report: r,
        tailscale,
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
        // The agent's edits on the box show in the open panes now (never over unsaved typing).
        void refreshOpenFiles({ vault, paths: r.merged_paths?.length ? r.merged_paths : null });
      } else if (r.committed) {
        void forceRefreshFileTree(vault);
      }
      const st = boxStates.get(vault);
      if (st) await maybeAlert(st);
    } finally {
      inFlight = false;
      if (!cancelled && boxStates.get(vault)?.running) set({ running: false });
      if (again !== null && !cancelled) {
        const pullAgain = again;
        again = null;
        void cycle({ pull: pullAgain });
      }
    }
  };
  const kick = (o: { pull?: boolean } = {}): Promise<void> => {
    if (inFlight) {
      again = again === null ? !!o.pull : again && !!o.pull;
      return Promise.resolve();
    }
    return cycle({ pull: !!o.pull });
  };

  const timer = window.setInterval(() => void cycle(), BOX_CYCLE_MS);
  // Re-evaluate amber → red even while a cycle is stuck.
  const clock = window.setInterval(() => {
    if (boxStates.has(vault)) set({});
  }, 30_000);
  boxKick.set(vault, kick);
  if (!boxKick.has(vaultKey(vault))) boxKick.set(vaultKey(vault), kick);
  loops.set(vault, {
    vault,
    cancel: () => {
      cancelled = true;
      window.clearInterval(timer);
      window.clearInterval(clock);
      boxKick.delete(vault);
      if (boxKick.get(vaultKey(vault)) === kick) boxKick.delete(vaultKey(vault));
    },
  });
  // First cycle at launch once the vault is on screen (≤ 4 s): its commit, fetch
  // and push don't compete with the file walk and the chats load.
  void afterVaultReady()
    .then(cycle)
    .finally(() => markSyncIdle(vault, "box", { ok: boxStates.get(vault)?.report?.ok ?? null }));
}

// The boot log's "sync idle": the open vault's first sync / autosave pass is done.
function markSyncIdle(vault: string, kind: string, data?: Record<string, unknown>): void {
  if (useStore.getState().vaultPath === vault) bootMark("sync idle", { kind, ...(data ?? {}) });
}
