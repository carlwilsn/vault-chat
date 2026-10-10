// History, style B — "Side sheet": a 380px slide-over cloned from ChatsPanel,
// so the note stays in view. With a note open it starts on that note's
// versions ("This note | Everything"). A click opens a version's diff (vs the
// note as it is now) right under its row; Restore sits on the row.
// "Everything" is the timeline; a click opens the entry's notes and Undo/Redo
// under its row.

import { useEffect, useState } from "react";
import { History as HistoryIcon, X as XIcon, Undo2 } from "lucide-react";
import { useStore } from "./store";
import { cn } from "./lib/utils";
import { historyDiff, leafOf, restoreNote, type HistoryEntry, type NoteVersion } from "./history";
import { BucketedEntries, DiffView, EntryRow, LineCounts, MoreSentinel, StatusGlyph, VersionRow, useNoteVersions, useTimeline } from "./historyParts";
import { ActionButton, ConflictList, useEntryAction } from "./historyPanes";
import { relInVault, useEscape } from "./HistoryModal";

type Mode = "note" | "all";

export function HistorySheet({ open, onClose, startIn }: { open: boolean; onClose: () => void; startIn?: Mode }) {
  const vault = useStore((s) => s.vaultPath);
  const currentFile = useStore((s) => s.currentFile);
  const [mode, setMode] = useState<Mode>("all");
  const [note, setNote] = useState<string | null>(null);
  useEscape(open, onClose);

  useEffect(() => {
    if (!open) return;
    const rel = relInVault(vault, currentFile);
    setNote(rel);
    setMode(startIn ?? (rel ? "note" : "all"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-30 flex justify-end pointer-events-none">
      <div className="h-full w-[380px] max-w-[92vw] bg-card border-l border-border shadow-xl flex flex-col pointer-events-auto">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/60">
          <div className="flex items-center gap-2">
            <HistoryIcon className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-[13px] font-semibold">History</span>
          </div>
          <button
            onClick={onClose}
            className="h-7 w-7 flex items-center justify-center rounded hover:bg-accent/60 text-muted-foreground"
            title="Close (Esc)"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="flex items-center gap-3 px-4 border-b border-border/60">
          {note && (
            <button
              onClick={() => setMode("note")}
              className={cn(
                "py-1.5 text-[11.5px] border-b-2 -mb-px truncate max-w-[200px]",
                mode === "note" ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
              title={note}
            >
              {leafOf(note)}
            </button>
          )}
          <button
            onClick={() => setMode("all")}
            className={cn(
              "py-1.5 text-[11.5px] border-b-2 -mb-px",
              mode === "all" ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            Everything
          </button>
        </div>
        <div className="flex-1 overflow-auto">
          {mode === "note" && note ? (
            <NoteVersions path={note} />
          ) : (
            <Everything
              onOpenNote={(p) => {
                setNote(p);
                setMode("note");
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function NoteVersions({ path }: { path: string }) {
  const vault = useStore((s) => s.vaultPath);
  const { versions, loaded, hasMore, more, reload } = useNoteVersions(vault, path);
  const [open, setOpen] = useState<string | null>(null);
  const [diff, setDiff] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const toggle = async (v: NoteVersion) => {
    if (open === v.hash) {
      setOpen(null);
      return;
    }
    setOpen(v.hash);
    setDiff("");
    if (vault) setDiff(await historyDiff(vault, v.hash, path, "disk").catch((e) => String(e)));
  };
  const restore = async (v: NoteVersion) => {
    if (!vault || busy) return;
    setBusy(v.hash);
    try {
      await restoreNote(vault, path, v.hash);
      setToast(`Restored ${leafOf(path)}`);
      setOpen(null);
      await reload();
    } catch (e) {
      setToast(String(e));
    }
    setBusy(null);
    window.setTimeout(() => setToast(null), 3000);
  };

  return (
    <>
      {toast && <div className={cn("px-4 py-1.5 text-[11px] border-b border-border/40", toast.startsWith("Restored") ? "text-emerald-600" : "text-destructive")}>{toast}</div>}
      {!loaded && <div className="p-4 text-[12px] text-muted-foreground">Loading…</div>}
      {loaded && versions.length === 0 && <div className="p-4 text-[12px] text-muted-foreground">No saved versions of this note yet.</div>}
      {versions.map((v, i) => (
        <div key={v.hash}>
          <VersionRow
            v={v}
            current={i === 0}
            selected={open === v.hash}
            onClick={() => toggle(v)}
            trailing={
              i > 0 ? (
                <button
                  onClick={() => restore(v)}
                  disabled={!!busy}
                  className="opacity-0 group-hover:opacity-100 transition-opacity h-6 px-2 mr-2 mt-1.5 rounded text-[11px] text-muted-foreground hover:bg-accent/60 hover:text-foreground flex items-center gap-1 shrink-0"
                  title="Make the note this version again"
                >
                  <Undo2 className="h-3 w-3" />
                  {busy === v.hash ? "Restoring…" : "Restore"}
                </button>
              ) : null
            }
          />
          {open === v.hash && (
            <div className="border-b border-border/40 bg-muted/30 max-h-[45vh] overflow-auto">
              <DiffView diff={diff} />
            </div>
          )}
        </div>
      ))}
      {hasMore && <MoreSentinel onMore={more} />}
    </>
  );
}

function Everything({ onOpenNote }: { onOpenNote: (path: string) => void }) {
  const vault = useStore((s) => s.vaultPath);
  const tl = useTimeline(vault, true);
  const [open, setOpen] = useState<string | null>(null);
  const action = useEntryAction(() => tl.reload());
  return (
    <>
      {!tl.loaded && <div className="p-4 text-[12px] text-muted-foreground">Loading…</div>}
      {tl.loaded && tl.entries.length === 0 && <div className="p-4 text-[12px] text-muted-foreground">{tl.error ?? "No history yet."}</div>}
      <BucketedEntries
        entries={tl.entries}
        render={(e: HistoryEntry) => (
          <div key={e.id}>
            <EntryRow
              compact
              entry={e}
              selected={open === e.id}
              onClick={() => {
                action.reset();
                setOpen(open === e.id ? null : e.id);
              }}
            />
            {open === e.id && (
              <div className="border-b border-border/40 bg-muted/30">
                {e.files.map((f) => (
                  <button
                    key={f.path}
                    onClick={() => onOpenNote(f.path)}
                    className="w-full text-left pl-8 pr-4 py-1 flex items-center gap-2 hover:bg-accent/40"
                    title="This note's versions"
                  >
                    <StatusGlyph status={f.status} />
                    <span className="text-[11.5px] truncate flex-1">{f.path}</span>
                    <LineCounts add={f.add} del={f.del} />
                  </button>
                ))}
                {action.conflicts && action.conflicts.entry.id === e.id && (
                  <ConflictList entry={e} paths={action.conflicts.paths} onRestored={() => tl.reload()} />
                )}
                <div className="pl-8 pr-4 py-2 flex items-center gap-2">
                  <span className="text-[11px] flex-1 truncate">
                    {action.error ? (
                      <span className="text-destructive">{action.error}</span>
                    ) : action.toast ? (
                      <span className="text-emerald-600">{action.toast}</span>
                    ) : null}
                  </span>
                  <ActionButton entry={e} action={action} />
                </div>
              </div>
            )}
          </div>
        )}
      />
      {tl.hasMore && <MoreSentinel onMore={tl.more} />}
    </>
  );
}
