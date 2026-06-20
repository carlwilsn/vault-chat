import { useEffect, useMemo, useRef, useState } from "react";
import { MessageSquare, Plus, X as XIcon, Trash2, Send, Mic } from "lucide-react";
import { useStore } from "./store";
import { conversationPreview, type Conversation } from "./conversations";

type Props = {
  open: boolean;
  onClose: () => void;
  onFocusComposer?: () => void;
};

export function ChatsPanel({ open, onClose, onFocusComposer }: Props) {
  const conversations = useStore((s) => s.conversations);
  const activeId = useStore((s) => s.activeConversationId);
  const newConversation = useStore((s) => s.newConversation);
  const selectConversation = useStore((s) => s.selectConversation);
  const deleteConversation = useStore((s) => s.deleteConversation);
  const [query, setQuery] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const el = panelRef.current;
      if (!el) return;
      if (el.contains(e.target as Node)) return;
      onClose();
    };
    // Defer one tick — the click that opened us shouldn't immediately
    // close us.
    const id = window.setTimeout(() => {
      window.addEventListener("mousedown", onDown);
    }, 0);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open, onClose]);

  const runningCount = useMemo(
    () => conversations.filter((c) => c.status === "running").length,
    [conversations],
  );

  const sections = useMemo(() => groupConversations(conversations, query), [conversations, query]);

  if (!open) return null;

  const handleNew = () => {
    newConversation();
    setQuery("");
    onClose();
    const store = useStore.getState();
    if (store.rightCollapsed) store.toggleRight();
    // Defer so the chat pane is fully visible before focus moves.
    setTimeout(() => onFocusComposer?.(), 0);
  };

  return (
    <div className="fixed inset-0 z-30 flex justify-end pointer-events-none">
      <div
        ref={panelRef}
        className="h-full w-[380px] max-w-[92vw] bg-card border-l border-border shadow-xl flex flex-col pointer-events-auto"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/60">
          <div className="flex items-center gap-2">
            <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-[13px] font-semibold">Chats</span>
            <span className="text-[11px] text-muted-foreground">
              {conversations.length}
              {runningCount > 0 ? ` · ${runningCount} running` : ""}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={handleNew}
              className="h-7 px-2 flex items-center gap-1 rounded hover:bg-accent/60 text-[11.5px] text-foreground/90"
              title="New chat (Ctrl+T)"
            >
              <Plus className="h-3 w-3" />
              <span>New</span>
            </button>
            <button
              onClick={onClose}
              className="h-7 w-7 flex items-center justify-center rounded hover:bg-accent/60 text-muted-foreground"
              title="Close (Esc)"
            >
              <XIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2 px-4 py-2 border-b border-border/60">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter chats…"
            className="flex-1 h-6 px-2 rounded bg-background border border-border text-[11.5px] placeholder:text-muted-foreground/60 focus:outline-none focus:border-ring/40"
          />
        </div>

        <div className="flex-1 overflow-auto">
          {conversations.length === 0 ? (
            <div className="px-4 py-6 text-center text-[12px] text-muted-foreground">
              No chats yet.
            </div>
          ) : (
            <>
              {sections.running.length > 0 && (
                <Section label="Running">
                  {sections.running.map((c) => (
                    <Row
                      key={c.id}
                      conversation={c}
                      active={c.id === activeId}
                      onSelect={() => {
                        selectConversation(c.id);
                        onClose();
                      }}
                      onDelete={() => deleteConversation(c.id)}
                    />
                  ))}
                </Section>
              )}
              {sections.recent.length > 0 && (
                <Section label="Recent">
                  {sections.recent.map((c) => (
                    <Row
                      key={c.id}
                      conversation={c}
                      active={c.id === activeId}
                      onSelect={() => {
                        selectConversation(c.id);
                        onClose();
                      }}
                      onDelete={() => deleteConversation(c.id)}
                    />
                  ))}
                </Section>
              )}
              {sections.earlier.length > 0 && (
                <Section label="Earlier">
                  {sections.earlier.map((c) => (
                    <Row
                      key={c.id}
                      conversation={c}
                      active={c.id === activeId}
                      onSelect={() => {
                        selectConversation(c.id);
                        onClose();
                      }}
                      onDelete={() => deleteConversation(c.id)}
                    />
                  ))}
                </Section>
              )}
              {sections.telegram.length > 0 && (
                <CollapsibleSection
                  label={`Telegram (${sections.telegram.length})`}
                  defaultOpen={false}
                >
                  {sections.telegram.map((c) => (
                    <Row
                      key={c.id}
                      conversation={c}
                      active={c.id === activeId}
                      onSelect={() => {
                        selectConversation(c.id);
                        onClose();
                      }}
                      onDelete={() => deleteConversation(c.id)}
                    />
                  ))}
                </CollapsibleSection>
              )}
              {sections.running.length === 0 &&
                sections.recent.length === 0 &&
                sections.earlier.length === 0 &&
                sections.telegram.length === 0 && (
                  <div className="px-4 py-6 text-center text-[12px] text-muted-foreground">
                    No matches.
                  </div>
                )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <div className="px-4 pt-3 pb-1 text-[10.5px] uppercase tracking-wider text-muted-foreground/80 font-medium">
        {label}
      </div>
      {children}
    </>
  );
}

function CollapsibleSection({
  label,
  defaultOpen,
  children,
}: {
  label: string;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-1.5 px-4 pt-3 pb-1 text-[10.5px] uppercase tracking-wider text-muted-foreground/80 font-medium hover:text-foreground transition-colors"
      >
        <span className="text-[10px] opacity-70">{open ? "▾" : "▸"}</span>
        {label}
      </button>
      {open && children}
    </>
  );
}

function Row({
  conversation,
  active,
  onSelect,
  onDelete,
}: {
  conversation: Conversation;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const c = conversation;
  const time = relativeTime(c.lastActivityAt);
  const preview = conversationPreview(c);
  const isRunning = c.status === "running";
  const isUnread = c.unread && !active;
  const titleClass = active
    ? "text-[12.5px] text-foreground truncate flex-1 font-medium"
    : isUnread || isRunning
      ? "text-[12.5px] text-foreground truncate flex-1"
      : "text-[12.5px] text-muted-foreground truncate flex-1";
  const previewClass =
    isUnread || isRunning || active
      ? "text-[10.5px] text-muted-foreground truncate mt-0.5"
      : "text-[10.5px] text-muted-foreground/80 truncate mt-0.5";

  return (
    <div
      className={
        active
          ? "border-b border-border/40 bg-accent flex items-start gap-2 group"
          : "border-b border-border/40 hover:bg-accent/40 flex items-start gap-2 group"
      }
    >
      <button
        onClick={onSelect}
        className="flex-1 text-left px-4 py-2.5 flex items-start gap-2 min-w-0"
      >
        <span
          className="relative inline-flex h-1.5 w-1.5 mt-[7px] shrink-0"
          title={
            isRunning ? "Generating…" : isUnread ? "Done — unseen" : undefined
          }
        >
          {isRunning ? (
            // White, pulsing = still thinking.
            <>
              <span className="absolute inset-0 rounded-full bg-foreground opacity-60 animate-ping" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-foreground" />
            </>
          ) : isUnread ? (
            // Solid accent = finished, waiting for you to look.
            <span className="h-1.5 w-1.5 rounded-full bg-primary" />
          ) : active ? (
            <span className="h-1.5 w-1.5 rounded-full bg-foreground/40" />
          ) : null}
        </span>
        <span className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className={titleClass}>{c.title || "New chat"}</span>
            {c.source !== "manual" && <SourceIcon source={c.source} />}
            <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
              {time}
            </span>
          </div>
          {preview && <div className={previewClass}>{preview}</div>}
        </span>
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className="opacity-0 group-hover:opacity-100 transition-opacity h-7 w-7 mr-2 mt-1 flex items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive shrink-0"
        title="Delete chat"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
}

function SourceIcon({ source }: { source: string }) {
  if (source === "telegram") {
    return <Send className="h-3 w-3 text-muted-foreground shrink-0" />;
  }
  if (source === "voice") {
    return <Mic className="h-3 w-3 text-muted-foreground shrink-0" />;
  }
  return null;
}

const DAY = 24 * 60 * 60 * 1000;

function groupConversations(list: Conversation[], query: string) {
  const q = query.trim().toLowerCase();
  const filter = (c: Conversation) => {
    if (!q) return true;
    const hay = `${c.title}\n${conversationPreview(c)}`.toLowerCase();
    return hay.includes(q);
  };
  const sorted = list.slice().sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  const now = Date.now();
  const running: Conversation[] = [];
  const recent: Conversation[] = [];
  const earlier: Conversation[] = [];
  const telegram: Conversation[] = [];
  for (const c of sorted) {
    if (!filter(c)) continue;
    // Telegram chats live on the phone by default — collapse them
    // into their own section so they don't pollute the main Recent
    // / Earlier views. Running-state telegram chats still bubble up
    // into Running so background activity is visible.
    if (c.source === "telegram" && c.status !== "running") {
      telegram.push(c);
      continue;
    }
    if (c.status === "running") {
      running.push(c);
      continue;
    }
    if (now - c.lastActivityAt <= DAY) recent.push(c);
    else earlier.push(c);
  }
  return { running, recent, earlier, telegram };
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return "now";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk}w`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
