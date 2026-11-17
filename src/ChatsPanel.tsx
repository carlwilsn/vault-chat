// Where the chat list is mounted. The list is a plugin (src/plugins/chats, app/chats): the overlay with the app's
// overlays (ChatsPanel) and fullscreen chat's left sidebar (ChatsSidebar), through the plugin host and the supervisor's
// records (src/PluginMount.tsx AppPluginMount). The chat list is how Carl gets around, so it never just disappears:
// turned off, or failing to mount or render, a minimal built-in list stands in (ChatsFallback): Main and each project
// with their chats, a click opens one, and one line says what happened with Turn on / Reload.
import { useEffect, useMemo } from "react";
import { MessageSquare, X as XIcon, PanelLeftClose } from "lucide-react";
import { useStore } from "./store";
import { useProjects } from "./ProjectChip";
import { openThread } from "./projects";
import { panelModel } from "./threads";
import { CHATS_PLUGIN } from "./appPlugins";
import { AppPluginMount, type PluginFallbackInfo } from "./PluginMount";
import { PluginOff } from "./PluginOff";
import * as chatsPlugin from "./plugins/chats";

/** The overlay (the docked layout), shown while the chat pane's chats button has it open. */
export function ChatsPanel() {
  return <AppPluginMount plugin={CHATS_PLUGIN} module={chatsPlugin} fallback={(f) => <OverlayFallback info={f} />} />;
}

/** Fullscreen chat's (and the popout's) left sidebar. */
export function ChatsSidebar() {
  return <AppPluginMount plugin={CHATS_PLUGIN} module={chatsPlugin.sidebar} fallback={(f) => <SidebarFallback info={f} />} part="sidebar" />;
}

function OverlayFallback({ info }: { info: PluginFallbackInfo }) {
  const open = useStore((s) => s.showChatsPanel && !(s.chatFullscreen && !s.popoutOpen));
  const close = useMemo(() => () => useStore.getState().setShowChatsPanel(false), []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-30 flex justify-end pointer-events-none">
      <div className="h-full w-[380px] max-w-[92vw] bg-card border-l border-border shadow-xl flex flex-col pointer-events-auto">
        <ChatsFallback info={info} onPicked={close} trailing={<XIcon className="h-3.5 w-3.5" />} onTrailing={close} />
      </div>
    </div>
  );
}

function SidebarFallback({ info }: { info: PluginFallbackInfo }) {
  return (
    <aside data-el="chats-sidebar" className="h-full w-[272px] shrink-0 bg-background flex flex-col">
      <ChatsFallback info={info} trailing={<PanelLeftClose className="h-3.5 w-3.5" />} onTrailing={() => useStore.getState().toggleChatSidebar()} />
    </aside>
  );
}

/** The minimal built-in list: every place with its chats, a click opens one. No menus, no paging. */
export function ChatsFallback({ info, onPicked, trailing, onTrailing }: { info: PluginFallbackInfo; onPicked?: () => void; trailing: React.ReactNode; onTrailing: () => void }) {
  const conversations = useStore((s) => s.conversations);
  const activeId = useStore((s) => s.activeConversationId);
  const projects = useProjects();
  const places = useMemo(
    () =>
      panelModel(
        conversations.map((c) => ({ id: c.id, title: c.title, kind: c.kind, project: c.project, lastActivityAt: c.lastActivityAt, running: c.status === "running", unread: c.unread })),
        projects,
        activeId,
      ).entries.filter((e) => e.type !== "new-project"),
    [conversations, projects, activeId],
  );
  const open = (id: string, title?: string) => {
    openThread(id, title);
    onPicked?.();
  };
  return (
    <div data-el="chats-fallback" className="flex flex-col min-h-0 h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/60">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-[13px] font-semibold">Chats</span>
        </div>
        <button onClick={onTrailing} className="h-7 w-7 flex items-center justify-center rounded hover:bg-accent/60 text-muted-foreground">
          {trailing}
        </button>
      </div>
      {info.pending ? null : info.off ? (
        <PluginOff path={CHATS_PLUGIN.id} desired={info.off} />
      ) : (
        <div data-el="chats-fallback-error" className="flex items-center gap-2 px-3 py-2 text-[12px] text-muted-foreground">
          <span className="truncate" title={info.error ?? ""}>The chat list stopped; a plain list until it is back.</span>
          <button type="button" data-el="plugin-reload" onClick={info.retry} className="shrink-0 rounded-md border border-border/60 px-2 py-0.5 text-[11.5px] hover:text-foreground">
            Reload
          </button>
        </div>
      )}
      <div className="flex-1 overflow-auto py-1" data-el="threads">
        {places.map((p) => (
          <div key={p.id} data-el="fallback-place" data-place={p.id}>
            <button
              onClick={() => open(p.id, p.type === "main" ? "Main" : p.title)}
              className={`w-full text-left px-4 py-1.5 text-[12.5px] ${p.type === "main" ? "font-semibold" : ""} ${p.active ? "bg-accent" : "hover:bg-accent/40"}`}
            >
              {p.type === "main" ? "Main" : p.title}
            </button>
            {p.chats.map((c) => (
              <button
                key={c.id}
                data-el="place-chat"
                data-chat={c.id}
                onClick={() => open(c.id, c.title)}
                className={`w-full text-left pl-8 pr-3 py-1 text-[12px] truncate ${c.active ? "bg-accent text-foreground font-medium" : "hover:bg-accent/40 text-foreground/75"}`}
              >
                {c.title}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
