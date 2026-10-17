// Phone plumbing the app calls through invoke (lib.rs:6760-6840 →
// voice_server.rs). Push subscriptions live in one JSON file, the same file
// the desktop app's voice server used (voice_server.rs:1435 subs_path); a
// missing file is simply "no subscriptions yet".
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { respondTo } from "../bus";
import { signal } from "../convlog/log";
import { loadConfig } from "../config";
import type { CommandFn } from "./registry";

let vapidPub: string | null = null;
export function vapidPublicKey(): string | null {
  return vapidPub;
}

function subsPath(): string {
  return loadConfig().pushSubsPath;
}

/** voice_server.rs:1442 push_subs_list (raw JSON array string). */
export function pushSubsList(): string {
  try {
    return readFileSync(subsPath(), "utf8");
  } catch {
    return "[]";
  }
}

function readSubs(): any[] {
  try {
    const v = JSON.parse(pushSubsList());
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function writeSubs(list: any[]): void {
  const p = subsPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(list, null, 2));
}

/** voice_server.rs:1447 push_subs_add — replace by endpoint. */
export function pushSubsAdd(sub: any): void {
  const ep = typeof sub?.endpoint === "string" ? sub.endpoint : "";
  if (!ep) return;
  const list = readSubs().filter((s) => s?.endpoint !== ep);
  list.push(sub);
  writeSubs(list);
}

/** voice_server.rs:1462 push_subs_remove. */
export function pushSubsRemove(endpoint: string): void {
  const list = readSubs();
  const next = list.filter((s) => s?.endpoint !== endpoint);
  if (next.length !== list.length) writeSubs(next);
}

/** voice_server.rs:1937 notification_append. */
export function notificationAppend(vault: string, line: string): void {
  const p = join(vault, ".vault-chat", "notifications.jsonl");
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, line.trim() + "\n");
}

export const phoneCommands: Record<string, CommandFn> = {
  // lib.rs:6760
  voice_tool_respond: ({ reqId, result }) => {
    respondTo(String(reqId), String(result ?? ""));
    return null;
  },
  // lib.rs:6812
  // The headless app's events: a vault-level signal (the notification feed). Conversation events never
  // come from here — a conversation is its event log, written by the engine alone.
  phone_broadcast: ({ json }) => {
    let ev: Record<string, unknown> = {};
    try {
      ev = JSON.parse(String(json));
    } catch {
      return null;
    }
    if (["message", "status", "runtime", "title", "meta", "chat"].includes(String(ev.type))) return null;
    signal(loadConfig().vault, ev);
    return null;
  },
  // lib.rs:6819
  phone_set_vapid: ({ key }) => {
    vapidPub = String(key);
    return null;
  },
  // lib.rs:6825
  phone_push_subs: () => pushSubsList(),
  // lib.rs:6831
  phone_push_unsub: ({ endpoint }) => {
    pushSubsRemove(String(endpoint));
    return null;
  },
  // lib.rs:6838
  notification_add: ({ vault, json }) => {
    notificationAppend(String(vault), String(json));
    return null;
  },
};
