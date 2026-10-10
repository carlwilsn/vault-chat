// The two detail panes the history styles share: one entry (its notes and
// Undo/Redo), and one note (its versions, Preview / Diff vs now, Restore).

import { useEffect, useState } from "react";
import { Undo2, Redo2 } from "lucide-react";
import { useStore } from "./store";
import { cn } from "./lib/utils";
import {
  fullTime,
  historyDiff,
  historyFileAt,
  leafOf,
  restoreNote,
  undoEntry,
  type HistoryEntry,
  type NoteVersion,
} from "./history";
import {
  ActorChip,
  DiffView,
  HistoricalPreview,
  LineCounts,
  MoreSentinel,
  StatusGlyph,
  VersionRow,
  useNoteVersions,
} from "./historyParts";

export const BUTTON =
  "h-7 px-3 rounded text-[12px] border border-border hover:bg-accent/60 flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed shrink-0 whitespace-nowrap";

/** Undo / Redo with the outcome: a toast, an error, or the conflicting notes. */
export function useEntryAction(onChanged: () => void) {
  const vault = useStore((s) => s.vaultPath);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<{ entry: HistoryEntry; paths: string[] } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const run = async (entry: HistoryEntry) => {
    if (!vault || busy) return;
    // An undone entry is redone by undoing its undo; a live undo's own
    // action is Redo.
    const target = entry.undone_by ?? entry.id;
    const isRedo = isRedoAction(entry);
    setBusy(true);
    setError(null);
    setConflicts(null);
    try {
      const r = await undoEntry(vault, target, isRedo && (!!entry.undone_by || entry.kind === "undo"));
      if (r.ok) {
        setToast(isRedo ? "Redone" : "Undone");
        window.setTimeout(() => setToast(null), 3000);
        onChanged();
      } else {
        setConflicts({ entry, paths: r.conflicts });
      }
    } catch (e) {
      setError(String(e));
    }
    setBusy(false);
  };
  const reset = () => {
    setError(null);
    setConflicts(null);
  };
  return { busy, error, conflicts, toast, run, reset };
}

export type EntryAction = ReturnType<typeof useEntryAction>;

/** Redo for an undone entry or a live undo; Undo otherwise. */
export function isRedoAction(e: HistoryEntry): boolean {
  return !!e.undone_by || e.kind === "undo";
}

export function actionLabel(e: HistoryEntry, busy: boolean): string {
  if (busy) return isRedoAction(e) ? "Redoing…" : "Undoing…";
  return isRedoAction(e) ? "Redo" : "Undo this change";
}

export function ActionButton({ entry, action }: { entry: HistoryEntry; action: EntryAction }) {
  const Icon = isRedoAction(entry) ? Redo2 : Undo2;
  return (
    <button onClick={() => action.run(entry)} disabled={action.busy || entry.files.length === 0} className={BUTTON}>
      <Icon className="h-3 w-3" />
      {actionLabel(entry, action.busy)}
    </button>
  );
}

/** "Couldn't undo cleanly" — each note offered on its own. */
export function ConflictList({ entry, paths, onRestored }: { entry: HistoryEntry; paths: string[]; onRestored: () => void }) {
  const vault = useStore((s) => s.vaultPath);
  const [done, setDone] = useState<Set<string>>(new Set());
  const canRestore = entry.base && !/^4b825dc6/.test(entry.base);
  return (
    <div className="px-4 py-2 border-t border-border/60 bg-muted/30">
      <div className="text-[11px] text-muted-foreground mb-1">
        Later edits overlap this change, so nothing was undone. You can put each note back as it was before it:
      </div>
      {paths.map((p) => (
        <div key={p} className="flex items-center gap-2 py-0.5">
          <span className="text-[11.5px] font-mono truncate flex-1">{p}</span>
          {canRestore && (
            <button
              disabled={done.has(p)}
              onClick={async () => {
                if (!vault) return;
                await restoreNote(vault, p, entry.base);
                setDone((s) => new Set(s).add(p));
                onRestored();
              }}
              className="text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-40"
            >
              {done.has(p) ? "Restored" : "Restore this version"}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/** One entry: header, its notes, the mission's own commits, Undo/Redo. */
export function EntryDetail({
  entry,
  action,
  onOpenFile,
  onRestored,
}: {
  entry: HistoryEntry;
  action: EntryAction;
  onOpenFile: (path: string) => void;
  onRestored: () => void;
}) {
  const [showInner, setShowInner] = useState(false);
  const span =
    entry.start !== entry.end ? `${fullTime(entry.start)} – ${fullTime(entry.end).split(", ").pop()}` : fullTime(entry.end);
  return (
    <>
      <div className="px-4 py-3 border-b border-border/60 shrink-0">
        <div className={cn("text-[12.5px]", entry.undone_by ? "line-through text-muted-foreground" : "text-foreground")}>{entry.title}</div>
        <div className="text-[10.5px] text-muted-foreground mt-0.5 flex items-center gap-2 flex-wrap">
          <span>{span}</span>
          <ActorChip actor={entry.actor} machine={entry.machine} />
          {entry.commits.length > 1 && <span>{entry.commits.length} saves</span>}
          {entry.cost_usd != null && <span>${entry.cost_usd.toFixed(2)}</span>}
        </div>
        {entry.summary && entry.kind === "session" && <div className="text-[11.5px] text-muted-foreground mt-1">{entry.summary}</div>}
      </div>
      <div className="flex-1 overflow-auto">
        {entry.files.length === 0 ? (
          <div className="p-4 text-[12px] text-muted-foreground">This entry changed no notes.</div>
        ) : (
          <ul className="divide-y divide-border/40">
            {entry.files.map((f) => (
              <li key={f.path}>
                <button
                  onClick={() => onOpenFile(f.path)}
                  className="w-full text-left px-4 py-2 flex items-center gap-3 hover:bg-accent/40"
                  title="See this note's versions"
                >
                  <StatusGlyph status={f.status} />
                  <span className="min-w-0 flex-1">
                    <div className="text-[12px] text-foreground truncate">{leafOf(f.path)}</div>
                    <div className="text-[10.5px] text-muted-foreground font-mono truncate">{f.path}</div>
                  </span>
                  <LineCounts add={f.add} del={f.del} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {entry.inner && entry.inner.length > 0 && (
          <div className="px-4 py-2">
            <button onClick={() => setShowInner((v) => !v)} className="text-[10.5px] text-muted-foreground hover:text-foreground">
              {showInner ? "Hide" : "Show"} the mission's {entry.inner.length} steps
            </button>
            {showInner &&
              entry.inner.map((c) => (
                <div key={c.hash} className="text-[10.5px] font-mono text-muted-foreground truncate py-0.5">
                  {c.hash.slice(0, 7)} · {c.subject}
                </div>
              ))}
          </div>
        )}
      </div>
      {action.conflicts && action.conflicts.entry.id === entry.id && (
        <ConflictList entry={entry} paths={action.conflicts.paths} onRestored={onRestored} />
      )}
      <div className="border-t border-border/60 px-4 py-2.5 flex items-center gap-3 shrink-0">
        <span className="text-[11px] min-w-0 flex-1 truncate text-muted-foreground">
          {action.error ? (
            <span className="text-destructive">{action.error}</span>
          ) : action.toast ? (
            <span className="text-emerald-600">{action.toast}</span>
          ) : entry.undone_by ? (
            "Undone. Redo puts it back."
          ) : (
            "Click a note to see its versions."
          )}
        </span>
        <ActionButton entry={entry} action={action} />
      </div>
    </>
  );
}

/** One note: its versions (a vertical list), Preview / Diff vs now, Restore. */
export function NotePane({ path, pin, onChanged, header }: { path: string; pin?: string[] | null; onChanged: () => void; header?: React.ReactNode }) {
  const vault = useStore((s) => s.vaultPath);
  const { versions, loaded, hasMore, more, reload } = useNoteVersions(vault, path);
  const [sel, setSel] = useState<NoteVersion | null>(null);
  const [tab, setTab] = useState<"preview" | "diff">("preview");
  const [content, setContent] = useState("");
  const [diff, setDiff] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!loaded) return;
    const pinned = pin ? versions.find((v) => pin.includes(v.hash) || pin.includes(v.entry_id)) : null;
    setSel(pinned ?? versions[0] ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, path, pin]);

  useEffect(() => {
    if (!vault || !sel) return;
    let live = true;
    setLoading(true);
    Promise.all([historyFileAt(vault, sel.hash, path), historyDiff(vault, sel.hash, path, "disk")])
      .then(([c, d]) => {
        if (!live) return;
        setContent(c);
        setDiff(d);
      })
      .catch(() => {})
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [vault, sel, path]);

  const isCurrent = sel && versions[0] && sel.hash === versions[0].hash;
  const restore = async () => {
    if (!vault || !sel || busy) return;
    setBusy(true);
    try {
      await restoreNote(vault, path, sel.hash);
      setToast(`Restored ${leafOf(path)}`);
      window.setTimeout(() => setToast(null), 3000);
      await reload();
      onChanged();
    } catch (e) {
      setToast(String(e));
    }
    setBusy(false);
  };

  return (
    <div className="flex-1 flex min-h-0 min-w-0">
      <div className="w-[240px] border-r border-border/60 flex flex-col shrink-0 min-h-0">
        {header}
        <div className="px-3 pt-2 pb-1 text-[10.5px] text-muted-foreground uppercase tracking-wide">Versions of {leafOf(path)}</div>
        <div className="flex-1 overflow-auto">
          {!loaded && <div className="p-3 text-[12px] text-muted-foreground">Loading…</div>}
          {loaded && versions.length === 0 && <div className="p-3 text-[11px] text-muted-foreground">No saved versions yet.</div>}
          {versions.map((v, i) => (
            <VersionRow key={v.hash} v={v} current={i === 0} selected={sel?.hash === v.hash} onClick={() => setSel(v)} />
          ))}
          {hasMore && <MoreSentinel onMore={more} />}
        </div>
      </div>
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        <div className="border-b border-border/60 px-3 py-1.5 flex items-center gap-3 shrink-0">
          {(["preview", "diff"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                "text-[11px] py-0.5",
                tab === t ? "text-foreground border-b-2 border-primary" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t === "preview" ? "Preview" : "Diff vs now"}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="p-4 text-[12px] text-muted-foreground">Loading…</div>
          ) : !sel ? (
            <div className="p-4 text-[12px] text-muted-foreground">Pick a version.</div>
          ) : tab === "preview" ? (
            <HistoricalPreview path={path} content={content} deleted={sel.deleted} />
          ) : (
            <DiffView diff={diff} />
          )}
        </div>
        <div className="border-t border-border/60 px-4 py-2.5 flex items-center gap-3 shrink-0">
          <span className="text-[11px] min-w-0 flex-1 truncate">
            {toast ? (
              <span className={toast.startsWith("Restored") ? "text-emerald-600" : "text-destructive"}>{toast}</span>
            ) : (
              <span className="text-muted-foreground">{sel && isCurrent ? "This is the note as it is now." : sel ? fullTime(sel.time) : ""}</span>
            )}
          </span>
          <button onClick={restore} disabled={!sel || busy || !!isCurrent} className={BUTTON}>
            <Undo2 className="h-3 w-3" />
            {busy ? "Restoring…" : "Restore this version"}
          </button>
        </div>
      </div>
    </div>
  );
}
