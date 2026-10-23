// The chat's intents. Every agent turn runs on the box (pi): this client sends
// the message, the steer, the queue, the take-back or the stop to the box
// (boxChat.ts) and shows the box's conversation feed. With no box connected,
// or the box unreachable, nothing runs here: the chat pane says so.
import { isArchivedThread } from "./conversations";
import { useStore, type ChatAttachment } from "./store";
import type { Pending, PendingKind } from "./pendingInput";

/** The open vault's box chat, started if it is not yet. Null: no box for this vault. */
async function boxReady(): Promise<typeof import("./boxChat") | null> {
  const vault = useStore.getState().vaultPath;
  if (!vault) return null;
  const bc = await import("./boxChat");
  if (bc.boxChatOn()) return bc;
  if (!(await bc.boxLinkFor(vault))) return null;
  return (await bc.startBoxChat(vault)) ? bc : null;
}

/**
 * A message sent while the agent works (pendingInput.ts). `steer` (Enter) goes
 * into the running turn at its next step; `queue` (Tab) runs after it ends —
 * both held by the box's engine.
 */
export async function sendMidTurn(kind: PendingKind, text: string, contextPreamble?: string, attachments?: ChatAttachment[]): Promise<void> {
  if (await compactCommand(text, useStore.getState().activeConversationId)) return;
  const bc = await boxReady();
  if (!bc) return;
  await bc.boxSend({ text, contextPreamble, attachments, convId: useStore.getState().activeConversationId, mode: kind });
}

/** Take a queued message back from the box (a chip's ×, or its edit). */
export async function cancelPending(id: string): Promise<Pending | null> {
  if (!id.startsWith("box:")) return null;
  const [, convId, qid] = id.split(":");
  const bc = await import("./boxChat");
  return (await bc.boxUnqueue(convId!, qid!)) ? { id, convId: convId!, kind: "queue", text: "" } : null;
}

/** "/compact [focus]": compact the open conversation's context now (not a message to the agent). */
const COMPACT = /^\/compact(?:\s+([\s\S]*))?$/i;
async function compactCommand(text: string, convId: string | null): Promise<boolean> {
  const m = COMPACT.exec(text.trim());
  if (!m || !convId) return false;
  const bc = await boxReady();
  if (!bc) return true;
  await bc.boxCompact(convId, m[1] ?? "");
  return true;
}

/** Send a message to the box: a new turn, or a steer into the running one. */
export async function sendMessage(text: string, contextPreamble?: string, attachments?: ChatAttachment[], convId?: string): Promise<void> {
  const s = useStore.getState();
  if (await compactCommand(text, convId ?? s.activeConversationId)) return;
  // Threads from the old missions system are archived: readable, never run.
  const t = s.conversations.find((c) => c.id === (convId ?? s.activeConversationId));
  if (t && isArchivedThread(t)) return;
  const bc = await boxReady();
  if (!bc) return;
  await bc.boxSend({ text, contextPreamble, attachments, convId: convId ?? null });
}

/** Stop is the box's /kill. The thread reads running until the box says it ended. */
export function stopAgent(): void {
  const id = useStore.getState().activeConversationId;
  void import("./boxChat").then((bc) => bc.boxChatOn() && bc.boxStop(id));
}

/** A message into a running thread steers it on the box — nothing is cut short here. */
export async function interruptAndSend(text: string, contextPreamble?: string, attachments?: ChatAttachment[]): Promise<void> {
  await sendMessage(text, contextPreamble, attachments);
}

/** Clear: this surface's view of the open thread goes blank (the conversation and other surfaces keep it all). */
export function clearThread(): void {
  const id = useStore.getState().activeConversationId;
  if (id) void import("./boxChat").then((bc) => bc.boxClear(id));
}

/** "Delete": the active conversation goes. */
export function clearChat(): void {
  const s = useStore.getState();
  if (s.activeConversationId) void s.deleteConversation(s.activeConversationId);
}
