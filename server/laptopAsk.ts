// Asking the laptop app over Show's channel: a {type, id, to:"laptop", ...} signal, answered by an ack on
// POST /api/v1/show/<id>/ack. Used by Timing (server/timingTool.ts) and the gate's UI runner (server/gate.ts), which run in
// the hidden, read-only Drive copy of the app (src/driveOnLaptop.ts, src/driveHost.ts).
import { randomBytes } from "node:crypto";
import { waitAck, type Ack } from "./show";
import { noteAnswer } from "./deviceLink";

/** The knobs a laptop run needs. */
export function laptopRunArgs(args: Record<string, unknown>, defTimeout = 60, maxTimeout = 180): { force: boolean; idleMs: number; timeoutMs: number } {
  const idleMin = typeof args.idleMinutes === "number" && args.idleMinutes >= 0 ? Math.min(args.idleMinutes, 60) : 5;
  const sec = typeof args.timeoutSec === "number" && args.timeoutSec > 0 ? Math.min(args.timeoutSec, maxTimeout) : defTimeout;
  return { force: args.force === true, idleMs: Math.round(idleMin * 60_000), timeoutMs: Math.round(sec * 1000) };
}

/** Ask the laptop over Show's channel; null when it didn't answer in time. */
export async function askLaptop(d: { emit: (ev: Record<string, unknown>) => void }, type: string, fields: Record<string, unknown>, ms: number): Promise<{ id: string; ack: Ack | null }> {
  const id = `${type}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  const got = waitAck(id, ms);
  d.emit({ type, id, to: "laptop", ...fields });
  const ack = await got;
  noteAnswer("laptop", type, !!ack);
  return { id, ack };
}
