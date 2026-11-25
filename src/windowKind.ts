// Which window this webview is: the main window, the chat popout (`index.html?view=chat`, opened by sync.ts's
// openChatPopout), or a second app window (`index.html?window=2`, the title bar's New window, src/newWindow.ts: the
// whole app with its own tiles, kept on the box per window). A module of its own so the store and projects can ask
// without importing sync.ts. Guarded: tests and the server import the store with no window or location.
const query = (): URLSearchParams | null => {
  try {
    const search = (globalThis as { location?: { search?: string } }).location?.search;
    return typeof search === "string" ? new URLSearchParams(search) : null;
  } catch {
    return null;
  }
};

export const isPopout = query()?.get("view") === "chat";

/** This window's number: 1 the main window, 2 a New window. */
export const windowNo: number = (() => {
  const n = Number(query()?.get("window"));
  return Number.isInteger(n) && n >= 2 && n <= 9 ? n : 1;
})();

/** A second app window (New window): its own tiles; it leaves sync, voice, the agent's screen requests and the app's
 *  housekeeping to the main window. */
export const isSecondWindow = windowNo > 1;
