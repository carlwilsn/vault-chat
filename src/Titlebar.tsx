import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { FolderOpen, RotateCw, Minus, Square, Copy, X, Settings, PanelLeft, PanelRight, ExternalLink, Eye, Terminal, Undo2, History, FileText } from "lucide-react";
import { useStore, type FileEntry } from "./store";
import { openChatPopout } from "./sync";
import { gitInitIfNeeded, gitRecentCommits, gitShowCommit, gitRestoreToCommit, type GitCommit } from "./git";

export function Titlebar() {
  const {
    vaultPath,
    setVault,
    setFiles,
    setCurrentFile,
    setShowSettings,
    showSettings,
    leftCollapsed,
    middleCollapsed,
    rightCollapsed,
    popoutOpen,
    toggleLeft,
    toggleMiddle,
    toggleRight,
  } = useStore();
  const [maximized, setMaximized] = useState(false);
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const [hiddenLines, setHiddenLines] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [historyOpen, setHistoryOpen] = useState(false);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [patch, setPatch] = useState<string>("");
  const [patchLoading, setPatchLoading] = useState(false);
  const [fullDiff, setFullDiff] = useState(false);
  const [showEarlier, setShowEarlier] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);
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

  const refresh = async () => {
    if (!vaultPath) return;
    const listed = await invoke<FileEntry[]>("list_markdown_files", { vault: vaultPath });
    setFiles(listed);
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

  const openHistory = async () => {
    if (!vaultPath) return;
    const c = await gitRecentCommits(vaultPath, 30, showEarlier);
    setCommits(c);
    setSelectedHash(null);
    setPatch("");
    setUndoError(null);
    setHistoryOpen(true);
  };

  const toggleShowEarlier = async () => {
    const next = !showEarlier;
    setShowEarlier(next);
    if (vaultPath) {
      const c = await gitRecentCommits(vaultPath, 100, next);
      setCommits(c);
    }
  };

  const loadPatch = async (hash: string, withFull: boolean) => {
    if (!vaultPath) return;
    setPatchLoading(true);
    try {
      const p = await gitShowCommit(vaultPath, hash, withFull);
      setPatch(p);
    } catch (e) {
      setPatch(`Failed to load: ${String(e)}`);
    }
    setPatchLoading(false);
  };

  const selectCommit = async (hash: string) => {
    if (!vaultPath) return;
    if (selectedHash === hash) return;
    setSelectedHash(hash);
    setPatch("");
    await loadPatch(hash, fullDiff);
  };

  const toggleFullDiff = async () => {
    const next = !fullDiff;
    setFullDiff(next);
    if (selectedHash) await loadPatch(selectedHash, next);
  };

  const restoreToSelected = async () => {
    if (!vaultPath || !selectedHash || restoreBusy) return;
    if (commits[0]?.hash === selectedHash) return; // already at this commit
    setRestoreBusy(true);
    setUndoError(null);
    try {
      await gitRestoreToCommit(vaultPath, selectedHash);
      const listed = await invoke<FileEntry[]>("list_markdown_files", { vault: vaultPath });
      setFiles(listed);
      const c = await gitRecentCommits(vaultPath, 30, showEarlier);
      setCommits(c);
      setSelectedHash(null);
      setPatch("");
    } catch (e) {
      setUndoError(String(e));
    }
    setRestoreBusy(false);
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
  const [sourceDir, setSourceDir] = useState<string | null>(null);
  const [metaDir, setMetaDir] = useState<string | null>(null);
  useEffect(() => {
    invoke<string>("app_source_dir")
      .then((p) => setSourceDir(p))
      .catch(() => {});
    invoke<string>("meta_vault_path")
      .then((p) => setMetaDir(p))
      .catch(() => {});
  }, []);
  const inSource = !!vaultPath && vaultPath === sourceDir;
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
          {inSource && (
            <span className="rounded px-1.5 py-px text-[10px] bg-destructive/20 text-destructive font-mono">
              app source
            </span>
          )}
          {inMeta && (
            <span className="rounded px-1.5 py-px text-[10px] bg-primary/20 text-primary font-mono">
              meta
            </span>
          )}
        </button>
        {vaultPath && (
          <>
            <button
              onClick={openHidden}
              className="h-7 w-7 flex items-center justify-center rounded hover:bg-accent/60 text-muted-foreground"
              title="Hidden files"
            >
              <Eye className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={refresh}
              className="h-7 w-7 flex items-center justify-center rounded hover:bg-accent/60 text-muted-foreground"
              title="Refresh"
            >
              <RotateCw className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={openHistory}
              className="h-7 w-7 flex items-center justify-center rounded hover:bg-accent/60 text-muted-foreground"
              title="History"
            >
              <History className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </div>

      <div data-tauri-drag-region className="flex-1 h-full" />

      <div className="flex items-center">
        {leftCollapsed && (
          <button
            onClick={toggleLeft}
            className="h-7 w-7 flex items-center justify-center rounded hover:bg-accent/60 text-muted-foreground mr-1"
            title="Show file tree (Ctrl+B)"
          >
            <PanelLeft className="h-3.5 w-3.5" />
          </button>
        )}
        {middleCollapsed && !rightCollapsed && !popoutOpen && (
          <button
            onClick={toggleMiddle}
            className="h-7 w-7 flex items-center justify-center rounded hover:bg-accent/60 text-muted-foreground mr-1"
            title="Show editor (Ctrl+Shift+M)"
          >
            <FileText className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          onClick={toggleRight}
          className={`h-7 w-7 flex items-center justify-center rounded hover:bg-accent/60 mr-1 ${rightCollapsed ? "text-muted-foreground" : "text-foreground/90"}`}
          title={`${rightCollapsed ? "Show" : "Hide"} chat panel (Ctrl+Shift+B)`}
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
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
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
                  className="shrink-0"
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
    {historyOpen && (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) setHistoryOpen(false);
        }}
      >
        <div
          className="w-[720px] max-h-[80vh] flex flex-col rounded-md border border-border bg-card shadow-xl"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="px-4 pt-4 pb-2 flex items-center justify-between">
            <div>
              <div className="text-[13px] font-semibold text-foreground">History</div>
              <div className="text-[11.5px] text-muted-foreground mt-0.5">
                Pick a commit to view the diff. Nothing is reverted until you
                click the button below.
              </div>
            </div>
            <button
              onClick={restoreToSelected}
              disabled={
                !selectedHash ||
                restoreBusy ||
                (commits[0]?.hash === selectedHash)
              }
              className="h-7 px-3 rounded text-[12px] border border-border hover:bg-accent/60 flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
              title={
                !selectedHash
                  ? "Select a commit first"
                  : commits[0]?.hash === selectedHash
                    ? "Already at this commit"
                    : "Rewind the vault to this commit state"
              }
            >
              <Undo2 className="h-3 w-3" />
              {restoreBusy ? "Restoring…" : "Go back to this commit"}
            </button>
          </div>
          <div className="flex-1 min-h-0 flex">
            <div className="w-[280px] border-r border-border/60 overflow-auto">
              {commits.length === 0 && (
                <div className="p-4 text-[12px] text-muted-foreground">
                  No commits yet.
                </div>
              )}
              {commits.map((c, idx) => {
                const isSelected = selectedHash === c.hash;
                const isHead = idx === 0;
                return (
                  <button
                    key={c.hash}
                    onClick={() => selectCommit(c.hash)}
                    className={`w-full text-left px-3 py-2 border-b border-border/40 flex items-start gap-2 hover:bg-accent/40 ${
                      isSelected ? "bg-accent/60" : ""
                    }`}
                  >
                    <span
                      className={`mt-[3px] h-3 w-3 shrink-0 rounded-full border ${
                        isSelected
                          ? "border-primary bg-primary"
                          : "border-muted-foreground/50"
                      }`}
                    />
                    <span className="min-w-0 flex-1">
                      <div className="text-[12px] text-foreground truncate">
                        {c.subject}
                      </div>
                      <div className="text-[10.5px] text-muted-foreground font-mono mt-0.5 flex items-center gap-2 flex-wrap">
                        <span>{c.short_hash} · {c.date}</span>
                        {isHead && <span className="text-primary">HEAD</span>}
                        {c.is_anchor && (
                          <span className="rounded px-1.5 py-px text-[9.5px] bg-primary/15 text-primary">
                            vault-chat start
                          </span>
                        )}
                      </div>
                    </span>
                  </button>
                );
              })}
              <button
                onClick={toggleShowEarlier}
                className="w-full text-center px-3 py-2 text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent/30"
              >
                {showEarlier
                  ? "hide earlier history"
                  : "show earlier history (before vault-chat)"}
              </button>
            </div>
            <div className="flex-1 flex flex-col min-h-0">
              {selectedHash && (
                <div className="px-3 py-1.5 border-b border-border/60 flex items-center justify-between shrink-0">
                  <span className="text-[10.5px] text-muted-foreground">
                    {fullDiff ? "Full diff" : "Summary (files + line counts)"}
                  </span>
                  <button
                    onClick={toggleFullDiff}
                    disabled={patchLoading}
                    className="text-[10.5px] text-muted-foreground hover:text-foreground underline underline-offset-2 disabled:opacity-50"
                  >
                    {fullDiff ? "hide file contents" : "show file contents"}
                  </button>
                </div>
              )}
              <div className="flex-1 overflow-auto p-3">
                {patchLoading ? (
                  <div className="text-[12px] text-muted-foreground p-2">
                    Loading…
                  </div>
                ) : patch ? (
                  <pre className="text-[11.5px] font-mono whitespace-pre-wrap text-foreground/90">
                    {patch}
                  </pre>
                ) : (
                  <div className="text-[12px] text-muted-foreground p-2">
                    Pick a commit to view what changed.
                  </div>
                )}
              </div>
            </div>
          </div>
          {undoError && (
            <div className="px-4 py-2 border-t border-border/60 text-[11.5px] text-destructive">
              {undoError}
            </div>
          )}
        </div>
      </div>
    )}
    </>
  );
}
