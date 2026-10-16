// Startup timing marks for the debug log (app-log.txt).
//
// "vault-chat takes a bit and is glitchy on startup" was unanswerable from the
// log: it said "boot" and then nothing until the first warning. Each launch now
// leaves one line per phase and a summary:
//
//   boot           main.tsx starts running (the bundle has been fetched and parsed)
//   first paint    React's first frame; the window is shown
//   tree           the vault's file list arrived
//   chats          the conversations are loaded
//   vault ready    tree + chats
//   sync idle      the first sync / autosave pass for the open vault finished
//   summary        all of the above, plus the process uptime, the main-thread
//                  stalls Rust saw (boot_watch.rs: what Windows calls "Not
//                  responding") and the renderer's long tasks
//
// Times are ms since the page started loading (performance.now()); the summary
// also gives where page-load began in process time, so Rust's stalls line up.

import { invoke } from "@tauri-apps/api/core";
import { vlog } from "./debugLog";

type Stall = { at_ms: number; ms: number };
type RustTiming = { uptime_ms: number; stalls: Stall[] };

const marks = new Map<string, number>();
const longTasks: { at: number; ms: number }[] = [];
let summarized = false;
let summaryTimer: number | null = null;
const settledWaiters: (() => void)[] = [];

/** ms since the page started loading. */
export function bootNow(): number {
  return Math.round(performance.now());
}

/** Record a boot phase once (later calls with the same name are ignored). */
export function bootMark(name: string, data?: Record<string, unknown>): void {
  if (marks.has(name)) return;
  const t = bootNow();
  marks.set(name, t);
  vlog(`boot:${name}`, { t, ...(data ?? {}) });
  if ((name === "tree" || name === "chats") && marks.has("tree") && marks.has("chats")) {
    bootMark("vault ready");
  }
  if (name === "vault ready") releaseSettled();
  if (name === "sync idle") void summarize("sync idle");
}

export function hasBootMark(name: string): boolean {
  return marks.has(name);
}

function releaseSettled(): void {
  while (settledWaiters.length) settledWaiters.shift()!();
}

/**
 * Resolves once the open vault is on screen (tree + chats), or after `maxMs`,
 * whichever is first; immediately once startup is past. For background work
 * that would otherwise compete with the first screen (the first sync pass,
 * the phone host) — it still runs, just not in the way.
 */
export function afterVaultReady(maxMs = 4000): Promise<void> {
  // Only an app launch in progress waits (no "boot" mark: a harness, a headless run).
  if (!marks.has("boot") || marks.has("vault ready") || bootNow() > 20_000) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    settledWaiters.push(finish);
    setTimeout(finish, maxMs);
  });
}

/** Watch the renderer's long tasks (≥ 200 ms) until the summary is written. */
export function installBootTiming(): void {
  try {
    const po = new PerformanceObserver((list) => {
      if (summarized) return;
      for (const e of list.getEntries()) {
        if (e.duration >= 200) longTasks.push({ at: Math.round(e.startTime), ms: Math.round(e.duration) });
      }
    });
    po.observe({ type: "longtask", buffered: true });
  } catch {
    /* no longtask support in this webview */
  }
  // A launch with no vault (or a sync that never settles) still gets a summary.
  summaryTimer = window.setTimeout(() => void summarize("timeout"), 90_000);
}

async function summarize(why: string): Promise<void> {
  if (summarized) return;
  summarized = true;
  if (summaryTimer !== null) window.clearTimeout(summaryTimer);
  let rust: RustTiming | null = null;
  try {
    rust = await invoke<RustTiming>("boot_timing");
  } catch {
    rust = null;
  }
  const now = bootNow();
  const stalls = rust?.stalls ?? [];
  const lt = longTasks.slice().sort((a, b) => b.ms - a.ms);
  vlog("boot:summary", {
    why,
    marks: Object.fromEntries(marks),
    // Where page-load began, in ms since the process started.
    pageStartMs: rust ? rust.uptime_ms - now : null,
    mainThreadStalls: stalls.length,
    mainThreadStallMaxMs: stalls.reduce((m, s) => Math.max(m, s.ms), 0),
    mainThreadStallTotalMs: stalls.reduce((m, s) => m + s.ms, 0),
    stalls: stalls.slice(0, 6).map((s) => `${s.ms}ms@${s.at_ms}`),
    longTasks: lt.length,
    longTaskTotalMs: lt.reduce((m, s) => m + s.ms, 0),
    longTaskTop: lt.slice(0, 4).map((s) => `${s.ms}ms@${s.at}`),
  });
}
