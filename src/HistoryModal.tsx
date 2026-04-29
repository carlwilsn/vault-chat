import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkBreaks from "remark-breaks";
import rehypeRaw from "rehype-raw";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import { History as HistoryIcon, Undo2, FileText, FilePlus, FileX, Pencil } from "lucide-react";
import { useStore, type FileEntry } from "./store";
import {
  gitRecentCommits,
  gitRestoreToCommit,
  gitAllTouchedFiles,
  gitCommitFiles,
  gitFileHistory,
  gitFileAt,
  gitDiffVsCurrent,
  gitRestoreFileTo,
  type GitCommit,
  type TouchedFile,
  type CommitFile,
} from "./git";
import { fileKind } from "./fileKind";
import { cn } from "./lib/utils";

const KATEX_OPTIONS = { strict: "ignore", errorColor: "currentColor" } as const;

type Props = { open: boolean; onClose: () => void };

type Tab = "commits" | "files";
type FileTab = "preview" | "diff";

// --- shared utilities ----------------------------------------------------

function StatusGlyph({ status }: { status: string }) {
  if (status === "A") {
    return <FilePlus className="h-3 w-3 text-emerald-500 shrink-0" />;
  }
  if (status === "D" || status === "deleted") {
    return <FileX className="h-3 w-3 text-destructive shrink-0" />;
  }
  if (status === "M") {
    return <Pencil className="h-3 w-3 text-primary/70 shrink-0" />;
  }
  return <FileText className="h-3 w-3 text-muted-foreground/70 shrink-0" />;
}

// Render the source content the same way the main view does — markdown
// renders as markdown, code as a fenced block (let rehypeHighlight
// colour it), images stay as a placeholder for now (we'd need a
// separate code path to decode the bytes from the historical commit).
function HistoricalPreview({ path, content }: { path: string; content: string }) {
  if (content === "") {
    return (
      <div className="text-[12px] text-muted-foreground p-4 italic">
        (file did not exist at this version)
      </div>
    );
  }
  const { kind, ext } = fileKind(path);
  // The preview has to live inside a narrow modal pane, so we use the
  // chat-bubble prose scale (smaller headings, tighter padding) rather
  // than the main-view prose. The wrapper's max-width is capped to
  // the parent, never the 780px main-view ceiling, so long lines wrap
  // instead of forcing horizontal scroll.
  if (kind === "markdown") {
    return (
      <div className="prose-chat px-4 py-3">
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath, remarkBreaks]}
          rehypePlugins={[rehypeRaw, [rehypeKatex, KATEX_OPTIONS], rehypeHighlight]}
        >
          {content}
        </ReactMarkdown>
      </div>
    );
  }
  if (kind === "code") {
    const fenced = "```" + (ext || "") + "\n" + content + "\n```";
    return (
      <div className="prose-chat px-4 py-3">
        <ReactMarkdown rehypePlugins={[rehypeHighlight]}>{fenced}</ReactMarkdown>
      </div>
    );
  }
  return (
    <div className="text-[12px] text-muted-foreground p-4">
      Preview not available for {kind}. Use the Diff vs current tab to see what
      would change on rollback.
    </div>
  );
}

// Tiny structural diff renderer — colours +/- lines without doing
// anything fancier than a unified-diff parse. Keeps line numbers out
// because file-level diffs are short and the line numbers in the raw
// patch are noisy for the "what would change" framing.
function DiffView({ diff }: { diff: string }) {
  if (!diff.trim()) {
    return (
      <div className="text-[12px] text-muted-foreground p-4 italic">
        Identical — rolling back this file would change nothing.
      </div>
    );
  }
  const lines = diff.split("\n");
  return (
    <pre className="text-[11.5px] font-mono whitespace-pre-wrap p-3 leading-relaxed">
      {lines.map((l, i) => {
        let cls = "text-foreground/80";
        if (l.startsWith("+++") || l.startsWith("---") || l.startsWith("diff --git") ||
            l.startsWith("index ") || l.startsWith("@@")) {
          cls = "text-muted-foreground";
        } else if (l.startsWith("+")) {
          cls = "text-emerald-500";
        } else if (l.startsWith("-")) {
          cls = "text-destructive";
        }
        return (
          <span key={i} className={cls}>
            {l}
            {"\n"}
          </span>
        );
      })}
    </pre>
  );
}

function relativeTime(iso: string): string {
  // dates from our git format are "YYYY-MM-DD HH:MM"
  const d = new Date(iso.replace(" ", "T") + ":00");
  if (Number.isNaN(d.getTime())) return iso;
  const diff = Date.now() - d.getTime();
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return iso;
}

// --- main component ------------------------------------------------------

export function HistoryModal({ open, onClose }: Props) {
  const vaultPath = useStore((s) => s.vaultPath);
  const setFiles = useStore((s) => s.setFiles);

  const [tab, setTab] = useState<Tab>("files");
  const [showEarlier, setShowEarlier] = useState(false);

  // --- commits tab state ---
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [commitFiles, setCommitFiles] = useState<CommitFile[]>([]);
  const [commitFilesLoading, setCommitFilesLoading] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);

  // --- files tab state ---
  const [touched, setTouched] = useState<TouchedFile[]>([]);
  const [touchedLoaded, setTouchedLoaded] = useState(false);
  const [filter, setFilter] = useState("");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileCommits, setFileCommits] = useState<GitCommit[]>([]);
  const [selectedFileHash, setSelectedFileHash] = useState<string | null>(null);
  const [fileTab, setFileTab] = useState<FileTab>("preview");
  const [previewContent, setPreviewContent] = useState<string>("");
  const [fileDiff, setFileDiff] = useState<string>("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [fileRestoreBusy, setFileRestoreBusy] = useState(false);
  const [fileToast, setFileToast] = useState<string | null>(null);
  // When the user lands on the Files tab via "click file in commit",
  // remember the originating commit so we can show a breadcrumb back
  // to the same commit row. Cleared when the user picks a file
  // directly from the Files-tab list.
  const [cameFromCommit, setCameFromCommit] = useState<GitCommit | null>(null);
  const toastTimer = useRef<number | null>(null);

  const reloadCommits = async () => {
    if (!vaultPath) return;
    const c = await gitRecentCommits(vaultPath, 30, showEarlier);
    setCommits(c);
  };

  const reloadTouched = async () => {
    if (!vaultPath) return;
    setTouchedLoaded(false);
    const t = await gitAllTouchedFiles(vaultPath, showEarlier);
    setTouched(t);
    setTouchedLoaded(true);
  };

  useEffect(() => {
    if (!open) return;
    setUndoError(null);
    reloadCommits();
    reloadTouched();
    // Reset transient selections so reopening doesn't show stale state.
    setSelectedHash(null);
    setCommitFiles([]);
    setSelectedFile(null);
    setSelectedFileHash(null);
    setFileCommits([]);
    setPreviewContent("");
    setFileDiff("");
    setCameFromCommit(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, showEarlier]);

  const selectCommit = async (hash: string) => {
    if (!vaultPath || selectedHash === hash) return;
    setSelectedHash(hash);
    setCommitFiles([]);
    setCommitFilesLoading(true);
    try {
      const files = await gitCommitFiles(vaultPath, hash);
      setCommitFiles(files);
    } catch (e) {
      console.error("[history] commit files failed:", e);
    }
    setCommitFilesLoading(false);
  };

  const restoreToSelected = async () => {
    if (!vaultPath || !selectedHash || restoreBusy) return;
    if (commits[0]?.hash === selectedHash) return;
    setRestoreBusy(true);
    setUndoError(null);
    try {
      await gitRestoreToCommit(vaultPath, selectedHash);
      const listed = await invoke<FileEntry[]>("list_markdown_files", { vault: vaultPath });
      setFiles(listed);
      await reloadCommits();
      await reloadTouched();
      setSelectedHash(null);
      setCommitFiles([]);
    } catch (e) {
      setUndoError(String(e));
    }
    setRestoreBusy(false);
  };

  // --- file tab actions ---

  // Open a file in the per-file pane. If `pinHash` is provided, that
  // version is selected (used for "click a file in a commit" jumps);
  // otherwise the most recent version that touched the file is shown.
  const openFile = async (path: string, pinHash?: string) => {
    if (!vaultPath) return;
    setSelectedFile(path);
    setSelectedFileHash(null);
    setPreviewContent("");
    setFileDiff("");
    const c = await gitFileHistory(vaultPath, path, 50, showEarlier);
    setFileCommits(c);
    const target = pinHash && c.some((v) => v.hash === pinHash) ? pinHash : c[0]?.hash;
    if (target) await selectFileVersion(path, target);
  };

  const selectFileVersion = async (path: string, hash: string) => {
    if (!vaultPath) return;
    setSelectedFileHash(hash);
    setPreviewLoading(true);
    try {
      const [content, diff] = await Promise.all([
        gitFileAt(vaultPath, hash, path),
        gitDiffVsCurrent(vaultPath, hash, path),
      ]);
      setPreviewContent(content);
      setFileDiff(diff);
    } catch (e) {
      console.error("[file-history] load failed:", e);
    }
    setPreviewLoading(false);
  };

  const restoreThisFile = async () => {
    if (!vaultPath || !selectedFile || !selectedFileHash || fileRestoreBusy) return;
    setFileRestoreBusy(true);
    try {
      await gitRestoreFileTo(vaultPath, selectedFileHash, selectedFile);
      const listed = await invoke<FileEntry[]>("list_markdown_files", { vault: vaultPath });
      setFiles(listed);
      await reloadCommits();
      await reloadTouched();
      const c = await gitFileHistory(vaultPath, selectedFile, 50, showEarlier);
      setFileCommits(c);
      // Move selection to the new HEAD so the user sees their current state.
      if (c[0]) await selectFileVersion(selectedFile, c[0].hash);
      // Toast the result.
      setFileToast(`Restored ${selectedFile.split("/").pop()}`);
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
      toastTimer.current = window.setTimeout(() => setFileToast(null), 3000);
    } catch (e) {
      setFileToast(`Restore failed: ${String(e)}`);
    }
    setFileRestoreBusy(false);
  };

  // --- cross-tab navigation: commit-files → files tab ---

  // From the Commits tab: click a file in a commit's file list. We
  // jump to the Files tab and pin the timeline to *that* commit's
  // version of the file, with a breadcrumb so the user can return.
  const jumpToFile = async (path: string, fromCommit: GitCommit) => {
    setTab("files");
    setCameFromCommit(fromCommit);
    await openFile(path, fromCommit.hash);
  };

  const backToCommit = () => {
    if (!cameFromCommit) return;
    setTab("commits");
    if (selectedHash !== cameFromCommit.hash) {
      selectCommit(cameFromCommit.hash);
    }
  };

  // Picking a file directly from the Files-tab list breaks the
  // breadcrumb chain — we're no longer "viewing this from a commit",
  // we're browsing the file's own history.
  const openFileDirect = async (path: string) => {
    setCameFromCommit(null);
    await openFile(path);
  };

  // --- filter + sort for files list ---

  const filteredTouched = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return touched;
    return touched.filter((t) => t.path.toLowerCase().includes(q));
  }, [touched, filter]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-[920px] max-w-[92vw] max-h-[85vh] flex flex-col rounded-md border border-border bg-card shadow-xl overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* header + tabs */}
        <div className="px-4 pt-4 pb-0 flex items-end justify-between gap-3">
          <div className="flex items-center gap-3">
            <HistoryIcon className="h-4 w-4 text-muted-foreground" />
            <div className="flex">
              <button
                onClick={() => setTab("files")}
                className={cn(
                  "px-3 py-1.5 text-[12px] border-b-2 -mb-px transition-colors",
                  tab === "files"
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                Files
              </button>
              <button
                onClick={() => setTab("commits")}
                className={cn(
                  "px-3 py-1.5 text-[12px] border-b-2 -mb-px transition-colors",
                  tab === "commits"
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                Commits
              </button>
            </div>
          </div>
          <button
            onClick={() => setShowEarlier((v) => !v)}
            className="text-[10.5px] text-muted-foreground hover:text-foreground"
          >
            {showEarlier ? "hide pre-vault-chat history" : "show earlier history"}
          </button>
        </div>
        <div className="border-b border-border/60" />

        {/* tab content */}
        <div className="flex-1 min-h-0 flex">
          {tab === "commits" ? (
            <CommitsTab
              commits={commits}
              selectedHash={selectedHash}
              commitFiles={commitFiles}
              commitFilesLoading={commitFilesLoading}
              restoreBusy={restoreBusy}
              undoError={undoError}
              onSelect={selectCommit}
              onRestore={restoreToSelected}
              onJumpToFile={jumpToFile}
            />
          ) : (
            <FilesTab
              touched={filteredTouched}
              loaded={touchedLoaded}
              filter={filter}
              setFilter={setFilter}
              selectedFile={selectedFile}
              fileCommits={fileCommits}
              selectedFileHash={selectedFileHash}
              fileTab={fileTab}
              setFileTab={setFileTab}
              previewContent={previewContent}
              fileDiff={fileDiff}
              previewLoading={previewLoading}
              fileRestoreBusy={fileRestoreBusy}
              fileToast={fileToast}
              cameFromCommit={cameFromCommit}
              onOpenFile={openFileDirect}
              onSelectVersion={selectFileVersion}
              onRestoreFile={restoreThisFile}
              onBackToCommit={backToCommit}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// --- commits tab subcomponent --------------------------------------------

function CommitsTab({
  commits,
  selectedHash,
  commitFiles,
  commitFilesLoading,
  restoreBusy,
  undoError,
  onSelect,
  onRestore,
  onJumpToFile,
}: {
  commits: GitCommit[];
  selectedHash: string | null;
  commitFiles: CommitFile[];
  commitFilesLoading: boolean;
  restoreBusy: boolean;
  undoError: string | null;
  onSelect: (hash: string) => void;
  onRestore: () => void;
  onJumpToFile: (path: string, fromCommit: GitCommit) => void;
}) {
  const selectedCommit = commits.find((c) => c.hash === selectedHash) ?? null;
  return (
    <>
      <div className="w-[300px] border-r border-border/60 overflow-auto shrink-0">
        {commits.length === 0 && (
          <div className="p-4 text-[12px] text-muted-foreground">No commits yet.</div>
        )}
        {commits.map((c, idx) => {
          const isSelected = selectedHash === c.hash;
          const isHead = idx === 0;
          return (
            <button
              key={c.hash}
              onClick={() => onSelect(c.hash)}
              className={cn(
                "w-full text-left px-3 py-2 border-b border-border/40 flex items-start gap-2 hover:bg-accent/40",
                isSelected && "bg-accent/60",
              )}
            >
              <span
                className={cn(
                  "mt-[3px] h-3 w-3 shrink-0 rounded-full border",
                  isSelected ? "border-primary bg-primary" : "border-muted-foreground/50",
                )}
              />
              <span className="min-w-0 flex-1">
                <div className="text-[12px] text-foreground truncate">{c.subject}</div>
                <div className="text-[10.5px] text-muted-foreground font-mono mt-0.5 flex items-center gap-2 flex-wrap">
                  <span>
                    {c.short_hash} · {c.date}
                  </span>
                  {isHead && <span className="text-primary">HEAD</span>}
                  {c.is_anchor && (
                    <span className="rounded px-1.5 py-px text-[9.5px] bg-primary/15 text-primary">
                      vault-chat start
                    </span>
                  )}
                </div>
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex-1 flex flex-col min-h-0">
        {!selectedCommit ? (
          <div className="flex-1 flex items-center justify-center text-[12px] text-muted-foreground">
            Pick a commit on the left to see the files it touched.
          </div>
        ) : (
          <>
            <div className="px-4 py-3 border-b border-border/60 shrink-0">
              <div className="text-[12.5px] text-foreground">{selectedCommit.subject}</div>
              <div className="text-[10.5px] text-muted-foreground font-mono mt-0.5">
                {selectedCommit.short_hash} · {selectedCommit.date}
              </div>
            </div>
            <div className="flex-1 overflow-auto">
              {commitFilesLoading ? (
                <div className="p-4 text-[12px] text-muted-foreground">Loading…</div>
              ) : commitFiles.length === 0 ? (
                <div className="p-4 text-[12px] text-muted-foreground">
                  This commit didn't touch any files (probably a restore marker).
                </div>
              ) : (
                <ul className="divide-y divide-border/40">
                  {commitFiles.map((f) => {
                    const leaf = f.path.split("/").pop() ?? f.path;
                    return (
                      <li key={f.path}>
                        <button
                          onClick={() => onJumpToFile(f.path, selectedCommit)}
                          className="w-full text-left px-4 py-2 flex items-center gap-3 hover:bg-accent/40"
                          title="Open this file at this commit's version"
                        >
                          <StatusGlyph status={f.status} />
                          <span className="min-w-0 flex-1">
                            <div className="text-[12px] text-foreground truncate">
                              {leaf}
                            </div>
                            <div className="text-[10.5px] text-muted-foreground font-mono truncate">
                              {f.path}
                            </div>
                          </span>
                          <span className="text-[10.5px] font-mono shrink-0 flex items-center gap-2">
                            {f.additions > 0 && (
                              <span className="text-emerald-500">+{f.additions}</span>
                            )}
                            {f.deletions > 0 && (
                              <span className="text-destructive">-{f.deletions}</span>
                            )}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            <div className="border-t border-border/60 px-4 py-2.5 flex items-center gap-3 shrink-0">
              <span className="text-[11px] min-w-0 flex-1 truncate text-muted-foreground">
                {undoError ? (
                  <span className="text-destructive">{undoError}</span>
                ) : (
                  "Click any file to inspect it at this commit."
                )}
              </span>
              <button
                onClick={onRestore}
                disabled={!selectedHash || restoreBusy || commits[0]?.hash === selectedHash}
                className="h-7 px-3 rounded text-[12px] border border-border hover:bg-accent/60 flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed shrink-0 whitespace-nowrap"
              >
                <Undo2 className="h-3 w-3" />
                {restoreBusy ? "Restoring…" : "Restore to this commit"}
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}

// --- files tab subcomponent ----------------------------------------------

function FilesTab({
  touched,
  loaded,
  filter,
  setFilter,
  selectedFile,
  fileCommits,
  selectedFileHash,
  fileTab,
  setFileTab,
  previewContent,
  fileDiff,
  previewLoading,
  fileRestoreBusy,
  fileToast,
  cameFromCommit,
  onOpenFile,
  onSelectVersion,
  onRestoreFile,
  onBackToCommit,
}: {
  touched: TouchedFile[];
  loaded: boolean;
  filter: string;
  setFilter: (v: string) => void;
  selectedFile: string | null;
  fileCommits: GitCommit[];
  selectedFileHash: string | null;
  fileTab: FileTab;
  setFileTab: (t: FileTab) => void;
  previewContent: string;
  fileDiff: string;
  previewLoading: boolean;
  fileRestoreBusy: boolean;
  fileToast: string | null;
  cameFromCommit: GitCommit | null;
  onOpenFile: (path: string) => void;
  onSelectVersion: (path: string, hash: string) => void;
  onRestoreFile: () => void;
  onBackToCommit: () => void;
}) {
  return (
    <>
      {/* file list */}
      <div className="w-[300px] border-r border-border/60 flex flex-col shrink-0">
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
          {!loaded && (
            <div className="p-4 text-[12px] text-muted-foreground">Loading…</div>
          )}
          {loaded && touched.length === 0 && (
            <div className="p-4 text-[12px] text-muted-foreground">
              No files in history.
            </div>
          )}
          {touched.map((tf) => {
            const isSelected = selectedFile === tf.path;
            const leaf = tf.path.split("/").pop() ?? tf.path;
            return (
              <button
                key={tf.path}
                onClick={() => onOpenFile(tf.path)}
                className={cn(
                  "w-full text-left px-3 py-2 border-b border-border/40 flex items-start gap-2 hover:bg-accent/40",
                  isSelected && "bg-accent/60",
                )}
              >
                <StatusGlyph status={tf.status} />
                <span className="min-w-0 flex-1">
                  <div className="text-[12px] text-foreground truncate">{leaf}</div>
                  <div className="text-[10.5px] text-muted-foreground font-mono truncate">
                    {tf.path}
                  </div>
                  <div className="text-[10.5px] text-muted-foreground/80 mt-0.5">
                    {relativeTime(tf.last_date)} · {tf.edits} edit
                    {tf.edits === 1 ? "" : "s"}
                    {tf.status === "deleted" && (
                      <span className="ml-1.5 text-destructive">deleted</span>
                    )}
                  </div>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* per-file pane */}
      <div className="flex-1 flex flex-col min-h-0">
        {!selectedFile ? (
          <div className="flex-1 flex items-center justify-center text-[12px] text-muted-foreground">
            Pick a file to see its history.
          </div>
        ) : (
          <>
            {cameFromCommit && (
              <div className="border-b border-border/60 px-3 py-1.5 shrink-0 bg-muted/30">
                <button
                  onClick={onBackToCommit}
                  className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                >
                  <span aria-hidden>←</span>
                  <span>Back to commit</span>
                  <span className="font-mono">{cameFromCommit.short_hash}</span>
                  <span className="truncate max-w-[400px]">· {cameFromCommit.subject}</span>
                </button>
              </div>
            )}
            {/* version timeline (horizontal pills, scroll if long) */}
            <div className="border-b border-border/60 px-3 py-2 overflow-x-auto shrink-0">
              <div className="text-[10.5px] text-muted-foreground mb-1 uppercase tracking-wide">
                Versions of {selectedFile.split("/").pop()}
              </div>
              <div className="flex gap-1 flex-wrap">
                {fileCommits.length === 0 && (
                  <span className="text-[11px] text-muted-foreground">
                    No tracked versions yet.
                  </span>
                )}
                {fileCommits.map((c, idx) => {
                  const isSelected = selectedFileHash === c.hash;
                  const isHead = idx === 0;
                  return (
                    <button
                      key={c.hash}
                      onClick={() => onSelectVersion(selectedFile, c.hash)}
                      title={c.subject}
                      className={cn(
                        "px-2 py-0.5 rounded text-[10.5px] font-mono border whitespace-nowrap",
                        isSelected
                          ? "bg-primary text-primary-foreground border-primary"
                          : "border-border bg-muted/40 hover:bg-accent/60",
                      )}
                    >
                      {c.short_hash} · {relativeTime(c.date)}
                      {isHead && (
                        <span
                          className={cn(
                            "ml-1.5",
                            isSelected ? "" : "text-primary",
                          )}
                        >
                          HEAD
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* preview / diff toggle */}
            <div className="border-b border-border/60 px-3 py-1.5 flex items-center gap-3 shrink-0">
              <button
                onClick={() => setFileTab("preview")}
                className={cn(
                  "text-[11px] py-0.5",
                  fileTab === "preview"
                    ? "text-foreground border-b-2 border-primary"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                Preview
              </button>
              <button
                onClick={() => setFileTab("diff")}
                className={cn(
                  "text-[11px] py-0.5",
                  fileTab === "diff"
                    ? "text-foreground border-b-2 border-primary"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                Diff vs current
              </button>
            </div>

            <div className="flex-1 overflow-auto">
              {previewLoading ? (
                <div className="p-4 text-[12px] text-muted-foreground">Loading…</div>
              ) : !selectedFileHash ? (
                <div className="p-4 text-[12px] text-muted-foreground">
                  Pick a version above.
                </div>
              ) : fileTab === "preview" ? (
                <HistoricalPreview path={selectedFile} content={previewContent} />
              ) : (
                <DiffView diff={fileDiff} />
              )}
            </div>

            {/* restore footer */}
            <div className="border-t border-border/60 px-4 py-2.5 flex items-center gap-3 shrink-0">
              <span className="text-[11px] min-w-0 flex-1 truncate">
                {fileToast ? (
                  <span className="text-emerald-600">{fileToast}</span>
                ) : (
                  <span className="text-muted-foreground">
                    {selectedFileHash &&
                      fileCommits[0]?.hash === selectedFileHash &&
                      "This is the current version."}
                  </span>
                )}
              </span>
              <button
                onClick={onRestoreFile}
                disabled={
                  !selectedFileHash ||
                  fileRestoreBusy ||
                  fileCommits[0]?.hash === selectedFileHash
                }
                className="h-7 px-3 rounded text-[12px] border border-border hover:bg-accent/60 flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed shrink-0 whitespace-nowrap"
              >
                <Undo2 className="h-3 w-3" />
                {fileRestoreBusy ? "Restoring…" : "Restore this file"}
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
