// The chat list (Stage 2, Track 1: the second part of the app to become a plugin; src/plugins/chats/index.tsx mounts
// it): "New chat" on top, the chats without a project under it, then the projects as places that open into their
// chats, "Show more", spinners and the unseen dot, the right-click menus (rename, delete) and "New project" (Carl's
// design E2, 2026-11-24: no "Chats" header, no Main row). Two surfaces show the same list: the overlay from the
// chat pane's chats button (ChatsOverlay) and fullscreen chat's left sidebar (ChatsSidebarView).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Plus, X as XIcon, Folder, FolderPlus, ChevronRight } from "lucide-react";
import { useStore } from "../../store";
import { useProjects } from "../../ProjectChip";
import { newChatIn } from "../../chat-controller";
import { openChatDock } from "../../chatDock";
import { createProjectThread, deleteProject, openThread, projectName, renameProject } from "../../projects";
import { panelModel, visibleChats, nextChatLevel, type PanelChat, type PanelEntry } from "../../threads";
import { canDeleteChat, deleteChats, renameChat } from "../../chatDelete";
import { cn } from "../../lib/utils";
import { MENU_PANEL, menuItemClass } from "../../ui";
import { ROW_HOVER, ROW_INSET, ROW_SELECTED, ROW_SHAPE } from "../../lib/rows";
import { NewProjectForm } from "../../NewProjectForm";
import { usePlaceOpen } from "../../placeOpen";
import { chatLevels, useChatLevel } from "./view";

/** Composer focus is owned by ChatPane (the event App.tsx and the popout send too). */
export const focusComposer = () => window.dispatchEvent(new CustomEvent("vc-focus-composer"));

/** The list as an overlay (the docked layout): a 272px slide-over on the right (Carl 11-26: the old sidebar width), while the chat pane's button has it open. */
export function ChatsOverlay() {
  // Fullscreen chat has its sidebar instead (the popout window keeps the docked layout here).
  const open = useStore((s) => s.showChatsPanel && !(s.chatFullscreen && !s.popoutOpen));
  const panelRef = useRef<HTMLDivElement>(null);
  const onClose = useMemo(() => () => useStore.getState().setShowChatsPanel(false), []);

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
        className="h-full w-[272px] max-w-[92vw] bg-card border-l border-border shadow-xl flex flex-col pointer-events-auto"
      >
        <ThreadsList data-offer="app/chats.closePanel"
          onPicked={onClose}
          onFocusComposer={focusComposer}
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
export function ChatsSidebarView() {
  // no hide button of its own: the title bar's Chats button and Ctrl+Shift+B hide it.
  return (
    <aside data-el="chats-sidebar" className="h-full w-full min-w-0 bg-background flex flex-col border-l border-border">
      <ThreadsList data-offer="box:workspace.chatSidebar" onFocusComposer={focusComposer} trailing={null} />
    </aside>
  );
}

/**
 * The left panel (src/threads.ts panelModel): "New chat" (with the surface's close / hide at its right end), the
 * chats without a project (the model's "main" place) listed flush, always shown, then a line, the projects under a
 * small "Projects" label and "New project". Each project is a place that opens into its chats, newest first — the
 * place Carl is in is open, the rest are shut until he asks. Nothing else: no older chats (their files stay on disk; the agent reads them with
 * its tools), no memory viewer (memory works behind the scenes; Carl: "if there is a failure, i will
 * tell you to fix it").
 */
export function ThreadsList({
  onPicked,
  onFocusComposer,
  trailing,
}: {
  /** after a thread is picked or started (the overlay closes; the sidebar stays) */
  onPicked?: () => void;
  onFocusComposer?: () => void;
  /** the top line's last control: close (overlay) or hide (sidebar) */
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
    // The new chat is the docked panel's (src/chatDock.ts): it opens.
    openChatDock();
    setTimeout(() => onFocusComposer?.(), 0);
  };
  const open = (id: string, title?: string) => {
    openThread(id, title);
    // The list shows without the docked chat panel (Ctrl+Shift+C); a chat picked then opens there.
    openChatDock();
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
      <div className="flex items-center gap-1 pl-2 pr-1.5 pt-2 pb-1 shrink-0">
        <button data-offer="app/chats.newChat"
          data-el="chats-new-chat"
          onClick={() => {
            newChatIn("main");
            focusChat();
          }}
          className="group/new flex-1 flex items-center gap-2 px-2 py-1.5 rounded-md text-[12.5px] font-medium text-foreground hover:bg-accent/60 min-w-0"
        >
          <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground group-hover/new:text-foreground" />
          New chat
        </button>
        {trailing}
      </div>

      <div className="flex-1 overflow-auto" data-el="threads">
        {/* The chats without a project: listed flush, always shown. */}
        <LooseChats entry={main} deleteOne={deleteOne} onOpenChat={(id, title) => open(id, title)} />
        <div className="mt-2 border-t border-border/60" />
        <div className={label} data-el="projects-label">
          Projects
        </div>
        {entries.map((e) =>
          e.type === "main" ? null : e.type === "new-project" ? (
            naming === null ? (
              <div key="new-project" className="px-2 pt-1 pb-2">
                <button data-offer="box:chats.openProject"
                  onClick={() => setNaming("")}
                  data-el="new-project"
                  className="w-full px-2 py-[5px] flex items-center gap-2 rounded-md text-[11.5px] text-muted-foreground/80 hover:text-foreground hover:bg-accent/60"
                >
                  <FolderPlus className="h-3 w-3 shrink-0" />
                  New project
                </button>
              </div>
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
                newChatIn(e.slug);
                focusChat();
              }}
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
 * The chats without a project (the model's "main" place), under "New chat": no bar of their own, never collapsed,
 * flush left, with the same Show more / Show all as a project's list.
 */
function LooseChats({
  entry,
  onOpenChat,
  deleteOne,
}: {
  entry: Extract<PanelEntry, { type: "main" }>;
  onOpenChat: (id: string, title: string) => void;
  deleteOne?: (id: string) => Promise<string | null>;
}) {
  const level = useChatLevel(entry.id);
  // Its Show more is forgotten when the list goes away (panel closed).
  useEffect(() => () => void chatLevels.delete(entry.id), [entry.id]);
  const vis = visibleChats(entry.chats, level);
  return (
    <div data-el="place-chat-list" data-place={entry.id}>
      {vis.shown.map((c) => (
        <ChatItem key={c.id} chat={c} loose onOpen={() => onOpenChat(c.id, c.title)} deleteOne={deleteOne} />
      ))}
      {vis.next && (
        <button data-offer="app/chats.showMore"
          data-el="place-show-more"
          data-place={entry.id}
          onClick={() => chatLevels.set(entry.id, nextChatLevel(entry.chats.length, level))}
          className={cn("w-[calc(100%-0.5rem)] text-left pl-3 py-1 text-[12px] text-muted-foreground/70 hover:text-foreground", ROW_INSET, ROW_SHAPE, ROW_HOVER)}
        >
          {vis.next === "more" ? "Show more" : "Show all"}
        </button>
      )}
    </div>
  );
}

/**
 * A project (a folder). At rest and on hover the bar shows only its chevron,
 * icon, name and "+" (Carl's option B, 2026-11-08: no hover icons): while the place works a small spinner takes
 * the icon's spot; finished unseen, a dot at the end. Right-click opens its menu: Rename (the row becomes its name,
 * Enter keeps it) and "Delete project…" (asked once, right under the row).
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
  onRename,
  onDelete,
  deleteOne,
}: {
  entry: Extract<PanelEntry, { type: "project" }>;
  name: string;
  /** Open one of the place's chats. */
  onOpenChat?: (id: string, title: string) => void;
  /** Start a fresh chat in this place. */
  onNewChat?: () => void;
  onRename?: (name: string) => Promise<void>;
  /** `folder`: Carl's second choice — the folder goes too. */
  onDelete?: (folder: boolean) => Promise<void>;
  /** Delete one chat (after its confirm) (src/chatDelete.ts). Null when done, else why not; none: no Delete. */
  deleteOne?: (id: string) => Promise<string | null>;
}) {
  const { active, running, unread } = entry;
  const chats = entry.chats;
  // Open where Carl is: a place he is in shows its chats; the others stay shut
  // until he asks. His own click wins over that, and is kept (src/placeOpen.ts):
  // closing the panel, the other list surface and a restart all keep it.
  const [opened, setOpened] = usePlaceOpen(entry.id);
  const shown = opened ?? active;
  // A place that closes, by his click or because he went elsewhere, also closes its "Show more":
  // it opens again at the short list (Carl, 2026-11-12).
  useEffect(() => {
    if (!shown) chatLevels.delete(entry.id);
  }, [shown, entry.id]);
  // And when the list itself goes away (panel closed). Only then: a level the agent set as it opened the place stays.
  useEffect(() => () => void chatLevels.delete(entry.id), [entry.id]);
  // A place's spinner shows only while it is collapsed: open, its own chats show theirs (Carl, 2026-11-10, 2026-11-12).
  const spinning = running && !shown;
  // One row is highlighted in the whole list: the open conversation's (Carl, 2026-11-24). This bar is it when the
  // project's own thread is open, or when the open chat is inside and the list is shut (the same roll-up as the
  // spinner); open, the chat's own row is the one.
  const selected = shown ? active && !chats.some((c) => c.active) : active;
  // How far its list is opened ("Show more" / "Show all"): session state, not saved (./view.ts, shared with the offers).
  const level = useChatLevel(entry.id);
  const vis = visibleChats(chats, level);
  const [menu, setMenu] = useState(false);
  const [mode, setMode] = useState<null | "rename" | "confirm">(null);
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const canEdit = !!(onRename || onDelete);
  const hasMenu = canEdit;
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
        <input data-offer="box:chats.openProject"
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
      data-el="thread-project"
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
      // The same padding in every state, so the "+" sits at one x on every row (Carl: it jumped left on a row
      // with unseen chats). A working place shows its spinner where its icon was; the unseen dot follows the name.
      className={cn("relative flex items-center gap-1 group pr-0.5", ROW_INSET, ROW_SHAPE, selected ? ROW_SELECTED : ROW_HOVER)}
    >
      <button data-offer="app/chats.expand"
        data-el="place-toggle"
        // Only shows or hides the chats: never opens the place or switches chat.
        onClick={() => setOpened(!shown)}
        aria-label={shown ? `Hide ${name}'s chats` : `Show ${name}'s chats`}
        aria-expanded={shown}
        className="flex-1 text-left px-3 py-1.5 gap-2 flex items-center min-w-0"
      >
        <span data-el="place-chats" className="shrink-0 -ml-2 mr-0.5 h-4 w-4 flex items-center justify-center rounded text-muted-foreground">
          <ChevronRight className={cn("h-3 w-3 transition-transform", shown && "rotate-90")} />
        </span>
        {spinning ? (
          <Spinner className="h-3 w-3" />
        ) : (
          <Folder className="h-3 w-3 text-muted-foreground shrink-0" />
        )}
        <span
          className={cn(
            "truncate flex-1 text-[12.5px]",
            selected ? "font-medium" : running || unread ? "text-foreground" : "text-foreground/80",
          )}
        >
          {name}
        </span>
        {!running && unread ? (
          <span className="shrink-0 h-1.5 w-1.5 rounded-full bg-primary" title="Done — unseen" role="img" aria-label="Done — unseen" />
        ) : null}
      </button>
      {hasMenu && menu && (
        <div ref={menuRef} data-el="project-menu-list" className={cn("absolute right-2 top-full -mt-1 z-30 min-w-[150px]", MENU_PANEL)}>
          {canEdit && (
            <>
              <MenuItem data-offer="box:chats.renameProject"
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
              <MenuItem data-offer="box:chats.deleteProject"
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
        <button data-offer="app/chats.newChat"
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
          <button data-offer="app/chats.showMore"
            data-el="place-show-more"
            data-place={entry.id}
            onClick={() => chatLevels.set(entry.id, nextChatLevel(chats.length, level))}
            className={cn("w-[calc(100%-0.5rem)] text-left pl-10 py-1 text-[12px] text-muted-foreground/70 hover:text-foreground", ROW_INSET, ROW_SHAPE, ROW_HOVER)}
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
    <button data-offer-exempt="a UI primitive: each use names its own offer"
      data-el={el}
      onClick={onClick}
      className={menuItemClass(danger)}
    >
      {children}
    </button>
  );
}

/**
 * One chat under its place. Nothing on hover (Carl's option B): a spinner at the right end while it works, the
 * dot when it finished unseen. Right-click: Rename (the row becomes its name) and Delete chat (asked once).
 */
/** `loose`: a chat without a project, flush left under "New chat" (a project's chats are indented under its bar). */
function ChatItem({ chat: c, loose, onOpen, deleteOne }: { chat: PanelChat; loose?: boolean; onOpen: () => void; deleteOne?: (id: string) => Promise<string | null> }) {
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
  // Keep the menu inside the row (the sidebar's width) and the window: shift it left, or above the click, when it
  // would spill past an edge and be clipped.
  useLayoutEffect(() => {
    const el = menuRef.current;
    const row = el?.parentElement;
    if (!menu || !el || !row) return;
    const r = row.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const right = Math.min(r.right, window.innerWidth) - 4;
    el.style.left = `${Math.max(4, Math.min(menu.x, right - r.left - w))}px`;
    el.style.top = r.top + menu.y + 4 + h > window.innerHeight - 4 ? `${menu.y - h - 4}px` : `${menu.y + 4}px`;
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
      <div className={cn(loose ? "pl-2" : "pl-9", "pr-3 py-0.5")} data-el="chat-rename" data-chat={c.id}>
        <input data-offer="box:chats.rename"
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
        className={cn("relative group/chat", ROW_INSET)}
        {...press}
        onContextMenu={
          hasMenu
            ? (ev) => {
                ev.preventDefault();
                const box = ev.currentTarget.getBoundingClientRect();
                setMenu({ x: ev.clientX - box.left, y: ev.clientY - box.top });
              }
            : undefined
        }
      >
        <button data-offer="app/chats.open"
          data-el="place-chat"
          data-chat={c.id}
          onClick={onOpen}
          className={cn(
            "relative w-full text-left py-1 flex items-center gap-2 text-[12px] min-w-0",
            // Room at the right only for what is there: the spinner while it works, the dot when unseen.
            loose ? "pl-3" : "pl-10",
            c.running || c.unread ? "pr-6" : "pr-2",
            ROW_SHAPE,
            c.active ? cn(ROW_SELECTED, "font-medium") : cn(ROW_HOVER, "text-foreground/75"),
          )}
        >
          <span className="truncate flex-1">{c.title}</span>
          {c.running ? (
            <span className="absolute right-2.5 top-1/2 -translate-y-1/2 inline-flex">
              <Spinner className="h-2.5 w-2.5" />
            </span>
          ) : c.unread ? (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 h-1.5 w-1.5 rounded-full bg-primary" title="Done — unseen" role="img" aria-label="Done — unseen" />
          ) : null}
        </button>
        {menu && (
          <div
            ref={menuRef}
            data-el="chat-menu"
            style={{ left: menu.x, top: menu.y + 4 }}
            className={cn("absolute z-30 min-w-[150px]", MENU_PANEL)}
          >
            <MenuItem data-offer="box:chats.rename"
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
                <MenuItem data-offer="box:chats.delete"
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
        {err && !confirm && <div className={cn(loose ? "pl-4" : "pl-11", "pr-3 pb-1 text-[11px] text-destructive")}>Not renamed: {err}</div>}
      </div>
      {confirm && (
        <div data-el="chat-delete-confirm" data-chat={c.id} className={cn(loose ? "ml-2" : "ml-9", "mr-3 my-1 px-3 py-2 rounded-md border border-border bg-muted/40 text-[12px]")}>
          <div className="text-foreground/90 leading-snug">
            Delete <span className="font-medium">{c.title}</span>? The agent can bring it back if you ask.
          </div>
          {err && <div className="mt-1 text-destructive text-[11.5px]">Not deleted: {err}</div>}
          <div className="mt-2 flex justify-end gap-1">
            <button data-offer="box:chats.delete" data-el="chat-delete-cancel" disabled={busy} onClick={() => setConfirm(false)} className="h-6 px-2.5 rounded text-[11.5px] text-muted-foreground hover:bg-accent hover:text-foreground">
              Cancel
            </button>
            <button data-offer="box:chats.delete" data-el="chat-delete-yes" disabled={busy} autoFocus onClick={() => void yes()} className="h-6 px-2.5 rounded text-[11.5px] text-destructive hover:bg-destructive/10 disabled:opacity-60">
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
        <button data-offer="box:chats.deleteProject" data-el="project-delete-yes" disabled={busy} autoFocus onClick={() => onYes(false)} className="min-h-6 py-1 px-2 rounded text-left leading-snug text-[11.5px] hover:bg-accent disabled:opacity-60">
          Remove the conversation, keep the folder
        </button>
        <button data-offer="box:chats.deleteProject" data-el="project-delete-everything" disabled={busy} onClick={() => onYes(true)} className="min-h-6 py-1 px-2 rounded text-left leading-snug text-[11.5px] text-destructive hover:bg-accent disabled:opacity-60">
          Delete everything, the folder too
        </button>
      </div>
      <div className="mt-1 flex justify-end">
        <button data-offer="box:chats.deleteProject" data-el="project-delete-cancel" disabled={busy} onClick={onCancel} className="h-6 px-2.5 rounded text-[11.5px] text-muted-foreground hover:bg-accent hover:text-foreground">
          {busy ? "Deleting…" : "Cancel"}
        </button>
      </div>
    </div>
  );
}
