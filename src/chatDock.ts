// The docked chat panel on the right (src/App.tsx), as before tiles (Carl 11-26): the active chat with its composer,
// outside the tile area (Ctrl+Shift+B, the title bar's button, box:workspace open / closeRightPanel; store
// rightCollapsed). The chat list is the 272 px overlay from the right edge, over everything (store showChatsPanel;
// src/plugins/chats ChatsOverlay: Esc, a click outside or picking a chat closes it), shown by itself: it never opens the
// dock. Its footer's Chats button, Ctrl+Shift+C, box:workspace chatSidebar and the chats openPanel / closePanel toggle
// it (one path: toggleChatsList).
import { useStore } from "./store";
import { useTiles } from "./tiles";
import { newChatIn, placeOfChat } from "./chat-controller";
import { pressToDrag } from "./tileDrag";
import { HEAD_CONTROLS } from "./TileTitle";

/** Show or hide the chat list's overlay (`open`: as asked; left out: the other way). Only the overlay: the docked chat
 *  panel stays as it is; a chat picked from it with the panel closed opens the panel (openChatDock). */
export function toggleChatsList(open?: boolean): void {
  const s = useStore.getState();
  // The full-screen chat frame (the popout window's, src/plugins/chat/Frame.tsx) has the list as its own sidebar.
  if (s.chatFullscreen) {
    if ((open ?? !s.chatSidebarOpen) !== s.chatSidebarOpen) s.toggleChatSidebar();
    return;
  }
  const want = open ?? !s.showChatsPanel;
  if (want !== s.showChatsPanel) s.setShowChatsPanel(want);
}

/** Whether the chat list is shown (toggleChatsList's own record). */
export const chatsListShown = (s = useStore.getState()): boolean => (s.chatFullscreen ? s.chatSidebarOpen : s.showChatsPanel);

// ---------------------------------------------------------------- the docked chat moves into the tiles and back
// (Carl 11-26). Its header row drags it out like any tile (startChatDockDrag); wherever the docked chat lands in a
// tile (that drag, a list row of it, the agent's openInPane / newChat), it moves: the dock closes (watchDockedChat).
// Ctrl+Shift+B (toggleChatDock) then opens the dock on a new chat in the same place; the tile stays.

/** The chat tile showing the dock's chat (the active one), or null. */
function dockChatTile(): string | null {
  const id = useStore.getState().activeConversationId;
  return useTiles.getState().slots.find((s) => s.content?.type === "chat" && s.content.chatId === id)?.id ?? null;
}

/** Ctrl+Shift+B, the title bar's button, the agent's open / closeRightPanel: show or hide the docked chat. Opened
 *  while its chat is in a tile (dragged out): the tile stays, and the dock opens on a new chat in the same place
 *  (its project, or Main) (Carl 11-26). */
export function toggleChatDock(open?: boolean): void {
  const s = useStore.getState();
  if (s.popoutOpen) return;
  const want = open ?? s.rightCollapsed;
  if (want && s.rightCollapsed && dockChatTile() && s.activeConversationId) newChatIn(placeOfChat(s.activeConversationId));
  if (want === useStore.getState().rightCollapsed) useStore.getState().toggleRight();
}

/** Open the dock on the active chat as it is (a chat picked from the list, a new chat started from it or by the agent's
 *  newChat): no new chat, unlike toggleChatDock. */
export function openChatDock(): void {
  const s = useStore.getState();
  if (s.rightCollapsed && !s.popoutOpen) s.toggleRight();
}

/** At start, the dock as it was kept (the box's layout chatPanel.open, a core swap's own). A layout from before the
 *  dock came back (no record of it): open, unless a tile already shows the active chat (its chat is on screen as it
 *  was left; Ctrl+Shift+B then opens a new chat beside it). */
export function restoreChatDock(open: boolean | undefined): void {
  const s = useStore.getState();
  if (s.popoutOpen) return;
  const want = open ?? !dockChatTile();
  if (want === s.rightCollapsed) s.toggleRight();
}

/** The dock's chat put in a tile (by any path): the dock closes, the chat moved. Returns the undo. */
export function watchDockedChat(): () => void {
  let had = dockChatTile();
  let active = useStore.getState().activeConversationId;
  const check = () => {
    const now = dockChatTile();
    const act = useStore.getState().activeConversationId;
    // Only a tile that appeared for the same chat moves it (picking a chat already in a tile does not).
    if (now && !had && act === active && !useStore.getState().rightCollapsed) useStore.getState().toggleRight();
    had = now;
    active = act;
  };
  const offT = useTiles.subscribe(check);
  const offS = useStore.subscribe((s, p) => void (s.activeConversationId !== p.activeConversationId && check()));
  return () => (offT(), offS());
}

/** The docked chat's header row (not its controls) drags the chat out into the tiles, as a tile's own row does. */
export function startChatDockDrag(): () => void {
  const down = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const t = e.target as Element | null;
    const dock = t?.closest?.('[data-el="chat-dock"]');
    const head = t?.closest?.('[data-el="chat-header"]');
    if (!dock || !head || !dock.contains(head) || t?.closest(HEAD_CONTROLS)) return;
    const s = useStore.getState();
    const id = s.activeConversationId;
    if (!id) return;
    e.preventDefault();
    const title = id === "main" ? "Main" : s.conversations.find((c) => c.id === id)?.title || "Chat";
    pressToDrag(e, { kind: "chat", chatId: id, title }, head);
  };
  document.addEventListener("pointerdown", down, true);
  return () => document.removeEventListener("pointerdown", down, true);
}
