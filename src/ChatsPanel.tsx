import { useEffect, useMemo, useRef, useState } from "react";
import { MessageSquare, Plus, X as XIcon, Folder, PanelLeftClose, FileText, Home } from "lucide-react";
import { useStore } from "./store";
import { useProjects } from "./ProjectChip";
import { createProjectThread, openProjectNotes, openThread, projectName } from "./projects";
import { panelModel, type PanelEntry } from "./threads";
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
    setNaming(null);
    const r = await createProjectThread(name);
    if (!r.ok) {
      setErr(r.error);
      return;
    }
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
              // Name it here: Enter makes the project and opens its thread.
              <div key="new-project" className="px-4 pt-2 pb-1">
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
              name={projectName(e.slug, projects) || e.title}
              onSelect={() => open(e.id, e.title)}
              onNotes={() => void openProjectNotes(e.slug, e.title).then(() => onPicked?.())}
            />
          ),
        )}
        {err && <div className="px-4 py-1 text-[11px] text-destructive">{err}</div>}
      </div>
    </>
  );
}

/** Main (a home, a stronger name) or a project's thread (a folder): a dot while it works (pulsing) or when it finished unseen. */
function ThreadRow({ entry, name, onSelect, onNotes }: { entry: Extract<PanelEntry, { type: "main" | "project" }>; name: string; onSelect: () => void; onNotes?: () => void }) {
  const { active, running, unread } = entry;
  const isMain = entry.type === "main";
  return (
    <div
      data-el={isMain ? "thread-main" : "thread-project"}
      data-thread={entry.id}
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
