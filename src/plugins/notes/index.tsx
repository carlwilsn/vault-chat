// The Notes plugin (Stage 2, the first part of the app to become a plugin; src/appPlugins.ts NOTES_PLUGIN_ID): the
// Notes panel, mounted through the plugin host (src/mountHost.ts) with the widget contract mount(el, api). The app
// mounts it in its overlays (src/App.tsx, AppPluginMount); the supervisor's records turn it off or on there
// (a stopped plugin is unmounted: its React root and every listener of the panel go).
//
// Unchanged for Carl: the panel itself (NotesPanel.tsx), its data (.vault-chat/notes.jsonl through src/notes.ts and
// the store, and the box's sync of it), its Esc and its opening from the titlebar.
import { createRoot } from "react-dom/client";
import type { PluginApi } from "../../mountHost";
import { NotesPanel } from "./NotesPanel";

export function mount(el: HTMLElement, api: PluginApi): () => void {
  // A render error the panel does not catch is the plugin's failure (its error card), not the app's.
  const root = createRoot(el, { onUncaughtError: (e) => api.error(e) });
  root.render(<NotesPanel host={api.host} />);
  // The host may run this while the app's React is committing; a root is unmounted outside of that.
  return () => queueMicrotask(() => root.unmount());
}
