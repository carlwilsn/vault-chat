// Carl's Delete on chats in the chats list (one row, or his multi-select): the
// same in the chat pane's list and the fullscreen sidebar (src/ChatsPanel.tsx).
// On the box a delete is recoverable: a mark in each chat's log, its history
// kept (server/engine/engine.ts deleteConversations; the agent's
// RestoreConversation brings one back). Main and a project's own thread are
// never deleted.
import { useStore } from "./store";
import { MAIN_ID, projectOfThread } from "./threads";

export function canDeleteChat(id: string): boolean {
  return id !== MAIN_ID && !projectOfThread(id);
}

/** Rename a chat (its row's right-click menu). Null when done, else why not. */
export async function renameChat(id: string, title: string): Promise<string | null> {
  const want = title.trim().replace(/\s+/g, " ");
  if (!want) return "a chat needs a name";
  if (id === MAIN_ID) return "Main keeps its name";
  const local = () =>
    useStore.setState((st) => ({ conversations: st.conversations.map((c) => (c.id === id ? { ...c, title: want } : c)) }));
  const s = useStore.getState();
  if (!s.boxChat?.on) {
    local();
    return null;
  }
  const bc = await import("./boxChat");
  const r = await bc.boxRename(id, want);
  if (!r.ok) return r.error ?? "the box refused";
  // A chat the box has not heard of yet (started, nothing sent): only here; the box's row says the rest.
  local();
  return null;
}

/** Delete these chats. Null when done, else why not. */
export async function deleteChats(ids: string[]): Promise<string | null> {
  const want = [...new Set(ids)].filter(canDeleteChat);
  if (!want.length) return null;
  const s = useStore.getState();
  if (!s.boxChat?.on) {
    for (const id of want) await s.deleteConversation(id);
    return null;
  }
  const bc = await import("./boxChat");
  // One intent for the lot; the box's feed then drops them from every list (and moves a screen that was on
  // one of them to Main). A chat the box has never heard of (started, nothing sent) only goes from here.
  const r = await bc.boxDeleteMany(want);
  if (!r.ok) return r.error ?? "the box refused";
  for (const id of r.localOnly) void useStore.getState().deleteConversation(id);
  return null;
}
