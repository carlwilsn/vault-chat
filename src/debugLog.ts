// Freeze/crash diagnostic logger.
//
// The app has been hard-freezing in edit mode for one vault, and a hard
// freeze means we can't rely on async file writes flushing before the
// main thread locks. So every log entry is mirrored into `localStorage`
// *synchronously* (localStorage.setItem is a synchronous, durable write).
// Even if the renderer then locks up and the user force-quits, the trail
// survives. On the next launch we flush whatever's in localStorage to
// `<vault>/.vault-chat/app-log.txt` (which the agent can read) and clear
// the buffer.
//
// To capture a tight synchronous loop, we also re-persist every ~200ms of
// wall-clock time *during* logging — so even a function that never yields
// leaves a partial trail as long as it keeps calling vlog().
//
// Every line on disk is `<ISO time> v<version> <tag> <data>`: the full date and
// the app's version on each line (a flush header alone left both to be
// inferred). Data passes through src/logRedact.ts (no keys, no tokens, no
// message or file contents: names, ids, counts and timings). The file is
// capped: past 4 MB it becomes app-log.1.txt (append_debug_log, lib.rs).

import { invoke } from "@tauri-apps/api/core";
import { capText, redactText, safeData } from "./logRedact";

declare const __APP_VERSION__: string | undefined;
/** The app's version (vite.config.ts defines it; "dev" elsewhere). */
export const APP_VERSION: string = typeof __APP_VERSION__ !== "undefined" && __APP_VERSION__ ? __APP_VERSION__ : "dev";

const LS_KEY = "vc_debug_buf";
const MAX_ENTRIES = 800;
// 0 = persist synchronously on every entry. The freeze locks within a few
// ms of the toggle, faster than any throttle window, so we cannot afford
// to buffer: every entry must hit durable localStorage immediately or it's
// lost when the user force-quits the frozen app.
const PERSIST_INTERVAL_MS = 0;

type Entry = { t: number; tag: string; data?: unknown; v?: string };

let buf: Entry[] = [];
let lastPersist = 0;
let installed = false;

// Hydrate any trail left by a previous (possibly frozen) session so the
// startup flush can pick it up even before the first new log.
try {
  const raw = localStorage.getItem(LS_KEY);
  if (raw) buf = JSON.parse(raw) as Entry[];
} catch {
  buf = [];
}

function persistNow(): void {
  lastPersist = Date.now();
  try {
    if (buf.length > MAX_ENTRIES) buf = buf.slice(-MAX_ENTRIES);
    localStorage.setItem(LS_KEY, JSON.stringify(buf));
  } catch {
    // localStorage full or unavailable — drop oldest half and retry once.
    try {
      buf = buf.slice(-Math.floor(MAX_ENTRIES / 2));
      localStorage.setItem(LS_KEY, JSON.stringify(buf));
    } catch {
      /* give up silently */
    }
  }
}

/**
 * Record a diagnostic event. Cheap and never throws. `data` should be
 * small and JSON-serializable; large blobs are stringified+truncated.
 */
export function vlog(tag: string, data?: unknown): void {
  let safe: unknown = undefined;
  try {
    if (data !== undefined) {
      safe = typeof data === "string" ? capText(redactText(data), 500) : safeData(data);
      const s = JSON.stringify(safe);
      if (s && s.length > 600) safe = s.slice(0, 600) + "…";
    }
  } catch {
    safe = capText(redactText(String(data)), 500);
  }
  buf.push({ t: Date.now(), tag, data: safe, v: APP_VERSION });
  if (buf.length > MAX_ENTRIES) buf = buf.slice(-MAX_ENTRIES);
  // Throttle the synchronous localStorage write so a hot loop calling
  // vlog() thousands of times doesn't itself become the bottleneck — but
  // because we key off wall-clock time, a long synchronous loop still
  // leaves a trail every ~200ms.
  if (Date.now() - lastPersist >= PERSIST_INTERVAL_MS) persistNow();
}

/** Force a synchronous persist — call before known-risky operations. */
export function vlogFlush(): void {
  persistNow();
}

/**
 * Install global hooks: mirror console.warn/error (CodeMirror's measure-
 * loop warning goes here), and capture uncaught errors / rejections.
 * Idempotent.
 */
export function installDebugLog(): void {
  if (installed) return;
  installed = true;

  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);
  // console.info / console.debug, and console.log lines tagged "[…]" (the app's own diagnostics):
  // into the trail too, redacted and capped like everything else.
  for (const level of ["info", "debug", "log"] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      try {
        if (level !== "log" || (typeof args[0] === "string" && args[0].startsWith("["))) vlog(`console.${level}`, consoleText(args));
      } catch {
        /* ignore */
      }
      orig(...args);
    };
  }
  console.warn = (...args: unknown[]) => {
    try {
      vlog("console.warn", consoleText(args));
      persistNow();
    } catch {
      /* ignore */
    }
    origWarn(...args);
  };
  console.error = (...args: unknown[]) => {
    try {
      vlog("console.error", consoleText(args));
      persistNow();
    } catch {
      /* ignore */
    }
    origError(...args);
  };

  window.addEventListener("error", (e) => {
    vlog("window.error", {
      msg: e.message,
      src: e.filename,
      line: e.lineno,
      col: e.colno,
    });
    persistNow();
  });
  window.addEventListener("unhandledrejection", (e) => {
    vlog("unhandledrejection", String((e as PromiseRejectionEvent).reason).slice(0, 500));
    persistNow();
  });
  // Last chance to persist when the window is being torn down.
  window.addEventListener("pagehide", () => persistNow());
  window.addEventListener("beforeunload", () => persistNow());

  vlog("debugLog installed", { ua: navigator.userAgent.slice(0, 80) });
}

/** A console call's arguments as one line (objects as JSON, errors as their message). */
function consoleText(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return a.message;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ")
    .slice(0, 800);
}

/** One entry as its app-log line: `<ISO> v<version> <tag> <data>`. */
export function formatEntry(e: Entry): string {
  const d = e.data === undefined ? "" : " " + (typeof e.data === "string" ? e.data : JSON.stringify(e.data));
  return `${new Date(e.t).toISOString()} v${e.v ?? APP_VERSION} ${e.tag}${d}`.replace(/\r?\n/g, " ⏎ ");
}

/**
 * Flush the buffered trail (including anything left by a previous frozen
 * session) to `<vault>/.vault-chat/app-log.txt`, then clear it. Safe to
 * call repeatedly; no-ops when the buffer is empty.
 */
export async function flushDebugLogToDisk(vaultPath: string | null): Promise<void> {
  if (!vaultPath) return;
  let saved: Entry[] = [];
  try {
    saved = JSON.parse(localStorage.getItem(LS_KEY) || "[]") as Entry[];
  } catch {
    saved = [];
  }
  if (!saved.length) return;
  const header = `\n===== flush @ ${new Date().toISOString()} v${APP_VERSION} (${saved.length} entries) =====\n`;
  const lines = saved.map(formatEntry).join("\n");
  try {
    await invoke("append_debug_log", { vaultPath, text: header + lines + "\n" });
    // Only clear after a successful write so we never lose the trail — and
    // clear only what was written: entries logged while the write was in
    // flight (everything right after "boot" used to vanish here) stay for the
    // next flush.
    dropFlushed(saved);
  } catch {
    // Couldn't write — keep the buffer for the next attempt.
  }
}

// Remove the flushed entries from the buffer and its localStorage mirror,
// keeping anything logged after `saved` was read.
function dropFlushed(saved: Entry[]): void {
  // Since `saved` was read the buffer has only grown at the end (or been
  // trimmed at the front), so the last flushed entry sits at or before index
  // saved.length - 1. Not found: it was trimmed away (or another flush already
  // dropped it), so everything left is newer.
  const last = saved[saved.length - 1];
  let j = -1;
  for (let p = Math.min(saved.length, buf.length) - 1; p >= 0; p--) {
    if (buf[p].t === last.t && buf[p].tag === last.tag) {
      j = p;
      break;
    }
  }
  buf = j === -1 ? buf : buf.slice(j + 1);
  try {
    if (buf.length) localStorage.setItem(LS_KEY, JSON.stringify(buf));
    else localStorage.removeItem(LS_KEY);
  } catch {
    /* ignore */
  }
}
