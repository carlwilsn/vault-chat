// The whiteboard's own log, sent to the box (POST /api/v1/board/log → the box's
// <state>/logs/board.jsonl, server/diag.ts): what the iPad did, so a board bug
// can be traced from the logs alone. Events are batched (every 15 s, or 40
// queued, or when the page hides) and carry names, ids and counts only — never
// ink, never what an item says.
//
//   tool          {tool}                         a toolbar mode chosen
//   board.open    {slug, items, strokes}         / board.close {slug}
//   inbox.add     {entry, part, items}           an inbox part placed on the board
//   inbox.fail    {entry, error}
//   image.fail    {error}
//   save.fail     {status, error}                / save.conflict {rev}
//   voice         {phase, error?}                the voice pill's phase changes
//   taps          {pressed, missed, dropped}     chrome taps since the last batch (chrome.ts)
//   error         {msg, src?}                    an uncaught error on the page
import { postBoardLog } from "./api";

type Ev = { at: string; ev: string; [k: string]: unknown };

const FLUSH_MS = 15_000;
const BATCH = 40;
const MAX_QUEUE = 300;
const SESSION = Math.random().toString(36).slice(2, 10);

let queue: Ev[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let taps: (() => { pressed: number; missed: number; dropped: number }) | null = null;
let installed = false;
let sending = false;

/** One board event. `data`: names, ids, counts. */
export function blog(ev: string, data: Record<string, unknown> = {}): void {
  queue.push({ at: new Date().toISOString(), ev, ...data });
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
  if (queue.length >= BATCH) void flushBoardLog();
  else if (!timer) timer = setTimeout(() => void flushBoardLog(), FLUSH_MS);
}

/** Where the chrome tap counts come from (the open board's ChromeTaps). */
export function setTapSource(fn: (() => { pressed: number; missed: number; dropped: number }) | null): void {
  if (!fn && taps) addTaps(taps);
  taps = fn;
}

function addTaps(fn: () => { pressed: number; missed: number; dropped: number }): void {
  const t = fn();
  if (t.pressed || t.missed || t.dropped) queue.push({ at: new Date().toISOString(), ev: "taps", ...t });
}

/** Send what is queued (never throws; a failed batch goes back in front). */
export async function flushBoardLog(beacon = false): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (taps) addTaps(taps);
  if (!queue.length || sending) return;
  const batch = queue;
  queue = [];
  sending = true;
  try {
    await postBoardLog({ session: SESSION, events: batch }, beacon);
  } catch {
    queue = [...batch, ...queue].slice(-MAX_QUEUE);
    if (!timer) timer = setTimeout(() => void flushBoardLog(), FLUSH_MS * 2);
  } finally {
    sending = false;
  }
}

/** Uncaught errors and the page hiding (send before iOS suspends it). Idempotent. */
export function installBoardLog(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (e) => blog("error", { msg: String(e.message).slice(0, 300), src: e.filename ? e.filename.split("/").pop() : null, line: e.lineno }));
  window.addEventListener("unhandledrejection", (e) => blog("error", { msg: String((e as PromiseRejectionEvent).reason?.message ?? (e as PromiseRejectionEvent).reason).slice(0, 300) }));
  document.addEventListener("visibilitychange", () => {
    blog("page", { hidden: document.hidden });
    if (document.hidden) void flushBoardLog(true);
  });
  window.addEventListener("pagehide", () => void flushBoardLog(true));
}
