import { useEffect, useRef } from "react";
import { useStore } from "./store";
import { buildNote, type NoteAnchor } from "./notes";
import { fileKind } from "./fileKind";
import { Button, Textarea } from "./ui";
import { cn } from "./lib/utils";

// Lightweight capture popover. Triggered by Ctrl+N or the "Save as
// note" button on InlineEditPrompt. Stores a text draft + the current
// file as a primary anchor. Image capture + multi-anchor are v2.

type NotePopupProps = {
  open: boolean;
  onClose: () => void;
  // Draft seed (when promoted from ask mode, fill with the conversation).
  initialDraft?: string;
  initialAnchors?: NoteAnchor[];
  initialTurns?: { role: "user" | "assistant"; content: string }[];
  /**
   * Called after save succeeds — primarily for callers that want to
   * close a parent popover (e.g. InlineEditPrompt save-as-note).
   */
  onSaved?: () => void;
};

function kindOf(path: string): NoteAnchor["source_kind"] {
  if (!path) return "none";
  const { kind } = fileKind(path);
  if (kind === "markdown") return "markdown";
  if (kind === "pdf") return "pdf";
  if (kind === "html") return "html";
  if (kind === "image") return "image";
  if (kind === "notebook") return "notebook";
  return "code";
}

export function NotePopup({
  open,
  onClose,
  initialDraft = "",
  initialAnchors,
  initialTurns = [],
  onSaved,
}: NotePopupProps) {
  const currentFile = useStore((s) => s.currentFile);
  const addNote = useStore((s) => s.addNote);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [open]);

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

  const resolvedAnchors: NoteAnchor[] =
    initialAnchors && initialAnchors.length > 0
      ? initialAnchors
      : currentFile
        ? [
            {
              source_path: currentFile,
              source_kind: kindOf(currentFile),
              source_anchor: null,
              primary: true,
            },
          ]
        : [];

  const save = async () => {
    const ref = textareaRef.current;
    const draft = ref?.value.trim() ?? "";
    // Allow empty-text saves — anchor-only "bookmark" notes are valid.
    const note = buildNote({
      anchors: resolvedAnchors,
      turns: initialTurns,
      userDraft: draft || null,
    });
    await addNote(note);
    onClose();
    onSaved?.();
  };

  const onTextareaKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.key === "Enter" && (e.ctrlKey || e.metaKey)) || (e.key === "Enter" && !e.shiftKey)) {
      e.preventDefault();
      save();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[22vh] bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-[460px] max-w-[92vw] rounded-xl border border-border bg-card shadow-xl p-4 space-y-3"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            New note
          </div>
          <div className="text-[10.5px] text-muted-foreground/80">
            Enter to save · Shift+Enter for newline · Esc cancels
          </div>
        </div>

        {resolvedAnchors.length > 0 ? (
          <div className="space-y-1">
            {resolvedAnchors.map((a, i) => (
              <div
                key={`${a.source_path}:${i}`}
                className={cn(
                  "flex items-center gap-2 text-[11.5px] rounded border px-2 py-1 font-mono",
                  "border-primary/30 bg-primary/10 text-foreground/90",
                )}
              >
                <span>📎</span>
                <span className="truncate" title={a.source_path}>
                  {a.source_path.split("/").pop()}
                </span>
                {a.source_anchor && (
                  <span className="text-muted-foreground/90">· {a.source_anchor}</span>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="text-[11.5px] text-muted-foreground italic">
            No file anchored — this note will have no source.
          </div>
        )}

        <Textarea
          ref={textareaRef}
          defaultValue={initialDraft}
          placeholder="What are you stuck on? (empty is fine — the anchor alone is a bookmark.)"
          onKeyDown={onTextareaKey}
          className="min-h-[96px] text-[13px]"
        />

        {initialTurns.length > 0 && (
          <details className="text-[11px] text-muted-foreground">
            <summary className="cursor-pointer hover:text-foreground">
              Carrying {initialTurns.length} conversation turn{initialTurns.length === 1 ? "" : "s"} from chat
            </summary>
            <div className="mt-1.5 max-h-[120px] overflow-auto space-y-1.5 rounded border border-border/50 bg-muted/30 p-2">
              {initialTurns.map((t, i) => (
                <div key={i}>
                  <span className="font-semibold mr-1 opacity-70">{t.role}:</span>
                  <span className="whitespace-pre-wrap">
                    {t.content.slice(0, 240)}
                    {t.content.length > 240 ? "…" : ""}
                  </span>
                </div>
              ))}
            </div>
          </details>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={save}>
            Save note
          </Button>
        </div>
      </div>
    </div>
  );
}
