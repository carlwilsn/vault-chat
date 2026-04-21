import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ComponentPropsWithoutRef, MouseEvent as ReactMouseEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkBreaks from "remark-breaks";
import rehypeRaw from "rehype-raw";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import { visit } from "unist-util-visit";
import type { Plugin } from "unified";
import type { Root } from "mdast";
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
import { ImageView } from "./ImageView";
import { UnsupportedView } from "./UnsupportedView";
import { VAULT_PANE_MIME } from "./dnd";
import { InlineEditPrompt, type InlineEditRequest } from "./InlineEditPrompt";
import { fileKind } from "./fileKind";

// Obsidian-style wikilinks: `[[Target]]`, `[[Target|Display]]`, and
// `[[Target#Section]]`. We rewrite them to plain markdown links with a
// `vault://` scheme so VaultLink can tell them apart from file-relative
// paths and resolve against the vault root. If Target has no extension,
// `.md` is appended so `[[goals/foo]]` opens the corresponding note.
const wikiLinkRe = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

const remarkWikiLinks: Plugin<[], Root> = () => {
  return (tree) => {
    visit(tree, "text", (node, index, parent) => {
      if (!parent || typeof index !== "number") return;
      const value = node.value;
      if (!value.includes("[[")) return;
      wikiLinkRe.lastIndex = 0;
      const pieces: Array<Root["children"][number] | { type: "text"; value: string }> = [];
      let last = 0;
      let match: RegExpExecArray | null;
      while ((match = wikiLinkRe.exec(value)) !== null) {
        if (match.index > last) {
          pieces.push({ type: "text", value: value.slice(last, match.index) });
        }
        const rawTarget = match[1].trim();
        const display = (match[2] ?? rawTarget).trim();
        // Split out #anchor if present.
        const hashAt = rawTarget.indexOf("#");
        const pathPart = hashAt >= 0 ? rawTarget.slice(0, hashAt) : rawTarget;
        const anchor = hashAt >= 0 ? rawTarget.slice(hashAt) : "";
        const hasExt = /\.[^./\\]+$/.test(pathPart);
        const url = `vault://${hasExt ? pathPart : pathPart + ".md"}${anchor}`;
        pieces.push({
          type: "link",
          url,
          title: null,
          children: [{ type: "text", value: display }],
        } as Root["children"][number]);
        last = wikiLinkRe.lastIndex;
      }
      if (pieces.length === 0) return;
      if (last < value.length) {
        pieces.push({ type: "text", value: value.slice(last) });
      }
      parent.children.splice(index, 1, ...(pieces as Root["children"]));
      return index + pieces.length;
    });
  };
};

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

// Render anchors safely: for internal links (vault://, relative paths)
// we strip the real href attribute so the webview cannot navigate under
// any circumstance — the global click handler in App reads the original
// href from `data-href`. External links keep their href so the default
// browser tooltip shows the URL on hover.
function SafeAnchor({ href, children, ...rest }: ComponentPropsWithoutRef<"a">) {
  if (!href || href.startsWith("#")) {
    return <a href={href} {...rest}>{children}</a>;
  }
  const isExternal = /^(https?:|mailto:)/i.test(href);
  if (isExternal) {
    return <a href={href} {...rest}>{children}</a>;
  }
  return (
    <a
      role="link"
      data-href={href}
      className="cursor-pointer text-primary underline underline-offset-2 hover:opacity-80"
      title={href.startsWith("vault://") ? href.slice("vault://".length) : href}
      {...rest}
    >
      {children}
    </a>
  );
}

// Renders an <img> whose src has been resolved relative to the current
// vault file and read off disk into a blob URL. The webview can't load
// local file:// URLs directly, so we always go through read_binary_file.
function VaultImage({ src, alt, ...rest }: ComponentPropsWithoutRef<"img">) {
  const currentFile = useStore((s) => s.currentFile);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!src || !currentFile) return;
    // External / data / blob URLs — leave alone.
    if (/^(https?:|data:|blob:)/i.test(src)) {
      setUrl(src);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    const cleaned = src.replace(/^file:\/\/\/?/, "").split("#")[0].split("?")[0];
    const resolved = /^([a-zA-Z]:[\/\\]|[\/\\])/.test(cleaned)
      ? cleaned
      : resolveRelative(currentFile, cleaned);
    (async () => {
      try {
        const bytes = await invoke<number[]>("read_binary_file", { path: resolved });
        if (cancelled) return;
        const dot = resolved.lastIndexOf(".");
        const ext = dot > 0 ? resolved.slice(dot + 1).toLowerCase() : "";
        const mime =
          ext === "svg"
            ? "image/svg+xml"
            : ext === "jpg" || ext === "jpeg"
              ? "image/jpeg"
              : ext === "png"
                ? "image/png"
                : ext === "gif"
                  ? "image/gif"
                  : ext === "webp"
                    ? "image/webp"
                    : ext === "bmp"
                      ? "image/bmp"
                      : ext === "ico"
                        ? "image/x-icon"
                        : `image/${ext || "png"}`;
        const blob = new Blob([new Uint8Array(bytes)], { type: mime });
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      } catch (err) {
        console.error("vault-chat: failed to load image:", resolved, err);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src, currentFile]);

  if (!url) return <span className="text-muted-foreground italic">[{alt || src}]</span>;
  return <img src={url} alt={alt} {...rest} />;
}

// Flip the Nth GFM task-list checkbox in `content`. A task-list item is a
// list item (- / * / + / "1.") whose first inline content is "[ ]", "[x]",
// or "[X]". Matches must start on a new line; "[x]" buried inside a
// paragraph is not a task checkbox. Blockquote-prefixed items (`> - [ ]`
// and nested `> > - [ ]`) are matched too.
function flipNthTaskCheckbox(content: string, n: number): string | null {
  const re = /^([ \t]*(?:>[ \t]*)*(?:[-*+]|\d+\.)[ \t]+)\[([ xX])\]/gm;
  let i = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    if (i === n) {
      const cur = match[2];
      const flipped = cur === " " ? "x" : " ";
      const charIdx = match.index + match[1].length + 1; // position between the brackets
      return content.slice(0, charIdx) + flipped + content.slice(charIdx + 1);
    }
    i++;
  }
  return null;
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

  // GFM task checkboxes render as <input type="checkbox" disabled> via
  // remark-gfm. We override the input component to make them interactive:
  // on toggle, locate the clicked checkbox's index among all rendered
  // checkboxes, flip the Nth task-list token in the source, and save.
  const renderInput = (props: ComponentPropsWithoutRef<"input"> & { node?: unknown }) => {
    const { node: _node, type, disabled: _disabled, checked, onChange: _oc, ...rest } = props;
    if (type !== "checkbox") {
      return <input type={type} disabled={_disabled} {...rest} />;
    }
    const onFlip = (e: ReactMouseEvent<HTMLInputElement>) => {
      const scope = viewScrollRef.current;
      if (!scope) return;
      const all = Array.from(
        scope.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
      );
      const idx = all.indexOf(e.currentTarget);
      if (idx < 0) return;
      const next = flipNthTaskCheckbox(content, idx);
      if (next == null) return;
      onChange(next);
    };
    return (
      <input
        type="checkbox"
        checked={!!checked}
        onChange={() => {}}
        onClick={onFlip}
        style={{ cursor: "pointer" }}
        {...rest}
      />
    );
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

  // Ctrl+L ask (no context) for PDF, HTML, and image viewers. These don't
  // have a meaningful source-text window to slice like markdown does, so
  // we open the prompt with empty before/after — the user's question
  // stands on its own.
  useEffect(() => {
    if (!file || !isActive) return;
    const { kind: k, ext: e2 } = fileKind(file);
    if (k !== "pdf" && k !== "html" && k !== "image") return;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod || e.key.toLowerCase() !== "l") return;
      e.preventDefault();
      const anchor: InlineEditRequest["anchor"] = {
        left: window.innerWidth * 0.5,
        top: window.innerHeight * 0.4,
        bottom: window.innerHeight * 0.4 + 20,
      };
      setInlineAsk({
        anchor,
        selection: "",
        before: "",
        after: "",
        language: e2,
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [file, isActive]);

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
              remarkPlugins={[remarkGfm, remarkMath, remarkBreaks, remarkWikiLinks]}
              rehypePlugins={[rehypeRaw, rehypeKatex, rehypeHighlight]}
              components={{ a: SafeAnchor, img: VaultImage, input: renderInput }}
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
      ) : kind === "image" ? (
        <ImageView path={file} />
      ) : kind === "unsupported" ? (
        <UnsupportedView path={file} />
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
