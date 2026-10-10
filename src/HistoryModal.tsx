// History, style A — "Timeline modal": today's 920px modal, header and tab
// underline kept for muscle memory; the tabs are Timeline | Notes.
//   Timeline: entries (sessions, missions, restores, undos) bucketed by day;
//             the right pane shows one entry's notes and Undo / Redo.
//   Notes:    a note's versions as a vertical list, Preview / Diff vs now,
//             Restore this version.
// Opened with Ctrl+H only; Esc or the backdrop closes it; always the vault root.

import { useEffect, useMemo, useState } from "react";
import { History as HistoryIcon } from "lucide-react";
import { useStore } from "./store";
import { cn } from "./lib/utils";
import { leafOf, type HistoryEntry } from "./history";
import { BucketedEntries, EntryRow, MoreSentinel, StatusGlyph, useTimeline } from "./historyParts";
import { EntryDetail, NotePane, useEntryAction } from "./historyPanes";

type Props = { open: boolean; onClose: () => void };
type Tab = "timeline" | "notes";

export function useEscape(active: boolean, onClose: () => void) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, onClose]);
}

export function relInVault(vault: string | null, file: string | null): string | null {
  if (!vault || !file) return null;
  const v = vault.replace(/\\/g, "/").replace(/\/$/, "");
  const f = file.replace(/\\/g, "/");
  return f.startsWith(v + "/") ? f.slice(v.length + 1) : null;
}

export function HistoryModal({ open, onClose }: Props) {
  const vaultPath = useStore((s) => s.vaultPath);
  const currentFile = useStore((s) => s.currentFile);
  const files = useStore((s) => s.files);
  const [tab, setTab] = useState<Tab>("timeline");
  const tl = useTimeline(vaultPath, open);
  const [selected, setSelected] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pin, setPin] = useState<string[] | null>(null);
  const [cameFrom, setCameFrom] = useState<HistoryEntry | null>(null);
  const [filter, setFilter] = useState("");
  const action = useEntryAction(() => tl.reload());
  useEscape(open, onClose);

  useEffect(() => {
    if (!open) return;
    setTab("timeline");
    setSelected(null);
    setCameFrom(null);
    setPin(null);
    setNote(relInVault(vaultPath, currentFile));
    action.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const notes = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return files
      .filter((f) => !f.is_dir)
      .map((f) => relInVault(vaultPath, f.path))
      .filter((p): p is string => !!p && !p.startsWith(".vault-chat/"))
      .filter((p) => !q || p.toLowerCase().includes(q))
      .sort();
  }, [files, vaultPath, filter]);

  if (!open) return null;
  const entry = tl.entries.find((e) => e.id === selected) ?? null;

  const openNoteFrom = (path: string, from: HistoryEntry) => {
    setCameFrom(from);
    setPin([from.id, ...from.commits]);
    setNote(path);
    setTab("notes");
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-[920px] max-w-[92vw] h-[85vh] flex flex-col rounded-md border border-border bg-card shadow-xl overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-4 pt-4 pb-0 flex items-end justify-between gap-3">
          <div className="flex items-center gap-3">
            <HistoryIcon className="h-4 w-4 text-muted-foreground" />
            <div className="flex">
              {(["timeline", "notes"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={cn(
                    "px-3 py-1.5 text-[12px] border-b-2 -mb-px transition-colors",
                    tab === t ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t === "timeline" ? "Timeline" : "Notes"}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="border-b border-border/60" />

        <div className="flex-1 min-h-0 flex">
          {tab === "timeline" ? (
            <>
              <div className="w-[300px] border-r border-border/60 overflow-auto shrink-0">
                {!tl.loaded && <div className="p-4 text-[12px] text-muted-foreground">Loading…</div>}
                {tl.loaded && tl.entries.length === 0 && (
                  <div className="p-4 text-[12px] text-muted-foreground">{tl.error ?? "No history yet."}</div>
                )}
                <BucketedEntries
                  entries={tl.entries}
                  render={(e) => (
                    <EntryRow
                      key={e.id}
                      entry={e}
                      selected={selected === e.id}
                      onClick={() => {
                        action.reset();
                        setSelected(e.id);
                      }}
                    />
                  )}
                />
                {tl.hasMore && <MoreSentinel onMore={tl.more} />}
              </div>
              <div className="flex-1 flex flex-col min-h-0 min-w-0">
                {!entry ? (
                  <div className="flex-1 flex items-center justify-center text-[12px] text-muted-foreground">
                    Pick a change on the left to see what it did.
                  </div>
                ) : (
                  <EntryDetail entry={entry} action={action} onOpenFile={(p) => openNoteFrom(p, entry)} onRestored={() => tl.reload()} />
                )}
              </div>
            </>
          ) : (
            <>
              <div className="w-[220px] border-r border-border/60 flex flex-col shrink-0">
                <div className="p-2 border-b border-border/40">
                  <input
                    type="search"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="Filter…"
                    className="w-full px-2 py-1 text-[11.5px] rounded bg-muted/40 border border-border focus:outline-none focus:border-ring/40"
                  />
                </div>
                <div className="flex-1 overflow-auto">
                  {notes.map((p) => (
                    <button
                      key={p}
                      onClick={() => {
                        setCameFrom(null);
                        setPin(null);
                        setNote(p);
                      }}
                      className={cn(
                        "w-full text-left px-3 py-1.5 border-b border-border/40 flex items-start gap-2 hover:bg-accent/40",
                        note === p && "bg-accent/60",
                      )}
                    >
                      <StatusGlyph status="" />
                      <span className="min-w-0 flex-1">
                        <div className="text-[12px] text-foreground truncate">{leafOf(p)}</div>
                        <div className="text-[10.5px] text-muted-foreground font-mono truncate">{p}</div>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
              {note ? (
                <div className="flex-1 flex flex-col min-h-0 min-w-0">
                  {cameFrom && (
                    <div className="border-b border-border/60 px-3 py-1.5 shrink-0 bg-muted/30">
                      <button
                        onClick={() => {
                          setTab("timeline");
                          setSelected(cameFrom.id);
                        }}
                        className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                      >
                        <span aria-hidden>←</span>
                        <span>Back to</span>
                        <span className="truncate max-w-[400px]">{cameFrom.title}</span>
                      </button>
                    </div>
                  )}
                  <NotePane key={note} path={note} pin={pin} onChanged={() => tl.reload()} />
                </div>
              ) : (
                <div className="flex-1 flex items-center justify-center text-[12px] text-muted-foreground">
                  Pick a note to see its versions.
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
