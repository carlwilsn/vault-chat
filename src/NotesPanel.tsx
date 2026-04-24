import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { StickyNote, CheckCircle2, Circle, Trash2, X as XIcon } from "lucide-react";
import { useStore } from "./store";
import type { Note } from "./notes";
import { cn } from "./lib/utils";
import { isUnreadableAsText } from "./fileKind";

// Slide-in review panel for vault notes. Shows active by default;
// toggle pill flips to resolved. Click a card → opens the note's
// anchored source in the viewer. Delete / resolve per-card, clear-
// resolved as a bulk action.

export function NotesPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const notes = useStore((s) => s.notes);
  const deleteNote = useStore((s) => s.deleteNote);
  const setNoteStatus = useStore((s) => s.setNoteStatus);
  const clearResolvedNotes = useStore((s) => s.clearResolvedNotes);
  const setCurrentFile = useStore((s) => s.setCurrentFile);
  const [filter, setFilter] = useState<"active" | "resolved">("active");
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const q = query.trim().toLowerCase();
  const filtered = notes.filter((n) => {
    if (filter === "active" && n.status !== "open") return false;
    if (filter === "resolved" && n.status !== "resolved") return false;
    if (!q) return true;
    const hay = [
      n.user_draft ?? "",
      ...n.turns.map((t) => t.content),
      ...n.anchors.map((a) => a.source_path),
    ]
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });

  const resolvedCount = notes.filter((n) => n.status === "resolved").length;

  const openAnchor = async (note: Note) => {
    const primary = note.anchors.find((a) => a.primary) ?? note.anchors[0];
    if (!primary || !primary.source_path) return;
    try {
      if (isUnreadableAsText(primary.source_path)) {
        setCurrentFile(primary.source_path, "");
      } else {
        const content = await invoke<string>("read_text_file", { path: primary.source_path });
        setCurrentFile(primary.source_path, content);
      }
      onClose();
    } catch (e) {
      console.error("[notes] open anchor failed:", e);
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/30"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="h-full w-[420px] max-w-[92vw] bg-card border-l border-border shadow-xl flex flex-col"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/60">
          <div className="flex items-center gap-2">
            <StickyNote className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-[13px] font-semibold">Notes</span>
            <span className="text-[11px] text-muted-foreground">
              {filtered.length} of {notes.length}
            </span>
          </div>
          <button
            onClick={onClose}
            className="h-7 w-7 flex items-center justify-center rounded hover:bg-accent/60 text-muted-foreground"
            title="Close (Esc)"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="flex items-center gap-2 px-4 py-2 border-b border-border/60">
          <button
            onClick={() => setFilter("active")}
            className={cn(
              "h-6 px-2 rounded-full text-[11px] border",
              filter === "active"
                ? "border-primary/50 bg-primary/15 text-foreground"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            Active ●
          </button>
          <button
            onClick={() => setFilter("resolved")}
            className={cn(
              "h-6 px-2 rounded-full text-[11px] border",
              filter === "resolved"
                ? "border-primary/50 bg-primary/15 text-foreground"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            Resolved ○
          </button>
          <input
            type="search"
            placeholder="Search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="flex-1 h-6 px-2 rounded bg-background border border-border text-[11.5px] placeholder:text-muted-foreground/60 focus:outline-none focus:border-ring/40"
          />
        </div>

        <div className="flex-1 overflow-auto">
          {filtered.length === 0 ? (
            <div className="px-4 py-6 text-center text-[12px] text-muted-foreground">
              {query ? "No matches." : filter === "resolved" ? "No resolved notes yet." : "No notes yet. Ctrl+N to capture one."}
            </div>
          ) : (
            filtered.map((n) => (
              <NoteCard
                key={n.id}
                note={n}
                onOpen={() => openAnchor(n)}
                onToggleStatus={() =>
                  setNoteStatus(n.id, n.status === "open" ? "resolved" : "open")
                }
                onDelete={() => deleteNote(n.id)}
              />
            ))
          )}
        </div>

        {filter === "resolved" && resolvedCount > 0 && (
          <div className="p-3 border-t border-border/60 flex justify-end">
            <button
              onClick={clearResolvedNotes}
              className="h-7 px-3 rounded text-[11.5px] border border-border text-destructive hover:bg-destructive/10"
            >
              Clear all resolved ({resolvedCount})
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function NoteCard({
  note,
  onOpen,
  onToggleStatus,
  onDelete,
}: {
  note: Note;
  onOpen: () => void;
  onToggleStatus: () => void;
  onDelete: () => void;
}) {
  const primary = note.anchors.find((a) => a.primary) ?? note.anchors[0];
  const body =
    note.user_draft ??
    (note.turns[0]?.content
      ? note.turns[0].content.slice(0, 240) + (note.turns[0].content.length > 240 ? "…" : "")
      : "(no text)");
  const timeAgo = prettyTime(note.timestamp);
  const hasImage = note.anchors.some((a) => !!a.image_data_url);
  const StatusIcon = note.status === "resolved" ? CheckCircle2 : Circle;

  return (
    <div className="px-3 py-2.5 border-b border-border/40 hover:bg-accent/20 group">
      <div className="flex items-start gap-2">
        <button
          onClick={onToggleStatus}
          className={cn(
            "mt-[3px] h-3.5 w-3.5 shrink-0",
            note.status === "resolved"
              ? "text-primary"
              : "text-muted-foreground hover:text-foreground",
          )}
          title={note.status === "resolved" ? "Mark open" : "Mark resolved"}
        >
          <StatusIcon className="h-3.5 w-3.5" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 text-[10.5px] text-muted-foreground mb-0.5 font-mono">
            <button
              onClick={onOpen}
              className="truncate hover:text-foreground hover:underline underline-offset-2"
              title={primary?.source_path ?? "(no anchor)"}
            >
              {primary ? primary.source_path.split("/").pop() : "(no anchor)"}
              {primary?.source_anchor ? ` · ${primary.source_anchor}` : ""}
            </button>
            <span>·</span>
            <span>{timeAgo}</span>
            {note.turns.length > 0 && (
              <>
                <span>·</span>
                <span>
                  {Math.floor(note.turns.length / 2)} turn
                  {Math.floor(note.turns.length / 2) === 1 ? "" : "s"}
                </span>
              </>
            )}
            {hasImage && (
              <>
                <span>·</span>
                <span>📷</span>
              </>
            )}
          </div>
          <div className="text-[12.5px] text-foreground/90 whitespace-pre-wrap break-words">
            {body}
          </div>
        </div>
        <button
          onClick={onDelete}
          className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive transition-opacity"
          title="Delete"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

function prettyTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(iso).toLocaleDateString();
}
