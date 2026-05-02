import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, X as XIcon, Camera, Send, Bug, Sparkles, ExternalLink } from "lucide-react";
import { useStore } from "./store";
import { anchorImages, type NoteAnchor } from "./notes";
import { fileKind } from "./fileKind";
import { Button, Textarea } from "./ui";
import { cn } from "./lib/utils";
import { submitFeedback, type FeedbackKind } from "./feedback";

// "Send feedback" composer. Visually mirrors NotePopup but with an
// indigo accent so it's unmistakably not a note. Files a GitHub issue
// — Bug → label `auto-fix:queued` (one-shot, picked up by the nightly
// auto-fix routine); Feature → label `task:in-progress` (long-running,
// owned by the maintainer app's iterative agent). Issue management
// (verify/close/re-queue) lives in the maintainer app, not here, so
// this popup stays single-purpose: file new feedback fast.

type FeedbackPopupProps = {
  open: boolean;
  onClose: () => void;
  initialDraft?: string;
  initialAnchors?: NoteAnchor[];
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

type SendState =
  | { phase: "idle" }
  | { phase: "sending" }
  | { phase: "ok"; number: number; url: string }
  | { phase: "error"; message: string };

export function FeedbackPopup({ open, onClose, initialDraft = "", initialAnchors }: FeedbackPopupProps) {
  const currentFile = useStore((s) => s.currentFile);
  const files = useStore((s) => s.files);
  const vaultPath = useStore((s) => s.vaultPath);
  const githubPat = useStore((s) => s.serviceKeys.github_pat);
  const setShowSettings = useStore((s) => s.setShowSettings);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const pickerRef = useRef<HTMLInputElement | null>(null);

  const [anchors, setAnchors] = useState<NoteAnchor[]>([]);
  const [pickerQuery, setPickerQuery] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerIdx, setPickerIdx] = useState(0);
  const [send, setSend] = useState<SendState>({ phase: "idle" });
  // Bug → one-shot fix flow (auto-fix:queued). Feature → long-running
  // task flow owned by the maintainer app (task:in-progress).
  const [kind, setKind] = useState<FeedbackKind>("bug");

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
    setSend({ phase: "idle" });
    setKind("bug");
  }, [open, initialAnchors, currentFile]);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (pickerOpen) return;
        e.preventDefault();
        if (send.phase === "sending") return;
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, pickerOpen, send.phase]);

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
    const k: NoteAnchor["source_kind"] = hit.is_dir ? "code" : kindOf(hit.path);
    const isPrimary = anchors.length === 0;
    setAnchors([
      ...anchors,
      { source_path: hit.path, source_kind: k, source_anchor: null, primary: isPrimary },
    ]);
    setPickerOpen(false);
    setPickerQuery("");
  };

  const removeAnchor = (path: string) => {
    setAnchors((prev) => {
      const next = prev.filter((a) => a.source_path !== path);
      if (next.length > 0 && !next.some((a) => a.primary)) {
        next[0] = { ...next[0], primary: true };
      }
      return next;
    });
  };

  const captureRegion = () => {
    const draft = textareaRef.current?.value ?? "";
    const s = useStore.getState();
    s.setNoteCapturePending(false);
    s.setChatPaneCapturePending(false);
    s.setEditPromptCapturePending(false);
    s.stashFeedbackForCapture({ draft, anchors });
    window.dispatchEvent(new CustomEvent("vc-marquee-toggle"));
  };

  const removeImage = (path: string, index: number) => {
    setAnchors((prev) =>
      prev.map((a) => {
        if (a.source_path !== path) return a;
        const list = anchorImages(a);
        const next = list.filter((_, i) => i !== index);
        return { ...a, image_data_url: next[0] ?? null, images: next };
      }),
    );
  };

  const currentCanMarquee = (() => {
    if (!currentFile) return false;
    const k = fileKind(currentFile).kind;
    return k === "pdf" || k === "html" || k === "image";
  })();

  if (!open) return null;

  const trySend = async () => {
    const ref = textareaRef.current;
    const text = ref?.value.trim() ?? "";
    if (!text && anchors.every((a) => anchorImages(a).length === 0)) {
      setSend({ phase: "error", message: "Add a description or attach an image first." });
      return;
    }
    if (!githubPat) {
      setSend({
        phase: "error",
        message: "No GitHub token configured. Add one in Settings → Send feedback.",
      });
      return;
    }
    setSend({ phase: "sending" });
    try {
      const created = await submitFeedback(githubPat, { text, anchors, kind });
      setSend({ phase: "ok", number: created.number, url: created.url });
    } catch (e) {
      setSend({ phase: "error", message: stringifyError(e) });
    }
  };

  const onTextareaKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.key === "Enter" && (e.ctrlKey || e.metaKey)) || (e.key === "Enter" && !e.shiftKey)) {
      e.preventDefault();
      trySend();
    }
  };

  const sending = send.phase === "sending";
  const sentOk = send.phase === "ok";

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[18vh] bg-black/40 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (sending) return;
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-[540px] max-w-[92vw] rounded-xl border-2 border-indigo-500/40 bg-card shadow-xl overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-stretch border-b border-border bg-muted/30">
          <div className="px-4 py-2 text-[12px] font-medium text-foreground/90">Send feedback</div>
          <div className="ml-auto flex items-center pr-3 text-[10.5px] text-muted-foreground/80">
            Enter to send · Shift+Enter newline · Esc cancels
          </div>
        </div>

        <div className="p-4 space-y-3">
          {sentOk && send.phase === "ok" ? (
            <div className="space-y-3 py-2">
              <div className="text-[12.5px] text-foreground/90">
                ✅ Filed as{" "}
                <a
                  href={send.url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-indigo-400 hover:underline inline-flex items-center gap-1"
                >
                  #{send.number}
                  <ExternalLink className="h-3 w-3" />
                </a>
                .{" "}
                {kind === "feature"
                  ? "Iterate on it via the maintainer app's Tasks tab."
                  : "The auto-fix agent will pick it up on its next run."}
              </div>
              <div className="flex justify-end">
                <Button size="sm" onClick={onClose}>
                  Close
                </Button>
              </div>
            </div>
          ) : (
            <>
              {/* Bug / Feature toggle. Bug = fast one-shot fix. Feature
                  = slow iterative task owned by the maintainer agent. */}
              <div className="inline-flex rounded-md border border-border bg-background overflow-hidden text-[11.5px]">
                <button
                  onClick={() => setKind("bug")}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1.5 transition-colors",
                    kind === "bug"
                      ? "bg-indigo-500 text-white"
                      : "text-muted-foreground hover:bg-accent/60",
                  )}
                  title="One-shot fix — auto-fix:queued, agent ships overnight"
                >
                  <Bug className="h-3 w-3" /> Bug
                </button>
                <button
                  onClick={() => setKind("feature")}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1.5 transition-colors border-l border-border",
                    kind === "feature"
                      ? "bg-indigo-500 text-white"
                      : "text-muted-foreground hover:bg-accent/60",
                  )}
                  title="Long-running task — task:in-progress, iterate via maintainer app"
                >
                  <Sparkles className="h-3 w-3" /> Feature
                </button>
              </div>

              <div className="space-y-1">
                {anchors.map((a, i) => (
                  <div
                    key={`${a.source_path}:${i}`}
                    className={cn(
                      "flex items-center gap-2 text-[11.5px] rounded border px-2 py-1 font-mono group",
                      "border-indigo-500/40 bg-indigo-500/10 text-foreground/90",
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
                              "flex items-center gap-2 px-2 py-1 rounded cursor-pointer",
                              i === pickerIdx ? "bg-accent" : "hover:bg-accent/60",
                            )}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              addAnchor(m);
                            }}
                            onMouseEnter={() => setPickerIdx(i)}
                          >
                            <span className="text-indigo-400 font-mono text-[11.5px] font-medium shrink-0 truncate max-w-[50%]">
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
                    No file anchored — feedback will go through with just the text.
                  </div>
                )}
              </div>

              <Textarea
                ref={textareaRef}
                defaultValue={initialDraft}
                placeholder={
                  kind === "feature"
                    ? "Describe the feature or idea. Agent will reply with options or questions; you iterate from the maintainer app."
                    : "What's broken? The cloud agent will read this and try to fix it."
                }
                onKeyDown={onTextareaKey}
                className="min-h-[96px] text-[13px]"
                disabled={sending}
              />

              {!githubPat && (
                <div className="text-[11px] text-indigo-400 leading-relaxed">
                  No GitHub token configured.{" "}
                  <button
                    onClick={() => {
                      onClose();
                      setShowSettings(true);
                    }}
                    className="underline hover:text-indigo-300"
                  >
                    Add one in Settings →
                  </button>
                </div>
              )}

              {send.phase === "error" && (
                <div className="text-[11.5px] text-destructive leading-relaxed">{send.message}</div>
              )}

              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={onClose} disabled={sending}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={trySend}
                  disabled={sending || !githubPat}
                  className="bg-indigo-500 text-white hover:bg-indigo-400"
                >
                  <Send className="h-3 w-3 mr-1.5" />
                  {sending ? "Filing…" : `File ${kind === "feature" ? "feature" : "bug"}`}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function stringifyError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
