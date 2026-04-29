import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FileText, ChevronRight, ChevronDown, FilePlus, FolderPlus, Pencil, Trash2, EyeOff, FolderOpen } from "lucide-react";
import { useStore, type FileEntry } from "./store";
import { VAULT_PATH_MIME, VAULT_PATHS_MIME, isExternalFileDrop, copyExternalFilesInto } from "./dnd";
import { cn } from "./lib/utils";
import { isUnreadableAsText } from "./fileKind";
import { revealInFileExplorer } from "./opener";
import { commitFsAction } from "./commit-controller";

type PendingKind = "file" | "folder";
type Menu = { x: number; y: number; entry: FileEntry | null } | null;

export function FileTree() {
  const {
    vaultPath,
    files,
    currentFile,
    setCurrentFile,
    setFiles,
    setMode,
    applyDeleteCascade,
    applyRenameCascade,
  } = useStore();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<{ kind: PendingKind; parent: string } | null>(null);
  const [pendingName, setPendingName] = useState("");
  const [renaming, setRenaming] = useState<{ path: string; value: string } | null>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const [confirmDelete, setConfirmDelete] = useState<FileEntry | null>(null);
  const [confirmDeleteMulti, setConfirmDeleteMulti] = useState<string[] | null>(null);
  const [selectedDir, setSelectedDir] = useState<string | null>(null);
  // Multi-select (Shift+Click). Holds absolute paths. `anchor` is the
  // last plain-click, used as the range start for shift-extend.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  // Drop target is either a specific folder path or null for the tree root
  // (vault root). undefined means no drop in progress.
  const [dropTarget, setDropTarget] = useState<string | null | undefined>(undefined);
  const lastVaultRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const renameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (
      vaultPath &&
      vaultPath !== lastVaultRef.current &&
      files.length > 0 &&
      files[0].path.startsWith(vaultPath)
    ) {
      lastVaultRef.current = vaultPath;
      setCollapsed(new Set(files.filter((f) => f.is_dir).map((f) => f.path)));
    }
  }, [vaultPath, files]);

  useEffect(() => {
    if (pending && inputRef.current) inputRef.current.focus();
  }, [pending]);

  useEffect(() => {
    if (renaming && renameRef.current) {
      renameRef.current.focus();
      const dot = renaming.value.lastIndexOf(".");
      const end = dot > 0 ? dot : renaming.value.length;
      renameRef.current.setSelectionRange(0, end);
    }
  }, [renaming?.path]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("mousedown", close);
    return () => {
      window.removeEventListener("mousedown", close);
    };
  }, [menu]);

  useEffect(() => {
    if (!confirmDelete && !confirmDeleteMulti) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setConfirmDelete(null);
        setConfirmDeleteMulti(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmDelete, confirmDeleteMulti]);

  const openFile = async (f: FileEntry) => {
    if (f.is_dir) return;
    if (isUnreadableAsText(f.path)) {
      setCurrentFile(f.path, "");
      return;
    }
    const content = await invoke<string>("read_text_file", { path: f.path });
    setCurrentFile(f.path, content);
  };

  const toggleFolder = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const isHidden = (f: FileEntry) => {
    for (const c of collapsed) {
      if (f.path !== c && f.path.startsWith(c + "/")) return true;
    }
    return false;
  };

  const refreshFiles = async () => {
    if (!vaultPath) return;
    const listed = await invoke<FileEntry[]>("list_markdown_files", { vault: vaultPath });
    setFiles(listed);
  };

  const handleExternalDrop = async (
    e: React.DragEvent<HTMLElement>,
    targetDir: string,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(undefined);
    if (!vaultPath) return;
    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;
    try {
      await copyExternalFilesInto(targetDir, files);
      await refreshFiles();
    } catch (err) {
      console.error("[drop] copy failed:", err);
    }
  };

  // Move vault entries into a folder. Each source is an absolute vault
  // path; dst is the destination directory (vaultPath itself for the
  // tree root). Filters out no-op, self-parent, and into-descendant
  // moves so the backend never sees them. Accepts a list so Shift-
  // click multi-selections drag as a group.
  const handleInternalMove = async (
    e: React.DragEvent<HTMLElement>,
    sources: string[],
    dstDir: string,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(undefined);
    if (!vaultPath) return;
    const dstClean = dstDir.replace(/\/$/, "");
    const moves: { from: string; to: string }[] = [];
    for (const src of sources) {
      if (!src.startsWith(vaultPath + "/")) continue;
      if (src === dstDir) continue;
      if (dstDir.startsWith(src + "/")) continue;
      const base = src.split("/").pop();
      if (!base) continue;
      const to = `${dstClean}/${base}`;
      if (to === src) continue;
      moves.push({ from: src, to });
    }
    if (moves.length === 0) return;
    try {
      const succeeded: { from: string; to: string }[] = [];
      for (const m of moves) {
        try {
          await invoke("rename_path", { from: m.from, to: m.to });
          succeeded.push(m);
        } catch (e) {
          console.error("[move] rename failed:", m, e);
          continue;
        }
        // Keep hidden-file entries in sync — the move just shifted any
        // ignored descendants to a new prefix on disk, so the ignore
        // file's stored relative paths need the same shift.
        if (m.from.startsWith(vaultPath + "/") && m.to.startsWith(vaultPath + "/")) {
          const oldRel = m.from.slice(vaultPath.length + 1);
          const newRel = m.to.slice(vaultPath.length + 1);
          try {
            await invoke("rename_in_ignore", {
              vault: vaultPath,
              oldRelative: oldRel,
              newRelative: newRel,
            });
          } catch (e) {
            console.error("[move] update ignore failed:", e);
          }
        }
      }
      if (succeeded.length > 0) {
        // Rewrite panes / currentFile / note anchors. After cascade,
        // re-read the current file's contents so the editor reflects
        // its new path.
        await applyRenameCascade(succeeded);
        const after = useStore.getState();
        if (after.currentFile && succeeded.some((m) => after.currentFile === m.to)) {
          if (isUnreadableAsText(after.currentFile)) {
            setCurrentFile(after.currentFile, "");
          } else {
            try {
              const content = await invoke<string>("read_text_file", {
                path: after.currentFile,
              });
              setCurrentFile(after.currentFile, content);
            } catch (e) {
              console.error("[move] reread current failed:", e);
            }
          }
        }
      }
      setCollapsed((prev) => {
        const next = new Set<string>();
        for (const p of prev) {
          let rewritten = p;
          for (const m of moves) {
            if (rewritten === m.from) rewritten = m.to;
            else if (rewritten.startsWith(m.from + "/"))
              rewritten = m.to + rewritten.slice(m.from.length);
          }
          next.add(rewritten);
        }
        return next;
      });
      setSelected(new Set(moves.map((m) => m.to)));
      setAnchor(moves[moves.length - 1].to);
      await refreshFiles();
      if (succeeded.length > 0 && vaultPath) {
        const rel = (p: string) =>
          p.startsWith(vaultPath + "/") ? p.slice(vaultPath.length + 1) : p;
        const msg =
          succeeded.length === 1
            ? `move ${rel(succeeded[0].from)} → ${rel(succeeded[0].to)}`
            : `move ${succeeded.length} items`;
        commitFsAction(vaultPath, msg).catch(() => {});
      }
    } catch (err) {
      console.error("[dnd] move failed:", err);
    }
  };

  const readDropSources = (dt: DataTransfer): string[] => {
    const multi = dt.getData(VAULT_PATHS_MIME);
    if (multi) {
      try {
        const parsed = JSON.parse(multi);
        if (Array.isArray(parsed)) return parsed.filter((p) => typeof p === "string");
      } catch {
        /* fall through to single */
      }
    }
    const one = dt.getData(VAULT_PATH_MIME);
    return one ? [one] : [];
  };

  const isInternalDrag = (dt: DataTransfer | null): boolean =>
    !!dt && dt.types.includes(VAULT_PATH_MIME);

  // Shift+Click toggles the clicked row in/out of the selection — one
  // at a time, not a range. Includes the previous anchor so the user's
  // starting row stays in the selection until they deselect it.
  const toggleSelection = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (anchor && !next.has(anchor)) next.add(anchor);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const beginCreate = (kind: PendingKind, parentOverride?: string) => {
    if (!vaultPath) return;
    const parent = parentOverride ?? selectedDir ?? vaultPath;
    if (parent !== vaultPath) {
      setCollapsed((prev) => {
        const n = new Set(prev);
        n.delete(parent);
        return n;
      });
    }
    setPending({ kind, parent });
    setPendingName("");
  };

  const commitCreate = async () => {
    if (!pending || !pendingName.trim()) {
      setPending(null);
      return;
    }
    const raw = pendingName.trim();
    const base = pending.parent.replace(/\/$/, "");
    if (pending.kind === "file") {
      const name = /\.[^./\\]+$/.test(raw) ? raw : `${raw}.md`;
      const path = `${base}/${name}`;
      try {
        await invoke("write_text_file", { path, contents: "" });
        await refreshFiles();
        const content = await invoke<string>("read_text_file", { path });
        setCurrentFile(path, content);
        // A brand-new file is empty — there's nothing to *view*, so
        // landing in view mode just shows a blank pane and forces an
        // extra Ctrl+E. Drop straight into the editor.
        setMode("edit");
        if (vaultPath) {
          const rel = path.startsWith(vaultPath + "/")
            ? path.slice(vaultPath.length + 1)
            : path;
          commitFsAction(vaultPath, `create ${rel}`).catch(() => {});
        }
      } catch (e) {
        console.error(e);
      }
    } else {
      const path = `${base}/${raw}`;
      try {
        await invoke("create_dir", { path });
        await refreshFiles();
        // git only tracks files, not empty dirs — no commit until the
        // first file lands inside. Skip commitFsAction here.
      } catch (e) {
        console.error(e);
      }
    }
    setPending(null);
    setPendingName("");
  };

  const cancelCreate = () => {
    setPending(null);
    setPendingName("");
  };

  const beginRename = (f: FileEntry) => {
    setRenaming({ path: f.path, value: f.name });
  };

  const commitRename = async () => {
    if (!renaming) return;
    const next = renaming.value.trim();
    const cur = renaming.path.split("/").pop() ?? "";
    if (!next || next === cur) {
      setRenaming(null);
      return;
    }
    const parent = renaming.path.substring(0, renaming.path.lastIndexOf("/"));
    const to = `${parent}/${next}`;
    try {
      await invoke("rename_path", { from: renaming.path, to });
      // Hidden-file paths in the ignore list are stored relative to the
      // vault. When the renamed entry (or any descendant) is on that
      // list, the entry survives the move on disk but the ignore entry
      // would dangle. Patch every matching prefix so previously-hidden
      // items stay hidden under the new name.
      if (vaultPath && renaming.path.startsWith(vaultPath + "/")) {
        const oldRel = renaming.path.slice(vaultPath.length + 1);
        const newRel = to.slice(vaultPath.length + 1);
        try {
          await invoke("rename_in_ignore", {
            vault: vaultPath,
            oldRelative: oldRel,
            newRelative: newRel,
          });
        } catch (e) {
          console.error("[rename] update ignore failed:", e);
        }
      }
      // Rewrite panes, currentFile, and note anchors that pointed at
      // the renamed path or any descendant. Re-read currentFile from
      // disk afterward so the editor sees the just-written contents.
      await applyRenameCascade([{ from: renaming.path, to }]);
      const stateAfter = useStore.getState();
      if (stateAfter.currentFile === to) {
        try {
          const content = await invoke<string>("read_text_file", { path: to });
          setCurrentFile(to, content);
        } catch (e) {
          console.error("[rename] reread current failed:", e);
        }
      }
      await refreshFiles();
      if (vaultPath && renaming.path.startsWith(vaultPath + "/")) {
        const oldRel = renaming.path.slice(vaultPath.length + 1);
        const newRel = to.slice(vaultPath.length + 1);
        commitFsAction(vaultPath, `rename ${oldRel} → ${newRel}`).catch(() => {});
      }
    } catch (e) {
      console.error(e);
    }
    setRenaming(null);
  };

  const cancelRename = () => setRenaming(null);

  const hidePaths = async (paths: string[]) => {
    if (!vaultPath) return;
    for (const p of paths) {
      if (!p.startsWith(vaultPath + "/")) continue;
      const rel = p.slice(vaultPath.length + 1);
      try {
        await invoke("add_to_ignore", { vault: vaultPath, relativePath: rel });
      } catch (e) {
        console.error("[hide]", p, e);
      }
    }
    await refreshFiles();
    setSelected(new Set());
    setAnchor(null);
  };

  const deletePaths = async (paths: string[]) => {
    const deletedOk: string[] = [];
    for (const p of paths) {
      try {
        await invoke("delete_file", { path: p });
        deletedOk.push(p);
      } catch (e) {
        console.error("[delete]", p, e);
      }
    }
    if (deletedOk.length > 0) {
      if (vaultPath) {
        const rels = deletedOk
          .filter((p) => p.startsWith(vaultPath + "/"))
          .map((p) => p.slice(vaultPath.length + 1));
        if (rels.length > 0) {
          try {
            await invoke("remove_prefix_from_ignore", {
              vault: vaultPath,
              relativePrefixes: rels,
            });
          } catch (e) {
            console.error("[delete] prune ignore failed:", e);
          }
        }
      }
      await applyDeleteCascade(deletedOk);
    }
    await refreshFiles();
    setSelected(new Set());
    setAnchor(null);
    if (deletedOk.length > 0 && vaultPath) {
      const rel = (p: string) =>
        p.startsWith(vaultPath + "/") ? p.slice(vaultPath.length + 1) : p;
      const msg =
        deletedOk.length === 1
          ? `delete ${rel(deletedOk[0])}`
          : `delete ${deletedOk.length} items`;
      commitFsAction(vaultPath, msg).catch(() => {});
    }
  };

  const hideEntry = async (f: FileEntry) => {
    if (!vaultPath || !f.path.startsWith(vaultPath + "/")) return;
    const rel = f.path.slice(vaultPath.length + 1);
    try {
      await invoke("add_to_ignore", { vault: vaultPath, relativePath: rel });
      await refreshFiles();
    } catch (e) {
      console.error(e);
    }
  };

  const doDelete = async (f: FileEntry) => {
    try {
      await invoke("delete_file", { path: f.path });
      if (vaultPath && f.path.startsWith(vaultPath + "/")) {
        const rel = f.path.slice(vaultPath.length + 1);
        try {
          await invoke("remove_prefix_from_ignore", {
            vault: vaultPath,
            relativePrefixes: [rel],
          });
        } catch (e) {
          console.error("[delete] prune ignore failed:", e);
        }
      }
      await applyDeleteCascade([f.path]);
      await refreshFiles();
      if (vaultPath && f.path.startsWith(vaultPath + "/")) {
        const rel = f.path.slice(vaultPath.length + 1);
        commitFsAction(vaultPath, `delete ${rel}`).catch(() => {});
      }
    } catch (e) {
      console.error(e);
    }
  };

  const pendingParentDepth =
    pending && pending.parent !== vaultPath
      ? (files.find((f) => f.path === pending.parent)?.depth ?? 0) + 1
      : 0;

  return (
    <div className="h-full flex flex-col bg-card border-r border-border">
      {vaultPath && (
        <div className="flex items-center gap-1 px-2 py-1 border-b border-border/50 shrink-0">
          <div className="flex-1 text-[10px] text-muted-foreground/70 font-mono truncate">
            {vaultPath}
          </div>
          <button
            onClick={() => beginCreate("file")}
            title="New file"
            className="h-6 w-6 flex items-center justify-center rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground"
          >
            <FilePlus className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => beginCreate("folder")}
            title="New folder"
            className="h-6 w-6 flex items-center justify-center rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground"
          >
            <FolderPlus className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      <div
        className={cn(
          "flex-1 overflow-auto py-1",
          dropTarget === null && "ring-2 ring-inset ring-primary/50 bg-primary/5",
        )}
        onContextMenu={(e) => {
          if (!vaultPath) return;
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, entry: null });
        }}
        onDragEnter={(e) => {
          if (!vaultPath) return;
          const internal = isInternalDrag(e.dataTransfer);
          const external = isExternalFileDrop(e.dataTransfer);
          if (!internal && !external) return;
          e.preventDefault();
          if (dropTarget === undefined) setDropTarget(null);
        }}
        onDragOver={(e) => {
          if (!vaultPath) return;
          const internal = isInternalDrag(e.dataTransfer);
          const external = isExternalFileDrop(e.dataTransfer);
          if (!internal && !external) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = internal ? "move" : "copy";
        }}
        onDragLeave={(e) => {
          if (!vaultPath) return;
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          setDropTarget(undefined);
        }}
        onDrop={(e) => {
          if (!vaultPath) return;
          if (isInternalDrag(e.dataTransfer)) {
            handleInternalMove(e, readDropSources(e.dataTransfer), vaultPath);
          } else if (isExternalFileDrop(e.dataTransfer)) {
            handleExternalDrop(e, vaultPath);
          }
        }}
      >
        {!vaultPath && (
          <div className="px-4 py-8 text-center text-[12px] text-muted-foreground">
            Open a folder to begin.
          </div>
        )}
        {files.map((f) => {
          if (f.hidden) return null;
          if (isHidden(f)) return null;
          const multiSelecting = selected.size > 1;
          // When the user is shift-building a multi-selection, the only
          // row visual that should read as "selected" is the clicked
          // set. Hide the open-file highlight and the folder-context
          // highlight so they don't bleed into the selection.
          const isActive = !multiSelecting && currentFile === f.path;
          const isSelectedDir = !multiSelecting && f.is_dir && selectedDir === f.path;
          const isMultiSelected = multiSelecting && selected.has(f.path);
          const isOpen = f.is_dir && !collapsed.has(f.path);
          const isRenaming = renaming?.path === f.path;
          return (
            <div key={f.path} className="mx-1 rounded-sm">
              {isRenaming ? (
                <div
                  className="flex items-center gap-1 px-2 py-1 text-[12.5px] rounded-sm bg-accent/30"
                  style={{ paddingLeft: 8 + f.depth * 12 }}
                >
                  {f.is_dir ? (
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-70" />
                  ) : (
                    <FileText className="h-3.5 w-3.5 shrink-0 opacity-70 ml-3.5" />
                  )}
                  <input
                    ref={renameRef}
                    size={1}
                    value={renaming.value}
                    onChange={(e) => setRenaming({ path: renaming.path, value: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      else if (e.key === "Escape") cancelRename();
                    }}
                    onBlur={commitRename}
                    className="flex-1 min-w-0 bg-transparent outline-none text-foreground p-0"
                  />
                </div>
              ) : (
                <div
                  className={cn(
                    "flex items-center gap-1 px-2 py-1 text-[12.5px] cursor-pointer select-none rounded-sm",
                    f.is_dir
                      ? "text-muted-foreground hover:text-foreground/90"
                      : "hover:bg-accent/60",
                    isActive && "bg-accent text-accent-foreground",
                    isSelectedDir && "bg-accent/40",
                    isMultiSelected && "bg-primary/15 text-foreground",
                    f.is_dir && dropTarget === f.path && "ring-2 ring-primary/60 bg-primary/10",
                  )}
                  style={{ paddingLeft: 8 + f.depth * 12 }}
                  draggable
                  onDragStart={(e) => {
                    // If the dragged row is part of a multi-selection,
                    // ship the whole set; otherwise just this row.
                    const group =
                      selected.has(f.path) && selected.size > 1
                        ? Array.from(selected)
                        : [f.path];
                    e.dataTransfer.setData(VAULT_PATH_MIME, f.path);
                    e.dataTransfer.setData("text/plain", f.path);
                    if (group.length > 1) {
                      e.dataTransfer.setData(VAULT_PATHS_MIME, JSON.stringify(group));
                    }
                    // copyMove — ChatPane treats it as copy (attach),
                    // folder targets treat it as move.
                    e.dataTransfer.effectAllowed = "copyMove";
                  }}
                  onDragEnter={(e) => {
                    if (!f.is_dir) return;
                    const internal = isInternalDrag(e.dataTransfer);
                    const external = isExternalFileDrop(e.dataTransfer);
                    if (!internal && !external) return;
                    // Can't drop into self or a descendant. For multi-
                    // drags, reject the whole gesture if ANY source
                    // would be invalid — otherwise the visual lights up
                    // for moves that won't happen on drop.
                    if (internal) {
                      const sources = readDropSources(e.dataTransfer);
                      const blocked = sources.some(
                        (s) => s === f.path || f.path.startsWith(s + "/"),
                      );
                      if (blocked) return;
                    }
                    e.preventDefault();
                    e.stopPropagation();
                    setDropTarget(f.path);
                  }}
                  onDragOver={(e) => {
                    if (!f.is_dir) return;
                    const internal = isInternalDrag(e.dataTransfer);
                    const external = isExternalFileDrop(e.dataTransfer);
                    if (!internal && !external) return;
                    e.preventDefault();
                    e.stopPropagation();
                    e.dataTransfer.dropEffect = internal ? "move" : "copy";
                  }}
                  onDragLeave={(e) => {
                    if (!f.is_dir) return;
                    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
                    if (dropTarget === f.path) setDropTarget(null);
                  }}
                  onDrop={(e) => {
                    if (!f.is_dir) return;
                    if (isInternalDrag(e.dataTransfer)) {
                      handleInternalMove(e, readDropSources(e.dataTransfer), f.path);
                    } else if (isExternalFileDrop(e.dataTransfer)) {
                      handleExternalDrop(e, f.path);
                    }
                  }}
                  onClick={(ev) => {
                    if (ev.shiftKey) {
                      ev.preventDefault();
                      toggleSelection(f.path);
                      return;
                    }
                    // Plain click — reset multi-selection to just this
                    // row (acts as the anchor for a subsequent shift).
                    setSelected(new Set([f.path]));
                    setAnchor(f.path);
                    if (f.is_dir) {
                      setSelectedDir((prev) => (prev === f.path ? null : f.path));
                      toggleFolder(f.path);
                    } else {
                      setSelectedDir(null);
                      openFile(f);
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setMenu({ x: e.clientX, y: e.clientY, entry: f });
                  }}
                  onMouseDown={(e) => {
                    if (e.button === 2) e.stopPropagation();
                  }}
                >
                  {f.is_dir ? (
                    isOpen ? (
                      <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-70" />
                    )
                  ) : (
                    <FileText className="h-3.5 w-3.5 shrink-0 opacity-70 ml-3.5" />
                  )}
                  <span className="truncate">{f.name.replace(/\.md$/, "")}</span>
                </div>
              )}
              {pending && pending.parent === f.path && (
                <PendingRow
                  kind={pending.kind}
                  depth={pendingParentDepth}
                  name={pendingName}
                  onChange={setPendingName}
                  onCommit={commitCreate}
                  onCancel={cancelCreate}
                  inputRef={inputRef}
                />
              )}
            </div>
          );
        })}
        {pending && pending.parent === vaultPath && (
          <PendingRow
            kind={pending.kind}
            depth={0}
            name={pendingName}
            onChange={setPendingName}
            onCommit={commitCreate}
            onCancel={cancelCreate}
            inputRef={inputRef}
          />
        )}
      </div>
      {menu && (
        <div
          className="fixed z-50 rounded-md border border-border bg-card shadow-lg py-1 text-[12.5px]"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          {selected.size > 1 ? (
            <>
              <button
                className="w-full flex items-center gap-2 px-3 py-1 hover:bg-accent/60 text-left text-foreground whitespace-nowrap"
                onClick={() => {
                  const paths = Array.from(selected);
                  setMenu(null);
                  hidePaths(paths);
                }}
              >
                <EyeOff className="h-3.5 w-3.5 opacity-70" /> Hide {selected.size} selected
              </button>
              <button
                className="w-full flex items-center gap-2 px-3 py-1 hover:bg-accent/60 text-left text-destructive whitespace-nowrap"
                onClick={() => {
                  setConfirmDeleteMulti(Array.from(selected));
                  setMenu(null);
                }}
              >
                <Trash2 className="h-3.5 w-3.5 opacity-70" /> Delete {selected.size} selected
              </button>
            </>
          ) : menu.entry ? (
            <>
              {menu.entry.is_dir && (
                <>
                  <button
                    className="w-full flex items-center gap-2 px-3 py-1 hover:bg-accent/60 text-left text-foreground whitespace-nowrap"
                    onClick={() => {
                      beginCreate("file", menu.entry!.path);
                      setMenu(null);
                    }}
                  >
                    <FilePlus className="h-3.5 w-3.5 opacity-70" /> New file
                  </button>
                  <button
                    className="w-full flex items-center gap-2 px-3 py-1 hover:bg-accent/60 text-left text-foreground whitespace-nowrap"
                    onClick={() => {
                      beginCreate("folder", menu.entry!.path);
                      setMenu(null);
                    }}
                  >
                    <FolderPlus className="h-3.5 w-3.5 opacity-70" /> New folder
                  </button>
                  <div className="my-1 h-px bg-border/60" />
                </>
              )}
              <button
                className="w-full flex items-center gap-2 px-3 py-1 hover:bg-accent/60 text-left text-foreground whitespace-nowrap"
                onClick={() => {
                  beginRename(menu.entry!);
                  setMenu(null);
                }}
              >
                <Pencil className="h-3.5 w-3.5 opacity-70" /> Rename
              </button>
              <button
                className="w-full flex items-center gap-2 px-3 py-1 hover:bg-accent/60 text-left text-foreground whitespace-nowrap"
                onClick={() => {
                  revealInFileExplorer(menu.entry!.path).catch((e) =>
                    console.error("[opener] reveal failed:", e),
                  );
                  setMenu(null);
                }}
              >
                <FolderOpen className="h-3.5 w-3.5 opacity-70" /> File Explorer
              </button>
              <button
                className="w-full flex items-center gap-2 px-3 py-1 hover:bg-accent/60 text-left text-foreground whitespace-nowrap"
                onClick={() => {
                  hideEntry(menu.entry!);
                  setMenu(null);
                }}
              >
                <EyeOff className="h-3.5 w-3.5 opacity-70" /> Hide
              </button>
              <button
                className="w-full flex items-center gap-2 px-3 py-1 hover:bg-accent/60 text-left text-destructive whitespace-nowrap"
                onClick={() => {
                  setConfirmDelete(menu.entry);
                  setMenu(null);
                }}
              >
                <Trash2 className="h-3.5 w-3.5 opacity-70" /> Delete
              </button>
            </>
          ) : (
            <>
              <button
                className="w-full flex items-center gap-2 px-3 py-1 hover:bg-accent/60 text-left text-foreground whitespace-nowrap"
                onClick={() => {
                  beginCreate("file", vaultPath ?? undefined);
                  setMenu(null);
                }}
              >
                <FilePlus className="h-3.5 w-3.5 opacity-70" /> New file
              </button>
              <button
                className="w-full flex items-center gap-2 px-3 py-1 hover:bg-accent/60 text-left text-foreground whitespace-nowrap"
                onClick={() => {
                  beginCreate("folder", vaultPath ?? undefined);
                  setMenu(null);
                }}
              >
                <FolderPlus className="h-3.5 w-3.5 opacity-70" /> New folder
              </button>
              {vaultPath && (
                <button
                  className="w-full flex items-center gap-2 px-3 py-1 hover:bg-accent/60 text-left text-foreground whitespace-nowrap"
                  onClick={() => {
                    revealInFileExplorer(vaultPath).catch((e) =>
                      console.error("[opener] reveal failed:", e),
                    );
                    setMenu(null);
                  }}
                >
                  <FolderOpen className="h-3.5 w-3.5 opacity-70" /> File Explorer
                </button>
              )}
            </>
          )}
        </div>
      )}
      {confirmDeleteMulti && confirmDeleteMulti.length > 0 && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setConfirmDeleteMulti(null);
          }}
        >
          <div
            className="w-[360px] rounded-md border border-border bg-card shadow-xl p-4"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="text-[13px] font-semibold text-foreground">
              Delete {confirmDeleteMulti.length} items?
            </div>
            <div className="text-[12px] text-muted-foreground mt-1 max-h-[180px] overflow-auto">
              {confirmDeleteMulti.map((p) => (
                <div key={p} className="break-all font-mono">
                  {p.split("/").pop()}
                </div>
              ))}
            </div>
            <div className="mt-2 text-[12px] text-destructive/90">
              Folders will be removed with everything inside. This cannot be undone.
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button
                className="px-3 py-1 rounded text-[12px] hover:bg-accent/60 text-foreground"
                onClick={() => setConfirmDeleteMulti(null)}
              >
                Cancel
              </button>
              <button
                className="px-3 py-1 rounded text-[12px] bg-destructive text-destructive-foreground hover:bg-destructive/90"
                autoFocus
                onClick={() => {
                  const paths = confirmDeleteMulti;
                  setConfirmDeleteMulti(null);
                  deletePaths(paths);
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
      {confirmDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setConfirmDelete(null);
          }}
        >
          <div
            className="w-[320px] rounded-md border border-border bg-card shadow-xl p-4"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="text-[13px] font-semibold text-foreground">
              Delete {confirmDelete.is_dir ? "folder" : "file"}?
            </div>
            <div className="text-[12px] text-muted-foreground mt-1 break-all">
              {confirmDelete.name}
              {confirmDelete.is_dir && (
                <div className="mt-1.5 text-destructive/90">
                  Everything inside will be permanently removed.
                </div>
              )}
              {!confirmDelete.is_dir && (
                <div className="mt-1.5 text-destructive/90">This cannot be undone.</div>
              )}
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button
                className="px-3 py-1 rounded text-[12px] hover:bg-accent/60 text-foreground"
                onClick={() => setConfirmDelete(null)}
              >
                Cancel
              </button>
              <button
                className="px-3 py-1 rounded text-[12px] bg-destructive text-destructive-foreground hover:bg-destructive/90"
                autoFocus
                onClick={() => {
                  const f = confirmDelete;
                  setConfirmDelete(null);
                  doDelete(f);
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PendingRow({
  kind,
  depth,
  name,
  onChange,
  onCommit,
  onCancel,
  inputRef,
}: {
  kind: PendingKind;
  depth: number;
  name: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  inputRef: React.MutableRefObject<HTMLInputElement | null>;
}) {
  return (
    <div
      className="flex items-center gap-1 px-2 py-1 text-[12.5px] mx-1 rounded-sm bg-accent/30"
      style={{ paddingLeft: 8 + depth * 12 }}
    >
      {kind === "folder" ? (
        <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-70" />
      ) : (
        <FileText className="h-3.5 w-3.5 shrink-0 opacity-70 ml-3.5" />
      )}
      <input
        ref={inputRef}
        size={1}
        value={name}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onCommit();
          else if (e.key === "Escape") onCancel();
        }}
        onBlur={onCommit}
        placeholder={kind === "file" ? "filename" : "folder"}
        className="flex-1 min-w-0 bg-transparent outline-none text-foreground placeholder:text-muted-foreground/60 p-0"
      />
    </div>
  );
}
