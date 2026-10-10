// Stand-in for server/atomic.ts (which sleeps with Atomics.wait on a
// SharedArrayBuffer — unavailable in a page that isn't cross-origin isolated).
// The in-memory rename never fails, so no retry is needed.
import { renameSync, writeFileSync } from "./memfs";

export function renameRetry(from: string, to: string): void {
  renameSync(from, to);
}

export function writeAtomic(path: string, body: string, tmp = `${path}.tmp`): void {
  writeFileSync(tmp, body);
  renameSync(tmp, path);
}
