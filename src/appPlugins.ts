// The app's own parts that are plugins (Stage 2 of the plugin refactor: a part moves when it is touched). Each runs
// through the in-process mount host (src/mountHost.ts, mountPlugin with a module instead of a page) and follows the
// supervisor's records like any vault page (src/pluginSupervisor.ts): a `plugin.desired` record for its id turns it off
// or on in every view. Only what they are is here (shared by the app, the box's Plugins tool and the catalog: no
// imports); the code is under src/plugins/<name>/ and the app mounts it (src/PluginMount.tsx AppPluginMount).
//
// Id: "app/<name>". A vault page's id is its path and always ends in .html, so the two never meet.

export type AppPluginInfo = {
  /** The plugin's id (the supervisor's records name it). */
  id: string;
  /** What Carl calls it. */
  name: string;
  /** Where it mounts: a panel of the app's window. */
  mount: "panel";
  description: string;
  /** Words that name it (lower case), for the agent's Plugins tool ("disable notes"). */
  words: readonly string[];
};

export const NOTES_PLUGIN_ID = "app/notes";

/** The Notes panel (src/plugins/notes). */
export const NOTES_PLUGIN: AppPluginInfo = {
  id: NOTES_PLUGIN_ID,
  name: "Notes",
  mount: "panel",
  description: "The Notes panel: the notes in .vault-chat/notes.jsonl, to review, resolve, open at their source or discuss in a chat.",
  words: ["notes", "notes panel", "notes-panel", "notespanel"],
};

export const APP_PLUGINS: readonly AppPluginInfo[] = [NOTES_PLUGIN];

/** The app plugin a word names (its id, its name or one of its words), or null. */
export function appPluginNamed(word: string): AppPluginInfo | null {
  const w = String(word ?? "").trim().toLowerCase().replace(/\\/g, "/");
  if (!w) return null;
  return APP_PLUGINS.find((p) => p.id === w || p.name.toLowerCase() === w || p.words.includes(w)) ?? null;
}
