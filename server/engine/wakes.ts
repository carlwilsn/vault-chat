// Durable one-off wakes: <vault>/.vault-chat/local/wakes.json
// [{conv, at, reason, id}]. Machine-local (the engine adds .vault-chat/local/
// to the working copy's .git/info/exclude). Written atomically; reloaded on
// every tick, so a restart re-arms whatever is pending. No recurrence.
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { renameRetry } from "../atomic";

/** `byCarl`: set by a turn Carl started (its finish may buzz his phone, server/pushGate.ts). */
export type Wake = { conv: string; at: number; reason: string; id: string; byCarl?: boolean };

export function wakesPath(vault: string): string {
  return join(vault, ".vault-chat", "local", "wakes.json");
}

export function readWakes(vault: string): Wake[] {
  try {
    const v = JSON.parse(readFileSync(wakesPath(vault), "utf8"));
    return Array.isArray(v) ? v.filter((w) => w && typeof w.conv === "string" && typeof w.at === "number") : [];
  } catch {
    return [];
  }
}

function writeWakes(vault: string, list: Wake[]): void {
  const p = wakesPath(vault);
  mkdirSync(join(vault, ".vault-chat", "local"), { recursive: true });
  writeFileSync(p + ".tmp", JSON.stringify(list, null, 1));
  renameRetry(p + ".tmp", p);
}

export function addWake(vault: string, w: Omit<Wake, "id">): Wake {
  const wake: Wake = { ...w, id: `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}` };
  writeWakes(vault, [...readWakes(vault), wake]);
  return wake;
}

export function removeWakes(vault: string, pred: (w: Wake) => boolean): Wake[] {
  const all = readWakes(vault);
  const gone = all.filter(pred);
  if (gone.length) writeWakes(vault, all.filter((w) => !pred(w)));
  return gone;
}

export function nextWakeFor(vault: string, conv: string): number | undefined {
  const mine = readWakes(vault).filter((w) => w.conv === conv).map((w) => w.at);
  return mine.length ? Math.min(...mine) : undefined;
}

/** "90s", "2m", "1h30m", "1d", or a bare number of minutes → ms. */
export function parseDelay(s: unknown): number | null {
  if (typeof s === "number" && Number.isFinite(s)) return s * 60_000;
  const t = String(s ?? "").trim().toLowerCase();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t) * 60_000;
  let ms = 0;
  let matched = false;
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(d|h|m|min|mins|minutes?|s|sec|secs|seconds?|hours?|days?)/g)) {
    matched = true;
    const n = Number(m[1]);
    const u = m[2]!;
    ms += u.startsWith("d") ? n * 86_400_000 : u.startsWith("h") ? n * 3_600_000 : u.startsWith("s") ? n * 1000 : n * 60_000;
  }
  return matched ? ms : null;
}

/** Keep machine-local engine files out of the vault's git (never touches tracked files). */
export function excludeLocalDir(vault: string): void {
  const ex = join(vault, ".git", "info", "exclude");
  try {
    if (!existsSync(join(vault, ".git"))) return;
    mkdirSync(join(vault, ".git", "info"), { recursive: true });
    const cur = existsSync(ex) ? readFileSync(ex, "utf8") : "";
    if (!cur.split(/\r?\n/).includes(".vault-chat/local/")) appendFileSync(ex, `${cur && !cur.endsWith("\n") ? "\n" : ""}.vault-chat/local/\n`);
  } catch {
    /* best effort */
  }
}
