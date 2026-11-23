// The app's places (where a part mounts: the title bar, the left panel, the chat's composer …) and which app plugin
// (and which part of it) fills each, in order. A fixed table: changing the app is a change to this code, not a record
// or a draft (report 24 piece C). The files that hold the places register each part's built-in module (placeModule);
// src/PluginMount.tsx PlaceMount mounts them.

/** One plugin (one part of it) in one place. */
export type PlaceMountSpec = { plugin: string; part?: string };

const m = (plugin: string, part?: string): PlaceMountSpec => (part ? { plugin, part } : { plugin });

/** What each place mounts, in order. */
export const PLACES: Readonly<Record<string, readonly PlaceMountSpec[]>> = {
  // Every part's offers, headless, in every layout (fullscreen chat, docked, Settings open or not): the agent reaches a
  // part whether or not it is drawn (report 28). Mounted once, with the overlays (src/App.tsx).
  offers: [m("app/titlebar", "offers"), m("app/settings", "offers"), m("app/vaults", "offers"), m("app/filetree", "offers"), m("app/viewer", "offers"), m("app/chats", "offers"), m("app/chat", "offers"), m("app/chat-rows", "offers"), m("app/composer", "offers")],
  titlebar: [m("app/titlebar")],
  "titlebar.vaults": [m("app/vaults")],
  "left.tree": [m("app/filetree")],
  overlay: [m("app/notes"), m("app/context"), m("app/ask"), m("app/elevenlabs-voice")],
  "chats.overlay": [m("app/chats")],
  "chats.sidebar": [m("app/chats", "sidebar")],
  "chat.header": [m("app/chat")],
  "chat.bar": [m("app/chat", "bar")],
  "chat.frame": [m("app/chat", "frame")],
  "chat.transcript": [m("app/chat", "transcript")],
  "chat.composer": [m("app/composer")],
  settings: [m("app/settings")],
  voice: [m("app/voice")],
  "viewer.pane": [m("app/viewer", "pane")],
  "ask.prompt": [m("app/ask", "prompt")],
};

/** The built-in modules by plugin id and part ("app/chat#frame"), each as a thunk (the files that register them may be
 *  mid-import when they do: an import cycle). */
const modules = new Map<string, () => unknown>();
export const moduleKey = (plugin: string, part?: string): string => `${plugin}#${part ?? ""}`;

/** Register a plugin's built-in module (or one part's export) for the places that name it. */
export function placeModule(plugin: { id: string }, module: () => unknown, part?: string): void {
  modules.set(moduleKey(plugin.id, part), module);
}

/** The built-in module of a mount, or undefined when this app has no such part. */
export function placeModuleOf(spec: PlaceMountSpec): unknown {
  return modules.get(moduleKey(spec.plugin, spec.part))?.();
}
