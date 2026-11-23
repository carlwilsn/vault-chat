// The chat pane's transcript (Track 1; part `transcript` of app/chat, src/plugins/chat): everything the pane draws
// around the rows, moved here from src/ChatPane.tsx unchanged. While the box starts or there is no box, a screen that
// says so (no box: a way to Settings → Box); otherwise the header slot, the messages (only the newest CHAT_WINDOW drawn;
// older ones join as Carl scrolls up or the agent asks), "new messages" when he has scrolled away mid-reply, the live
// tail, and above the composer the background-task strip, the plan, the ongoing-work line and the composer slot.
// The rows themselves are app/chat-rows' renderers; the composer is app/composer; the header is this plugin's own.
//
// src/ChatPane.tsx mounts it (./index.tsx `transcript`) through the plugin host; while the records are not known yet, or the plugin is off, this same component is
// drawn in the app's own tree. Speed: it reads the store per field, and the history is a memoized list, so a keystroke
// in the composer (its own root) or a streaming reply never re-walks the history.
import { useShallow } from "zustand/react/shallow";
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { planCards, currentPlan, type PlanCard } from "../../planPlace";
import { dispatchChatAction } from "../../sync";
import { isCompactionDivider } from "../../chatContext";
import { useStore, type ChatMessage } from "../../store";
import { Button } from "../../ui";
import { BOX_UNREACHABLE, NO_BOX, STARTING, boxAnswer, boxChatOn, boxRetry, boxSubagent } from "../../boxChat";
import { Subagents, VerdictLine, chosenAnswer, subagentsOfMessage, type SubagentRec } from "../../chatExtras";
import { uiChoice } from "../../uiChoices";
import { taskState } from "../../backgroundTasks";
import { OngoingLine } from "../../OngoingLine";
import { useChatGate } from "../../chatGate";
import { ComposerSlot } from "../../ComposerPanel";
import { scrollHold } from "../composer/draft";
import { MessageBubble, PinnedPlan, PlanRow } from "../chat-rows/rows";
import { LiveTail } from "../chat-rows/tail";
import { CHAT_REVEAL_EVENT, setVisibleRows } from "../../chatRows";
import { ChatHeaderSlot } from "../../ChatHeader";
import { isPopout } from "../../windowKind";
import { emitChatEvent, paneScrolled, setPaneScroll } from "./model";

const NO_SUBAGENTS: SubagentRec[] = [];

/** How many messages a chat draws at first, and how many more each scroll to the top adds. */
const CHAT_WINDOW = 60;

/** Settings, at its Box section (the no-box screen's button; the offers' openBoxSettings). */
export function openBoxSettings() {
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

/** The chat pane's transcript and what sits with it (the box starting / no-box screens, the header slot, the window of
 *  messages, jump-to-latest, the background-task strip, the plan, the ongoing-work line, the composer slot). */
export function Transcript() {
  // Per-field selectors so the pane only re-renders when the field it
  // actually reads changes. Destructuring the whole store was causing
  // every keystroke to rebuild the entire message list because the
  // agent's streamingText/liveTools updates were waking this component
  // 60+ times per second.
  const messages = useStore((s) => s.messages);
  const busy = useStore((s) => s.busy);
  // Fullscreen chat and the popout draw the header in their own top bar (src/FullscreenChat.tsx).
  const inOwnBar = useStore((s) => isPopout || (s.chatFullscreen && !s.popoutOpen));
  const streamingText = useStore((s) => s.streamingText);
  const streamingReasoning = useStore((s) => s.streamingReasoning);
  const liveTools = useStore((s) => s.liveTools);
  // Hooks must live above the early returns below (the box starting, no box): React's
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
  const jumpShownRef = useRef(false);
  jumpShownRef.current = showJumpToLatest;

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
  // The agent's scrollTo (app/chat-rows) asks for a row above the window: draw from it down.
  useEffect(() => {
    const onReveal = (e: Event) => {
      const at = Number((e as CustomEvent<{ index?: number }>).detail?.index);
      const msgs = useStore.getState().messages;
      if (!Number.isInteger(at) || at < 0 || at >= msgs.length) return;
      let n = 0;
      for (let i = msgs.length - 1; i >= at; i--) if (!msgs[i]!.hidden && !msgs[i]!.waiting) n++;
      setChatWindow((w) => ({ conv: useStore.getState().activeConversationId, count: Math.max(n, w.conv === useStore.getState().activeConversationId ? w.count : CHAT_WINDOW) }));
    };
    window.addEventListener(CHAT_REVEAL_EVENT, onReveal);
    return () => window.removeEventListener(CHAT_REVEAL_EVENT, onReveal);
  }, []);

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
    paneScrolled();
    if (restoreHeldScroll()) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distanceFromBottom < 40;
    pinnedToBottomRef.current = atBottom;
    setShowJumpToLatest(!atBottom && (busy || streamingText.length > 0));
    if (el.scrollTop < 400 && windowStartRef.current > 0 && heightBeforeOlderRef.current == null) {
      heightBeforeOlderRef.current = el.scrollHeight;
      setChatWindow({ conv: activeConversationId, count: shownCount + CHAT_WINDOW });
      emitChatEvent("olderShown", { by: "scroll", shown: shownCount + CHAT_WINDOW });
    }
  };

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedToBottomRef.current = true;
    setShowJumpToLatest(false);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    emitChatEvent("jumped");
  };

  // The pane's scroll, for the chat pane plugin's offers (src/plugins/chat: scrollToBottom, showOlder, scroll state).
  const scrollLive = useRef({ shownCount, activeConversationId });
  scrollLive.current = { shownCount, activeConversationId };
  useEffect(() => {
    const visible = () => useStore.getState().messages.filter((m) => !m.hidden && !m.waiting).length;
    return setPaneScroll({
      state: () => {
        const el = scrollRef.current;
        const total = visible();
        const shown = Math.min(total, scrollLive.current.shownCount);
        return { atBottom: el ? el.scrollHeight - el.scrollTop - el.clientHeight < 40 : true, shown, total, older: total - shown, jump: jumpShownRef.current };
      },
      toBottom: () => {
        const el = scrollRef.current;
        pinnedToBottomRef.current = true;
        setShowJumpToLatest(false);
        if (el) el.scrollTop = el.scrollHeight;
      },
      older: (n, top) => {
        const el = scrollRef.current;
        const { shownCount: now, activeConversationId: conv } = scrollLive.current;
        const total = visible();
        const count = n === "all" ? total : Math.min(total, now + Math.max(1, Math.floor(n)));
        if (count > now) {
          if (el && !top) heightBeforeOlderRef.current = el.scrollHeight;
          setChatWindow({ conv, count });
        }
        if (top) {
          pinnedToBottomRef.current = false;
          requestAnimationFrame(() => {
            if (scrollRef.current) scrollRef.current.scrollTop = 0;
          });
        }
      },
    });
  }, []);

  // The background-task strip, for the offers' tasksChanged (only when the running set changes).
  const taskKey = runningTasks.map((t) => t.threadId).join(" ");
  const firstTasks = useRef(true);
  useEffect(() => {
    if (firstTasks.current) {
      firstTasks.current = false;
      return;
    }
    emitChatEvent("tasksChanged", { running: runningTasks.length });
  }, [taskKey]);

  const todos = useMemo(() => currentPlan(messages), [messages]);
  const plans = useMemo(() => planCards(messages), [messages]);
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
            <Button data-offer="app/chat.openBoxSettings" variant="secondary" size="sm" onClick={openBoxSettings} className="w-full">
              Settings → Box
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const verdict = activeConv?.state === "done" ? activeConv.verdict : undefined;
  let lastVisible = -1;
  for (let i = messages.length - 1; i >= 0; i--) if (!messages[i]!.hidden && !messages[i]!.system) { lastVisible = i; break; }
  let windowStart = 0;
  for (let i = messages.length - 1, n = 0; i >= 0; i--) {
    if (messages[i]!.hidden || messages[i]!.waiting) continue;
    if (++n > shownCount) { windowStart = i + 1; break; }
  }
  windowStartRef.current = windowStart;

  return (
    <div className="h-full flex flex-col bg-card border-l border-border relative" data-el="chat-transcript">
      {/* The pane's header (the chat's name, the cost, the ⋯ menu): this plugin's header part, with a
          built-in fallback (src/ChatHeader.tsx). Fullscreen chat and the popout draw it in their top bar instead. */}
      {!inOwnBar && <ChatHeaderSlot />}
      <div
        className="flex-1 min-h-0 overflow-auto px-3 py-4 pb-8 relative"
        data-el="chat-scroll"
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

        {parentConv && <button data-offer="app/chat.openParent" type="button" data-el="worker-parent" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => openSubagent(parentConv.id)}>Back to {parentConv.title || "parent chat"}</button>}

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
          plans={plans}
        />




        {verdict && uiChoice("verdict") === "thread" && <VerdictLine verdict={verdict} />}

        {/* Running, nothing streamed yet: the model is thinking without showing
            it. Gone at the first text, thinking or tool line. */}

        {/* What streams now: the live tail's rows (src/plugins/chat-rows/tail.tsx), each drawn by its kind's renderer. */}
        <LiveTail text={streamingText} reasoning={streamingReasoning} tools={liveTools} busy={busy} />

        </div>
      </div>

      <div className="relative">
        <div className="pointer-events-none absolute -top-12 left-0 right-0 h-12 bg-gradient-to-t from-card to-transparent" />
        {showJumpToLatest && (
          <button data-offer="app/chat.scrollToBottom"
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
          {/* The plan above the composer, when the plan renderer places it there (its placement option). */}
          <PinnedPlan todos={todos} busy={busy} />
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
 * (its own root) never re-walks the history: only a new message, the window or the
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
  /** Each plan's card under the reply that wrote it; the plan renderer decides whether it shows there (PlanRow). */
  plans: PlanCard[];
}) {
  // What is on screen, for the agent (src/chatRows.ts visibleRows; read only when asked).
  useEffect(() => setVisibleRows(messages, windowStart, isCompactionDivider as (m: unknown) => boolean), [messages, windowStart]);
  return (
    <>
      {messages.map((m, i) =>
        i < windowStart || m.hidden ? null : (
          <Fragment key={m.mid ?? i}>
            <MessageBubble
              message={m}
              index={i}
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
            {plans.filter((p) => p.index === i).map((p) => <PlanRow key={p.id} todos={p.todos} index={i} />)}
          </Fragment>
        ),
      )}
    </>
  );
});
