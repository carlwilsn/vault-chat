import { runAgent } from "./agent";
import { findModel, AUTO_MODEL_ID, resolveAutoModel, getLiveCatalog } from "./providers";
import {
  readConversations,
  writeConversations,
  emptyConversation,
  deriveConversationTitle,
  newConversationId,
  type Conversation,
} from "./conversations";
import { sendTelegramMessage, sendTelegramReplyWithImages } from "./telegram";
import { useStore, type ChatMessage, type LiveTool } from "./store";

// Minimum gap between Telegram progress pings during a long headless run,
// so the phone gets "still working" signal without being spammed.
const PROGRESS_MIN_GAP_MS = 25_000;

// Off-vault inbound handler. Runs the full Telegram round-trip for
// a vault that is NOT currently open in the UI: load that vault's
// conversations from disk, route the user message into the right
// conversation, run the agent fully headless, persist the reply,
// and send it back to Telegram via that vault's bot token.
//
// The UI is never touched — the active vault's store stays
// completely untouched. The user only sees off-vault activity by
// switching to that vault later, where they'll find the new
// messages already persisted.

export async function handleOffVaultInbound(
  vault: string,
  chatId: number,
  userText: string,
  fromUsername: string | null,
  photoFileIds: string[] = [],
): Promise<void> {
  const trimmed = userText.trim();
  // Slash commands work for any vault — pure state mutation +
  // Telegram reply, no agent needed.
  if (await handleOffVaultSlashCommand(vault, chatId, trimmed, fromUsername)) return;

  const store = useStore.getState();
  // Telegram inbound is by definition telegram-sourced — use the
  // cheaper default model. User overrides in Settings → Telegram.
  const { getTelegramModelId } = await import("./telegram");
  const modelId = getTelegramModelId();
  const spec = findModel(modelId);
  const apiKey = spec ? store.apiKeys[spec.provider] : undefined;
  if (!spec || !apiKey) {
    await sendTelegramMessage(
      vault,
      chatId,
      "(error: no model / API key configured in vault-chat)",
    ).catch(() => {});
    return;
  }

  // First write: persist the user message so it isn't lost if the
  // agent run blows up partway through.
  // Download phone-sent photos before persisting the user turn.
  const attachments: import("./store").ChatAttachment[] = [];
  if (photoFileIds.length > 0) {
    const { downloadTelegramPhoto, readImageAsAttachment } = await import(
      "./telegram"
    );
    for (const fid of photoFileIds) {
      try {
        const path = await downloadTelegramPhoto(vault, fid);
        const att = await readImageAsAttachment(path);
        attachments.push(att);
      } catch (e) {
        console.warn("[off-vault] photo download failed:", e);
      }
    }
  }

  const list = await readConversations(vault);
  let idx = list.findIndex((c) => c.telegramChatId === chatId);
  if (idx < 0) {
    const fresh: Conversation = {
      ...emptyConversation(),
      source: "telegram",
      telegramChatId: chatId,
      title: fromUsername
        ? `Telegram · @${fromUsername}`
        : deriveConversationTitle([{ role: "user", content: userText }]),
    };
    list.unshift(fresh);
    idx = 0;
  }
  const userMsg: ChatMessage = {
    role: "user",
    content: userText || (attachments.length > 0 ? "(image)" : ""),
    attachments: attachments.length > 0 ? attachments : undefined,
  };
  list[idx] = {
    ...list[idx]!,
    messages: [...list[idx]!.messages, userMsg],
    lastActivityAt: Date.now(),
  };
  await writeConversations(vault, list);

  // Run the agent. No store updates — onEvent only accumulates the
  // final assistant text and any tool calls into local buffers.
  let acc = "";
  const tools: LiveTool[] = [];
  const baseHistory = list[idx]!.messages
    .filter((m) => !m.system)
    .map((m) => ({ role: m.role, content: m.content }));

  // Live progress to the phone so a slow run doesn't strand the user.
  let lastProgressAt = 0;
  const notify = (text: string) => {
    void sendTelegramMessage(vault, chatId, text).catch(() => {});
  };

  try {
    await runAgent({
      modelId,
      apiKey,
      vault,
      history: baseHistory,
      userMessage: trimmed,
      userAttachments: attachments.length > 0 ? attachments : undefined,
      tavilyKey: store.serviceKeys.tavily,
      strictVault: store.strictVaultMode,
      bashDisabled: store.bashDisabled,
      voiceMode: false,
      telegramMode: true,
      conversationId: list[idx]?.id,
      isTelegramSourced: true,
      onEvent: (e) => {
        if (e.kind === "text") {
          acc += e.delta;
        } else if (e.kind === "tool_use") {
          tools.push({
            id: e.id,
            name: e.name,
            input: e.input,
            startedAt: Date.now(),
          });
          const now = Date.now();
          if (now - lastProgressAt > PROGRESS_MIN_GAP_MS) {
            lastProgressAt = now;
            notify(`🔧 ${e.name}…`);
          }
        } else if (e.kind === "tool_result") {
          const t = tools.find((x) => x.id === e.id);
          if (t) t.result = e.result;
        } else if (e.kind === "error") {
          acc = (acc + `\n\n⚠️ ${e.message}`).trim();
          notify(`⚠️ ${e.message}`);
        }
      },
    });
  } catch (e) {
    acc = (acc + `\n\n⚠️ off-vault run failed: ${String(e)}`).trim();
    notify(`⚠️ off-vault run failed: ${String(e)}`);
  }

  // Second write: persist the assistant reply. Re-read to avoid
  // clobbering any other writer (different vault). Match by chat_id
  // again in case the conversation got rotated between writes.
  const finalList = await readConversations(vault);
  let fi = finalList.findIndex((c) => c.telegramChatId === chatId);
  if (fi < 0) fi = 0;
  if (finalList[fi]) {
    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: acc,
      toolCalls: tools.length ? tools : undefined,
    };
    finalList[fi] = {
      ...finalList[fi]!,
      messages: [...finalList[fi]!.messages, assistantMsg],
      lastActivityAt: Date.now(),
      unread: true,
    };
    await writeConversations(vault, finalList);
  }

  // Surface the reply (and its tool calls) live if the user is on this vault.
  if (finalList[fi]) {
    await useStore
      .getState()
      .refreshConversationFromDisk(vault, finalList[fi]!.id)
      .catch(() => {});
  }

  if (acc.trim()) {
    await sendTelegramReplyWithImages(vault, chatId, acc).catch((e) =>
      console.warn("[off-vault] telegram send failed:", e),
    );
  }
}

// Scheduler fire for a non-active vault. Same disk-only contract as
// handleOffVaultInbound but the trigger is a schedule, not a Telegram
// message. If the target conversation is telegram-sourced and the
// schedule has sendViaTelegram on, the reply also goes to the phone.
export async function runScheduledHeadlessTurn(
  vault: string,
  conversationId: string,
  prompt: string,
  opts: { sendViaTelegram: boolean; modelId?: string },
): Promise<void> {
  const store = useStore.getState();
  // Model precedence: the schedule's pinned model wins (it was chosen for
  // a reason — e.g. Opus for a heavy weekly sweep). Only fall back to the
  // cheaper Telegram brain when the schedule didn't pin one AND the reply
  // is Telegram-bound. Resolve the "auto" sentinel to a concrete model so
  // the headless run doesn't silently no-op on a missing model.
  let modelId = opts.modelId || store.modelId;
  if (!opts.modelId && opts.sendViaTelegram) {
    const { getTelegramModelId } = await import("./telegram");
    modelId = getTelegramModelId();
  }
  if (modelId === AUTO_MODEL_ID) {
    modelId = resolveAutoModel(prompt, store.apiKeys, getLiveCatalog())?.id ?? modelId;
  }
  const spec = findModel(modelId);
  const apiKey = spec ? store.apiKeys[spec.provider] : undefined;
  if (!spec || !apiKey) {
    console.warn("[scheduler] headless run: no model/key configured");
    return;
  }

  const list = await readConversations(vault);
  let idx = list.findIndex((c) => c.id === conversationId);
  if (idx < 0) {
    // The schedule's target conversation no longer exists on disk —
    // fall back to creating a fresh one rather than dropping the run.
    const fresh: Conversation = {
      ...emptyConversation(),
      id: conversationId,
      source: "scheduled",
      title: deriveConversationTitle([{ role: "user", content: prompt }]),
    };
    list.unshift(fresh);
    idx = 0;
  }
  const userMsg: ChatMessage = { role: "user", content: prompt };
  list[idx] = {
    ...list[idx]!,
    messages: [...list[idx]!.messages, userMsg],
    lastActivityAt: Date.now(),
  };
  await writeConversations(vault, list);

  const isTelegramSourced = list[idx]!.source === "telegram";
  const telegramChatId = list[idx]!.telegramChatId;

  let acc = "";
  const tools: LiveTool[] = [];
  const baseHistory = list[idx]!.messages
    .filter((m) => !m.system)
    .map((m) => ({ role: m.role, content: m.content }));

  // Live progress to the phone so a slow run doesn't strand the user.
  // Only when the run is Telegram-bound and the conversation has a chat.
  let lastProgressAt = 0;
  const notify = (text: string) => {
    if (!opts.sendViaTelegram || telegramChatId === undefined) return;
    void sendTelegramMessage(vault, telegramChatId, text).catch(() => {});
  };

  try {
    await runAgent({
      modelId,
      apiKey,
      vault,
      history: baseHistory,
      userMessage: prompt,
      tavilyKey: store.serviceKeys.tavily,
      strictVault: store.strictVaultMode,
      bashDisabled: store.bashDisabled,
      voiceMode: false,
      telegramMode: isTelegramSourced && opts.sendViaTelegram,
      conversationId,
      isTelegramSourced: isTelegramSourced && opts.sendViaTelegram,
      onEvent: (e) => {
        if (e.kind === "text") acc += e.delta;
        else if (e.kind === "tool_use") {
          tools.push({
            id: e.id,
            name: e.name,
            input: e.input,
            startedAt: Date.now(),
          });
          const now = Date.now();
          if (now - lastProgressAt > PROGRESS_MIN_GAP_MS) {
            lastProgressAt = now;
            notify(`🔧 ${e.name}…`);
          }
        } else if (e.kind === "tool_result") {
          const t = tools.find((x) => x.id === e.id);
          if (t) t.result = e.result;
        } else if (e.kind === "error") {
          acc = (acc + `\n\n⚠️ ${e.message}`).trim();
          notify(`⚠️ ${e.message}`);
        }
      },
    });
  } catch (e) {
    acc = (acc + `\n\n⚠️ scheduled run failed: ${String(e)}`).trim();
    notify(`⚠️ scheduled run failed: ${String(e)}`);
  }

  const finalList = await readConversations(vault);
  let fi = finalList.findIndex((c) => c.id === conversationId);
  if (fi < 0) fi = 0;
  if (finalList[fi]) {
    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: acc,
      toolCalls: tools.length ? tools : undefined,
    };
    finalList[fi] = {
      ...finalList[fi]!,
      messages: [...finalList[fi]!.messages, assistantMsg],
      lastActivityAt: Date.now(),
      unread: true,
    };
    await writeConversations(vault, finalList);
  }

  // If the user is on this vault right now, surface the result (and its
  // tool calls) live without yanking their focus.
  await useStore
    .getState()
    .refreshConversationFromDisk(vault, conversationId)
    .catch(() => {});

  if (acc.trim() && opts.sendViaTelegram && telegramChatId !== undefined) {
    await sendTelegramReplyWithImages(vault, telegramChatId, acc).catch((e) =>
      console.warn("[scheduler] telegram send failed:", e),
    );
  }
}

// Create a fresh conversation entry on disk for a vault that's not
// currently in memory. Returns the new conversation's id so the
// scheduler can bind subsequent runs to it.
export async function createScheduledConversationOnDisk(
  vault: string,
  title: string,
): Promise<string> {
  const list = await readConversations(vault);
  const fresh: Conversation = {
    ...emptyConversation(),
    id: newConversationId(),
    source: "scheduled",
    title,
  };
  list.unshift(fresh);
  await writeConversations(vault, list);
  return fresh.id;
}

// Slash command handler for off-vault chats. Mirrors the active-
// vault logic in App.tsx, but operates directly on the on-disk
// conversations list. Returns true if the command was handled.
async function handleOffVaultSlashCommand(
  vault: string,
  chatId: number,
  trimmedText: string,
  fromUsername: string | null,
): Promise<boolean> {
  const isCommand =
    /^\/(new|start|reset|help)\b/i.test(trimmedText);
  if (!isCommand) return false;

  if (/^\/help\b/i.test(trimmedText)) {
    await sendTelegramMessage(
      vault,
      chatId,
      "Commands:\n/new (or /start) — start a fresh conversation; the old one stays in vault-chat\n/reset — list recent conversations and switch back to one (/reset N)\n/help — this message\n\nNote: clearing chat history on your phone is invisible to the bot — use /new to actually reset on the vault-chat side.",
    ).catch(() => {});
    return true;
  }

  if (/^\/(new|start)\b/i.test(trimmedText)) {
    const list = await readConversations(vault);
    // Detach existing chat_id binding, if any.
    for (let i = 0; i < list.length; i++) {
      if (list[i]!.telegramChatId === chatId) {
        list[i] = { ...list[i]!, telegramChatId: undefined };
      }
    }
    const fresh: Conversation = {
      ...emptyConversation(),
      source: "telegram",
      telegramChatId: chatId,
      title: fromUsername ? `Telegram · @${fromUsername}` : "New chat",
    };
    list.unshift(fresh);
    await writeConversations(vault, list);
    await sendTelegramMessage(
      vault,
      chatId,
      "Started a new chat — fresh context. The old conversation is still in vault-chat under Recent.",
    ).catch(() => {});
    return true;
  }

  if (/^\/reset\b/i.test(trimmedText)) {
    const argMatch = trimmedText.match(/^\/reset\s+(\d+)\s*$/i);
    const list = await readConversations(vault);
    const sorted = list
      .slice()
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      .slice(0, 10);
    if (argMatch) {
      const idx = parseInt(argMatch[1]!, 10) - 1;
      const target = sorted[idx];
      if (!target) {
        await sendTelegramMessage(
          vault,
          chatId,
          `No conversation #${idx + 1}. Send /reset alone to see the list.`,
        ).catch(() => {});
        return true;
      }
      const updated = list.map((c) => {
        if (c.telegramChatId === chatId && c.id !== target.id) {
          return { ...c, telegramChatId: undefined };
        }
        if (c.id === target.id) {
          return {
            ...c,
            source: "telegram" as const,
            telegramChatId: chatId,
          };
        }
        return c;
      });
      await writeConversations(vault, updated);
      await sendTelegramMessage(
        vault,
        chatId,
        `Reattached to: ${target.title || "New chat"}\nNext messages from your phone land in that conversation.`,
      ).catch(() => {});
      return true;
    }
    if (sorted.length === 0) {
      await sendTelegramMessage(vault, chatId, "No conversations yet.").catch(() => {});
      return true;
    }
    const fmtAge = (ts: number) => {
      const diff = Date.now() - ts;
      const min = Math.floor(diff / 60_000);
      if (min < 60) return `${Math.max(1, min)}m`;
      const hr = Math.floor(min / 60);
      if (hr < 24) return `${hr}h`;
      return `${Math.floor(hr / 24)}d`;
    };
    const lines = sorted.map(
      (c, i) =>
        `${i + 1}. ${c.title || "New chat"} · ${fmtAge(c.lastActivityAt)}${
          c.telegramChatId === chatId ? " (current)" : ""
        }`,
    );
    await sendTelegramMessage(
      vault,
      chatId,
      `Recent conversations:\n${lines.join("\n")}\n\nReply /reset <N> to switch to one.`,
    ).catch(() => {});
    return true;
  }

  return false;
}
