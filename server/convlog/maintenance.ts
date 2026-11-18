/** Writer exclusion for an events directory: shared (a runtime, for its lifetime) or exclusive (an offline
 * transaction). Never rotate the events DIRECTORY inode. Every mutation-capable entrypoint must acquire one.
 *
 * Linux: a kernel lock, not a PID lease or per-event subprocess. flock(2) belongs to the open-file description:
 * the flock(1) child locks our inherited FD once, then exits; our parent FD keeps it held until close/process death.
 *
 * Elsewhere (macOS and Windows have no flock(1), so the app's own server failed as soon as it opened a vault):
 * holder files made with O_EXCL in a lock folder outside the vault (os.tmpdir(), per user), one per acquisition,
 * each naming its pid. Same rules as flock: any number of shared holders or one exclusive, two acquisitions in one
 * process conflict like two FDs do, and a holder whose process is gone (a crash, SIGKILL) is stale and removed by
 * the next acquirer. Released on release(), and on a normal exit.
 */
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Mode = "shared" | "exclusive";
const unavailable = (dir: string, mode: Mode, why: string) =>
  new Error(`Event directory ${mode} lock unavailable: ${dir}; ${why}`);

export function acquireEventDirectory(dir: string, mode: Mode): () => void {
  if (process.platform !== "linux" || process.env.VC_EVENT_LOCK === "portable") return acquirePortable(dir, mode);
  const fd = openSync(dir, "r");
  try {
    const r = spawnSync("flock", [`--${mode}`, "--nonblock", "3"], {
      stdio: ["ignore", "pipe", "pipe", fd], timeout: 5000, windowsHide: true,
    });
    if (r.error || r.status !== 0)
      throw unavailable(dir, mode, "maintenance/writer may be active or util-linux flock unavailable");
  } catch (e) { closeSync(fd); throw e; }
  let held = true;
  return () => { if (held) { held = false; closeSync(fd); } };
}

/** Where the portable holders for `dir` live: one folder per events directory, named by its real path. */
export function portableLockDir(dir: string, root = process.env.VC_LOCK_DIR || join(tmpdir(), "vault-chat-locks")): string {
  let real = resolve(dir);
  try { real = realpathSync.native(dir); } catch { /* not there yet: its resolved path */ }
  // APFS and NTFS are case-insensitive by default: one folder whatever case the path was given in.
  if (process.platform === "darwin" || process.platform === "win32") real = real.toLowerCase();
  return join(root, createHash("sha256").update(real).digest("hex").slice(0, 32));
}

const EXCLUSIVE = "exclusive.lock";
/** A holder file written but not yet filled in (its writer died in between) is stale after this long. */
const HALF_WRITTEN_MS = 10_000;
const held = new Set<string>();
let exitHook = false;

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/** The file is a live holder (true), gone (null), or stale and now removed (false). */
function live(file: string): boolean | null {
  let st;
  try { st = statSync(file); } catch { return null; }
  let pid = NaN;
  try { pid = (JSON.parse(readFileSync(file, "utf8")) as { pid?: number }).pid ?? NaN; } catch { /* half written */ }
  if (Number.isNaN(pid) ? Date.now() - st.mtimeMs < HALF_WRITTEN_MS : alive(pid)) return true;
  // Stale. Remove it only if it is still the same file (another acquirer may have reaped and replaced it).
  try { if (statSync(file).ino === st.ino) unlinkSync(file); } catch { /* already gone */ }
  return false;
}

/** Create `file` exclusively with this process as its holder; false when it already exists. */
function create(file: string): boolean {
  let fd: number;
  try { fd = openSync(file, "wx"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
  try { writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() })); } finally { closeSync(fd); }
  return true;
}

function drop(file: string) {
  held.delete(file);
  try { unlinkSync(file); } catch { /* gone */ }
}

export function acquirePortable(dir: string, mode: Mode, root?: string): () => void {
  const ld = portableLockDir(dir, root);
  mkdirSync(ld, { recursive: true });
  const ex = join(ld, EXCLUSIVE);
  let mine: string;
  if (mode === "exclusive") {
    // Take the exclusive file first, then look for shared holders; a shared acquirer does the opposite. Whatever
    // the interleaving, one of the two sees the other, so they are never both granted.
    if (!create(ex)) {
      if (live(ex) !== false || !create(ex)) throw unavailable(dir, mode, "maintenance or another writer is active");
    }
    mine = ex;
    for (const n of readdirSync(ld)) {
      if (!n.startsWith("shared-")) continue;
      if (live(join(ld, n))) { drop(ex); throw unavailable(dir, mode, "a writer is active"); }
    }
  } else {
    mine = join(ld, `shared-${process.pid}-${randomBytes(6).toString("hex")}.lock`);
    if (!create(mine)) throw unavailable(dir, mode, "holder name clash");
    if (live(ex)) { drop(mine); throw unavailable(dir, mode, "maintenance is active"); }
  }
  held.add(mine);
  if (!exitHook) {
    exitHook = true;
    process.on("exit", () => { for (const f of [...held]) drop(f); });
  }
  let on = true;
  return () => { if (on) { on = false; drop(mine); } };
}
