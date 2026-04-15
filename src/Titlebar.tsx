import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { FolderOpen, RotateCw, Minus, Square, Copy, X, Settings } from "lucide-react";
import { useStore, type FileEntry } from "./store";

export function Titlebar() {
  const { vaultPath, setVault, setFiles, setShowSettings, showSettings } = useStore();
  const [maximized, setMaximized] = useState(false);
  const win = getCurrentWindow();

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

  const pickVault = async () => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string") {
      setVault(picked.replace(/\\/g, "/"));
      const listed = await invoke<FileEntry[]>("list_markdown_files", { vault: picked });
      setFiles(listed);
    }
  };

  const refresh = async () => {
    if (!vaultPath) return;
    const listed = await invoke<FileEntry[]>("list_markdown_files", { vault: vaultPath });
    setFiles(listed);
  };

  const vaultName = vaultPath ? vaultPath.split("/").filter(Boolean).pop() : null;

  return (
    <div
      data-tauri-drag-region
      className="h-9 flex items-center bg-card border-b border-border select-none shrink-0"
    >
      <div className="flex items-center gap-1 px-2">
        <button
          onClick={pickVault}
          className="h-7 flex items-center gap-1.5 px-2 rounded hover:bg-accent/60 text-[12px] text-foreground/90"
          title="Open vault"
        >
          <FolderOpen className="h-3.5 w-3.5 opacity-80" />
          <span className="max-w-[220px] truncate">{vaultName ?? "Open vault"}</span>
        </button>
        {vaultPath && (
          <button
            onClick={refresh}
            className="h-7 w-7 flex items-center justify-center rounded hover:bg-accent/60 text-muted-foreground"
            title="Refresh"
          >
            <RotateCw className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div data-tauri-drag-region className="flex-1 h-full" />

      <div className="flex items-center">
        <button
          onClick={() => setShowSettings(!showSettings)}
          className="h-7 w-7 flex items-center justify-center rounded hover:bg-accent/60 text-muted-foreground mr-1"
          title="Settings"
        >
          <Settings className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => win.minimize()}
          className="h-9 w-11 flex items-center justify-center hover:bg-accent/60 text-muted-foreground"
          title="Minimize"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => win.toggleMaximize()}
          className="h-9 w-11 flex items-center justify-center hover:bg-accent/60 text-muted-foreground"
          title={maximized ? "Restore" : "Maximize"}
        >
          {maximized ? <Copy className="h-3 w-3" /> : <Square className="h-3 w-3" />}
        </button>
        <button
          onClick={() => win.close()}
          className="h-9 w-11 flex items-center justify-center hover:bg-destructive hover:text-destructive-foreground text-muted-foreground"
          title="Close"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
