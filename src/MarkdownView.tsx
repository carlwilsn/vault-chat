import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ComponentPropsWithoutRef, MouseEvent as ReactMouseEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkBreaks from "remark-breaks";
import rehypeRaw from "rehype-raw";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import "katex/dist/katex.min.css";
import "highlight.js/styles/github-dark.css";
import { invoke } from "@tauri-apps/api/core";
import { FileText, Eye, Pencil, X } from "lucide-react";
import { useStore } from "./store";
import { MonacoEditor } from "./MonacoEditor";
import { LiveEditor } from "./LiveEditor";
import { CodeView } from "./CodeView";
import { NotebookView } from "./NotebookView";
import { PdfView } from "./PdfView";
import { HtmlView } from "./HtmlView";
import { VAULT_PANE_MIME } from "./dnd";
import { InlineEditPrompt, type InlineEditRequest } from "./InlineEditPrompt";

type FileKind = "markdown" | "notebook" | "pdf" | "html" | "code";

function fileKind(path: string): { kind: FileKind; ext: string } {
  const dot = path.lastIndexOf(".");
  const ext = dot > 0 ? path.slice(dot + 1).toLowerCase() : "";
  if (ext === "md" || ext === "markdown") return { kind: "markdown", ext };
  if (ext === "ipynb") return { kind: "notebook", ext };
  if (ext === "pdf") return { kind: "pdf", ext };
  if (ext === "html" || ext === "htm") return { kind: "html", ext };
  return { kind: "code", ext };
}

function resolveRelative(baseFile: string, rel: string): string {
  const sep = baseFile.includes("\\") ? "\\" : "/";
  const baseParts = baseFile.slice(0, baseFile.lastIndexOf(sep)).split(sep);
  const relParts = rel.replace(/^\.\/+/, "").split(/[\/\\]/);
  for (const p of relParts) {
    if (p === "..") baseParts.pop();
    else if (p && p !== ".") baseParts.push(p);
  }
  return baseParts.join(sep);
}

function VaultLink({ href, children, ...rest }: ComponentPropsWithoutRef<"a">) {
  const currentFile = useStore((s) => s.currentFile);
  const setCurrentFile = useStore((s) => s.setCurrentFile);

  const onClick = async (e: ReactMouseEvent<HTMLAnchorElement>) => {
    if (!href) return;
    if (href.startsWith("#")) return; // in-page anchor — let browser scroll
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.toLowerCase().startsWith("file:")) {
      // External scheme (http/https/mailto/…). Prevent webview hijack;
      // opening in system browser is a follow-up.
      e.preventDefault();
      return;
    }
    e.preventDefault();
    if (!currentFile) return;
    const cleaned = href.replace(/^file:\/\/\/?/, "").split("#")[0].split("?")[0];
    const resolved = /^([a-zA-Z]:[\/\\]|[\/\\])/.test(cleaned)
      ? cleaned
      : resolveRelative(currentFile, cleaned);
    try {
      const { kind } = fileKind(resolved);
      const content =
        kind === "pdf" ? "" : await invoke<string>("read_text_file", { path: resolved });
      setCurrentFile(resolved, content);
    } catch (err) {
      console.error("vault-chat: failed to open linked file:", resolved, err);
    }
  };

  return (
    <a href={href} {...rest} onClick={onClick}>
      {children}
    </a>
  );
}

type Props = { paneId?: string };

export function MarkdownView({ paneId }: Props) {
  const currentFile = useStore((s) => s.currentFile);
  const currentContent = useStore((s) => s.currentContent);
  const panes = useStore((s) => s.panes);
  const activePaneId = useStore((s) => s.activePaneId);
  const mode = useStore((s) => s.mode);
  const toggleMode = useStore((s) => s.toggleMode);
  const reloadCurrent = useStore((s) => s.reloadCurrent);
  const setActivePane = useStore((s) => s.setActivePane);
  const closePane = useStore((s) => s.closePane);
  const updatePaneContent = useStore((s) => s.updatePaneContent);

  const pane = paneId ? panes.find((p) => p.id === paneId) : null;
  const file = pane ? pane.file : currentFile;
  const content = pane ? pane.content : currentContent;
  const isActive = paneId ? paneId === activePaneId : true;
  const inSplit = panes.length > 0;

  const saveTimer = useRef<number | null>(null);
  const lastSaved = useRef<string>(content);
  const scrollRatioRef = useRef(0);
  const viewScrollRef = useRef<HTMLDivElement | null>(null);
  const [inlineAsk, setInlineAsk] = useState<InlineEditRequest | null>(null);

  useEffect(() => {
    lastSaved.current = content;
    scrollRatioRef.current = 0;
  }, [file]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, []);

  useLayoutEffect(() => {
    const el = viewScrollRef.current;
    if (!el) return;
    const ratio = scrollRatioRef.current;
    if (ratio <= 0) return;
    const max = el.scrollHeight - el.clientHeight;
    if (max > 0) el.scrollTop = ratio * max;
  }, [mode, file]);

  const onViewScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const max = el.scrollHeight - el.clientHeight;
    scrollRatioRef.current = max > 0 ? el.scrollTop / max : 0;
  };

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

  // Ctrl+L in view mode opens the inline ask popover, using any text
  // the user has highlighted in the rendered markdown as the selection.
  // Only the active pane responds, so multi-pane doesn't double-fire.
  useEffect(() => {
    if (!file) return;
    const scroller = viewScrollRef.current;
    if (!scroller) return;
    const { kind: k, ext: e2 } = fileKind(file);
    if (mode !== "view" || k !== "markdown" || !isActive) return;

    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod || e.key.toLowerCase() !== "l") return;

      const sel = window.getSelection();
      const selectionText = sel && !sel.isCollapsed ? sel.toString() : "";

      // Anchor: bottom of the selection if present, else the viewer's
      // visible center-ish as a graceful fallback.
      let anchor: InlineEditRequest["anchor"];
      if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        anchor = { left: rect.left, top: rect.top, bottom: rect.bottom };
      } else {
        const r = scroller.getBoundingClientRect();
        anchor = {
          left: r.left + 40,
          top: r.top + r.height * 0.25,
          bottom: r.top + r.height * 0.25 + 20,
        };
      }

      // Context: if there's a selection, try to locate it in the source
      // content to slice before/after. Fall back to the whole file
      // being "before" if we can't find it (whitespace or formatting
      // normalization can make exact matches miss).
      let before = content;
      let after = "";
      if (selectionText) {
        const idx = content.indexOf(selectionText);
        if (idx >= 0) {
          before = content.slice(Math.max(0, idx - 6000), idx);
          after = content.slice(
            idx + selectionText.length,
            Math.min(content.length, idx + selectionText.length + 6000),
          );
        } else {
          before = content.slice(-6000);
        }
      } else {
        before = content.slice(-6000);
      }

      e.preventDefault();
      setInlineAsk({
        anchor,
        selection: selectionText,
        before,
        after,
        language: e2,
      });
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, file, isActive, content]);

  if (!file) {
    return (
      <div className="h-full flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <FileText className="h-8 w-8 opacity-30" />
          <p className="text-sm">Open a vault and pick a file to get started.</p>
        </div>
      </div>
    );
  }

  const relPath = file.split("/").slice(-3).join(" › ");
  const showActiveOutline = inSplit && isActive;
  const { kind, ext } = fileKind(file);
  // Code files are edit-only — Monaco renders them fine and the toggle
  // would just flip to a near-identical view. Only markdown has a
  // meaningful view/edit split.
  const showToggle = kind === "markdown";
  const showingEditor = kind === "code" || (kind === "markdown" && mode === "edit" && isActive);

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
          {showToggle && (
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
          )}
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
      {showingEditor && kind === "markdown" ? (
        <div className="flex-1 min-h-0">
          <LiveEditor
            value={content}
            onChange={onChange}
            initialScrollRatio={scrollRatioRef.current}
            onScrollRatio={(r) => {
              scrollRatioRef.current = r;
            }}
          />
        </div>
      ) : showingEditor ? (
        <div className="flex-1 min-h-0">
          <MonacoEditor value={content} onChange={onChange} ext={ext} />
        </div>
      ) : kind === "markdown" ? (
        <div
          ref={viewScrollRef}
          onScroll={onViewScroll}
          className="flex-1 overflow-auto py-10 px-8"
        >
          <div className="prose-md mx-auto">
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath, remarkBreaks]}
              rehypePlugins={[rehypeRaw, rehypeKatex, rehypeHighlight]}
              components={{ a: VaultLink }}
            >
              {content}
            </ReactMarkdown>
          </div>
        </div>
      ) : kind === "notebook" ? (
        <NotebookView content={content} />
      ) : kind === "pdf" ? (
        <PdfView path={file} />
      ) : kind === "html" ? (
        <HtmlView content={content} />
      ) : (
        <CodeView content={content} ext={ext} />
      )}
      {inlineAsk && (
        <InlineEditPrompt
          request={inlineAsk}
          initialMode="ask"
          askOnly
          onAccept={() => setInlineAsk(null)}
          onCancel={() => setInlineAsk(null)}
        />
      )}
    </div>
  );
}
