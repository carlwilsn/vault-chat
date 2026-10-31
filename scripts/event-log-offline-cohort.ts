/** Recoverable two-file installation; NOT an atomic cohort. All source access is
 * under exclusive kernel exclusion. A durable external intent pins dynamic bytes
 * and original/new inodes; it is safety/CAS metadata, never authorization. */
import { open, lstat, stat, readFile, realpath, rename } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type { Position } from "../server/convlog/reader.ts";
import { dirname, resolve } from "node:path";
import { acquireEventDirectory } from "../server/convlog/maintenance.ts";
import { hashFile, identity, same, syncDir, digest } from "./event-log-stream.ts";
import type { Observations } from "./offline-event-log.ts";

type Evidence = { path: string; identity: ReturnType<typeof identity>; bytes: number; sha256: string };
type Intent = {
  format: "offline-event-cohort-v1"; events: string; source: string; checkpoint: string; checkpointOnly: boolean;
  backup: Evidence & { source: string; backupIdentity: ReturnType<typeof identity> };
  originalCheckpoint: Evidence | null; log: Evidence; checkpointNew: Evidence;
  candidate: { seq: number; position: Position; pointed: Record<string, string[]>; foldSha256: string };
  nativeFiles: { path: string; identity: ReturnType<typeof identity> | null }[];
};
// rename changes ctime, not inode/generation or content. Hash every checked file
// as well: stat alone is not proof against same-size in-place legacy mutation.
function generation(a: ReturnType<typeof identity>, b: ReturnType<typeof identity>) {
  return a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs && a.size === b.size && a.mtimeMs === b.mtimeMs && b.nlink === 1;
}
async function matches(path: string, e: Evidence, exact = false) {
  let fd: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const st = await lstat(path);
    if (!st.isFile() || st.isSymbolicLink()) return false;
    const now = identity(st);
    if (!(exact ? same(now, e.identity) : generation(e.identity, now)) || st.size !== e.bytes) return false;
    fd = await open(path, "r");
    return await hashFile(fd, e.bytes) === e.sha256 && same(now, identity(await fd.stat())) && same(now, identity(await lstat(path)));
  } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
  finally { await fd?.close(); }
}
async function absent(path: string) {
  try { await lstat(path); return false; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return true; throw e; }
}
export async function completePrepared(manifestPath: string, observations: Observations, alreadyExclusive = false) {
  await observations.assertStopped();
  const bytes = await readFile(manifestPath);
  const m = JSON.parse(bytes.toString("utf8")) as Intent;
  if (m.format !== "offline-event-cohort-v1" || resolve(m.events) !== m.events || dirname(m.source) !== m.events || !m.source.endsWith(".jsonl") || m.checkpoint !== m.source.replace(/\.jsonl$/, ".ckpt.json") || dirname(m.checkpointNew.path) !== m.events || !m.checkpointNew.path.endsWith(".pending") || (m.checkpointOnly ? m.log.path !== m.source : dirname(m.log.path) !== m.events || !m.log.path.endsWith(".pending"))) throw new Error("invalid-recovery-intent");
  if (await realpath(m.events) !== m.events) throw new Error("event-directory-alias");
  const release = alreadyExclusive ? () => {} : acquireEventDirectory(m.events, "exclusive");
  try {
    await observations.assertStopped();
    // Retain and verify fresh original data even when only completing the second
    // rename. A stale/missing backup is never silently bypassed.
    if (!await matches(m.backup.path, { ...m.backup, identity: m.backup.backupIdentity }, true)) throw new Error("recovery-original-backup-invalid");
    if (m.originalCheckpoint) {
      const fd = await open(m.originalCheckpoint.path, "r");
      try { if ((await fd.stat()).size !== m.originalCheckpoint.bytes || await hashFile(fd, m.originalCheckpoint.bytes) !== m.originalCheckpoint.sha256) throw new Error("recovery-original-checkpoint-backup-invalid"); }
      finally { await fd.close(); }
    }
    const verifyNative = async () => { for (const native of m.nativeFiles) {
      let now = null;
      try { now = identity(await stat(native.path)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      if (!same(now, native.identity)) throw new Error("native-session-changed-after-fold-verification");
    } };
    await verifyNative();
    const oldLog = await matches(m.source, { ...m.backup, path: m.source }, true);
    const newLog = await matches(m.source, m.log);
    const oldCheckpoint = m.originalCheckpoint ? await matches(m.checkpoint, m.originalCheckpoint, true) : await absent(m.checkpoint);
    const newCheckpoint = await matches(m.checkpoint, m.checkpointNew);
    if ((!oldLog && !newLog) || (!oldCheckpoint && !newCheckpoint) || (!m.checkpointOnly && oldLog && newCheckpoint)) throw new Error("recovery-current-cohort-unknown-refuse-overwrite");
    if (!newLog && !await matches(m.log.path, m.log, true)) throw new Error("recovery-prepared-log-invalid");
    if (!newCheckpoint && !await matches(m.checkpointNew.path, m.checkpointNew, true)) throw new Error("recovery-prepared-checkpoint-invalid");
    // Validate position against the actual NEW inode, before either rename.
    const checkpointPath = newCheckpoint ? m.checkpoint : m.checkpointNew.path;
    const ck = JSON.parse(await readFile(checkpointPath, "utf8"));
    const logPath = newLog ? m.source : m.log.path;
    const st = await lstat(logPath);
    if (ck.v !== 3 || ck.seq !== ck.picture?.seq || ck.position?.seq !== ck.seq || ck.position?.offset !== m.log.bytes || ck.position.dev !== st.dev || ck.position.ino !== st.ino || ck.position.birthtimeMs !== st.birthtimeMs || !ck.pointed || typeof ck.pointed !== "object") throw new Error("recovery-checkpoint-cohort-invalid");
    if (ck.seq !== m.candidate.seq || !isDeepStrictEqual(ck.position, m.candidate.position) || !isDeepStrictEqual(ck.pointed, m.candidate.pointed) || digest().update(JSON.stringify(ck.picture)).digest("hex") !== m.candidate.foldSha256) throw new Error("recovery-checkpoint-cache-mismatch");
    // Confirm intent itself remained stable while verifying potentially large
    // files, then perform only the recognized forward state transition.
    if (digest().update(bytes).digest("hex") !== digest().update(await readFile(manifestPath)).digest("hex")) throw new Error("recovery-intent-changed");
    await observations.assertStopped();
    await observations.onStage?.("before-log-rename", dirname(manifestPath));
    // Synthetic hooks can fail, not authorize replacing an unexpected source.
    if (!(newLog ? await matches(m.source, m.log) : await matches(m.source, { ...m.backup, path: m.source }, true))) throw new Error("source-changed-or-rotated");
    if (!newLog && !await matches(m.log.path, m.log, true)) throw new Error("recovery-prepared-log-invalid");
    if (!newCheckpoint && !await matches(m.checkpointNew.path, m.checkpointNew, true)) throw new Error("recovery-prepared-checkpoint-invalid");
    if (!(newCheckpoint ? await matches(m.checkpoint, m.checkpointNew) : m.originalCheckpoint ? await matches(m.checkpoint, m.originalCheckpoint, true) : await absent(m.checkpoint))) throw new Error("checkpoint-changed");
    await verifyNative();
    if (!m.checkpointOnly && !newLog) {
      await rename(m.log.path, m.source);
      await syncDir(m.events); // durable log-first ordering even across power loss
    }
    await observations.onStage?.("between-renames", dirname(manifestPath));
    await verifyNative();
    if (!newCheckpoint) {
      if (!(m.originalCheckpoint ? await matches(m.checkpoint, m.originalCheckpoint, true) : await absent(m.checkpoint))) throw new Error("checkpoint-changed");
      await rename(m.checkpointNew.path, m.checkpoint);
    }
    await syncDir(m.events);
    await observations.onStage?.("after-renames", dirname(manifestPath));
    return { installed: true, checkpointOnly: m.checkpointOnly };
  } finally { release(); }
}
