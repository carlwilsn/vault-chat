// Where the chat pane's header is mounted. The header is a plugin (src/plugins/chat, app/chat), mounted through the
// plugin host and the supervisor's records (src/PluginMount.tsx AppPluginMount): docked, as the pane's top row
// (ChatHeaderSlot, src/ChatPane.tsx); in fullscreen chat and the popout, in the window's top bar (ChatBarSlot,
// src/FullscreenChat.tsx). It holds the way to the memory, so it never just disappears:
//  - while the records are not known yet, the header itself is drawn here in the app's own tree (nothing flashes);
//  - turned off, or failing to mount or render, a plain header stands in: the chat's name and a Memory button (the same
//    one entry: Main's memory or the chat's project memory), with one line that says what happened and Turn on / Reload.
import { memo } from "react";
import { BookOpen } from "lucide-react";
import { CHAT_PLUGIN } from "./appPlugins";
import { PlaceMount, type PluginFallbackInfo } from "./PluginMount";
import { placeModule } from "./places";
import { PluginOff } from "./PluginOff";
import { ChatTitle } from "./ProjectChip";
import * as chatPlugin from "./plugins/chat";
import { BarTitle, DockHeader } from "./plugins/chat/Header";
import { openChatMemory } from "./plugins/chat/model";

// The built-in module(s) of the places below (src/places.ts).
placeModule(CHAT_PLUGIN, () => chatPlugin);
placeModule(CHAT_PLUGIN, () => chatPlugin.bar, "bar");

/** The docked chat pane's header row. Memoized: the pane's own redraws (a streaming reply) never reach it. */
export const ChatHeaderSlot = memo(function ChatHeaderSlot() {
  return <PlaceMount place="chat.header" fallback={(f) => (f.pending ? <DockHeader /> : <ChatHeaderFallback info={f} />)} />;
});

/** Fullscreen chat's (and the popout's) title in its top bar. */
export const ChatBarSlot = memo(function ChatBarSlot() {
  return <PlaceMount place="chat.bar" fallback={(f) => (f.pending ? <BarTitle /> : <ChatHeaderFallback info={f} bar />)} />;
});

function MemoryButton() {
  return (
    <button
      type="button"
      data-el="chat-memory-fallback"
      onClick={() => void openChatMemory()}
      className="pointer-events-auto shrink-0 flex items-center gap-1 rounded px-1.5 h-6 text-[11.5px] text-muted-foreground hover:text-foreground hover:bg-accent/60"
      title="Open this chat's memory (Main's, or its project's)"
    >
      <BookOpen className="h-3.5 w-3.5" />
      Memory
    </button>
  );
}

/** The plain header: the chat's name, Memory, and why the plugin's header is not there. */
export function ChatHeaderFallback({ info, bar = false }: { info: PluginFallbackInfo; bar?: boolean }) {
  const why = info.off ? (
    <PluginOff path={CHAT_PLUGIN.id} desired={info.off} className="pointer-events-auto py-0 px-1 min-w-0" />
  ) : (
    <span data-el="chat-header-fallback-error" className="pointer-events-auto flex items-center gap-2 px-1 min-w-0 text-[11.5px] text-muted-foreground">
      <span className="truncate" title={info.error ?? ""}>The chat header stopped.</span>
      <button type="button" data-el="plugin-reload" onClick={info.retry} className="shrink-0 rounded-md border border-border/60 px-2 py-0.5 text-[11.5px] hover:text-foreground">
        Reload
      </button>
    </span>
  );
  if (bar)
    return (
      <div data-el="chat-header-fallback" className="flex items-center gap-1 min-w-0 max-w-[80%]">
        <ChatTitle />
        <MemoryButton />
        {why}
      </div>
    );
  return (
    <div data-el="chat-header-fallback" className="shrink-0 h-8 px-3 flex items-center gap-2">
      <div className="flex-1 min-w-0">
        <ChatTitle />
      </div>
      {why}
      <MemoryButton />
    </div>
  );
}
