import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, X as XIcon, Camera } from "lucide-react";
import { useStore } from "./store";
import { buildNote, anchorImages, type NoteAnchor } from "./notes";
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
  const files = useStore((s) => s.files);
  const vaultPath = useStore((s) => s.vaultPath);
  const addNote = useStore((s) => s.addNote);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const pickerRef = useRef<HTMLInputElement | null>(null);
  const [anchors, setAnchors] = useState<NoteAnchor[]>([]);
  const [pickerQuery, setPickerQuery] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerIdx, setPickerIdx] = useState(0);

  // Seed anchors when the popup opens — from initialAnchors if the
  // caller supplied them (e.g. InlineEditPrompt save-as-note), else
  // from the currently open file. Re-seed on each open so reopening
  // after a save starts fresh.
  useEffect(() => {
    if (!open) return;
    if (initialAnchors && initialAnchors.length > 0) {
      setAnchors(initialAnchors);
    } else if (currentFile) {
      setAnchors([
        {
          source_path: currentFile,
          source_kind: kindOf(currentFile),
          source_anchor: null,
          primary: true,
        },
      ]);
    } else {
      setAnchors([]);
    }
    setPickerOpen(false);
    setPickerQuery("");
  }, [open, initialAnchors, currentFile]);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Give the picker a chance to consume Escape first.
        if (pickerOpen) return;
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, pickerOpen]);

  // Build matches for the "link another file" picker. Includes dirs.
  const pickerMatches = useMemo(() => {
    if (!pickerOpen || !vaultPath) return [] as Array<{ path: string; name: string; rel: string; is_dir: boolean }>;
    const q = pickerQuery.trim().toLowerCase();
    const taken = new Set(anchors.map((a) => a.source_path));
    const hits: Array<{ path: string; name: string; rel: string; is_dir: boolean; score: number }> = [];
    for (const f of files) {
      if (f.hidden) continue;
      if (taken.has(f.path)) continue;
      const rel = f.path.startsWith(vaultPath + "/")
        ? f.path.slice(vaultPath.length + 1)
        : f.path;
      const nameLower = f.name.toLowerCase();
      const relLower = rel.toLowerCase();
      let score: number;
      if (!q) score = 10;
      else if (nameLower.startsWith(q)) score = 100 - Math.abs(nameLower.length - q.length);
      else if (nameLower.includes(q)) score = 60 - nameLower.indexOf(q);
      else if (relLower.includes(q)) score = 30 - relLower.indexOf(q);
      else continue;
      hits.push({ path: f.path, name: f.name, rel, is_dir: f.is_dir, score });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, 6).map(({ score: _s, ...h }) => h);
  }, [pickerOpen, pickerQuery, files, vaultPath, anchors]);

  const addAnchor = (hit: { path: string; name: string; rel: string; is_dir: boolean }) => {
    const kind: NoteAnchor["source_kind"] = hit.is_dir
      ? "code" /* dirs don't have their own kind; reuse */
      : kindOf(hit.path);
    const isPrimary = anchors.length === 0;
    setAnchors([
      ...anchors,
      {
        source_path: hit.path,
        source_kind: kind,
        source_anchor: null,
        primary: isPrimary,
      },
    ]);
    setPickerOpen(false);
    setPickerQuery("");
  };

  const removeAnchor = (path: string) => {
    setAnchors((prev) => {
      const next = prev.filter((a) => a.source_path !== path);
      // If we removed the primary, promote the first remaining.
      if (next.length > 0 && !next.some((a) => a.primary)) {
        next[0] = { ...next[0], primary: true };
      }
      return next;
    });
  };

  // Hide the popup, trigger marquee on the current viewer, then let
  // the viewer reopen the popup with the captured image attached.
  const captureRegion = () => {
    const draft = textareaRef.current?.value ?? "";
    useStore.getState().stashNoteForCapture({
      draft,
      anchors,
      turns: initialTurns,
    });
    // Toggle marquee on whichever viewer is currently mounted.
    window.dispatchEvent(new CustomEvent("vc-marquee-toggle"));
  };

  const removeImage = (path: string, index: number) => {
    setAnchors((prev) =>
      prev.map((a) => {
        if (a.source_path !== path) return a;
        const list = anchorImages(a);
        const next = list.filter((_, i) => i !== index);
        return {
          ...a,
          image_data_url: next[0] ?? null,
          images: next,
        };
      }),
    );
  };

  // Gate the Capture button on what's currently in the viewer, not
  // on the note's primary anchor — the user might be anchored to a
  // markdown note but viewing a PDF they want to clip from.
  const currentCanMarquee = (() => {
    if (!currentFile) return false;
    const k = fileKind(currentFile).kind;
    return k === "pdf" || k === "html" || k === "image";
  })();

  if (!open) return null;

  const save = async () => {
    const ref = textareaRef.current;
    const draft = ref?.value.trim() ?? "";
    // Allow empty-text saves — anchor-only "bookmark" notes are valid.
    const note = buildNote({
      anchors,
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

        <div className="space-y-1">
          {anchors.map((a, i) => (
            <div
              key={`${a.source_path}:${i}`}
              className={cn(
                "flex items-center gap-2 text-[11.5px] rounded border px-2 py-1 font-mono group",
                "border-primary/30 bg-primary/10 text-foreground/90",
              )}
            >
              <span>📎</span>
              <span className="truncate flex-1 min-w-0" title={a.source_path}>
                {a.source_path.split("/").pop() || a.source_path}
              </span>
              {a.source_anchor && (
                <span className="text-muted-foreground/90 shrink-0">· {a.source_anchor}</span>
              )}
              {a.primary && anchors.length > 1 && (
                <span className="shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground/80">
                  primary
                </span>
              )}
              <button
                onClick={() => removeAnchor(a.source_path)}
                className="shrink-0 h-4 w-4 flex items-center justify-center rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive opacity-60 group-hover:opacity-100"
                title="Remove anchor"
              >
                <XIcon className="h-3 w-3" />
              </button>
            </div>
          ))}

          {pickerOpen ? (
            <div className="rounded border border-border bg-background p-1.5 space-y-1">
              <input
                ref={pickerRef}
                type="search"
                autoFocus
                value={pickerQuery}
                onChange={(e) => {
                  setPickerQuery(e.target.value);
                  setPickerIdx(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    setPickerOpen(false);
                    setPickerQuery("");
                  } else if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setPickerIdx((i) => Math.min(i + 1, pickerMatches.length - 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setPickerIdx((i) => Math.max(i - 1, 0));
                  } else if (e.key === "Enter" || e.key === "Tab") {
                    e.preventDefault();
                    const hit = pickerMatches[pickerIdx] ?? pickerMatches[0];
                    if (hit) addAnchor(hit);
                  }
                }}
                placeholder="Search files or folders…"
                className="w-full h-6 px-2 rounded bg-background text-[11.5px] outline-none placeholder:text-muted-foreground/60"
              />
              {pickerMatches.length > 0 && (
                <div className="max-h-[160px] overflow-auto">
                  {pickerMatches.map((m, i) => (
                    <div
                      key={m.path}
                      className={cn(
                        "flex items-baseline gap-2 px-2 py-1 cursor-pointer rounded",
                        i === pickerIdx ? "bg-accent" : "hover:bg-accent/60",
                      )}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        addAnchor(m);
                      }}
                      onMouseEnter={() => setPickerIdx(i)}
                    >
                      <span className="text-primary font-mono text-[11.5px] font-medium shrink-0 truncate max-w-[50%]">
                        {m.is_dir ? `${m.name}/` : m.name}
                      </span>
                      <span className="text-muted-foreground text-[10.5px] truncate font-mono">
                        {m.rel}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-4">
              <button
                onClick={() => setPickerOpen(true)}
                className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground"
              >
                <Plus className="h-3 w-3" />
                Link another file or folder
              </button>
              {currentCanMarquee && (
                <button
                  onClick={captureRegion}
                  className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                  title="Hide this popup, draw a region in the current viewer, then come back with the image attached"
                >
                  <Camera className="h-3 w-3" />
                  Capture region
                </button>
              )}
            </div>
          )}

          {/* Image thumbnails — every image on every anchor, each
              with its own remove. Captures accumulate so multiple
              marquees add up instead of replacing each other. */}
          {anchors.some((a) => anchorImages(a).length > 0) && (
            <div className="flex flex-wrap gap-2 pt-1">
              {anchors.flatMap((a) =>
                anchorImages(a).map((url, i) => (
                  <div key={`${a.source_path}:${i}`} className="relative group">
                    <img
                      src={url}
                      alt={`captured region ${i + 1}`}
                      className="max-h-[90px] rounded border border-border/60"
                    />
                    <button
                      onClick={() => removeImage(a.source_path, i)}
                      className="absolute -top-1.5 -right-1.5 h-5 w-5 flex items-center justify-center rounded-full bg-card border border-border text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100"
                      title="Remove image"
                    >
                      <XIcon className="h-3 w-3" />
                    </button>
                  </div>
                )),
              )}
            </div>
          )}

          {anchors.length === 0 && (
            <div className="text-[11.5px] text-muted-foreground italic">
              No file anchored — this note will have no source.
            </div>
          )}
        </div>

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
