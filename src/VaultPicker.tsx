// Where the title bar's vault picker is mounted. The picker is a plugin (src/plugins/vaults, app/vaults), mounted
// through the plugin host and the supervisor's records (src/PluginMount.tsx AppPluginMount). It is how Carl changes
// the workspace, so it never just disappears:
//  - while the records are not known yet, the picker itself is drawn here in the app's own tree (nothing flashes);
//  - turned off, or failing to mount or render, a minimal built-in picker stands in (VaultPickerFallback): the open
//    vault's name, and a plain list of the vaults to open one, with one line that says what happened and Turn on /
//    Reload. Rename, delete and New vault are the plugin's.
// The picker lists vaults only; Main and projects live in the chat pane.
import { useEffect, useRef } from "react";
import { Check, FolderOpen } from "lucide-react";
import { useStore } from "./store";
import { VAULTS_PLUGIN } from "./appPlugins";
import { PlaceMount, type PluginFallbackInfo } from "./PluginMount";
import { placeModule } from "./places";
import { PluginOff } from "./PluginOff";
import * as vaultsPlugin from "./plugins/vaults";
import { Picker } from "./plugins/vaults/Picker";
import { isOpenRow, loadRows, setPickerOpen, switchTo, usePicker } from "./plugins/vaults/model";

// The built-in module(s) of the places below (src/places.ts).
placeModule(VAULTS_PLUGIN, () => vaultsPlugin);

/** The picker, in the title bar. */
export function VaultPicker() {
  return <PlaceMount place="titlebar.vaults" fallback={(f) => (f.pending ? <Picker /> : <VaultPickerFallback info={f} />)} />;
}

/** The minimal built-in picker: the open vault, and its vaults to open one. */
export function VaultPickerFallback({ info }: { info: PluginFallbackInfo }) {
  const vaultPath = useStore((s) => s.vaultPath);
  const open = usePicker((s) => s.open);
  const rows = usePicker((s) => s.rows);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    void loadRows().catch(() => {});
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setPickerOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open, vaultPath]);
  const vaultName = vaultPath ? vaultPath.split("/").filter(Boolean).pop() : null;
  return (
    <div className="relative" ref={ref} data-el="vault-picker-fallback">
      <button data-offer="app/vaults.openMenu"
        onClick={() => setPickerOpen(!open)}
        data-el="vault-picker"
        className="h-7 flex items-center gap-1.5 px-2 rounded hover:bg-titlebar-hover text-[12px] text-titlebar-foreground"
        title="Change vault"
        aria-expanded={open}
      >
        <FolderOpen className="h-3.5 w-3.5 opacity-80" />
        <span className="max-w-[220px] truncate">{vaultName ?? "Open folder"}</span>
      </button>
      {open && (
        <div data-el="vault-picker-menu" className="absolute left-0 top-8 z-50 w-72 rounded-md border border-border bg-popover text-popover-foreground shadow-lg p-1">
          {info.off ? (
            <PluginOff path={VAULTS_PLUGIN.id} desired={info.off} className="px-2.5" />
          ) : (
            <div data-el="vault-picker-fallback-error" className="flex items-center gap-2 px-2.5 py-1.5 text-[11.5px] text-muted-foreground">
              <span className="truncate" title={info.error ?? ""}>The vault picker stopped; a plain one until it is back.</span>
              <button data-offer="app/titlebar.reloadPart" type="button" data-el="plugin-reload" onClick={info.retry} className="shrink-0 rounded-md border border-border/60 px-2 py-0.5 text-[11.5px] hover:text-foreground">
                Reload
              </button>
            </div>
          )}
          <div className="max-h-[60vh] overflow-auto">
            {rows.map((r) => (
              <button data-offer="app/vaults.open"
                key={r.rel}
                data-el="vault-picker-item"
                data-rel={r.rel}
                className="w-full h-7 pl-2.5 pr-1 flex items-center gap-2 rounded text-[12px] text-left hover:bg-accent/60"
                onClick={() => {
                  setPickerOpen(false);
                  void switchTo(r);
                }}
              >
                <span className="w-3.5 shrink-0">{isOpenRow(r, vaultPath) && <Check className="h-3.5 w-3.5 text-primary" />}</span>
                <span className="truncate">{r.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
