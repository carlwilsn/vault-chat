import type { ReactNode } from "react";
import { PanelLeftOpen } from "lucide-react";
import { ChatPane } from "./ChatPane";
import { ChatsSidebar } from "./ChatsPanel";
import { ChatTitle } from "./ProjectChip";
import { WindowControls } from "./Titlebar";
import { useStore } from "./store";
import { isPopout } from "./windowKind";

/**
 * The fullscreen chat, like Claude Code desktop / Codex: the chats in a
 * collapsible left sidebar (Ctrl+B), the chat beside it with its own top bar
 * (sidebar toggle, the chat's name, the window controls). No titlebar, no
 * viewer. The main window shows it on Ctrl+Shift+F (App.tsx); the chat popout
 * window is always it (ChatWindow.tsx). `children` float over it.
 */
export function FullscreenChat({ onFocusComposer, children }: { onFocusComposer: () => void; children?: ReactNode }) {
  const chatSidebarOpen = useStore((s) => s.chatSidebarOpen);
  const toggleChatSidebar = useStore((s) => s.toggleChatSidebar);
  return (
    <div className="h-full w-full bg-background flex flex-col relative">
      <div className="flex-1 min-h-0 flex relative">
        {chatSidebarOpen && <ChatsSidebar onFocusComposer={onFocusComposer} />}
        <div className="flex-1 min-w-0 flex flex-col bg-card">
          {/* The chat's own top bar, in the chat's colour: sidebar toggle (when
              it's hidden), the chat's name, the window controls (this window's). */}
          <div
            data-tauri-drag-region
            className="h-9 shrink-0 flex items-center relative select-none"
            title={isPopout ? "Drag to move window" : "Drag to move window — Ctrl+Shift+F to exit fullscreen chat"}
          >
            <div className="px-2 flex items-center relative z-10">
              {!chatSidebarOpen && (
                <button
                  onClick={toggleChatSidebar}
                  data-el="chats-sidebar-open"
                  className="h-7 w-7 flex items-center justify-center rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground"
                  title="Show chats (Ctrl+B)"
                >
                  <PanelLeftOpen className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <div data-tauri-drag-region className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <ChatTitle />
            </div>
            <div data-tauri-drag-region className="flex-1 h-full" />
            <WindowControls className="relative z-10" />
          </div>
          <div className="flex-1 min-h-0">
            <ChatPane />
          </div>
        </div>
      </div>
      {children}
    </div>
  );
}
