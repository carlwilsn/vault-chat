// Messages Carl sends while the agent is working (Codex / Claude Code style):
//   steer  (Enter) — into the running turn at its next step;
//   queue  (Tab)   — a follow-up, after the turn ends.
// Until delivered they are chips above the composer he can edit or remove;
// delivered, they are ordinary user messages in the thread.
//
// A steer is the box's /message (pending until the box has it); a queued
// message is held by the box's engine (`queued` on the conversation) and only
// mirrored here while the POST is in flight.
import { useSyncExternalStore } from "react";
import type { ChatAttachment } from "./store";

export type PendingKind = "steer" | "queue";
export type Pending = {
  id: string;
  convId: string;
  kind: PendingKind;
  text: string;
  contextPreamble?: string;
  attachments?: ChatAttachment[];
  /** Sent, waiting for the box's answer (not editable). */
  sending?: boolean;
  /** The box's id for a queued message. */
  qid?: string;
};

let items: Pending[] = [];
const listeners = new Set<() => void>();
const emit = () => {
  items = items.slice();
  for (const l of listeners) l();
};
let seq = 0;

export function addPending(p: Omit<Pending, "id">): Pending {
  const it: Pending = { ...p, id: `pi-${Date.now().toString(36)}-${++seq}` };
  items.push(it);
  emit();
  return it;
}

export function removePending(id: string): Pending | null {
  const it = items.find((x) => x.id === id) ?? null;
  if (!it) return null;
  items = items.filter((x) => x.id !== id);
  emit();
  return it;
}

export function pendingFor(convId: string | null | undefined): Pending[] {
  return convId ? items.filter((x) => x.convId === convId) : [];
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};
const EMPTY: Pending[] = [];
let cacheKey = "";
let cacheItems: Pending[] = items;
let cacheOut: Pending[] = EMPTY;

/** The chips for a conversation (re-renders when they change). */
export function usePending(convId: string | null | undefined): Pending[] {
  return useSyncExternalStore(subscribe, () => {
    if (cacheItems === items && cacheKey === (convId ?? "")) return cacheOut;
    cacheItems = items;
    cacheKey = convId ?? "";
    const out = pendingFor(convId);
    cacheOut = out.length ? out : EMPTY;
    return cacheOut;
  });
}
