// The shared context as a plugin the agent reaches (src/appPlugins.ts CONTEXT_PLUGIN, app/context): mounted with the
// app, it draws nothing and offers the shared context (src/sharedContext.ts) through api.offer: what Carl has selected
// (a file's text and lines, a chat message, a note, other text), what he hovers, the plugin he is in and the open file,
// as state; a `changed` event (the keys that changed) as it moves. Its subscription is what runs the app's publisher
// (src/contextSource.ts, throttled, off the typing path); turned off, the agent cannot read it, and a plugin that
// listens through api.context still runs the publisher for itself.
import type { PluginApi } from "../../mountHost";
import type { Offers } from "../../pluginOffers";
import type { ContextApi } from "../../sharedContext";

const css = (v: unknown) => String(v ?? "").replace(/["\\]/g, "\\$&");

/** The plugin's offers over a context api (exported for tests). */
export function contextOffers(ctx: Pick<ContextApi, "get"> & Partial<Pick<ContextApi, "on">>): Offers {
  return {
    watch: (fn) => (ctx.on ? ctx.on(() => fn()) : () => {}),
    state: {
      selection: { description: "What Carl has selected now: {kind: file, path, text, lineStart?, lineEnd?} | {kind: message, messageId, chatId, text} | {kind: note, noteId, text} | {kind: text, text, path?, plugin?} | {kind: files, paths} (selected in the file tree); null: nothing.", read: () => ctx.get().selection },
      hover: { description: "The item under his pointer: a file, chat message, note, chat or plugin; null: none known.", read: () => ctx.get().hover },
      focus: { description: "The plugin he last clicked or focused in ({plugin: id}), or the app's own part ({plugin: null, area}).", read: () => ctx.get().focus },
      file: { description: "The file open in the viewer.", read: () => ctx.get().file },
      at: { description: "When the context last changed (ms since epoch).", read: () => ctx.get().at },
    },
    actions: {
      hover: {
        description: "Point at an item as Carl's pointer does (the app's hover, what this part's hover reads and other parts follow): a chat message (messageId), a note (noteId), a file in the tree (path, vault-relative or as the tree names it), a chat in the list (chatId). The OS pointer itself stays where Carl left it.",
        args: { type: "object", properties: { messageId: { type: "string" }, noteId: { type: "string" }, path: { type: "string" }, chatId: { type: "string" } }, additionalProperties: false },
        run: (a) => {
          const sel = a.messageId ? `[data-message-id="${css(a.messageId)}"]` : a.noteId ? `[data-note-id="${css(a.noteId)}"]` : a.chatId ? `[data-chat="${css(a.chatId)}"]` : a.path ? `[data-tree-path$="${css(a.path)}"], [data-file$="${css(a.path)}"]` : "";
          if (!sel) throw new Error("say what to point at: messageId, noteId, path or chatId");
          const el = typeof document === "undefined" ? null : document.querySelector(sel);
          if (!el) throw new Error("that item is not on screen now");
          el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
          return { pointedAt: a };
        },
      },
    },
    events: {
      changed: { description: "The selection, hover, focus or open file changed ({changed: [keys]}); throttled.", before: false },
    },
  };
}

export function mount(_el: HTMLElement, api: PluginApi): void {
  const offers = api.offer(contextOffers(api.context));
  api.context.on((_c, changed) => offers.emit("changed", { changed }));
}
