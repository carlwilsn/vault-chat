import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  StickyNote,
  CheckCircle2,
  Circle,
  Trash2,
  X as XIcon,
  ChevronDown,
  ChevronRight,
  Sparkles,
  FileText,
  RefreshCw,
  ExternalLink as ExternalLinkIcon,
} from "lucide-react";
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
  const reformatNote = useStore((s) => s.reformatNote);
  const setCurrentFile = useStore((s) => s.setCurrentFile);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showRawId, setShowRawId] = useState<string | null>(null);
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
                expanded={expandedId === n.id}
                showRaw={showRawId === n.id}
                onToggleExpand={() => {
                  const next = expandedId === n.id ? null : n.id;
                  setExpandedId(next);
                  if (next && !n.formatted) reformatNote(n.id);
                }}
                onToggleRaw={() =>
                  setShowRawId(showRawId === n.id ? null : n.id)
                }
                onReformat={() => reformatNote(n.id)}
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
  expanded,
  showRaw,
  onToggleExpand,
  onToggleRaw,
  onReformat,
  onOpen,
  onToggleStatus,
  onDelete,
}: {
  note: Note;
  expanded: boolean;
  showRaw: boolean;
  onToggleExpand: () => void;
  onToggleRaw: () => void;
  onReformat: () => void;
  onOpen: () => void;
  onToggleStatus: () => void;
  onDelete: () => void;
}) {
  const primary = note.anchors.find((a) => a.primary) ?? note.anchors[0];
  const secondaries = note.anchors.filter((a) => a !== primary);
  const bodyPreview =
    note.user_draft ??
    (note.turns[0]?.content
      ? note.turns[0].content.slice(0, 240) +
        (note.turns[0].content.length > 240 ? "…" : "")
      : "(no text)");
  const timeAgo = prettyTime(note.timestamp);
  const images = note.anchors.map((a) => a.image_data_url).filter((u): u is string => !!u);
  const StatusIcon = note.status === "resolved" ? CheckCircle2 : Circle;
  const ExpandIcon = expanded ? ChevronDown : ChevronRight;
  const turnPairs = Math.floor(note.turns.length / 2);

  return (
    <div className="border-b border-border/40">
      <div
        className={cn(
          "px-3 py-2.5 hover:bg-accent/20 group cursor-pointer",
          expanded && "bg-accent/10",
        )}
        onClick={onToggleExpand}
      >
        <div className="flex items-start gap-2">
          <ExpandIcon className="h-3.5 w-3.5 mt-[3px] shrink-0 opacity-60" />
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggleStatus();
            }}
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
                onClick={(e) => {
                  e.stopPropagation();
                  onOpen();
                }}
                className="truncate hover:text-foreground hover:underline underline-offset-2"
                title={primary?.source_path ?? "(no anchor)"}
              >
                {primary ? primary.source_path.split("/").pop() : "(no anchor)"}
                {primary?.source_anchor ? ` · ${primary.source_anchor}` : ""}
              </button>
              <span>·</span>
              <span>{timeAgo}</span>
              {turnPairs > 0 && (
                <>
                  <span>·</span>
                  <span>
                    {turnPairs} turn{turnPairs === 1 ? "" : "s"}
                  </span>
                </>
              )}
              {images.length > 0 && (
                <>
                  <span>·</span>
                  <span>📷</span>
                </>
              )}
            </div>
            {!expanded && (
              <div className="text-[12.5px] text-foreground/90 whitespace-pre-wrap break-words line-clamp-2">
                {bodyPreview}
              </div>
            )}
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive transition-opacity"
            title="Delete"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="px-3 pb-3 pl-[34px] space-y-3 bg-accent/5">
          {/* AI-formatted summary */}
          <div className="rounded-md border border-border/50 bg-card p-3 space-y-2">
            <div className="flex items-center justify-between text-[10.5px] text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Sparkles className="h-3 w-3" />
                Summary
              </span>
              <button
                onClick={onReformat}
                className="h-5 px-1.5 flex items-center gap-1 rounded hover:bg-accent/60 hover:text-foreground"
                title="Regenerate"
              >
                <RefreshCw className="h-3 w-3" />
              </button>
            </div>
            {note.formatted ? (
              <div className="text-[12.5px] text-foreground/90 leading-relaxed whitespace-pre-wrap">
                {note.formatted}
              </div>
            ) : (
              <div className="text-[11.5px] text-muted-foreground italic flex items-center gap-1.5">
                <RefreshCw className="h-3 w-3 animate-spin" />
                Summarizing…
              </div>
            )}
          </div>

          {/* Images */}
          {images.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {images.map((u, i) => (
                <img
                  key={i}
                  src={u}
                  alt={`captured region ${i + 1}`}
                  className="max-h-[160px] rounded border border-border/50"
                />
              ))}
            </div>
          )}

          {/* Anchors list */}
          <div className="space-y-1">
            {[primary, ...secondaries].filter((a): a is typeof primary => !!a).map((a, i) => (
              <div
                key={`${a.source_path}:${i}`}
                className="flex items-center gap-2 text-[11px] font-mono text-muted-foreground"
              >
                <span>📎</span>
                <span className="truncate" title={a.source_path}>
                  {a.source_path.split("/").pop()}
                </span>
                {a.source_anchor && <span>· {a.source_anchor}</span>}
                {!a.primary && <span className="opacity-70">(secondary)</span>}
              </div>
            ))}
          </div>

          {/* Action row */}
          <div className="flex items-center gap-2 text-[11px]">
            <button
              onClick={onOpen}
              className="flex items-center gap-1 h-6 px-2 rounded border border-border/60 text-foreground/80 hover:bg-accent/40"
            >
              <ExternalLinkIcon className="h-3 w-3" />
              Open anchor
            </button>
            <button
              onClick={onToggleRaw}
              className="flex items-center gap-1 h-6 px-2 rounded border border-border/60 text-foreground/80 hover:bg-accent/40"
            >
              <FileText className="h-3 w-3" />
              {showRaw ? "Hide raw" : "View raw"}
            </button>
          </div>

          {/* Raw details (toggle) */}
          {showRaw && (
            <div className="rounded-md border border-border/40 bg-muted/30 p-2 space-y-2 text-[11px] font-mono text-foreground/85">
              {note.user_draft && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">
                    user_draft
                  </div>
                  <div className="whitespace-pre-wrap break-words">
                    {note.user_draft}
                  </div>
                </div>
              )}
              {note.turns.length > 0 && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">
                    turns ({note.turns.length})
                  </div>
                  <div className="space-y-1 max-h-[240px] overflow-auto">
                    {note.turns.map((t, i) => (
                      <div key={i}>
                        <span className="text-muted-foreground mr-1">{t.role}:</span>
                        <span className="whitespace-pre-wrap">{t.content}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {primary?.source_selection && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">
                    selection
                  </div>
                  <div className="whitespace-pre-wrap break-words max-h-[160px] overflow-auto">
                    {primary.source_selection}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
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
