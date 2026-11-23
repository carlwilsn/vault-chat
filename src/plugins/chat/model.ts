// The chat pane's own state and actions (src/plugins/chat): the ⋯ menu's open state, which memory its Memory entry
// opens, and a handle on the pane's scroll (registered by the transcript, ./Transcript.tsx). Shared by the
// header (./Header.tsx), its offers (./index.tsx) and the built-in fallback (src/ChatHeader.tsx), so what the agent does
// through PluginAct is what a click does, on screen.
import { create } from "zustand";
import { useStore } from "../../store";
import { MAIN_ID, projectOfThread } from "../../threads";
import { MEMORY_REL, MEMORY_SLUG, nameFromSlug, openProjectNotes } from "../../projects";

export const useChatMenu = create<{ open: boolean }>(() => ({ open: false }));

type Listener = (event: string, data?: unknown) => void;
const listeners = new Set<Listener>();
/** What the pane did (menuOpened, memoryOpened, itemClicked, scrolled, ...), for the offers' events; the off. */
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

/** Which memory the Memory entry opens for the open chat: Main's (.vault-chat/MEMORY.md) for Main and chats in no
 *  project, the project's own for a project's thread or a chat in a project. One entry either way (U24). */
export type MemoryTarget = { kind: "main"; slug: typeof MEMORY_SLUG; name: "Memory"; file: string } | { kind: "project"; slug: string; name: string; file: string };
export function memoryTarget(names: (slug: string) => string = nameFromSlug): MemoryTarget {
  const s = useStore.getState();
  const id = s.activeConversationId;
  const conv = s.conversations.find((c) => c.id === id);
  const slug = id === MAIN_ID ? null : (projectOfThread(id) ?? conv?.project ?? null);
  if (!slug) return { kind: "main", slug: MEMORY_SLUG, name: "Memory", file: MEMORY_REL };
  return { kind: "project", slug, name: names(slug) || nameFromSlug(slug), file: `the project's memory (${slug})` };
}

/** Open the open chat's memory in the viewer (fullscreen chat leaves for it). The path, or null (the popout hands it to
 *  the main window). */
export async function openChatMemory(names?: (slug: string) => string): Promise<{ target: MemoryTarget; path: string | null }> {
  const t = memoryTarget(names);
  setMenuOpen(false);
  const path = await openProjectNotes(t.slug, t.name);
  emitChatEvent("memoryOpened", { kind: t.kind, ...(t.kind === "project" ? { project: t.slug } : {}), path });
  return { target: t, path };
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
