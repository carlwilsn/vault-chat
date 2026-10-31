/** Backup-first offline maintenance under the shared kernel directory lock.
 * Neither a quiet stat nor systemctl alone excludes writers.
 * No service control, private-log defaults, old source SHA or historical file-size constants.
 */
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { open, realpath, stat, lstat, access, mkdtemp, rename, chmod, writeFile, readFile, readdir, copyFile, unlink } from "node:fs/promises";
import { dirname, join, resolve, relative, sep } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { compactOffline } from "./compact-event-log-offline.ts";
import { hashFile, identity, same, syncDir, lines, digest, parseRecord } from "./event-log-stream.ts";

import { acquireEventDirectory } from "../server/convlog/maintenance.ts";
import { checkpointFor } from "../server/convlog/log.ts";
import { validatePosition } from "../server/convlog/reader.ts";
import { OfflineFold, type Reference } from "./event-log-offline-fold.ts";
import { completePrepared } from "./event-log-offline-cohort.ts";

export type PrepareOptions = { mode?: "dry-run" | "apply" | "checkpoint-only"; source: string; eventsDir: string; backupsRoot: string; idleMs: number };
export type Stage = "idle" | "copied" | "backup-verified" | "compacted" | "before-log-rename" | "between-renames" | "after-renames";
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
  await observations.assertStopped();
  const events = await realpath(options.eventsDir);
  const release = acquireEventDirectory(events, "exclusive");
  try { return await prepareLocked(options, observations); } finally { release(); }
}
async function prepareLocked(options: PrepareOptions, observations: Observations) {
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
  const stagingPaths: string[] = []; let durableIntent = false;
  try {
    const start = await source.stat();
    const checkpoint = sourcePath.replace(/\.jsonl$/, ".ckpt.json");
    const applying = options.mode === "apply" || options.mode === "checkpoint-only";
    let originalCheckpoint: { identity: ReturnType<typeof identity>; sha256: string; bytes: number; path: string } | null = null;
    let reference: Reference | undefined;
    let checkpointBytes: Buffer | undefined;
    if (applying) {
      try {
        const cs = await lstat(checkpoint);
        if (!cs.isFile() || cs.nlink !== 1) throw new Error("invalid-checkpoint-file");
        checkpointBytes = await readFile(checkpoint);
        if (!same(identity(cs), identity(await lstat(checkpoint)))) throw new Error("checkpoint-changed");
        const parsed = JSON.parse(checkpointBytes.toString("utf8"));
        reference = parsed as Reference;
        if (parsed.v === 3) validatePosition(sourcePath, parsed.position, parsed.seq);
        originalCheckpoint = { identity: identity(cs), bytes: cs.size, sha256: digest().update(checkpointBytes).digest("hex"), path: "" };
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    }
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
    if (originalCheckpoint && checkpointBytes) {
      originalCheckpoint.path = join(artifactDir, "original.ckpt.json");
      const cf = await open(originalCheckpoint.path, "wx", 0o400);
      try { await cf.writeFile(checkpointBytes); await cf.sync(); } finally { await cf.close(); }
      await syncDir(artifactDir);
    }
    const backupEvidence = { backupIdentity, format: "offline-event-backup-v1", verified: true, source: sourcePath, identity: identity(start), bytes: start.size, sha256: sourceSha256, path: backupPath };
    const manifest = await open(join(artifactDir, "backup.json"), "wx", 0o600);
    try { await manifest.writeFile(JSON.stringify(backupEvidence, null, 2) + "\n"); await manifest.sync(); }
    finally { await manifest.close(); }
    await syncDir(artifactDir);
    await observations.onStage?.("backup-verified", artifactDir);
    await checkSource();
    // Legacy v2 carries no original inode identity: after log-first replacement,
    // an interrupted cohort could attach it to the new file. Upgrade metadata
    // independently first; do not invent an identity in the live reader.
    if (options.mode === "apply" && reference?.v === 2) throw new Error("checkpoint-only-required-before-replacing-v2-log");
    const compact = options.mode === "checkpoint-only" ? await (async () => {
      const fold = new OfflineFold(events, true, reference);
      const fd = await open(backupPath, "r");
      try {
        // One sequential original-root canonical fold, including its complete
        // native pointer IDs. No candidate log and no worker-history rewrite.
        const logicalHash = digest(); let records = 0;
        for await (const line of lines(fd, start.size, digest())) {
          const { logical } = fold.add(parseRecord(line));
          logicalHash.update(JSON.stringify(logical) + "\n"); records++;
        }
        const picture = fold.verify();
        return { output: { path: backupPath, bytes: start.size, sha256: sourceSha256 }, picture,
          pointed: fold.pointed, nativeFiles: fold.nativeFiles, foldVerified: true, records, changedRecords: 0, logicalSha256: logicalHash.digest("hex"),
          lastSeq: picture.seq, foldSha256: digest().update(JSON.stringify(picture)).digest("hex") };
      } finally { fold.close(); await fd.close(); }
    })() : await compactOffline({ input: backupPath, outDir: join(artifactDir, "candidate"), sha256: sourceSha256, bytes: start.size, eventsDir: events, strictNative: applying, reference });
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
    const { picture, ...compactEvidence } = compact;
    const result = { format: "offline-event-preparation-v2", prepared: true, installed: false, writerExcluded: true,
      writerExclusion: "kernel-flock-cooperating-writers-only", legacyWritersMustBeStoppedByOperator: true,
      idleMs: options.idleMs, source: sourcePath, checkpoint, backup: backupEvidence, compact: compactEvidence };
    if (applying) {
      // Same-filesystem non-.jsonl names: startup cannot mistake an interrupted
      // staging file for a conversation. Never rotate the directory inode.
      const candidateLog = options.mode === "checkpoint-only" ? sourcePath : join(events, `.offline-${randomUUID()}-log.pending`);
      const candidateCheckpoint = join(events, `.offline-${randomUUID()}-checkpoint.pending`);
      if (candidateLog !== sourcePath) {
        stagingPaths.push(candidateLog);
        await copyFile(compact.output.path, candidateLog, constants.COPYFILE_EXCL);
        const f = await open(candidateLog, "r+");
        try { await f.sync(); } finally { await f.close(); }
      }
      const ck = checkpointFor(candidateLog, picture, compact.output.bytes, compact.pointed);
      stagingPaths.push(candidateCheckpoint);
      const f = await open(candidateCheckpoint, "wx", 0o600);
      try { await f.writeFile(JSON.stringify(ck) + "\n"); await f.sync(); } finally { await f.close(); }
      const evidence = async (path: string) => {
        const fd = await open(path, "r");
        try { const st = await fd.stat(); return { path, identity: identity(st), bytes: st.size, sha256: await hashFile(fd, st.size) }; }
        finally { await fd.close(); }
      };
      const log = await evidence(candidateLog), checkpointNew = await evidence(candidateCheckpoint);
      if (log.sha256 !== compact.output.sha256 || log.bytes !== compact.output.bytes) throw new Error("candidate-changed-after-fold-verification");
      await syncDir(events);
      const intent = { format: "offline-event-cohort-v1" as const, events, source: sourcePath, checkpoint,
        checkpointOnly: options.mode === "checkpoint-only", backup: backupEvidence, originalCheckpoint,
        log, checkpointNew, candidate: { seq: ck.seq, position: ck.position, pointed: ck.pointed!, foldSha256: compact.foldSha256 }, nativeFiles: compact.nativeFiles };
      const intentPath = join(artifactDir, "intent.json");
      const mf = await open(intentPath, "wx", 0o600);
      try { await mf.writeFile(JSON.stringify(intent, null, 2) + "\n"); await mf.sync(); } finally { await mf.close(); }
      await syncDir(artifactDir);
      durableIntent = true;
      await checkSource();
      await completePrepared(intentPath, observations, true);
      result.installed = true;
    }
    const out = await open(join(artifactDir, "prepared.json"), "wx", 0o600);
    try { await out.writeFile(JSON.stringify(result, null, 2) + "\n"); await out.sync(); } finally { await out.close(); }
    await syncDir(artifactDir);
    return result;
  } catch (error) {
    // Only our newly allocated, uncommitted staging files may be removed.
    // Once intent is durable, retain both inodes for ordinary --recover.
    if (!durableIntent) {
      for (const path of stagingPaths) await unlink(path).catch(() => {});
      if (stagingPaths.length) await syncDir(events).catch(() => {});
    }
    // Keep original source and complete/partial backup for recovery; no deletion or replacement.
    if (artifactDir) {
      await writeFile(join(artifactDir, "FAILED.json"), JSON.stringify({ prepared: false, installed: (options.mode === "apply" || options.mode === "checkpoint-only") ? "unknown-check-intent" : false, cohortMayBePartiallyInstalled: true }) + "\n", { mode: 0o600 }).catch(() => {});
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
  const values = new Map<string, string>(); let mode: "dry-run" | "apply" | "checkpoint-only" | undefined;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--dry-run" || flag === "--apply" || flag === "--checkpoint-only") {
      if (mode) throw new Error("choose-one-mode"); mode = flag.slice(2) as "dry-run" | "apply" | "checkpoint-only"; continue;
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
  const argv = process.argv.slice(2);
  if (argv.length === 2 && argv[0] === "--recover") {
    await completePrepared(argv[1]!, { assertStopped: assertHostStopped });
    console.log("Offline cohort complete; verified under exclusive event-directory lock.");
    return;
  }
  const options = parseArgs(argv);
  const result = await prepareOffline(options, { assertStopped: assertHostStopped });
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error: unknown) => {
  const reasons = new Set(["checkpoint-only-required-before-replacing-v2-log", "native-pointer-missing-preserve-original-checkpoint", "authoritative-checkpoint-fold-mismatch-preserve-original", "candidate-record-exceeds-runtime-8MiB-limit", "recovery-current-cohort-unknown-refuse-overwrite", "host-process-namespace-required", "host-service-check-unavailable", "server-and-updater-must-be-stopped", "service-workers-remain", "source-changed-or-rotated", "source-hash-changed", "backup-readback-mismatch", "backup-changed", "candidate-changed-after-fold-verification", "native-session-changed-after-fold-verification", "backup-root-must-be-outside-vault", "source-must-be-a-conversation-file-in-events-dir", "positive-idle-ms-required", "choose-one-mode", "invalid-arguments", "explicit-source-events-dir-backups-root-idle-ms-and-mode-required"]);
  const reason = error instanceof Error && reasons.has(error.message) ? error.message : error instanceof Error && error.message.startsWith("Event directory ") ? "event-directory-lock-unavailable" : "validation-or-io-failure";
  console.error(`reason=${reason}`);
  console.error("Offline maintenance failed or refused. If intent.json exists, retain ALL artifacts and use --recover INTENT after review; do not manually overwrite the log or checkpoint. See reports/offline-apply-urgent.md. No record contents are printed.");
  process.exitCode = 1;
});
