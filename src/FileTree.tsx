// Where the left panel's file tree is mounted. The tree is a plugin (src/plugins/filetree, app/filetree), mounted
// through the plugin host and the supervisor's records (src/PluginMount.tsx AppPluginMount). It is how Carl gets to his
// files, so it never just disappears:
//  - while the records are not known yet, the tree itself is drawn here in the app's own tree (nothing flashes);
//  - turned off, or failing to mount or render, a minimal built-in tree stands in (FileTreeFallback): the vault's
//    folders to open and files to open in the viewer, with one line that says what happened and Turn on / Reload.
//    New file, rename, move, hide and delete are the plugin's.
import { useMemo } from "react";
import { ChevronDown, ChevronRight, FileText } from "lucide-react";
import { useStore } from "./store";
import { FILETREE_PLUGIN } from "./appPlugins";
import { AppPluginMount, type PluginFallbackInfo } from "./PluginMount";
import { PluginOff } from "./PluginOff";
import { cn } from "./lib/utils";
import * as fileTreePlugin from "./plugins/filetree";
import { Tree } from "./plugins/filetree/Tree";
import { clickRow, useTree, visibleItems } from "./plugins/filetree/model";

/** The left file tree: always the open folder (Carl, 2026-10-29: no second tab for a project's folder). */
export function FileTree() {
  return <AppPluginMount plugin={FILETREE_PLUGIN} module={fileTreePlugin} fallback={(f) => (f.pending ? <Tree /> : <FileTreeFallback info={f} />)} />;
}

/** The fallback's rows at most (it is not virtualized). */
const FALLBACK_ROWS = 1500;

/** The minimal built-in tree: open folders, open files. */
export function FileTreeFallback({ info }: { info: PluginFallbackInfo }) {
  const vaultPath = useStore((s) => s.vaultPath);
  const files = useStore((s) => s.files);
  const currentFile = useStore((s) => s.currentFile);
  const expanded = useTree((s) => s.expanded);
  const filter = useTree((s) => s.filter);
  const hiddenLines = useTree((s) => s.hiddenLines);
  const items = useMemo(() => visibleItems(files, expanded, vaultPath, null, filter, hiddenLines), [files, expanded, vaultPath, filter, hiddenLines]);
  return (
    <div data-el="file-tree-fallback" className="h-full flex flex-col bg-card border-r border-border">
      {info.off ? (
        <PluginOff path={FILETREE_PLUGIN.id} desired={info.off} className="border-b border-border/50 shrink-0" />
      ) : (
        <div data-el="file-tree-fallback-error" className="flex items-center gap-2 px-3 py-2 border-b border-border/50 shrink-0 text-[11.5px] text-muted-foreground">
          <span className="truncate" title={info.error ?? ""}>The file tree stopped; a plain one until it is back.</span>
          <button type="button" data-el="plugin-reload" onClick={info.retry} className="shrink-0 rounded-md border border-border/60 px-2 py-0.5 text-[11.5px] hover:text-foreground">
            Reload
          </button>
        </div>
      )}
      <div className="flex-1 overflow-auto py-1">
        {!vaultPath && <div className="px-4 py-8 text-center text-[12px] text-muted-foreground">Open a folder to begin.</div>}
        {items.slice(0, FALLBACK_ROWS).map((it) => {
          if (it.kind !== "row") return null;
          const f = it.f;
          return (
            <div
              key={f.path}
              data-el="file-tree-fallback-row"
              data-tree-path={f.path}
              className={cn(
                "mx-1 flex items-center gap-1 px-2 h-[25px] text-[12.5px] cursor-pointer select-none rounded-sm",
                f.is_dir ? "text-muted-foreground hover:text-foreground/90" : "hover:bg-accent/60",
                currentFile === f.path && "bg-accent text-accent-foreground",
              )}
              style={{ paddingLeft: 8 + f.depth * 12 }}
              onClick={() => clickRow(f, false)}
            >
              {f.is_dir ? (
                it.open ? <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-70" />
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
