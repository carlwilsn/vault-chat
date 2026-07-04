// Support module for the desktop Mission Control modal (MissionControlModal.tsx).
// Ports the phone cockpit's mission-grouping (loadActivity) and notifications
// (loadAlerts / parseDoneWhen) logic — see src-tauri/assets/phone.html — onto
// the desktop's in-memory conversations store + a direct read of
// notifications.jsonl (there's no desktop notifications reader yet).

import { invoke } from "@tauri-apps/api/core";
import { useStore } from "./store";
import type { Conversation } from "./conversations";

// ---- mission grouping (port of phone.html's loadActivity) ----

export type MissionGroup = {
  key: string;
  conv: Conversation;
  active: Conversation[]; // workers currently running
  done: Conversation[]; // workers idle/finished
};

export const missionKeyOf = (c: Conversation) => (c.mission || c.title || "").trim() || c.title;

// Resolve a mission's full group (its own thread + every worker sharing its
// mission key) regardless of whether it's live or archived (completed) — used
// by the mission detail view, which needs the Workers list either way. Unlike
// groupMissions (list-view buckets, which drop completed missions), this
// looks the mission up directly by key.
export function resolveMissionGroup(conversations: Conversation[], key: string): MissionGroup | null {
  const conv = conversations.find((c) => c.source === "mission" && missionKeyOf(c) === key);
  if (!conv) return null;
  const workers = conversations.filter((c) => c.source === "worker" && (c.mission ?? "").trim() === key);
  const active = workers.filter((c) => c.status === "running");
  const done = workers.filter((c) => c.status !== "running");
  return { key, conv, active, done };
}

export function groupMissions(conversations: Conversation[]): {
  running: MissionGroup[];
  recent: MissionGroup[];
  archived: Conversation[];
} {
  const completedKeys = new Set<string>();
  for (const c of conversations) {
    if (c.source === "mission" && c.completedAt) completedKeys.add(missionKeyOf(c));
  }
  const missions = new Map<string, MissionGroup>();
  // Mission threads seed the groups (only non-completed ones stay live).
  for (const c of conversations) {
    if (c.source !== "mission" || c.completedAt) continue;
    const key = missionKeyOf(c);
    missions.set(key, { key, conv: c, active: [], done: [] });
  }
  // Workers join their mission's group. A worker with no live mission thread
  // is orphaned (shouldn't happen — every worker is minted with a mission —
  // but skip it defensively, matching the phone).
  for (const c of conversations) {
    if (c.source !== "worker") continue;
    const key = (c.mission || "").trim();
    if (!key || completedKeys.has(key)) continue;
    const g = missions.get(key);
    if (!g) continue;
    if (c.status === "running") g.active.push(c);
    else g.done.push(c);
  }
  const running: MissionGroup[] = [];
  const recent: MissionGroup[] = [];
  for (const g of missions.values()) {
    const isLive = g.conv.status === "running" || g.active.length > 0;
    (isLive ? running : recent).push(g);
  }
  const byActivity = (a: MissionGroup, b: MissionGroup) => b.conv.lastActivityAt - a.conv.lastActivityAt;
  running.sort(byActivity);
  recent.sort(byActivity);
  const archived = conversations
    .filter((c) => c.source === "mission" && c.completedAt)
    .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
  return { running, recent, archived };
}

// A row-level state heuristic. There's no structured "failed" field on
// Conversation — mirrors the phone's alertMeta title/preview sniff so a
// stalled/errored mission reads as destructive without new plumbing.
const FAILISH_RE = /fail|error|diverg|crash|wedge/i;
export function isFailish(text: string | undefined | null): boolean {
  return !!text && FAILISH_RE.test(text);
}

export type RowState = "running" | "fail" | "unseen" | "idle";
export function missionRowState(c: Conversation, preview: string): RowState {
  if (c.status === "running") return "running";
  if (isFailish(c.title) || isFailish(preview)) return "fail";
  if (c.unread) return "unseen";
  return "idle";
}

// ---- "Done when" checklist (port of phone.html's parseDoneWhen) ----

export function parseDoneWhen(goal: string): string[] {
  const out: string[] = [];
  for (const ln of (goal || "").split(/\r?\n/)) {
    const m = ln.match(/^\s*(?:[-*•]|\d+[.)])\s+(.+)$/);
    if (m) out.push(m[1].trim());
  }
  return out;
}

export const normalizeCriterion = (s: string) =>
  s.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();

export type DoneWhenItem = { text: string; status: "done" | "prog" | "pending" };

// The mission's real brief is its MISSION BRIEF turn (carries the done-when
// bullets), not merely the first user message — a worker-wake turn could be
// internal plumbing. Falls back to the first user message, then "".
export function missionBriefText(mission: Conversation): string {
  const brief = mission.messages.find(
    (m) => m.role === "user" && /^\s*MISSION BRIEF/i.test(m.content || ""),
  );
  if (brief?.content) return brief.content;
  const first = mission.messages.find((m) => m.role === "user" && !m.hidden);
  return first?.content ?? "";
}

export function buildDoneWhen(mission: Conversation): DoneWhenItem[] {
  const bullets = parseDoneWhen(missionBriefText(mission));
  const doneSet = new Set((mission.doneWhenDone ?? []).map(normalizeCriterion));
  const allDone = !!mission.completedAt;
  let progAssigned = false;
  return bullets.map((text) => {
    if (allDone || doneSet.has(normalizeCriterion(text))) return { text, status: "done" as const };
    if (!progAssigned && mission.status === "running") {
      progAssigned = true;
      return { text, status: "prog" as const };
    }
    return { text, status: "pending" as const };
  });
}

// ---- live run state for any conversation (not just the active one) ----
// The active conversation's live stream lives in the global busy/streamingText/
// liveTools/agentTodos fields; every other running conversation's stream is
// buffered in convRuntime (see store.ts) so leaving and returning shows the
// same progress. This reads whichever applies so Mission Control's mission/
// worker detail views show live state even when that thread isn't the one the
// user has open in the main ChatPane.
export function useConvLiveState(convId: string | undefined): {
  running: boolean;
  liveChars: number;
} {
  const conv = useStore((s) => (convId ? s.conversations.find((c) => c.id === convId) : undefined));
  const isActive = useStore((s) => convId != null && s.activeConversationId === convId);
  const globalStreamingText = useStore((s) => s.streamingText);
  const globalStreamingReasoning = useStore((s) => s.streamingReasoning);
  const globalLiveTools = useStore((s) => s.liveTools);
  const runtime = useStore((s) => (convId ? s.convRuntime[convId] : undefined));
  const running = conv?.status === "running";
  if (!running) return { running: false, liveChars: 0 };
  if (isActive) {
    const toolChars = globalLiveTools.reduce(
      (n, t) => n + (t.inputChars && t.inputChars > 0 ? t.inputChars : t.input ? JSON.stringify(t.input).length : 0) + (t.result ? t.result.length : 0),
      0,
    );
    return { running: true, liveChars: globalStreamingText.length + globalStreamingReasoning.length + toolChars };
  }
  const tools = runtime?.liveTools ?? [];
  const toolChars = tools.reduce(
    (n, t) => n + (t.input ? JSON.stringify(t.input).length : 0) + (t.result ? t.result.length : 0),
    0,
  );
  return {
    running: true,
    liveChars: (runtime?.streamingText?.length ?? 0) + (runtime?.streamingReasoning?.length ?? 0) + toolChars,
  };
}

// ---- notifications (mirrors the phone server's notifications_json + the
// /notifications/read and /notifications/hide routes — see voice_server.rs) ----

export type Notification = {
  id: string;
  ts: number;
  kind: "info" | "ask";
  title: string;
  body: string;
  convId?: string;
  intention?: string;
  summary?: string;
  icon?: string;
  cls?: string;
  read: boolean;
};

function notificationsPath(vault: string): string {
  return `${vault}/.vault-chat/notifications.jsonl`;
}

export async function readNotifications(vault: string): Promise<Notification[]> {
  const raw = await invoke<string>("read_text_file", { path: notificationsPath(vault) }).catch(() => "");
  const readIds = new Set<string>();
  const hiddenIds = new Set<string>();
  const byId = new Map<string, Record<string, unknown>>();
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    let v: Record<string, unknown>;
    try {
      v = JSON.parse(t);
    } catch {
      continue;
    }
    const type = v.type as string | undefined;
    if (type === "read") {
      if (typeof v.id === "string") readIds.add(v.id);
      continue;
    }
    if (type === "hide") {
      if (typeof v.id === "string") hiddenIds.add(v.id);
      continue;
    }
    if (typeof v.id === "string") byId.set(v.id, v);
  }
  const list: Notification[] = [];
  for (const [id, v] of byId) {
    if (hiddenIds.has(id)) continue;
    list.push({
      id,
      ts: typeof v.ts === "number" ? v.ts : 0,
      kind: v.kind === "ask" ? "ask" : "info",
      title: typeof v.title === "string" ? v.title : "",
      body: typeof v.body === "string" ? v.body : "",
      convId: typeof v.convId === "string" ? v.convId : undefined,
      intention: typeof v.intention === "string" ? v.intention : undefined,
      summary: typeof v.summary === "string" ? v.summary : undefined,
      icon: typeof v.icon === "string" ? v.icon : undefined,
      cls: typeof v.cls === "string" ? v.cls : undefined,
      read: readIds.has(id),
    });
  }
  list.sort((a, b) => b.ts - a.ts);
  return list.slice(0, 80);
}

export async function markNotificationRead(vault: string, id: string): Promise<void> {
  await invoke("notification_add", { vault, json: JSON.stringify({ type: "read", id, ts: Date.now() }) });
}

export async function hideNotification(vault: string, id: string): Promise<void> {
  await invoke("notification_add", { vault, json: JSON.stringify({ type: "hide", id, ts: Date.now() }) });
}

export async function markAllNotificationsRead(vault: string, ids: string[]): Promise<void> {
  await Promise.all(ids.map((id) => markNotificationRead(vault, id)));
}

// Category derivation for notifications that don't carry the structured
// intention/icon/cls fields yet — same title-sniffing heuristic as the
// phone's alertMeta.
export function notificationMeta(n: Notification): { intention: string; icon: "ask" | "fail" | "ok" | "info"; cls: "" | "a" | "r" | "g" } {
  if (n.intention || n.icon) {
    const cls = (n.cls as "" | "a" | "r" | "g" | undefined) ?? "";
    const icon = cls === "a" ? "ask" : cls === "r" ? "fail" : cls === "g" ? "ok" : "info";
    return { intention: n.intention || "Update", icon, cls };
  }
  if (n.kind === "ask") return { intention: "Needs your call", icon: "ask", cls: "a" };
  if (isFailish(n.title)) return { intention: "Something failed", icon: "fail", cls: "r" };
  if (/worker|complete|done|finished/i.test(n.title)) return { intention: "Worker deliverable", icon: "ok", cls: "g" };
  if (/stopped|idle|cost|\$/i.test(n.title)) return { intention: "Cost / cleanup", icon: "fail", cls: "r" };
  if (/brief|coach|morning|daily|check-?in/i.test(n.title)) return { intention: "Briefing", icon: "info", cls: "" };
  return { intention: "Update", icon: "info", cls: "" };
}

