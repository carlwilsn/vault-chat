import { useEffect } from "react";
import { FullscreenChat } from "./FullscreenChat";
import { useStore } from "./store";
import { applyHljsTheme } from "./hljsTheme";
import { useGlobalAnchorClickHandler } from "./linkNav";
import { dispatchChatAction } from "./sync";

/**
 * The chat popout window: the fullscreen chat itself (FullscreenChat.tsx), with
 * its window controls acting on this window. The chats list, the agent and
 * voice are the main window's (sync.ts relays them).
 */
export function ChatWindow() {
  const theme = useStore((s) => s.theme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    applyHljsTheme(theme);
  }, [theme]);

  useGlobalAnchorClickHandler();

  // The fullscreen chat's shortcuts (App.tsx has the main window's): Ctrl+B
  // the sidebar, Ctrl+T a new chat, Ctrl+D voice. Ctrl+Shift+F has nothing to
  // leave here, and the webview's own Ctrl+F/G/R/P/S/F5 stay off.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (e.key === "F5") {
        e.preventDefault();
        return;
      }
      if (!mod) return;
      if (k === "f" || k === "g" || k === "r" || k === "p" || k === "s") {
        e.preventDefault();
        return;
      }
      if (e.altKey) return;
      if (k === "b" && !e.shiftKey) {
        e.preventDefault();
        if (!e.repeat) useStore.getState().toggleChatSidebar();
      } else if (k === "t" && !e.shiftKey) {
        e.preventDefault();
        if (e.repeat || !useStore.getState().vaultPath) return;
        useStore.getState().newConversation();
        setTimeout(focusComposer, 0);
      } else if (k === "d" && !e.shiftKey) {
        e.preventDefault();
        if (!e.repeat) dispatchChatAction({ kind: "toggleVoice" });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return <FullscreenChat onFocusComposer={focusComposer} />;
}

// Composer focus is owned by ChatPane (the same event App.tsx sends).
function focusComposer() {
  window.dispatchEvent(new CustomEvent("vc-focus-composer"));
}
