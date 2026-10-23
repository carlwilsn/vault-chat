// GET /api/v1/diag?minutes=15 — the box's half of a "something just went
// wrong" bundle: the last N minutes of the turn log (turns and intents), the
// board's log, the journal of the server and its updater, and the phone's
// client events in this vault. The laptop's Report action (src/diag.ts) adds
// its own app-log and client events and writes the whole as one file.
// Everything passes through src/logRedact.ts again on the way out: no key, no
// token, no message text.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { boxLogs } from "./boxLogs";
import { redactText, safeData } from "../src/logRedact";

export type BoxDiag = {
  at: string;
  host: string;
  version: string;
  rev: string | null;
  vault: string;
  minutes: number;
  turns: unknown[];
  board: unknown[];
  /** The laptop's and the phone's voice diagnostics (voice.jsonl). */
  voice: unknown[];
  /** The laptop app's errors and box drops (app.jsonl). */
  app: unknown[];
  journal: string[];
  phoneEvents: unknown[];
  notes: string[];
};

const MAX_MINUTES = 24 * 60;

/** The journal of the server (and its updater) since `minutes` ago, redacted. Empty off systemd. */
export function journalExcerpt(minutes: number, max = 3000): { lines: string[]; note?: string } {
  if (process.platform !== "linux") return { lines: [], note: "no journal on this platform" };
  const r = spawnSync("journalctl", ["--user", "-u", "vault-chat-server", "-u", "vault-chat-update", "--since", `-${Math.ceil(minutes)}min`, "-o", "short-iso-precise", "--no-pager", "-n", String(max)], {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) return { lines: [], note: `journalctl: ${String(r.error?.message ?? r.stderr ?? r.status).trim().slice(0, 200)}` };
  return { lines: String(r.stdout).split("\n").filter(Boolean).map((l) => redactText(l).slice(0, 2000)) };
}

/** JSONL lines of a file whose `ts` (ms) or `at` (ISO) is at or after `since`; reads at most the last `tailBytes`. */
export function jsonlSince(file: string, since: number, tailBytes = 2 * 1024 * 1024): unknown[] {
  if (!existsSync(file)) return [];
  let raw = "";
  try {
    const size = statSync(file).size;
    const buf = readFileSync(file);
    raw = buf.subarray(Math.max(0, size - tailBytes)).toString("utf8");
  } catch {
    return [];
  }
  const out: unknown[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      const t = typeof v?.ts === "number" ? v.ts : Date.parse(String(v?.at ?? v?.t ?? ""));
      if (Number.isFinite(t) && t >= since) out.push(safeData(v, { depth: 5 }));
    } catch {
      /* a torn line */
    }
  }
  return out;
}

export function boxDiag(o: { stateDir: string; vault: string; vaultName: string; version: string; rev: string | null; minutes: number; now?: number }): BoxDiag {
  const minutes = Math.max(1, Math.min(MAX_MINUTES, Math.round(o.minutes) || 15));
  const now = o.now ?? Date.now();
  const since = now - minutes * 60_000;
  const logs = boxLogs(o.stateDir);
  const notes: string[] = [];
  const j = journalExcerpt(minutes);
  if (j.note) notes.push(j.note);
  return {
    at: new Date(now).toISOString(),
    host: hostname(),
    version: o.version,
    rev: o.rev,
    vault: o.vaultName,
    minutes,
    turns: logs.turns.since(since).map((x) => safeData(x, { depth: 5 })),
    board: logs.board.since(since).map((x) => safeData(x, { depth: 5 })),
    voice: logs.voice.since(since).map((x) => safeData(x, { depth: 5 })),
    app: logs.app.since(since).map((x) => safeData(x, { depth: 5 })),
    journal: j.lines,
    phoneEvents: jsonlSince(join(o.vault, ".vault-chat", "client-events.jsonl"), since),
    notes,
  };
}

/** One board batch (POST /api/v1/board/log): each event its own line, stamped and made safe. A batch with
 *  source "voice" (the laptop's and the phone's voice diagnostics, src/voiceShip.ts) goes to voice.jsonl, one with
 *  source "app" (the laptop app's errors and box drops, src/appShip.ts) to app.jsonl. */
export function boardLogPost(o: { stateDir: string; vaultName: string; ua: string }, body: any): { status: number; body: Record<string, unknown> } {
  const evs: unknown[] = Array.isArray(body?.events) ? body.events.slice(0, 300) : [];
  if (!evs.length) return { status: 400, body: { error: "events: a non-empty list is required" } };
  const voice = body?.source === "voice" || body?.source === "app";
  const log = body?.source === "app" ? boxLogs(o.stateDir).app : voice ? boxLogs(o.stateDir).voice : boxLogs(o.stateDir).board;
  const from = voice && typeof body?.device === "string" ? body.device.slice(0, 20) : null;
  const ua = /iPad|iPhone|Macintosh|Android|Windows|Linux/.exec(o.ua)?.[0] ?? "?";
  const sess = typeof body?.session === "string" ? body.session.slice(0, 40) : null;
  // The board's build, and what the device says it is: an iPad sends a Mac UA, so its touch points tell it apart.
  const v = typeof body?.v === "string" ? body.v.slice(0, 60) : null;
  const touch = typeof body?.touch === "number" && Number.isFinite(body.touch) ? Math.max(0, Math.min(20, Math.round(body.touch))) : null;
  const app = body?.standalone === true ? "home-screen" : body?.standalone === false ? "browser" : null;
  const device = { ...(v ? { v } : {}), ...(touch !== null ? { touch } : {}), ...(app ? { app } : {}) };
  let n = 0;
  for (const e of evs) {
    if (!e || typeof e !== "object") continue;
    const { at, ev, ...rest } = e as Record<string, unknown>;
    const t = Date.parse(String(at ?? ""));
    log.append({ ...rest, at: Number.isFinite(t) ? new Date(t).toISOString() : new Date().toISOString(), ev: String(ev ?? "?").slice(0, 60), vault: o.vaultName, ua, ...device, ...(from ? { device: from } : {}), ...(sess ? { session: sess } : {}) });
    n++;
  }
  return { status: 200, body: { ok: true, n } };
}
