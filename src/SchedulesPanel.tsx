import { useEffect, useMemo, useRef, useState } from "react";
import {
  Clock,
  Plus,
  X as XIcon,
  ArrowLeft,
  Trash2,
} from "lucide-react";
import { useStore } from "./store";
import {
  type Schedule,
  type Recurrence,
  type ScheduleTarget,
  emptySchedule,
  nextFireAt,
  recurrenceLabel,
  shortTimeLabel,
} from "./schedules";
import {
  subscribeSchedules,
  saveSchedule,
  deleteSchedule,
  toggleSchedule,
} from "./schedulerLoop";
import { readTelegramEnabled } from "./telegram";

type Props = {
  open: boolean;
  onClose: () => void;
};

export function SchedulesPanel({ open, onClose }: Props) {
  const vaultPath = useStore((s) => s.vaultPath);
  const modelId = useStore((s) => s.modelId);
  const conversations = useStore((s) => s.conversations);
  const [list, setList] = useState<Schedule[]>([]);
  const [editing, setEditing] = useState<Schedule | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => subscribeSchedules(setList), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (editing) {
          setEditing(null);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, editing]);

  const sorted = useMemo(
    () =>
      list.slice().sort((a, b) => {
        const an = nextFireAt(a) ?? Infinity;
        const bn = nextFireAt(b) ?? Infinity;
        return an - bn;
      }),
    [list],
  );

  const nextFiring = useMemo(() => {
    const enabled = list.filter((s) => s.enabled);
    let soonest: number | null = null;
    for (const s of enabled) {
      const n = nextFireAt(s);
      if (n === null) continue;
      if (soonest === null || n < soonest) soonest = n;
    }
    return soonest;
  }, [list]);

  if (!open) return null;

  const onSave = async (s: Schedule) => {
    if (!vaultPath) return;
    await saveSchedule(vaultPath, s);
    setEditing(null);
  };

  const onDelete = async (id: string) => {
    if (!vaultPath) return;
    await deleteSchedule(vaultPath, id);
    setEditing(null);
  };

  const onToggle = async (id: string, enabled: boolean) => {
    if (!vaultPath) return;
    await toggleSchedule(vaultPath, id, enabled);
  };

  const onNew = () => {
    setEditing(emptySchedule(modelId));
  };

  return (
    <div className="fixed inset-0 z-30 flex justify-end pointer-events-none">
      <div
        ref={panelRef}
        className="h-full w-[420px] max-w-[92vw] bg-card border-l border-border shadow-xl flex flex-col pointer-events-auto"
      >
        {editing ? (
          <FormView
            schedule={editing}
            conversations={conversations}
            onCancel={() => setEditing(null)}
            onSave={onSave}
            onDelete={onDelete}
          />
        ) : (
          <ListView
            list={sorted}
            nextFiring={nextFiring}
            onClose={onClose}
            onNew={onNew}
            onEdit={setEditing}
            onToggle={onToggle}
            onDelete={onDelete}
          />
        )}
      </div>
    </div>
  );
}

function ListView({
  list,
  nextFiring,
  onClose,
  onNew,
  onEdit,
  onToggle,
  onDelete,
}: {
  list: Schedule[];
  nextFiring: number | null;
  onClose: () => void;
  onNew: () => void;
  onEdit: (s: Schedule) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/60 shrink-0">
        <div className="flex items-center gap-2">
          <Clock className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-[13px] font-semibold">Schedules</span>
          <span className="text-[11px] text-muted-foreground">
            {list.length}
            {nextFiring ? ` · next ${untilLabel(nextFiring)}` : ""}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={onNew}
            className="h-7 px-2 flex items-center gap-1 rounded hover:bg-accent/60 text-[11.5px] text-foreground/90"
            title="New schedule"
          >
            <Plus className="h-3 w-3" />
            <span>New</span>
          </button>
          <button
            onClick={onClose}
            className="h-7 w-7 flex items-center justify-center rounded hover:bg-accent/60 text-muted-foreground"
            title="Close (Esc)"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        {list.length === 0 ? (
          <div className="px-4 py-6 text-center text-[11px] text-muted-foreground italic">
            No schedules yet. Hit New to fire a prompt on a timer.
          </div>
        ) : (
          list.map((s) => (
            <Row
              key={s.id}
              schedule={s}
              onEdit={() => onEdit(s)}
              onToggle={(v) => onToggle(s.id, v)}
              onDelete={() => onDelete(s.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function Row({
  schedule,
  onEdit,
  onToggle,
  onDelete,
}: {
  schedule: Schedule;
  onEdit: () => void;
  onToggle: (v: boolean) => void;
  onDelete: () => void;
}) {
  const next = schedule.enabled ? nextFireAt(schedule) : null;
  const imminent = next !== null && next - Date.now() < 5 * 60_000;
  const subdued = !schedule.enabled ? "opacity-60" : "";
  return (
    <div
      className={`px-4 py-3 border-b border-border/40 hover:bg-accent/20 group cursor-pointer ${subdued}`}
      onClick={onEdit}
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[13px] text-foreground font-medium truncate">
              {schedule.name?.trim() || schedule.prompt.split("\n")[0]?.slice(0, 48) || "Untitled"}
            </span>
            <span className="text-[9.5px] uppercase tracking-wider px-1 py-px rounded bg-primary/15 text-primary font-medium">
              {recurrenceLabel(schedule.recurrence)}
            </span>
            {imminent && (
              <span className="inline-flex items-center gap-1 text-[10px] text-primary">
                <span className="relative inline-flex h-1.5 w-1.5">
                  <span className="absolute inset-0 rounded-full bg-primary opacity-60 animate-ping" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
                </span>
                soon
              </span>
            )}
            {!schedule.enabled && (
              <span className="text-[10px] text-muted-foreground">paused</span>
            )}
          </div>
          <div className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
            {recurrenceWhenLabel(schedule)} ·{" "}
            <span className="text-foreground/85">
              {schedule.target.kind === "new" ? "new chat" : "existing chat"}
            </span>
          </div>
          <div className="text-[10.5px] text-muted-foreground/80 mt-1 truncate font-mono">
            "{schedule.prompt.split("\n")[0]?.slice(0, 80)}"
          </div>
          <div className="flex items-center gap-3 text-[10px] text-muted-foreground/70 mt-1.5 tabular-nums">
            {schedule.lastFiredAt && <span>last fired {agoLabel(schedule.lastFiredAt)}</span>}
            {schedule.lastFiredAt && next && <span>·</span>}
            {next && <span>next {untilLabel(next)}</span>}
          </div>
        </div>
        <div className="flex flex-col items-end gap-2 shrink-0">
          <label
            onClick={(e) => e.stopPropagation()}
            className="cursor-pointer"
          >
            <input
              type="checkbox"
              className="vc-checkbox"
              checked={schedule.enabled}
              onChange={(e) => onToggle(e.target.checked)}
            />
          </label>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
            title="Delete"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </div>
    </div>
  );
}

function FormView({
  schedule,
  conversations,
  onCancel,
  onSave,
  onDelete,
}: {
  schedule: Schedule;
  conversations: { id: string; title: string }[];
  onCancel: () => void;
  onSave: (s: Schedule) => void | Promise<void>;
  onDelete: (id: string) => void | Promise<void>;
}) {
  const vaultPath = useStore((s) => s.vaultPath);
  const [draft, setDraft] = useState<Schedule>(schedule);
  const isNew = !schedule.lastFiredAt && !schedule.name && !schedule.prompt;
  const telegramAvailable = readTelegramEnabled(vaultPath);
  const next = nextFireAt(draft);

  const setRecurrence = (r: Recurrence) => {
    setDraft((d) => ({ ...d, recurrence: r }));
  };

  const setTarget = (t: ScheduleTarget) => {
    setDraft((d) => ({ ...d, target: t }));
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/60 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <button
            onClick={onCancel}
            className="h-7 w-7 flex items-center justify-center rounded hover:bg-accent/60 text-muted-foreground -ml-2"
            title="Back"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </button>
          <span className="text-[13px] font-semibold truncate">
            {isNew ? "New schedule" : "Edit schedule"}
          </span>
        </div>
        <button
          onClick={onCancel}
          className="h-7 w-7 flex items-center justify-center rounded hover:bg-accent/60 text-muted-foreground"
          title="Close"
        >
          <XIcon className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex-1 overflow-auto px-4 py-4 space-y-4">
        <Field label="Name">
          <input
            type="text"
            placeholder="Auto from prompt if blank"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            className="w-full h-8 px-2.5 rounded-md bg-background border border-border text-[12.5px] focus:outline-none focus:border-ring/40"
          />
        </Field>

        <Field label="When">
          <div className="flex flex-wrap gap-1">
            <RecurrenceButton
              active={draft.recurrence.kind === "daily"}
              onClick={() => setRecurrence({ kind: "daily" })}
            >
              Daily
            </RecurrenceButton>
            <RecurrenceButton
              active={draft.recurrence.kind === "weekdays"}
              onClick={() => setRecurrence({ kind: "weekdays" })}
            >
              Weekdays
            </RecurrenceButton>
            <RecurrenceButton
              active={draft.recurrence.kind === "weekly"}
              onClick={() =>
                setRecurrence({ kind: "weekly", dow: new Date().getDay() })
              }
            >
              Weekly
            </RecurrenceButton>
            <RecurrenceButton
              active={draft.recurrence.kind === "every"}
              onClick={() => setRecurrence({ kind: "every", minutes: 60 })}
            >
              Every…
            </RecurrenceButton>
            <RecurrenceButton
              active={draft.recurrence.kind === "once"}
              onClick={() => setRecurrence({ kind: "once" })}
            >
              Once
            </RecurrenceButton>
            <RecurrenceButton
              active={draft.recurrence.kind === "cron"}
              onClick={() => setRecurrence({ kind: "cron", expr: "0 * * * *" })}
            >
              Cron
            </RecurrenceButton>
          </div>
          {draft.recurrence.kind === "weekly" && (
            <div className="flex items-center gap-2 pt-1">
              <span className="text-[11.5px] text-muted-foreground">on</span>
              <select
                value={draft.recurrence.dow}
                onChange={(e) =>
                  setRecurrence({ kind: "weekly", dow: Number(e.target.value) })
                }
                className="h-7 px-2 rounded-md bg-background border border-border text-[12px] focus:outline-none focus:border-ring/40"
              >
                {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) => (
                  <option key={i} value={i}>
                    {d}
                  </option>
                ))}
              </select>
            </div>
          )}
          {draft.recurrence.kind === "every" && (
            <div className="flex items-center gap-2 pt-1">
              <span className="text-[11.5px] text-muted-foreground">every</span>
              <input
                type="number"
                min={1}
                value={draft.recurrence.minutes}
                onChange={(e) =>
                  setRecurrence({
                    kind: "every",
                    minutes: Math.max(1, Number(e.target.value) || 1),
                  })
                }
                className="h-7 w-16 px-2 rounded-md bg-background border border-border text-[12px] focus:outline-none focus:border-ring/40 tabular-nums"
              />
              <span className="text-[11.5px] text-muted-foreground">minutes</span>
            </div>
          )}
          {draft.recurrence.kind === "cron" && (
            <div className="flex items-center gap-2 pt-1">
              <span className="text-[11.5px] text-muted-foreground">expr</span>
              <input
                type="text"
                value={draft.recurrence.expr}
                onChange={(e) => setRecurrence({ kind: "cron", expr: e.target.value })}
                className="flex-1 h-7 px-2 rounded-md bg-background border border-border text-[12px] focus:outline-none focus:border-ring/40 font-mono"
                placeholder="0 * * * *"
              />
            </div>
          )}
          {draft.recurrence.kind === "once" && (
            <div className="flex items-center gap-2 pt-1">
              <span className="text-[11.5px] text-muted-foreground">on</span>
              <input
                type="date"
                value={draft.date ?? new Date().toISOString().slice(0, 10)}
                onChange={(e) => setDraft({ ...draft, date: e.target.value })}
                className="h-7 px-2 rounded-md bg-background border border-border text-[12px] focus:outline-none focus:border-ring/40"
              />
            </div>
          )}
          <div className="flex items-center gap-2 pt-1">
            <span className="text-[11.5px] text-muted-foreground">at</span>
            <input
              type="time"
              value={draft.time}
              onChange={(e) => setDraft({ ...draft, time: e.target.value })}
              className="h-7 px-2 rounded-md bg-background border border-border text-[12px] focus:outline-none focus:border-ring/40"
            />
            <span className="text-[11.5px] text-muted-foreground">·</span>
            <span className="text-[11.5px] text-muted-foreground">timezone:</span>
            <span className="text-[11.5px] text-foreground/85 font-mono">
              {draft.timezone}
            </span>
          </div>
          {next && (
            <div className="text-[10.5px] text-muted-foreground/80 pt-0.5">
              Next: <span className="text-foreground/80">{absoluteLabel(next)}</span>
            </div>
          )}
        </Field>

        <Field label="Fires into">
          <div className="space-y-1">
            <label className={radioClasses(draft.target.kind === "new")}>
              <input
                type="radio"
                name={`target-${draft.id}`}
                className="vc-radio"
                checked={draft.target.kind === "new"}
                onChange={() => setTarget({ kind: "new" })}
              />
              <span className="text-[12px] text-foreground">A new chat each run</span>
              <span className="ml-auto text-[10.5px] text-muted-foreground">
                titled with the date
              </span>
            </label>
            <label className={radioClasses(draft.target.kind === "existing")}>
              <input
                type="radio"
                name={`target-${draft.id}`}
                className="vc-radio"
                checked={draft.target.kind === "existing"}
                onChange={() => {
                  const first = conversations[0]?.id;
                  if (first) setTarget({ kind: "existing", conversationId: first });
                }}
                disabled={conversations.length === 0}
              />
              <span className="text-[12px] text-foreground">Existing chat:</span>
              {draft.target.kind === "existing" && conversations.length > 0 && (
                <select
                  value={draft.target.conversationId}
                  onChange={(e) =>
                    setTarget({ kind: "existing", conversationId: e.target.value })
                  }
                  className="ml-auto min-w-0 max-w-[55%] truncate h-6 px-1.5 rounded bg-background border border-border text-[11.5px] focus:outline-none"
                >
                  {conversations.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title || "(untitled)"}
                    </option>
                  ))}
                </select>
              )}
            </label>
          </div>
        </Field>

        <Field label="Prompt">
          <textarea
            rows={6}
            value={draft.prompt}
            onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
            className="w-full px-2.5 py-2 rounded-md bg-background border border-border text-[12.5px] font-mono leading-relaxed focus:outline-none focus:border-ring/40 resize-none"
            placeholder="Open notes/inbox/ and summarize the three things to look at first today."
          />
          <div className="text-[10.5px] text-muted-foreground/80">
            @mention files like in chat. Vault context is whatever's open at fire time, plus the explicit @mentions.
          </div>
        </Field>

        <Field label="Model">
          <input
            type="text"
            value={draft.modelId}
            onChange={(e) => setDraft({ ...draft, modelId: e.target.value })}
            className="w-full h-8 px-2 rounded-md bg-background border border-border text-[12.5px] focus:outline-none focus:border-ring/40 font-mono"
            placeholder="claude-opus-4-7"
          />
        </Field>

        <Field label="On completion">
          <label className="flex items-center gap-2 text-[12px] text-foreground">
            <input
              type="checkbox"
              className="vc-checkbox"
              checked={draft.markUnreadOnFinish}
              onChange={(e) =>
                setDraft({ ...draft, markUnreadOnFinish: e.target.checked })
              }
            />
            Mark unread in Chats
          </label>
          <label className="flex items-center gap-2 text-[12px] text-foreground">
            <input
              type="checkbox"
              className="vc-checkbox"
              checked={draft.sendViaTelegram}
              onChange={(e) =>
                setDraft({ ...draft, sendViaTelegram: e.target.checked })
              }
              disabled={!telegramAvailable}
            />
            Send via Telegram bot
            {!telegramAvailable && (
              <span className="text-[10.5px] text-muted-foreground">
                (configure Telegram in Settings)
              </span>
            )}
          </label>
        </Field>
      </div>

      <div className="border-t border-border/60 px-4 py-3 flex items-center justify-between shrink-0">
        {schedule.lastFiredAt || schedule.name || schedule.prompt ? (
          <button
            onClick={() => onDelete(draft.id)}
            className="text-[11.5px] text-destructive hover:underline"
          >
            Delete
          </button>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          <button
            onClick={onCancel}
            className="h-8 px-3 rounded-md text-[12px] hover:bg-accent/60 text-foreground"
          >
            Cancel
          </button>
          <button
            onClick={() => onSave(draft)}
            disabled={!draft.prompt.trim()}
            className="h-8 px-3 rounded-md text-[12px] bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-[10.5px] uppercase tracking-wider text-muted-foreground/80 font-medium">
        {label}
      </label>
      {children}
    </div>
  );
}

function RecurrenceButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={
        active
          ? "px-2.5 h-7 rounded-md text-[11.5px] bg-primary text-primary-foreground"
          : "px-2.5 h-7 rounded-md text-[11.5px] border border-border hover:bg-accent/60"
      }
    >
      {children}
    </button>
  );
}

function radioClasses(active: boolean): string {
  return active
    ? "flex items-center gap-2 px-2.5 py-1.5 rounded-md border border-primary/60 bg-primary/10 cursor-pointer"
    : "flex items-center gap-2 px-2.5 py-1.5 rounded-md border border-border hover:bg-accent/40 cursor-pointer";
}

function recurrenceWhenLabel(s: Schedule): string {
  const t = shortTimeLabel(s);
  switch (s.recurrence.kind) {
    case "daily":
      return `Every day at ${t}`;
    case "weekdays":
      return `Weekdays at ${t}`;
    case "weekly":
      return `${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][s.recurrence.dow]} at ${t}`;
    case "every":
      return `Every ${s.recurrence.minutes} min`;
    case "once":
      return `${s.date ?? "(date unset)"} at ${t}`;
    case "cron":
      return `cron: ${s.recurrence.expr}`;
  }
}

function untilLabel(ts: number): string {
  const diff = ts - Date.now();
  if (diff < 0) return "now";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `in ${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `in ${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) {
    const remMin = min % 60;
    return remMin > 0 ? `in ${hr}h ${remMin}m` : `in ${hr}h`;
  }
  const day = Math.floor(hr / 24);
  return `in ${day}d`;
}

function agoLabel(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return "now";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function absoluteLabel(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (sameDay) return `today at ${time}`;
  const tomorrow = new Date(now.getTime() + 24 * 3600_000);
  const isTomorrow =
    d.getFullYear() === tomorrow.getFullYear() &&
    d.getMonth() === tomorrow.getMonth() &&
    d.getDate() === tomorrow.getDate();
  if (isTomorrow) return `tomorrow at ${time}`;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${time}`;
}
