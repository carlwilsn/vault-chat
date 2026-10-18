// The box's own logs, beside its other state: <state>/logs/.
//   turns.jsonl  one line per agent turn (engine/turnLog.ts), every vault;
//   board.jsonl  the whiteboard's batched events (POST /api/v1/board/log).
// Each is a JSONL file capped in size: past the cap it becomes <name>.1 (the
// older .1 → .2 …, the last dropped), so a box that runs for months keeps the
// recent weeks and never fills its disk. Not in a vault: these are this
// machine's records (git never carries them, a re-clone never loses them), and
// one directory holds everything the diag bundle reads (server/diag.ts).
// Every line goes through src/logRedact.ts on the way in.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { safeLine } from "../src/logRedact";

export type RotatingOpts = { maxBytes?: number; keep?: number };

/** An append-only JSONL file that rotates past `maxBytes`, keeping `keep` older files. */
export class RotatingLog {
  readonly maxBytes: number;
  readonly keep: number;
  constructor(
    readonly path: string,
    o: RotatingOpts = {},
  ) {
    this.maxBytes = o.maxBytes ?? 5 * 1024 * 1024;
    this.keep = Math.max(1, o.keep ?? 3);
  }

  /** The files, newest first (the live file, then .1, .2 …), those that exist. */
  files(): string[] {
    const out = [this.path];
    for (let i = 1; i <= this.keep; i++) out.push(`${this.path}.${i}`);
    return out.filter((f) => existsSync(f));
  }

  private rotate(): void {
    try {
      const last = `${this.path}.${this.keep}`;
      if (existsSync(last)) rmSync(last, { force: true });
      for (let i = this.keep - 1; i >= 1; i--) if (existsSync(`${this.path}.${i}`)) renameSync(`${this.path}.${i}`, `${this.path}.${i + 1}`);
      renameSync(this.path, `${this.path}.1`);
    } catch {
      /* best effort: the next append tries again */
    }
  }

  /** Append one record (made safe) or a raw line already made safe. Never throws. */
  append(rec: Record<string, unknown> | string): void {
    try {
      const line = typeof rec === "string" ? rec : safeLine(rec);
      mkdirSync(dirname(this.path), { recursive: true });
      let size = 0;
      try {
        size = statSync(this.path).size;
      } catch {
        size = 0;
      }
      if (size > 0 && size + line.length + 1 > this.maxBytes) this.rotate();
      appendFileSync(this.path, line.endsWith("\n") ? line : line + "\n");
    } catch {
      /* logging never breaks the caller */
    }
  }

  /** The records whose `at` (ISO) is at or after `since` (ms), oldest first, across the rotated files. */
  since(since: number, max = 5000): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const f of this.files()) {
      let raw = "";
      try {
        raw = readFileSync(f, "utf8");
      } catch {
        continue;
      }
      const got: Record<string, unknown>[] = [];
      let older = false;
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const v = JSON.parse(line) as Record<string, unknown>;
          const t = Date.parse(String(v.at ?? ""));
          if (Number.isFinite(t) && t >= since) got.push(v);
          else if (Number.isFinite(t)) older = true;
        } catch {
          /* a torn line */
        }
      }
      out.unshift(...got);
      // A rotated file whose lines are all before the window: the older ones are too.
      if (older && !got.length) break;
    }
    return out.slice(-max);
  }
}

export type BoxLogs = { dir: string; turns: RotatingLog; board: RotatingLog };

const cache = new Map<string, BoxLogs>();

/** The box's logs under `stateDir` (one set per state dir). */
export function boxLogs(stateDir: string): BoxLogs {
  let l = cache.get(stateDir);
  if (!l) {
    const dir = join(stateDir, "logs");
    l = { dir, turns: new RotatingLog(join(dir, "turns.jsonl")), board: new RotatingLog(join(dir, "board.jsonl"), { maxBytes: 2 * 1024 * 1024 }) };
    cache.set(stateDir, l);
  }
  return l;
}
