// Minimize / maximize-restore / close (Windows and Linux). Core, not a plugin: the
// title bar plugin (src/plugins/titlebar) draws them, its built-in fallback (src/Titlebar.tsx) draws them when the
// plugin is off or failing, and fullscreen chat draws them top-right, so the window can always be closed.
import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, Copy, X } from "lucide-react";

/** onBar: drawn on the (blue) title bar, in its colours; elsewhere (fullscreen chat, the chat's own bar) the theme's. */
export function WindowControls({ className = "", onBar = false }: { className?: string; onBar?: boolean }) {
  const win = getCurrentWindow();
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let live = true;
    (async () => {
      try {
        const m = await win.isMaximized();
        if (live) setMaximized(m);
        const off = await win.onResized(async () => {
          const now = await win.isMaximized().catch(() => false);
          if (live) setMaximized(now);
        });
        if (live) unlisten = off;
        else off();
      } catch {
        /* no window here (a test, a browser preview): the buttons still work as far as they can */
      }
    })();
    return () => {
      live = false;
      if (unlisten) unlisten();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const tone = onBar ? "hover:bg-titlebar-hover text-titlebar-muted" : "hover:bg-accent/60 text-muted-foreground";
  return (
    <div className={`flex items-center ${className}`} data-el="window-controls">
      <button data-offer="app/titlebar.minimize"
        onClick={() => void win.minimize()}
        data-el="window-minimize"
        className={`h-9 w-11 flex items-center justify-center ${tone}`}
        title="Minimize"
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
      <button data-offer="app/titlebar.toggleMaximize"
        onClick={() => void win.toggleMaximize()}
        data-el="window-maximize"
        className={`h-9 w-11 flex items-center justify-center ${tone}`}
        title={maximized ? "Restore" : "Maximize"}
      >
        {maximized ? <Copy className="h-3 w-3" /> : <Square className="h-3 w-3" />}
      </button>
      <button data-offer="app/titlebar.closeWindow"
        onClick={() => void win.close()}
        data-el="window-close"
        className={`h-9 w-11 flex items-center justify-center hover:bg-destructive hover:text-destructive-foreground ${onBar ? "text-titlebar-muted" : "text-muted-foreground"}`}
        title="Close"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
