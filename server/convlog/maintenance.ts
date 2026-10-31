/** Linux kernel writer exclusion, not a PID lease or per-event subprocess.
 * flock(2) belongs to the open-file description: the child locks our inherited
 * FD once, then exits; our parent FD keeps it held until close/process death.
 * Never rotate the events DIRECTORY inode. Every mutation-capable entrypoint
 * must acquire shared (runtime lifetime) or exclusive (offline transaction).
 */
import { closeSync, openSync } from "node:fs";
import { spawnSync } from "node:child_process";
export function acquireEventDirectory(dir: string, mode: "shared" | "exclusive"): () => void {
  const fd = openSync(dir, "r");
  try {
    const r = spawnSync("flock", [`--${mode}`, "--nonblock", "3"], {
      stdio: ["ignore", "pipe", "pipe", fd], timeout: 5000, windowsHide: true,
    });
    if (r.error || r.status !== 0)
      throw new Error(`Event directory ${mode} lock unavailable: ${dir}; maintenance/writer may be active or util-linux flock unavailable`);
  } catch (e) { closeSync(fd); throw e; }
  let held = true;
  return () => { if (held) { held = false; closeSync(fd); } };
}
