// The box side of vault sync (contract "Branches per vault"):
//   • the working copy (VC_VAULT) lives on branch `box`, written only here;
//   • every cycle (15 s, plus after each mission turn):
//       1. commit the working copy as the agent ("[agent] …"), under the
//          shared repo lock, never staging a file over 50 MB;
//       2. push `box` to the bare repo (a local path);
//       3. fetch `master` from it and fast-forward `box` when master
//          contains it — never a merge on the box;
//   • the bare repo is what the laptop pushes `master` to / fetches `box`
//     from, over /git (see gitHttp.ts). The box does not mirror to GitHub
//     (its credential is gone); the laptop does the backup.
import { existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig } from "./config";
import { runGit, git, withRepoLock, abortStuckMergeOrRebase, stageAllExceptLarge, onLargeFilesSkipped, AGENT_IDENTITY_ARGS } from "./git";

const BRANCH = "box";
const HUB = "master";
const HUB_REF = "refs/remotes/hub/master";
const ALERT_AFTER_MS = 10 * 60_000;

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
  mirror: string;
};

type Alert = (title: string, body: string, tag?: string) => Promise<unknown>;

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
  ) {
    this.status = {
      enabled: true,
      vault,
      bareRepo: bare,
      branch: BRANCH,
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
      mirror: "off — the box does not mirror to GitHub; the laptop pushes master and box to its github remote",
    };
    onLargeFilesSkipped((paths) => this.noteLarge(paths));
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
        await git(this.bare, ["init", "--bare", "-q", "-b", HUB]);
      }
      if (!wcOk) {
        mkdirSync(this.vault, { recursive: true });
        await git(this.vault, ["init", "-q", "-b", BRANCH]);
      }
    }
    // Receive settings + the guard that keeps `box` box-only.
    await git(this.bare, ["config", "http.receivepack", "true"]);
    await git(this.bare, ["config", "receive.denyDeletes", "true"]);
    this.installPreReceive();
    // The working copy must be on `box`. An unborn repo just switches.
    const head = (await runGit(this.vault, ["symbolic-ref", "--short", "HEAD"])).stdout.trim();
    if (head !== BRANCH) {
      const hasCommits = (await runGit(this.vault, ["rev-parse", "--verify", "HEAD"])).code === 0;
      if (!hasCommits || init) {
        await git(this.vault, ["checkout", "-q", "-B", BRANCH]);
      } else {
        throw new Error(`working copy ${this.vault} is on "${head || "(detached)"}", not "${BRANCH}" — refusing to sync`);
      }
    }
  }

  private installPreReceive(): void {
    const hook = join(this.bare, "hooks", "pre-receive");
    const body = `#!/bin/sh
# Installed by vault-chat-server. Branch ownership (contract):
#   box    — written only by the box (local pushes; never over /git)
#   master — written only by the laptop (over /git)
# Pushes with no VC_PUSHER label (an admin on the box) are not restricted.
while read old new ref; do
  if [ "$VC_PUSHER" = "http" ] && [ "$ref" = "refs/heads/box" ]; then
    echo "refs/heads/box is written only by the box" >&2; exit 1
  fi
  if [ "$VC_PUSHER" = "box" ] && [ "$ref" = "refs/heads/master" ]; then
    echo "refs/heads/master is written only by the laptop" >&2; exit 1
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

  /** Run a cycle now (after a mission turn, after a push over /git). */
  trigger(): void {
    this.schedule(200);
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
        if (head !== BRANCH) throw new Error(`working copy is on "${head || "(detached)"}", not "${BRANCH}"`);
        await abortStuckMergeOrRebase(vault);

        // 1. Commit.
        try {
          const st = await git(vault, ["status", "--porcelain", "--ignore-submodules=dirty"]);
          let detail = "clean";
          if (st.trim()) {
            const skipped = await stageAllExceptLarge(vault, AGENT_IDENTITY_ARGS);
            this.noteLarge(skipped);
            const staged = await runGit(vault, ["diff", "--cached", "--quiet"]);
            if (staged.code !== 0) {
              const n = (await git(vault, ["diff", "--cached", "--name-only"])).trim().split("\n").filter(Boolean).length;
              await git(vault, [...AGENT_IDENTITY_ARGS, "commit", "-q", "-m", `[agent] box autosave: ${n} file(s)`]);
              detail = `committed ${n} file(s)`;
            } else {
              detail = skipped.length ? `only oversized files changed (${skipped.length} skipped)` : "nothing to stage";
            }
          }
          s.steps.commit = { ok: true, at: Date.now(), detail };
        } catch (e) {
          s.steps.commit = { ok: false, at: Date.now(), error: errText(e) };
          throw e;
        }

        const hasHead = (await runGit(vault, ["rev-parse", "--verify", "HEAD"])).code === 0;
        if (!hasHead) {
          // A vault added from Settings starts empty: once the laptop has
          // pushed master, box starts from it.
          const f = await runGit(vault, ["fetch", "-q", bare, `+refs/heads/${HUB}:${HUB_REF}`]);
          if (f.code !== 0) {
            s.steps.push = { ok: true, at: Date.now(), detail: "no commits yet" };
            return;
          }
          await git(vault, ["checkout", "-q", "-B", BRANCH, HUB_REF]);
          s.steps.fetch = { ok: true, at: Date.now(), detail: `box started from ${HUB}` };
        }

        // 2. Push box → bare.
        await this.pushBox();

        // 3. Fetch master; fast-forward box when master contains it.
        try {
          const r = await runGit(vault, ["fetch", "-q", bare, `+refs/heads/${HUB}:${HUB_REF}`]);
          if (r.code !== 0) {
            if (/couldn't find remote ref|could not find remote ref/i.test(r.stderr)) {
              s.steps.fetch = { ok: true, at: Date.now(), detail: `no ${HUB} in the bare repo yet` };
              s.steps.fastForward = { ok: true, at: Date.now(), detail: "nothing to fast-forward to" };
              return;
            }
            throw new Error(`git fetch ${HUB} (exit ${r.code}): ${r.stderr.trim()}`);
          }
          s.steps.fetch = { ok: true, at: Date.now() };
        } catch (e) {
          s.steps.fetch = { ok: false, at: Date.now(), error: errText(e) };
          throw e;
        }
        try {
          const boxSha = (await git(vault, ["rev-parse", "HEAD"])).trim();
          const masterSha = (await git(vault, ["rev-parse", HUB_REF])).trim();
          if (boxSha === masterSha) {
            s.steps.fastForward = { ok: true, at: Date.now(), detail: "box == master" };
          } else if ((await runGit(vault, ["merge-base", "--is-ancestor", "HEAD", HUB_REF])).code === 0) {
            await git(vault, ["merge", "--ff-only", "-q", HUB_REF]);
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
        void this.alert("Box sync recovered", `Sync is working again after ${Math.round((Date.now() - s.failingSince) / 60_000)} min.`, "vault-chat-sync").catch(() => {});
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
        void this.alert("Box sync failing", `For ${Math.round((Date.now() - s.failingSince) / 60_000)} min: ${s.lastError.slice(0, 300)}`, "vault-chat-sync").catch(() => {});
      }
      await this.refreshRefs().catch(() => {});
    } finally {
      s.running = false;
    }
  }

  private async pushBox(): Promise<void> {
    const s = this.status;
    try {
      const r = await runGit(this.vault, ["push", "-q", this.bare, `refs/heads/${BRANCH}:refs/heads/${BRANCH}`], {
        env: { VC_PUSHER: "box" },
      });
      if (r.code !== 0) throw new Error(`git push ${BRANCH} (exit ${r.code}): ${r.stderr.trim()}`);
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
    s.master = await rp(HUB_REF);
    if (s.box && s.master) {
      const r = await runGit(this.vault, ["rev-list", "--left-right", "--count", `HEAD...${HUB_REF}`]);
      const [a, b] = r.stdout.trim().split(/\s+/).map(Number);
      s.ahead = Number.isFinite(a) ? a! : null;
      s.behind = Number.isFinite(b) ? b! : null;
    } else {
      s.ahead = s.behind = null;
    }
  }

  private noteLarge(paths: string[]): void {
    if (!paths.length) return;
    const set = new Set(this.status.largeFilesSkipped);
    for (const p of paths) set.add(p);
    this.status.largeFilesSkipped = [...set].sort();
    const fresh = paths.filter((p) => !this.alertedLarge.has(p));
    if (!fresh.length) return;
    for (const p of fresh) this.alertedLarge.add(p);
    void this.alert(
      "File too large to sync",
      `Not committed (over 50 MB): ${fresh.slice(0, 5).join(", ")}${fresh.length > 5 ? ` and ${fresh.length - 5} more` : ""}. It stays on the box only.`,
      "vault-chat-sync",
    ).catch(() => {});
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

/** Where a vault lives: the main one from the config, the rest beside it
 * (`~/vaults/<name>` + `~/vaults/<name>.git`). */
export function vaultPaths(name: string): { vault: string; bare: string } {
  const cfg = loadConfig();
  if (name === cfg.vaultName) return { vault: cfg.vault, bare: cfg.bareRepo };
  const root = dirname(cfg.vault);
  return { vault: join(root, name), bare: join(root, `${name}.git`) };
}

/** Every vault this box has: the main one plus each `<name>.git` beside it
 * that has its working copy. */
export function listVaults(): Array<{ name: string; main: boolean; syncing: boolean }> {
  const cfg = loadConfig();
  const out = [{ name: cfg.vaultName, main: true, syncing: !!instance }];
  let entries: string[] = [];
  try {
    entries = readdirSync(dirname(cfg.vault));
  } catch {
    /* no root */
  }
  for (const e of entries.sort()) {
    if (!e.endsWith(".git")) continue;
    const name = e.slice(0, -4);
    if (name === cfg.vaultName || !validVaultName(name)) continue;
    const { vault, bare } = vaultPaths(name);
    if (existsSync(join(bare, "HEAD")) && existsSync(join(vault, ".git"))) out.push({ name, main: false, syncing: added.has(name) });
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
  if (name && added.has(name)) added.get(name)!.trigger();
  else instance?.trigger();
}

export function syncStatus(): unknown {
  if (instance) return instance.status;
  const cfg = loadConfig();
  return { enabled: false, ok: false, vault: cfg.vault, bareRepo: cfg.bareRepo, lastError: setupError };
}

export function syncSummary(): Record<string, unknown> {
  if (!instance) return { enabled: false, ok: false, error: setupError };
  const s = instance.status;
  return { enabled: true, ok: s.ok, lastOkAt: s.lastOkAt, failingSince: s.failingSince, lastError: s.lastError, ahead: s.ahead, behind: s.behind, largeFilesSkipped: s.largeFilesSkipped.length };
}
