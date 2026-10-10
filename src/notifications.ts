// The in-app notification list (replaces Mission Control's Notifications tab):
// questions, finished work and failures, each opening its conversation.
//
// The feed is `.vault-chat/notifications.jsonl` — records plus read / hide /
// answered / clear markers, folded the way server/phoneData.ts
// notificationsFeed folds them for the phone. In box mode the box owns the
// file, so the list and the read markers go through the box's
// `/notifications` routes; otherwise the file is read and appended here.
import { invoke } from "@tauri-apps/api/core";
import { boxLinkFor, boxGet, boxPost } from "./boxChat";

export type NotifKind = "question" | "done" | "failed" | "info";

export type Notification = {
  id: string;
  ts: number;
  kind: NotifKind;
  title: string;
  body: string;
  convId?: string;
  read: boolean;
  answeredWith?: string;
};

const FAILISH = /\b(fail|failed|failure|error|crash|blocked|diverg)/i;
const DONEISH = /^(done|finished|complete)\b|\bdone\b|✓/i;

/** What a record is about, from its structured fields first. */
export function notifKind(v: { kind?: unknown; title?: unknown; cls?: unknown }): NotifKind {
  const title = typeof v.title === "string" ? v.title : "";
  if (v.kind === "ask") return "question";
  if (v.cls === "r" || /^blocked\b/i.test(title) || FAILISH.test(title)) return "failed";
  if (v.cls === "g" || DONEISH.test(title)) return "done";
  return "info";
}

function normMs(ts: number): number {
  while (ts >= 1e14) ts = Math.floor(ts / 1000);
  return ts;
}

/** notificationsFeed (server/phoneData.ts), for the local file. */
export function foldNotifications(raw: string): Notification[] {
  const read = new Set<string>();
  const hidden = new Set<string>();
  const answered = new Map<string, string>();
  let clearBefore = 0;
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
    const id = typeof v.id === "string" ? v.id : null;
    switch (v.type) {
      case "read":
        if (id) read.add(id);
        break;
      case "answered":
        if (id) {
          read.add(id);
          answered.set(id, typeof v.answer === "string" ? v.answer : "");
        }
        break;
      case "hide":
        if (id) hidden.add(id);
        break;
      case "clear":
        if (typeof v.ts === "number") clearBefore = Math.max(clearBefore, v.ts);
        break;
      case "followup":
        break;
      default:
        if (id) byId.set(id, v);
    }
  }
  const out: Notification[] = [];
  for (const [id, v] of byId) {
    if (hidden.has(id)) continue;
    const ts = typeof v.ts === "number" ? normMs(v.ts) : 0;
    if (read.has(id) && ts <= clearBefore) continue;
    out.push(fromRecord({ ...v, id, ts, read: read.has(id), answeredWith: answered.get(id) }));
  }
  out.sort((a, b) => b.ts - a.ts);
  return out.slice(0, 80);
}

function fromRecord(v: Record<string, unknown>): Notification {
  return {
    id: String(v.id),
    ts: typeof v.ts === "number" ? normMs(v.ts) : 0,
    kind: notifKind(v),
    title: typeof v.title === "string" ? v.title : "",
    body: typeof v.summary === "string" && v.summary ? v.summary : typeof v.body === "string" ? v.body : "",
    convId: typeof v.convId === "string" && v.convId ? v.convId : undefined,
    read: v.read === true,
    answeredWith: typeof v.answeredWith === "string" ? v.answeredWith : undefined,
  };
}

export async function readNotifications(vault: string): Promise<Notification[]> {
  const link = await boxLinkFor(vault);
  if (link) {
    const d = await boxGet(link, "/notifications");
    const list: Record<string, unknown>[] = Array.isArray(d?.notifications) ? d.notifications : [];
    return list.filter((v) => typeof v.id === "string").map(fromRecord);
  }
  const raw = await invoke<string>("read_text_file", { path: `${vault}/.vault-chat/notifications.jsonl` }).catch(() => "");
  return foldNotifications(raw);
}

export async function markNotificationRead(vault: string, id: string): Promise<void> {
  const link = await boxLinkFor(vault);
  if (link) {
    await boxPost(link, "/notifications/read", { id });
    return;
  }
  await invoke("notification_add", { vault, json: JSON.stringify({ type: "read", id, ts: Date.now() }) }).catch(() => {});
}
