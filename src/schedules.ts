import { invoke } from "@tauri-apps/api/core";

// Scheduled agent runs. Each schedule fires a saved prompt on a
// recurrence; the firing creates a new conversation (or appends to a
// chosen existing one) and runs the agent on it.
//
// Persisted per-vault to `<vault>/.vault-chat/schedules.jsonl`.

export type Recurrence =
  | { kind: "daily" }
  | { kind: "weekdays" }
  | { kind: "weekly"; dow: number } // 0=Sun..6=Sat
  | { kind: "every"; minutes: number }
  | { kind: "once" }
  | { kind: "cron"; expr: string };

export type ScheduleTarget =
  | { kind: "new" }
  | { kind: "existing"; conversationId: string };

export type Schedule = {
  id: string;
  name: string;
  prompt: string;
  recurrence: Recurrence;
  // Local time HH:MM (24h). For `once`, paired with the date below.
  time: string;
  // ISO date "YYYY-MM-DD" — only used by `once` and `weekly`/`daily`
  // for grounding "next fire". Optional otherwise.
  date?: string;
  timezone: string;
  target: ScheduleTarget;
  modelId: string;
  enabled: boolean;
  markUnreadOnFinish: boolean;
  sendViaTelegram: boolean;
  lastFiredAt?: number;
  createdAt: number;
};

export function newScheduleId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID().slice(0, 12);
  }
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function emptySchedule(defaultModelId: string): Schedule {
  const now = Date.now();
  const tz =
    Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  return {
    id: newScheduleId(),
    name: "",
    prompt: "",
    recurrence: { kind: "daily" },
    time: "07:00",
    timezone: tz,
    target: { kind: "new" },
    modelId: defaultModelId,
    enabled: true,
    markUnreadOnFinish: true,
    sendViaTelegram: false,
    createdAt: now,
  };
}

export async function readSchedules(vault: string): Promise<Schedule[]> {
  const lines = await invoke<string[]>("schedules_read", { vault });
  const out: Schedule[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Schedule;
      if (!parsed || typeof parsed.id !== "string") continue;
      out.push(normalizeSchedule(parsed));
    } catch {
      // skip
    }
  }
  return dedupeById(out);
}

// schedules.jsonl is committed with `merge=union` so a schedule is never
// lost when two machines edit it concurrently. The cost: a row that both
// machines rewrote (e.g. each stamping its own lastFiredAt) survives as
// TWO lines after the union merge, and over time a schedule accumulates
// several duplicate rows. The scheduler fires every row it reads, so an
// undeduped read makes one daily check-in run N times — N independent
// agent runs with divergent output, which is how the phone and the chat
// pane end up showing completely different replies. Collapse to one row
// per id here, carrying the MAX lastFiredAt so the survivor reflects the
// most recent fire and won't immediately re-fire.
function dedupeById(list: Schedule[]): Schedule[] {
  const byId = new Map<string, Schedule>();
  for (const s of list) {
    const prev = byId.get(s.id);
    if (!prev) {
      byId.set(s.id, s);
      continue;
    }
    // Keep the most-recently-fired row as the base (it carries the
    // freshest edits), but never let the merged lastFiredAt regress
    // below any duplicate's — otherwise a stale row could reopen a
    // fire window the newest row already closed.
    const base = (s.lastFiredAt ?? 0) >= (prev.lastFiredAt ?? 0) ? s : prev;
    byId.set(s.id, {
      ...base,
      lastFiredAt: Math.max(s.lastFiredAt ?? 0, prev.lastFiredAt ?? 0) || undefined,
    });
  }
  return Array.from(byId.values());
}

export async function writeSchedules(
  vault: string,
  list: Schedule[],
): Promise<void> {
  const lines = list.map((s) => JSON.stringify(s));
  await invoke("schedules_write_all", { vault, lines });
}

function normalizeSchedule(s: Partial<Schedule>): Schedule {
  return {
    id: s.id!,
    name: s.name ?? "",
    prompt: s.prompt ?? "",
    recurrence: s.recurrence ?? { kind: "daily" },
    time: s.time ?? "07:00",
    date: s.date,
    timezone: s.timezone ?? "UTC",
    target: s.target ?? { kind: "new" },
    modelId: s.modelId ?? "",
    enabled: s.enabled ?? true,
    markUnreadOnFinish: s.markUnreadOnFinish ?? true,
    sendViaTelegram: s.sendViaTelegram ?? false,
    lastFiredAt: s.lastFiredAt,
    createdAt: s.createdAt ?? Date.now(),
  };
}

// Compute the next fire timestamp (ms) after `from`. Returns null if
// the schedule has no future fire (e.g. one-time already past).
export function nextFireAt(s: Schedule, from: number = Date.now()): number | null {
  const fromDate = new Date(from);
  switch (s.recurrence.kind) {
    case "daily":
      return nextOnDays(s.time, [0, 1, 2, 3, 4, 5, 6], fromDate);
    case "weekdays":
      return nextOnDays(s.time, [1, 2, 3, 4, 5], fromDate);
    case "weekly":
      return nextOnDays(s.time, [s.recurrence.dow], fromDate);
    case "every": {
      const last = s.lastFiredAt ?? s.createdAt ?? from;
      const interval = Math.max(1, s.recurrence.minutes) * 60_000;
      let n = last + interval;
      while (n <= from) n += interval;
      return n;
    }
    case "once": {
      if (!s.date) return null;
      const t = atDateTime(s.date, s.time);
      return t > from ? t : null;
    }
    case "cron":
      // Cron is an escape hatch; without a full parser we treat it as
      // a daily-at-time fallback so the user isn't stuck — they can
      // override with simpler presets if needed.
      return nextOnDays(s.time, [0, 1, 2, 3, 4, 5, 6], fromDate);
  }
}

function atDateTime(date: string, time: string): number {
  // ISO `YYYY-MM-DDTHH:MM` parsed as local time.
  const [h = 0, m = 0] = time.split(":").map((p) => Number(p));
  const [y, mo, d] = date.split("-").map((p) => Number(p));
  if (!y || !mo || !d) return 0;
  return new Date(y, mo - 1, d, h, m, 0, 0).getTime();
}

function nextOnDays(time: string, dows: number[], from: Date): number {
  const [h = 0, m = 0] = time.split(":").map((p) => Number(p));
  for (let offset = 0; offset < 14; offset++) {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset, h, m, 0, 0);
    if (!dows.includes(d.getDay())) continue;
    if (d.getTime() <= from.getTime()) continue;
    return d.getTime();
  }
  return from.getTime() + 24 * 3600_000;
}

export function recurrenceLabel(r: Recurrence): string {
  switch (r.kind) {
    case "daily":
      return "daily";
    case "weekdays":
      return "weekdays";
    case "weekly":
      return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][r.dow] + " weekly";
    case "every":
      return `every ${r.minutes}m`;
    case "once":
      return "one-time";
    case "cron":
      return "cron";
  }
}

export function shortTimeLabel(s: Schedule): string {
  const [hStr, mStr] = s.time.split(":");
  const h = Number(hStr) || 0;
  const m = Number(mStr) || 0;
  const am = h < 12;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${am ? "AM" : "PM"}`;
}
