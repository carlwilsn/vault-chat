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
//   taps          {pressed, missed, dropped, missedOn?, src}  chrome taps since the last batch (chrome.ts):
//                                                the board's chrome (src "board") and the voice pill ("pill")
//   gestures      {pan, pinch, pan1, undo, reverted, palm: {reason: n}, maxSize}
//                                                fingers on the canvas since the last batch (palm.ts):
//                                                two-finger pans and pinches, one-finger pans, undo taps,
//                                                gestures undone by a palm, each palm rejection by reason
//                                                (size, third-touch, late-second, pen-down, pen-hover,
//                                                pen-lock, hand-side, rested) and the largest contact (css px)
//   voice.close   {reason, code, closeReason, transport, secs, by}  why a voice session ended
//   dialog        {what, how, focused, keyboard, vvh, ih}  the name dialog: how it was opened, whether its
//                                                field took focus and whether the keyboard came up;
//   dialog.tap    {what, n, field, keyboard}    a tap on the field that had no keyboard, refocused in the tap
//   error         {msg, src?}                    an uncaught error on the page
//
// Every batch carries the board's build ({v}: its version and commit), so a report names the code it ran,
// and the device (touch: navigator.maxTouchPoints, standalone: from the Home Screen): iPadOS sends a Mac user
// agent, so the box's "ua" alone says "Macintosh" for Carl's iPad.
import { postBoardLog } from "./api";

type Ev = { at: string; ev: string; [k: string]: unknown };

const FLUSH_MS = 15_000;
const BATCH = 40;
const MAX_QUEUE = 300;
const SESSION = Math.random().toString(36).slice(2, 10);

let queue: Ev[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
/** Counters read at every flush (the chrome's taps, the fingers' gestures): a source returns null when it has nothing. */
const sources = new Map<string, () => Record<string, unknown> | null>();
const VERSION = typeof __BOARD_VERSION__ === "string" ? __BOARD_VERSION__ : "dev";
/** What the device is (an iPad sends a Mac UA: its touch points tell it apart) and whether it runs from the Home Screen. */
const DEVICE = (() => {
  try {
    return { touch: navigator.maxTouchPoints ?? 0, standalone: (navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia("(display-mode: standalone)").matches };
  } catch {
    return {};
  }
})();
let installed = false;
let sending = false;

/** One board event. `data`: names, ids, counts. */
export function blog(ev: string, data: Record<string, unknown> = {}): void {
  queue.push({ at: new Date().toISOString(), ev, ...data });
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
  if (queue.length >= BATCH) void flushBoardLog();
  else if (!timer) timer = setTimeout(() => void flushBoardLog(), FLUSH_MS);
}

/** A counter read at every flush, under `key` (e.g. "taps:board"); its events are `ev` lines. Null removes it (read once more first). */
export function setStatSource(key: string, ev: string, fn: (() => Record<string, unknown> | null) | null): void {
  const prev = sources.get(key);
  if (prev) readSource(prev);
  if (fn) {
    sources.set(key, () => {
      const d = fn();
      return d ? { ev, ...d } : null;
    });
    // Counters are read every FLUSH_MS while there are any (a batch goes only when something happened).
    if (!timer) timer = setTimeout(() => void flushBoardLog(), FLUSH_MS);
  } else sources.delete(key);
}

function readSource(fn: () => Record<string, unknown> | null): void {
  const d = fn();
  if (d) queue.push({ at: new Date().toISOString(), ...(d as { ev: string }) });
}

/** The chrome's tap counts as a log line, or null when there were none. */
export function tapLine(t: { pressed: number; missed: number; dropped: number; missedOn?: string[] }, src: string): Record<string, unknown> | null {
  return t.pressed || t.missed || t.dropped ? { ...t, src } : null;
}

/** Where the chrome tap counts come from (the open board's ChromeTaps). */
export function setTapSource(fn: (() => { pressed: number; missed: number; dropped: number; missedOn?: string[] }) | null): void {
  setStatSource("taps:board", "taps", fn ? () => tapLine(fn(), "board") : null);
}

/** Send what is queued (never throws; a failed batch goes back in front). */
export async function flushBoardLog(beacon = false): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  for (const fn of sources.values()) readSource(fn);
  if (sources.size) timer = setTimeout(() => void flushBoardLog(), FLUSH_MS);
  if (!queue.length || sending) return;
  const batch = queue;
  queue = [];
  sending = true;
  try {
    await postBoardLog({ session: SESSION, v: VERSION, ...DEVICE, events: batch }, beacon);
  } catch {
    queue = [...batch, ...queue].slice(-MAX_QUEUE);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void flushBoardLog(), FLUSH_MS * 2);
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
