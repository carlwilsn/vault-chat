// Laptop-side changes asked for while the laptop is away (reports/21-design 10): kept by the box as desired state and
// run when its app is back, never a silent failure. PluginAct {…, whenBack: true} on a device that is down queues the
// action here (<stateDir>/device-queue.json); when the device's link comes up (server/deviceLink.ts onLinkUp) the box
// runs each queued action through the same PluginAct, in order, and the chat that asked gets one line saying what
// happened. An action not run within a day expires (said the same way). box:queue reads and cancels them.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { onLinkUp, type LinkClient } from "./deviceLink";

export const EXPIRE_MS = 24 * 3600_000;
/** After the link comes up, the app settles (mounts its parts) before the queue runs. */
export const SETTLE_MS = 4_000;

export type QueuedAct = { id: string; device: LinkClient; vault: string; conv: string | null; plugin: string; action: string; args: Record<string, unknown>; at: number };
export type QueueDone = QueuedAct & { ended: number; ok: boolean; text: string };
type File = { pending: QueuedAct[]; done: QueueDone[] };

const fileOf = (stateDir: string) => join(stateDir, "device-queue.json");

function read(stateDir: string): File {
  try {
    const v = JSON.parse(readFileSync(fileOf(stateDir), "utf8")) as Partial<File>;
    return { pending: Array.isArray(v.pending) ? v.pending : [], done: Array.isArray(v.done) ? v.done : [] };
  } catch {
    return { pending: [], done: [] };
  }
}
function write(stateDir: string, f: File): void {
  const p = fileOf(stateDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p + ".tmp", JSON.stringify({ pending: f.pending, done: f.done.slice(-20) }, null, 1));
  renameSync(p + ".tmp", p);
}

export function queueAct(stateDir: string, a: Omit<QueuedAct, "id" | "at">, now = Date.now()): QueuedAct {
  const f = read(stateDir);
  const q: QueuedAct = { ...a, id: `q-${now.toString(36)}-${randomBytes(3).toString("hex")}`, at: now };
  f.pending.push(q);
  write(stateDir, f);
  return q;
}

export function queueState(stateDir: string): File {
  return existsSync(fileOf(stateDir)) ? read(stateDir) : { pending: [], done: [] };
}

export function cancelQueued(stateDir: string, id: string, now = Date.now()): { ok: boolean; text: string } {
  const f = read(stateDir);
  const q = f.pending.find((x) => x.id === id);
  if (!q) return { ok: false, text: `no queued action "${id}"` };
  f.pending = f.pending.filter((x) => x !== q);
  f.done.push({ ...q, ended: now, ok: false, text: "cancelled" });
  write(stateDir, f);
  return { ok: true, text: `cancelled ${q.plugin} ${q.action}` };
}

export type QueueDeps = {
  stateDir: string;
  /** Run one queued action now (the same PluginAct a turn runs). */
  run: (q: QueuedAct) => Promise<{ ok: boolean; text: string }>;
  /** Say the outcome in the chat that asked (one line). */
  say: (q: QueuedAct, line: string) => Promise<void> | void;
  settleMs?: number;
  now?: () => number;
};

/** Run every queued action of `device`, oldest first; expired ones are said and dropped. */
export async function runQueued(d: QueueDeps, device: LinkClient): Promise<QueueDone[]> {
  const now = d.now ?? Date.now;
  const out: QueueDone[] = [];
  for (;;) {
    const f = read(d.stateDir);
    const q = f.pending.find((x) => x.device === device);
    if (!q) break;
    f.pending = f.pending.filter((x) => x !== q);
    write(d.stateDir, f);
    let r: { ok: boolean; text: string };
    if (now() - q.at > EXPIRE_MS) r = { ok: false, text: "expired: the laptop was away more than a day, so it was not done" };
    else {
      try {
        r = await d.run(q);
      } catch (e) {
        r = { ok: false, text: (e as Error)?.message ?? String(e) };
      }
    }
    const done: QueueDone = { ...q, ended: now(), ok: r.ok, text: r.text.slice(0, 600) };
    const g = read(d.stateDir);
    g.done.push(done);
    write(d.stateDir, g);
    out.push(done);
    try {
      await d.say(q, `${r.ok ? "Done now that the laptop is back" : "Not done"}: ${q.plugin} ${q.action} (asked while it was away)${r.ok ? "" : `: ${r.text.split("\n")[0]!.slice(0, 300)}`}.`);
    } catch {
      /* the line is best effort; the record is kept */
    }
  }
  return out;
}

/** Run the queue each time a device's link comes up. Returns the stop. */
export function startDeviceQueue(d: QueueDeps): () => void {
  return onLinkUp((device) => {
    const t = setTimeout(() => void runQueued(d, device).catch(() => {}), d.settleMs ?? SETTLE_MS);
    (t as { unref?: () => void }).unref?.();
  });
}
