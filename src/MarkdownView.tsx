import { useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkBreaks from "remark-breaks";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import "katex/dist/katex.min.css";
import "highlight.js/styles/github-dark.css";
import { invoke } from "@tauri-apps/api/core";
import { FileText, Eye, Pencil, X } from "lucide-react";
import { useStore } from "./store";
import { LiveEditor } from "./LiveEditor";
import { VAULT_PANE_MIME } from "./dnd";

type Props = { paneId?: string };

export function MarkdownView({ paneId }: Props) {
  const {
    currentFile,
    currentContent,
    panes,
    activePaneId,
    mode,
    toggleMode,
    reloadCurrent,
    setActivePane,
    closePane,
    updatePaneContent,
  } = useStore();

  const pane = paneId ? panes.find((p) => p.id === paneId) : null;
  const file = pane ? pane.file : currentFile;
  const content = pane ? pane.content : currentContent;
  const isActive = paneId ? paneId === activePaneId : true;
  const inSplit = panes.length > 0;

  const saveTimer = useRef<number | null>(null);
  const lastSaved = useRef<string>(content);

  useEffect(() => {
    lastSaved.current = content;
  }, [file]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, []);

  const onChange = (value: string) => {
    if (paneId) {
      updatePaneContent(paneId, value);
    } else {
      reloadCurrent(value);
    }
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      if (value === lastSaved.current || !file) return;
      try {
        await invoke("write_text_file", { path: file, contents: value });
        lastSaved.current = value;
      } catch (e) {
        console.error("autosave failed", e);
      }
    }, 300);
  };

  const onPaneClick = () => {
    if (paneId && !isActive) setActivePane(paneId);
  };

  const onHeaderDragStart = (e: React.DragEvent<HTMLDivElement>) => {
    if (!paneId) return;
    e.dataTransfer.setData(VAULT_PANE_MIME, paneId);
    e.dataTransfer.effectAllowed = "move";
  };

  if (!file) {
    return (
      <div className="h-full flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <FileText className="h-8 w-8 opacity-30" />
          <p className="text-sm">Open a vault, then pick a markdown file.</p>
        </div>
      </div>
    );
  }

  const relPath = file.split("/").slice(-3).join(" › ");
  const showActiveOutline = inSplit && isActive;

  return (
    <div
      className={`h-full flex flex-col bg-background ${
        showActiveOutline ? "ring-1 ring-primary/40 ring-inset" : ""
      }`}
      onClick={onPaneClick}
    >
      <div
        className={`flex items-center justify-between px-6 py-2.5 border-b border-border/60 ${
          paneId ? "cursor-grab active:cursor-grabbing" : ""
        }`}
        draggable={!!paneId}
        onDragStart={onHeaderDragStart}
      >
        <div className="text-[11px] font-mono text-muted-foreground truncate select-none">
          {relPath}
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (paneId && !isActive) setActivePane(paneId);
              toggleMode();
            }}
            className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
            title={mode === "view" ? "Edit (Ctrl+E)" : "View (Ctrl+E)"}
            draggable={false}
          >
            {mode === "view" ? (
              <>
                <Eye className="h-3 w-3" /> view
              </>
            ) : (
              <>
                <Pencil className="h-3 w-3" /> editing
              </>
            )}
          </button>
          {paneId && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                closePane(paneId);
              }}
              className="text-muted-foreground hover:text-foreground transition-colors"
              title="Close pane"
              draggable={false}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
      {mode === "view" || !isActive ? (
        <div className="flex-1 overflow-auto py-10 px-8">
          <div className="prose-md mx-auto">
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath, remarkBreaks]}
              rehypePlugins={[rehypeKatex, rehypeHighlight]}
            >
              {content}
            </ReactMarkdown>
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0">
          <LiveEditor value={content} onChange={onChange} />
        </div>
      )}
    </div>
  );
}
