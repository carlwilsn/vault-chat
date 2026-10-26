// The chat's intents. Every agent turn runs on the box (pi): this client sends
// the message (into the running turn, if one runs), "send now", the take-back or the stop to the box
// (boxChat.ts) and shows the box's conversation feed. With no box connected,
// or the box unreachable, nothing runs here: the chat pane says so.
import { isArchivedThread } from "./conversations";
import { useStore, type ChatAttachment, type FileUpload } from "./store";

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
 * A message still waiting for the agent's next step: "Send now" cuts the current step and it starts
 * the next turn at once (Claude Code's interrupt-and-send).
 */
export async function sendNow(convId: string, id: string): Promise<boolean> {
  const bc = await import("./boxChat");
  return bc.boxSendNow(convId, id);
}

/** Take a waiting message back before the agent reads it (its Edit or Cancel). */
export async function takeBack(convId: string, id: string): Promise<boolean> {
  const bc = await import("./boxChat");
  return bc.boxUnqueue(convId, id);
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

/** Send a message to the box: a new turn, or into the running one (at the agent's next step). */
export async function sendMessage(text: string, contextPreamble?: string, attachments?: ChatAttachment[], convId?: string, uploads?: FileUpload[]): Promise<void> {
  const s = useStore.getState();
  if (await compactCommand(text, convId ?? s.activeConversationId)) return;
  // Threads from the old missions system are archived: readable, never run.
  const t = s.conversations.find((c) => c.id === (convId ?? s.activeConversationId));
  if (t && isArchivedThread(t)) return;
  const bc = await boxReady();
  if (!bc) return;
  await bc.boxSend({ text, contextPreamble, attachments, uploads, convId: convId ?? null });
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
