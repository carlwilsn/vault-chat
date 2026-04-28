import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import { Check, X, Loader2, CornerDownLeft, MessageSquare, StickyNote, Camera } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "./store";
import { findModel } from "./providers";
import { isUnreadableAsText } from "./fileKind";
import { fileKind } from "./fileKind";
import { cn } from "./lib/utils";
import type { NoteAnchor } from "./notes";
import {
  runInlineEdit,
  runInlineAsk,
  stripCodeFence,
  type InlineTurn,
} from "./inlineEdit";

const KATEX_OPTIONS = { strict: "ignore", errorColor: "currentColor" } as const;

export type InlineEditMode = "edit" | "ask";

export type InlineEditAnchor = {
  left: number;
  top: number;
  bottom: number;
  // Optional right edge. When present (PDF marquee), placement treats
  // the anchor as a full rect and places the popover on the side the
  // drag ended — dirX/dirY carry the drag direction.
  right?: number;
  // Sign of the drag's horizontal motion (+1 right, -1 left). Used only
  // with `right`. Defaults to +1 if omitted.
  dirX?: number;
  // Sign of the drag's vertical motion (+1 down, -1 up). Defaults to +1.
  dirY?: number;
};

export type InlineEditRequest = {
  anchor: InlineEditAnchor;
  selection: string;
  before: string;
  after: string;
  language?: string;
  // Optional screenshot (data URL) sent to the agent alongside the
  // text context in ask mode. Not shown to the user.
  imageDataUrl?: string;
  // Optional source-location hint for when this request later becomes
  // a note — e.g. "page=3" for a PDF marquee, "L42" for a code cursor.
  sourceAnchor?: string;
};

const POPOVER_WIDTH = 416;
const MARGIN = 8;
const MIN_VERTICAL_SPACE = 160;

export function InlineEditPrompt({
  request,
  initialMode = "edit",
  askOnly = false,
  onAccept,
  onCancel,
}: {
  request: InlineEditRequest;
  initialMode?: InlineEditMode;
  askOnly?: boolean;
  onAccept: (result: string) => void;
  onCancel: () => void;
}) {
  const modelId = useStore((s) => s.modelId);
  const apiKeys = useStore((s) => s.apiKeys);
  const vaultPath = useStore((s) => s.vaultPath);
  const serviceKeys = useStore((s) => s.serviceKeys);
  const files = useStore((s) => s.files);
  const currentFile = useStore((s) => s.currentFile);
  const openNoteComposer = useStore((s) => s.openNoteComposer);
  const [mode, setMode] = useState<InlineEditMode>(initialMode);
  const [prompt, setPrompt] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [result, setResult] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [priorTurns, setPriorTurns] = useState<InlineTurn[]>([]);
  const [lastPrompt, setLastPrompt] = useState<string | null>(null);
  // @mention autocomplete (ask mode only — edit mode stays surgical).
  const [fileMention, setFileMention] = useState<{ query: string; start: number } | null>(null);
  const [fileMentionIdx, setFileMentionIdx] = useState(0);
  const [attachedMentions, setAttachedMentions] = useState<
    Array<{ rel: string; path: string; name: string }>
  >([]);
  // Mid-conversation marquee injection. Each Capture click hides the
  // popover, fires a marquee, and the viewer pipes the image back via
  // store.editPromptLastImage → appended to extraImages → included
  // on the next agent turn.
  type CapturedImage = {
    imageDataUrl: string;
    sourcePath?: string;
    sourceAnchor?: string | null;
  };
  const [extraImages, setExtraImages] = useState<CapturedImage[]>([]);
  const [capturing, setCapturing] = useState(false);
  const editPromptLastCapture = useStore((s) => s.editPromptLastCapture);
  const setEditPromptLastCapture = useStore((s) => s.setEditPromptLastCapture);
  useEffect(() => {
    if (!editPromptLastCapture) return;
    setExtraImages((prev) => [
      ...prev,
      {
        imageDataUrl: editPromptLastCapture.imageDataUrl,
        sourcePath: editPromptLastCapture.sourcePath,
        sourceAnchor: editPromptLastCapture.sourceAnchor ?? null,
      },
    ]);
    setEditPromptLastCapture(null);
    setCapturing(false);
  }, [editPromptLastCapture, setEditPromptLastCapture]);

  const captureRegion = () => {
    setCapturing(true);
    // Clear any rival pending capture reservations so a stale chat-
    // or note-pending flag doesn't steal this marquee.
    const s = useStore.getState();
    s.setChatPaneCapturePending(false);
    s.setNoteCapturePending(false);
    s.setEditPromptCapturePending(true);
    window.dispatchEvent(new CustomEvent("vc-marquee-toggle"));
  };
  const removeExtraImage = (idx: number) => {
    setExtraImages((prev) => prev.filter((_, i) => i !== idx));
  };

  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    const cs = getComputedStyle(el);
    const lineHeight = parseFloat(cs.lineHeight) || 20;
    const padTop = parseFloat(cs.paddingTop) || 0;
    const padBot = parseFloat(cs.paddingBottom) || 0;
    const maxH = lineHeight * 6 + padTop + padBot;
    el.style.height = Math.min(el.scrollHeight, maxH) + "px";
  }, [prompt]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const filterFilesForMention = (query: string) => {
    if (!vaultPath) return [] as Array<{ path: string; name: string; rel: string }>;
    const q = query.toLowerCase();
    const hits: Array<{ path: string; name: string; rel: string; score: number }> = [];
    for (const f of files) {
      if (f.hidden) continue;
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
      hits.push({ path: f.path, name: f.name, rel, score });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, 8).map(({ score: _s, ...h }) => h);
  };

  const matchedFiles = fileMention ? filterFilesForMention(fileMention.query) : [];

  const onPromptChange = (v: string) => {
    setPrompt(v);
    if (mode !== "ask") {
      setFileMention(null);
      return;
    }
    const el = inputRef.current;
    const caret = el?.selectionStart ?? v.length;
    const upToCaret = v.slice(0, caret);
    const atMatch = upToCaret.match(/(^|\s)@([^\s]*)$/);
    if (atMatch) {
      setFileMention({ query: atMatch[2], start: caret - atMatch[2].length - 1 });
      setFileMentionIdx(0);
    } else {
      setFileMention(null);
    }
  };

  const pickMention = (hit: { rel: string; path: string; name: string }) => {
    if (!fileMention) return;
    const before = prompt.slice(0, fileMention.start);
    const after = prompt.slice(fileMention.start + 1 + fileMention.query.length);
    const insertion = `@${hit.name} `;
    const next = `${before}${insertion}${after.replace(/^\s+/, "")}`;
    setPrompt(next);
    setAttachedMentions((prev) => {
      if (prev.some((m) => m.path === hit.path)) return prev;
      return [...prev, hit];
    });
    setFileMention(null);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      const pos = before.length + insertion.length;
      el.setSelectionRange(pos, pos);
      el.focus();
    });
  };

  // Resolve all @tokens in the prompt to their file contents. Covers
  // both picked-from-dropdown mentions and manually-typed @name that
  // matches a vault basename (case-insensitive). Binaries have null
  // content; the agent can still see the path.
  const resolveAttachedFiles = async (
    text: string,
  ): Promise<Array<{ rel: string; path: string; content: string | null }>> => {
    const tokens = Array.from(text.matchAll(/(?:^|\s)@([\w][\w./-]*)/g)).map((m) => m[1]);
    const byPath = new Map<string, { rel: string; path: string; isDir?: boolean }>();
    for (const m of attachedMentions) {
      const f = files.find((f) => f.path === m.path);
      byPath.set(m.path, { rel: m.rel, path: m.path, isDir: f?.is_dir ?? false });
    }
    for (const tok of tokens) {
      const lower = tok.toLowerCase();
      if (attachedMentions.some((m) => m.name.toLowerCase() === lower)) continue;
      const hits = files.filter((f) => !f.hidden && f.name.toLowerCase() === lower);
      for (const h of hits) {
        if (!byPath.has(h.path)) {
          const rel = vaultPath && h.path.startsWith(vaultPath + "/")
            ? h.path.slice(vaultPath.length + 1)
            : h.path;
          byPath.set(h.path, { rel, path: h.path, isDir: h.is_dir });
        }
      }
    }
    const out: Array<{ rel: string; path: string; content: string | null }> = [];
    for (const r of byPath.values()) {
      if (r.isDir) {
        // Agent is told the path; it can ListDir/Glob/Grep if it wants.
        out.push({ rel: r.rel + "/", path: r.path, content: null });
      } else if (isUnreadableAsText(r.path)) {
        out.push({ rel: r.rel, path: r.path, content: null });
      } else {
        try {
          const content = await invoke<string>("read_text_file", { path: r.path });
          out.push({ rel: r.rel, path: r.path, content });
        } catch {
          out.push({ rel: r.rel, path: r.path, content: null });
        }
      }
    }
    return out;
  };

  const submit = async () => {
    if (!prompt.trim() || streaming) return;
    const spec = findModel(modelId);
    const key = spec ? apiKeys[spec.provider] : undefined;
    if (!spec || !key) {
      setError(`No API key for ${spec?.provider ?? modelId}. Add one in settings.`);
      return;
    }
    if (mode === "ask" && !vaultPath) {
      setError("Open a vault first — ask mode uses it for file context.");
      return;
    }

    // If there's an existing result and a previous prompt, archive the pair as
    // a prior turn so the model sees it as conversational history for the
    // refinement that follows.
    const nextPrior =
      result && lastPrompt !== null
        ? [...priorTurns, { prompt: lastPrompt, result }]
        : priorTurns;

    const currentPrompt = prompt.trim();
    setPriorTurns(nextPrior);
    setLastPrompt(currentPrompt);
    setPrompt("");
    setError(null);
    setResult("");
    setStreaming(true);
    setThinking(mode === "ask");
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      if (mode === "edit") {
        let acc = "";
        for await (const chunk of runInlineEdit({
          modelId,
          apiKey: key,
          prompt: currentPrompt,
          selection: request.selection,
          before: request.before,
          after: request.after,
          language: request.language,
          priorTurns: nextPrior,
          extraImages,
          abortSignal: ac.signal,
        })) {
          acc += chunk;
          setResult(acc);
        }
      } else {
        let acc = "";
        const attachedFiles = await resolveAttachedFiles(currentPrompt);
        // Only on the first popover turn, pull the last few chat-pane
        // turns as context. Keeps subsequent popover turns focused on
        // the in-popover thread without re-sending the chat history.
        const isFirstTurn = nextPrior.length === 0;
        const chatPaneHistory = isFirstTurn
          ? recentChatPaneHistory(useStore.getState().messages, 6)
          : undefined;
        for await (const ev of runInlineAsk({
          modelId,
          apiKey: key,
          vault: vaultPath!,
          tavilyKey: serviceKeys.tavily,
          prompt: currentPrompt,
          selection: request.selection,
          before: request.before,
          after: request.after,
          language: request.language,
          imageDataUrl: request.imageDataUrl,
          attachedFiles,
          priorTurns: nextPrior,
          extraImages,
          chatPaneHistory,
          abortSignal: ac.signal,
        })) {
          if (ev.kind === "text") {
            setThinking(false);
            acc += ev.delta;
            setResult(acc);
          } else if (ev.kind === "thinking") {
            setThinking(true);
          } else if (ev.kind === "error") {
            setError(ev.message);
          }
        }
      }
    } catch (e: any) {
      if (e?.name !== "AbortError") {
        setError(e?.message ?? String(e));
      }
    } finally {
      setStreaming(false);
      setThinking(false);
      abortRef.current = null;
      // extraImages were consumed by this turn; clear so the next
      // turn doesn't double-include them.
      setExtraImages([]);
    }
  };

  const switchMode = (next: InlineEditMode) => {
    if (next === mode || streaming) return;
    setMode(next);
    setPriorTurns([]);
    setLastPrompt(null);
    setResult("");
    setError(null);
  };

  const accept = () => {
    if (!result || streaming) return;
    onAccept(stripCodeFence(result));
  };

  const sendToChat = () => {
    if (!result || streaming) return;
    const store = useStore.getState();
    const turns: { prompt: string; result: string }[] = [
      ...priorTurns,
      ...(lastPrompt !== null ? [{ prompt: lastPrompt, result }] : []),
    ];
    if (turns.length === 0) return;

    // Marquee asks carry imageDataUrl — show only the image in the
    // bubble (any text the marquee scraped is incidental, not what the
    // user pointed at). Text-selection asks show the quoted selection.
    // Surrounding file excerpt always stays hidden.
    //
    // Always lead with a small "@file:anchor" badge so the chat
    // history records where this thread came from — without it the
    // transplanted turns are context-less.
    const fileName = currentFile ? currentFile.split("/").pop() : null;
    const locationLabel = fileName
      ? request.sourceAnchor
        ? `@${fileName}:${request.sourceAnchor}`
        : `@${fileName}`
      : null;

    // Collect every image attached to this popover thread: the
    // original marquee (request.imageDataUrl) plus any mid-
    // conversation captures (extraImages). They ride along as
    // proper ChatMessage attachments so the chat bubble renders
    // thumbnails and future agent turns see them as image content
    // parts, not just markdown-embedded data URLs.
    const attachments: Array<{
      imageDataUrl: string;
      sourcePath?: string;
      sourceAnchor?: string | null;
    }> = [];
    if (request.imageDataUrl) {
      attachments.push({
        imageDataUrl: request.imageDataUrl,
        sourcePath: currentFile ?? undefined,
        sourceAnchor: request.sourceAnchor ?? null,
      });
    }
    for (const img of extraImages) {
      attachments.push({
        imageDataUrl: img.imageDataUrl,
        sourcePath: img.sourcePath,
        sourceAnchor: img.sourceAnchor ?? null,
      });
    }

    const visiblePrefixParts: string[] = [];
    if (locationLabel) {
      visiblePrefixParts.push(`*from ${locationLabel}*`);
    }
    // Show a quoted selection in text (still useful for text-ask).
    // Images come through the attachments list now, so we no longer
    // embed a data URL in the content markdown.
    if (!request.imageDataUrl && request.selection) {
      const quoted = request.selection
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      visiblePrefixParts.push(quoted);
    }
    const visiblePrefix = visiblePrefixParts.length
      ? visiblePrefixParts.join("\n\n") + "\n\n"
      : "";

    const hiddenPreamble = buildHiddenFilePreamble(request, currentFile);
    if (hiddenPreamble) {
      store.appendMessage({ role: "user", content: hiddenPreamble, hidden: true });
    }

    const [first, ...rest] = turns;
    store.appendMessage({
      role: "user",
      content: visiblePrefix + first.prompt,
      attachments: attachments.length > 0 ? attachments : undefined,
    });
    store.appendMessage({ role: "assistant", content: first.result });
    rest.forEach((t) => {
      store.appendMessage({ role: "user", content: t.prompt });
      store.appendMessage({ role: "assistant", content: t.result });
    });

    if (store.rightCollapsed) store.toggleRight();
    onCancel();
  };

  const cancel = () => {
    abortRef.current?.abort();
    onCancel();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Let the @mention menu consume navigation keys first.
    if (fileMention && matchedFiles.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFileMentionIdx((i) => Math.min(i + 1, matchedFiles.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setFileMentionIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        pickMention(matchedFiles[fileMentionIdx] ?? matchedFiles[0]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setFileMention(null);
        return;
      }
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancel();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      if (streaming) return;
      if (prompt.trim()) submit();
      else if (result) accept();
    }
  };

  // Snapshot the current popover state into a note. Carries the
  // user's ask conversation (if any), their current draft, the
  // selection as the primary anchor's selection field, and any
  // marquee image. Agent clarity is preserved in the thread.
  const saveAsNote = () => {
    if (!currentFile && !request.selection && !request.imageDataUrl) return;
    const fk = currentFile ? fileKind(currentFile).kind : "code";
    const primaryAnchor: NoteAnchor = {
      source_path: currentFile ?? "",
      source_kind: (fk === "markdown" || fk === "pdf" || fk === "html" || fk === "image" || fk === "notebook"
        ? fk
        : "code") as NoteAnchor["source_kind"],
      source_anchor: request.sourceAnchor ?? null,
      source_before: request.before || null,
      source_after: request.after || null,
      source_selection: request.selection || null,
      image_data_url: request.imageDataUrl || null,
      primary: true,
    };
    const anchors: NoteAnchor[] = currentFile ? [primaryAnchor] : [];
    // Also add every attached @mention as a secondary anchor.
    for (const m of attachedMentions) {
      if (m.path === currentFile) continue;
      anchors.push({
        source_path: m.path,
        source_kind: (fileKind(m.path).kind === "markdown" || fileKind(m.path).kind === "pdf" || fileKind(m.path).kind === "html" || fileKind(m.path).kind === "image" || fileKind(m.path).kind === "notebook"
          ? fileKind(m.path).kind
          : "code") as NoteAnchor["source_kind"],
        source_anchor: null,
        primary: false,
      });
    }
    // Reconstruct turns from priorTurns (pairs of prompt/result) plus
    // the current exchange if present.
    const turns: { role: "user" | "assistant"; content: string }[] = [];
    for (const t of priorTurns) {
      turns.push({ role: "user", content: t.prompt });
      turns.push({ role: "assistant", content: t.result });
    }
    if (lastPrompt !== null && result) {
      turns.push({ role: "user", content: lastPrompt });
      turns.push({ role: "assistant", content: result });
    }
    openNoteComposer({
      initialDraft: prompt,
      initialAnchors: anchors,
      initialTurns: turns,
    });
  };

  // Pick side (below vs above) based on where there's more room, and cap
  // max-height to the viewport so very long streamed output stays scrollable
  // inside the popover instead of overflowing the screen.
  const [placement, setPlacement] = useState<{
    left: number;
    top?: number;
    bottom?: number;
    maxHeight: number;
  }>(() => computePlacement(request.anchor));
  // Drag offset applied on top of the computed placement. Once the user
  // has dragged, stop re-applying placement from anchor changes or
  // window resize — the user's manual position wins.
  const [drag, setDrag] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const dragged = useRef(false);

  useLayoutEffect(() => {
    if (dragged.current) return;
    setPlacement(computePlacement(request.anchor));
  }, [request.anchor.left, request.anchor.top, request.anchor.bottom, request.anchor.right, request.anchor.dirX, request.anchor.dirY]);

  useEffect(() => {
    const onResize = () => {
      if (dragged.current) return;
      setPlacement(computePlacement(request.anchor));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [request.anchor.left, request.anchor.top, request.anchor.bottom, request.anchor.right, request.anchor.dirX, request.anchor.dirY]);

  const [dragging, setDragging] = useState(false);

  // Begin a drag from anywhere on the popup that isn't an interactive
  // control. A 6px threshold lets short clicks pass through as normal
  // text selection / link clicks inside the rendered result; once the
  // pointer has moved past that, we take over, clear any selection that
  // started, and move the popup.
  const onDragPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (t.closest("textarea, input, button, a")) return;
    if (e.button !== 0) return;
    const originX = e.clientX;
    const originY = e.clientY;
    const startX = e.clientX - drag.x;
    const startY = e.clientY - drag.y;
    let active = false;
    const onMove = (ev: PointerEvent) => {
      if (!active) {
        const dx = ev.clientX - originX;
        const dy = ev.clientY - originY;
        if (dx * dx + dy * dy < 36) return; // 6px threshold
        active = true;
        setDragging(true);
        // Cancel any in-progress text selection that the initial
        // mousedown may have started.
        window.getSelection()?.removeAllRanges();
      }
      ev.preventDefault();
      setDrag({ x: ev.clientX - startX, y: ev.clientY - startY });
      dragged.current = true;
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDragging(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return createPortal(
    <div
      className="fixed z-50 w-[416px] max-w-[90vw] rounded-md border border-border bg-card shadow-xl flex flex-col"
      style={{
        left: placement.left + drag.x,
        top: placement.top != null ? placement.top + drag.y : undefined,
        bottom: placement.bottom != null ? placement.bottom - drag.y : undefined,
        maxHeight: placement.maxHeight,
        userSelect: dragging ? "none" : undefined,
        WebkitUserSelect: dragging ? "none" : undefined,
        cursor: dragging ? "grabbing" : undefined,
        // Hide while the user is drawing a marquee; state stays
        // mounted so prompt / prior turns / result survive.
        visibility: capturing ? "hidden" : undefined,
        pointerEvents: capturing ? "none" : undefined,
      }}
      onKeyDown={onKeyDown}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={onDragPointerDown}
    >
      {fileMention && matchedFiles.length > 0 && (
        <div className="max-h-[180px] overflow-auto border-b border-border/60">
          {matchedFiles.map((f, i) => (
            <div
              key={f.path}
              className={cn(
                "flex items-baseline gap-2 px-3 py-1.5 cursor-pointer border-b border-border/30 last:border-b-0",
                i === fileMentionIdx ? "bg-accent" : "hover:bg-accent/60",
              )}
              onMouseDown={(e) => {
                e.preventDefault();
                pickMention(f);
              }}
              onMouseEnter={() => setFileMentionIdx(i)}
            >
              <span className="text-primary font-mono text-[11.5px] font-medium shrink-0 max-w-[50%] truncate">
                {f.name}
              </span>
              <span className="text-muted-foreground text-[10.5px] truncate font-mono">
                {f.rel}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-start gap-1 p-2 shrink-0">
        <textarea
          ref={inputRef}
          rows={1}
          value={prompt}
          onChange={(e) => onPromptChange(e.target.value)}
          placeholder={
            result
              ? mode === "edit"
                ? "Refine, or Enter to accept…"
                : "Follow-up…"
              : mode === "ask"
                ? request.selection
                  ? "Ask about the selection…"
                  : "Ask about this file…"
                : request.selection
                  ? "Edit the selection…"
                  : "Generate at cursor…"
          }
          disabled={streaming}
          className="flex-1 min-w-0 resize-none overflow-y-auto bg-transparent p-1 text-[13px] text-foreground outline-none placeholder:text-muted-foreground/60"
        />
        {!streaming && prompt.trim() && (
          <button
            onClick={submit}
            className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:bg-accent/60 hover:text-foreground"
            title={result ? "Send refinement (Enter)" : "Submit (Enter)"}
          >
            <CornerDownLeft className="h-3 w-3" />
          </button>
        )}
        {!streaming && !prompt.trim() && result && mode === "edit" && (
          <button
            onClick={accept}
            className="h-6 px-2 flex items-center gap-1 rounded bg-primary/90 text-[11px] text-primary-foreground hover:bg-primary"
            title="Accept (Enter)"
          >
            <Check className="h-3 w-3" />
            accept
          </button>
        )}
        {!streaming && result && mode === "ask" && (
          <button
            onClick={sendToChat}
            className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:bg-accent/60 hover:text-foreground"
            title="Send conversation to chat panel"
          >
            <MessageSquare className="h-3 w-3" />
          </button>
        )}
        {!streaming && mode === "ask" && (
          <button
            onClick={saveAsNote}
            className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:bg-accent/60 hover:text-foreground"
            title="Save as note — keeps selection, conversation, and source anchor"
          >
            <StickyNote className="h-3 w-3" />
          </button>
        )}
        {!streaming &&
          (request.language === "pdf" ||
            request.language === "html" ||
            request.language === "image") && (
            <button
              onClick={captureRegion}
              className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:bg-accent/60 hover:text-foreground"
              title="Capture region — hides this popup, draw a marquee, then resume with the image attached"
            >
              <Camera className="h-3 w-3" />
            </button>
          )}
        <button
          onClick={cancel}
          className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:bg-accent/60 hover:text-foreground"
          title={streaming ? "Stop (Esc)" : "Close (Esc)"}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {extraImages.length > 0 && (
        <div className="flex flex-wrap gap-2 px-3 pb-2 border-t border-border/40 pt-2">
          {extraImages.map((img, i) => {
            const name = img.sourcePath?.split("/").pop();
            return (
              <div key={i} className="relative group flex flex-col items-start gap-0.5">
                <img
                  src={img.imageDataUrl}
                  alt={`captured ${i + 1}`}
                  className="max-h-[64px] rounded border border-border/60"
                />
                {name && (
                  <span className="text-[9.5px] text-muted-foreground font-mono">
                    {name}
                    {img.sourceAnchor ? ` · ${img.sourceAnchor}` : ""}
                  </span>
                )}
                <button
                  onClick={() => removeExtraImage(i)}
                  className="absolute -top-1.5 -right-1.5 h-4 w-4 flex items-center justify-center rounded-full bg-card border border-border text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100"
                  title="Remove"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </div>
            );
          })}
        </div>
      )}
      {(streaming || result || error) && (
        <div
          className="prose-chat min-h-0 overflow-auto border-t border-border/60 px-3 py-2 text-foreground/90"
          style={{ maxHeight: "calc(20 * 1lh + 1rem)" }}
        >
          {error ? (
            <span className="text-destructive">{error}</span>
          ) : (
            <>
              {thinking && !result && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  <span>Thinking…</span>
                </div>
              )}
              {result && (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm, remarkMath]}
                  rehypePlugins={[[rehypeKatex, KATEX_OPTIONS], rehypeHighlight]}
                >
                  {result}
                </ReactMarkdown>
              )}
              {streaming && result && (
                <Loader2 className="inline h-3 w-3 ml-1 animate-spin text-muted-foreground align-[-2px]" />
              )}
            </>
          )}
        </div>
      )}
      <div className="flex items-center justify-between border-t border-border/60 px-3 py-1 text-[10.5px] text-muted-foreground shrink-0">
        <div className="flex items-center gap-1">
          {!askOnly && (
            <>
              <button
                onClick={() => switchMode("edit")}
                disabled={streaming}
                className={
                  mode === "edit"
                    ? "px-1.5 py-0.5 rounded text-foreground"
                    : "px-1.5 py-0.5 rounded opacity-60 hover:opacity-100 disabled:opacity-40"
                }
              >
                edit
              </button>
              <span className="opacity-40">·</span>
              <button
                onClick={() => switchMode("ask")}
                disabled={streaming}
                className={
                  mode === "ask"
                    ? "px-1.5 py-0.5 rounded text-foreground"
                    : "px-1.5 py-0.5 rounded opacity-60 hover:opacity-100 disabled:opacity-40"
                }
              >
                ask
              </button>
            </>
          )}
          {askOnly && <span className="text-foreground">ask</span>}
          <span className="ml-2 opacity-50">
            {request.selection
              ? `${request.selection.length} char selection`
              : mode === "edit"
                ? "empty cursor → insert"
                : "no selection"}
          </span>
          {priorTurns.length > 0 && (
            <span className="ml-1 opacity-50">
              · {priorTurns.length} prior {priorTurns.length === 1 ? "turn" : "turns"}
            </span>
          )}
        </div>
        <span className="opacity-70">Enter · Esc</span>
      </div>
    </div>,
    document.body,
  );
}

// Build the hidden-only portion of the chat preamble — surrounding
// file context (before/after). The user's selection and any captured
// image go in the visible user bubble instead, so the chat shows "what
// you asked about" without piping the full file excerpt into the UI.
/** Last N non-system / non-hidden messages from the chat pane, in
 *  chronological order, clipped to a reasonable per-turn length so a
 *  chatty session doesn't balloon the popover prompt. */
function recentChatPaneHistory(
  messages: Array<{
    role: "user" | "assistant";
    content: string;
    system?: boolean;
    hidden?: boolean;
  }>,
  n: number,
): Array<{ role: "user" | "assistant"; content: string }> {
  const visible = messages.filter((m) => !m.system && !m.hidden);
  const tail = visible.slice(-n);
  const MAX_PER_TURN = 1200;
  return tail.map((m) => ({
    role: m.role,
    content:
      m.content.length > MAX_PER_TURN
        ? m.content.slice(0, MAX_PER_TURN) + "…"
        : m.content,
  }));
}

function buildHiddenFilePreamble(
  request: InlineEditRequest,
  currentFile: string | null,
): string {
  const BEFORE_KEEP = 1500;
  const AFTER_KEEP = 1500;
  const before = request.before
    ? request.before.length > BEFORE_KEEP
      ? "…" + request.before.slice(-BEFORE_KEEP)
      : request.before
    : "";
  const after = request.after
    ? request.after.length > AFTER_KEEP
      ? request.after.slice(0, AFTER_KEEP) + "…"
      : request.after
    : "";
  const hasAny =
    before || after || request.selection || currentFile || request.sourceAnchor;
  if (!hasAny) return "";
  const parts: string[] = [
    "[Hidden context preamble from an inline ask transplanted into this thread.]",
  ];
  if (currentFile) {
    const anchor = request.sourceAnchor ? ` (${request.sourceAnchor})` : "";
    parts.push(`Source file: ${currentFile}${anchor}`);
  }
  if (request.selection) {
    parts.push(`Selection at that location:\n\n\`\`\`\n${request.selection}\n\`\`\``);
  }
  if (before) parts.push(`Before:\n\n\`\`\`\n${before}\n\`\`\``);
  if (after) parts.push(`After:\n\n\`\`\`\n${after}\n\`\`\``);
  return parts.join("\n\n");
}

function computePlacement(anchor: InlineEditAnchor) {
  const vw = typeof window !== "undefined" ? window.innerWidth : 1400;
  const vh = typeof window !== "undefined" ? window.innerHeight : 900;
  const gap = 6;
  const maxLeft = Math.max(MARGIN, vw - POPOVER_WIDTH - MARGIN);

  // Marquee / rect mode: the only constraint is "don't overlap the
  // rect." The popover is free to float over any other UI (file tree,
  // chat pane, etc.). Always place on the drag-end side; clamp only to
  // keep the popover corner inside the viewport.
  if (anchor.right !== undefined) {
    const dirX = anchor.dirX ?? 1;
    const dirY = anchor.dirY ?? 1;

    // Horizontal. Rightward drag → popover's left edge just past rect.right
    // and clamped so it's not fully off-screen. Leftward drag → mirror.
    let left: number;
    if (dirX >= 0) {
      left = Math.min(anchor.right + gap, vw - POPOVER_WIDTH - MARGIN);
      // If the viewport is so narrow that this clamp would push the
      // popover back over the rect, honor the "no overlap" rule by
      // keeping it right at rect.right + gap (may extend off-screen).
      if (left < anchor.right + gap) left = anchor.right + gap;
    } else {
      left = Math.max(anchor.left - POPOVER_WIDTH - gap, MARGIN);
      if (left + POPOVER_WIDTH + gap > anchor.left) {
        left = anchor.left - POPOVER_WIDTH - gap;
      }
    }

    // Vertical. Same idea — honor the drag's vertical direction; clamp
    // maxHeight so the popover fits, but don't flip away from the drag.
    const spaceBelow = vh - anchor.bottom - gap - MARGIN;
    const spaceAbove = anchor.top - gap - MARGIN;

    if (dirY >= 0) {
      return {
        left,
        top: anchor.bottom + gap,
        maxHeight: Math.max(MIN_VERTICAL_SPACE, spaceBelow),
      };
    }
    return {
      left,
      bottom: vh - anchor.top + gap,
      maxHeight: Math.max(MIN_VERTICAL_SPACE, spaceAbove),
    };
  }

  const left = Math.max(MARGIN, Math.min(anchor.left, maxLeft));
  const spaceBelow = vh - anchor.bottom - MARGIN * 2;
  const spaceAbove = anchor.top - MARGIN * 2;

  if (spaceBelow >= MIN_VERTICAL_SPACE || spaceBelow >= spaceAbove) {
    return {
      left,
      top: anchor.bottom + gap,
      maxHeight: Math.max(MIN_VERTICAL_SPACE, spaceBelow),
    };
  }
  return {
    left,
    bottom: vh - anchor.top + gap,
    maxHeight: Math.max(MIN_VERTICAL_SPACE, spaceAbove),
  };
}
