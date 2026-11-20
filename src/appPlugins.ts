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
  /** Where it mounts: a panel of the app's window, or a whole surface (the phone app). */
  mount: "panel" | "surface";
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

export const VAULTS_PLUGIN_ID = "app/vaults";

/** The title bar's vault picker (src/plugins/vaults): the vault folders, to open one, make, rename or delete a vault. Off or failed, a minimal built-in picker stands in. */
export const VAULTS_PLUGIN: AppPluginInfo = {
  id: VAULTS_PLUGIN_ID,
  name: "Vault picker",
  mount: "panel",
  description: "The title bar's vault picker: the vault folders (vaults only; Main and projects are in the chat list), to open one as the workspace, make a new vault, rename or delete one (recoverably), or make one a project.",
  words: ["vaults", "vault picker", "vault-picker", "vaultpicker", "vault menu", "vault dropdown", "folder picker", "vault switcher"],
};

export const FILETREE_PLUGIN_ID = "app/filetree";

/** The left panel's file tree (src/plugins/filetree): the open vault's files and folders. Off or failed, a minimal built-in tree stands in. */
export const FILETREE_PLUGIN: AppPluginInfo = {
  id: FILETREE_PLUGIN_ID,
  name: "File tree",
  mount: "panel",
  description: "The left panel's file tree: the open vault's files and folders, to open, reveal, expand or collapse, select, filter, make, rename, move, hide (a path, or every file or folder of a name such as assets) and delete them.",
  words: ["file tree", "filetree", "file-tree", "files", "tree", "left panel", "file panel", "files panel"],
};

export const TITLEBAR_PLUGIN_ID = "app/titlebar";

/** The title bar (src/plugins/titlebar): its buttons, indicators and plugins' items. Off or failed, a minimal built-in bar stands in (the window controls always work). */
export const TITLEBAR_PLUGIN: AppPluginInfo = {
  id: TITLEBAR_PLUGIN_ID,
  name: "Title bar",
  mount: "panel",
  description: "The title bar across the top of the window: the panel toggles, the vault picker, refresh and Hidden files, Notes, items vault plugins put there, the sync chip, background tasks, the chat toggle and pop-out, the terminal, Settings and the window controls.",
  words: ["title bar", "titlebar", "title-bar", "top bar", "topbar", "toolbar", "tool bar", "header bar", "window bar", "menu bar"],
};

export const VIEWER_PLUGIN_ID = "app/viewer";

/** The viewer (src/plugins/viewer): which viewer draws each type of file, the files open and where they are. Off: the agent cannot reach it; files still draw. */
export const VIEWER_PLUGIN: AppPluginInfo = {
  id: VIEWER_PLUGIN_ID,
  name: "Viewer",
  mount: "panel",
  description:
    "The viewer: the files open in its panes (type, the viewer drawing each, view or edit mode, where each is scrolled), the viewer of each type of file (PDF, markdown, notebook, TeX, HTML, image, video, code; a vault plugin can draw a type its own way) and which types Ctrl+E edits; open a file, scroll to a page, line or heading, find text, zoom a PDF or image, switch mode, choose, disable or enable a viewer; each pane's header (the file's path, \"Changed by the agent\" with Reload / Keep mine, the view / edit toggle, Close pane). Off: the agent cannot reach it; files still draw.",
  words: ["viewer", "the viewer", "file viewer", "viewers", "viewer pane", "pdf viewer", "markdown viewer", "document viewer"],
};

export const CHAT_PLUGIN_ID = "app/chat";

/** The chat pane's shell (src/plugins/chat): its header (the chat's name, the ⋯ menu with Memory and plugins' entries) and the pane's scroll. Off or failed, a plain header with Memory stands in. */
export const CHAT_PLUGIN: AppPluginInfo = {
  id: CHAT_PLUGIN_ID,
  name: "Chat pane",
  mount: "panel",
  description:
    "The chat pane: its header (the chat's name and project, the cost, the ⋯ menu with Memory, which opens Main's memory or the chat's project memory, and entries vault plugins put there) and the pane around the transcript (which chat, docked or full screen, scrolled to the bottom or up, older messages shown, the way back to a worker's parent), and fullscreen chat's and the popout's frame (the chats sidebar, the top bar; enter or leave fullscreen, open or close the sidebar).",
  words: ["chat", "chat pane", "chat-pane", "chatpane", "the chat", "chat header", "chat menu", "chat's menu", "chat window", "conversation pane"],
};

export const SETTINGS_PLUGIN_ID = "app/settings";

/** The Settings pane (src/plugins/settings). Off or failed, a plain pane stands in (back, Keyboard shortcuts). */
export const SETTINGS_PLUGIN: AppPluginInfo = {
  id: SETTINGS_PLUGIN_ID,
  name: "Settings",
  mount: "panel",
  description:
    "The Settings pane: the Claude sign-in, keys, the vault-chat folder, the box (connect, sync, the phone link), appearance and keyboard shortcuts; open or close it, go to a section, read its sections and the app's settings.",
  words: ["settings", "settings pane", "settings-pane", "settingspane", "preferences", "settings page", "options"],
};

export const VOICE_PLUGIN_ID = "app/voice";

/** Voice (src/plugins/voice): the mic, the waves, Mute and the voice text box. Off or failed, a plain mic and Mute stand in. */
export const VOICE_PLUGIN: AppPluginInfo = {
  id: VOICE_PLUGIN_ID,
  name: "Voice",
  mount: "panel",
  description:
    "Voice: the title bar's mic and waves, the composer's Mute and the box to type to the voice agent; the call's state (on, connecting, listening, speaking, muted, its error), start or end a call, mute, open the text box, say something to the voice agent in text.",
  words: ["voice", "voice controls", "voice-controls", "mic", "microphone", "voice mode", "voice call", "call", "mute", "voice text"],
};

export const CONTEXT_PLUGIN_ID = "app/context";

/** The shared context (src/plugins/context): what Carl has selected, hovers, the plugin he is in and the open file, for the agent and other plugins. Off: the agent cannot read it. */
export const CONTEXT_PLUGIN: AppPluginInfo = {
  id: CONTEXT_PLUGIN_ID,
  name: "Context",
  mount: "panel",
  description: "The shared context: what Carl has selected (a file's text and lines, a chat message, a note), the item under his pointer, the plugin he is in and the open file, readable and followed by the agent and by other plugins. Off: the agent cannot read it.",
  words: ["context", "shared context", "context plugin", "selection context", "app context"],
};

export const ASK_PLUGIN_ID = "app/ask";

/** The Ctrl+K / Ctrl+L box (src/plugins/ask): one input to the agent from a file, with the selection as context. Off: still drawn, the agent cannot reach it; failing, a plain box says so. */
export const ASK_PLUGIN: AppPluginInfo = {
  id: ASK_PLUGIN_ID,
  name: "Ctrl+K box",
  mount: "panel",
  description:
    "The Ctrl+K / Ctrl+L box: the input that opens over a file (Ctrl+K in an editor, Ctrl+L or a marquee in a viewer) to ask the agent about the selection or have it propose an edit; read the open boxes (what is typed, the answer, the proposed edit), type, send, accept, close, send to the chat or save as a note.",
  words: ["ctrl+k", "ctrl k", "ctrl-k", "ctrl+l", "ctrl l", "ctrl-l", "ask", "ask box", "inline ask", "inline edit", "edit box", "ctrl+k box", "ctrl+k popup", "ask popup", "inline prompt", "edit prompt"],
};

export const ELEVENLABS_VOICE_PLUGIN_ID = "app/elevenlabs-voice";

/** ElevenLabs voice (src/plugins/elevenlabs-voice): the core voice is local (Kokoro, af_heart); on, with an ElevenLabs key
 *  in Keys, calls speak and hear with ElevenLabs (server/voiceProvider.ts), and its panel picks the voice. */
export const ELEVENLABS_VOICE_PLUGIN: AppPluginInfo = {
  id: ELEVENLABS_VOICE_PLUGIN_ID,
  name: "ElevenLabs voice",
  mount: "panel",
  description:
    "ElevenLabs voice: on, with an ElevenLabs key in Keys, calls speak and hear with ElevenLabs instead of the free local voice (Kokoro, af_heart); its panel (the chat's ⋯ menu, ElevenLabs voice) picks the voice from the account or the ElevenLabs voice library, plays a test line and shows the box's voice health. Off: calls use the local voice.",
  words: ["elevenlabs", "elevenlabs voice", "elevenlabs-voice", "eleven labs", "eleven labs voice", "voice picker", "voice library", "elevenlabs voices"],
};

export const APP_PLUGINS: readonly AppPluginInfo[] = [NOTES_PLUGIN, CHATS_PLUGIN, COMPOSER_PLUGIN, CHAT_ROWS_PLUGIN, VAULTS_PLUGIN, FILETREE_PLUGIN, TITLEBAR_PLUGIN, VIEWER_PLUGIN, CHAT_PLUGIN, SETTINGS_PLUGIN, VOICE_PLUGIN, CONTEXT_PLUGIN, ASK_PLUGIN, ELEVENLABS_VOICE_PLUGIN];

// The surfaces (Track 2: the phone is a host, an app Carl can switch off). A `plugin.desired` record for it
// turns the whole app off or on live, no release: off, the box serves the one "turned off" line where its app would
// open (/phone), pushes to the phone and sends to it (Show) stop and say so, and an app
// already open goes to that line (server/surfaces.ts).

export const PHONE_SURFACE_ID = "app/phone";

/** The phone app (phone/): chats, alerts and pushes on the phone, and the vault plugins it hosts. */
export const PHONE_SURFACE: AppPluginInfo = {
  id: PHONE_SURFACE_ID,
  name: "Phone app",
  mount: "surface",
  description: "The phone app: chats, alerts, Show on the phone and phone pushes, and the vault plugins it hosts. Off: /phone shows that it is turned off, no push or Show reaches the phone.",
  words: ["phone", "phone app", "the phone", "the phone app", "iphone", "mobile", "mobile app", "phone surface"],
};

export const SURFACE_PLUGINS: readonly AppPluginInfo[] = [PHONE_SURFACE];

/** The app plugin or surface a word names (its id, its name or one of its words), or null. */
export function appPluginNamed(word: string): AppPluginInfo | null {
  const w = String(word ?? "").trim().toLowerCase().replace(/\\/g, "/");
  if (!w) return null;
  return [...APP_PLUGINS, ...SURFACE_PLUGINS].find((p) => p.id === w || p.name.toLowerCase() === w || p.words.includes(w)) ?? null;
}
