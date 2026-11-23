// The chat pane's header (app/chat): the chat's name (and its project), the total cost when that is shown here, and the
// ⋯ menu: Memory (one entry: Main's memory, or the project's memory for a project's thread or a chat in a project), then
// the entries vault plugins put there (api.host.chat.menuItem, src/chatMenuItems.ts). Docked, it is a slim row at the top
// of the pane (DockHeader); in fullscreen chat and the popout it sits in the window's own top bar (BarTitle).
import { useEffect, useRef, useSyncExternalStore } from "react";
import { BookOpen, MoreHorizontal } from "lucide-react";
import { useStore } from "../../store";
import { useProjects } from "../../ProjectChip";
import { projectName } from "../../projects";
import { uiChoice } from "../../uiChoices";
import { formatCost } from "../../ongoingWork";
import { chatMenuItems, subscribeChatMenuItems } from "../../chatMenuItems";
import { emitChatEvent, memoryTarget, openChatMemory, setMenuOpen, useChatMenu } from "./model";

function useTitle(): { title: string; project: string } {
  const conv = useStore((s) => s.conversations.find((c) => c.id === s.activeConversationId));
  const projects = useProjects();
  // A project's own thread is named after the project already.
  const project = conv?.project && conv.kind !== "project" ? projectName(conv.project, projects) : "";
  return { title: conv?.title || "New chat", project };
}

function useTotalCost(): string | undefined {
  const cost = useStore((s) => {
    if (uiChoice("cost") !== "total") return undefined;
    const c = s.conversations.find((x) => x.id === s.activeConversationId);
    return c?.costUsd ?? s.messages.reduce((n, m) => n + (m.costUsd ?? m.usage?.costUsd ?? 0), 0);
  });
  return formatCost(cost);
}

/** The ⋯ button and its menu. `align`: which edge of the button the menu lines up with. */
export function ChatMenu({ align = "right" }: { align?: "left" | "right" }) {
  const open = useChatMenu((s) => s.open);
  const items = useSyncExternalStore(subscribeChatMenuItems, chatMenuItems, chatMenuItems);
  const projects = useProjects();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const names = (slug: string) => projectName(slug, projects);
  const mem = memoryTarget(names);
  const row = "flex items-center gap-2 w-full text-left px-3 py-1.5 text-[12px] hover:bg-accent transition-colors";
  return (
    <div className="relative pointer-events-auto" ref={ref}>
      <button data-offer="app/chat.openMenu"
        type="button"
        data-el="chat-menu-button"
        aria-label="Chat menu"
        aria-expanded={open}
        onClick={() => setMenuOpen(!open)}
        className={`h-6 w-6 flex items-center justify-center rounded hover:bg-accent/60 ${open ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}
        title="More: Memory and more"
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div data-el="chat-menu" className={`absolute top-full mt-1 ${align === "right" ? "right-0" : "left-0"} w-56 rounded-lg border border-border bg-card shadow-lg z-50 py-1`}>
          <button data-offer="app/chat.openMemory"
            type="button"
            data-el="chat-menu-memory"
            className={row}
            title={mem.kind === "main" ? "Open the agent's memory (.vault-chat/MEMORY.md)" : `Open ${mem.name}'s memory: what the agent keeps for this project`}
            onClick={() => void openChatMemory(names)}
          >
            <BookOpen className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="flex-1 truncate">Memory</span>
            {mem.kind === "project" && <span className="text-[11px] text-muted-foreground truncate max-w-[45%]">{mem.name}</span>}
          </button>
          {items.length > 0 && <div className="my-1 h-px bg-border/60" />}
          {items.map((i) => (
            <button data-offer="app/chat.clickItem"
              key={i.key}
              type="button"
              data-el="chat-menu-item"
              data-item={i.key}
              className={row}
              title={i.title}
              onClick={() => {
                setMenuOpen(false);
                i.onClick();
                emitChatEvent("itemClicked", { key: i.key, by: i.by });
              }}
            >
              <span className="flex-1 truncate">{i.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The docked pane's header: a slim row, the chat's name on the left, the cost and ⋯ on the right. */
export function DockHeader() {
  const { title, project } = useTitle();
  const cost = useTotalCost();
  return (
    <div data-el="chat-header" className="shrink-0 h-8 px-3 flex items-center gap-2">
      <div className="flex-1 min-w-0 flex items-baseline gap-1.5 text-[12px]" data-el="chat-header-title">
        <span className="text-foreground/80 truncate">{title}</span>
        {project && <span className="text-muted-foreground truncate">· {project}</span>}
      </div>
      {cost && (
        <span className="text-[11px] text-muted-foreground tabular-nums" data-el="total-cost" title="What this conversation has cost so far">
          {cost}
        </span>
      )}
      <ChatMenu />
    </div>
  );
}

/** Fullscreen chat's (and the popout's) top bar: the chat's name, then " · <project>" only when the chat is in one, then ⋯. */
export function BarTitle() {
  const { title, project } = useTitle();
  return (
    <div data-el="chat-header" className="flex items-center gap-1 min-w-0 max-w-[60%]">
      <div data-el="chat-title" className="flex items-baseline gap-1.5 min-w-0 text-[12px]">
        <span className="text-foreground/85 truncate">{title}</span>
        {project && <span className="text-muted-foreground truncate">· {project}</span>}
      </div>
      <ChatMenu align="left" />
    </div>
  );
}
