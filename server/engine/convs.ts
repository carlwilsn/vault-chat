// Conversation persistence for the engine. Disk is the record (one jsonl per
// conversation, the existing format); the in-memory store mirrors it so the
// phone host's store diff emits the /poll events the phone already understands
// (message / status / title / runtime). Every change is a locked
// read-modify-write of ONE conversation, then the same object is placed in the
// store — so the store's debounced persist (which prefers memory at equal
// message counts) never writes stale meta over ours.
import { useStore, type ChatMessage } from "../../src/store";
import {
  readConversations,
  writeConversations,
  withConvLock,
  emptyConversation,
  deriveConversationTitle,
  newMessageId,
} from "../../src/conversations";
import type { EngineConv } from "./context";

export { newMessageId };

function toMemory(c: EngineConv): EngineConv {
  const mem = useStore.getState().conversations.find((x) => x.id === c.id);
  // Disk always reads back idle; keep the live run flag from memory.
  return mem ? { ...c, status: mem.status, runStartedAt: mem.runStartedAt } : c;
}

function placeInStore(c: EngineConv): void {
  const next = toMemory(c);
  useStore.setState((s) => {
    const exists = s.conversations.some((x) => x.id === c.id);
    return {
      conversations: exists ? s.conversations.map((x) => (x.id === c.id ? next : x)) : [next, ...s.conversations],
    };
  });
}

export async function readConv(vault: string, id: string): Promise<EngineConv | null> {
  const list = (await readConversations(vault)) as EngineConv[];
  return list.find((c) => c.id === id) ?? null;
}

export async function allConvs(vault: string): Promise<EngineConv[]> {
  return (await readConversations(vault)) as EngineConv[];
}

/** Locked read-modify-write of one conversation. `fn` may mutate and/or return the next value. */
export async function mutateConv(
  vault: string,
  id: string,
  fn: (c: EngineConv) => EngineConv | void,
): Promise<EngineConv | null> {
  return withConvLock(async () => {
    const list = (await readConversations(vault)) as EngineConv[];
    const cur = list.find((c) => c.id === id);
    if (!cur) return null;
    const copy: EngineConv = { ...cur, messages: [...cur.messages] };
    const next = (fn(copy) ?? copy) as EngineConv;
    await writeConversations(vault, [next]);
    placeInStore(next);
    return next;
  });
}

export async function appendMessage(vault: string, id: string, m: ChatMessage, meta: Partial<EngineConv> = {}): Promise<EngineConv | null> {
  return mutateConv(vault, id, (c) => {
    c.messages.push({ ...m, mid: m.mid ?? newMessageId() });
    Object.assign(c, meta);
    c.lastActivityAt = Date.now();
    if (c.title === "New chat") c.title = deriveConversationTitle(c.messages);
  });
}

export async function patchMeta(vault: string, id: string, meta: Partial<EngineConv>): Promise<EngineConv | null> {
  return mutateConv(vault, id, (c) => {
    Object.assign(c, meta);
  });
}

export async function createConv(vault: string, init: Partial<EngineConv>, firstText: string): Promise<EngineConv> {
  const c: EngineConv = {
    ...emptyConversation(),
    source: "phone",
    ...init,
    title: deriveConversationTitle([{ role: "user", content: firstText }]),
    state: "idle",
    costUsd: 0,
  };
  await withConvLock(async () => {
    await writeConversations(vault, [c]);
    placeInStore(c);
  });
  return c;
}

export function setLive(id: string, running: boolean): void {
  useStore.getState().setConversationStatus(id, running ? "running" : "idle");
  if (!running) useStore.getState().clearConvRuntime(id);
}

export function setRuntime(
  id: string,
  rt: { text: string; reasoning?: string; tools: { id?: string; name: string; input?: any; result?: string }[]; startedAt: number; context?: number; window?: number },
): void {
  const liveTools = rt.tools.map((t, i) => ({ id: t.id ?? String(i), name: t.name, input: t.input, result: t.result })) as any;
  const prev = useStore.getState().convRuntime[id];
  useStore.getState().setConvRuntime(id, {
    streamingText: rt.text,
    streamingReasoning: rt.reasoning ?? "",
    liveTools,
    startedAt: rt.startedAt,
    ...(rt.context ? { lastContext: rt.context } : prev?.lastContext ? { lastContext: prev.lastContext } : {}),
    ...(rt.window ? { contextWindow: rt.window } : prev?.contextWindow ? { contextWindow: prev.contextWindow } : {}),
  });
}
