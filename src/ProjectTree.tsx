// The file tree of a project that works in a folder on the box (server/projectFolders.ts): read live
// from the box, one folder at a time as Carl opens it; a text file opens in the viewer through the
// box's file route and his edits are written back there (src/boxFiles.ts). The folder is never synced:
// what this shows is the box's folder as it is now.
import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, FileText, RefreshCw } from "lucide-react";
import { useStore } from "./store";
import { cn } from "./lib/utils";
import { isUnreadableAsText } from "./fileKind";
import { boxPathOf, listBoxDir, readTextAt, tildePath, type BoxEntry } from "./boxFiles";

export function ProjectTree({ root, home }: { root: string; home?: string | null }) {
  const currentFile = useStore((s) => s.currentFile);
  const setCurrentFile = useStore((s) => s.setCurrentFile);
  const [kids, setKids] = useState<Map<string, BoxEntry[]>>(new Map());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async (dir: string) => {
    try {
      const entries = await listBoxDir(dir);
      setKids((m) => new Map(m).set(dir, entries));
      setErr(null);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    }
  }, []);

  useEffect(() => {
    setKids(new Map());
    setOpen(new Set());
    void load(root);
  }, [root, load]);

  const refresh = () => {
    for (const d of [root, ...open]) void load(d);
  };

  const toggle = (d: string) => {
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(d)) n.delete(d);
      else {
        n.add(d);
        if (!kids.has(d)) void load(d);
      }
      return n;
    });
  };

  const openFile = async (f: BoxEntry) => {
    const p = boxPathOf(f.path);
    try {
      setCurrentFile(p, await readTextAt(p));
      setErr(null);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    }
  };

  const rows: { f: BoxEntry; depth: number }[] = [];
  const walk = (dir: string, depth: number) => {
    for (const f of kids.get(dir) ?? []) {
      rows.push({ f, depth });
      if (f.is_dir && open.has(f.path)) walk(f.path, depth + 1);
    }
  };
  walk(root, 0);

  return (
    <div className="h-full flex flex-col bg-card" data-el="project-tree" data-root={root}>
      <div className="flex items-center gap-1 px-2 py-1 border-b border-border/50 shrink-0">
        <div className="flex-1 text-[10px] text-muted-foreground/70 font-mono truncate" title={`${root} (on the box)`}>
          {tildePath(root, home)} · box
        </div>
        <button onClick={refresh} title="Refresh from the box" className="h-6 w-6 flex items-center justify-center rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground">
          <RefreshCw className="h-3 w-3" />
        </button>
      </div>
      <div className="flex-1 overflow-auto py-1">
        {rows.map(({ f, depth }) => {
          const text = !f.is_dir && !isUnreadableAsText(f.path);
          const active = currentFile === boxPathOf(f.path);
          return (
            <div
              key={f.path}
              data-box-path={f.path}
              title={f.is_dir || text ? undefined : "Only text files open from the box"}
              onClick={() => (f.is_dir ? toggle(f.path) : text ? void openFile(f) : undefined)}
              className={cn(
                "mx-1 rounded-sm flex items-center gap-1 px-2 h-[25px] text-[12.5px] select-none",
                f.is_dir ? "cursor-pointer text-muted-foreground hover:text-foreground/90" : text ? "cursor-pointer hover:bg-accent/60" : "text-muted-foreground/50",
                active && "bg-accent text-accent-foreground",
              )}
              style={{ paddingLeft: 8 + depth * 12 }}
            >
              {f.is_dir ? (
                open.has(f.path) ? <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-70" />
              ) : (
                <FileText className="h-3.5 w-3.5 shrink-0 opacity-70 ml-3.5" />
              )}
              <span className="truncate">{f.name}</span>
            </div>
          );
        })}
        {!rows.length && !err && <div className="px-4 py-6 text-center text-[12px] text-muted-foreground">{kids.has(root) ? "Empty folder." : "Reading the box…"}</div>}
        {err && <div className="px-3 py-2 text-[11px] text-destructive">{err}</div>}
      </div>
    </div>
  );
}
