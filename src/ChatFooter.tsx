// The right side of the line under the composer: the run's elapsed time, the context ring, New chat and the Chats
// toggle. Drawn by the composer plugin (src/plugins/composer) and by its built-in fallback (src/ComposerPanel.tsx), so
// New chat and the way to the chat list stay whatever happens to the composer.
import { useEffect, useState } from "react";
import { MessageSquare, Plus } from "lucide-react";
import { useStore } from "./store";
import { isPopout } from "./sync";
import { newChatHere } from "./chat-controller";
import { UsagePopover } from "./UsagePopover";

export function ChatFooterTools({ ready, archived }: { ready: boolean; archived: boolean }) {
  const busy = useStore((s) => s.busy);
  const lastContext = useStore((s) => s.lastContext);
  const boxWindow = useStore((s) => (s.boxChat?.on ? s.conversations.find((c) => c.id === s.activeConversationId)?.contextWindow : undefined));
  // The box's model window (reported with its usage); unknown until it reports one.
  const ctxWindow = boxWindow ? { tokens: boxWindow, known: true } : { tokens: 200_000, known: false };
  // Fullscreen chat shows the chats as its left sidebar (FullscreenChat.tsx), so the button opens and closes that; the
  // docked layout keeps the overlay. The popout window is the fullscreen chat.
  const chatFullscreen = useStore((s) => isPopout || (s.chatFullscreen && !s.popoutOpen));
  const chatsShown = useStore((s) => (isPopout || (s.chatFullscreen && !s.popoutOpen) ? s.chatSidebarOpen : s.showChatsPanel));
  // For chats you can't see: "running" (something is still thinking) takes priority, else "unseen" (a background chat
  // finished and you haven't looked). Mirrors the per-row dot.
  const indicatorKind = useStore((s): "running" | "unseen" | null => {
    const off = s.conversations.filter((c) => c.id !== s.activeConversationId);
    return off.some((c) => c.status === "running") ? "running" : off.some((c) => c.unread) ? "unseen" : null;
  });
  const toggleChatsPanel = () => {
    const s = useStore.getState();
    if (chatFullscreen) s.toggleChatSidebar();
    else s.setShowChatsPanel(!s.showChatsPanel);
  };
  return (
    <div className="flex items-center gap-2">
      {busy && <ElapsedTimer />}
      {lastContext > 0 && (
        <UsagePopover
          title={contextTitle(lastContext, ctxWindow)}
          used={lastContext}
          limit={ctxWindow.tokens}
          known={ctxWindow.known}
          ring={
            <>
              <TokenRing used={lastContext} limit={ctxWindow.tokens} size={14} />
              <span>{formatTokens(lastContext)}</span>
            </>
          }
        />
      )}
      {!archived && (
        <button data-offer="app/chats.newChat"
          onClick={() => {
            newChatHere();
            window.dispatchEvent(new CustomEvent("vc-focus-composer"));
          }}
          disabled={!ready}
          data-el="new-chat"
          className="flex items-center gap-1 hover:text-foreground transition-colors disabled:opacity-40"
          title="New chat — a fresh conversation in this project (or the vault's main). Nothing is wiped: this one stays in the list."
        >
          <Plus className="h-3 w-3" />
          <span>New chat</span>
        </button>
      )}
      {!isPopout && !chatFullscreen && (
        <button data-offer="app/chats.openPanel"
          onClick={toggleChatsPanel}
          className={`relative flex items-center gap-1 text-[11px] hover:text-foreground transition-colors ${chatsShown ? "text-foreground" : "text-muted-foreground"}`}
          data-el="chats-toggle"
          title="Chats — Main and your projects, and what's running"
          aria-label="Chats"
        >
          <MessageSquare className="h-3 w-3" />
          {indicatorKind && (
            <span
              className="relative inline-flex h-1.5 w-1.5 ml-0.5"
              title={indicatorKind === "running" ? "A background chat is thinking" : "A background chat finished — unseen"}
            >
              {indicatorKind === "running" ? (
                // White, pulsing = a background chat is still thinking.
                <>
                  <span className="absolute inset-0 rounded-full bg-foreground opacity-60 animate-ping" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-foreground" />
                </>
              ) : (
                // Solid accent = a background chat finished, unseen.
                <span className="h-1.5 w-1.5 rounded-full bg-primary" />
              )}
            </span>
          )}
        </button>
      )}
    </div>
  );
}

function ElapsedTimer() {
  // Count from the run's real start so leaving and returning to a running
  // thread shows continuous elapsed time, not a restart from 0. The start lives
  // on the conversation itself (`runStartedAt`, stamped when the prompt was
  // sent), so it's correct for EVERY source — manual, voice, mission, worker,
  // phone — and survives open/close and reload. Falls back to the global
  // busyStartedAt, then to mount time, if a start somehow wasn't recorded.
  const startedAt = useStore((s) => {
    const active = s.conversations.find((c) => c.id === s.activeConversationId);
    return active?.runStartedAt ?? s.busyStartedAt;
  });
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const start = startedAt ?? Date.now();
    const tick = () => setSeconds(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  const mm = Math.floor(seconds / 60);
  const ss = seconds % 60;
  const label = mm > 0 ? `${mm}:${ss.toString().padStart(2, "0")}` : `${ss}s`;
  return (
    <span className="tabular-nums opacity-70" title="Agent running">
      {label}
    </span>
  );
}

function TokenRing({ used, limit, size }: { used: number; limit: number; size: number }) {
  const r = (size - 2) / 2;
  const circ = 2 * Math.PI * r;
  const pct = Math.min(used / limit, 1);
  // The track is the quiet divider grey and the used arc the text colour, so even a short arc reads in every theme
  // (high contrast's border is white: a grey arc on a white track looked like an empty ring, 11-23).
  const color = pct < 0.5 ? "hsl(var(--foreground))" : pct < 0.8 ? "hsl(40, 90%, 55%)" : "hsl(0, 72%, 58%)";
  return (
    <svg width={size} height={size} className="shrink-0">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="hsl(var(--divider))" strokeWidth={1.5} />
      <circle
        cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={1.5}
        strokeDasharray={circ} strokeDashoffset={circ * (1 - pct)}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

function contextTitle(used: number, w: { tokens: number; known: boolean }): string {
  const pct = Math.round((used / w.tokens) * 100);
  const of = w.known ? `${w.tokens.toLocaleString()}` : `~${w.tokens.toLocaleString()} (window unknown)`;
  return `Context: ${used.toLocaleString()} of ${of} tokens (${pct}%)`;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}
