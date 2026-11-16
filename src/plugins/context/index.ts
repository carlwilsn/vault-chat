// The shared context as a plugin the agent reaches (src/appPlugins.ts CONTEXT_PLUGIN, app/context): mounted with the
// app, it draws nothing and offers the shared context (src/sharedContext.ts) through api.offer: what Carl has selected
// (a file's text and lines, a chat message, a note, other text), what he hovers, the plugin he is in and the open file,
// as state; a `changed` event (the keys that changed) as it moves. Its subscription is what runs the app's publisher
// (src/contextSource.ts, throttled, off the typing path); turned off, the agent cannot read it, and a plugin that
// listens through api.context still runs the publisher for itself.
import type { PluginApi } from "../../mountHost";
import type { Offers } from "../../pluginOffers";
import type { ContextApi } from "../../sharedContext";

/** The plugin's offers over a context api (exported for tests). */
export function contextOffers(ctx: Pick<ContextApi, "get">): Offers {
  return {
    state: {
      selection: { description: "What Carl has selected now: {kind: file, path, text, lineStart?, lineEnd?} | {kind: message, messageId, chatId, text} | {kind: note, noteId, text} | {kind: text, text, path?, plugin?} | {kind: files, paths} (selected in the file tree); null: nothing.", read: () => ctx.get().selection },
      hover: { description: "The item under his pointer: a file, chat message, note, chat or plugin; null: none known.", read: () => ctx.get().hover },
      focus: { description: "The plugin he last clicked or focused in ({plugin: id}), or the app's own part ({plugin: null, area}).", read: () => ctx.get().focus },
      file: { description: "The file open in the viewer.", read: () => ctx.get().file },
      at: { description: "When the context last changed (ms since epoch).", read: () => ctx.get().at },
    },
    events: {
      changed: { description: "The selection, hover, focus or open file changed ({changed: [keys]}); throttled." },
    },
  };
}

export function mount(_el: HTMLElement, api: PluginApi): void {
  const offers = api.offer(contextOffers(api.context));
  api.context.on((_c, changed) => offers.emit("changed", { changed }));
}
