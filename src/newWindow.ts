// New window (the title bar's button, in place of Pop out chat): a second vault-chat window on the same vault, the
// same box and the same chats. Its own tiles (the same rules, at most 4), Files and Chats closed at first (Ctrl+B /
// Ctrl+Shift+B open them, in that window only: src/store.ts); a chat in it is the same live chat as in the main window
// (both read the box). Each window's tiles are kept on the box by window (server/layoutTool.ts): they survive a
// restart (the main window opens the kept ones again at start, src/boxChat.ts), and closing a New window drops them.
//
// One path: box:workspace's newWindow and closeWindow (src/layoutOps.ts) are what the button, the window's own close
// (its X, Alt+F4) and the agent run. The native window is the shell's (src-tauri/src/app_windows.rs, label win-<n>,
// loading index.html?window=<n>; the preview's fake opens a popup of the same page).
import { invoke } from "@tauri-apps/api/core";
import { isSecondWindow, windowNo } from "./windowKind";

/** The one New window there is (Carl: 8 chats across two windows). */
export const SECOND_WINDOW = 2;

type Done = { ok: boolean; note?: string; error?: string };
const why = (e: unknown) => (e as Error)?.message ?? String(e);

/** Says to the box what a window's tiles are (POST /api/v2/layout); set by src/boxChat.ts once it is connected. */
let boxPost: ((body: Record<string, unknown>) => Promise<unknown>) | null = null;
export function setWindowBoxPost(fn: typeof boxPost): void {
  boxPost = fn;
}

/** Open window `n` (or bring it forward when it is open). `quiet`: put back at start, not brought to the front. */
export async function openWindow(n = SECOND_WINDOW, quiet = false): Promise<Done> {
  if (n === windowNo) return { ok: true, note: "this is that window" };
  try {
    const made = await invoke<boolean>("app_window_open", { n, focus: !quiet });
    return { ok: true, note: made ? `window ${n} opened` : `window ${n} was open: brought to the front` };
  } catch (e) {
    return { ok: false, error: `the window could not be opened: ${why(e)}` };
  }
}

/** This window is closing: it no longer tells the box its layout. */
let closing = false;
export const windowClosing = (): boolean => closing;

/**
 * Close window `n`: it goes, with its web pages, and its tiles are dropped on the box (a closed window does not come
 * back at the next start). Run in the window itself (its X, Alt+F4) or in the main window (the agent).
 */
export async function closeWindow(n = isSecondWindow ? windowNo : SECOND_WINDOW): Promise<Done> {
  if (n < 2) return { ok: false, error: "the main window is not closed this way (it is the app)" };
  if (n === windowNo) {
    // This window: it says nothing more to the box, the box forgets its tiles, then it goes.
    closing = true;
    await dropKept(n);
    await invoke("web_embed_close", {}).catch(() => undefined);
    try {
      await invoke<boolean>("app_window_close", { n });
      return { ok: true, note: `window ${n} closed` };
    } catch (e) {
      closing = false;
      return { ok: false, error: `the window could not be closed: ${why(e)}` };
    }
  }
  // Another window (from the main window): it goes first, so it can't say its tiles again after they are dropped.
  let was: boolean;
  try {
    was = await invoke<boolean>("app_window_close", { n });
  } catch (e) {
    return { ok: false, error: `the window could not be closed: ${why(e)}` };
  }
  await dropKept(n);
  return { ok: true, note: was ? `window ${n} closed` : `window ${n} was not open` };
}

/** The box forgets window `n`'s tiles. */
async function dropKept(n: number): Promise<void> {
  try {
    await boxPost?.({ window: n, closed: true });
  } catch {
    /* the box away: the window still closes; its tiles come back at most */
  }
}

/** A New window (its side panels start closed: src/store.ts): its title says which, and its own close (the X,
 *  Alt+F4, the taskbar) is closeWindow. */
export function startSecondWindow(): void {
  if (!isSecondWindow) return;
  if (typeof document !== "undefined") document.title = `vault-chat (window ${windowNo})`;
  void import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) =>
      getCurrentWindow().onCloseRequested(async (e) => {
        // closeWindow destroys the window itself, once its tiles are dropped.
        e.preventDefault();
        await closeWindow(windowNo);
      }),
    )
    .catch(() => {});
}
