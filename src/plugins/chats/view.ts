// The chat list's own view state that is not saved: how far each place's list is opened ("Show more" / "Show all",
// a level per place: src/threads.ts visibleChats). Kept by the plugin, outside React, so the list on screen and the
// plugin's offers (src/plugins/chats/index.tsx) share it: the agent reads and sets it, the list shows it. Session
// state, as before: a place that closes forgets it (src/plugins/chats/ChatsList.tsx ThreadRow).
import { useSyncExternalStore } from "react";

const levels = new Map<string, number>();
const fns = new Set<() => void>();
const changed = () => {
  for (const f of [...fns]) f();
};

export const chatLevels = {
  get: (place: string): number => levels.get(place) ?? 0,
  set(place: string, level: number): void {
    if ((levels.get(place) ?? 0) === level) return;
    if (level <= 0) levels.delete(place);
    else levels.set(place, level);
    changed();
  },
  delete(place: string): void {
    if (levels.delete(place)) changed();
  },
  subscribe(fn: () => void): () => void {
    fns.add(fn);
    return () => void fns.delete(fn);
  },
};

/** One place's level, live. */
export function useChatLevel(place: string): number {
  const get = () => chatLevels.get(place);
  return useSyncExternalStore(chatLevels.subscribe, get, get);
}
