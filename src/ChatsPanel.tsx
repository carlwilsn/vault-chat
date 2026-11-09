import { useEffect, useMemo, useRef, useState } from "react";
import { MessageSquare, Plus, X as XIcon, Folder, PanelLeftClose, FileText, Home, MoreHorizontal, ChevronRight, Trash2, Check, ListChecks } from "lucide-react";
import { useStore } from "./store";
import { useProjects } from "./ProjectChip";
import { createProjectThread, deleteProject, newChatInProject, openProjectNotes, openThread, projectName, renameProject } from "./projects";
import { panelModel, type PanelChat, type PanelEntry } from "./threads";
import { canDeleteChat, deleteChats } from "./chatDelete";
import { cn } from "./lib/utils";
import { NewProjectForm } from "./NewProjectForm";
import { placeOpen, usePlaceOpen, usePlaceOpenVersion } from "./placeOpen";

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
  // Multi-select (Carl clears out old chats in bulk): a click picks a row; the bar at the bottom deletes them.
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const stopPicking = () => {
    setPicking(false);
    setPicked(new Set());
    setBulkConfirm(false);
  };
  const select: ChatSelect = {
    on: picking,
    picked,
    toggle: (id) =>
      setPicked((p) => {
        const n = new Set(p);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        return n;
      }),
    start: (id) => {
      setPicking(true);
      setPicked(new Set([id]));
    },
    deleteOne: (id) => deleteChats([id]),
  };
  // "Select all": every chat that can go in the places that are open on screen (a shut place's chats are
  // never picked unseen).
  const vault = useStore((s) => s.vaultPath);
  usePlaceOpenVersion();
  const allDeletable = entries
    .flatMap((e) => (e.type === "new-project" || !(placeOpen(vault, e.id) ?? e.active) ? [] : e.chats.map((c) => c.id)))
    .filter(canDeleteChat);
  const deletePicked = async () => {
    setBulkBusy(true);
    const why = await deleteChats([...picked]);
    setBulkBusy(false);
    if (why) setErr(`Not deleted: ${why}`);
    else {
      setErr(null);
      stopPicking();
    }
  };

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
          <button
            onClick={() => (picking ? stopPicking() : setPicking(true))}
            data-el="chats-select"
            aria-pressed={picking}
            className={cn("h-7 px-1.5 flex items-center gap-1 rounded text-[11.5px] hover:bg-accent/60", picking ? "text-foreground bg-accent/60" : "text-muted-foreground hover:text-foreground")}
            title={picking ? "Done selecting" : "Select chats to delete"}
          >
            <ListChecks className="h-3.5 w-3.5" />
            {picking && <span>Done</span>}
          </button>
          {trailing}
        </div>
      </div>

      <div className="flex-1 overflow-auto" data-el="threads">
        {/* Main: the one conversation, on its own. */}
        <div className="py-1.5">
          <ThreadRow
            entry={main}
            name="Main"
            select={select}
            onOpenChat={(id, title) => open(id, title)}
            onNewChat={() => {
              useStore.getState().newConversation();
              focusChat();
            }}
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
              select={select}
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
      {picking && (
        <div data-el="chats-select-bar" className="shrink-0 border-t border-border/60 px-3 py-2 text-[12px] bg-card">
          {bulkConfirm ? (
            <div data-el="chats-bulk-confirm">
              <div className="text-foreground/90 leading-snug">
                Delete {picked.size} chat{picked.size === 1 ? "" : "s"}? The agent can bring them back if you ask.
              </div>
              <div className="mt-2 flex justify-end gap-1">
                <button data-el="chats-bulk-cancel" disabled={bulkBusy} onClick={() => setBulkConfirm(false)} className="h-6 px-2.5 rounded text-[11.5px] text-muted-foreground hover:bg-accent hover:text-foreground">
                  Cancel
                </button>
                <button data-el="chats-bulk-yes" disabled={bulkBusy} autoFocus onClick={() => void deletePicked()} className="h-6 px-2.5 rounded text-[11.5px] text-destructive hover:bg-destructive/10 disabled:opacity-60">
                  {bulkBusy ? "Deleting…" : `Delete ${picked.size}`}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-1">
              <span className="text-muted-foreground flex-1" data-el="chats-picked-count">
                {picked.size} selected
              </span>
              <button
                data-el="chats-select-all"
                onClick={() => setPicked(picked.size === allDeletable.length ? new Set() : new Set(allDeletable))}
                className="h-6 px-2 rounded text-[11.5px] text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                {picked.size === allDeletable.length && picked.size > 0 ? "Select none" : "Select all"}
              </button>
              <button
                data-el="chats-bulk-delete"
                disabled={!picked.size}
                onClick={() => setBulkConfirm(true)}
                className="h-6 px-2 rounded text-[11.5px] text-destructive hover:bg-destructive/10 disabled:opacity-40 disabled:hover:bg-transparent"
              >
                Delete
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

/**
 * Main (a home, a stronger name) or a project's thread (a folder): a dot while it works (pulsing) or when it
 * finished unseen. A project's row has a ⋯ menu (also on right-click): Rename (the row becomes its name, Enter
 * keeps it) and Delete (asked once, right under the row). Main has none: it can't be renamed or deleted.
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
  select,
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
  /** Delete and multi-select on the chats (src/chatDelete.ts); none: the rows are plain. */
  select?: ChatSelect;
}) {
  const { active, running, unread } = entry;
  const isMain = entry.type === "main";
  const chats = entry.chats;
  // Open where Carl is: a place he is in shows its chats; the others stay shut
  // until he asks. His own click wins over that, and is kept (src/placeOpen.ts):
  // closing the panel, the other list surface and a restart all keep it.
  const [opened, setOpened] = usePlaceOpen(entry.id);
  const shown = opened ?? active;
  const [menu, setMenu] = useState(false);
  const [mode, setMode] = useState<null | "rename" | "confirm">(null);
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const hasMenu = !isMain && !!(onRename || onDelete);
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
      onContextMenu={
        hasMenu
          ? (ev) => {
              ev.preventDefault();
              setMenu(true);
            }
          : undefined
      }
      // Keep a fixed trailing status gutter; hover actions must not push the dot into the name column.
      className={cn("relative flex items-center gap-1 pr-7 group", active ? "bg-accent" : "hover:bg-accent/40")}
    >
      <button
        data-el="place-toggle"
        // Only shows or hides the chats: never opens the place or switches chat.
        onClick={() => setOpened(!shown)}
        aria-label={shown ? `Hide ${name}'s chats` : `Show ${name}'s chats`}
        aria-expanded={shown}
        className={cn("flex-1 text-left px-4 flex items-center min-w-0", isMain ? "py-2 gap-2.5" : "py-1.5 gap-2")}
      >
        <span data-el="place-chats" className="shrink-0 -ml-2 mr-0.5 h-4 w-4 flex items-center justify-center rounded text-muted-foreground">
          <ChevronRight className={cn("h-3 w-3 transition-transform", shown && "rotate-90")} />
        </span>
        {isMain ? <Home className="h-3.5 w-3.5 text-foreground/80 shrink-0" /> : <Folder className="h-3 w-3 text-muted-foreground shrink-0" />}
        <span
          className={cn(
            "truncate flex-1",
            isMain ? "text-[13px] font-semibold text-foreground" : cn("text-[12.5px]", active ? "text-foreground font-medium" : running || unread ? "text-foreground" : "text-foreground/80"),
          )}
        >
          {name}
        </span>
        {running ? (
          <span className="absolute right-4 top-1/2 -translate-y-1/2 inline-flex h-1.5 w-1.5" title="Working…" role="img" aria-label="Working…">
            <span className="absolute inset-0 rounded-full bg-foreground opacity-60 animate-ping" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-foreground" />
          </span>
        ) : unread ? (
          <span className="absolute right-4 top-1/2 -translate-y-1/2 h-1.5 w-1.5 rounded-full bg-primary" title="Done — unseen" role="img" aria-label="Done — unseen" />
        ) : null}
      </button>
      {onNotes && (
        <button
          onClick={onNotes}
          data-el="project-notes"
          className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity h-7 w-7 min-h-[28px] min-w-[28px] flex items-center justify-center rounded text-muted-foreground hover:bg-accent/60 hover:text-foreground shrink-0"
          title="Project notes"
        >
          <FileText className="h-3 w-3" />
        </button>
      )}
      {hasMenu && (
        <div ref={menuRef} className="relative shrink-0">
          <button
            onClick={() => setMenu((m) => !m)}
            data-el="project-menu"
            className={cn(
              "transition-opacity h-7 w-7 min-h-[28px] min-w-[28px] flex items-center justify-center rounded text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              menu ? "opacity-100 bg-accent/60" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
            )}
            title="More"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
          {menu && (
            <div data-el="project-menu-list" className="absolute right-0 top-8 z-30 min-w-[128px] py-1 rounded-md border border-border bg-popover shadow-md text-[12.5px]">
              <button
                data-el="project-rename-item"
                className="w-full text-left px-3 py-1.5 hover:bg-accent"
                onClick={() => {
                  setMenu(false);
                  setDraft(name);
                  setMode("rename");
                }}
              >
                Rename
              </button>
              <button
                data-el="project-delete-item"
                className="w-full text-left px-3 py-1.5 text-destructive hover:bg-destructive/10"
                onClick={() => {
                  setMenu(false);
                  setMode("confirm");
                }}
              >
                Delete
              </button>
            </div>
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
        {chats.map((c) => (
          <ChatItem key={c.id} chat={c} onOpen={() => onOpenChat?.(c.id, c.title)} select={select} />
        ))}
        {chats.length === 0 && <div className="pl-11 pr-4 py-1 text-[11.5px] text-muted-foreground/60">No chats yet</div>}
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

/** What the chats list shares with each chat row for Delete and multi-select. */
export type ChatSelect = {
  /** Multi-select is on: a click picks the row instead of opening it. */
  on: boolean;
  picked: ReadonlySet<string>;
  toggle: (id: string) => void;
  /** Turn multi-select on with this chat picked (a row's menu: Select). */
  start: (id: string) => void;
  /** Delete one chat (after its confirm). Null when done, else why not. */
  deleteOne: (id: string) => Promise<string | null>;
};

/**
 * One chat in a place's list: opens it on click. On hover a trash button (and on right-click a small menu:
 * Delete…, Select) asks once, right under the row, before it goes. In multi-select a click picks the row.
 * Main and a project's own thread have no Delete (src/chatDelete.ts canDeleteChat).
 */
function ChatItem({ chat: c, onOpen, select }: { chat: PanelChat; onOpen: () => void; select?: ChatSelect }) {
  const [confirm, setConfirm] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const deletable = !!select && canDeleteChat(c.id);
  const picking = !!select?.on;
  const picked = !!select?.picked.has(c.id);
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
  const yes = async () => {
    if (!select) return;
    setBusy(true);
    const why = await select.deleteOne(c.id);
    setBusy(false);
    setErr(why);
    if (!why) setConfirm(false);
  };
  return (
    <>
      <div
        className="relative group/chat"
        onContextMenu={
          deletable && !picking
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
          aria-pressed={picking && deletable ? picked : undefined}
          onClick={() => (picking ? deletable && select!.toggle(c.id) : onOpen())}
          className={cn(
            "relative w-full text-left pl-11 pr-7 py-1 flex items-center gap-2 text-[12px] min-w-0",
            picking && picked ? "bg-primary/15 text-foreground" : c.active ? "bg-accent text-foreground font-medium" : "hover:bg-accent/40 text-foreground/75",
            picking && !deletable && "opacity-50",
          )}
        >
          {picking && (
            <span
              data-el="chat-pick"
              className={cn(
                "absolute left-5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 rounded-[3px] border flex items-center justify-center",
                picked ? "bg-primary border-primary text-primary-foreground" : "border-muted-foreground/50",
                !deletable && "invisible",
              )}
            >
              {picked && <Check className="h-2.5 w-2.5" />}
            </span>
          )}
          <span className="truncate flex-1">{c.title}</span>
          {c.running ? (
            <span className={cn("absolute right-4 top-1/2 -translate-y-1/2 inline-flex h-1.5 w-1.5", deletable && !picking && "group-hover/chat:opacity-0")} title="Working…" role="img" aria-label="Working…">
              <span className="absolute inset-0 rounded-full bg-foreground opacity-60 animate-ping" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-foreground" />
            </span>
          ) : c.unread ? (
            <span className={cn("absolute right-4 top-1/2 -translate-y-1/2 h-1.5 w-1.5 rounded-full bg-primary", deletable && !picking && "group-hover/chat:opacity-0")} title="Done — unseen" role="img" aria-label="Done — unseen" />
          ) : null}
        </button>
        {deletable && !picking && (
          <button
            data-el="chat-delete"
            data-chat={c.id}
            onClick={() => setConfirm(true)}
            title="Delete chat"
            aria-label={`Delete ${c.title}`}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 h-5 w-5 flex items-center justify-center rounded text-muted-foreground hover:text-destructive hover:bg-accent/60 opacity-0 group-hover/chat:opacity-100 focus:opacity-100 transition-opacity"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
        {menu && (
          <div
            ref={menuRef}
            data-el="chat-menu"
            style={{ left: Math.max(24, menu.x), top: menu.y + 4 }}
            className="absolute z-30 min-w-[120px] py-1 rounded-md border border-border bg-popover shadow-md text-[12.5px]"
          >
            <button
              data-el="chat-menu-delete"
              className="w-full text-left px-3 py-1.5 text-destructive hover:bg-destructive/10"
              onClick={() => {
                setMenu(null);
                setConfirm(true);
              }}
            >
              Delete…
            </button>
            <button
              data-el="chat-menu-select"
              className="w-full text-left px-3 py-1.5 hover:bg-accent"
              onClick={() => {
                setMenu(null);
                select!.start(c.id);
              }}
            >
              Select
            </button>
          </div>
        )}
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
