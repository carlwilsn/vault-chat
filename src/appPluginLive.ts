// App plugins load live (corrected model, point 4: change by asking, not releasing). The app's own plugins
// (src/appPlugins.ts: the chat list, the vault picker, the file tree, the title bar, the composer, the chat pane, Settings, voice, Notes...) ship inside
// the build, and that built-in copy stays the fallback. A live copy of one is a code file in the vault,
//   <vault>/.vault-chat/app-plugins/<name>.js          the live copy (name: the id without "app/": filetree.js)
//   <vault>/.vault-chat/app-plugins/<name>.draft.js    a draft of it, tried first
// built from src/plugins/<name>/ by `node scripts/app-plugin-live.mjs <name> --vault <vault> [--draft]` (no app build,
// no release). The app reads the folder at startup and every few seconds after (src/appPluginLiveHost.ts), like the vault
// plugins' folder, so an edit synced from the box is on screen in seconds. Which copy runs: the draft, else the live
// copy, else the built-in one; a copy that is missing, turned off (its id, the file's vault path, has a plugin.desired
// "stopped" record: the Plugins tool) or fails (it does not load, its mount throws, it throws later) is passed over for
// the next one, and a failure is written next to it as <file>.error.txt for the agent. Keep a draft: --keep (it becomes
// the live copy); discard it: --discard; back to the built-in copy: --remove.
//
// A live copy is the plugin's folder bundled on its own. What it shares with the running app (one store, one React) is
// not in the bundle: every app module outside the plugin's folder, its state files (model / draft / view: the fallback
// and the rest of the app read the same state) and React are taken from the app at load (src/appPluginShared.ts), by the
// names its header line lists; an app that lacks one is a failed load (the built-in copy runs). Everything else in the
// folder (its components, its offers) is the live copy's own: that is what an edit changes. Styling is the app's
// stylesheet: a Tailwind class the app's build never saw has no style yet.
//
// Shared by the app, the box and the builder script: no imports.

export const APP_PLUGIN_LIVE_DIR = ".vault-chat/app-plugins";
export const APP_PLUGIN_LIVE_MAX_BYTES = 4 * 1024 * 1024;

/** The app plugins that can run a live copy (their code is under src/plugins/<name>/, with an index module). */
export const LIVE_APP_PLUGINS: readonly string[] = ["app/notes", "app/chats", "app/composer", "app/chat-rows", "app/vaults", "app/filetree", "app/titlebar", "app/chat", "app/settings", "app/voice", "app/context"];

export type LiveCopyKind = "draft" | "live";

/** The plugin's folder under src/plugins (its id without "app/"), or null when it has no live copy. */
export function appPluginFolder(id: string): string | null {
  return LIVE_APP_PLUGINS.includes(id) ? id.slice("app/".length) : null;
}

/** The copy's file name in the folder: filetree.js, filetree.draft.js. */
export const liveCopyFile = (folder: string, kind: LiveCopyKind): string => `${folder}${kind === "draft" ? ".draft" : ""}.js`;

/** The copy's id (its vault path): what the supervisor's records and the Plugins tool name. */
export const liveCopyId = (folder: string, kind: LiveCopyKind): string => `${APP_PLUGIN_LIVE_DIR}/${liveCopyFile(folder, kind)}`;

/** Which app plugin's copy a file name in the folder is, or null (an error report, anything else). */
export function liveCopyOf(file: string): { plugin: string; folder: string; kind: LiveCopyKind } | null {
  const m = /^([a-z][a-z0-9-]*)(\.draft)?\.js$/.exec(String(file ?? ""));
  if (!m || !appPluginFolder(`app/${m[1]}`)) return null;
  return { plugin: `app/${m[1]}`, folder: m[1]!, kind: m[2] ? "draft" : "live" };
}

/** Which app plugin's copy a vault path (an id) names, or null. */
export function liveCopyAt(id: string): { plugin: string; folder: string; kind: LiveCopyKind } | null {
  const w = String(id ?? "").replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
  return w.startsWith(`${APP_PLUGIN_LIVE_DIR}/`) ? liveCopyOf(w.slice(APP_PLUGIN_LIVE_DIR.length + 1)) : null;
}

/** Where a copy's failure is written for the agent. */
export const liveErrorFile = (file: string): string => `${file}.error.txt`;

/** The first line of a live copy: what it is and what it takes from the app. */
export const LIVE_HEADER = "// @vc-app-plugin ";
export type LiveHeader = { plugin: string; shared: string[]; built?: string };

export function liveHeaderLine(h: LiveHeader): string {
  return LIVE_HEADER + JSON.stringify(h);
}

/** The copy's header line, or null when it has none (not a built live copy). */
export function parseLiveHeader(code: string): LiveHeader | null {
  const first = String(code ?? "").split("\n", 1)[0]!;
  if (!first.startsWith(LIVE_HEADER)) return null;
  try {
    const h = JSON.parse(first.slice(LIVE_HEADER.length));
    if (typeof h?.plugin !== "string" || !Array.isArray(h.shared) || !h.shared.every((s: unknown) => typeof s === "string")) return null;
    return { plugin: h.plugin, shared: h.shared, ...(typeof h.built === "string" ? { built: h.built } : {}) };
  } catch {
    return null;
  }
}

/** Files in a plugin's folder that hold its state: shared with the app, never bundled into a live copy. */
export const LIVE_STATE_FILES: readonly string[] = ["model", "draft", "view"];
/** Packages a live copy takes from the app (one React for the app and its plugins). Other packages are bundled. */
export const LIVE_SHARED_PACKAGES: readonly string[] = ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"];

/** The global the app puts the shared modules on before it loads a live copy (by the names in its header). */
export const LIVE_SHARED_GLOBAL = "__vcAppShared";
