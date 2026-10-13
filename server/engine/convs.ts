// Conversation persistence for the engine. Disk is the record (one jsonl per
// conversation, the existing format); the in-memory store mirrors it so the
// phone host's store diff emits the /poll events the phone already understands
// (message / status / title / runtime). Every change is a locked
// read-modify-write of ONE conversation, then the same object is placed in the
// store — so the store's debounced persist (which prefers memory at equal
// message counts) never writes stale meta over ours.
//
// The store holds the main vault only (its persist writes there). Every other
// vault on the box keeps its conversations in a VaultMirror of its own, whose
// diff sends the same /poll events tagged with that vault's name.
import { useStore, type ChatMessage, type ConvRuntime } from "../../src/store";
import {
  readConversations,
  writeConversations,
  withConvLock,
  emptyConversation,
  deriveConversationTitle,
  newMessageId,
} from "../../src/conversations";
import { makeConvDiff } from "../../src/convDiff";
import type { EngineConv } from "./context";

export { newMessageId };

/** Another vault's conversations in memory, and its /poll diff. */
export class VaultMirror {
  conversations: EngineConv[] = [];
  convRuntime: Record<string, ConvRuntime> = {};
  private timer: NodeJS.Timeout | null = null;
  private diff: () => void;
  constructor(seed: EngineConv[], broadcast: (ev: Record<string, unknown>) => void, onRunEnded?: (convId: string) => void) {
    this.conversations = seed.map((c) => ({ ...c, status: "idle" }) as EngineConv);
    this.diff = makeConvDiff(() => this, broadcast, onRunEnded);
    this.diff(); // seed: a fresh boot doesn't replay the history
  }
  changed(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.diff();
    }, 250);
    this.timer.unref?.();
  }
}

const mirrors = new Map<string, VaultMirror>();

/** The mirror of a vault that is not the store's (created silent when nobody opened it). */
export function openMirror(vault: string, seed: EngineConv[] = [], broadcast: (ev: Record<string, unknown>) => void = () => {}, onRunEnded?: (convId: string) => void): VaultMirror {
  let m = mirrors.get(vault);
  if (!m) {
    m = new VaultMirror(seed, broadcast, onRunEnded);
    mirrors.set(vault, m);
  }
  return m;
}

function inStore(vault: string): boolean {
  return useStore.getState().vaultPath === vault;
}

/** Patch one conversation's in-memory copy in a mirrored vault (projectRoutes). */
export function mirrorPatch(vault: string, id: string, patch: Partial<EngineConv>): void {
  const m = openMirror(vault);
  m.conversations = m.conversations.map((c) => (c.id === id ? ({ ...c, ...patch } as EngineConv) : c));
  m.changed();
}

function memList(vault: string): EngineConv[] {
  return inStore(vault) ? (useStore.getState().conversations as EngineConv[]) : openMirror(vault).conversations;
}

function toMemory(vault: string, c: EngineConv): EngineConv {
  const mem = memList(vault).find((x) => x.id === c.id);
  // Disk always reads back idle; keep the live run flag from memory.
  return mem ? { ...c, status: mem.status, runStartedAt: mem.runStartedAt } : c;
}

function placeInStore(vault: string, c: EngineConv): void {
  const next = toMemory(vault, c);
  const place = (list: EngineConv[]) => (list.some((x) => x.id === c.id) ? list.map((x) => (x.id === c.id ? next : x)) : [next, ...list]);
  if (inStore(vault)) {
    useStore.setState((s) => ({ conversations: place(s.conversations as EngineConv[]) }));
    return;
  }
  const m = openMirror(vault);
  m.conversations = place(m.conversations);
  m.changed();
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
    placeInStore(vault, next);
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
    placeInStore(vault, c);
  });
  return c;
}

export function setLive(vault: string, id: string, running: boolean): void {
  if (inStore(vault)) {
    useStore.getState().setConversationStatus(id, running ? "running" : "idle");
    if (!running) useStore.getState().clearConvRuntime(id);
    return;
  }
  // The store's setConversationStatus, for a mirror: the run start stamped once on idle→running.
  const m = openMirror(vault);
  m.conversations = m.conversations.map((c) => {
    if (c.id !== id) return c;
    if (running) return { ...c, status: "running", runStartedAt: c.status === "running" && c.runStartedAt ? c.runStartedAt : Date.now() } as EngineConv;
    return { ...c, status: "idle", runStartedAt: undefined } as EngineConv;
  });
  if (!running && id in m.convRuntime) {
    const { [id]: _gone, ...rest } = m.convRuntime;
    m.convRuntime = rest;
  }
  m.changed();
}

export function setRuntime(
  vault: string,
  id: string,
  rt: { text: string; reasoning?: string; tools: { id?: string; name: string; input?: any; result?: string }[]; startedAt: number; context?: number; window?: number },
): void {
  const liveTools = rt.tools.map((t, i) => ({ id: t.id ?? String(i), name: t.name, input: t.input, result: t.result })) as any;
  const store = inStore(vault);
  const prev = store ? useStore.getState().convRuntime[id] : openMirror(vault).convRuntime[id];
  const next: ConvRuntime = {
    streamingText: rt.text,
    streamingReasoning: rt.reasoning ?? "",
    liveTools,
    startedAt: rt.startedAt,
    ...(rt.context ? { lastContext: rt.context } : prev?.lastContext ? { lastContext: prev.lastContext } : {}),
    ...(rt.window ? { contextWindow: rt.window } : prev?.contextWindow ? { contextWindow: prev.contextWindow } : {}),
  } as ConvRuntime;
  if (store) {
    useStore.getState().setConvRuntime(id, next);
    return;
  }
  const m = openMirror(vault);
  m.convRuntime = { ...m.convRuntime, [id]: next };
  m.changed();
}
