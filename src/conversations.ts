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
  // Telegram-source conversations remember the chat_id so outbound
  // assistant replies can be routed back to the same Telegram thread.
  telegramChatId?: number;
};

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
  // In cross-sync client mode the conversations live on the daemon —
  // read those instead so both machines stay in sync. The daemon
  // serves vaults by their stable vault-id (.vault-chat/vault-id);
  // if the daemon doesn't know about this vault (DaemonVaultNotFound),
  // fall back to local disk so non-synced vaults still work.
  try {
    const { isClientMode, clientFetchConversations, DaemonVaultNotFound } = await import("./crossSync");
    if (isClientMode()) {
      try {
        return await clientFetchConversations(vault);
      } catch (e) {
        if (e instanceof DaemonVaultNotFound) {
          // Vault isn't synced — read local as if standalone.
        } else {
          throw e;
        }
      }
    }
  } catch {
    // crossSync module unavailable or daemon unreachable — fall back
    // to local disk so the app degrades gracefully.
  }
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
  try {
    const { isClientMode, clientPushConversations, DaemonVaultNotFound } = await import("./crossSync");
    if (isClientMode()) {
      try {
        await clientPushConversations(vault, conversations);
        return;
      } catch (e) {
        if (e instanceof DaemonVaultNotFound) {
          // Vault isn't synced — write local instead.
        } else {
          throw e;
        }
      }
    }
  } catch {
    // fall through to local write
  }
  await invoke("conversations_write_all", { vault, lines });
}
