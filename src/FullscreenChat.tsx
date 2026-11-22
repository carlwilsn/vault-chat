// The fullscreen chat: the main window on Ctrl+Shift+F (src/App.tsx), and the chat popout window, always
// (src/ChatWindow.tsx). Its frame (the chats sidebar, the chat's top bar with its name, ⋯ and the window controls, the
// chat pane) is a part of the chat pane plugin (src/plugins/chat/Frame.tsx, app/chat, part `frame`), mounted through the
// plugin host and the supervisor's records (src/PluginMount.tsx AppPluginMount). The chat never just disappears:
//  - while the records are not known yet, or app/chat is turned off, the same frame is drawn here in the app's own tree;
//  - failing to mount or render (the built-in copy too), a plain frame stands in: a bar to drag the window with the
//    window controls, one line that says what happened with Reload, and the chat pane.
// `children` float over it (the main window's overlays).
import { memo, type ReactNode } from "react";
import { CHAT_PLUGIN } from "./appPlugins";
import { PlaceMount, type PluginFallbackInfo } from "./PluginMount";
import { placeModule } from "./places";
import * as chatPlugin from "./plugins/chat";
import { Frame } from "./plugins/chat/Frame";
import { ChatPane } from "./ChatPane";
import { WindowControls } from "./WindowControls";

// The built-in module(s) of the places below (src/places.ts).
placeModule(CHAT_PLUGIN, () => chatPlugin.frame, "frame");

export function FullscreenChat({ children }: { children?: ReactNode }) {
  return (
    <div data-perf-view="fullscreen" className="h-full w-full bg-background flex flex-col relative">
      <FrameSlot />
      {children}
    </div>
  );
}

/** The frame, mounted as app/chat's part `frame`. Memoized: the overlays' redraws never reach it. */
const FrameSlot = memo(function FrameSlot() {
  return <PlaceMount place="chat.frame" fallback={(f) => (f.error === null ? <Frame /> : <FrameFallback info={f} />)} />;
});

/** The plain frame: a bar with the window controls, why the frame is not there, and the chat. */
export function FrameFallback({ info }: { info: PluginFallbackInfo }) {
  return (
    <div className="flex-1 min-h-0 flex flex-col bg-card" data-el="chat-frame-fallback">
      <div data-tauri-drag-region className="h-9 shrink-0 flex items-center gap-2 px-3 select-none text-[11.5px] text-muted-foreground">
        <span className="truncate" title={info.error ?? ""}>The chat window stopped; a plain frame until it is back.</span>
        <button type="button" data-el="plugin-reload" onClick={info.retry} className="shrink-0 rounded-md border border-border/60 px-2 py-0.5 text-[11.5px] hover:text-foreground">
          Reload
        </button>
        <div data-tauri-drag-region className="flex-1 h-full" />
        <WindowControls />
      </div>
      <div className="flex-1 min-h-0">
        <ChatPane />
      </div>
    </div>
  );
}
