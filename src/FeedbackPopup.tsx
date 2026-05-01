import { useEffect, useMemo, useRef, useState } from "react";
import {
  Plus,
  X as XIcon,
  Camera,
  Send,
  ExternalLink,
  RefreshCw,
  Check,
  RotateCw,
  X,
  Play,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { useStore } from "./store";
import { anchorImages, type NoteAnchor } from "./notes";
import { fileKind } from "./fileKind";
import { Button, Textarea } from "./ui";
import { cn } from "./lib/utils";
import { openUrl } from "./opener";
import {
  submitFeedback,
  listFeedbackIssues,
  getIssueComments,
  closeIssue,
  relabelIssue,
  commentIssue,
  feedbackStatusOf,
  ALL_FEEDBACK_STATUS_LABELS,
  FEEDBACK_LABEL_QUEUED,
  type FeedbackStatus,
  type IssueSummary,
  type IssueComment,
} from "./feedback";

// Manually triggering the cloud auto-fix routine just opens the
// routine page in the user's browser; from there they click "Run now"
// in the Anthropic UI. Avoids needing an Anthropic API token in the
// desktop app — auth is handled by the user's existing claude.ai
// session in the browser.
const ROUTINE_URL = "https://claude.ai/code/routines/trig_01Qi59s8Cqj1gf6PvcpmrH8j";

// "Send feedback" composer + Issues tab. Visually mirrors NotePopup
// but with an indigo accent so it's unmistakably not a note. New tab
// files a GitHub issue (label auto-fix:queued); Issues tab lists what
// you've filed and what the cloud agent has done with each one, with
// inline buttons to close / re-queue / convert without leaving the
// app.

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

type Tab = "new" | "issues";

type IssueActionState =
  | { phase: "idle" }
  | { phase: "pending"; verb: string }
  | { phase: "error"; message: string };

export function FeedbackPopup({ open, onClose, initialDraft = "", initialAnchors }: FeedbackPopupProps) {
  const currentFile = useStore((s) => s.currentFile);
  const files = useStore((s) => s.files);
  const vaultPath = useStore((s) => s.vaultPath);
  const githubPat = useStore((s) => s.serviceKeys.github_pat);
  const setShowSettings = useStore((s) => s.setShowSettings);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const pickerRef = useRef<HTMLInputElement | null>(null);
  const [tab, setTab] = useState<Tab>("new");

  // --- New-feedback state ---
  const [anchors, setAnchors] = useState<NoteAnchor[]>([]);
  const [pickerQuery, setPickerQuery] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerIdx, setPickerIdx] = useState(0);
  const [send, setSend] = useState<SendState>({ phase: "idle" });

  // --- Issues-tab state ---
  const [issues, setIssues] = useState<IssueSummary[] | null>(null);
  const [issuesLoading, setIssuesLoading] = useState(false);
  const [issuesError, setIssuesError] = useState<string | null>(null);
  const [expandedIssue, setExpandedIssue] = useState<number | null>(null);
  const [comments, setComments] = useState<Record<number, IssueComment[] | "loading" | { error: string }>>({});
  const [actionState, setActionState] = useState<Record<number, IssueActionState>>({});

  useEffect(() => {
    if (!open) return;
    setTab("new");
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
    setIssues(null);
    setExpandedIssue(null);
    setComments({});
    setActionState({});
    setIssuesError(null);
  }, [open, initialAnchors, currentFile]);

  useEffect(() => {
    if (!open) return;
    if (tab !== "new") return;
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [open, tab]);

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

  useEffect(() => {
    if (tab !== "issues") return;
    if (issues !== null || issuesLoading) return;
    if (!githubPat) return;
    void loadIssues();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, githubPat]);

  const loadIssues = async () => {
    if (!githubPat) return;
    setIssuesLoading(true);
    setIssuesError(null);
    try {
      const list = await listFeedbackIssues(githubPat);
      setIssues(list);
    } catch (e) {
      setIssuesError(stringifyError(e));
      setIssues([]);
    } finally {
      setIssuesLoading(false);
    }
  };

  const toggleExpandIssue = async (n: number) => {
    if (expandedIssue === n) {
      setExpandedIssue(null);
      return;
    }
    setExpandedIssue(n);
    if (!githubPat) return;
    if (comments[n] && comments[n] !== "loading" && !("error" in (comments[n] as object))) return;
    setComments((c) => ({ ...c, [n]: "loading" }));
    try {
      const list = await getIssueComments(githubPat, n);
      setComments((c) => ({ ...c, [n]: list }));
    } catch (e) {
      setComments((c) => ({ ...c, [n]: { error: stringifyError(e) } }));
    }
  };

  // Run an action against an issue, then optimistically refresh just
  // that issue from the latest list. On error, surface inline so the
  // user can retry.
  const runAction = async (
    issue: IssueSummary,
    verb: string,
    fn: () => Promise<void>,
  ) => {
    setActionState((s) => ({ ...s, [issue.number]: { phase: "pending", verb } }));
    try {
      await fn();
      // Refetch the issues list so labels/state reflect what we just did.
      // Keep the user's expansion state intact.
      const list = await listFeedbackIssues(githubPat!);
      setIssues(list);
      setActionState((s) => ({ ...s, [issue.number]: { phase: "idle" } }));
    } catch (e) {
      setActionState((s) => ({
        ...s,
        [issue.number]: { phase: "error", message: stringifyError(e) },
      }));
    }
  };

  const verifyAndClose = (issue: IssueSummary) =>
    runAction(issue, "closing", async () => {
      await closeIssue(githubPat!, issue.number, "completed");
    });

  const closeAnyway = (issue: IssueSummary) =>
    runAction(issue, "closing", async () => {
      await closeIssue(githubPat!, issue.number, "not_planned");
    });

  const reQueue = (issue: IssueSummary, guidance?: string) =>
    runAction(issue, "re-queueing", async () => {
      // Optional guidance from the user — posted as an issue comment so
      // the agent can read it on the next run alongside the original
      // body and any prior comments.
      const note = (guidance ?? "").trim();
      if (note.length > 0) {
        await commentIssue(
          githubPat!,
          issue.number,
          `**Guidance from user before re-queue:**\n\n${note}`,
        );
      }
      // Strip every auto-fix:* status label, then add queued. Other
      // labels (set on GitHub) are left alone.
      const currentNames = new Set(issue.labels.map((l) => l.name));
      const remove = ALL_FEEDBACK_STATUS_LABELS.filter(
        (l) => currentNames.has(l) && l !== FEEDBACK_LABEL_QUEUED,
      );
      const add = currentNames.has(FEEDBACK_LABEL_QUEUED) ? [] : [FEEDBACK_LABEL_QUEUED];
      if (remove.length === 0 && add.length === 0) return;
      await relabelIssue(githubPat!, issue.number, add, remove);
    });

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
    const kind: NoteAnchor["source_kind"] = hit.is_dir ? "code" : kindOf(hit.path);
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
        return {
          ...a,
          image_data_url: next[0] ?? null,
          images: next,
        };
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
      const created = await submitFeedback(githubPat, { text, anchors });
      setSend({ phase: "ok", number: created.number, url: created.url });
      setIssues(null);
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
  const openCount = (issues ?? []).filter((i) => i.state === "open").length;

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
          <TabButton active={tab === "new"} onClick={() => setTab("new")}>
            New
          </TabButton>
          <TabButton active={tab === "issues"} onClick={() => setTab("issues")}>
            Issues{issues !== null ? ` (${openCount})` : ""}
          </TabButton>
          <div className="ml-auto flex items-center pr-2 text-[10.5px] text-muted-foreground/80">
            {tab === "new"
              ? "Enter to send · Shift+Enter newline · Esc cancels"
              : "Click an issue to expand · Esc closes"}
          </div>
        </div>

        <div className="p-4 space-y-3">
          {tab === "new" ? (
            <NewFeedbackTab
              sentOk={sentOk}
              send={send}
              onClose={onClose}
              textareaRef={textareaRef}
              pickerRef={pickerRef}
              anchors={anchors}
              pickerOpen={pickerOpen}
              setPickerOpen={setPickerOpen}
              pickerQuery={pickerQuery}
              setPickerQuery={setPickerQuery}
              pickerIdx={pickerIdx}
              setPickerIdx={setPickerIdx}
              pickerMatches={pickerMatches}
              addAnchor={addAnchor}
              removeAnchor={removeAnchor}
              captureRegion={captureRegion}
              removeImage={removeImage}
              currentCanMarquee={currentCanMarquee}
              initialDraft={initialDraft}
              onTextareaKey={onTextareaKey}
              sending={sending}
              githubPat={githubPat}
              onOpenSettings={() => {
                onClose();
                setShowSettings(true);
              }}
              trySend={trySend}
            />
          ) : (
            <IssuesTab
              issues={issues}
              loading={issuesLoading}
              error={issuesError}
              expandedIssue={expandedIssue}
              comments={comments}
              actionState={actionState}
              onToggleExpand={toggleExpandIssue}
              onRefresh={loadIssues}
              onVerifyClose={verifyAndClose}
              onCloseAnyway={closeAnyway}
              onReQueue={reQueue}
              hasToken={!!githubPat}
              onOpenSettings={() => {
                onClose();
                setShowSettings(true);
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- internals ----------

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "px-4 py-2 text-[12px] font-medium border-b-2 -mb-[2px] transition-colors",
        active
          ? "border-indigo-500 text-indigo-400"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

type NewFeedbackTabProps = {
  sentOk: boolean;
  send: SendState;
  onClose: () => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  pickerRef: React.RefObject<HTMLInputElement | null>;
  anchors: NoteAnchor[];
  pickerOpen: boolean;
  setPickerOpen: (b: boolean) => void;
  pickerQuery: string;
  setPickerQuery: (s: string) => void;
  pickerIdx: number;
  setPickerIdx: React.Dispatch<React.SetStateAction<number>>;
  pickerMatches: Array<{ path: string; name: string; rel: string; is_dir: boolean }>;
  addAnchor: (hit: { path: string; name: string; rel: string; is_dir: boolean }) => void;
  removeAnchor: (path: string) => void;
  captureRegion: () => void;
  removeImage: (path: string, index: number) => void;
  currentCanMarquee: boolean;
  initialDraft: string;
  onTextareaKey: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  sending: boolean;
  githubPat: string | undefined;
  onOpenSettings: () => void;
  trySend: () => void;
};

function NewFeedbackTab(p: NewFeedbackTabProps) {
  if (p.sentOk && p.send.phase === "ok") {
    return (
      <div className="space-y-3 py-2">
        <div className="text-[12.5px] text-foreground/90">
          ✅ Filed as{" "}
          <a
            href={p.send.url}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-indigo-400 hover:underline inline-flex items-center gap-1"
          >
            #{p.send.number}
            <ExternalLink className="h-3 w-3" />
          </a>
          . The auto-fix agent will pick it up on its next run.
        </div>
        <div className="flex justify-end">
          <Button size="sm" onClick={p.onClose}>
            Close
          </Button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-1">
        {p.anchors.map((a, i) => (
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
            {a.primary && p.anchors.length > 1 && (
              <span className="shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground/80">
                primary
              </span>
            )}
            <button
              onClick={() => p.removeAnchor(a.source_path)}
              className="shrink-0 h-4 w-4 flex items-center justify-center rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive opacity-60 group-hover:opacity-100"
              title="Remove anchor"
            >
              <XIcon className="h-3 w-3" />
            </button>
          </div>
        ))}

        {p.pickerOpen ? (
          <div className="rounded border border-border bg-background p-1.5 space-y-1">
            <input
              ref={p.pickerRef}
              type="search"
              autoFocus
              value={p.pickerQuery}
              onChange={(e) => {
                p.setPickerQuery(e.target.value);
                p.setPickerIdx(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  p.setPickerOpen(false);
                  p.setPickerQuery("");
                } else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  p.setPickerIdx((i: number) => Math.min(i + 1, p.pickerMatches.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  p.setPickerIdx((i: number) => Math.max(i - 1, 0));
                } else if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  const hit = p.pickerMatches[p.pickerIdx] ?? p.pickerMatches[0];
                  if (hit) p.addAnchor(hit);
                }
              }}
              placeholder="Search files or folders…"
              className="w-full h-6 px-2 rounded bg-background text-[11.5px] outline-none placeholder:text-muted-foreground/60"
            />
            {p.pickerMatches.length > 0 && (
              <div className="max-h-[160px] overflow-auto">
                {p.pickerMatches.map((m, i) => (
                  <div
                    key={m.path}
                    className={cn(
                      "flex items-baseline gap-2 px-2 py-1 cursor-pointer rounded",
                      i === p.pickerIdx ? "bg-accent" : "hover:bg-accent/60",
                    )}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      p.addAnchor(m);
                    }}
                    onMouseEnter={() => p.setPickerIdx(i)}
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
              onClick={() => p.setPickerOpen(true)}
              className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground"
            >
              <Plus className="h-3 w-3" />
              Link another file or folder
            </button>
            {p.currentCanMarquee && (
              <button
                onClick={p.captureRegion}
                className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                title="Hide this popup, draw a region in the current viewer, then come back with the image attached"
              >
                <Camera className="h-3 w-3" />
                Capture region
              </button>
            )}
          </div>
        )}

        {p.anchors.some((a) => anchorImages(a).length > 0) && (
          <div className="flex flex-wrap gap-2 pt-1">
            {p.anchors.flatMap((a) =>
              anchorImages(a).map((url, i) => (
                <div key={`${a.source_path}:${i}`} className="relative group">
                  <img
                    src={url}
                    alt={`captured region ${i + 1}`}
                    className="max-h-[90px] rounded border border-border/60"
                  />
                  <button
                    onClick={() => p.removeImage(a.source_path, i)}
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

        {p.anchors.length === 0 && (
          <div className="text-[11.5px] text-muted-foreground italic">
            No file anchored — feedback will go through with just the text.
          </div>
        )}
      </div>

      <Textarea
        ref={p.textareaRef}
        defaultValue={p.initialDraft}
        placeholder="What's broken or what should change? The cloud agent will read this and try to fix it."
        onKeyDown={p.onTextareaKey}
        className="min-h-[96px] text-[13px]"
        disabled={p.sending}
      />

      {!p.githubPat && (
        <div className="text-[11px] text-indigo-400 leading-relaxed">
          No GitHub token configured.{" "}
          <button onClick={p.onOpenSettings} className="underline hover:text-indigo-300">
            Add one in Settings →
          </button>
        </div>
      )}

      {p.send.phase === "error" && (
        <div className="text-[11.5px] text-destructive leading-relaxed">{p.send.message}</div>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={p.onClose} disabled={p.sending}>
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={p.trySend}
          disabled={p.sending || !p.githubPat}
          className="bg-indigo-500 text-white hover:bg-indigo-400"
        >
          <Send className="h-3 w-3 mr-1.5" />
          {p.sending ? "Sending…" : "Send feedback"}
        </Button>
      </div>
    </>
  );
}

type IssuesTabProps = {
  issues: IssueSummary[] | null;
  loading: boolean;
  error: string | null;
  expandedIssue: number | null;
  comments: Record<number, IssueComment[] | "loading" | { error: string }>;
  actionState: Record<number, IssueActionState>;
  onToggleExpand: (n: number) => void;
  onRefresh: () => void;
  onVerifyClose: (issue: IssueSummary) => Promise<void>;
  onCloseAnyway: (issue: IssueSummary) => Promise<void>;
  onReQueue: (issue: IssueSummary, guidance?: string) => Promise<void>;
  hasToken: boolean;
  onOpenSettings: () => void;
};

function IssuesTab({
  issues,
  loading,
  error,
  expandedIssue,
  comments,
  actionState,
  onToggleExpand,
  onRefresh,
  onVerifyClose,
  onCloseAnyway,
  onReQueue,
  hasToken,
  onOpenSettings,
}: IssuesTabProps) {
  if (!hasToken) {
    return (
      <div className="py-6 text-center text-[12px] text-muted-foreground space-y-2">
        <div>No GitHub token configured.</div>
        <button onClick={onOpenSettings} className="underline text-indigo-400 hover:text-indigo-300">
          Add one in Settings →
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-[11px] text-muted-foreground">
          {issues === null
            ? "Loading…"
            : issues.length === 0
              ? "No feedback issues yet — file your first one in the New tab."
              : `${issues.length} issue${issues.length === 1 ? "" : "s"}`}
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => openUrl(ROUTINE_URL).catch((e) => console.error("[feedback] openUrl:", e))}
            className="flex items-center gap-1 text-[11px] text-indigo-400 hover:text-indigo-300"
            title="Open the routine page; click Run now there to trigger the agent immediately"
          >
            <Play className="h-3 w-3" />
            run agent now
          </button>
          <button
            onClick={onRefresh}
            disabled={loading}
            className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50"
            title="Refresh"
          >
            <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
            {loading ? "refreshing…" : "refresh"}
          </button>
        </div>
      </div>

      {error && (
        <div className="text-[11.5px] text-destructive leading-relaxed">{error}</div>
      )}

      <div className="max-h-[420px] overflow-auto pr-1 -mr-1 space-y-1.5">
        {(issues ?? []).map((iss) => {
          const status = feedbackStatusOf(iss);
          const isExpanded = expandedIssue === iss.number;
          const cmt = comments[iss.number];
          const a = actionState[iss.number] ?? { phase: "idle" };
          return (
            <div
              key={iss.number}
              className="rounded-md border border-border bg-background/40 overflow-hidden"
            >
              <button
                onClick={() => onToggleExpand(iss.number)}
                className="w-full text-left px-3 py-2 hover:bg-accent/40 transition-colors"
              >
                <div className="flex items-start gap-2">
                  <StatusBadge status={status} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2">
                      <span className="text-[12.5px] font-medium truncate">{iss.title}</span>
                      <span className="text-[10.5px] text-muted-foreground/80 font-mono shrink-0">
                        #{iss.number}
                      </span>
                    </div>
                    <div className="text-[10.5px] text-muted-foreground/80">
                      filed {relativeTime(iss.created_at)}
                      {iss.comments > 0 && ` · ${iss.comments} comment${iss.comments === 1 ? "" : "s"}`}
                      {iss.updated_at !== iss.created_at && ` · updated ${relativeTime(iss.updated_at)}`}
                    </div>
                  </div>
                </div>
              </button>

              {isExpanded && (
                <div className="border-t border-border/60 bg-muted/30 px-3 py-2 space-y-2 text-[12px]">
                  {iss.body && (
                    <div className="prose-chat text-foreground/85">
                      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                        {trimBody(iss.body)}
                      </ReactMarkdown>
                    </div>
                  )}
                  <div className="border-t border-border/40 pt-2">
                    {cmt === undefined || cmt === "loading" ? (
                      <div className="text-[11px] text-muted-foreground italic">
                        Loading comments…
                      </div>
                    ) : "error" in (cmt as object) ? (
                      <div className="text-[11px] text-destructive">
                        Couldn't load comments: {(cmt as { error: string }).error}
                      </div>
                    ) : (cmt as IssueComment[]).length === 0 ? (
                      <div className="text-[11px] text-muted-foreground italic">
                        No comments yet — agent hasn't acted on this one.
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {(cmt as IssueComment[]).map((c) => (
                          <div key={c.id} className="rounded border border-border/60 bg-background/60 p-2">
                            <div className="text-[10.5px] text-muted-foreground/90 mb-1 font-mono">
                              {c.author} · {relativeTime(c.created_at)}
                            </div>
                            <div className="prose-chat text-[12px] text-foreground/90">
                              <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                                {trimBody(c.body)}
                              </ReactMarkdown>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <ActionRow
                    issue={iss}
                    status={status}
                    action={a}
                    onVerifyClose={onVerifyClose}
                    onCloseAnyway={onCloseAnyway}
                    onReQueue={onReQueue}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ActionRow({
  issue,
  status,
  action,
  onVerifyClose,
  onCloseAnyway,
  onReQueue,
}: {
  issue: IssueSummary;
  status: FeedbackStatus;
  action: IssueActionState;
  onVerifyClose: (issue: IssueSummary) => Promise<void>;
  onCloseAnyway: (issue: IssueSummary) => Promise<void>;
  onReQueue: (issue: IssueSummary, guidance?: string) => Promise<void>;
}) {
  const pending = action.phase === "pending";
  const error = action.phase === "error" ? action.message : null;

  // Guidance textarea — when the agent kicked an issue back to us
  // (needs-review or agent-error), the user may want to leave a note
  // before re-queueing. The text gets posted as an issue comment so the
  // next agent run sees it.
  const showGuidance = status === "needs-review" || status === "agent-error";
  const [guidance, setGuidance] = useState("");

  // Buttons by status. Each button is a (label, icon, fn, variant) tuple
  // rendered as a <button>. Closed issues get no actions (we don't yet
  // expose "Reopen" — easy to add if needed).
  const buttons: Array<{
    label: string;
    icon: React.ReactNode;
    fn: () => Promise<void>;
    primary?: boolean;
  }> = [];

  if (status === "awaiting-verification") {
    buttons.push({
      label: "Verified & close",
      icon: <Check className="h-3 w-3" />,
      fn: () => onVerifyClose(issue),
      primary: true,
    });
    buttons.push({
      label: "Re-queue",
      icon: <RotateCw className="h-3 w-3" />,
      fn: () => onReQueue(issue),
    });
  } else if (status === "needs-review") {
    buttons.push({
      label: guidance.trim() ? "Re-queue with note" : "Re-queue",
      icon: <RotateCw className="h-3 w-3" />,
      fn: () => onReQueue(issue, guidance),
      primary: true,
    });
    buttons.push({
      label: "Close anyway",
      icon: <X className="h-3 w-3" />,
      fn: () => onCloseAnyway(issue),
    });
  } else if (status === "agent-error") {
    buttons.push({
      label: guidance.trim() ? "Re-queue with note" : "Convert to queued",
      icon: <RotateCw className="h-3 w-3" />,
      fn: () => onReQueue(issue, guidance),
      primary: true,
    });
    buttons.push({
      label: "Close",
      icon: <X className="h-3 w-3" />,
      fn: () => onCloseAnyway(issue),
    });
  } else if (status === "queued") {
    buttons.push({
      label: "Cancel",
      icon: <X className="h-3 w-3" />,
      fn: () => onCloseAnyway(issue),
    });
  }

  const githubLink = (
    <a
      href={issue.html_url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-[11px] text-indigo-400 hover:underline"
    >
      Open on GitHub
      <ExternalLink className="h-3 w-3" />
    </a>
  );

  return (
    <div className="border-t border-border/40 pt-2 space-y-1.5">
      {showGuidance && (
        <textarea
          value={guidance}
          onChange={(e) => setGuidance(e.target.value)}
          placeholder="Optional: leave a note for the agent before re-queueing (e.g. what went wrong, what to try instead)…"
          rows={3}
          disabled={pending}
          className="w-full resize-y rounded border border-border bg-background/60 px-2 py-1.5 text-[12px] leading-snug placeholder:text-muted-foreground/70 focus:outline-none focus:ring-1 focus:ring-indigo-500/50 disabled:opacity-50"
        />
      )}
      <div className="flex items-center gap-2 flex-wrap">
        {buttons.map((b, i) => (
          <button
            key={i}
            onClick={b.fn}
            disabled={pending}
            className={cn(
              "inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded border transition-colors disabled:opacity-50",
              b.primary
                ? "bg-indigo-500 text-white border-indigo-500 hover:bg-indigo-400 hover:border-indigo-400"
                : "bg-background/60 text-foreground/85 border-border hover:bg-accent",
            )}
          >
            {b.icon}
            {b.label}
          </button>
        ))}
        <div className="ml-auto">{githubLink}</div>
      </div>
      {pending && (
        <div className="text-[11px] text-muted-foreground italic">
          {action.verb}…
        </div>
      )}
      {error && (
        <div className="text-[11px] text-destructive leading-relaxed">{error}</div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: FeedbackStatus }) {
  const cfg: Record<FeedbackStatus, { label: string; cls: string }> = {
    queued: { label: "queued", cls: "bg-muted text-muted-foreground border-border" },
    "awaiting-verification": {
      label: "verify",
      cls: "bg-emerald-500/15 text-emerald-500 border-emerald-500/30",
    },
    "needs-review": {
      label: "review",
      cls: "bg-amber-500/15 text-amber-500 border-amber-500/40",
    },
    "agent-error": {
      label: "agent err",
      cls: "bg-rose-500/15 text-rose-400 border-rose-500/40",
    },
    closed: { label: "closed", cls: "bg-muted/40 text-muted-foreground/60 border-border/60" },
    unknown: { label: "?", cls: "bg-muted/40 text-muted-foreground border-border/60" },
  };
  const c = cfg[status];
  return (
    <span
      className={cn(
        "shrink-0 rounded border px-1.5 py-0.5 text-[9.5px] uppercase tracking-wider font-semibold",
        c.cls,
      )}
    >
      {c.label}
    </span>
  );
}

function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.round(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  const yr = Math.round(mo / 12);
  return `${yr}y ago`;
}

function trimBody(s: string): string {
  const idx = s.indexOf("\n\n---\n\n_Filed via in-app feedback");
  if (idx >= 0) return s.slice(0, idx).trim();
  return s.trim();
}

function stringifyError(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
