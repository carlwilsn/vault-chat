// Where the title bar is mounted. The bar is a plugin (src/plugins/titlebar, app/titlebar), mounted through the plugin
// host and the supervisor's records (src/PluginMount.tsx AppPluginMount). It holds the window controls, so it never
// just disappears:
//  - while the records are not known yet, the bar itself is drawn here in the app's own tree (nothing flashes);
//  - turned off, or failing to mount or render, a minimal built-in bar stands in (TitlebarFallback): the window drags
//    by it, the file panel and chat toggles, the vault picker (its own plugin, with its own fallback), Settings and the
//    window controls (core, src/WindowControls.tsx), with one line that says what happened and Turn on / Reload.
//    Refresh, Hidden files, Notes, the apps launcher, the mic, plugins' items, the sync chip, the terminal and
//    pop-out are the plugin's.
import { PanelLeft, PanelRight, Settings } from "lucide-react";
import { useStore } from "./store";
import { TITLEBAR_PLUGIN } from "./appPlugins";
import { PlaceMount, type PluginFallbackInfo } from "./PluginMount";
import { placeModule } from "./presetApp";
import { PluginOff } from "./PluginOff";
import { VaultPicker } from "./VaultPicker";
import { WindowControls } from "./WindowControls";
import * as titlebarPlugin from "./plugins/titlebar";
import { Bar } from "./plugins/titlebar/Bar";

// The built-in module(s) the preset can mount (src/appPreset.ts; the daily preset puts them in the places below).
placeModule(TITLEBAR_PLUGIN, () => titlebarPlugin);

/** The bar across the top of the main window. */
export function Titlebar() {
  return <PlaceMount place="titlebar" fallback={(f) => (f.pending ? <Bar /> : <TitlebarFallback info={f} />)} />;
}

const BTN = "h-7 w-7 flex items-center justify-center rounded hover:bg-accent/60";

/** The minimal built-in bar: drag, the two panels, the vault picker, Settings, the window controls. */
export function TitlebarFallback({ info }: { info: PluginFallbackInfo }) {
  const leftCollapsed = useStore((s) => s.leftCollapsed);
  const rightCollapsed = useStore((s) => s.rightCollapsed);
  const popoutOpen = useStore((s) => s.popoutOpen);
  const toggleLeft = useStore((s) => s.toggleLeft);
  const toggleRight = useStore((s) => s.toggleRight);
  const showSettings = useStore((s) => s.showSettings);
  const setShowSettings = useStore((s) => s.setShowSettings);
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);
  return (
    <div data-tauri-drag-region data-el="titlebar-fallback" className="h-9 flex items-center bg-card border-b border-border select-none shrink-0 relative">
      <div className="flex items-center gap-1 px-2" style={isMac ? { paddingLeft: 76 } : undefined}>
        <button onClick={toggleLeft} className={`${BTN} ${leftCollapsed ? "text-muted-foreground" : "text-foreground/90"}`} title={`${leftCollapsed ? "Show" : "Hide"} file panel (Ctrl+B)`}>
          <PanelLeft className="h-3.5 w-3.5" />
        </button>
        <VaultPicker />
      </div>
      {info.off ? (
        <PluginOff path={TITLEBAR_PLUGIN.id} desired={info.off} className="py-0 min-w-0" />
      ) : (
        <div data-el="titlebar-fallback-error" className="flex items-center gap-2 px-3 min-w-0 text-[11.5px] text-muted-foreground">
          <span className="truncate" title={info.error ?? ""}>The title bar stopped; a plain one until it is back.</span>
          <button type="button" data-el="plugin-reload" onClick={info.retry} className="shrink-0 rounded-md border border-border/60 px-2 py-0.5 text-[11.5px] hover:text-foreground">
            Reload
          </button>
        </div>
      )}
      <div data-tauri-drag-region className="flex-1 h-full" />
      <div className="flex items-center">
        <button
          onClick={toggleRight}
          disabled={popoutOpen}
          className={`${BTN} mr-1 disabled:opacity-40 disabled:cursor-not-allowed ${rightCollapsed ? "text-muted-foreground" : "text-foreground/90"}`}
          title={popoutOpen ? "Chat is popped out — close the popout window to dock" : `${rightCollapsed ? "Show" : "Hide"} chat panel (Ctrl+Shift+B)`}
        >
          <PanelRight className="h-3.5 w-3.5" />
        </button>
        <button onClick={() => setShowSettings(!showSettings)} className={`${BTN} text-muted-foreground mr-1`} title="Settings">
          <Settings className="h-3.5 w-3.5" />
        </button>
        <WindowControls />
      </div>
    </div>
  );
}
