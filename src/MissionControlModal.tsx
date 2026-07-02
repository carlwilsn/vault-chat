import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Rocket,
  X as XIcon,
  ArrowLeft,
  ArrowUp,
  Square,
  ChevronRight,
  Plus,
  CheckCheck,
  Trash2,
  Check as CheckIcon,
  Archive as ArchiveIcon,
  CircleHelp,
  AlertTriangle,
  CheckCircle2,
  Info,
  ExternalLink,
} from "lucide-react";
import { useStore } from "./store";
import { conversationPreview, type Conversation } from "./conversations";
import { relativeTime } from "./ChatsPanel";
import { MessageBubble, ThinkingIndicator } from "./ChatPane";
import { sendMessage } from "./chat-controller";
import { abortRun } from "./runRegistry";
import { stopAndDeleteMission } from "./offVaultRun";
import { ListView as ScheduleListView, FormView as ScheduleFormView } from "./SchedulesPanel";
import { subscribeSchedules, saveSchedule, deleteSchedule, toggleSchedule } from "./schedulerLoop";
import { type Schedule, emptySchedule, nextFireAt } from "./schedules";
import {
  groupMissions,
  resolveMissionGroup,
  missionKeyOf,
  isFailish,
  missionRowState,
  buildDoneWhen,
  missionBriefText,
  useConvLiveState,
  readNotifications,
  markNotificationRead,
  hideNotification,
  markAllNotificationsRead,
  notificationMeta,
  type Notification,
  type MissionGroup,
  type DoneWhenItem,
} from "./missionControl";
import { Button, Textarea } from "./ui";
import { cn } from "./lib/utils";

type Tab = "missions" | "schedules" | "notifications";
type View = "list" | "mission" | "worker" | "alert" | "schedule-form";

type Props = { open: boolean; onClose: () => void };

export function MissionControlModal({ open, onClose }: Props) {
  const vaultPath = useStore((s) => s.vaultPath);
  const modelId = useStore((s) => s.modelId);
  const conversations = useStore((s) => s.conversations);

  const [tab, setTab] = useState<Tab>("missions");
  const [view, setView] = useState<View>("list");
  const [missionKey, setMissionKey] = useState<string | null>(null);
  const [workerId, setWorkerId] = useState<string | null>(null);
  const [alertId, setAlertId] = useState<string | null>(null);
  const [editingSchedule, setEditingSchedule] = useState<Schedule | null>(null);
  const [missionArchiveOpen, setMissionArchiveOpen] = useState(false);
  const [notifArchiveOpen, setNotifArchiveOpen] = useState(false);

  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);

  useEffect(() => subscribeSchedules(setSchedules), []);

  const reloadNotifications = async () => {
    if (!vaultPath) return;
    try {
      setNotifications(await readNotifications(vaultPath));
    } catch (e) {
      console.error("[mission-control] notifications load failed:", e);
    }
  };

  useEffect(() => {
    if (!open || !vaultPath) return;
    void reloadNotifications();
    const id = window.setInterval(() => void reloadNotifications(), 5000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, vaultPath]);

  useEffect(() => {
    if (open) return;
    setView("list");
    setMissionKey(null);
    setWorkerId(null);
    setAlertId(null);
    setEditingSchedule(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (view !== "list") {
        setView("list");
        setEditingSchedule(null);
      } else {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, view, onClose]);

  const groups = useMemo(() => groupMissions(conversations), [conversations]);
  const currentGroup: MissionGroup | null = missionKey ? resolveMissionGroup(conversations, missionKey) : null;
  const currentWorker: Conversation | null = workerId
    ? conversations.find((c) => c.id === workerId) ?? null
    : null;
  const currentAlert: Notification | null = alertId
    ? notifications.find((n) => n.id === alertId) ?? null
    : null;

  const nextFiring = useMemo(() => {
    let soonest: number | null = null;
    for (const s of schedules) {
      if (!s.enabled) continue;
      const n = nextFireAt(s);
      if (n === null) continue;
      if (soonest === null || n < soonest) soonest = n;
    }
    return soonest;
  }, [schedules]);

  const unreadNotifCount = notifications.filter((n) => !n.read).length;

  if (!open) return null;

  const openThread = (convId: string) => {
    const conv = conversations.find((c) => c.id === convId);
    if (!conv) {
      onClose();
      return;
    }
    if (conv.source === "mission") {
      setTab("missions");
      setMissionKey(missionKeyOf(conv));
      setWorkerId(null);
      setView("mission");
      return;
    }
    if (conv.source === "worker") {
      setTab("missions");
      setMissionKey((conv.mission ?? "").trim() || conv.title);
      setWorkerId(conv.id);
      setView("worker");
      return;
    }
    useStore.getState().selectConversation(conv.id);
    onClose();
  };

  // Optimistic UI: the local list flips immediately, and the modal re-polls
  // notifications.jsonl every 5s while open. If the persist call below fails,
  // log it — otherwise the next poll silently reverts the optimistic update
  // (the card "un-reads" itself) with no indication anything went wrong.
  const openAlert = (n: Notification) => {
    setAlertId(n.id);
    setView("alert");
    if (!n.read && vaultPath) {
      setNotifications((prev) => prev.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
      markNotificationRead(vaultPath, n.id).catch((e) => console.error("[mission-control] mark read failed:", e));
    }
  };

  const markRead = (id: string) => {
    if (!vaultPath) return;
    setNotifications((prev) => prev.map((x) => (x.id === id ? { ...x, read: true } : x)));
    markNotificationRead(vaultPath, id).catch((e) => console.error("[mission-control] mark read failed:", e));
  };

  const archiveNotif = (id: string) => {
    if (!vaultPath) return;
    setNotifications((prev) => prev.filter((x) => x.id !== id));
    hideNotification(vaultPath, id).catch((e) => console.error("[mission-control] archive failed:", e));
  };

  const markAllRead = () => {
    if (!vaultPath) return;
    const ids = notifications.filter((n) => !n.read).map((n) => n.id);
    if (ids.length === 0) return;
    setNotifications((prev) => prev.map((x) => ({ ...x, read: true })));
    markAllNotificationsRead(vaultPath, ids).catch((e) => console.error("[mission-control] mark all read failed:", e));
  };

  const deleteArchivedMission = (id: string) => {
    if (!vaultPath) return;
    void stopAndDeleteMission(vaultPath, id);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-[920px] max-w-[92vw] max-h-[85vh] flex flex-col rounded-md border border-border bg-card shadow-xl overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {view === "schedule-form" && editingSchedule ? (
          <ScheduleFormView
            schedule={editingSchedule}
            conversations={conversations}
            onCancel={() => {
              setEditingSchedule(null);
              setView("list");
            }}
            onSave={async (s) => {
              if (!vaultPath) return;
              await saveSchedule(vaultPath, s);
              setEditingSchedule(null);
              setView("list");
            }}
            onDelete={async (id) => {
              if (!vaultPath) return;
              await deleteSchedule(vaultPath, id);
              setEditingSchedule(null);
              setView("list");
            }}
          />
        ) : view === "mission" && currentGroup ? (
          <MissionDetail
            group={currentGroup}
            onOpenWorker={(id) => {
              setWorkerId(id);
              setView("worker");
            }}
            onBack={() => {
              setView("list");
              setMissionKey(null);
            }}
            onClose={onClose}
            onStopped={() => {
              setView("list");
              setMissionKey(null);
            }}
          />
        ) : view === "worker" && currentWorker ? (
          <WorkerDetail
            worker={currentWorker}
            missionTitle={currentGroup?.conv.title ?? currentWorker.mission ?? ""}
            onBack={() => setView("mission")}
            onClose={onClose}
          />
        ) : view === "alert" && currentAlert ? (
          <AlertDetail
            n={currentAlert}
            onBack={() => setView("list")}
            onClose={onClose}
            onMarkSeen={() => {
              markRead(currentAlert.id);
              setView("list");
            }}
            onOpenThread={openThread}
          />
        ) : (
          <>
            <div className="px-4 pt-4 pb-0 flex items-end justify-between gap-3 shrink-0">
              <div className="flex items-center gap-3 min-w-0">
                <Rocket className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="flex">
                  <TabButton active={tab === "missions"} onClick={() => setTab("missions")}>
                    Missions
                  </TabButton>
                  <TabButton active={tab === "schedules"} onClick={() => setTab("schedules")}>
                    Schedules
                  </TabButton>
                  <TabButton active={tab === "notifications"} onClick={() => setTab("notifications")}>
                    Notifications
                  </TabButton>
                </div>
              </div>
              <div className="flex items-center gap-1 pb-1.5">
                {tab === "schedules" && (
                  <button
                    onClick={() => {
                      setEditingSchedule(emptySchedule(modelId));
                      setView("schedule-form");
                    }}
                    className="h-7 px-2 flex items-center gap-1.5 rounded hover:bg-accent/60 text-[11.5px] text-foreground/90"
                    title="New schedule"
                  >
                    <Plus className="h-3 w-3" />
                    <span>New</span>
                  </button>
                )}
                {tab === "notifications" && unreadNotifCount > 0 && (
                  <button
                    onClick={markAllRead}
                    className="h-7 px-2 flex items-center gap-1.5 rounded hover:bg-accent/60 text-[11.5px] text-foreground/90"
                    title="Mark all read"
                  >
                    <CheckCheck className="h-3 w-3" />
                    <span>Mark all read</span>
                  </button>
                )}
                <button
                  onClick={onClose}
                  className="h-7 w-7 flex items-center justify-center rounded hover:bg-accent/60 text-muted-foreground"
                  title="Close"
                >
                  <XIcon className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
            <div className="border-b border-border/60 shrink-0" />
            {tab === "missions" && (
              <MissionsPane
                groups={groups}
                archiveOpen={missionArchiveOpen}
                onToggleArchive={() => setMissionArchiveOpen((v) => !v)}
                onOpenMission={(key) => {
                  setMissionKey(key);
                  setWorkerId(null);
                  setView("mission");
                }}
                onOpenWorker={(key, id) => {
                  setMissionKey(key);
                  setWorkerId(id);
                  setView("worker");
                }}
                onDeleteArchived={deleteArchivedMission}
              />
            )}
            {tab === "schedules" && (
              <ScheduleListView
                embedded
                list={schedules
                  .slice()
                  .sort((a, b) => (nextFireAt(a) ?? Infinity) - (nextFireAt(b) ?? Infinity))}
                nextFiring={nextFiring}
                onClose={() => {}}
                onNew={() => {
                  setEditingSchedule(emptySchedule(modelId));
                  setView("schedule-form");
                }}
                onEdit={(s) => {
                  setEditingSchedule(s);
                  setView("schedule-form");
                }}
                onToggle={(id, enabled) => {
                  if (vaultPath) void toggleSchedule(vaultPath, id, enabled);
                }}
                onDelete={(id) => {
                  if (vaultPath) void deleteSchedule(vaultPath, id);
                }}
              />
            )}
            {tab === "notifications" && (
              <NotificationsPane
                notifications={notifications}
                archiveOpen={notifArchiveOpen}
                onToggleArchive={() => setNotifArchiveOpen((v) => !v)}
                onOpen={openAlert}
                onMarkRead={markRead}
                onArchive={archiveNotif}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "px-3 py-1.5 text-[12px] border-b-2 -mb-px transition-colors",
        active ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-4 pt-3 pb-1 text-[10.5px] uppercase tracking-wider text-muted-foreground/80 font-medium">
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Missions tab
// ---------------------------------------------------------------------------

function MissionsPane({
  groups,
  archiveOpen,
  onToggleArchive,
  onOpenMission,
  onOpenWorker,
  onDeleteArchived,
}: {
  groups: ReturnType<typeof groupMissions>;
  archiveOpen: boolean;
  onToggleArchive: () => void;
  onOpenMission: (key: string) => void;
  onOpenWorker: (missionKey: string, workerId: string) => void;
  onDeleteArchived: (id: string) => void;
}) {
  const empty = groups.running.length === 0 && groups.recent.length === 0 && groups.archived.length === 0;
  return (
    <div className="flex-1 overflow-auto min-h-0">
      {empty && (
        <div className="px-4 py-8 text-center text-[12px] text-muted-foreground">
          Nothing in flight. Approve a plan in chat and the mission — with its workers — lands here.
        </div>
      )}
      {groups.running.length > 0 && (
        <>
          <SectionLabel>Running</SectionLabel>
          {groups.running.map((g) => (
            <MissionGroupRow
              key={g.key}
              g={g}
              showWorkers
              onOpen={() => onOpenMission(g.key)}
              onOpenWorker={(id) => onOpenWorker(g.key, id)}
            />
          ))}
        </>
      )}
      {groups.recent.length > 0 && (
        <>
          <SectionLabel>Recent</SectionLabel>
          {groups.recent.map((g) => (
            <MissionGroupRow
              key={g.key}
              g={g}
              showWorkers={false}
              onOpen={() => onOpenMission(g.key)}
              onOpenWorker={(id) => onOpenWorker(g.key, id)}
            />
          ))}
        </>
      )}
      {groups.archived.length > 0 && (
        <>
          <button
            onClick={onToggleArchive}
            className="w-full flex items-center gap-1.5 px-4 py-3 text-muted-foreground hover:text-foreground text-[10.5px] uppercase tracking-wider"
          >
            <ChevronRight className={cn("h-3 w-3 transition-transform", archiveOpen && "rotate-90")} />
            <span>Archive · {groups.archived.length} completed</span>
          </button>
          {archiveOpen &&
            groups.archived.map((c) => (
              <ArchivedMissionRow
                key={c.id}
                conv={c}
                onOpen={() => onOpenMission(missionKeyOf(c))}
                onDelete={() => onDeleteArchived(c.id)}
              />
            ))}
        </>
      )}
    </div>
  );
}

function MissionGroupRow({
  g,
  showWorkers,
  onOpen,
  onOpenWorker,
}: {
  g: MissionGroup;
  showWorkers: boolean;
  onOpen: () => void;
  onOpenWorker: (id: string) => void;
}) {
  const workers = [...g.active, ...g.done];
  return (
    <div>
      <MissionRow conv={g.conv} onClick={onOpen} />
      {showWorkers && workers.length > 0 && (
        <div className="pl-[22px] border-b border-border/40">
          {workers.map((w) => (
            <MissionRow key={w.id} conv={w} onClick={() => onOpenWorker(w.id)} sub />
          ))}
        </div>
      )}
    </div>
  );
}

function MissionRow({ conv, onClick, sub }: { conv: Conversation; onClick: () => void; sub?: boolean }) {
  const preview = conversationPreview(conv);
  const state = missionRowState(conv, preview);
  const time = relativeTime(conv.lastActivityAt);
  return (
    <div className="border-b border-border/40 hover:bg-accent/40 flex items-start gap-2 group">
      <button onClick={onClick} className="flex-1 text-left px-4 py-2.5 flex items-start gap-2 min-w-0">
        <span className="relative inline-flex h-1.5 w-1.5 mt-[7px] shrink-0">
          {state === "running" ? (
            <>
              <span className="absolute inset-0 rounded-full bg-foreground opacity-60 animate-ping" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-foreground" />
            </>
          ) : state === "fail" ? (
            <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
          ) : state === "unseen" ? (
            <span className="h-1.5 w-1.5 rounded-full bg-primary" />
          ) : (
            <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className={cn("truncate flex-1", sub ? "text-[11.5px] text-foreground/80" : "text-[12.5px] text-foreground")}>
              {conv.title || "Mission"}
            </span>
            <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">{time}</span>
          </div>
          {preview && (
            <div className={cn("text-[10.5px] mt-0.5 truncate", state === "fail" ? "text-destructive/85" : "text-muted-foreground")}>
              {preview}
            </div>
          )}
        </span>
      </button>
    </div>
  );
}

function ArchivedMissionRow({ conv, onOpen, onDelete }: { conv: Conversation; onOpen: () => void; onDelete: () => void }) {
  const [dismissing, setDismissing] = useState(false);
  return (
    <div
      className={cn(
        "border-b border-border/40 hover:bg-accent/40 flex items-start gap-2 group transition-all duration-150",
        dismissing && "opacity-0 translate-x-2",
      )}
    >
      <button onClick={onOpen} className="flex-1 text-left px-4 py-2.5 flex items-start gap-2 min-w-0">
        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40 mt-[7px] shrink-0" />
        <span className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[12.5px] text-muted-foreground truncate flex-1">{conv.title || "Mission"}</span>
            <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
              {relativeTime(conv.completedAt ?? conv.lastActivityAt)}
            </span>
          </div>
        </span>
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setDismissing(true);
          window.setTimeout(onDelete, 150);
        }}
        className="opacity-0 group-hover:opacity-100 transition-opacity h-7 w-7 mr-2 mt-1 flex items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive shrink-0"
        title="Delete mission"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
}

// ---- mission detail --------------------------------------------------------

function DoneWhenCard({ items, goalFallback }: { items: DoneWhenItem[]; goalFallback: string }) {
  if (items.length === 0) {
    return (
      <div className="rounded-md border border-border/60 bg-muted/30 p-2.5 text-[12px] text-muted-foreground leading-relaxed">
        {goalFallback.trim() || "No explicit criteria recorded for this mission."}
      </div>
    );
  }
  const done = items.filter((i) => i.status === "done").length;
  return (
    <div className="rounded-md border border-border/60 bg-muted/30 p-2.5 space-y-1">
      <div className="flex items-center justify-between text-[10.5px] text-muted-foreground">
        <span>Done when</span>
        <span className="font-mono">
          {done}/{items.length}
        </span>
      </div>
      <ul className="space-y-0.5">
        {items.map((it, i) => (
          <li key={i} className="flex items-start gap-2 text-[12px] leading-relaxed">
            <span
              className={cn(
                "mt-[5px] h-2 w-2 shrink-0 rounded-full",
                it.status === "done" && "bg-emerald-600",
                it.status === "prog" && "bg-primary animate-pulse",
                it.status === "pending" && "bg-muted-foreground/40",
              )}
            />
            <span
              className={cn(
                "min-w-0 flex-1",
                it.status === "done" && "line-through text-muted-foreground",
                it.status === "prog" && "text-foreground",
                it.status === "pending" && "text-muted-foreground",
              )}
            >
              {it.text}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StopMissionLink({ onConfirm }: { onConfirm: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const timerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
  }, []);
  return (
    <button
      onClick={() => {
        if (!confirming) {
          setConfirming(true);
          timerRef.current = window.setTimeout(() => setConfirming(false), 2200);
          return;
        }
        if (timerRef.current) window.clearTimeout(timerRef.current);
        setConfirming(false);
        onConfirm();
      }}
      className={cn("text-[11.5px] px-1.5 text-destructive hover:underline", confirming && "underline font-medium")}
    >
      {confirming ? "Confirm?" : "Stop mission"}
    </button>
  );
}

function MissionComposer({
  missionId,
  running,
  placeholder,
}: {
  missionId: string;
  running: boolean;
  placeholder: string;
}) {
  const [text, setText] = useState("");
  const send = () => {
    const t = text.trim();
    if (!t || running) return;
    setText("");
    void sendMessage(t, undefined, undefined, missionId);
  };
  return (
    <div className="p-3 shrink-0">
      <div className="relative flex flex-col rounded-2xl border border-border bg-background focus-within:border-ring/40 focus-within:ring-[0.5px] focus-within:ring-ring/20 transition-colors">
        <div className="relative flex items-end">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                if ((e.nativeEvent as { isComposing?: boolean }).isComposing) return;
                e.preventDefault();
                send();
              }
            }}
            placeholder={placeholder}
            rows={1}
            className="border-0 bg-transparent min-h-0 max-h-[160px] focus-visible:ring-0 shadow-none !py-2 !pl-3 !pr-12"
          />
          <div className="absolute right-2 bottom-1.5 flex items-center gap-1">
            {running ? (
              <Button
                size="icon"
                variant="secondary"
                onClick={() => abortRun(missionId)}
                className="h-7 w-7 rounded-lg"
                title="Stop the agent"
              >
                <Square className="h-3 w-3 fill-current" />
              </Button>
            ) : (
              <Button size="icon" onClick={send} disabled={!text.trim()} className="h-7 w-7 rounded-lg" title="Send">
                <ArrowUp className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function MissionDetail({
  group,
  onOpenWorker,
  onBack,
  onClose,
  onStopped,
}: {
  group: MissionGroup;
  onOpenWorker: (id: string) => void;
  onBack: () => void;
  onClose: () => void;
  onStopped: () => void;
}) {
  const vaultPath = useStore((s) => s.vaultPath);
  const mission = group.conv;
  const live = useConvLiveState(mission.id);
  const completed = !!mission.completedAt;
  const failed = !live.running && !completed && (isFailish(mission.title) || isFailish(conversationPreview(mission)));
  const subLabel = live.running ? "Mission · running" : failed ? "Mission · failed" : completed ? "Mission · complete" : "Mission · idle";
  const doneWhen = useMemo(() => buildDoneWhen(mission), [mission]);
  const brief = useMemo(() => missionBriefText(mission), [mission]);
  const threadMessages = useMemo(
    () =>
      mission.messages.filter((m) => !m.hidden && !(m.role === "user" && /^\s*MISSION BRIEF/i.test(m.content || ""))),
    [mission],
  );
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [mission.id, threadMessages.length, live.running]);
  const workers = [...group.active, ...group.done];
  const [stopping, setStopping] = useState(false);

  return (
    <>
      <div className="px-4 pt-4 pb-0 flex items-end justify-between gap-3 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <button
            onClick={onBack}
            className="h-7 w-7 flex items-center justify-center rounded hover:bg-accent/60 text-muted-foreground -mb-1"
            title="Back"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </button>
          <div className="min-w-0 pb-1.5">
            <div className="text-[13px] font-semibold text-foreground truncate">{mission.title}</div>
            <div className="text-[11px] text-muted-foreground mt-0.5">{subLabel}</div>
          </div>
        </div>
        <div className="flex items-center gap-1 pb-1">
          {(live.running || failed) && !stopping && (
            <StopMissionLink
              onConfirm={async () => {
                if (!vaultPath) return;
                setStopping(true);
                await stopAndDeleteMission(vaultPath, mission.id);
                onStopped();
              }}
            />
          )}
          <button
            onClick={onClose}
            className="h-7 w-7 flex items-center justify-center rounded hover:bg-accent/60 text-muted-foreground"
            title="Close"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="border-b border-border/60 shrink-0" />
      <div ref={bodyRef} className="flex-1 overflow-auto min-h-0 px-4 py-3.5">
        <div className="text-[10.5px] uppercase tracking-wide text-muted-foreground/80 font-medium mb-2">Done when</div>
        <DoneWhenCard items={doneWhen} goalFallback={brief} />
        <div className="text-[10.5px] uppercase tracking-wide text-muted-foreground/80 font-medium mt-4 mb-2">Thread</div>
        {threadMessages.length === 0 ? (
          <div className="text-[12px] text-muted-foreground italic">No turns yet — it hasn't run since being briefed.</div>
        ) : (
          <div className="space-y-3">
            {threadMessages.map((m, i) => (
              <MessageBubble key={i} message={m} />
            ))}
          </div>
        )}
        {live.running && (
          <div className="mt-2">
            <ThinkingIndicator liveChars={live.liveChars} />
          </div>
        )}
        {!live.running && !completed && threadMessages.length > 0 && (
          <div className="text-[11px] text-muted-foreground leading-relaxed mt-2 px-2.5 py-2 bg-accent/25 rounded-md">
            Ready for you — it's waiting on its workers and self-checks on its own schedule. Ask it anything below.
          </div>
        )}
        {workers.length > 0 && (
          <>
            <div className="text-[10.5px] uppercase tracking-wide text-muted-foreground/80 font-medium mt-4 mb-2">
              Workers · {workers.length}
            </div>
            <div className="space-y-1">
              {workers.map((w) => (
                <button
                  key={w.id}
                  onClick={() => onOpenWorker(w.id)}
                  className="w-full flex items-center justify-between px-2.5 py-2 rounded-md border border-border/60 hover:bg-accent/40 text-[12px] text-foreground/90"
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <span
                      className={cn(
                        "h-1.5 w-1.5 rounded-full shrink-0",
                        w.status === "running" ? "bg-foreground" : "bg-muted-foreground/50",
                      )}
                    />
                    <span className="truncate">
                      {w.title}
                      {w.status !== "running" ? " · done" : ""}
                    </span>
                  </span>
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      <MissionComposer
        missionId={mission.id}
        running={live.running}
        placeholder={completed ? "Ask the supervisor about this finished mission…" : "Steer the supervisor, or tell it to spawn a worker…"}
      />
    </>
  );
}

function WorkerDetail({
  worker,
  missionTitle,
  onBack,
  onClose,
}: {
  worker: Conversation;
  missionTitle: string;
  onBack: () => void;
  onClose: () => void;
}) {
  const live = useConvLiveState(worker.id);
  const threadMessages = useMemo(() => worker.messages.filter((m) => !m.hidden), [worker]);
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [worker.id, threadMessages.length, live.running]);
  return (
    <>
      <div className="px-4 pt-4 pb-0 flex items-end justify-between gap-3 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <button
            onClick={onBack}
            className="h-7 w-7 flex items-center justify-center rounded hover:bg-accent/60 text-muted-foreground -mb-1"
            title="Back"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </button>
          <div className="min-w-0 pb-1.5">
            <div className="text-[13px] font-semibold text-foreground truncate">{worker.title}</div>
            <div className="text-[11px] text-muted-foreground mt-0.5 truncate">
              Worker · {missionTitle} · read-only
            </div>
          </div>
        </div>
        <button
          onClick={onClose}
          className="h-7 w-7 flex items-center justify-center rounded hover:bg-accent/60 text-muted-foreground"
          title="Close"
        >
          <XIcon className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="border-b border-border/60 shrink-0" />
      <div ref={bodyRef} className="flex-1 overflow-auto min-h-0 px-4 py-3.5">
        <div className="text-[10.5px] uppercase tracking-wide text-muted-foreground/80 font-medium mb-2">
          Thread · supervisor ↔ worker
        </div>
        {threadMessages.length === 0 ? (
          <div className="text-[12px] text-muted-foreground italic">No turns yet.</div>
        ) : (
          <div className="space-y-3">
            {threadMessages.map((m, i) => (
              <MessageBubble key={i} message={m} />
            ))}
          </div>
        )}
        {live.running && (
          <div className="mt-2">
            <ThinkingIndicator liveChars={live.liveChars} />
          </div>
        )}
        <div className="text-[11px] text-muted-foreground leading-relaxed mt-3.5 px-2.5 py-2.5 bg-accent/25 rounded-md">
          This back-and-forth is the <span className="text-foreground/85 font-medium">supervisor</span> briefing and
          steering the <span className="text-foreground/85 font-medium">worker</span> — not you. Read-only: if it's
          off track, steer the supervisor or re-scope the mission.
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Notifications tab
// ---------------------------------------------------------------------------

function NotificationsPane({
  notifications,
  archiveOpen,
  onToggleArchive,
  onOpen,
  onMarkRead,
  onArchive,
}: {
  notifications: Notification[];
  archiveOpen: boolean;
  onToggleArchive: () => void;
  onOpen: (n: Notification) => void;
  onMarkRead: (id: string) => void;
  onArchive: (id: string) => void;
}) {
  const unread = notifications.filter((n) => !n.read);
  const read = notifications.filter((n) => n.read);
  const needsReply = unread.filter((n) => n.kind === "ask");
  const headsUp = unread.filter((n) => n.kind !== "ask");
  const empty = notifications.length === 0;
  return (
    <div className="flex-1 overflow-auto min-h-0 pt-1">
      {empty && (
        <div className="px-4 py-8 text-center text-[12px] text-muted-foreground">
          Nothing yet. Worker results, failures that need a call, and your recurring briefings land here.
        </div>
      )}
      {needsReply.length > 0 && (
        <>
          <SectionLabel>Needs a reply</SectionLabel>
          {needsReply.map((n) => (
            <AlertCard key={n.id} n={n} onOpen={() => onOpen(n)} onMarkRead={() => onMarkRead(n.id)} onArchive={() => onArchive(n.id)} />
          ))}
        </>
      )}
      {headsUp.length > 0 && (
        <>
          <SectionLabel>Heads-up</SectionLabel>
          {headsUp.map((n) => (
            <AlertCard key={n.id} n={n} onOpen={() => onOpen(n)} onMarkRead={() => onMarkRead(n.id)} onArchive={() => onArchive(n.id)} />
          ))}
        </>
      )}
      {!empty && needsReply.length === 0 && headsUp.length === 0 && (
        <div className="px-4 py-6 text-center text-[12px] text-muted-foreground">All caught up.</div>
      )}
      {read.length > 0 && (
        <>
          <button
            onClick={onToggleArchive}
            className="w-full flex items-center gap-1.5 px-4 py-3 text-muted-foreground hover:text-foreground text-[10.5px] uppercase tracking-wider"
          >
            <ChevronRight className={cn("h-3 w-3 transition-transform", archiveOpen && "rotate-90")} />
            <span>Archive · {read.length}</span>
          </button>
          {archiveOpen &&
            read.map((n) => (
              <AlertCard key={n.id} n={n} onOpen={() => onOpen(n)} onMarkRead={() => onMarkRead(n.id)} onArchive={() => onArchive(n.id)} />
            ))}
        </>
      )}
    </div>
  );
}

function AlertCard({
  n,
  onOpen,
  onMarkRead,
  onArchive,
}: {
  n: Notification;
  onOpen: () => void;
  onMarkRead: () => void;
  onArchive: () => void;
}) {
  const [dismissing, setDismissing] = useState(false);
  const meta = notificationMeta(n);
  const IconComp = meta.icon === "ask" ? CircleHelp : meta.icon === "fail" ? AlertTriangle : meta.icon === "ok" ? CheckCircle2 : Info;
  const iconClass =
    meta.icon === "ask" ? "text-primary" : meta.icon === "fail" ? "text-destructive" : meta.icon === "ok" ? "text-emerald-600" : "text-muted-foreground";
  return (
    <div
      className={cn(
        "relative mx-4 mb-2 flex gap-2.5 rounded-lg border border-border/50 bg-muted/40 p-2.5 cursor-pointer hover:bg-accent/40 group transition-all duration-150",
        dismissing && "opacity-0 translate-x-2",
      )}
      onClick={onOpen}
    >
      <div className={cn("h-7 w-7 rounded-md flex items-center justify-center bg-accent shrink-0", iconClass)}>
        <IconComp className="h-3.5 w-3.5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[12.5px] text-foreground truncate flex-1">{n.title}</span>
          {!n.read && <span className="h-1.5 w-1.5 rounded-full bg-primary shrink-0 self-center" />}
          <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">{relativeTime(n.ts)}</span>
        </div>
        <div className="text-[9.5px] uppercase tracking-wide text-muted-foreground/80 mt-0.5">
          {n.intention || meta.intention}
        </div>
        <p className="text-[11.5px] text-muted-foreground mt-1 leading-relaxed line-clamp-2">{n.summary || n.body || ""}</p>
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          if (n.read) {
            setDismissing(true);
            window.setTimeout(onArchive, 150);
          } else {
            onMarkRead();
          }
        }}
        className="opacity-0 group-hover:opacity-100 transition-opacity h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground shrink-0 self-center"
        title={n.read ? "Archive" : "Mark read"}
      >
        {n.read ? <ArchiveIcon className="h-3.5 w-3.5" /> : <CheckIcon className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

function AlertDetail({
  n,
  onBack,
  onClose,
  onMarkSeen,
  onOpenThread,
}: {
  n: Notification;
  onBack: () => void;
  onClose: () => void;
  onMarkSeen: () => void;
  onOpenThread: (convId: string) => void;
}) {
  const meta = notificationMeta(n);
  return (
    <>
      <div className="px-4 pt-4 pb-0 flex items-end justify-between gap-3 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <button
            onClick={onBack}
            className="h-7 w-7 flex items-center justify-center rounded hover:bg-accent/60 text-muted-foreground -mb-1"
            title="Back"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </button>
          <div className="min-w-0 pb-1.5">
            <div className="text-[13px] font-semibold text-foreground truncate">{n.title}</div>
            <div className="text-[11px] text-muted-foreground mt-0.5">{n.intention || meta.intention}</div>
          </div>
        </div>
        <div className="flex items-center gap-1 pb-1">
          {n.convId && (
            <button
              onClick={() => onOpenThread(n.convId!)}
              className="h-7 px-2 flex items-center gap-1.5 rounded hover:bg-accent/60 text-[11.5px] text-foreground/90"
            >
              <ExternalLink className="h-3 w-3" />
              <span>Open thread</span>
            </button>
          )}
          <button
            onClick={onClose}
            className="h-7 w-7 flex items-center justify-center rounded hover:bg-accent/60 text-muted-foreground"
            title="Close"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="border-b border-border/60 shrink-0" />
      <div className="flex-1 overflow-auto min-h-0 px-4 py-3.5">
        <div className="prose-chat text-foreground/95">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{n.body || n.summary || "*(no summary)*"}</ReactMarkdown>
        </div>
      </div>
      <div className="border-t border-border/60 px-4 py-3 flex justify-end shrink-0">
        {n.kind === "ask" && n.convId ? (
          <Button onClick={() => onOpenThread(n.convId!)} className="h-8 px-4 text-[12.5px]">
            Reply to supervisor
          </Button>
        ) : (
          <Button onClick={onMarkSeen} className="h-8 px-4 text-[12.5px]">
            Mark as seen
          </Button>
        )}
      </div>
    </>
  );
}
