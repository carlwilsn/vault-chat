// Messages Carl sends while the agent is working (Codex / Claude Code style):
//   steer  (Enter) — into the running turn at its next step;
//   queue  (Tab)   — a follow-up, after the turn ends.
// Until delivered they are chips above the composer he can edit or remove;
// delivered, they are ordinary user messages in the thread.
//
// Local mode (this laptop runs the agent): this list IS the queue — the agent
// loop takes the steers between steps (agent.ts prepareStep → takeSteers) and
// chat-controller starts the next queued one when a turn ends (takeNext).
// Box mode: a steer is the box's /message (pending until the box has it), a
// queued message is held by the box's engine (`queued` on the conversation)
// and only mirrored here while the POST is in flight.
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
  /** Box mode: sent, waiting for the box's answer (not editable). */
  sending?: boolean;
  /** Box mode: the box's id for a queued message. */
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

export function patchPending(id: string, patch: Partial<Pending>): void {
  const i = items.findIndex((x) => x.id === id);
  if (i < 0) return;
  items[i] = { ...items[i]!, ...patch };
  emit();
}

export function pendingFor(convId: string | null | undefined): Pending[] {
  return convId ? items.filter((x) => x.convId === convId) : [];
}

/** Every steer waiting for this conversation's running turn, taken (delivered). */
export function takeSteers(convId: string): Pending[] {
  const out = items.filter((x) => x.convId === convId && x.kind === "steer" && !x.sending);
  if (!out.length) return out;
  items = items.filter((x) => !out.includes(x));
  emit();
  return out;
}

/** The turn ended: the next thing to run — a steer it never reached first, else the oldest queued. */
export function takeNext(convId: string): Pending | null {
  const mine = items.filter((x) => x.convId === convId && !x.sending);
  const it = mine.find((x) => x.kind === "steer") ?? mine[0] ?? null;
  if (it) removePending(it.id);
  return it;
}

export function clearPending(convId?: string): void {
  items = convId ? items.filter((x) => x.convId !== convId) : [];
  emit();
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
