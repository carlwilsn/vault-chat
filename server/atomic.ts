// rename() that survives Windows' transient EPERM/EACCES/EBUSY (an indexer or
// virus scanner briefly holding the target open). On Linux it is a plain
// atomic rename and never retries.
import { renameSync, writeFileSync } from "node:fs";

const sleeper = new Int32Array(new SharedArrayBuffer(4));

export function renameRetry(from: string, to: string): void {
  for (let i = 0; ; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= 20 || !(code === "EPERM" || code === "EACCES" || code === "EBUSY")) throw e;
      Atomics.wait(sleeper, 0, 0, 25 * (i + 1));
    }
  }
}

/** Write to `tmp`, then rename over `path`. */
export function writeAtomic(path: string, body: string, tmp = `${path}.tmp`): void {
  writeFileSync(tmp, body);
  renameRetry(tmp, path);
}
