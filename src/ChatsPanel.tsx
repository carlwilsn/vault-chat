import { useEffect, useMemo, useRef, useState } from "react";
import { MessageSquare, Plus, X as XIcon, Trash2, Mic, Folder, PanelLeftClose, FileText, MoreHorizontal, ChevronLeft, Brain, MessageSquarePlus, History } from "lucide-react";
import { useStore } from "./store";
import { conversationPreview, type Conversation } from "./conversations";
import { useProjects } from "./ProjectChip";
import { createProjectThread, openMemory, openProjectNotes, openThread, projectName } from "./projects";
import { panelModel, threadKindOf, type PanelEntry } from "./threads";
import { cn } from "./lib/utils";

type Props = {
  open: boolean;
  onClose: () => void;
  onFocusComposer?: () => void;
};

/** The left panel as an overlay (the docked layout): a 380px slide-over on the right. */
export function ChatsPanel({ open, onClose, onFocusComposer }: Props) {
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

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-30 flex justify-end pointer-events-none">
      <div
        ref={panelRef}
        className="h-full w-[380px] max-w-[92vw] bg-card border-l border-border shadow-xl flex flex-col pointer-events-auto"
      >
        <ThreadsList
          onPicked={onClose}
          onFocusComposer={onFocusComposer}
          trailing={
            <button
              onClick={onClose}
              className="h-7 w-7 flex items-center justify-center rounded hover:bg-accent/60 text-muted-foreground"
              title="Close (Esc)"
            >
              <XIcon className="h-3.5 w-3.5" />
            </button>
          }
        />
      </div>
    </div>
  );
}

/** Fullscreen chat's (and the popout's) left sidebar: the same list, docked, collapsible. */
export function ChatsSidebar({ onFocusComposer }: { onFocusComposer?: () => void }) {
  const toggle = useStore((s) => s.toggleChatSidebar);
  return (
    <aside data-el="chats-sidebar" className="h-full w-[272px] shrink-0 bg-background flex flex-col">
      <ThreadsList
        onFocusComposer={onFocusComposer}
        trailing={
          <button
            onClick={toggle}
            className="h-7 w-7 flex items-center justify-center rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground"
            title="Hide (Ctrl+B)"
          >
            <PanelLeftClose className="h-3.5 w-3.5" />
          </button>
        }
      />
    </aside>
  );
}

/**
 * The left panel (src/threads.ts panelModel): Main at the top, then the projects (each opens its one
 * thread), then "+ New project". No list of chats: the menu has "New separate chat", "Older chats"
 * (separate and older chats, newest first) and "Memory" (the agent's MEMORY.md).
 */
function ThreadsList({
  onPicked,
  onFocusComposer,
  trailing,
}: {
  /** after a thread is picked or started (the overlay closes; the sidebar stays) */
  onPicked?: () => void;
  onFocusComposer?: () => void;
  /** the header's last control: close (overlay) or hide (sidebar) */
  trailing: React.ReactNode;
}) {
  const conversations = useStore((s) => s.conversations);
  const activeId = useStore((s) => s.activeConversationId);
  const deleteConversation = useStore((s) => s.deleteConversation);
  const projects = useProjects();
  const { entries, others } = useMemo(
    () =>
      panelModel(
        conversations.map((c) => ({ id: c.id, title: c.title, kind: c.kind, lastActivityAt: c.lastActivityAt, running: c.status === "running", unread: c.unread })),
        projects,
        activeId,
      ),
    [conversations, projects, activeId],
  );
  const [menu, setMenu] = useState(false);
  const [older, setOlder] = useState(false);
  const [naming, setNaming] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const focusChat = () => {
    onPicked?.();
    const store = useStore.getState();
    if (store.rightCollapsed) store.toggleRight();
    setTimeout(() => onFocusComposer?.(), 0);
  };
  const open = (id: string, title?: string) => {
    openThread(id, title);
    onPicked?.();
  };
  const create = async (name: string) => {
    setNaming(null);
    const r = await createProjectThread(name);
    if (!r.ok) {
      setErr(r.error);
      return;
    }
    setErr(null);
    focusChat();
  };
  const byId = useMemo(() => new Map(conversations.map((c) => [c.id, c])), [conversations]);

  if (older) {
    return (
      <>
        <div className="flex items-center justify-between px-2 py-3 border-b border-border/60">
          <button onClick={() => setOlder(false)} data-el="older-back" className="h-7 px-2 flex items-center gap-1 rounded hover:bg-accent/60 text-[13px] font-semibold">
            <ChevronLeft className="h-3.5 w-3.5 text-muted-foreground" />
            Older chats
          </button>
          {trailing}
        </div>
        <div className="flex-1 overflow-auto" data-el="older-chats">
          {others.length === 0 ? (
            <div className="px-4 py-6 text-center text-[12px] text-muted-foreground">No other chats.</div>
          ) : (
            others.map((o) => {
              const c = byId.get(o.id);
              return c ? <OlderRow key={c.id} conversation={c} active={c.id === activeId} onSelect={() => open(c.id)} onDelete={() => void deleteConversation(c.id)} /> : null;
            })
          )}
        </div>
      </>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/60">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-[13px] font-semibold">Chats</span>
        </div>
        <div className="flex items-center gap-1 relative">
          <button
            onClick={() => setMenu((v) => !v)}
            data-el="threads-menu"
            className={cn("h-7 w-7 flex items-center justify-center rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground", menu && "bg-accent/60 text-foreground")}
            title="More"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
          {menu && (
            <Menu onClose={() => setMenu(false)}>
              <MenuItem
                el="new-separate-chat"
                icon={<MessageSquarePlus className="h-3 w-3" />}
                label="New separate chat"
                onClick={() => {
                  useStore.getState().newConversation();
                  focusChat();
                }}
              />
              <MenuItem el="open-older-chats" icon={<History className="h-3 w-3" />} label={`Older chats${others.length ? ` (${others.length})` : ""}`} onClick={() => setOlder(true)} />
              <MenuItem el="open-memory" icon={<Brain className="h-3 w-3" />} label="Memory" onClick={() => void openMemory().then(() => onPicked?.())} />
            </Menu>
          )}
          {trailing}
        </div>
      </div>

      <div className="flex-1 overflow-auto py-1" data-el="threads">
        {entries.map((e) =>
          e.type === "new-project" ? (
            naming === null ? (
              <button
                key="new-project"
                onClick={() => setNaming("")}
                data-el="new-project"
                className="w-full px-4 pt-3 pb-1 flex items-center gap-1.5 text-[10.5px] uppercase tracking-wider text-muted-foreground/70 hover:text-foreground font-medium"
              >
                <Plus className="h-3 w-3" />
                New project
              </button>
            ) : (
              // Name it here: Enter makes the project and opens its thread.
              <div key="new-project" className="px-4 pt-3 pb-1">
                <input
                  autoFocus
                  value={naming}
                  data-el="new-project-name"
                  onChange={(ev) => setNaming(ev.target.value)}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter" && naming.trim()) void create(naming.trim());
                    if (ev.key === "Escape") {
                      ev.stopPropagation();
                      setNaming(null);
                    }
                  }}
                  onBlur={() => !naming.trim() && setNaming(null)}
                  placeholder="Project name, then Enter"
                  className="w-full h-7 px-2 rounded bg-background border border-border text-[12px] placeholder:text-muted-foreground/60 focus:outline-none focus:border-ring/40"
                />
              </div>
            )
          ) : (
            <ThreadRow
              key={e.id}
              entry={e}
              name={e.type === "project" ? projectName(e.slug, projects) || e.title : e.title}
              onSelect={() => open(e.id, e.title)}
              onNotes={e.type === "project" ? () => void openProjectNotes(e.slug, e.title).then(() => onPicked?.()) : () => void openMemory().then(() => onPicked?.())}
            />
          ),
        )}
        {err && <div className="px-4 py-1 text-[11px] text-destructive">{err}</div>}
      </div>
    </>
  );
}

function Menu({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);
  return (
    <div ref={ref} data-el="threads-menu-list" className="absolute right-0 top-8 z-20 w-48 rounded-md border border-border bg-popover text-popover-foreground shadow-lg p-1" onClick={onClose}>
      {children}
    </div>
  );
}

function MenuItem({ icon, label, onClick, el }: { icon: React.ReactNode; label: string; onClick: () => void; el: string }) {
  return (
    <button data-el={el} onClick={onClick} className="w-full text-left px-2.5 h-7 flex items-center gap-2 rounded text-[12px] hover:bg-accent/60">
      <span className="text-muted-foreground">{icon}</span>
      <span className="truncate flex-1">{label}</span>
    </button>
  );
}

/** Main or a project's thread: its name, a dot while it works (pulsing) or when it finished unseen. */
function ThreadRow({ entry, name, onSelect, onNotes }: { entry: Extract<PanelEntry, { type: "main" | "project" }>; name: string; onSelect: () => void; onNotes: () => void }) {
  const { active, running, unread } = entry;
  return (
    <div
      data-el={entry.type === "main" ? "thread-main" : "thread-project"}
      data-thread={entry.id}
      className={cn("relative flex items-center gap-1 group", active ? "bg-accent" : "hover:bg-accent/40")}
    >
      <button onClick={onSelect} className="flex-1 text-left px-4 py-2 flex items-center gap-2 min-w-0">
        {entry.type === "main" ? <MessageSquare className="h-3 w-3 text-muted-foreground shrink-0" /> : <Folder className="h-3 w-3 text-muted-foreground shrink-0" />}
        <span className={cn("text-[12.5px] truncate flex-1", active ? "text-foreground font-medium" : running || unread ? "text-foreground" : "text-foreground/80")}>{name}</span>
        {running ? (
          <span className="relative inline-flex h-1.5 w-1.5 shrink-0" title="Working…">
            <span className="absolute inset-0 rounded-full bg-foreground opacity-60 animate-ping" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-foreground" />
          </span>
        ) : unread ? (
          <span className="h-1.5 w-1.5 rounded-full bg-primary shrink-0" title="Done — unseen" />
        ) : null}
      </button>
      <button
        onClick={onNotes}
        data-el={entry.type === "main" ? "main-memory" : "project-notes"}
        className="opacity-0 group-hover:opacity-100 transition-opacity h-7 w-7 mr-2 flex items-center justify-center rounded text-muted-foreground hover:bg-accent/60 hover:text-foreground shrink-0"
        title={entry.type === "main" ? "Memory" : "Project notes"}
      >
        {entry.type === "main" ? <Brain className="h-3 w-3" /> : <FileText className="h-3 w-3" />}
      </button>
    </div>
  );
}

/** A separate or older chat, in "Older chats". */
function OlderRow({ conversation: c, active, onSelect, onDelete }: { conversation: Conversation; active: boolean; onSelect: () => void; onDelete: () => void }) {
  const preview = conversationPreview(c);
  const separate = threadKindOf(c) === "separate";
  return (
    <div className={cn("relative border-b border-border/40 flex items-start gap-1 group", active ? "bg-accent" : "hover:bg-accent/40")}>
      <button onClick={onSelect} className="flex-1 text-left px-4 py-2.5 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className={cn("text-[12.5px] truncate flex-1", active ? "text-foreground font-medium" : "text-muted-foreground")}>{c.title || "New chat"}</span>
          {c.source === "voice" && <Mic className="h-3 w-3 text-muted-foreground shrink-0" />}
          {separate && <span className="text-[10px] text-muted-foreground/80 shrink-0">separate</span>}
          <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">{relativeTime(c.lastActivityAt)}</span>
        </div>
        {preview && <div className="text-[10.5px] text-muted-foreground/80 truncate mt-0.5">{preview}</div>}
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

export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return "now";
  const sec = Math.floor(diff / 1000);
  // Under a minute is "now" (it used to read as a clock: "0:04").
  if (sec < 60) return "now";
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
