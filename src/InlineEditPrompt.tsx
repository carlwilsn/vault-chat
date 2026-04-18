import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import { Check, X, Loader2, CornerDownLeft, MessageSquare } from "lucide-react";
import { useStore } from "./store";
import { findModel } from "./providers";
import {
  runInlineEdit,
  runInlineAsk,
  stripCodeFence,
  type InlineTurn,
} from "./inlineEdit";

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
  const [mode, setMode] = useState<InlineEditMode>(initialMode);
  const [prompt, setPrompt] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [result, setResult] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [priorTurns, setPriorTurns] = useState<InlineTurn[]>([]);
  const [lastPrompt, setLastPrompt] = useState<string | null>(null);
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
          abortSignal: ac.signal,
        })) {
          acc += chunk;
          setResult(acc);
        }
      } else {
        let acc = "";
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
          priorTurns: nextPrior,
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

    // Prepend the inline-ask context to the first user message so the
    // main agent has everything this popover saw (selection + file
    // excerpt). Subsequent turns are pasted as-is.
    const preamble = buildContextPreamble(request);
    // The preamble goes in as a hidden user message so the agent sees
    // the selection + file context, but the chat UI only shows what the
    // user actually typed.
    store.appendMessage({ role: "user", content: preamble, hidden: true });
    turns.forEach((t) => {
      store.appendMessage({ role: "user", content: t.prompt });
      store.appendMessage({ role: "assistant", content: t.result });
    });

    // Reveal the chat pane if it was collapsed.
    if (store.rightCollapsed) store.toggleRight();

    onCancel();
  };

  const cancel = () => {
    abortRef.current?.abort();
    onCancel();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
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

  // Pick side (below vs above) based on where there's more room, and cap
  // max-height to the viewport so very long streamed output stays scrollable
  // inside the popover instead of overflowing the screen.
  const [placement, setPlacement] = useState<{
    left: number;
    top?: number;
    bottom?: number;
    maxHeight: number;
  }>(() => computePlacement(request.anchor));

  useLayoutEffect(() => {
    setPlacement(computePlacement(request.anchor));
  }, [request.anchor.left, request.anchor.top, request.anchor.bottom, request.anchor.right, request.anchor.dirX, request.anchor.dirY]);

  useEffect(() => {
    const onResize = () => setPlacement(computePlacement(request.anchor));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [request.anchor.left, request.anchor.top, request.anchor.bottom, request.anchor.right, request.anchor.dirX, request.anchor.dirY]);

  return createPortal(
    <div
      className="fixed z-50 w-[416px] max-w-[90vw] rounded-md border border-border bg-card shadow-xl flex flex-col"
      style={{
        left: placement.left,
        top: placement.top,
        bottom: placement.bottom,
        maxHeight: placement.maxHeight,
      }}
      onKeyDown={onKeyDown}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-start gap-1 p-2 shrink-0">
        <textarea
          ref={inputRef}
          rows={1}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
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
        <button
          onClick={cancel}
          className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:bg-accent/60 hover:text-foreground"
          title={streaming ? "Stop (Esc)" : "Close (Esc)"}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
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
                  rehypePlugins={[rehypeKatex, rehypeHighlight]}
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

function buildContextPreamble(request: InlineEditRequest): string {
  const parts: string[] = [];
  parts.push(
    "Context from an inline Ctrl+L ask in the editor — continuing the conversation in the chat pane.",
  );
  if (request.selection) {
    parts.push(`Selection:\n\n\`\`\`\n${request.selection}\n\`\`\``);
  } else {
    parts.push("(no selection — the question was about the surrounding file)");
  }
  const BEFORE_KEEP = 1500;
  const AFTER_KEEP = 1500;
  const before =
    request.before.length > BEFORE_KEEP
      ? "…" + request.before.slice(-BEFORE_KEEP)
      : request.before;
  const after =
    request.after.length > AFTER_KEEP
      ? request.after.slice(0, AFTER_KEEP) + "…"
      : request.after;
  parts.push(`Before:\n\n\`\`\`\n${before}\n\`\`\``);
  parts.push(`After:\n\n\`\`\`\n${after}\n\`\`\``);
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
