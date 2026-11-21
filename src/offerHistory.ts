// Offer events reach the box's event log (Native agency: history past a device's memory). A part's offer events
// (src/pluginOffers.ts: "opened X at page 4", "chat switched") were kept only in the app, 20 per part. Now each one is
// also sent to the box (POST /api/v2/offer-events), a few seconds at a time, where it becomes an `offer.event`
// record in the vault's log: the agent can ask "what did I have open yesterday?" through box:history. The level is a
// sentence: an event that repeats within COALESCE_MS keeps only its newest (a scroll is one line, not a hundred).
import { setOfferEventSink, type OfferEventRecord } from "./pluginOffers";

export const FLUSH_MS = 3_000;
export const COALESCE_MS = 2_000;
export const MAX_BATCH = 50;
const MAX_PAYLOAD = 400;
/** A before-value (src/pluginOffers.ts OfferEventRecord.before) is kept longer than a payload: it is what undo needs. */
const MAX_BEFORE = 1_500;

export type OfferLogEvent = { plugin: string; event: string; at: number; payload?: string; before?: string };

/** Hover / focus moves (app/context) are not kept in the box's history: they were half of it and say nothing. */
export function isNoise(plugin: string, rec: OfferEventRecord): boolean {
  if (plugin !== "app/context" || rec.event !== "changed") return false;
  const ch = (rec.payload as { changed?: unknown } | undefined)?.changed;
  return Array.isArray(ch) && ch.every((k) => k === "hover" || k === "focus" || k === "at");
}

/** The payload as a short line (JSON, cut), or nothing. */
export function payloadLine(p: unknown, max = MAX_PAYLOAD): string | undefined {
  if (p === undefined) return undefined;
  let s: string;
  try {
    s = typeof p === "string" ? p : JSON.stringify(p);
  } catch {
    return undefined;
  }
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** The queue between the app and the box: coalesces repeats, sends in batches. */
export class OfferHistory {
  private queue: OfferLogEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(
    private send: (events: OfferLogEvent[]) => Promise<unknown>,
    private schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = (fn, ms) => setTimeout(fn, ms),
  ) {}
  add(plugin: string, rec: OfferEventRecord): void {
    if (isNoise(plugin, rec)) return;
    const ev: OfferLogEvent = { plugin, event: rec.event, at: rec.at, ...(rec.payload !== undefined ? { payload: payloadLine(rec.payload) } : {}), ...(rec.before !== undefined ? { before: payloadLine(rec.before, MAX_BEFORE) } : {}) };
    let last = -1;
    for (let i = this.queue.length - 1; i >= 0; i--) if (this.queue[i]!.plugin === plugin && this.queue[i]!.event === rec.event) {
      last = i;
      break;
    }
    // A coalesced repeat keeps the first one's before: undo goes back to before the whole run (a scroll's start).
    if (last >= 0 && rec.at - this.queue[last]!.at < COALESCE_MS) this.queue[last] = { ...ev, ...(this.queue[last]!.before !== undefined ? { before: this.queue[last]!.before } : {}) };
    else this.queue.push(ev);
    if (this.queue.length > MAX_BATCH * 4) this.queue.splice(0, this.queue.length - MAX_BATCH * 4);
    if (!this.timer) this.timer = this.schedule(() => void this.flush(), FLUSH_MS);
  }
  async flush(): Promise<void> {
    this.timer = null;
    const batch = this.queue.splice(0, MAX_BATCH);
    if (!batch.length) return;
    try {
      await this.send(batch);
    } catch {
      /* the box is away: these are lost, the app keeps its own 20 */
    }
    if (this.queue.length && !this.timer) this.timer = this.schedule(() => void this.flush(), FLUSH_MS);
  }
}

/** Send this app's offer events to the box through `post`; returns the undo. */
export function startOfferHistory(post: (events: OfferLogEvent[]) => Promise<unknown>): () => void {
  const h = new OfferHistory(post);
  const prev = setOfferEventSink((p, rec) => h.add(p.id, rec));
  return () => void setOfferEventSink(prev);
}
