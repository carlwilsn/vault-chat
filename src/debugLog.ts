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

import { invoke } from "@tauri-apps/api/core";

const LS_KEY = "vc_debug_buf";
const MAX_ENTRIES = 800;
const PERSIST_INTERVAL_MS = 200;

type Entry = { t: number; tag: string; data?: unknown };

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
  let safe = data;
  try {
    if (data !== undefined) {
      const s = JSON.stringify(data);
      if (s && s.length > 600) safe = s.slice(0, 600) + "…";
      else safe = data;
    }
  } catch {
    safe = String(data);
  }
  buf.push({ t: Date.now(), tag, data: safe });
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
  console.warn = (...args: unknown[]) => {
    try {
      vlog("console.warn", args.map(String).join(" ").slice(0, 500));
      persistNow();
    } catch {
      /* ignore */
    }
    origWarn(...args);
  };
  console.error = (...args: unknown[]) => {
    try {
      vlog("console.error", args.map(String).join(" ").slice(0, 500));
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
  const header = `\n===== flush @ ${new Date().toISOString()} (${saved.length} entries) =====\n`;
  const lines = saved
    .map((e) => {
      const ts = new Date(e.t).toISOString().slice(11, 23);
      const d = e.data === undefined ? "" : " " + (typeof e.data === "string" ? e.data : JSON.stringify(e.data));
      return `${ts} ${e.tag}${d}`;
    })
    .join("\n");
  try {
    await invoke("append_debug_log", { vaultPath, text: header + lines + "\n" });
    // Only clear after a successful write so we never lose the trail.
    buf = [];
    try {
      localStorage.removeItem(LS_KEY);
    } catch {
      /* ignore */
    }
  } catch {
    // Couldn't write — keep the buffer for the next attempt.
  }
}
