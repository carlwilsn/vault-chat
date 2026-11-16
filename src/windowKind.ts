// Which window this webview is: the main window, or the chat popout
// (`index.html?view=chat`, opened by sync.ts's openChatPopout). A module of its
// own so the store and projects can ask without importing sync.ts. Guarded:
// tests and the server import the store with no window or location.
export const isPopout = (() => {
  try {
    const search = (globalThis as { location?: { search?: string } }).location?.search;
    return typeof search === "string" && new URLSearchParams(search).get("view") === "chat";
  } catch {
    return false;
  }
})();

// The agent's Drive window (`index.html?view=drive`, opened hidden by src/driveHost.ts): a sandboxed copy of the app the
// agent's scripted steps run in, so Carl's own window is never touched. src/driveGuard.ts makes it read-only.
export const isDriveWindow = (() => {
  try {
    const search = (globalThis as { location?: { search?: string } }).location?.search;
    return typeof search === "string" && new URLSearchParams(search).get("view") === "drive";
  } catch {
    return false;
  }
})();
