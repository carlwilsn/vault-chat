import { invoke } from "@tauri-apps/api/core";
import type { ChatMessage } from "./store";

export type ConversationSource = "manual" | "telegram" | "scheduled";
export type ConversationStatus = "idle" | "running";

export type Conversation = {
  id: string;
  title: string;
  messages: ChatMessage[];
  status: ConversationStatus;
  createdAt: number;
  lastActivityAt: number;
  source: ConversationSource;
  unread: boolean;
  // The Telegram chat_id this conversation is bound to, if any. Outbound
  // assistant replies route back to this thread, and inbound phone
  // messages route into it. Usually set on telegram-sourced convs, but a
  // schedule with "send via Telegram" also binds it onto a non-telegram
  // thread (e.g. a coach thread) so the phone becomes a window into it.
  telegramChatId?: number;
};

// Attach a Telegram chat_id to one conversation, detaching it from any
// other conversation that currently holds it. A chat_id maps to exactly
// one conversation — inbound routing picks the first match — so a stale
// duplicate would make phone replies land in the wrong thread. Source is
// left untouched: a schedule binding its (rich, non-Telegram) coach
// thread to the phone keeps running in rich mode; only the routing moves.
export function bindTelegramChatId(
  list: Conversation[],
  convId: string,
  chatId: number,
): Conversation[] {
  return list.map((c) => {
    if (c.id !== convId && c.telegramChatId === chatId) {
      return { ...c, telegramChatId: undefined };
    }
    if (c.id === convId) {
      return { ...c, telegramChatId: chatId };
    }
    return c;
  });
}

export function newConversationId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID().slice(0, 12);
  }
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function emptyConversation(): Conversation {
  const now = Date.now();
  return {
    id: newConversationId(),
    title: "New chat",
    messages: [],
    status: "idle",
    createdAt: now,
    lastActivityAt: now,
    source: "manual",
    unread: false,
  };
}


export function deriveConversationTitle(messages: ChatMessage[]): string {
  for (const m of messages) {
    if (m.role !== "user" || m.hidden) continue;
    const trimmed = (m.content ?? "").trim();
    if (!trimmed) continue;
    const firstLine = trimmed.split(/\r?\n/)[0]!;
    return firstLine.length <= 60 ? firstLine : firstLine.slice(0, 57) + "…";
  }
  return "New chat";
}

export function conversationPreview(c: Conversation): string {
  for (let i = c.messages.length - 1; i >= 0; i--) {
    const m = c.messages[i];
    if (m.hidden) continue;
    const text = (m.content ?? "").trim().replace(/\s+/g, " ");
    if (!text) continue;
    return text.length <= 120 ? text : text.slice(0, 117) + "…";
  }
  return "";
}

export async function readConversations(vault: string): Promise<Conversation[]> {
  // Conversations live in the vault on local disk; git auto-sync
  // propagates them across machines.
  const lines = await invoke<string[]>("conversations_read", { vault });
  const out: Conversation[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Conversation;
      if (!parsed || typeof parsed.id !== "string") continue;
      // Normalize legacy / partial entries. `running` state never
      // survives a restart — anything mid-run when the app died is
      // back to idle now.
      out.push({
        id: parsed.id,
        title: parsed.title ?? "New chat",
        messages: Array.isArray(parsed.messages) ? parsed.messages : [],
        status: "idle",
        createdAt: parsed.createdAt ?? Date.now(),
        lastActivityAt: parsed.lastActivityAt ?? parsed.createdAt ?? Date.now(),
        source: parsed.source ?? "manual",
        unread: parsed.unread ?? false,
        telegramChatId: parsed.telegramChatId,
      });
    } catch {
      // skip
    }
  }
  return out;
}

export async function writeConversations(
  vault: string,
  conversations: Conversation[],
): Promise<void> {
  // Persist messages, not in-flight stream state. The `status` field is
  // forced to 'idle' on read anyway.
  const lines = conversations.map((c) => JSON.stringify(c));
  await invoke("conversations_write_all", { vault, lines });
}
