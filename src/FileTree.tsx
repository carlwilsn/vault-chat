import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FileText, ChevronRight, ChevronDown } from "lucide-react";
import { useStore, type FileEntry } from "./store";
import { cn } from "./lib/utils";

export function FileTree() {
  const { vaultPath, files, currentFile, setCurrentFile } = useStore();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

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

  return (
    <div className="h-full flex flex-col bg-card border-r border-border">
      {vaultPath && (
        <div className="px-3 py-1.5 text-[10px] text-muted-foreground/70 font-mono truncate border-b border-border/50 shrink-0">
          {vaultPath}
        </div>
      )}
      <div className="flex-1 overflow-auto py-1">
        {!vaultPath && (
          <div className="px-4 py-8 text-center text-[12px] text-muted-foreground">
            Open a folder to begin.
          </div>
        )}
        {files.map((f) => {
          if (isHidden(f)) return null;
          const isActive = currentFile === f.path;
          const isOpen = f.is_dir && !collapsed.has(f.path);
          return (
            <div
              key={f.path}
              className={cn(
                "flex items-center gap-1 px-2 py-1 text-[12.5px] cursor-pointer select-none",
                f.is_dir
                  ? "text-muted-foreground hover:text-foreground/90"
                  : "hover:bg-accent/60 rounded-sm mx-1",
                isActive && "bg-accent text-accent-foreground rounded-sm mx-1"
              )}
              style={{ paddingLeft: 8 + f.depth * 12 }}
              onClick={() => (f.is_dir ? toggleFolder(f.path) : openFile(f))}
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
          );
        })}
      </div>
    </div>
  );
}
