/** Installed updater recovery entry: NO HTTP listener, agent, model or key-store load. A retained failed
 * published bundle can prove source recovery even while its pre-A fallback serves the UI. Never an agent
 * sidecar: only the updater invokes this installed, hash-verified release with a durable actual failure. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, SERVER_REV, SERVER_VERSION } from "./config";
import { acceptedChanges, acceptedFailedRelease, importLegacyBootstrap, updateShippingJournal, type AcceptedChange } from "./changeShipping";
import { activeFolders } from "./projectFolders";
import { installedChangeHostOptions } from "./changeHostConfig";
import { buildSandbox } from "./engine/index";
import { ensurePi, findBwrap } from "./engine/pi/install";
import { probeJob, readJobs, type PiJobEnv } from "./engine/pi/jobs";
import { requestRollback } from "./submitChange";
import { BoxSync, listVaults, vaultPaths } from "./sync";
import { masterDir, masterProjectOf, repoPaths } from "./master";
import { git } from "./git";
const hash = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");

/** Fail before reading a project or invoking a proof unless this is exactly the installed retained asset.
 * server-version metadata was authenticated by the normal updater's release checksum verification. */
export function verifyRetainedRecoveryBundle(o: { stateDir: string; entry: string; version: string; revision: string }): void {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(o.version) || !/^[a-f0-9]{40}$/.test(o.revision)) throw new Error("Recovery requires full installed release metadata");
  const expected = join(realpathSync(o.stateDir), "versions", o.version, "vault-chat-server.mjs");
  if (realpathSync(expected) !== expected || realpathSync(o.entry) !== expected) throw new Error("Source recovery must run the retained installed release, never a candidate/developer bundle");
  const meta = JSON.parse(readFileSync(join(o.stateDir, "versions", o.version, "server-version.json"), "utf8"));
  if (meta.version !== o.version || meta.rev !== o.revision || meta.sha256 !== hash(readFileSync(o.entry))) throw new Error("Retained installed release checksum/version/source does not match");
}

export function verifiedRecoveryFailure(stateDir: string, c: AcceptedChange, now = Date.now()): string | null {
  if (!c.acceptedAt || !c.release) return null;
  const path = join(stateDir, "release-failures", `${hash(c.release.version)}.json`);
  if (!existsSync(path)) return null;
  const failure = JSON.parse(readFileSync(path, "utf8"));
  if (failure.version !== c.release.version || failure.revision !== c.release.revision || !Number.isFinite(failure.observedAt) || !Number.isFinite(Date.parse(c.release.publishedAt)) || failure.observedAt < Date.parse(c.release.publishedAt) || failure.observedAt > now) throw new Error("Retained recovery failure identity/timestamp does not match the published accepted release");
  return "Actual box release readiness failed; restore the specific accepted source change";
}

/** Normal BoxSync hub transport only; never a GitHub push or bespoke source delivery mechanism. */
async function flushRecoveredProject(repo: string, base: string): Promise<void> {
  const master = masterDir(), name = masterProjectOf(repo);
  if (!master || !name) throw new Error("Source recovery accepted but project has no ordinary master hub sync; needs attention");
  const paths = repoPaths(master, "projects", name);
  const sync = new BoxSync(paths.wc, paths.bare, 60_000, async () => 0, undefined, { local: base, hub: base });
  try {
    await sync.ensure(false); await sync.flush();
    if (!sync.status.ok) throw new Error("Source recovery accepted but ordinary hub sync failed; laptop push is pending");
  } finally { sync.stop(); }
}

/** Exit zero means EVERY matched original has an accepted source rollback and confirmed hub transport. */
export function assertRecoveryCompletion(matching: number, confirmed: number): void {
  if (!matching) throw new Error("Failed installed release has no verified accepted source identity; no recovery authority and no success is claimed");
  if (confirmed !== matching) throw new Error("Not every matching failed published change has accepted/transported source recovery");
}

export async function runPublishedRecoveryCli(): Promise<number> {
  try {
    if (process.env.VC_UPDATER_RECOVERY !== "1" || process.argv.length !== 3) throw new Error("Only the installed updater may invoke recover-published-release, without arbitrary arguments");
    const cfg = loadConfig(), entry = realpathSync(fileURLToPath(import.meta.url));
    verifyRetainedRecoveryBundle({ stateDir: cfg.stateDir, entry, version: SERVER_VERSION, revision: SERVER_REV });
    const marker = join(cfg.stateDir, "release-failures", `${hash(SERVER_VERSION)}.json`);
    if (!existsSync(marker)) throw new Error("No durable host observation of this failed installed release");
    const failure = JSON.parse(readFileSync(marker, "utf8"));
    if (failure.version !== SERVER_VERSION || failure.revision !== SERVER_REV || !Number.isFinite(failure.observedAt) || failure.observedAt <= 0 || failure.observedAt > Date.now()) throw new Error("Installed source recovery failure observation does not match this retained release");
    const bwrap = findBwrap(); if (!bwrap) throw new Error("Source recovery requires installed bubblewrap");
    const vaults = listVaults().map(v => ({ name: v.name, path: v.main ? cfg.vault : vaultPaths(v.name).vault }));
    const repos = new Map<string, { vault: string; slug: string; name: string }[]>();
    for (const v of vaults) for (const folder of activeFolders(v.path)) {
      const repo = resolve(folder.abs), contexts = repos.get(repo) ?? [];
      contexts.push({ vault: v.path, slug: folder.slug, name: v.name }); repos.set(repo, contexts);
    }
    let recovered = 0, matching = 0, confirmed = 0;
    for (const [repo, contexts] of repos) {
      // Also works if first A died before its normal sync/engine imported the exact final legacy fact.
      // This verifies public publication + protected completed Keep receipt, never mints a permit.
      await importLegacyBootstrap(repo, SERVER_REV, contexts);
      const changes = await acceptedChanges(repo);
      const failed = changes.filter(c => c.release?.revision === SERVER_REV && verifiedRecoveryFailure(cfg.stateDir, c));
      const releaseIds = [...new Set(failed.map(c => c.release!.id))];
      const originals: AcceptedChange[] = [];
      for (const id of releaseIds) originals.push(...await acceptedFailedRelease(repo, id, SERVER_REV));
      matching += originals.length;
      // One release may include several accepted changes. Reverse acceptance/source order preserves
      // dependencies; each gets its own exact source revert, full proof and live permit.
      if (originals.some(c => c.rollbackOf)) throw new Error("A recovery release failed; needs attention, never revert its revert");
      for (const accepted of originals) {
        const already = (await acceptedChanges(repo)).find(c => c.rollbackOf === accepted.id);
        if (already) { await flushRecoveredProject(repo, accepted.review.base); confirmed++; continue; }
        const prior = await updateShippingJournal(repo, j => j.delivery?.rollbacks[accepted.id]);
        if (prior?.status === "failed") throw new Error("Previous retained source recovery failed; needs attention, not an automatic proof loop");
        const owners = contexts.filter(c => c.slug === accepted.review.slug && resolve(accepted.proofDir).startsWith(join(resolve(c.vault), ".vault-chat") + sep));
        if (owners.length !== 1) throw new Error("Accepted recovery identity has missing/ambiguous registered owning vault");
        const owner = owners[0]!;
        const home = homedir(), runtime = join(cfg.stateDir, "retained-recovery", owner.name);
        for (const dir of [runtime, join(runtime, "sessions"), join(runtime, "agent"), join(runtime, "jobs")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
        const shell = buildSandbox({ bwrap, home, stateDir: cfg.stateDir, secretsDir: cfg.secretsDir, hideFiles: [cfg.tokenPath, cfg.pushSubsPath, cfg.localStoragePath], sessionsDir: join(runtime, "sessions"), agentDir: join(runtime, "agent"), vault: owner.vault, uid: process.getuid?.() ?? -1, envFile: process.env.VC_ENV_FILE }).shell;
        const host = await installedChangeHostOptions(shell, await ensurePi(cfg.stateDir, { allowInstall: false }));
        // Same job primitive, private updater-owned context. The pre-A server must not reap this as a
        // missing shell unit and wake a model merely because it cannot recognize A's service-job kind.
        const jobs: PiJobEnv = { logDir: join(runtime, "jobs"), wrap: null, env: {} };
        const reason = verifiedRecoveryFailure(cfg.stateDir, accepted)!;
        try {
          const result = await requestRollback({ vault: owner.vault, accepted, reason, jobs, host });
          if (result.job) {
            await updateShippingJournal(repo, j => { const d = j.delivery ??= { releases: {}, rollbacks: {} }; d.rollbacks[accepted.id] = { status: "running", jobId: result.job!.id }; });
            for (;;) {
              const observed = probeJob(jobs, readJobs(jobs).find(j => j.id === result.job!.id) ?? result.job);
              if (observed.state !== "running") { if (observed.exit !== 0) throw new Error(`Retained source proof ${observed.state}; see ${join(runtime, "jobs", `${result.job.id}.log`)}`); break; }
              await new Promise(r => setTimeout(r, 500));
            }
          }
          if (!(await acceptedChanges(repo)).some(c => c.rollbackOf === accepted.id)) throw new Error("Recovery ended without accepted rollbackOf; no recovery success is claimed");
          await updateShippingJournal(repo, j => { const d = j.delivery ??= { releases: {}, rollbacks: {} }; d.rollbacks[accepted.id] = { status: "accepted" }; });
          await flushRecoveredProject(repo, accepted.review.base);
          recovered++; confirmed++;
        } catch (e) {
          await updateShippingJournal(repo, j => { const d = j.delivery ??= { releases: {}, rollbacks: {} }; d.rollbacks[accepted.id] = { status: "failed", error: "Retained source recovery needs attention; check installed updater logs" }; });
          throw e;
        }
      }
      // No write to the user's main occurs here outside requestRollback's exact proof acceptance.
      if (originals.length) console.log(`[recovery] ${repo}: source recovery accepted/transported; laptop sync, CI and actual device health still pending (${(await git(repo, ["rev-parse", "HEAD"])).trim()})`);
    }
    assertRecoveryCompletion(matching, confirmed);
    console.log(`[recovery] ${confirmed}/${matching} matching accepted changes have accepted source rollback and confirmed hub transport (${recovered} new); laptop push/CI/device health remain pending.`);
    return 0;
  } catch (e) {
    console.error(`[recovery] Needs attention: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
