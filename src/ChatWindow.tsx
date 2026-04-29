import { getCurrentWindow } from "@tauri-apps/api/window";
import { X, Minus, Square, Settings } from "lucide-react";
import { useEffect, useState } from "react";
import { ChatPane } from "./ChatPane";
import { SettingsPane } from "./SettingsPane";
import { useStore } from "./store";
import { applyHljsTheme } from "./main";

export function ChatWindow() {
  const win = getCurrentWindow();
  const [maximized, setMaximized] = useState(false);
  const theme = useStore((s) => s.theme);
  const showSettings = useStore((s) => s.showSettings);
  const setShowSettings = useStore((s) => s.setShowSettings);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    applyHljsTheme(theme);
  }, [theme]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      setMaximized(await win.isMaximized());
      unlisten = await win.onResized(async () => {
        setMaximized(await win.isMaximized());
      });
    })();
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  return (
    <div className="h-full w-full flex flex-col bg-background">
      <div
        data-tauri-drag-region
        className="h-8 flex items-center bg-card border-b border-border select-none shrink-0"
      >
        <div
          data-tauri-drag-region
          className="flex-1 h-full flex items-center px-3 text-[11px] text-muted-foreground"
        >
          Chat
        </div>
        <button
          onClick={() => setShowSettings(!showSettings)}
          className="h-8 w-9 flex items-center justify-center hover:bg-accent/60 text-muted-foreground"
          title="Settings"
        >
          <Settings className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => win.minimize()}
          className="h-8 w-10 flex items-center justify-center hover:bg-accent/60 text-muted-foreground"
          title="Minimize"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => win.toggleMaximize()}
          className="h-8 w-10 flex items-center justify-center hover:bg-accent/60 text-muted-foreground"
          title={maximized ? "Restore" : "Maximize"}
        >
          <Square className="h-3 w-3" />
        </button>
        <button
          onClick={() => win.close()}
          className="h-8 w-10 flex items-center justify-center hover:bg-destructive hover:text-destructive-foreground text-muted-foreground"
          title="Close"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex-1 min-h-0">
        {showSettings ? <SettingsPane /> : <ChatPane />}
      </div>
    </div>
  );
}
