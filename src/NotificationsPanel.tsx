// The one in-app notification list, behind the bell in the titlebar (where
// Mission Control's rocket was). Questions, finished work and failures; a row
// opens its conversation. Two frames while Carl picks
// (localStorage `vc_notif_style`): "popover" under the bell (default), or
// "panel", the Chats panel's right-hand sheet.
import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, Check, AlertTriangle, HelpCircle, X as XIcon } from "lucide-react";
import { useStore } from "./store";
import { cn } from "./lib/utils";
import { readNotifications, markNotificationRead, type Notification, type NotifKind } from "./notifications";
import { relativeTime } from "./ChatsPanel";

const POLL_MS = 15_000;

function notifStyle(): "popover" | "panel" {
  try {
    return localStorage.getItem("vc_notif_style") === "panel" ? "panel" : "popover";
  } catch {
    return "popover";
  }
}

/** The feed, refreshed on an interval and on demand. */
function useNotifications(): { list: Notification[]; refresh: () => void } {
  const vaultPath = useStore((s) => s.vaultPath);
  const [list, setList] = useState<Notification[]>([]);
  const refresh = useCallback(() => {
    if (!vaultPath) return;
    void readNotifications(vaultPath)
      .then(setList)
      .catch(() => {});
  }, [vaultPath]);
  useEffect(() => {
    setList([]);
    refresh();
    const id = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);
  return { list, refresh };
}

function KindIcon({ kind }: { kind: NotifKind }) {
  const cls = "h-3.5 w-3.5 shrink-0 mt-[1px]";
  if (kind === "question") return <HelpCircle className={cn(cls, "text-foreground/80")} />;
  if (kind === "done") return <Check className={cn(cls, "text-emerald-500")} />;
  if (kind === "failed") return <AlertTriangle className={cn(cls, "text-destructive")} />;
  return <Bell className={cn(cls, "text-muted-foreground")} />;
}

function NotifRow({ n, onOpen }: { n: Notification; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className={cn(
        "w-full text-left px-3 py-2.5 flex items-start gap-2.5 border-b border-border/40 hover:bg-accent/40",
        !n.convId && "cursor-default",
      )}
      title={n.convId ? "Open the conversation" : undefined}
    >
      <KindIcon kind={n.kind} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className={cn("text-[12.5px] truncate flex-1", n.read ? "text-muted-foreground" : "text-foreground")}>
            {n.title || "Notification"}
          </span>
          {!n.read && <span className="h-1.5 w-1.5 rounded-full bg-primary shrink-0" />}
          <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">{relativeTime(n.ts)}</span>
        </span>
        {(n.answeredWith || n.body) && (
          <span className="block text-[10.5px] text-muted-foreground truncate mt-0.5">
            {n.answeredWith ? `Answered: ${n.answeredWith}` : n.body}
          </span>
        )}
      </span>
    </button>
  );
}

function List({ list, onOpen }: { list: Notification[]; onOpen: (n: Notification) => void }) {
  if (!list.length) {
    return <div className="px-4 py-6 text-center text-[12px] text-muted-foreground">Nothing yet. Questions, finished work and failures land here.</div>;
  }
  const unread = list.filter((n) => !n.read);
  const read = list.filter((n) => n.read);
  return (
    <>
      {unread.map((n) => (
        <NotifRow key={n.id} n={n} onOpen={() => onOpen(n)} />
      ))}
      {read.length > 0 && (
        <>
          <div className="px-3 pt-3 pb-1 text-[10.5px] uppercase tracking-wider text-muted-foreground/80 font-medium">Earlier</div>
          {read.map((n) => (
            <NotifRow key={n.id} n={n} onOpen={() => onOpen(n)} />
          ))}
        </>
      )}
    </>
  );
}

/** The bell button plus its list. */
export function NotificationsButton() {
  const vaultPath = useStore((s) => s.vaultPath);
  const { list, refresh } = useNotifications();
  const [open, setOpen] = useState(false);
  const [style] = useState(notifStyle);
  const ref = useRef<HTMLDivElement>(null);
  const unread = list.filter((n) => !n.read).length;

  useEffect(() => {
    if (!open) return;
    refresh();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    const t = window.setTimeout(() => window.addEventListener("mousedown", onDown), 0);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(t);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open, refresh]);

  const openOne = async (n: Notification) => {
    if (!vaultPath) return;
    if (!n.read) await markNotificationRead(vaultPath, n.id);
    refresh();
    if (!n.convId) return;
    const s = useStore.getState();
    if (s.conversations.some((c) => c.id === n.convId)) {
      s.selectConversation(n.convId);
      if (s.rightCollapsed) s.toggleRight();
      setOpen(false);
    }
  };

  const markAll = async () => {
    if (!vaultPath) return;
    await Promise.all(list.filter((n) => !n.read).map((n) => markNotificationRead(vaultPath, n.id)));
    refresh();
  };

  const header = (
    <div className="flex items-center justify-between px-3 py-2.5 border-b border-border/60">
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-semibold">Notifications</span>
        {unread > 0 && <span className="text-[11px] text-muted-foreground">{unread} new</span>}
      </div>
      <div className="flex items-center gap-1">
        {unread > 0 && (
          <button
            onClick={() => void markAll()}
            className="h-7 px-2 flex items-center gap-1 rounded hover:bg-accent/60 text-[11.5px] text-muted-foreground hover:text-foreground/90"
          >
            <Check className="h-3 w-3" />
            <span>Mark all read</span>
          </button>
        )}
        {style === "panel" && (
          <button
            onClick={() => setOpen(false)}
            className="h-7 w-7 flex items-center justify-center rounded hover:bg-accent/60 text-muted-foreground"
            title="Close (Esc)"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className={`h-7 w-7 flex items-center justify-center rounded relative ${
          open ? "bg-accent text-foreground" : "hover:bg-accent/60 text-muted-foreground"
        }`}
        title="Notifications"
      >
        <Bell className="h-3.5 w-3.5" />
        {unread > 0 && <span className="absolute top-0.5 right-0.5 h-1.5 w-1.5 rounded-full bg-primary" />}
      </button>
      {open && style === "popover" && (
        <div className="absolute top-full left-0 mt-1 w-[340px] max-h-[60vh] rounded-lg border border-border bg-card shadow-lg z-50 flex flex-col overflow-hidden">
          {header}
          <div className="flex-1 overflow-auto">
            <List list={list} onOpen={(n) => void openOne(n)} />
          </div>
        </div>
      )}
      {open && style === "panel" && (
        <div className="fixed inset-0 top-9 z-30 flex justify-end pointer-events-none">
          <div className="h-full w-[380px] max-w-[92vw] bg-card border-l border-border shadow-xl flex flex-col pointer-events-auto">
            {header}
            <div className="flex-1 overflow-auto">
              <List list={list} onOpen={(n) => void openOne(n)} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
