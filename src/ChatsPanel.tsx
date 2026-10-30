import { useEffect, useMemo, useRef, useState } from "react";
import { MessageSquare, Plus, X as XIcon, Folder, PanelLeftClose, FileText, Home, MoreHorizontal } from "lucide-react";
import { useStore } from "./store";
import { useProjects } from "./ProjectChip";
import { createProjectThread, deleteProject, openProjectNotes, openThread, projectName, renameProject } from "./projects";
import { panelModel, type PanelEntry } from "./threads";
import { cn } from "./lib/utils";
import { NewProjectForm } from "./NewProjectForm";

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
 * The left panel (src/threads.ts panelModel): Main on its own at the top, then the projects under a
 * small "Projects" label (each opens its one thread) and "+ New project". Nothing else: no older chats
 * (their files stay on disk; the agent reads them with its tools), no separate chats, no memory viewer
 * (memory works behind the scenes; Carl: "if there is a failure, i will tell you to fix it").
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
        conversations.map((c) => ({ id: c.id, title: c.title, kind: c.kind, lastActivityAt: c.lastActivityAt, running: c.status === "running", unread: c.unread })),
        projects,
        activeId,
      ),
    [conversations, projects, activeId],
  );
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
          <ThreadRow entry={main} name="Main" onSelect={() => open(main.id, main.title)} />
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
              onSelect={() => open(e.id, e.title)}
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
 * Main (a home, a stronger name) or a project's thread (a folder): a dot while it works (pulsing) or when it
 * finished unseen. A project's row has a ⋯ menu (also on right-click): Rename (the row becomes its name, Enter
 * keeps it) and Delete (asked once, right under the row). Main has none: it can't be renamed or deleted.
 */
export function ThreadRow({
  entry,
  name,
  onSelect,
  onNotes,
  onRename,
  onDelete,
}: {
  entry: Extract<PanelEntry, { type: "main" | "project" }>;
  name: string;
  onSelect: () => void;
  onNotes?: () => void;
  onRename?: (name: string) => Promise<void>;
  /** `folder`: Carl's second choice — the folder goes too. */
  onDelete?: (folder: boolean) => Promise<void>;
}) {
  const { active, running, unread } = entry;
  const isMain = entry.type === "main";
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
      className={cn("relative flex items-center gap-1 group", active ? "bg-accent" : "hover:bg-accent/40")}
    >
      <button onClick={onSelect} className={cn("flex-1 text-left px-4 flex items-center min-w-0", isMain ? "py-2 gap-2.5" : "py-1.5 gap-2")}>
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
          <span className="relative inline-flex h-1.5 w-1.5 shrink-0" title="Working…">
            <span className="absolute inset-0 rounded-full bg-foreground opacity-60 animate-ping" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-foreground" />
          </span>
        ) : unread ? (
          <span className="h-1.5 w-1.5 rounded-full bg-primary shrink-0" title="Done — unseen" />
        ) : null}
      </button>
      {onNotes && (
        <button
          onClick={onNotes}
          data-el="project-notes"
          className="opacity-0 group-hover:opacity-100 transition-opacity h-7 w-7 mr-2 flex items-center justify-center rounded text-muted-foreground hover:bg-accent/60 hover:text-foreground shrink-0"
          title="Project notes"
        >
          <FileText className="h-3 w-3" />
        </button>
      )}
      {hasMenu && (
        <div ref={menuRef} className="relative shrink-0 mr-2">
          <button
            onClick={() => setMenu((m) => !m)}
            data-el="project-menu"
            className={cn(
              "transition-opacity h-7 w-7 flex items-center justify-center rounded text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              menu ? "opacity-100 bg-accent/60" : "opacity-0 group-hover:opacity-100",
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
    </div>
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

/** Delete, asked once, right under the project's row: the conversation only (the folder stays, a plain folder again),
 *  or everything (the folder too). Nothing is lost for good: git keeps a copy. */
export function DeleteProjectConfirm({ name, busy, onCancel, onYes }: { name: string; busy: boolean; onCancel: () => void; onYes: (folder: boolean) => void }) {
  return (
    <div data-el="project-delete-confirm" className="mx-3 mb-1.5 mt-0.5 px-3 py-2 rounded-md border border-border bg-muted/40 text-[12px]">
      <div className="text-foreground/90 leading-snug">
        Delete project <span className="font-medium">{name}</span>? Git keeps a copy either way.
      </div>
      <div className="mt-2 flex flex-col gap-1">
        <button data-el="project-delete-yes" disabled={busy} autoFocus onClick={() => onYes(false)} className="h-6 px-2 rounded text-left text-[11.5px] hover:bg-accent disabled:opacity-60">
          Remove the conversation, keep the folder
        </button>
        <button data-el="project-delete-everything" disabled={busy} onClick={() => onYes(true)} className="h-6 px-2 rounded text-left text-[11.5px] text-destructive hover:bg-accent disabled:opacity-60">
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
