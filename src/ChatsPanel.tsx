import { useEffect, useMemo, useRef, useState } from "react";
import { MessageSquare, Plus, X as XIcon, Folder, PanelLeftClose, Home, ChevronRight } from "lucide-react";
import { useStore } from "./store";
import { useProjects } from "./ProjectChip";
import { createProjectThread, deleteProject, MEMORY_SLUG, newChatInProject, openProjectNotes, openThread, projectName, renameProject } from "./projects";
import { panelModel, visibleChats, nextChatLevel, type PanelChat, type PanelEntry } from "./threads";
import { canDeleteChat, deleteChats, renameChat } from "./chatDelete";
import { cn } from "./lib/utils";
import { NewProjectForm } from "./NewProjectForm";
import { usePlaceOpen } from "./placeOpen";

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

// How far each place's list is opened ("Show more" / "Show all"): session state, not saved.
const chatLevels = new Map<string, number>();

/**
 * The left panel (src/threads.ts panelModel): the vault's main on its own at the top, then the
 * projects under a small "Projects" label and "+ New project". Each is a place that opens into its
 * chats, newest first, with "New chat" under them — the place Carl is in is open, the rest are shut
 * until he asks. Nothing else: no older chats (their files stay on disk; the agent reads them with
 * its tools), no memory viewer (memory works behind the scenes; Carl: "if there is a failure, i will
 * tell you to fix it").
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
  const projects = useProjects();
  const { entries } = useMemo(
    () =>
      panelModel(
        // `project` matters now: it is what puts a chat under the place it was
        // started in rather than under the vault's main.
        conversations.map((c) => ({ id: c.id, title: c.title, kind: c.kind, project: c.project, lastActivityAt: c.lastActivityAt, running: c.status === "running", unread: c.unread })),
        projects,
        activeId,
      ),
    [conversations, projects, activeId],
  );
  const [naming, setNaming] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const deleteOne = (id: string) => deleteChats([id]);
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
    const r = await createProjectThread(name);
    if (!r.ok) {
      setErr(r.error);
      return;
    }
    setNaming(null);
    setErr(null);
    focusChat();
  };
  const main = entries.find((e): e is Extract<PanelEntry, { type: "main" }> => e.type === "main")!;
  const label = "px-4 pt-3 pb-1 text-[10.5px] uppercase tracking-wider text-muted-foreground/70 font-medium";

  return (
    <>
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/60">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-[13px] font-semibold">Chats</span>
        </div>
        <div className="flex items-center gap-1 relative">
          {trailing}
        </div>
      </div>

      <div className="flex-1 overflow-auto" data-el="threads">
        {/* Main: the one conversation, on its own. */}
        <div className="py-1.5">
          <ThreadRow
            entry={main}
            name="Main"
            deleteOne={deleteOne}
            onOpenChat={(id, title) => open(id, title)}
            onNewChat={() => {
              useStore.getState().newConversation();
              focusChat();
            }}
            onNotes={() => void openProjectNotes(MEMORY_SLUG, "Memory").then(() => onPicked?.())}
          />
        </div>
        <div className="border-t border-border/60" />
        <div className={label} data-el="projects-label">
          Projects
        </div>
        {entries.map((e) =>
          e.type === "main" ? null : e.type === "new-project" ? (
            naming === null ? (
              <button
                key="new-project"
                onClick={() => setNaming("")}
                data-el="new-project"
                className="w-full px-4 pt-2 pb-1 flex items-center gap-1.5 text-[11.5px] text-muted-foreground/80 hover:text-foreground"
              >
                <Plus className="h-3 w-3" />
                New project
              </button>
            ) : (
              <NewProjectForm key="new-project" onCancel={() => setNaming(null)} onCreate={(name) => void create(name)} />
            )
          ) : (
            <ThreadRow
              key={e.id}
              entry={e}
              name={projectName(e.slug, projects) || e.title}
              deleteOne={deleteOne}
              onOpenChat={(id, title) => open(id, title)}
              onNewChat={() => {
                newChatInProject(e.slug);
                focusChat();
              }}
              onNotes={() => void openProjectNotes(e.slug, e.title).then(() => onPicked?.())}
              onRename={async (to) => {
                const r = await renameProject(e.slug, to);
                setErr(r.ok ? null : r.error);
              }}
              onDelete={async (folder) => {
                const r = await deleteProject(e.slug, { folder });
                setErr(r.ok ? null : r.error);
              }}
            />
          ),
        )}
        {err && <div className="px-4 py-1 text-[11px] text-destructive">{err}</div>}
      </div>
    </>
  );
}

/**
 * Main (a home, a stronger name) or a project (a folder). At rest and on hover the bar shows only its chevron,
 * icon, name and "+" (Carl's option B, 2026-11-08: no hover icons): while the place works a small spinner takes
 * the icon's spot; finished unseen, a dot at the end. Right-click opens its menu: Memory, then for a project
 * Rename (the row becomes its name, Enter keeps it) and "Delete project…" (asked once, right under the row).
 * Main's menu is Memory only.
 *
 * The header bar only shows or hides the place's chats (Carl: clicking it does nothing else — it neither opens
 * the project nor switches chat); a chat is opened from its own row. "+" at the header's right end starts a new
 * chat there.
 */
export function ThreadRow({
  entry,
  name,
  onOpenChat,
  onNewChat,
  onNotes,
  onRename,
  onDelete,
  deleteOne,
}: {
  entry: Extract<PanelEntry, { type: "main" | "project" }>;
  name: string;
  /** Open one of the place's chats. */
  onOpenChat?: (id: string, title: string) => void;
  /** Start a fresh chat in this place. */
  onNewChat?: () => void;
  onNotes?: () => void;
  onRename?: (name: string) => Promise<void>;
  /** `folder`: Carl's second choice — the folder goes too. */
  onDelete?: (folder: boolean) => Promise<void>;
  /** Delete one chat (after its confirm) (src/chatDelete.ts). Null when done, else why not; none: no Delete. */
  deleteOne?: (id: string) => Promise<string | null>;
}) {
  const { active, running, unread } = entry;
  const isMain = entry.type === "main";
  const chats = entry.chats;
  // Open where Carl is: a place he is in shows its chats; the others stay shut
  // until he asks. His own click wins over that, and is kept (src/placeOpen.ts):
  // closing the panel, the other list surface and a restart all keep it.
  const [opened, setOpened] = usePlaceOpen(entry.id);
  const shown = opened ?? active;
  // A project's spinner shows only while it is collapsed: open, its own chats show theirs (Carl, 2026-11-10).
  const spinning = running && (isMain || !shown);
  const [, bump] = useState(0);
  const level = chatLevels.get(entry.id) ?? 0;
  const vis = visibleChats(chats, level);
  const [menu, setMenu] = useState(false);
  const [mode, setMode] = useState<null | "rename" | "confirm">(null);
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const canEdit = !isMain && !!(onRename || onDelete);
  const hasMenu = !!onNotes || canEdit;
  const press = useLongPress(() => setMenu(true), hasMenu);
  useEffect(() => {
    if (!menu) return;
    const away = (ev: MouseEvent) => {
      if (!menuRef.current?.contains(ev.target as Node)) setMenu(false);
    };
    const esc = (ev: KeyboardEvent) => ev.key === "Escape" && setMenu(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [menu]);
  const rename = async () => {
    const to = draft.trim();
    if (!to || to === name) return setMode(null);
    setBusy(true);
    await onRename?.(to);
    setBusy(false);
    setMode(null);
  };
  if (mode === "rename")
    return (
      <div className="px-4 py-1" data-el="project-rename" data-thread={entry.id}>
        <input
          autoFocus
          value={draft}
          disabled={busy}
          onFocus={(ev) => ev.currentTarget.select()}
          onChange={(ev) => setDraft(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === "Enter") void rename();
            if (ev.key === "Escape") {
              ev.stopPropagation();
              setMode(null);
            }
          }}
          onBlur={() => void rename()}
          className="w-full h-7 px-2 rounded bg-background border border-border text-[12px] focus:outline-none focus:border-ring/40"
        />
      </div>
    );
  return (
    <>
    <div
      data-el={isMain ? "thread-main" : "thread-project"}
      data-thread={entry.id}
      {...press}
      onContextMenu={
        hasMenu
          ? (ev) => {
              ev.preventDefault();
              setMenu(true);
            }
          : undefined
      }
      // The trailing gutter only while the unseen dot is there (Carl: too much space on the right); a working
      // place shows its spinner where its icon was, so an idle or working bar ends at its "+".
      className={cn("relative flex items-center gap-1 group", !running && unread ? "pr-7" : "pr-1.5", active ? "bg-accent" : "hover:bg-accent/40")}
    >
      <button
        data-el="place-toggle"
        // Only shows or hides the chats: never opens the place or switches chat.
        onClick={() => {
          // Closing the place also closes its "Show more": opening it again starts at the short list.
          if (shown) chatLevels.delete(entry.id);
          setOpened(!shown);
        }}
        aria-label={shown ? `Hide ${name}'s chats` : `Show ${name}'s chats`}
        aria-expanded={shown}
        className={cn("flex-1 text-left px-4 flex items-center min-w-0", isMain ? "py-2 gap-2.5" : "py-1.5 gap-2")}
      >
        <span data-el="place-chats" className="shrink-0 -ml-2 mr-0.5 h-4 w-4 flex items-center justify-center rounded text-muted-foreground">
          <ChevronRight className={cn("h-3 w-3 transition-transform", shown && "rotate-90")} />
        </span>
        {spinning ? (
          <Spinner className={isMain ? "h-3.5 w-3.5" : "h-3 w-3"} />
        ) : isMain ? (
          <Home className="h-3.5 w-3.5 text-foreground/80 shrink-0" />
        ) : (
          <Folder className="h-3 w-3 text-muted-foreground shrink-0" />
        )}
        <span
          className={cn(
            "truncate flex-1",
            isMain ? "text-[13px] font-semibold text-foreground" : cn("text-[12.5px]", active ? "text-foreground font-medium" : running || unread ? "text-foreground" : "text-foreground/80"),
          )}
        >
          {name}
        </span>
        {!running && unread ? (
          <span className="absolute right-4 top-1/2 -translate-y-1/2 h-1.5 w-1.5 rounded-full bg-primary" title="Done — unseen" role="img" aria-label="Done — unseen" />
        ) : null}
      </button>
      {hasMenu && menu && (
        <div ref={menuRef} data-el="project-menu-list" className="absolute right-2 top-full -mt-1 z-30 min-w-[150px] p-1 rounded-lg border border-border bg-popover shadow-lg text-[12px]">
          {onNotes && (
            <MenuItem
              el="project-memory-item"
              onClick={() => {
                setMenu(false);
                onNotes();
              }}
            >
              Memory
            </MenuItem>
          )}
          {canEdit && (
            <>
              <MenuItem
                el="project-rename-item"
                onClick={() => {
                  setMenu(false);
                  setDraft(name);
                  setMode("rename");
                }}
              >
                Rename
              </MenuItem>
              <div className="my-1 mx-0.5 h-px bg-border" />
              <MenuItem
                el="project-delete-item"
                danger
                onClick={() => {
                  setMenu(false);
                  setMode("confirm");
                }}
              >
                Delete project…
              </MenuItem>
            </>
          )}
        </div>
      )}
      {onNewChat && (
        <button
          onClick={onNewChat}
          data-el="place-new-chat"
          data-place={entry.id}
          aria-label={`New chat in ${name}`}
          className="h-7 w-7 min-h-[28px] min-w-[28px] flex items-center justify-center rounded text-muted-foreground hover:bg-accent/60 hover:text-foreground shrink-0"
          title={`New chat in ${name}`}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
    {shown && (
      <div data-el="place-chat-list" data-place={entry.id}>
        {vis.shown.map((c) => (
          <ChatItem key={c.id} chat={c} onOpen={() => onOpenChat?.(c.id, c.title)} deleteOne={deleteOne} />
        ))}
        {vis.next && (
          <button
            data-el="place-show-more"
            data-place={entry.id}
            onClick={() => {
              chatLevels.set(entry.id, nextChatLevel(chats.length, level));
              bump((n) => n + 1);
            }}
            className="w-full text-left pl-11 py-1 text-[12px] text-muted-foreground/70 hover:text-foreground hover:bg-accent/40"
          >
            {vis.next === "more" ? "Show more" : "Show all"}
          </button>
        )}
        {chats.length === 0 && <div className="pl-11 pr-4 py-1 text-[11.5px] text-muted-foreground/60">No chats</div>}
      </div>
    )}
    {mode === "confirm" && (
      <DeleteProjectConfirm
        name={name}
        busy={busy}
        onCancel={() => setMode(null)}
        onYes={async (folder) => {
          setBusy(true);
          await onDelete?.(folder);
          setBusy(false);
          setMode(null);
        }}
      />
    )}
    </>
  );
}

/**
 * Long-press (touch) opens the same menu as right-click, which a touch screen never sends. A moved finger or an early
 * lift is a scroll or a tap; after a press that opened the menu the lift does not also click the row.
 */
function useLongPress(open: (at: { x: number; y: number }) => void, enabled: boolean) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  if (!enabled) return {};
  return {
    onTouchStart: (ev: React.TouchEvent<HTMLElement>) => {
      const t = ev.touches[0];
      if (!t || ev.touches.length > 1) return stop();
      fired.current = false;
      start.current = { x: t.clientX, y: t.clientY };
      const box = ev.currentTarget.getBoundingClientRect();
      const at = { x: t.clientX - box.left, y: t.clientY - box.top };
      stop();
      timer.current = setTimeout(() => {
        timer.current = null;
        fired.current = true;
        open(at);
      }, 500);
    },
    onTouchMove: (ev: React.TouchEvent<HTMLElement>) => {
      const t = ev.touches[0];
      if (t && start.current && Math.hypot(t.clientX - start.current.x, t.clientY - start.current.y) > 10) stop();
    },
    onTouchEnd: (ev: React.TouchEvent<HTMLElement>) => {
      stop();
      if (fired.current) {
        fired.current = false;
        if (ev.cancelable) ev.preventDefault();
      }
    },
    onTouchCancel: stop,
  };
}

/** A small spinner: a place or chat at work (Carl's option B). */
function Spinner({ className }: { className?: string }) {
  return (
    <span
      data-el="working"
      title="Working…"
      role="img"
      aria-label="Working…"
      className={cn("inline-block shrink-0 rounded-full border-[1.5px] border-muted-foreground/30 border-t-foreground/85 animate-spin", className)}
    />
  );
}

/** One line of a row's right-click menu. */
function MenuItem({ el, danger, onClick, children }: { el: string; danger?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      data-el={el}
      onClick={onClick}
      className={cn("w-full text-left px-2 py-1.5 rounded-md", danger ? "text-destructive hover:bg-destructive/10" : "text-foreground/85 hover:bg-accent hover:text-foreground")}
    >
      {children}
    </button>
  );
}

/**
 * One chat under its place. Nothing on hover (Carl's option B): a spinner at the right end while it works, the
 * dot when it finished unseen. Right-click: Rename (the row becomes its name) and Delete chat (asked once).
 */
function ChatItem({ chat: c, onOpen, deleteOne }: { chat: PanelChat; onOpen: () => void; deleteOne?: (id: string) => Promise<string | null> }) {
  const [confirm, setConfirm] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(c.title);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const deletable = !!deleteOne && canDeleteChat(c.id);
  // Main keeps its name and stays: no menu on its row.
  const hasMenu = canDeleteChat(c.id);
  const press = useLongPress((at) => setMenu(at), hasMenu);
  useEffect(() => {
    if (!menu) return;
    const away = (ev: MouseEvent) => !menuRef.current?.contains(ev.target as Node) && setMenu(null);
    const esc = (ev: KeyboardEvent) => ev.key === "Escape" && setMenu(null);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [menu]);
  const rename = async () => {
    const to = draft.trim();
    if (!to || to === c.title) return setRenaming(false);
    setBusy(true);
    const why = await renameChat(c.id, to);
    setBusy(false);
    setErr(why);
    setRenaming(false);
  };
  const yes = async () => {
    if (!deleteOne) return;
    setBusy(true);
    const why = await deleteOne(c.id);
    setBusy(false);
    setErr(why);
    if (!why) setConfirm(false);
  };
  if (renaming)
    return (
      <div className="pl-9 pr-3 py-0.5" data-el="chat-rename" data-chat={c.id}>
        <input
          autoFocus
          value={draft}
          disabled={busy}
          onFocus={(ev) => ev.currentTarget.select()}
          onChange={(ev) => setDraft(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === "Enter") void rename();
            if (ev.key === "Escape") {
              ev.stopPropagation();
              setRenaming(false);
            }
          }}
          onBlur={() => void rename()}
          className="w-full h-6 px-2 rounded bg-background border border-border text-[12px] focus:outline-none focus:border-ring/40"
        />
      </div>
    );
  return (
    <>
      <div
        className="relative group/chat"
        {...press}
        onContextMenu={
          hasMenu
            ? (ev) => {
                ev.preventDefault();
                setMenu({ x: ev.nativeEvent.offsetX, y: ev.nativeEvent.offsetY });
              }
            : undefined
        }
      >
        <button
          data-el="place-chat"
          data-chat={c.id}
          onClick={onOpen}
          className={cn(
            "relative w-full text-left pl-11 py-1 flex items-center gap-2 text-[12px] min-w-0",
            // Room at the right only for what is there: the spinner while it works, the dot when unseen.
            c.running || c.unread ? "pr-7" : "pr-3",
            c.active ? "bg-accent text-foreground font-medium" : "hover:bg-accent/40 text-foreground/75",
          )}
        >
          <span className="truncate flex-1">{c.title}</span>
          {c.running ? (
            <span className="absolute right-3.5 top-1/2 -translate-y-1/2 inline-flex">
              <Spinner className="h-2.5 w-2.5" />
            </span>
          ) : c.unread ? (
            <span className="absolute right-4 top-1/2 -translate-y-1/2 h-1.5 w-1.5 rounded-full bg-primary" title="Done — unseen" role="img" aria-label="Done — unseen" />
          ) : null}
        </button>
        {menu && (
          <div
            ref={menuRef}
            data-el="chat-menu"
            style={{ left: Math.max(24, menu.x), top: menu.y + 4 }}
            className="absolute z-30 min-w-[150px] p-1 rounded-lg border border-border bg-popover shadow-lg text-[12px]"
          >
            <MenuItem
              el="chat-menu-rename"
              onClick={() => {
                setMenu(null);
                setDraft(c.title);
                setErr(null);
                setRenaming(true);
              }}
            >
              Rename
            </MenuItem>
            {deletable && (
              <>
                <div className="my-1 mx-0.5 h-px bg-border" />
                <MenuItem
                  el="chat-menu-delete"
                  danger
                  onClick={() => {
                    setMenu(null);
                    setConfirm(true);
                  }}
                >
                  Delete chat
                </MenuItem>
              </>
            )}
          </div>
        )}
        {err && !confirm && <div className="pl-11 pr-3 pb-1 text-[11px] text-destructive">Not renamed: {err}</div>}
      </div>
      {confirm && (
        <div data-el="chat-delete-confirm" data-chat={c.id} className="ml-9 mr-3 my-1 px-3 py-2 rounded-md border border-border bg-muted/40 text-[12px]">
          <div className="text-foreground/90 leading-snug">
            Delete <span className="font-medium">{c.title}</span>? The agent can bring it back if you ask.
          </div>
          {err && <div className="mt-1 text-destructive text-[11.5px]">Not deleted: {err}</div>}
          <div className="mt-2 flex justify-end gap-1">
            <button data-el="chat-delete-cancel" disabled={busy} onClick={() => setConfirm(false)} className="h-6 px-2.5 rounded text-[11.5px] text-muted-foreground hover:bg-accent hover:text-foreground">
              Cancel
            </button>
            <button data-el="chat-delete-yes" disabled={busy} autoFocus onClick={() => void yes()} className="h-6 px-2.5 rounded text-[11.5px] text-destructive hover:bg-destructive/10 disabled:opacity-60">
              {busy ? "Deleting…" : "Delete"}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/** Delete, asked once, right under the project's row: the conversation only (the folder stays, a plain folder again),
 *  or everything (the folder too). Nothing is lost for good: git keeps a copy. */
export function DeleteProjectConfirm({ name, busy, onCancel, onYes }: { name: string; busy: boolean; onCancel: () => void; onYes: (folder: boolean) => void }) {
  return (
    <div data-el="project-delete-confirm" className="mx-3 mb-1.5 mt-0.5 px-3 py-2 rounded-md border border-border bg-muted/40 text-[12px]">
      <div className="text-foreground/90 leading-snug">
        Delete project <span className="font-medium">{name}</span>? Git keeps a copy either way.
      </div>
      <div className="mt-2 flex flex-col gap-1">
        <button data-el="project-delete-yes" disabled={busy} autoFocus onClick={() => onYes(false)} className="min-h-6 py-1 px-2 rounded text-left leading-snug text-[11.5px] hover:bg-accent disabled:opacity-60">
          Remove the conversation, keep the folder
        </button>
        <button data-el="project-delete-everything" disabled={busy} onClick={() => onYes(true)} className="min-h-6 py-1 px-2 rounded text-left leading-snug text-[11.5px] text-destructive hover:bg-accent disabled:opacity-60">
          Delete everything, the folder too
        </button>
      </div>
      <div className="mt-1 flex justify-end">
        <button data-el="project-delete-cancel" disabled={busy} onClick={onCancel} className="h-6 px-2.5 rounded text-[11.5px] text-muted-foreground hover:bg-accent hover:text-foreground">
          {busy ? "Deleting…" : "Cancel"}
        </button>
      </div>
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
