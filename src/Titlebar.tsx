import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { FolderOpen, Minus, Square, Copy, X, Settings, PanelLeft, PanelRight, ExternalLink, Eye, Terminal, History, RefreshCw, StickyNote } from "lucide-react";
import { useStore, type FileEntry } from "./store";
import { openChatPopout } from "./sync";
import { gitInitIfNeeded } from "./git";
import { HistoryModal } from "./HistoryModal";

export function Titlebar() {
  const {
    vaultPath,
    setVault,
    setFiles,
    setCurrentFile,
    setShowSettings,
    showSettings,
    leftCollapsed,
    rightCollapsed,
    popoutOpen,
    toggleLeft,
    toggleRight,
    setShowNotesPanel,
    notes,
    showHistory,
    setShowHistory,
  } = useStore();
  const [maximized, setMaximized] = useState(false);
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const [hiddenLines, setHiddenLines] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [refreshSpin, setRefreshSpin] = useState(false);
  const win = getCurrentWindow();

  const refreshTree = async () => {
    if (!vaultPath || refreshSpin) return;
    setRefreshSpin(true);
    try {
      const listed = await invoke<FileEntry[]>("list_markdown_files", { vault: vaultPath });
      setFiles(listed);
    } catch (e) {
      console.error("[tree] refresh failed:", e);
    } finally {
      // Keep the spin visible briefly so a fast refresh still reads as feedback.
      setTimeout(() => setRefreshSpin(false), 250);
    }
  };

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
      const normalized = picked.replace(/\\/g, "/");
      const switching = normalized !== vaultPath;
      setVault(normalized);
      if (switching) setCurrentFile(null, "");
      const listed = await invoke<FileEntry[]>("list_markdown_files", { vault: picked });
      setFiles(listed);
      // Ensure the vault is a git repo so agent turns can auto-commit.
      // Silent no-op if already one.
      gitInitIfNeeded(normalized).catch(() => {});
    }
  };

  const openHidden = async () => {
    if (!vaultPath) return;
    try {
      const lines = await invoke<string[]>("read_ignore_lines", { vault: vaultPath });
      setHiddenLines(lines);
      setSelected(new Set());
      setHiddenOpen(true);
    } catch (e) {
      console.error(e);
    }
  };

  const toggleSel = (line: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(line)) next.delete(line);
      else next.add(line);
      return next;
    });

  const unhideSelected = async () => {
    if (!vaultPath || selected.size === 0) {
      setHiddenOpen(false);
      return;
    }
    try {
      await invoke("remove_from_ignore", {
        vault: vaultPath,
        relativePaths: Array.from(selected),
      });
      const listed = await invoke<FileEntry[]>("list_markdown_files", { vault: vaultPath });
      setFiles(listed);
    } catch (e) {
      console.error(e);
    }
    setHiddenOpen(false);
  };

  useEffect(() => {
    if (!hiddenOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHiddenOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hiddenOpen]);

  const vaultName = vaultPath ? vaultPath.split("/").filter(Boolean).pop() : null;
  const isMac =
    typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);
  const [metaDir, setMetaDir] = useState<string | null>(null);
  useEffect(() => {
    invoke<string>("meta_vault_path")
      .then((p) => setMetaDir(p))
      .catch(() => {});
  }, []);
  const inMeta = !!vaultPath && vaultPath === metaDir;

  return (
    <>
    <div
      data-tauri-drag-region
      className="h-9 flex items-center bg-card border-b border-border select-none shrink-0"
    >
      <div
        className="flex items-center gap-1 px-2"
        style={isMac ? { paddingLeft: 76 } : undefined}
      >
        <button
          onClick={toggleLeft}
          className={`h-7 w-7 flex items-center justify-center rounded hover:bg-accent/60 ${leftCollapsed ? "text-muted-foreground" : "text-foreground/90"}`}
          title={`${leftCollapsed ? "Show" : "Hide"} file panel (Ctrl+B)`}
        >
          <PanelLeft className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={pickVault}
          className="h-7 flex items-center gap-1.5 px-2 rounded hover:bg-accent/60 text-[12px] text-foreground/90"
          title="Open vault"
        >
          <FolderOpen className="h-3.5 w-3.5 opacity-80" />
          <span className="max-w-[220px] truncate">{vaultName ?? "Open vault"}</span>
          {inMeta && (
            <span className="rounded px-1.5 py-px text-[10px] bg-primary/20 text-primary font-mono">
              meta
            </span>
          )}
        </button>
        {vaultPath && (
          <>
            <button
              onClick={refreshTree}
              className="h-7 w-7 flex items-center justify-center rounded hover:bg-accent/60 text-muted-foreground disabled:opacity-50"
              title="Refresh file tree"
              disabled={refreshSpin}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${refreshSpin ? "animate-spin" : ""}`} />
            </button>
            <button
              onClick={openHidden}
              className="h-7 w-7 flex items-center justify-center rounded hover:bg-accent/60 text-muted-foreground"
              title="Hidden files"
            >
              <Eye className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => setShowHistory(true)}
              className="h-7 w-7 flex items-center justify-center rounded hover:bg-accent/60 text-muted-foreground"
              title="History (Ctrl+H)"
            >
              <History className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => setShowNotesPanel(true)}
              className="h-7 w-7 flex items-center justify-center rounded hover:bg-accent/60 text-muted-foreground relative"
              title="Notes (Ctrl+N to create)"
            >
              <StickyNote className="h-3.5 w-3.5" />
              {notes.filter((n) => n.status === "open").length > 0 && (
                <span className="absolute top-0.5 right-0.5 h-1.5 w-1.5 rounded-full bg-primary" />
              )}
            </button>
          </>
        )}
      </div>

      <div data-tauri-drag-region className="flex-1 h-full" />

      <div className="flex items-center">
        <button
          onClick={toggleRight}
          disabled={popoutOpen}
          className={`h-7 w-7 flex items-center justify-center rounded hover:bg-accent/60 mr-1 disabled:opacity-40 disabled:cursor-not-allowed ${rightCollapsed ? "text-muted-foreground" : "text-foreground/90"}`}
          title={
            popoutOpen
              ? "Chat is popped out — close the popout window to dock"
              : `${rightCollapsed ? "Show" : "Hide"} chat panel (Ctrl+Shift+B)`
          }
        >
          <PanelRight className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => openChatPopout().catch((err) => console.error("[popout] failed:", err))}
          disabled={popoutOpen}
          className="h-7 w-7 flex items-center justify-center rounded hover:bg-accent/60 text-muted-foreground mr-1 disabled:opacity-40 disabled:cursor-not-allowed"
          title={popoutOpen ? "Chat is popped out" : "Pop out chat"}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() =>
            invoke("open_terminal", { cwd: vaultPath ?? undefined }).catch((err) =>
              console.error("[terminal] failed:", err),
            )
          }
          className="h-7 w-7 flex items-center justify-center rounded hover:bg-accent/60 text-muted-foreground mr-1"
          title={vaultPath ? `Open terminal in ${vaultPath}` : "Open terminal"}
        >
          <Terminal className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => setShowSettings(!showSettings)}
          className="h-7 w-7 flex items-center justify-center rounded hover:bg-accent/60 text-muted-foreground mr-1"
          title="Settings"
        >
          <Settings className="h-3.5 w-3.5" />
        </button>
        {!isMac && (
          <>
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
          </>
        )}
      </div>
    </div>
    {hiddenOpen && (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) setHiddenOpen(false);
        }}
      >
        <div
          className="w-[420px] max-h-[70vh] flex flex-col rounded-md border border-border bg-card shadow-xl"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="px-4 pt-4 pb-2">
            <div className="text-[13px] font-semibold text-foreground">Hidden files</div>
            <div className="text-[11.5px] text-muted-foreground mt-0.5">
              {hiddenLines.length === 0
                ? "Nothing hidden in this vault."
                : "Select entries to unhide. The agent can still see hidden files."}
            </div>
          </div>
          <div className="flex-1 overflow-auto px-2 py-1 min-h-0">
            {hiddenLines.map((line) => (
              <label
                key={line}
                className="flex items-center gap-2 px-2 py-1 rounded-sm hover:bg-accent/60 cursor-pointer text-[12.5px]"
              >
                <input
                  type="checkbox"
                  checked={selected.has(line)}
                  onChange={() => toggleSel(line)}
                  className="vc-checkbox shrink-0"
                />
                <span className="truncate font-mono text-[11.5px] text-foreground/90">{line}</span>
              </label>
            ))}
          </div>
          <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-border/60">
            <div className="text-[11px] text-muted-foreground">
              {selected.size > 0 ? `${selected.size} selected` : ""}
            </div>
            <div className="flex gap-2">
              <button
                className="px-3 py-1 rounded text-[12px] hover:bg-accent/60 text-foreground"
                onClick={() => setHiddenOpen(false)}
              >
                Close
              </button>
              <button
                className="px-3 py-1 rounded text-[12px] bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed"
                disabled={selected.size === 0}
                onClick={unhideSelected}
              >
                Unhide
              </button>
            </div>
          </div>
        </div>
      </div>
    )}
    <HistoryModal open={showHistory} onClose={() => setShowHistory(false)} />
    </>
  );
}
