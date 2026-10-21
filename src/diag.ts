// "Something just went wrong": one file with the last N minutes of every log.
// Ctrl+Shift+D on the laptop (or window.vcDiag() from the devtools) gathers
//   - this laptop's app-log (app-log.txt and its rotated .1),
//   - its client events (client-events.jsonl and .1) and sync log,
//   - the box's half (GET /api/v1/diag: the turn log with intents, the board
//     log, the journal excerpt, the phone's client events),
// and writes them as `<vault>/.vault-chat/diag/diag-<time>.json` (machine-local,
// gitignored). Everything is redacted again here (src/logRedact.ts): no key, no
// token, no message or file contents.
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "./store";
import { APP_VERSION, vlog, vlogFlush, flushDebugLogToDisk } from "./debugLog";
import { cev, flushClientEvents } from "./clientEvents";
import { redactText, safeData } from "./logRedact";
import { hit } from "./shortcuts";

export const DIAG_MINUTES = 15;

/** Lines of a `<ISO> …` text log at or after `since` (older-format lines without a date are skipped). */
export function textLinesSince(raw: string, since: number): string[] {
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)\s/.exec(line);
    if (!m) continue;
    const t = Date.parse(m[1]!);
    if (Number.isFinite(t) && t >= since) out.push(redactText(line).slice(0, 2000));
  }
  return out;
}

/** JSONL records at or after `since` (by `at` ISO or `ts` ms), made safe. */
export function jsonlSince(raw: string, since: number): unknown[] {
  const out: unknown[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      const t = typeof v?.ts === "number" ? v.ts : Date.parse(String(v?.at ?? ""));
      if (Number.isFinite(t) && t >= since) out.push(safeData(v, { depth: 5 }));
    } catch {
      /* a torn line */
    }
  }
  return out;
}

export type DiagInput = {
  now: number;
  minutes: number;
  vault: string | null;
  /** Raw file texts, oldest file first (a rotated .1 before the live one). */
  appLog: string[];
  clientEvents: string[];
  syncLog: string[];
  box: unknown;
};

/** The bundle, from the raw logs. Pure. */
export function buildDiagBundle(i: DiagInput): Record<string, unknown> {
  const since = i.now - i.minutes * 60_000;
  return {
    kind: "vault-chat-diag",
    at: new Date(i.now).toISOString(),
    minutes: i.minutes,
    laptop: {
      version: APP_VERSION,
      vault: i.vault,
      ua: typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 120) : null,
      appLog: i.appLog.flatMap((r) => textLinesSince(r, since)),
      clientEvents: i.clientEvents.flatMap((r) => jsonlSince(r, since)),
      syncLog: i.syncLog.flatMap((r) => jsonlSince(r, since)),
    },
    box: safeData(i.box, { depth: 7, cap: 2000 }),
  };
}

async function readOr(path: string): Promise<string> {
  try {
    return await invoke<string>("read_text_file", { path });
  } catch {
    return "";
  }
}

/** Gather, write, and return the bundle's path (null: no vault open). */
export async function writeDiagBundle(minutes = DIAG_MINUTES): Promise<string | null> {
  const vault = useStore.getState().vaultPath;
  if (!vault) return null;
  cev("diag", { minutes });
  vlog("diag", { minutes });
  vlogFlush();
  await flushDebugLogToDisk(vault).catch(() => {});
  await flushClientEvents();
  const dir = `${vault.replace(/[\\/]+$/, "")}/.vault-chat`;
  const [log1, log0, ev1, ev0, sync] = await Promise.all([
    readOr(`${dir}/app-log.1.txt`),
    readOr(`${dir}/app-log.txt`),
    readOr(`${dir}/client-events.1.jsonl`),
    readOr(`${dir}/client-events.jsonl`),
    readOr(`${dir}/sync-log.jsonl`),
  ]);
  let box: unknown = { note: "not in box mode" };
  try {
    const { boxLinkFor, boxGet } = await import("./boxChat");
    const link = await boxLinkFor(vault);
    if (link) box = await boxGet(link, `/api/v1/diag?minutes=${minutes}`, 30_000);
  } catch (e) {
    box = { error: `the box's logs could not be fetched: ${String((e as Error)?.message ?? e)}` };
  }
  const now = Date.now();
  const bundle = buildDiagBundle({ now, minutes, vault: vault.replace(/\\/g, "/").split("/").pop() ?? null, appLog: [log1, log0], clientEvents: [ev1, ev0], syncLog: [sync], box });
  const path = `${dir}/diag/diag-${new Date(now).toISOString().replace(/[:.]/g, "-")}.json`;
  await invoke("write_text_file", { path, contents: JSON.stringify(bundle, null, 1) });
  vlog("diag written", { path: path.slice(vault.length + 1) });
  return path;
}

/** Ctrl+Shift+D: write the bundle and say where. Also window.vcDiag(minutes?). */
export function installDiagShortcut(): void {
  if (typeof window === "undefined") return;
  const run = async (minutes?: number) => {
    try {
      const p = await writeDiagBundle(minutes);
      if (!p) return null;
      try {
        const { message } = await import("@tauri-apps/plugin-dialog");
        await message(`Saved the last ${minutes ?? DIAG_MINUTES} minutes of logs (laptop and box) to\n${p}`, { title: "Diagnostics" });
      } catch {
        /* no dialog: the path is in the app log */
      }
      return p;
    } catch (e) {
      console.warn("[diag] failed:", e);
      return null;
    }
  };
  (window as unknown as { vcDiag: typeof run }).vcDiag = run;
  window.addEventListener("keydown", (e) => {
    if (hit(e, "box.diag") && !e.repeat) {
      e.preventDefault();
      void run();
    }
  });
}
