// What a noun's watch is made of (server/model/index.ts Noun.watch): real events only, never a timer that re-reads.
// A directory's files changing (the OS's file events) and a burst of events folded into one call.
import { existsSync, watch as fsWatch } from "node:fs";

/** Call `fn` when a file in `dir` is written, added or removed; nothing when the dir is not there. Returns the undo. */
export function watchDir(dir: string, fn: () => void): () => void {
  if (!dir || !existsSync(dir)) return () => {};
  try {
    const w = fsWatch(dir, () => fn());
    w.on("error", () => {});
    return () => w.close();
  } catch {
    return () => {};
  }
}

/** `fn` once per burst: `ms` after the first call of a burst (a streaming turn writes many records; one read follows). */
export function folded(fn: () => void, ms = 250): { call: () => void; stop: () => void } {
  let t: ReturnType<typeof setTimeout> | null = null;
  return {
    call: () => {
      if (t) return;
      t = setTimeout(() => ((t = null), fn()), ms);
      (t as { unref?: () => void }).unref?.();
    },
    stop: () => {
      if (t) clearTimeout(t);
      t = null;
    },
  };
}

/** Several undos as one. */
export const all = (offs: (() => void)[]) => () => {
  for (const f of offs) {
    try {
      f();
    } catch {
      /* one undo's own error */
    }
  }
};
