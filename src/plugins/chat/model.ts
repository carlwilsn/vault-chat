// The chat pane's own state and actions (src/plugins/chat): the ⋯ menu's open state and a handle on the pane's scroll (registered by the transcript, ./Transcript.tsx). Shared by the
// header (./Header.tsx), its offers (./index.tsx) and the built-in fallback (src/ChatHeader.tsx), so what the agent does
// through PluginAct is what a click does, on screen.
import { create } from "zustand";

export const useChatMenu = create<{ open: boolean }>(() => ({ open: false }));

type Listener = (event: string, data?: unknown) => void;
const listeners = new Set<Listener>();
/** What the pane did (menuOpened, itemClicked, scrolled, ...), for the offers' events; the off. */
export function onChatEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
export function emitChatEvent(event: string, data?: unknown): void {
  for (const f of [...listeners]) {
    try {
      f(event, data);
    } catch {
      /* a listener's own failure */
    }
  }
}

export function setMenuOpen(open: boolean): void {
  if (useChatMenu.getState().open === open) return;
  useChatMenu.setState({ open });
  if (open) emitChatEvent("menuOpened");
}

/** The pane's scroll, as ./Transcript.tsx draws it: registered while the pane shows a chat. */
export type PaneScroll = {
  /** atBottom: following the newest; shown: messages drawn; total: messages in the chat; older: how many are not drawn yet;
   *  jump: the "new messages" button is shown (scrolled away while a reply comes in). */
  state(): { atBottom: boolean; shown: number; total: number; older: number; jump: boolean };
  toBottom(): void;
  /** Draw `n` more older messages (all: every one) and keep the view where it was, or go to the top. */
  older(n: number | "all", top?: boolean): void;
};
let pane: PaneScroll | null = null;
const scrollFns = new Set<() => void>();
/** The transcript registers its scroll; the off. */
export function setPaneScroll(p: PaneScroll): () => void {
  pane = p;
  paneScrolled();
  return () => {
    if (pane === p) pane = null;
    paneScrolled();
  };
}
/** The transcript's scroll moved (or older messages were drawn, or the jump button showed): the offers' watch. */
export function paneScrolled(): void {
  for (const f of [...scrollFns]) f();
}
export function onPaneScroll(fn: () => void): () => void {
  scrollFns.add(fn);
  return () => void scrollFns.delete(fn);
}
export function paneScroll(): PaneScroll | null {
  return pane;
}
