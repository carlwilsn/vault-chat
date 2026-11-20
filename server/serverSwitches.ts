// The box server's own handovers as log records. The updater (server/deploy/vault-chat-update.sh) is not a log writer:
// it appends one line per handover ("keep": a new version took over) and per switch back ("switch") to
// <state>/server-switches.jsonl, and the server that owns the log writes each line as a `box.server.switch` signal
// record in the main vault's log, once (a byte cursor in <state>/server-switches.seen). A switch back to a version
// from before this file is recorded by the next server that has it.
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { signal } from "./convlog/log";

export const SERVER_SWITCH = "box.server.switch";

type Side = { slot: string; version: string | null; rev: string | null; source: "box" | "github" } | null;
export type ServerSwitch = { type: typeof SERVER_SWITCH; change: "keep" | "switch"; by: "auto"; at: number; to: Side; from: Side; reason?: string };

const side = (v: unknown): Side => {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const str = (x: unknown, re: RegExp) => (typeof x === "string" && re.test(x) ? x : null);
  const slot = str(o.slot, /^[0-9A-Za-z.+-]{1,80}$/);
  if (!slot) return null;
  return { slot, version: str(o.version, /^[0-9A-Za-z.+-]{1,40}$/), rev: str(o.rev, /^[0-9a-f]{40}$/), source: o.source === "box" ? "box" : "github" };
};

/** One updater line as a record, or null when it is not one. */
export function parseSwitch(line: string): ServerSwitch | null {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (!o || (o.change !== "keep" && o.change !== "switch")) return null;
  const to = side(o.to);
  if (!to) return null;
  const reason = typeof o.reason === "string" && o.reason.trim() ? o.reason.trim().slice(0, 300) : undefined;
  return { type: SERVER_SWITCH, change: o.change, by: "auto", at: Number(o.at) || Date.now(), to, from: side(o.from), ...(reason ? { reason } : {}) };
}

/** Write the updater's new lines as records (emit: the main vault's signal). Returns how many were written. */
export function recordServerSwitches(stateDir: string, emit: (ev: ServerSwitch) => boolean): number {
  const file = join(stateDir, "server-switches.jsonl");
  const seenFile = join(stateDir, "server-switches.seen");
  if (!existsSync(file)) return 0;
  const buf = readFileSync(file);
  let seen = Number(existsSync(seenFile) ? readFileSync(seenFile, "utf8").trim() : 0) || 0;
  // The file was replaced by a shorter one: start over at its beginning.
  if (seen > buf.length) seen = 0;
  let n = 0;
  while (seen < buf.length) {
    const nl = buf.indexOf(10, seen);
    if (nl < 0) break; // a line still being written
    const rec = parseSwitch(buf.subarray(seen, nl).toString("utf8"));
    if (rec && !emit(rec)) break; // the log could not be written: try again next time
    if (rec) n++;
    seen = nl + 1;
    writeFileSync(seenFile + ".tmp", String(seen));
    renameSync(seenFile + ".tmp", seenFile);
  }
  return n;
}

let timer: ReturnType<typeof setInterval> | null = null;
/** At boot, on the server that owns the log: now, then every minute (the updater notes a handover after the new
 *  server is healthy). */
export function startServerSwitches(stateDir: string, vault: string): void {
  const look = () => {
    try {
      const n = recordServerSwitches(stateDir, (ev) => !!signal(vault, ev as unknown as Record<string, unknown>));
      if (n) console.log(`[update] recorded ${n} server handover(s) in the log`);
    } catch (e) {
      console.error(`[update] ${(e as Error).message}`);
    }
  };
  if (timer) clearInterval(timer);
  timer = setInterval(look, 60_000);
  timer.unref?.();
  look();
}
