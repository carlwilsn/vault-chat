// The box side of vault sync (contract "Branches per vault"):
//   • the working copy (VC_VAULT) lives on branch `box`, written only here;
//   • every cycle (15 s, plus after each mission turn):
//       1. commit the working copy as the agent ("[agent] …"), under the
//          shared repo lock, by the staging rules (git.ts stageForCommit):
//          never a file over 50 MB nor a new archive; a board being drawn
//          on waits until it is still (2 min, at most 10); at most 100 MB
//          of new content a commit;
//       2. push `box` to the bare repo (a local path);
//       3. fetch `master` from it and fast-forward `box` when master
//          contains it — never a merge on the box;
//   • the bare repo is what the laptop pushes `master` to / fetches `box`
//     from, over /git (see gitHttp.ts). The box does not mirror to GitHub
//     (its credential is gone); the laptop does the backup.
import { existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { loadConfig } from "./config";
import { masterDir, masterRepoNames, repoPaths, startMasterProjects, triggerProject, flushProject } from "./master";
import { runGit, git, withRepoLock, abortStuckMergeOrRebase, stageForCommit, onStageResult, sameRepo, AGENT_IDENTITY_ARGS, type StageResult } from "./git";

/** The box's branch in the hub, written only by the box. */
const BOX_BRANCH = "box";
const ALERT_AFTER_MS = 10 * 60_000;

/** The branches one synced repo uses. A vault: the working copy on `box`, the laptop's `master`. A project under
 * the vault-chat folder (server/master.ts): the working copy on its own main branch (Keep merges there), pushed to
 * the hub as `box`; the laptop's copy of that branch is the hub's `main`. */
export type SyncBranches = { local: string; hub: string };
export const VAULT_BRANCHES: SyncBranches = { local: BOX_BRANCH, hub: "master" };

export type StepResult = { ok: boolean; at: number; detail?: string; error?: string };

export type SyncStatus = {
  enabled: boolean;
  vault: string;
  bareRepo: string;
  branch: string;
  ok: boolean;
  running: boolean;
  lastRunAt: number | null;
  lastOkAt: number | null;
  failingSince: number | null;
  lastError: string | null;
  steps: { commit?: StepResult; push?: StepResult; fetch?: StepResult; fastForward?: StepResult };
  box: string | null;
  master: string | null;
  /** box commits not in master / master commits not in box. */
  ahead: number | null;
  behind: number | null;
  largeFilesSkipped: string[];
  /** New archives the box never commits (they belong in ~/agent-work/<vault>/). */
  archivesSkipped: string[];
  /** Boards being drawn on, not committed yet (they go once still). */
  heldBoards: string[];
  mirror: string;
};

/** `needsYou: false`: said in the journal only, never a buzz (server/pushGate.ts). */
export type Alert = (title: string, body: string, tag?: string, needsYou?: boolean) => Promise<unknown>;

export class BoxSync {
  status: SyncStatus;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private again = false;
  private stopped = true; // until start()
  private alertedFailure = false;
  private alertedLarge = new Set<string>();

  constructor(
    private vault: string,
    private bare: string,
    private intervalMs: number,
    private alert: Alert,
    private alertAfterMs = ALERT_AFTER_MS,
    private branches: SyncBranches = VAULT_BRANCHES,
  ) {
    this.status = {
      enabled: true,
      vault,
      bareRepo: bare,
      branch: branches.local,
      ok: false,
      running: false,
      lastRunAt: null,
      lastOkAt: null,
      failingSince: null,
      lastError: null,
      steps: {},
      box: null,
      master: null,
      ahead: null,
      behind: null,
      largeFilesSkipped: [],
      archivesSkipped: [],
      heldBoards: [],
      mirror: "off — the box does not mirror to GitHub; the laptop pushes master and box to its github remote",
    };
    onStageResult((repo, r) => {
      if (sameRepo(repo, this.vault)) this.noteStaged(r);
    });
  }

  private get BRANCH(): string {
    return this.branches.local;
  }
  private get HUB(): string {
    return this.branches.hub;
  }
  private get HUB_REF(): string {
    return `refs/remotes/hub/${this.branches.hub}`;
  }

  /** Make sure the bare repo and the working copy exist and are wired up.
   * Creates them only with `init` (VC_INIT=1); otherwise a missing piece is
   * an error in the status, never a silent auto-create in prod. */
  async ensure(init: boolean): Promise<void> {
    const bareOk = existsSync(join(this.bare, "HEAD"));
    const wcOk = existsSync(join(this.vault, ".git"));
    if (!bareOk || !wcOk) {
      if (!init) {
        throw new Error(
          `sync not set up: ${!bareOk ? `bare repo ${this.bare} missing` : ""}${!bareOk && !wcOk ? "; " : ""}${!wcOk ? `working copy ${this.vault} is not a git repo` : ""} (start once with VC_INIT=1 to create)`,
        );
      }
      if (!bareOk) {
        mkdirSync(this.bare, { recursive: true });
        await git(this.bare, ["init", "--bare", "-q", "-b", this.HUB]);
      }
      if (!wcOk) {
        mkdirSync(this.vault, { recursive: true });
        await git(this.vault, ["init", "-q", "-b", this.BRANCH]);
      }
    }
    // Receive settings + the guard that keeps `box` box-only.
    await git(this.bare, ["config", "http.receivepack", "true"]);
    await git(this.bare, ["config", "receive.denyDeletes", "true"]);
    this.installPreReceive();
    // The working copy must be on `box`. An unborn repo just switches.
    const head = (await runGit(this.vault, ["symbolic-ref", "--short", "HEAD"])).stdout.trim();
    if (head !== this.BRANCH) {
      const hasCommits = (await runGit(this.vault, ["rev-parse", "--verify", "HEAD"])).code === 0;
      if (!hasCommits || init) {
        await git(this.vault, ["checkout", "-q", "-B", this.BRANCH]);
      } else {
        throw new Error(`working copy ${this.vault} is on "${head || "(detached)"}", not "${this.BRANCH}" — refusing to sync`);
      }
    }
  }

  private installPreReceive(): void {
    const hook = join(this.bare, "hooks", "pre-receive");
    const body = `#!/bin/sh
# Installed by vault-chat-server. Branch ownership (contract):
#   box    — written only by the box (local pushes; never over /git)
#   ${this.HUB} — written only by the laptop (over /git)
# Pushes with no VC_PUSHER label (an admin on the box) are not restricted.
while read old new ref; do
  if [ "$VC_PUSHER" = "http" ] && [ "$ref" = "refs/heads/box" ]; then
    echo "refs/heads/box is written only by the box" >&2; exit 1
  fi
  if [ "$VC_PUSHER" = "box" ] && [ "$ref" = "refs/heads/${this.HUB}" ]; then
    echo "refs/heads/${this.HUB} is written only by the laptop" >&2; exit 1
  fi
done
exit 0
`;
    let cur = "";
    try {
      cur = readFileSync(hook, "utf8");
    } catch {
      mkdirSync(join(this.bare, "hooks"), { recursive: true });
    }
    if (cur !== body) {
      writeFileSync(hook, body);
      try {
        chmodSync(hook, 0o755);
      } catch {
        /* windows */
      }
    }
  }

  start(): void {
    this.stopped = false;
    this.schedule(500);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.runOnce(), ms);
  }

  /** Run a cycle now (after a mission turn, after a push over /git). During a
   * cycle it asks for a follow-up: a timer set now would be replaced by the
   * cycle's own `schedule(intervalMs)` when it ends, and a push that landed
   * after the cycle's fetch would wait a whole interval. */
  trigger(): void {
    if (this.inFlight) {
      this.again = true;
      return;
    }
    this.schedule(200);
  }

  /** A cycle that starts after this call (an in-flight one may predate a write): resolves when it is done. */
  async flush(): Promise<void> {
    if (this.inFlight) await this.inFlight.catch(() => {});
    await this.runOnce();
  }

  /** One full cycle; concurrent calls coalesce into one follow-up run. */
  runOnce(): Promise<void> {
    if (this.inFlight) {
      this.again = true;
      return this.inFlight;
    }
    this.inFlight = this.cycle().finally(() => {
      this.inFlight = null;
      if (this.again) {
        this.again = false;
        this.schedule(50);
      } else {
        this.schedule(this.intervalMs);
      }
    });
    return this.inFlight;
  }

  private async cycle(): Promise<void> {
    const s = this.status;
    s.running = true;
    s.lastRunAt = Date.now();
    const vault = this.vault;
    const bare = this.bare;
    try {
      await withRepoLock(vault, async () => {
        // 0. Still on box?
        const head = (await runGit(vault, ["symbolic-ref", "--short", "HEAD"])).stdout.trim();
        if (head !== this.BRANCH) throw new Error(`working copy is on "${head || "(detached)"}", not "${this.BRANCH}"`);
        await abortStuckMergeOrRebase(vault);

        // 1. Commit.
        try {
          s.steps.commit = { ok: true, at: Date.now(), detail: await this.commitWorkingCopy(true) };
        } catch (e) {
          s.steps.commit = { ok: false, at: Date.now(), error: errText(e) };
          throw e;
        }

        const hasHead = (await runGit(vault, ["rev-parse", "--verify", "HEAD"])).code === 0;
        if (!hasHead) {
          // A vault added from Settings starts empty: once the laptop has
          // pushed master, box starts from it.
          const f = await runGit(vault, ["fetch", "-q", bare, `+refs/heads/${this.HUB}:${this.HUB_REF}`]);
          if (f.code !== 0) {
            s.steps.push = { ok: true, at: Date.now(), detail: "no commits yet" };
            return;
          }
          await git(vault, ["checkout", "-q", "-B", this.BRANCH, this.HUB_REF]);
          s.steps.fetch = { ok: true, at: Date.now(), detail: `box started from ${this.HUB}` };
        }

        // 2. Push box → bare.
        await this.pushBox();

        // 3. Fetch master; fast-forward box when master contains it.
        try {
          const r = await runGit(vault, ["fetch", "-q", bare, `+refs/heads/${this.HUB}:${this.HUB_REF}`]);
          if (r.code !== 0) {
            if (/couldn't find remote ref|could not find remote ref/i.test(r.stderr)) {
              s.steps.fetch = { ok: true, at: Date.now(), detail: `no ${this.HUB} in the bare repo yet` };
              s.steps.fastForward = { ok: true, at: Date.now(), detail: "nothing to fast-forward to" };
              return;
            }
            throw new Error(`git fetch ${this.HUB} (exit ${r.code}): ${r.stderr.trim()}`);
          }
          s.steps.fetch = { ok: true, at: Date.now() };
        } catch (e) {
          s.steps.fetch = { ok: false, at: Date.now(), error: errText(e) };
          throw e;
        }
        try {
          const boxSha = (await git(vault, ["rev-parse", "HEAD"])).trim();
          const masterSha = (await git(vault, ["rev-parse", this.HUB_REF])).trim();
          if (boxSha === masterSha) {
            s.steps.fastForward = { ok: true, at: Date.now(), detail: "box == master" };
          } else if ((await runGit(vault, ["merge-base", "--is-ancestor", "HEAD", this.HUB_REF])).code === 0 && (await this.heldBoardsIn(this.HUB_REF))) {
            // Master changed a board that is being drawn on here: commit the drawing now (box is then ahead and
            // waits for the laptop's merge) rather than let the fast-forward refuse to overwrite it.
            const detail = await this.commitWorkingCopy(false);
            s.steps.commit = { ok: true, at: Date.now(), detail };
            await this.pushBox();
            s.steps.fastForward = { ok: true, at: Date.now(), detail: "master changed a board being drawn on: committed it, waiting for the laptop to merge" };
          } else if ((await runGit(vault, ["merge-base", "--is-ancestor", "HEAD", this.HUB_REF])).code === 0) {
            await git(vault, ["merge", "--ff-only", "-q", this.HUB_REF]);
            s.steps.fastForward = { ok: true, at: Date.now(), detail: `fast-forwarded ${boxSha.slice(0, 8)} → ${masterSha.slice(0, 8)}` };
            await this.pushBox();
          } else {
            s.steps.fastForward = { ok: true, at: Date.now(), detail: "master does not contain box yet (waiting for the laptop to merge)" };
          }
        } catch (e) {
          s.steps.fastForward = { ok: false, at: Date.now(), error: errText(e) };
          throw e;
        }
      });
      await this.refreshRefs();
      s.ok = true;
      s.lastError = null;
      s.lastOkAt = Date.now();
      if (s.failingSince !== null && this.alertedFailure) {
        void this.alert("Box sync recovered", `Sync is working again after ${Math.round((Date.now() - s.failingSince) / 60_000)} min.`, "vault-chat-sync", false).catch(() => {});
      }
      s.failingSince = null;
      this.alertedFailure = false;
    } catch (e) {
      s.ok = false;
      s.lastError = errText(e);
      if (s.failingSince === null) s.failingSince = Date.now();
      console.warn("[sync] cycle failed:", s.lastError);
      if (!this.alertedFailure && Date.now() - s.failingSince >= this.alertAfterMs) {
        this.alertedFailure = true;
        void this.alert("Needs you: box sync is failing", `For ${Math.round((Date.now() - s.failingSince) / 60_000)} min, the box and the laptop are not syncing: ${s.lastError.slice(0, 300)}`, "vault-chat-sync").catch(() => {});
      }
      await this.refreshRefs().catch(() => {});
    } finally {
      s.running = false;
    }
  }

  /** Commit the working copy as the agent (caller holds the repo lock). `hold`: boards being drawn on wait. */
  private async commitWorkingCopy(hold: boolean): Promise<string> {
    const vault = this.vault;
    const st = await git(vault, ["status", "--porcelain", "--ignore-submodules=dirty"]);
    if (!st.trim()) {
      this.status.heldBoards = [];
      return "clean";
    }
    const r = await stageForCommit(vault, AGENT_IDENTITY_ARGS, { holdBoards: hold });
    this.noteStaged(r);
    this.status.heldBoards = r.heldBoards;
    const staged = await runGit(vault, ["diff", "--cached", "--quiet"]);
    const notes = [
      r.heldBoards.length ? `held while drawn on: ${r.heldBoards.join(", ")}` : "",
      r.deferred.length ? `${r.deferred.length} file(s) left for the next commit (100 MB a commit)` : "",
      r.archives.length ? `${r.archives.length} archive(s) kept out` : "",
      r.tooLarge.length ? `${r.tooLarge.length} file(s) over 50 MB kept out` : "",
    ].filter(Boolean);
    const tail = notes.length ? `; ${notes.join("; ")}` : "";
    if (staged.code === 0) return `nothing to commit${tail}`;
    const n = (await git(vault, ["diff", "--cached", "--name-only"])).trim().split("\n").filter(Boolean).length;
    await git(vault, [...AGENT_IDENTITY_ARGS, "commit", "-q", "-m", `[agent] box autosave: ${n} file(s)`]);
    // More waits (a set of new files over the commit's budget): the next cycle takes it at once.
    if (r.deferred.length) this.again = true;
    return `committed ${n} file(s)${tail}`;
  }

  /** Does `ref` change a board this box is holding (being drawn on)? */
  private async heldBoardsIn(ref: string): Promise<boolean> {
    const held = this.status.heldBoards;
    if (!held.length) return false;
    const r = await runGit(this.vault, ["diff", "--name-only", "HEAD", ref, "--", ...held]);
    return r.code !== 0 || r.stdout.trim() !== "";
  }

  private async pushBox(): Promise<void> {
    const s = this.status;
    try {
      const r = await runGit(this.vault, ["push", "-q", this.bare, `refs/heads/${this.BRANCH}:refs/heads/${BOX_BRANCH}`], {
        env: { VC_PUSHER: "box" },
      });
      if (r.code !== 0) throw new Error(`git push ${this.BRANCH === BOX_BRANCH ? BOX_BRANCH : `${this.BRANCH} → ${BOX_BRANCH}`} (exit ${r.code}): ${r.stderr.trim()}`);
      s.steps.push = { ok: true, at: Date.now() };
    } catch (e) {
      s.steps.push = { ok: false, at: Date.now(), error: errText(e) };
      throw e;
    }
  }

  private async refreshRefs(): Promise<void> {
    const s = this.status;
    const rp = async (ref: string) => {
      const r = await runGit(this.vault, ["rev-parse", "--verify", "-q", ref]);
      return r.code === 0 ? r.stdout.trim() : null;
    };
    s.box = await rp("HEAD");
    s.master = await rp(this.HUB_REF);
    if (s.box && s.master) {
      const r = await runGit(this.vault, ["rev-list", "--left-right", "--count", `HEAD...${this.HUB_REF}`]);
      const [a, b] = r.stdout.trim().split(/\s+/).map(Number);
      s.ahead = Number.isFinite(a) ? a! : null;
      s.behind = Number.isFinite(b) ? b! : null;
    } else {
      s.ahead = s.behind = null;
    }
  }

  /** What a commit left out for good: in the status, and one alert per new path. */
  private noteStaged(r: StageResult): void {
    const fresh = (paths: string[], into: "largeFilesSkipped" | "archivesSkipped") => {
      if (!paths.length) return [];
      const set = new Set(this.status[into]);
      for (const p of paths) set.add(p);
      this.status[into] = [...set].sort();
      const out = paths.filter((p) => !this.alertedLarge.has(p));
      for (const p of out) this.alertedLarge.add(p);
      return out;
    };
    const list = (ps: string[]) => `${ps.slice(0, 5).join(", ")}${ps.length > 5 ? ` and ${ps.length - 5} more` : ""}`;
    const large = fresh(r.tooLarge, "largeFilesSkipped");
    if (large.length) {
      void this.alert("Needs you: a file is too large to sync", `Not committed (over 50 MB): ${list(large)}. It stays on the box only.`, "vault-chat-sync").catch(() => {});
    }
    const arch = fresh(r.archives, "archivesSkipped");
    if (arch.length) {
      const dirs = [...new Set(arch.map((p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "the vault's top folder")))];
      void this.alert(
        "Archives kept out of sync",
        `${arch.length === 1 ? "An archive" : `${arch.length} archives`} in ${list(dirs)} ${arch.length === 1 ? "was" : "were"} not committed: ` +
          `backups and archives belong in ~/agent-work/${basename(this.vault)}/, outside the vault, which is synced and backed up to GitHub with every change. ` +
          `They stay on the box only.`,
        "vault-chat-sync",
        // Nothing for Carl to do (the agent's archives belong outside the vault): logged, never a buzz.
        false,
      ).catch(() => {});
    }
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

let instance: BoxSync | null = null;
let setupError: string | null = null;
let alertFn: Alert = async () => 0;
/** Vaults added from Settings (POST /api/v1/vaults), beside the main one. */
const added = new Map<string, BoxSync>();

/** A vault's name on the box: `^[A-Za-z0-9._-]{1,64}$`, no leading dot, no `.git`. */
export function validVaultName(n: unknown): n is string {
  return typeof n === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(n) && !n.startsWith(".") && !n.endsWith(".git");
}

/** Where a vault lives: the main one from the config; with a vault-chat folder (server/master.ts) the rest in
 * `<folder>/vaults/<name>` + `<folder>/.hub/vaults/<name>.git`; without one, beside the main one
 * (`~/vaults/<name>` + `~/vaults/<name>.git`). A vault already beside the main one stays there. */
export function vaultPaths(name: string): { vault: string; bare: string } {
  const cfg = loadConfig();
  if (name === cfg.vaultName) return { vault: cfg.vault, bare: cfg.bareRepo };
  const root = dirname(cfg.vault);
  const legacy = { vault: join(root, name), bare: join(root, `${name}.git`) };
  const m = masterDir();
  if (m) {
    const p = repoPaths(m, "vaults", name);
    if (existsSync(p.wc) || !existsSync(join(legacy.bare, "HEAD"))) return { vault: p.wc, bare: p.bare };
  }
  return legacy;
}

/** Every vault this box has: the main one, each vault in the vault-chat folder, and each `<name>.git` beside the
 * main one that has its working copy. */
export function listVaults(): Array<{ name: string; main: boolean; syncing: boolean }> {
  const cfg = loadConfig();
  const out = [{ name: cfg.vaultName, main: true, syncing: !!instance }];
  const names = new Set<string>([cfg.vaultName]);
  const m = masterDir();
  const candidates: string[] = m ? masterRepoNames(m, "vaults") : [];
  try {
    for (const e of readdirSync(dirname(cfg.vault))) if (e.endsWith(".git")) candidates.push(e.slice(0, -4));
  } catch {
    /* no root */
  }
  for (const name of candidates.sort()) {
    if (names.has(name) || !validVaultName(name)) continue;
    const { vault, bare } = vaultPaths(name);
    if (existsSync(join(bare, "HEAD")) && existsSync(join(vault, ".git"))) {
      names.add(name);
      out.push({ name, main: false, syncing: added.has(name) });
    }
  }
  return out;
}

/** Create `<name>.git` (bare) and its working copy on `box` if missing, and
 * sync it. Idempotent. */
export async function addVault(name: string): Promise<{ name: string; created: boolean }> {
  if (!validVaultName(name)) throw new Error("invalid vault name");
  const cfg = loadConfig();
  if (name === cfg.vaultName || added.has(name)) return { name, created: false };
  const { vault, bare } = vaultPaths(name);
  const created = !existsSync(join(bare, "HEAD")) || !existsSync(join(vault, ".git"));
  const s = new BoxSync(vault, bare, cfg.syncIntervalMs, alertFn);
  await s.ensure(true);
  added.set(name, s);
  if (cfg.syncEnabled) s.start();
  return { name, created };
}

export async function startBoxSync(alert: Alert): Promise<BoxSync | null> {
  alertFn = alert;
  const cfg = loadConfig();
  if (!cfg.syncEnabled) {
    setupError = "disabled (VC_SYNC=0)";
    return null;
  }
  // Every project in the vault-chat folder syncs with the laptop the same way (server/master.ts).
  await startMasterProjects(alert).catch((e) => console.error("[sync] projects:", errText(e)));
  // Vaults added earlier come back with the server.
  for (const v of listVaults()) {
    if (v.main) continue;
    const { vault, bare } = vaultPaths(v.name);
    const s = new BoxSync(vault, bare, cfg.syncIntervalMs, alert);
    try {
      await s.ensure(false);
      added.set(v.name, s);
      s.start();
    } catch (e) {
      console.error(`[sync] ${v.name}:`, errText(e));
    }
  }
  const s = new BoxSync(cfg.vault, cfg.bareRepo, cfg.syncIntervalMs, alert);
  try {
    await s.ensure(cfg.init);
  } catch (e) {
    setupError = errText(e);
    console.error("[sync]", setupError);
    void alert("Box sync not running", setupError.slice(0, 300), "vault-chat-sync").catch(() => {});
    return null;
  }
  instance = s;
  s.start();
  return s;
}

/** Run a cycle now: the main vault, or the named one. */
export function triggerSync(name?: string): void {
  if (name?.startsWith("projects/")) return triggerProject(name.slice("projects/".length));
  if (name && added.has(name)) added.get(name)!.trigger();
  else instance?.trigger();
}

/** Commit and publish a vault now (an agent's edit): resolves when the cycle is done; no-op without sync. */
export async function syncNow(name?: string): Promise<void> {
  if (name?.startsWith("projects/")) return flushProject(name.slice("projects/".length));
  const s = name && added.has(name) ? added.get(name)! : instance;
  if (s) await s.flush();
}

export function syncStatus(): unknown {
  if (instance) return instance.status;
  const cfg = loadConfig();
  return { enabled: false, ok: false, vault: cfg.vault, bareRepo: cfg.bareRepo, lastError: setupError };
}

export function syncSummary(): Record<string, unknown> {
  if (!instance) return { enabled: false, ok: false, error: setupError };
  const s = instance.status;
  return { enabled: true, ok: s.ok, lastOkAt: s.lastOkAt, failingSince: s.failingSince, lastError: s.lastError, ahead: s.ahead, behind: s.behind, largeFilesSkipped: s.largeFilesSkipped.length, archivesSkipped: s.archivesSkipped.length, heldBoards: s.heldBoards };
}
