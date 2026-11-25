// Where the Settings pane is mounted. Settings is a plugin (src/plugins/settings, app/settings), mounted through the
// plugin host and the supervisor's records (src/PluginMount.tsx AppPluginMount) where it shows: in the chat pane's place
// (src/ChatPane.tsx), or the viewer's when the chat is hidden (src/App.tsx). It is how Carl gets back to the chat, so it
// never just disappears:
//  - while the records are not known yet, the pane itself is drawn here in the app's own tree (nothing flashes);
//  - turned off, or failing to mount or render, a plain pane stands in (SettingsFallback): back to the chat and one
//    line that says what happened with Turn on / Reload. The agent's box:settings still
//    changes every setting meanwhile.
import { TileHeadActions } from "./TileTitle";
import { ArrowLeft } from "lucide-react";
import { useStore } from "./store";
import { SETTINGS_PLUGIN } from "./appPlugins";
import { PlaceMount, type PluginFallbackInfo } from "./PluginMount";
import { placeModule } from "./places";
import { PluginOff } from "./PluginOff";
import { Button } from "./ui";
import * as settingsPlugin from "./plugins/settings";
import { Pane } from "./plugins/settings/Pane";

// The built-in module(s) of the places below (src/places.ts).
placeModule(SETTINGS_PLUGIN, () => settingsPlugin);

/** The Settings pane. */
export function SettingsPane() {
  return <PlaceMount place="settings" fallback={(f) => (f.pending ? <Pane /> : <SettingsFallback info={f} />)} />;
}

/** The plain pane: back, and why the plugin's pane is not there. */
export function SettingsFallback({ info }: { info: PluginFallbackInfo }) {
  const setShowSettings = useStore((s) => s.setShowSettings);
  return (
    <div className="h-full flex flex-col bg-card border-l border-border" data-el="settings-fallback">
      <div data-tile-head="" className="relative flex items-center gap-2 px-3 py-2 border-b border-border">
        <Button data-offer="app/settings.close" variant="ghost" size="icon" onClick={() => setShowSettings(false)} data-el="settings-back" title="Back">
          <ArrowLeft className="h-3.5 w-3.5" />
        </Button>
        <span className="flex-1 min-w-0 truncate text-center select-none text-[13px] font-semibold">Settings</span>
        <TileHeadActions />
      </div>
      <div className="flex-1 overflow-auto p-5 space-y-4">
        {info.off ? (
          <PluginOff path={SETTINGS_PLUGIN.id} desired={info.off} className="px-0" />
        ) : (
          <div data-el="settings-fallback-error" className="flex items-center gap-2 text-[12px] text-muted-foreground">
            <span className="truncate" title={info.error ?? ""}>Settings stopped; ask the agent to change a setting until it is back.</span>
            <button data-offer="app/titlebar.reloadPart" type="button" data-el="plugin-reload" onClick={info.retry} className="shrink-0 rounded-md border border-border/60 px-2 py-0.5 text-[11.5px] hover:text-foreground">
              Reload
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
