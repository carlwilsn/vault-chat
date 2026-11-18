// The fullscreen chat's frame (part `frame` of app/chat, src/plugins/chat), like Claude Code desktop / Codex: the chats
// in a collapsible left sidebar (Ctrl+B), the chat beside it with its own top bar (sidebar toggle, the chat's name and
// ⋯, the window controls). No title bar, no viewer. Moved here from src/FullscreenChat.tsx unchanged: the main window
// shows it on Ctrl+Shift+F (src/App.tsx), the chat popout window is always it (src/ChatWindow.tsx); src/FullscreenChat.tsx
// mounts it through the plugin host and draws this same frame in the app's tree while the records are unknown or the
// plugin is off. The sidebar is app/chats, the bar's title app/chat's `bar`, the pane src/ChatPane.tsx; the window
// controls are core (src/WindowControls.tsx).
import { PanelLeftOpen } from "lucide-react";
import { ChatPane } from "../../ChatPane";
import { ChatsSidebar } from "../../ChatsPanel";
import { ChatBarSlot } from "../../ChatHeader";
import { WindowControls } from "../../WindowControls";
import { useStore } from "../../store";
import { isPopout } from "../../windowKind";
import { shortcutHint } from "../../shortcuts";

export function Frame() {
  const chatSidebarOpen = useStore((s) => s.chatSidebarOpen);
  const toggleChatSidebar = useStore((s) => s.toggleChatSidebar);
  return (
    <div className="flex-1 min-h-0 flex relative">
      {chatSidebarOpen && <ChatsSidebar />}
      <div className="flex-1 min-w-0 flex flex-col bg-card">
        {/* The chat's own top bar, in the chat's colour: sidebar toggle (when
            it's hidden), the chat's name and ⋯ menu (the chat pane plugin, app/chat), the window controls (this window's). */}
        <div
          data-tauri-drag-region
          className="h-9 shrink-0 flex items-center relative select-none"
          title={isPopout ? "Drag to move window" : `Drag to move window — ${shortcutHint("view.fullscreen")} to exit fullscreen chat`}
        >
          <div className="px-2 flex items-center relative z-10">
            {!chatSidebarOpen && (
              <button
                onClick={toggleChatSidebar}
                data-el="chats-sidebar-open"
                className="h-7 w-7 flex items-center justify-center rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground"
                title={`Show chats (${shortcutHint("view.files")})`}
              >
                <PanelLeftOpen className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div data-tauri-drag-region className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <ChatBarSlot />
          </div>
          <div data-tauri-drag-region className="flex-1 h-full" />
          <WindowControls className="relative z-10" />
        </div>
        <div className="flex-1 min-h-0">
          <ChatPane />
        </div>
      </div>
    </div>
  );
}
