// The `/poll` event ring (voice_server.rs:1384-1420): seq-numbered JSON lines,
// bounded to 300. Unlike the Rust ring, the sequence survives a restart: seqs
// are handed out from blocks reserved on disk, and a boot starts above the
// last reserved block — so a phone holding cursor N before a restart always
// sees the new events (their seqs are > N).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { renameRetry } from "./atomic";
import { dirname } from "node:path";

const RING_MAX = 300;
const BLOCK = 1000;

export class EventRing {
  private ring: { seq: number; line: string }[] = [];
  private next: number;
  private reservedUpTo: number;
  private waiters = new Set<() => void>();

  constructor(private floorPath: string) {
    let floor = 0;
    try {
      floor = Number(readFileSync(floorPath, "utf8").trim()) || 0;
    } catch {
      floor = 0;
    }
    this.next = floor + 1;
    this.reservedUpTo = floor;
    this.reserve();
  }

  private reserve(): void {
    this.reservedUpTo = this.next + BLOCK - 1;
    try {
      mkdirSync(dirname(this.floorPath), { recursive: true });
      const tmp = this.floorPath + ".tmp";
      writeFileSync(tmp, String(this.reservedUpTo));
      renameRetry(tmp, this.floorPath);
    } catch (e) {
      console.warn("[poll] could not persist the seq floor:", (e as Error).message);
    }
  }

  /** voice_server.rs:1394 broadcast_event. */
  push(line: string): number {
    const seq = this.next++;
    if (seq >= this.reservedUpTo) this.reserve();
    this.ring.push({ seq, line });
    while (this.ring.length > RING_MAX) this.ring.shift();
    for (const w of [...this.waiters]) w();
    return seq;
  }

  /** voice_server.rs:1404 latest_seq. */
  latest(): number {
    return this.next - 1;
  }

  /** voice_server.rs:1409 events_after. */
  after(after: number): { events: string[]; next: number } {
    let next = after;
    const events: string[] = [];
    for (const e of this.ring) {
      if (e.seq > after) {
        events.push(e.line);
        next = Math.max(next, e.seq);
      }
    }
    return { events, next: Math.max(next, after) };
  }

  /** Resolve when a new event lands or after `ms`. */
  wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.waiters.delete(done);
        resolve();
      };
      const t = setTimeout(done, ms);
      this.waiters.add(done);
    });
  }
}

let ring: EventRing | null = null;
export function initRing(floorPath: string): EventRing {
  ring = new EventRing(floorPath);
  return ring;
}
export function getRing(): EventRing {
  if (!ring) throw new Error("event ring not initialised");
  return ring;
}
