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

export const CHATS_PLUGIN_ID = "app/chats";

/** The chat list (src/plugins/chats): the overlay and fullscreen chat's sidebar. Off or failed, a minimal built-in list stands in. */
export const CHATS_PLUGIN: AppPluginInfo = {
  id: CHATS_PLUGIN_ID,
  name: "Chats",
  mount: "panel",
  description: "The chat list: Main and the projects with their chats, to open, start, rename, delete or restore chats and expand places (the overlay and fullscreen chat's sidebar).",
  words: ["chats", "chat list", "chat-list", "chatlist", "chats list", "chats panel", "chats-panel", "chatspanel", "chat sidebar", "chats sidebar"],
};

export const COMPOSER_PLUGIN_ID = "app/composer";

/** The chat composer (src/plugins/composer): the text box, attachments, Send / Stop and the model / effort labels. Off or failed, a minimal built-in composer stands in. */
export const COMPOSER_PLUGIN: AppPluginInfo = {
  id: COMPOSER_PLUGIN_ID,
  name: "Composer",
  mount: "panel",
  description: "The chat composer: the text box messages are typed in, with its attached files and pictures, Send / Stop and the model and effort labels under it.",
  words: ["composer", "chat composer", "the composer", "composer box", "chat input", "chat box", "message box", "text box", "prompt box"],
};


export const CHAT_ROWS_PLUGIN_ID = "app/chat-rows";

/** The chat transcript's rows (src/plugins/chat-rows): which renderer draws each kind of row, and the rows on screen. */
export const CHAT_ROWS_PLUGIN: AppPluginInfo = {
  id: CHAT_ROWS_PLUGIN_ID,
  name: "Chat rows",
  mount: "panel",
  description: "The chat transcript's rows: the renderer of each kind of row (messages, tool calls, notices, plans, inline pages; a vault plugin can draw one kind its own way), the rows on screen, scrolling to a row and opening or closing tool rows. Off: the agent cannot reach it; the rows still draw.",
  words: ["chat rows", "chat-rows", "chatrows", "transcript", "chat transcript", "rows", "row renderers", "tool rows"],
};

export const APP_PLUGINS: readonly AppPluginInfo[] = [NOTES_PLUGIN, CHATS_PLUGIN, COMPOSER_PLUGIN, CHAT_ROWS_PLUGIN];

/** The app plugin a word names (its id, its name or one of its words), or null. */
export function appPluginNamed(word: string): AppPluginInfo | null {
  const w = String(word ?? "").trim().toLowerCase().replace(/\\/g, "/");
  if (!w) return null;
  return APP_PLUGINS.find((p) => p.id === w || p.name.toLowerCase() === w || p.words.includes(w)) ?? null;
}
