/** Backup-first offline preparation. NO installation until the writer/checkpoint owner supplies
 * a common exclusion/cohort contract. Neither a quiet stat nor systemctl is that contract.
 * No service control, private-log defaults, old source SHA or historical file-size constants.
 */
import { constants } from "node:fs";
import { open, realpath, stat, lstat, access, mkdtemp, rename, chmod, writeFile, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve, relative, sep } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { compactOffline } from "./compact-event-log-offline.ts";
import { hashFile, identity, same, syncDir } from "./event-log-stream.ts";

export type PrepareOptions = { source: string; eventsDir: string; backupsRoot: string; idleMs: number };
export type Stage = "idle" | "copied" | "backup-verified" | "compacted";
// Dependency injection is for disposable fixtures, NOT a CLI bypass of host checks.
export type Observations = { assertStopped: () => Promise<void>; onStage?: (stage: Stage, artifactDir?: string) => Promise<void> };
const inside = (path: string, root: string) => path === root || path.startsWith(root + sep);

async function externalBackupRoot(path: string, events: string) {
  if (inside(path, events) || inside(events, path) || path.split(sep).includes(".vault-chat")) throw new Error("backup-root-must-be-outside-vault");
  for (let parent = path; ; parent = dirname(parent)) {
    const marker = join(parent, ".vault-chat");
    if (marker !== join(homedir(), ".vault-chat")) {
      try { await access(marker); throw new Error("backup-root-must-be-outside-vault"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    if (dirname(parent) === parent) return;
  }
}

export async function prepareOffline(options: PrepareOptions, observations: Observations) {
  if (!Number.isSafeInteger(options.idleMs) || options.idleMs < 1) throw new Error("positive-idle-ms-required");
  // Always check before opening source, even for dry-run.
  await observations.assertStopped();
  const events = await realpath(options.eventsDir), sourcePath = resolve(options.source);
  // Refuse aliases/hardlinks so replacement would have an unambiguous directory entry.
  if ((await lstat(sourcePath)).isSymbolicLink() || await realpath(sourcePath) !== sourcePath || dirname(sourcePath) !== events || !sourcePath.endsWith(".jsonl") || relative(events, sourcePath).startsWith("_")) throw new Error("source-must-be-a-conversation-file-in-events-dir");
  const backups = await realpath(options.backupsRoot);
  await externalBackupRoot(backups, events);
  const source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let artifactDir: string | undefined;
  try {
    const start = await source.stat();
    if (!start.isFile() || start.nlink !== 1 || start.size < 1) throw new Error("regular-single-link-nonempty-source-required");
    const checkSource = async () => {
      await observations.assertStopped();
      if (!same(identity(start), identity(await source.stat())) || !same(identity(start), identity(await lstat(sourcePath)))) throw new Error("source-changed-or-rotated");
    };
    await checkSource();
    await observations.onStage?.("idle");
    const until = Date.now() + options.idleMs;
    do { await delay(Math.min(250, Math.max(1, until - Date.now()))); await checkSource(); } while (Date.now() < until);
    // No candidate output is created before the COMPLETE fresh backup is verified.
    artifactDir = await mkdtemp(join(backups, "offline-events-"));
    await chmod(artifactDir, 0o700);
    await syncDir(backups);
    const partial = join(artifactDir, "original.partial"), backupPath = join(artifactDir, "original.jsonl");
    const backup = await open(partial, "wx", 0o600);
    let sourceSha256: string;
    try { sourceSha256 = await hashFile(source, start.size, backup); await backup.sync(); }
    finally { await backup.close(); }
    await observations.onStage?.("copied", artifactDir);
    await checkSource();
    const check = await open(partial, "r");
    try {
      const before = identity(await check.stat());
      if (before.size !== start.size || await hashFile(check, start.size) !== sourceSha256 || !same(before, identity(await check.stat())) || !same(before, identity(await lstat(partial)))) throw new Error("backup-readback-mismatch");
    } finally { await check.close(); }
    // Re-read the CURRENT source as well: quiet size alone cannot detect an in-place rewrite.
    if (await hashFile(source, start.size) !== sourceSha256) throw new Error("source-hash-changed");
    await checkSource();
    await chmod(partial, 0o400);
    await rename(partial, backupPath);
    await syncDir(artifactDir);
    const backupIdentity = identity(await lstat(backupPath));
    const backupEvidence = { backupIdentity, format: "offline-event-backup-v1", verified: true, source: sourcePath, identity: identity(start), bytes: start.size, sha256: sourceSha256, path: backupPath };
    const manifest = await open(join(artifactDir, "backup.json"), "wx", 0o600);
    try { await manifest.writeFile(JSON.stringify(backupEvidence, null, 2) + "\n"); await manifest.sync(); }
    finally { await manifest.close(); }
    await syncDir(artifactDir);
    await observations.onStage?.("backup-verified", artifactDir);
    await checkSource();
    const compact = await compactOffline({ input: backupPath, outDir: join(artifactDir, "candidate"), sha256: sourceSha256, bytes: start.size, eventsDir: events });
    await observations.onStage?.("compacted", artifactDir);
    await checkSource();
    const finalCandidate = await open(compact.output.path, "r");
    try {
      if ((await finalCandidate.stat()).size !== compact.output.bytes || await hashFile(finalCandidate, compact.output.bytes) !== compact.output.sha256) throw new Error("candidate-changed-after-fold-verification");
    } finally { await finalCandidate.close(); }
    // Detect even deliberate same-size backup tampering after the copy's own verification.
    const finalBackup = await open(backupPath, "r");
    try {
      if (!same(backupIdentity, identity(await finalBackup.stat())) || await hashFile(finalBackup, start.size) !== sourceSha256 || !same(backupIdentity, identity(await finalBackup.stat())) || !same(backupIdentity, identity(await lstat(backupPath)))) throw new Error("backup-changed");
    } finally { await finalBackup.close(); }
    for (const native of compact.nativeFiles) {
      let observed = null;
      try { observed = identity(await stat(native.path)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (!same(observed, native.identity)) throw new Error("native-session-changed-after-fold-verification");
    }
    await checkSource();
    const result = { format: "offline-event-preparation-v1", prepared: true, installed: false, writerExcluded: false,
      applyBlocked: "shared-writer-exclusion-and-checkpoint-cohort-not-integrated", idleMs: options.idleMs,
      source: sourcePath, checkpoint: sourcePath.replace(/\.jsonl$/, ".ckpt.json"), backup: backupEvidence, compact };
    const out = await open(join(artifactDir, "prepared.json"), "wx", 0o600);
    try { await out.writeFile(JSON.stringify(result, null, 2) + "\n"); await out.sync(); } finally { await out.close(); }
    await syncDir(artifactDir);
    return result;
  } catch (error) {
    // Keep original source and complete/partial backup for recovery; no deletion or replacement.
    if (artifactDir) {
      await writeFile(join(artifactDir, "FAILED.json"), JSON.stringify({ prepared: false, installed: false, sourceUntouchedByTool: true }) + "\n", { mode: 0o600 }).catch(() => {});
      await syncDir(artifactDir).catch(() => {});
    }
    throw error;
  } finally { await source.close(); }
}

/** Observational preflight, deliberately NOT advertised as all-writer exclusion. */
export async function assertHostStopped() {
  if (process.platform !== "linux" || (await readFile("/proc/1/comm", "utf8")).trim() !== "systemd") throw new Error("host-process-namespace-required");
  const nspid = (await readFile("/proc/self/status", "utf8")).match(/^NSpid:\s+(.+)$/m)?.[1].trim().split(/\s+/);
  if (!nspid || nspid.length !== 1) throw new Error("host-process-namespace-required");
  for (const unit of ["vault-chat-server.service", "vault-chat-update.service", "vault-chat-update.timer"]) {
    let fields: Record<string, string>;
    try {
      fields = Object.fromEntries(execFileSync("systemctl", ["--user", "show", unit, "--property=LoadState,ActiveState,SubState,ControlGroup"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 }).trim().split("\n").map(line => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)]; }));
    } catch { throw new Error("host-service-check-unavailable"); }
    if (fields.LoadState !== "loaded" || fields.ActiveState !== "inactive" || fields.SubState !== "dead") throw new Error("server-and-updater-must-be-stopped");
    if (fields.ControlGroup) {
      const cg = resolve("/sys/fs/cgroup", "." + fields.ControlGroup);
      if (!inside(cg, "/sys/fs/cgroup")) throw new Error("invalid-service-cgroup");
      const pending = [cg];
      while (pending.length) {
        const dir = pending.pop()!;
        try {
          if ((await readFile(join(dir, "cgroup.procs"), "utf8")).trim()) throw new Error("service-workers-remain");
          for (const entry of await readdir(dir, { withFileTypes: true })) if (entry.isDirectory()) pending.push(join(dir, entry.name));
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    }
  }
}

export function parseArgs(argv: string[]) {
  const values = new Map<string, string>(); let mode: "dry-run" | "apply" | undefined;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--dry-run" || flag === "--apply") {
      if (mode) throw new Error("choose-one-mode"); mode = flag === "--apply" ? "apply" : "dry-run"; continue;
    }
    if (!["--source", "--events-dir", "--backups-root", "--idle-ms"].includes(flag) || values.has(flag) || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error("invalid-arguments");
    values.set(flag, argv[++i]);
  }
  if (!mode || values.size !== 4) throw new Error("explicit-source-events-dir-backups-root-idle-ms-and-mode-required");
  const idleMs = Number(values.get("--idle-ms"));
  if (!Number.isSafeInteger(idleMs) || idleMs < 1) throw new Error("positive-idle-ms-required");
  return { mode, source: values.get("--source")!, eventsDir: values.get("--events-dir")!, backupsRoot: values.get("--backups-root")!, idleMs };
}
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === "apply") throw new Error("apply-blocked-writer-lock-and-checkpoint-cohort-not-integrated");
  const result = await prepareOffline(options, { assertStopped: assertHostStopped });
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error: unknown) => {
  const reasons = new Set(["apply-blocked-writer-lock-and-checkpoint-cohort-not-integrated", "host-process-namespace-required", "host-service-check-unavailable", "server-and-updater-must-be-stopped", "service-workers-remain", "source-changed-or-rotated", "source-hash-changed", "backup-readback-mismatch", "backup-changed", "candidate-changed-after-fold-verification", "native-session-changed-after-fold-verification", "backup-root-must-be-outside-vault", "source-must-be-a-conversation-file-in-events-dir", "positive-idle-ms-required", "choose-one-mode", "invalid-arguments", "explicit-source-events-dir-backups-root-idle-ms-and-mode-required"]);
  const reason = error instanceof Error && reasons.has(error.message) ? error.message : "validation-or-io-failure";
  console.error(`reason=${reason}`);
  console.error("Offline maintenance refused or preparation failed. Source not replaced. Apply is unavailable until shared writer exclusion and checkpoint-cohort integration. Retain backup artifacts; see reports/offline-compaction-urgent.md. No record contents are printed.");
  process.exitCode = 1;
});
