import { useShallow } from "zustand/react/shallow";
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentPropsWithoutRef } from "react";
import { Markdown, StreamingMarkdown } from "./Markdown";
import { readChatImage } from "./chatImage";
import { InlineHtmlFrame } from "./InlineHtmlFrame";
import { VideoPlayer } from "./VideoPlayer";
import { isHtmlSrc } from "./inlineHtml";
import { InlineWebPage } from "./InlineWebPage";
import { soloWebImages } from "./inlineWeb";
import { localPathFromUrl } from "./mdPipeline";
import { planDone, planCards, currentPlan, type PlanCard } from "./planPlace";
import { ChevronDown, ChevronUp, Wrench, Mic, AlertCircle, Info, Loader2, FileText } from "lucide-react";
import { splitFilesLine } from "./filesLine";
import { invoke } from "@tauri-apps/api/core";
import { dispatchChatAction } from "./sync";
import { COMPACTION_DIVIDER_TEXT, isCompactionDivider, dividerSummary } from "./chatContext";
import { useStore, type ChatMessage, type LiveTool, type TodoItem } from "./store";
import { loadSkills } from "./skills";
import { SettingsPane } from "./SettingsPane";
import { Button } from "./ui";
import { cn } from "./lib/utils";
import { BOX_UNREACHABLE, NO_BOX, STARTING, boxAnswer, boxChatOn, boxLinkFor, boxRetry, boxSubagent, fetchBoxFile } from "./boxChat";
import {
  AskOptions,
  ReplyCost,
  Subagents,
  Thought,
  VerdictLine,
  chosenAnswer,
  isLegacySubagentRecord,
  subagentsOfMessage,
  withoutOptionList,
  type SubagentRec,
} from "./chatExtras";
import { uiChoice } from "./uiChoices";
import { taskState } from "./backgroundTasks";
import { formatCost } from "./ongoingWork";
import { OngoingLine } from "./OngoingLine";
import { useChatGate } from "./chatGate";
import { ComposerSlot } from "./ComposerPanel";
import { scrollHold } from "./plugins/composer/draft";

const NO_SUBAGENTS: SubagentRec[] = [];

// Markdown (math, tables, code, safe HTML, URLs) renders through the shared
// pipeline (Markdown.tsx / mdPipeline.ts): data:image URLs and Windows
// absolute paths pass its URL check, so ChatImage can load them.

// Render images in chat bubbles the same way MarkdownView does for
// vault files: data:/blob:/http(s) URLs go straight to the DOM; file
// paths get read off disk and turned into blob URLs so the Tauri
// webview can actually display them (file:// is blocked). Relative
// paths are resolved against the active vault root, so an agent reply
// like `![chart](./assets/forecast.png)` or `![cap](.vault-chat/
// captures/foo.png)` renders. Without this override, react-markdown
// handed the raw src to the DOM and the image silently failed to load.
const ChatImage = memo(function ChatImage({
  src,
  alt,
  ...rest
}: ComponentPropsWithoutRef<"img">) {
  const vaultPath = useStore((s) => s.vaultPath);
  const files = useStore((s) => s.files);
  const convId = useStore((s) => s.activeConversationId);
  const mediaKey = JSON.stringify([src, vaultPath, convId]);
  const [media, setMedia] = useState<{ key: string; url: string } | null>(null);
  const url = media?.key === mediaKey ? media.url : null;
  const [failedPath, setFailedPath] = useState<string | null>(null);

  // Reuse the retained video-playback-1030 fix: a mount, not a file-index
  // snapshot, owns this URL. Still re-read bytes so replacements are visible.
  const loaded = useRef<{ path: string; bytes: Uint8Array; url: string } | null>(null);
  useEffect(() => {
    setMedia(null);
    setFailedPath(null);
    return () => {
      if (loaded.current) URL.revokeObjectURL(loaded.current.url);
      loaded.current = null;
    };
  }, [mediaKey]);

  useEffect(() => {
    if (!src) return;
    if (/^(https?:|data:|blob:)/i.test(src)) {
      setMedia({ key: mediaKey, url: src });
      return;
    }
    const cleaned = localPathFromUrl(src);
    const isAbs = /^([a-zA-Z]:[\/\\]|[\/\\])/.test(cleaned);
    if (!isAbs && !vaultPath) return;
    const sep = (vaultPath ?? "").includes("\\") ? "\\" : "/";
    const primary = isAbs
      ? cleaned
      : `${vaultPath}${sep}${cleaned.replace(/^\.\/+/, "")}`;

    let cancelled = false;
    const show = (path: string, bytes: ArrayLike<number>) => {
      const data = new Uint8Array(bytes);
      const prev = loaded.current;
      if (prev?.path === path && prev.bytes.length === data.length && prev.bytes.every((b, i) => b === data[i])) return;
      const dot = path.lastIndexOf(".");
      const ext = dot > 0 ? path.slice(dot + 1).toLowerCase() : "";
      const mime = videoMime(path) ??
        (ext === "svg"
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
                      : `image/${ext || "png"}`);
      const blob = new Blob([data], { type: mime });
      const url = URL.createObjectURL(blob);
      loaded.current = { path, bytes: data, url };
      setFailedPath(null);
      setMedia({ key: mediaKey, url });
      if (prev) URL.revokeObjectURL(prev.url);
    };
    (async () => {
      // A box fetch can fail for a moment (link not up yet, 10 s timeout, conversation not
      // indexed yet): retry a few times before showing "image not found" for good.
      let image = null;
      for (let attempt = 0; attempt < 4 && !image; attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, [0, 1000, 3000, 8000][attempt]));
        if (cancelled) return;
        image = await readChatImage(cleaned, vaultPath, files, {
          local: (path) => invoke<number[]>("read_binary_file", { path }),
          box: async () => {
            const link = await boxLinkFor(vaultPath);
            // No local or viewer-root fallback once this is a box conversation.
            // The existing backend log is the authority for convId's asset root.
            return link ? (path) => convId ? fetchBoxFile(link, path, convId) : Promise.resolve(null) : null;
          },
        });
      }
      if (cancelled) return;
      if (image) {
        show(image.path, image.bytes);
        return;
      }
      if (!cancelled) {
        console.warn("[chat] image load failed:", primary);
        if (loaded.current) URL.revokeObjectURL(loaded.current.url);
        loaded.current = null;
        setMedia(null);
        setFailedPath(primary);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [src, vaultPath, files, convId, mediaKey]);

  if (!url) {
    // Honest fallback: make it obvious this is a failed image load, not
    // intentional bracket text. The old `[alt]` rendering was visually
    // indistinguishable from a literal markdown footnote/reference and
    // gave no signal that anything went wrong.
    return (
      <span className="text-muted-foreground italic text-[11.5px] border border-dashed border-border/60 rounded px-1.5 py-0.5 inline-block">
        ⚠ image not found: {failedPath ?? src}
        {alt ? ` (${alt})` : ""}
      </span>
    );
  }
  // No autoplay: Carl's own Play starts video AND audio. The app's player, not the webview's controls.
  if (isVideoSrc(src)) return <VideoPlayer src={url ?? ""} title={alt} dataEl="chat-video" />;
  return <img src={url} alt={alt} {...rest} />;
});

const VIDEO_EXT: Record<string, string> = { webm: "video/webm", mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime" };
function videoMime(src: string | undefined): string | null {
  const m = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(src ?? "");
  return m ? (VIDEO_EXT[m[1]!.toLowerCase()] ?? null) : null;
}
const isVideoSrc = (src: string | undefined) => !!videoMime(src);

/** A vault .html in image syntax renders live in the bubble (InlineHtmlFrame); everything else is ChatImage. */
function ChatMedia(props: ComponentPropsWithoutRef<"img">) {
  const { src } = props;
  if (typeof src === "string" && isHtmlSrc(src) && !/^(https?|data|blob):/i.test(src))
    return <InlineHtmlFrame src={src} alt={props.alt} sizeHint={props.title} />;
  return <ChatImage {...props} />;
}

/** A paragraph holding a public web page on a line of its own (`![label](https://…)`, src/inlineWeb.ts): the page shows
 *  live there (InlineWebPage); the rest of the paragraph stays text around it. */
function ChatParagraph({ node, children, ...rest }: ComponentPropsWithoutRef<"p"> & { node?: unknown }) {
  const solo = soloWebImages(node as Parameters<typeof soloWebImages>[0]);
  const kids = Array.isArray(children) ? children : [children];
  const hast = ((node as { children?: unknown[] } | undefined)?.children ?? []) as { properties?: Record<string, unknown> }[];
  if (!solo.length || kids.length !== hast.length) return <p {...rest}>{children}</p>;
  const out: React.ReactNode[] = [];
  let run: React.ReactNode[] = [];
  const flush = () => {
    if (run.some((k) => !(typeof k === "string" && !k.trim()))) out.push(<p key={`p${out.length}`} {...rest}>{run}</p>);
    run = [];
  };
  kids.forEach((k, i) => {
    if (!solo.includes(i)) { run.push(k); return; }
    flush();
    const pr = hast[i]?.properties ?? {};
    out.push(<InlineWebPage key={`w${i}`} src={String(pr.src)} alt={typeof pr.alt === "string" ? pr.alt : undefined} sizeHint={typeof pr.title === "string" ? pr.title : undefined} />);
  });
  flush();
  return <>{out}</>;
}

const chatComponents = { img: ChatMedia, p: ChatParagraph } as const;
/** Settings, at its Box section. */
/** How many messages a chat draws at first, and how many more each scroll to the top adds. */
const CHAT_WINDOW = 60;

function openBoxSettings() {
  useStore.getState().setShowSettings(true);
  // The pane renders on React's next commit: look for the section for a few frames.
  let tries = 0;
  const go = () => {
    const el = document.querySelector('[data-settings="box"]');
    if (el) el.scrollIntoView({ block: "start" });
    else if (++tries < 20) requestAnimationFrame(go);
  };
  requestAnimationFrame(go);
}

export function ChatPane() {
  // Per-field selectors so the pane only re-renders when the field it
  // actually reads changes. Destructuring the whole store was causing
  // every keystroke to rebuild the entire message list because the
  // agent's streamingText/liveTools updates were waking this component
  // 60+ times per second.
  const vaultPath = useStore((s) => s.vaultPath);
  const messages = useStore((s) => s.messages);
  const busy = useStore((s) => s.busy);
  const showSettings = useStore((s) => s.showSettings);
  const setSkills = useStore((s) => s.setSkills);
  const streamingText = useStore((s) => s.streamingText);
  const streamingReasoning = useStore((s) => s.streamingReasoning);
  const liveTools = useStore((s) => s.liveTools);
  // Hooks must live above the early `showSettings` returns below — React's
  // Rules of Hooks require the same hook-call order on every render.
  const conversations = useStore((s) => s.conversations);
  const openableThreadIds = useStore(useShallow((s) => s.conversations.map((c) => c.id)));
  const activeConversationId = useStore((s) => s.activeConversationId);
  const activeConv = conversations.find((c) => c.id === activeConversationId);
  // What the thread shows beside the text (chatExtras.tsx; uiChoices.ts picks
  // where each goes while Carl decides). Stable props, so the bubbles' memo
  // holds while a reply streams.
  // Background tasks (backgroundTasks.ts), as Claude Code shows them: while any runs, one compact chip above the
  // composer; it opens only on a click. A finished task leaves the screen (Carl: "when the tasks are done, I don't
  // think I care to see them"): the agent's reply carries the result; a failed one is one quiet line in the thread.
  const subagents = activeConv?.subagents ?? NO_SUBAGENTS;
  const parentConv = conversations.find((c) => c.subagents?.some((s) => s.kind !== "job" && s.threadId === activeConversationId));
  const openSubagent = useCallback((id: string) => useStore.getState().selectConversation(id), []);
  // Worker progress must not invalidate historical bubbles with no worker links.
  // Keep live worker rows current; share the existing empty-list sentinel elsewhere.
  const messageSubagents = useMemo(() => messages.map((m) => {
    const spawns = subagentsOfMessage(m, subagents);
    return spawns.length ? spawns : NO_SUBAGENTS;
  }), [messages, subagents]);
  const runningTasks = useMemo(() => subagents.filter((s) => taskState(s) === "running"), [subagents]);
  const answerAsk = useCallback((answer: string) => {
    const id = useStore.getState().activeConversationId;
    if (boxChatOn() && id) void boxAnswer(id, answer);
    else dispatchChatAction({ kind: "send", text: answer });
  }, []);
  const retryTurn = useCallback(() => {
    void boxRetry(useStore.getState().activeConversationId);
  }, []);
  const controlSubagent = useCallback((sid: string, op: "steer" | "stop", text?: string) => {
    const id = useStore.getState().activeConversationId;
    return id ? boxSubagent(id, sid, op, text) : Promise.resolve<string | null>("No conversation.");
  }, []);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Track whether the user is pinned near the bottom. If they scroll up
  // mid-stream, stop auto-scrolling so they can read older messages in
  // peace. Re-pins automatically when they scroll back to the bottom.
  const pinnedToBottomRef = useRef(true);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  // Only the newest messages are drawn; older ones join as you scroll up, as in
  // Claude Code. Drawing a whole long thread (1,500 bubbles) made every keystroke
  // and every remount (Ctrl+Shift+F, opening a file) take seconds.
  const [chatWindow, setChatWindow] = useState({ conv: activeConversationId, count: CHAT_WINDOW });
  const shownCount = chatWindow.conv === activeConversationId ? chatWindow.count : CHAT_WINDOW;
  const windowStartRef = useRef(0);
  const heightBeforeOlderRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    // Older messages went in above: keep what was on screen where it was.
    const el = scrollRef.current;
    const before = heightBeforeOlderRef.current;
    if (!el || before == null) return;
    heightBeforeOlderRef.current = null;
    el.scrollTop += el.scrollHeight - before;
  });

  // Every turn runs on the box: no box, nothing to chat with; the box out of
  // reach, the composer is off (with the reason) and the feed retries
  // (src/chatGate.ts: the composer reads the same).
  const { starting, noBox, boxDown, downWhy } = useChatGate();

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (pinnedToBottomRef.current) {
      // streamingText flushes ~5 Hz. Smooth-scrolling on top of every
      // flush stacks animations and fights the layout grow, which reads
      // as stutter. Snap instantly during stream — the eye sees a
      // smooth flow because tokens land in quick succession.
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, streamingText, liveTools]);

  // The thread's box shrinks when something appears above the composer (the
  // pinned plan, the subagent strip): stay at the bottom if we were there.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (pinnedToBottomRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // When the user sends a new message, re-pin so their own turn scrolls
  // into view even if they had scrolled away during the previous stream.
  useEffect(() => {
    pinnedToBottomRef.current = true;
    setShowJumpToLatest(false);
  }, [messages.length]);

  // Pasting an image adds a thumbnail row above the composer, which resizes the thread box
  // (twice: once when the row appears, once when the picture decodes). The thread must stay
  // exactly where it was, at the bottom or wherever he had scrolled to, and never jump to the top.
  // The composer (a plugin, its own React root) holds and restores it through scrollHold.
  const heldScrollRef = useRef<{ top: number; pinned: boolean; until: number } | null>(null);
  const holdScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    heldScrollRef.current = { top: el.scrollTop, pinned: pinnedToBottomRef.current, until: Date.now() + 1500 };
  };
  const restoreHeldScroll = () => {
    const el = scrollRef.current;
    const h = heldScrollRef.current;
    if (!el || !h) return false;
    if (Date.now() > h.until) {
      heldScrollRef.current = null;
      return false;
    }
    pinnedToBottomRef.current = h.pinned;
    el.scrollTop = h.pinned ? el.scrollHeight : h.top;
    return true;
  };
  scrollHold.hold = holdScroll;
  scrollHold.restore = restoreHeldScroll;

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    if (restoreHeldScroll()) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distanceFromBottom < 40;
    pinnedToBottomRef.current = atBottom;
    setShowJumpToLatest(!atBottom && (busy || streamingText.length > 0));
    if (el.scrollTop < 400 && windowStartRef.current > 0 && heightBeforeOlderRef.current == null) {
      heightBeforeOlderRef.current = el.scrollHeight;
      setChatWindow({ conv: activeConversationId, count: shownCount + CHAT_WINDOW });
    }
  };

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedToBottomRef.current = true;
    setShowJumpToLatest(false);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  useEffect(() => {
    if (vaultPath) {
      loadSkills(vaultPath).then(setSkills).catch(() => setSkills([]));
    } else {
      setSkills([]);
    }
  }, [vaultPath, setSkills]);

  const todos = useMemo(() => currentPlan(messages), [messages]);
  const plans = useMemo(() => planCards(messages), [messages]);
  if (showSettings) return <SettingsPane />;

  if (starting) {
    return (
      <div className="h-full flex flex-col bg-card border-l border-border" data-el="box-starting">
        <div className="flex-1 flex items-center justify-center px-8">
          <div className="max-w-[260px] text-center space-y-3">
            <p className="text-[13px] text-foreground/90">{STARTING}…</p>
            <p className="text-[11.5px] text-muted-foreground leading-relaxed">No box needed: this app runs it. The first start takes a moment.</p>
          </div>
        </div>
      </div>
    );
  }

  if (noBox) {
    return (
      <div className="h-full flex flex-col bg-card border-l border-border" data-el="no-box">
        <div className="flex-1 flex items-center justify-center px-8">
          <div className="max-w-[260px] text-center space-y-3">
            <p className="text-[13px] text-foreground/90">{NO_BOX}</p>
            <p className="text-[11.5px] text-muted-foreground leading-relaxed">The agent runs on your box. Files, notes and history work here without it.</p>
            <Button variant="secondary" size="sm" onClick={openBoxSettings} className="w-full">
              Settings → Box
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const planInline = uiChoice("todos") === "inline";
  const verdict = activeConv?.state === "done" ? activeConv.verdict : undefined;
  const totalCost = uiChoice("cost") === "total" ? formatCost(activeConv?.costUsd ?? messages.reduce((n, m) => n + (m.costUsd ?? m.usage?.costUsd ?? 0), 0)) : undefined;
  let lastVisible = -1;
  for (let i = messages.length - 1; i >= 0; i--) if (!messages[i]!.hidden && !messages[i]!.system) { lastVisible = i; break; }
  let windowStart = 0;
  for (let i = messages.length - 1, n = 0; i >= 0; i--) {
    if (messages[i]!.hidden || messages[i]!.waiting) continue;
    if (++n > shownCount) { windowStart = i + 1; break; }
  }
  windowStartRef.current = windowStart;

  return (
    <div className="h-full flex flex-col bg-card border-l border-border relative">
      {/* Projects are set in the chats panel (a row's folder action), not here. */}
      {totalCost && (
        <div className="shrink-0 px-3 pt-2">
          <div className="max-w-[820px] mx-auto flex items-center">
            {totalCost && (
              <span className="ml-auto text-[11px] text-muted-foreground tabular-nums" data-el="total-cost" title="What this conversation has cost so far">
                {totalCost}
              </span>
            )}
          </div>
        </div>
      )}
      <div
        className="flex-1 min-h-0 overflow-auto px-3 py-4 pb-8 relative"
        ref={scrollRef}
        onScroll={onScroll}
        onWheel={() => { heldScrollRef.current = null; }}
        onTouchStart={() => { heldScrollRef.current = null; }}
      >
        <div className="max-w-[820px] mx-auto space-y-4">
        {messages.length === 0 && !streamingText && boxDown && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none" data-el="box-down-empty">
            <div className="text-center space-y-1">
              <p className="text-[15px] font-medium text-foreground/90">{BOX_UNREACHABLE}</p>
              <p className="text-[12px] text-muted-foreground">{downWhy}. Retrying — files and notes work meanwhile.</p>
            </div>
          </div>
        )}

        {parentConv && <button type="button" data-el="worker-parent" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => openSubagent(parentConv.id)}>Back to {parentConv.title || "parent chat"}</button>}

        <HistoryList
          messages={messages}
          windowStart={windowStart}
          lastVisible={lastVisible}
          busy={busy}
          messageSubagents={messageSubagents}
          openableThreadIds={openableThreadIds}
          onAsk={answerAsk}
          onOpenSubagent={openSubagent}
          onSubagent={controlSubagent}
          onRetry={retryTurn}
          plans={planInline ? plans : null}
        />




        {verdict && uiChoice("verdict") === "thread" && <VerdictLine verdict={verdict} />}

        {/* Running, nothing streamed yet: the model is thinking without showing
            it. Gone at the first text, thinking or tool line. */}

        {(streamingText || streamingReasoning || liveTools.length > 0) && (
          <div className="space-y-2">
            {liveTools.length > 0 && <LiveToolTicker tools={liveTools} />}
            {streamingReasoning && !streamingText && (
              <ReasoningStream text={streamingReasoning} />
            )}
            {streamingText && (
              <div className="prose-chat text-foreground/95" data-el="stream">
                {/* Finished blocks render once each with the full
                    pipeline; only the open tail re-renders per flush
                    (re-rendering the whole growing reply every flush
                    was O(N²) and locked the main thread). */}
                <StreamingMarkdown text={streamingText} components={chatComponents} />
              </div>
            )}
          </div>
        )}

        {busy && (
          <ThinkingIndicator
            silent={!streamingText && !streamingReasoning && liveTools.length === 0}
            activeTool={liveTools.find((t) => !t.result)?.name}
            streaming={!!streamingText}
            reasoning={!!streamingReasoning && !streamingText}
            liveChars={
              streamingText.length +
              streamingReasoning.length +
              liveTools.reduce(
                (n, t) =>
                  n +
                  // Prefer the live char count from streaming tool-input
                  // deltas; fall back to the finalized input size once
                  // the tool-call resolves (and inputChars is 0/undefined).
                  (t.inputChars && t.inputChars > 0
                    ? t.inputChars
                    : t.input
                      ? JSON.stringify(t.input).length
                      : 0) +
                  (t.result ? t.result.length : 0),
                0,
              )
            }
          />
        )}

        </div>
      </div>

      <div className="relative">
        <div className="pointer-events-none absolute -top-12 left-0 right-0 h-12 bg-gradient-to-t from-card to-transparent" />
        {showJumpToLatest && (
          <button
            onClick={jumpToLatest}
            className="absolute -top-10 left-1/2 -translate-x-1/2 h-7 px-3 flex items-center gap-1.5 rounded-full border border-border bg-card shadow-md text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent/60 z-10"
            title="Jump to latest"
          >
            <ChevronDown className="h-3 w-3" />
            new messages
          </button>
        )}

        <div className="group/composer p-3 max-w-[820px] mx-auto w-full">
          {runningTasks.length > 0 && <Subagents list={runningTasks} variant="strip" onControl={controlSubagent} />}
          {todos.length > 0 && uiChoice("todos") === "pinned" && (busy || todos.some((t) => t.status !== "completed")) && (
            <div className="mb-1.5 max-h-40 overflow-auto" data-el="todos-pinned">
              <AgentTodoList todos={todos} />
            </div>
          )}
          {activeConv && (
            <OngoingLine
              conversation={{ ...activeConv, messages, ...(uiChoice("cost") !== "reply" ? { costUsd: undefined } : {}) }}
              size="chat"
              className="px-1 pb-1.5"
              verdict={uiChoice("verdict") === "ongoing"}
            />
          )}
          <ComposerSlot />
        </div>
      </div>
    </div>
  );
}


/** The thread's messages. Its own memoized component so a keystroke in the composer
 * (ChatPane state) never re-walks the history: only a new message, the window or the
 * run state redraws it. */
const HistoryList = memo(function HistoryList({
  messages, windowStart, lastVisible, busy, messageSubagents, openableThreadIds, onAsk, onOpenSubagent, onSubagent, onRetry, plans,
}: {
  messages: ChatMessage[];
  windowStart: number;
  lastVisible: number;
  busy: boolean;
  messageSubagents: SubagentRec[][];
  openableThreadIds: string[];
  onAsk: (answer: string) => void;
  onOpenSubagent: (id: string) => void;
  onSubagent: (sid: string, op: "steer" | "stop", text?: string) => Promise<string | null>;
  onRetry: () => void;
  plans: PlanCard[] | null;
}) {
  return (
    <>
      {messages.map((m, i) =>
        i < windowStart || m.hidden ? null : (
          <Fragment key={m.mid ?? i}>
            <MessageBubble
              message={m}
              askLive={!!m.askOptions?.length && i === lastVisible && !busy}
              askChosen={m.askOptions?.length ? chosenAnswer(messages, i) : undefined}
              onAsk={onAsk}
              spawns={messageSubagents[i]}
              onOpenSubagent={onOpenSubagent}
              openableThreadIds={openableThreadIds}
              onSubagent={onSubagent}
              onRetry={onRetry}
              voiceCont={!!m.voice && i > 0 && !!messages[i - 1]?.voice && !messages[i - 1]?.hidden}
            />
            {/* Native writes own their snapshot; never lift old work into the live window. */}
            {plans?.filter((p) => p.index === i).map((p) => <AgentTodoList key={p.id} todos={p.todos} />)}
          </Fragment>
        ),
      )}
    </>
  );
});


function toolSummary(input: any): string {
  if (!input || typeof input !== "object") return "";
  const primary =
    input.path ??
    input.file_path ??
    input.command ??
    input.pattern ??
    input.url ??
    input.query ??
    input.from ??
    null;
  if (primary != null && typeof primary !== "object") {
    const extra =
      input.to != null ? ` → ${input.to}` :
      input.old_string != null ? ` (edit)` :
      input.glob_filter != null ? ` [${input.glob_filter}]` :
      "";
    return `${primary}${extra}`;
  }
  const first = Object.values(input)[0];
  return typeof first === "object" || first == null ? "" : String(first);
}

// Strip the trailing "[attached: ...]" footer that ChatPane appends to
// user turns so the agent sees resolved @-ref paths. The footer is
// meant for the model, not the user's own bubble.
function stripAttachedFooter(src: string): string {
  return src.replace(/\n*\[attached:[^\]]*\]\s*$/, "");
}


/**
 * A message sent while the agent works, not yet read by it: on hover, "Send now" (cut the agent's
 * current step; it answers this next), Edit (back into the composer) and Cancel.
 */
function WaitingActions({ message }: { message: ChatMessage }) {
  const convId = useStore((s) => s.activeConversationId);
  if (!convId || !message.mid) return null;
  const id = message.mid;
  const btn = "h-5 px-1.5 rounded text-[10.5px] text-muted-foreground hover:text-foreground hover:bg-accent/60";
  return (
    <div className="flex items-center gap-0.5 opacity-0 group-hover/msg:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity" data-el="waiting-actions">
      <button className={btn} onClick={() => dispatchChatAction({ kind: "sendNow", convId, id })} title="Interrupt the agent's current step and send this now" data-el="send-now">
        Send now
      </button>
      <button
        className={btn}
        onClick={() => {
          dispatchChatAction({ kind: "unqueue", convId, id });
          window.dispatchEvent(new CustomEvent("vc-composer-insert", { detail: splitFilesLine(stripAttachedFooter(message.content)).text }));
        }}
        title="Take it back into the composer"
        data-el="waiting-edit"
      >
        Edit
      </button>
      <button className={btn} onClick={() => dispatchChatAction({ kind: "unqueue", convId, id })} title="Take it back (not sent)" data-el="waiting-cancel">
        Cancel
      </button>
    </div>
  );
}

export const MessageBubble = memo(function MessageBubble({
  message,
  askLive = false,
  askChosen = "",
  onAsk,
  spawns,
  onOpenSubagent,
  openableThreadIds,
  onSubagent,
  onRetry,
  voiceCont = false,
}: {
  message: ChatMessage;
  /** Try again on a turn that ended on a failed request (its line's `retry`). */
  onRetry?: () => void;
  /** A voice line right after another: the same voice turn (no marker of its own). */
  voiceCont?: boolean;
  /** AskUser options on this reply: still the open fork, and the answer given. */
  askLive?: boolean;
  askChosen?: string;
  onAsk?: (answer: string) => void;
  /** The subagents this reply's `subagent` call spawned (inline option). */
  spawns?: SubagentRec[];
  onOpenSubagent?: (id: string) => void;
  openableThreadIds?: readonly string[];
  onSubagent?: (sid: string, op: "steer" | "stop", text?: string) => Promise<string | null>;
}) {
  const calls = (message.toolCalls ?? []).filter((t) => !isLegacySubagentRecord(t));
  if (isCompactionDivider(message)) {
    return <CompactionDivider message={message} />;
  }
  // A job's or a background task's end is a system line of its own kind (before the generic notice).
  // A finished one says nothing here (the agent's reply carries the result); a failed or stopped one is one quiet line.
  if (message.job) return message.job.failed || message.job.status === "stopped" ? <JobRow job={message.job} /> : null;
  if (message.system && message.working) {
    // Work under way that is not a reply (the box summarizing the earlier conversation): the working spinner and its time.
    return (
      <div className="flex items-center gap-1.5 text-[11px] leading-snug text-muted-foreground min-w-0" data-el="notice" data-working="1">
        <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
        <span className="break-words min-w-0">{message.content}</span>
        {message.working.since ? <Elapsed since={message.working.since} /> : null}
      </div>
    );
  }
  if (message.system) {
    // A quiet notice (voice ended, an error): left, in the tool rows' small muted type.
    return (
      <div className={cn("flex items-start gap-1.5 text-[11px] leading-snug", message.failed ? "text-destructive/90" : "text-muted-foreground")} data-el="notice">
        {message.failed ? <AlertCircle className="h-3 w-3 mt-px shrink-0" /> : <Info className="h-3 w-3 mt-px shrink-0" />}
        <span className="break-words min-w-0">{message.content}</span>
        {message.retry && onRetry && (
          <button type="button" data-el="retry" onClick={onRetry} className="shrink-0 ml-1 underline underline-offset-2 hover:text-foreground">
            Try again
          </button>
        )}
      </div>
    );
  }
  if (message.voiceAsk) return <VoiceAskRow ask={message.voiceAsk} />;
  if (message.voice) return <VoiceLine message={message} cont={voiceCont} />;
  const isUser = message.role === "user";
  const userText = isUser ? splitFilesLine(stripAttachedFooter(message.display ?? message.content)) : null;
  return (
    <div className={cn("flex flex-col gap-1.5", isUser && "items-end group/msg")} data-message-id={message.mid} {...(message.waiting ? { "data-el": "waiting-message" } : {})}>
      {isUser ? (
        <>
        <div className={cn("max-w-[85%] rounded-2xl rounded-br-md bg-primary/90 text-primary-foreground px-3.5 py-2 text-[13px] leading-relaxed break-words overflow-hidden prose-user", message.waiting && "opacity-60")}>
          {/* Persisted feed entries may carry only a capture path, not inline pixels.
              Use the same scoped local/box loader as markdown images. */}
          {message.attachments && message.attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-1.5">
              {message.attachments.map((a, i) => {
                const name = a.sourcePath?.split("/").pop();
                return (
                  <div key={i} className="flex flex-col items-start gap-0.5">
                    <ChatImage
                      src={a.imageDataUrl || a.capturedFilePath}
                      alt={`captured ${i + 1}`}
                      className="max-h-[160px] rounded"
                    />
                    {name && (
                      <span className="text-[9.5px] opacity-80 font-mono">
                        {name}
                        {a.sourceAnchor ? ` · ${a.sourceAnchor}` : ""}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {userText!.files.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-1.5" data-el="message-files">
              {userText!.files.map((f, i) => (
                <span key={i} className="inline-flex items-center gap-1 rounded-md bg-primary-foreground/15 px-1.5 py-0.5 text-[11px]">
                  <FileText className="h-3 w-3 shrink-0 opacity-80" />
                  <span className="max-w-[240px] truncate">{f}</span>
                </span>
              ))}
            </div>
          )}
          {userText!.text.trim() && <Markdown source={userText!.text} profile="user" components={chatComponents} />}
        </div>
        {message.waiting && (
          <div className="flex items-center gap-1.5 -mt-0.5">
            <WaitingActions message={message} />
            <span className="text-[10.5px] text-muted-foreground" data-el="waiting-mark" title="Sent — the agent reads it at its next step">
              queued
            </span>
          </div>
        )}
        </>
      ) : (
        <div className="w-full space-y-2">
          {message.thinking && <Thought text={message.thinking} />}
          {message.attachments && message.attachments.length > 0 && (
            <div className="flex flex-wrap gap-2" data-el="shown-images">
              {message.attachments.map((a, i) => (
                <ChatImage key={i} src={a.imageDataUrl || a.capturedFilePath} alt={a.sourcePath?.split("/").pop() ?? `image ${i + 1}`} className="max-h-[260px] max-w-full rounded-lg border border-border/60" />
              ))}
            </div>
          )}
          <div className="prose-chat text-foreground/95">
            <Markdown
              source={message.askOptions?.length ? withoutOptionList(message.content, message.askOptions) : (message.display ?? message.content)}
              profile="chat"
              components={chatComponents}
            />
          </div>
          {onAsk && message.askOptions && message.askOptions.length > 0 && <AskOptions options={message.askOptions} live={askLive} chosen={askChosen} onPick={onAsk} />}
          {calls.length > 0 && (
            <details className="group" data-el="tool-calls">
              <summary className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer hover:text-foreground list-none select-none">
                <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-0 -rotate-90" />
                <Wrench className="h-3 w-3" />
                <span>{calls.length} tool call{calls.length === 1 ? "" : "s"}</span>
              </summary>
              <div className="mt-2 space-y-2 pl-4 border-l border-border">
                {calls.map((t, j) => (
                  <div key={j} className="space-y-1">
                    <div className="text-[11px] font-mono text-primary">{t.name}</div>
                    <pre className="text-[10.5px] font-mono bg-muted/60 border border-border/40 rounded p-2 max-h-[140px] overflow-auto whitespace-pre-wrap break-all">
                      {JSON.stringify(t.input, null, 2)}
                    </pre>
                    {t.result && (
                      <pre className="text-[10.5px] font-mono bg-muted/30 border border-border/40 rounded p-2 max-h-[200px] overflow-auto whitespace-pre-wrap break-all text-muted-foreground">
                        {t.result.length > 1200 ? `${t.result.slice(0, 1200)}…` : t.result}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            </details>
          )}
          {spawns && spawns.length > 0 && <Subagents list={spawns} variant="inline" onControl={onSubagent} onOpen={onOpenSubagent} openableThreadIds={openableThreadIds} />}
          <ReplyCost m={message} />
        </div>
      )}
    </div>
  );
});

// A line said on a voice call looks like the thread around it (Carl, 2026-10-21: the separate "YOU" voice style
// looked broken next to the bubbles): his spoken words are his bubble, the voice's replies are agent text, each
// with a tiny mic so a spoken line is still told apart from a typed one. The mic sits in a box exactly one text
// line tall (13px type, leading-relaxed = 1.625em), centred on the first line; the text keeps at least that
// height, so an empty or "…" line, or one still streaming, never shifts it.
function VoiceLine({ message, cont }: { message: ChatMessage; cont: boolean }) {
  const isUser = message.role === "user";
  const mic = (
    <span className="flex h-[1.625em] w-2.5 shrink-0 items-center" data-el="voice-mic">
      <Mic className={cn("block h-2.5 w-2.5", isUser ? "opacity-70" : "text-muted-foreground/70")} aria-label="said aloud" />
    </span>
  );
  if (isUser)
    return (
      <div className={cn("flex flex-col items-end", cont && "-mt-1")} data-el="voice-line" data-role="user">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary/90 text-primary-foreground px-3.5 py-2 text-[13px] leading-relaxed break-words overflow-hidden prose-user flex items-start gap-1.5">
          {mic}
          <div className="min-w-0 min-h-[1.625em]">
            <Markdown source={message.display ?? message.content} profile="user" components={chatComponents} />
          </div>
        </div>
      </div>
    );
  return (
    <div className={cn("w-full flex items-start gap-1.5 text-[13px] leading-relaxed", cont && "-mt-1")} data-el="voice-line" data-role={message.role}>
      {mic}
      <div className="min-w-0 flex-1 min-h-[1.625em]">
        <Markdown source={message.display ?? message.content} profile="chat" components={chatComponents} />
      </div>
    </div>
  );
}

// The agent's work on something Carl said on a call (server/voice.ts Ask), shown as its own — one agent (Carl,
// 2026-10-22: "we are all one agent"): working (a spinner, the time it has run), then the tools it ran and what
// came back, collapsed like a tool row; the spoken reply is the line after it. Never a "voice asked" row.
function VoiceAskRow({ ask }: { ask: NonNullable<ChatMessage["voiceAsk"]> }) {
  const line = ask.result.replace(/\s+/g, " ").trim();
  // Handed over and still working: said at once (Carl, 2026-10-22: no feedback until the result read as nothing
  // happening) — a spinner, what was asked, and how long it has run; the result replaces it in place.
  if (ask.running) {
    return (
      <div data-el="voice-ask" data-running="1" className="flex items-center gap-1.5 text-[11px] text-muted-foreground min-w-0">
        <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
        <span className="shrink-0">Working</span>
        <span className="truncate opacity-80">· {ask.request}</span>
        {ask.startedAt ? <Elapsed since={ask.startedAt} /> : null}
      </div>
    );
  }
  return (
    <details className="group" data-el="voice-ask">
      <summary className={cn("flex items-center gap-1.5 text-[11px] cursor-pointer hover:text-foreground list-none select-none min-w-0", ask.failed ? "text-destructive/90" : "text-muted-foreground")}>
        <ChevronDown className="h-3 w-3 shrink-0 transition-transform group-open:rotate-0 -rotate-90" />
        <Wrench className="h-3 w-3 shrink-0" />
        <span className="shrink-0">{ask.failed ? "Couldn't finish" : `Worked${ask.ms ? ` ${workedFor(ask.ms)}` : ""}`}</span>
        <span className="truncate opacity-80">· {ask.failed ? line : ask.tools?.length ? ask.tools.join(", ") : ask.request}</span>
      </summary>
      <div className="mt-2 space-y-1.5 pl-4 border-l border-border text-[11.5px]">
        <div className="text-muted-foreground">
          <span className="font-medium">You said:</span> {ask.request}
        </div>
        <div className="prose-chat text-foreground/90">
          <Markdown source={ask.result || "(nothing came back)"} profile="chat" components={chatComponents} />
        </div>
      </div>
    </details>
  );
}

// A background job that ended: one quiet row like a tool row ("Job finished · board safety copies"), red when
// it failed; its last output lines when opened. (The agent gets the whole wake: exit code and output.)
function JobRow({ job }: { job: NonNullable<ChatMessage["job"]> }) {
  // A background task's end: the row only (the agent's next message tells the result).
  if (job.task)
    return (
      <div data-el="task-end" data-failed={job.failed ? "1" : "0"} className={cn("flex items-center gap-1.5 text-[11px] min-w-0", job.failed ? "text-destructive/90" : "text-muted-foreground")}>
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", job.failed ? "bg-destructive/80" : job.status === "finished" ? "bg-emerald-600" : "bg-muted-foreground/50")} />
        <span className="shrink-0">Background task {job.status}</span>
        <span className="truncate opacity-80">· {job.name}</span>
      </div>
    );
  return (
    <details className="group" data-el="job-end">
      <summary className={cn("flex items-center gap-1.5 text-[11px] cursor-pointer hover:text-foreground list-none select-none min-w-0", job.failed ? "text-destructive/90" : "text-muted-foreground")} title={job.id}>
        <ChevronDown className="h-3 w-3 shrink-0 transition-transform group-open:rotate-0 -rotate-90" />
        <Wrench className="h-3 w-3 shrink-0" />
        <span className="shrink-0">Job {job.status}</span>
        <span className="truncate opacity-80">· {job.name}</span>
      </summary>
      <pre className="mt-2 pl-4 border-l border-border text-[11px] text-muted-foreground whitespace-pre-wrap break-all font-mono">{job.output || "(no output)"}</pre>
    </details>
  );
}

/** "for 34 s", "for 2 min". */
const workedFor = (ms: number) => (ms < 90_000 ? `for ${Math.max(1, Math.round(ms / 1000))} s` : `for ${Math.round(ms / 60_000)} min`);

/** "0:12": how long something has run, ticking each second. */
function Elapsed({ since }: { since: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
  return <span className="shrink-0 tabular-nums opacity-70">{`${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`}</span>;
}

// Where the earlier conversation was summarized: the quiet system-line divider,
// whose summary expands like a tool-call list.
function CompactionDivider({ message }: { message: ChatMessage }) {
  // A compaction and the box's roll-over read the same: earlier, summarized here.
  return (
    <details className="group py-2" data-el="divider">
      <summary className="flex items-center justify-center gap-2 text-[11px] text-muted-foreground cursor-pointer hover:text-foreground list-none select-none">
        <div className="h-px w-8 bg-border" />
        <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-0 -rotate-90" />
        <span className="italic">{COMPACTION_DIVIDER_TEXT}</span>
        <div className="h-px w-8 bg-border" />
      </summary>
      <div className="mt-2 pl-4 border-l border-border prose-chat text-[12px] text-muted-foreground">
        <Markdown source={dividerSummary(message)} profile="chat" components={chatComponents} />
      </div>
    </details>
  );
}

// Compact visual of the agent's current plan. Shows one row per todo,
// uses different glyphs/styles for pending / in_progress / completed.
// The agent maintains this list via the TodoWrite tool.
function AgentTodoList({ todos }: { todos: TodoItem[] }) {
  const done = todos.filter((t) => t.status === "completed").length;
  const [open, setOpen] = useState(false);
  // Every step done: one quiet line (click for the steps).
  if (planDone(todos) && !open) {
    return (
      <button
        onClick={() => setOpen(true)}
        data-el="todos-done"
        className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground"
        title="Show the plan's steps"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-600/70" />
        Plan · {done}/{todos.length} done
      </button>
    );
  }
  return (
    <div className="rounded-md border border-border/60 bg-muted/30 p-2.5 space-y-1" data-el="todos">
      <div className="flex items-center justify-between text-[10.5px] text-muted-foreground">
        <span>Plan</span>
        <span className="font-mono">
          {done}/{todos.length}
        </span>
      </div>
      <ul className="space-y-0.5">
        {todos.map((t, i) => {
          const label =
            t.status === "in_progress" && t.activeForm ? t.activeForm : t.content;
          return (
            <li
              key={i}
              className="flex items-start gap-2 text-[12px] leading-relaxed"
            >
              <span
                className={cn(
                  "mt-[5px] h-2 w-2 shrink-0 rounded-full",
                  t.status === "completed" && "bg-emerald-600",
                  t.status === "in_progress" && "bg-primary animate-pulse",
                  t.status === "pending" && "bg-muted-foreground/40",
                )}
              />
              <span
                className={cn(
                  "min-w-0 flex-1",
                  t.status === "completed" && "line-through text-muted-foreground",
                  t.status === "in_progress" && "text-foreground",
                  t.status === "pending" && "text-muted-foreground",
                )}
              >
                {label}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// Single-line ticker for live tool calls. Instead of stacking every
// tool invocation, it shows only the most recent one, cross-fading
// between entries as they arrive. A small count in the corner makes it
// clear more than one tool has run in this turn.
function LiveToolTicker({ tools }: { tools: LiveTool[] }) {
  // Prefer showing a still-running tool over the most-recently-added one.
  // Otherwise a fast-completing tool added late (e.g. a Read) hides a
  // slow tool that started first (e.g. a Bash subprocess).
  const latest =
    tools.find((t) => !t.result) ?? tools[tools.length - 1];
  if (!latest) return null;
  const running = !latest.result;
  // A subagent call waiting on its children: the background-tasks chip shows them moving, not a bare timer.
  if (running && latest.name === "subagent") return null;
  return (
    <div className="space-y-1">
    <div data-el="live-tool" className="flex items-center gap-2 text-[11px] font-mono text-muted-foreground overflow-hidden">
      <Wrench className={cn("h-3 w-3 shrink-0", running && "animate-pulse")} />
      <span
        key={latest.id}
        className="live-tool-flip flex min-w-0 flex-1 items-center gap-2"
      >
        <span className="text-foreground/80 shrink-0">{latest.name}</span>
        <span className="opacity-70 truncate" title={toolSummary(latest.input)}>
          {toolSummary(latest.input)}
        </span>
      </span>
      {running && latest.startedAt && <ToolElapsed startedAt={latest.startedAt} />}
      {running && latest.etaSeconds && latest.etaSeconds >= 15 && (
        <span className="shrink-0 tabular-nums opacity-50" title="Estimated by Haiku">
          ~{formatEta(latest.etaSeconds)} expected
        </span>
      )}
      {running ? (
        <span className="opacity-40 shrink-0">…</span>
      ) : (
        <span className="text-emerald-500 shrink-0">✓</span>
      )}
    </div>
    {running && latest.partial && (
      <pre data-el="live-tool-output" className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded border border-border/40 bg-muted/30 p-2 text-[10.5px] font-mono text-muted-foreground">
        {latest.partial}
      </pre>
    )}
    </div>
  );
}

function ToolElapsed({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  const s = Math.floor((now - startedAt) / 1000);
  if (s < 1) return null;
  return <span className="shrink-0 tabular-nums opacity-50">{s}s</span>;
}

function ReasoningStream({ text }: { text: string }) {
  const [open, setOpen] = useState(true);
  const tailRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open && tailRef.current) {
      tailRef.current.scrollTop = tailRef.current.scrollHeight;
    }
  }, [text, open]);
  return (
    <div data-el="live-thinking" className="rounded-md border border-border/40 bg-muted/30 text-[11.5px]">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 w-full px-2.5 py-1 text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3 rotate-180" />}
        <span className="italic">Thinking…</span>
      </button>
      {open && (
        <div
          ref={tailRef}
          className="px-2.5 pb-2 max-h-40 overflow-auto whitespace-pre-wrap text-muted-foreground/80 leading-relaxed"
        >
          {text}
        </div>
      )}
    </div>
  );
}


export function ThinkingIndicator({
  liveChars,
  silent,
}: {
  silent?: boolean;
  activeTool?: string;
  streaming?: boolean;
  reasoning?: boolean;
  liveChars?: number;
}) {
  // No raw token count: it said nothing about the work (Carl). The pulse alone says it runs.
  void liveChars;
  return (
    <div className="flex items-center gap-2 py-1 text-foreground/80">
      <span className="relative inline-flex h-3 w-3 vc-pulse-drift">
        <span className="absolute inset-0 rounded-full bg-current vc-pulse-ring-a" />
        <span className="absolute inset-0 rounded-full bg-current vc-pulse-ring-b" />
        <span className="relative inline-flex h-3 w-3 rounded-full bg-current vc-pulse-core" />
      </span>
      {/* Thinking with nothing to show yet: one quiet shimmering word beside the pulse. */}
      {silent && (
        <span data-el="live-thinking" data-silent="" className="vc-shimmer text-[13px]">
          Thinking
        </span>
      )}
    </div>
  );
}




function formatEta(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h${rem}m`;
}
