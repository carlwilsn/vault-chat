import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FileText, ChevronRight, ChevronDown, FilePlus, FolderPlus, Pencil, Trash2, EyeOff } from "lucide-react";
import { useStore, type FileEntry } from "./store";
import { VAULT_PATH_MIME } from "./dnd";
import { cn } from "./lib/utils";

type PendingKind = "file" | "folder";
type Menu = { x: number; y: number; entry: FileEntry | null } | null;

export function FileTree() {
  const { vaultPath, files, currentFile, setCurrentFile, setFiles } = useStore();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<{ kind: PendingKind; parent: string } | null>(null);
  const [pendingName, setPendingName] = useState("");
  const [renaming, setRenaming] = useState<{ path: string; value: string } | null>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const [confirmDelete, setConfirmDelete] = useState<FileEntry | null>(null);
  const [selectedDir, setSelectedDir] = useState<string | null>(null);
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
    if (!confirmDelete) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConfirmDelete(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmDelete]);

  const openFile = async (f: FileEntry) => {
    if (f.is_dir) return;
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
      } catch (e) {
        console.error(e);
      }
    } else {
      const path = `${base}/${raw}`;
      try {
        await invoke("create_dir", { path });
        await refreshFiles();
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
      if (currentFile === renaming.path) {
        const content = await invoke<string>("read_text_file", { path: to });
        setCurrentFile(to, content);
      }
      await refreshFiles();
    } catch (e) {
      console.error(e);
    }
    setRenaming(null);
  };

  const cancelRename = () => setRenaming(null);

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
      if (currentFile === f.path || (f.is_dir && currentFile && currentFile.startsWith(f.path + "/"))) {
        setCurrentFile(null, "");
      }
      await refreshFiles();
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
        className="flex-1 overflow-auto py-1"
        onContextMenu={(e) => {
          if (!vaultPath) return;
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, entry: null });
        }}
      >
        {!vaultPath && (
          <div className="px-4 py-8 text-center text-[12px] text-muted-foreground">
            Open a folder to begin.
          </div>
        )}
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
        {files.map((f) => {
          if (f.hidden) return null;
          if (isHidden(f)) return null;
          const isActive = currentFile === f.path;
          const isSelectedDir = f.is_dir && selectedDir === f.path;
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
                    isSelectedDir && "bg-accent/40"
                  )}
                  style={{ paddingLeft: 8 + f.depth * 12 }}
                  draggable={!f.is_dir}
                  onDragStart={(e) => {
                    if (f.is_dir) return;
                    e.dataTransfer.setData(VAULT_PATH_MIME, f.path);
                    e.dataTransfer.setData("text/plain", f.path);
                    e.dataTransfer.effectAllowed = "copy";
                  }}
                  onClick={() => {
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
      </div>
      {menu && (
        <div
          className="fixed z-50 rounded-md border border-border bg-card shadow-lg py-1 text-[12.5px]"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          {menu.entry ? (
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
            </>
          )}
        </div>
      )}
      {confirmDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
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
        placeholder={kind === "file" ? "filename.md" : "folder"}
        className="flex-1 min-w-0 bg-transparent outline-none text-foreground placeholder:text-muted-foreground/60 p-0"
      />
    </div>
  );
}
