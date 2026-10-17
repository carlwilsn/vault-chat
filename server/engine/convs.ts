// Conversations on the box: the event log (server/convlog/log.ts) is the only
// record, and this server its only writer. What the engine and the routes read
// is the log's fold (src/convlog/reduce.ts) projected to the conversation
// shape they already know (src/convlog/view.ts) — never a second copy.
//
// Older conversation files are imported into the log the first time one is
// read (server/convlog/importer.ts); the files themselves are never written.
import type { ChatMessage } from "../../src/store";
import { newMessageId } from "../../src/conversations";
import type { EventBody, Item, ItemImage, LogRecord } from "../../src/convlog/protocol";
import { openAsk, planOf, type Picture } from "../../src/convlog/reduce";
import { messagesOf } from "../../src/convlog/view";
import { convLog, type ConvLog } from "../convlog/log";
import { readConversationObjects } from "../commands/conversations";
import type { EngineConv } from "./context";

export { newMessageId };

export function logOf(vault: string): ConvLog {
  return convLog(vault);
}

/** Append one record to a conversation (the box's single write path). */
export function emitTo(vault: string, convId: string, body: EventBody, at?: number): LogRecord {
  return convLog(vault).emit(convId, body, at);
}

export function pictureOf(vault: string, id: string): Picture | null {
  const p = convLog(vault).picture(id);
  return p && p.exists ? p : null;
}

/** The picture as the conversation shape the engine, CONTEXT and the old routes read. */
export function toEngineConv(p: Picture): EngineConv {
  const m = p.meta;
  const ask = openAsk(p);
  const todos = planOf(p);
  const queued = p.pending.filter((x) => x.kind === "queue").map((x) => ({ id: x.id, text: x.text }));
  const { subagents, ...rest } = m;
  return {
    ...(rest as Record<string, unknown>),
    id: p.id,
    title: m.title,
    source: m.source as EngineConv["source"],
    createdAt: m.createdAt,
    lastActivityAt: m.lastActivityAt,
    unread: false,
    messages: messagesOf(p) as ChatMessage[],
    status: p.turn ? "running" : "idle",
    ...(p.turn ? { runStartedAt: p.turn.startedAt } : {}),
    ...(ask ? { pendingAsk: { question: ask.question ?? "", options: ask.options ?? [], at: ask.at } } : {}),
    ...(todos ? { todos } : {}),
    ...(queued.length ? { queued } : {}),
    ...(subagents?.length ? { subagents: subagents as any } : {}),
  } as EngineConv;
}

export async function readConv(vault: string, id: string): Promise<EngineConv | null> {
  const p = pictureOf(vault, id);
  return p ? toEngineConv(p) : null;
}

/** Every conversation (older files are imported on the way). */
export async function allConvs(vault: string): Promise<EngineConv[]> {
  const log = convLog(vault);
  const out: EngineConv[] = [];
  for (const r of log.rows()) {
    const p = pictureOf(vault, r.id);
    if (p) out.push(toEngineConv(p));
  }
  return out;
}

/** What the log derives itself (items, turns, cost, subagents …): never set by a conv.updated. */
const DERIVED = new Set(["id", "messages", "status", "runStartedAt", "pendingAsk", "todos", "queued", "subagents", "costUsd", "createdAt", "lastActivityAt", "unread"]);

/** The conversation fields of a patch (undefined → null: removes it). */
function metaPatch(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) if (!DERIVED.has(k)) out[k] = v === undefined ? null : v;
  return out;
}

export async function patchMeta(vault: string, id: string, meta: Partial<EngineConv> | Record<string, unknown>): Promise<EngineConv | null> {
  if (!pictureOf(vault, id)) return null;
  const patch = metaPatch(meta as Record<string, unknown>);
  if (Object.keys(patch).length) emitTo(vault, id, { type: "conv.updated", patch });
  return readConv(vault, id);
}

export async function createConv(vault: string, init: Partial<EngineConv>, firstText: string, id?: string): Promise<EngineConv> {
  const convId = id ?? newConvId();
  const meta: Record<string, unknown> = { ...metaPatch(init as Record<string, unknown>), title: init.title ?? titleOf(firstText), source: init.source ?? "phone" };
  for (const [k, v] of Object.entries(meta)) if (v === null) delete meta[k];
  emitTo(vault, convId, { type: "conv.created", meta: meta as any });
  return (await readConv(vault, convId))!;
}

function titleOf(text: string): string {
  const first = text.trim().split(/\r?\n/)[0] ?? "";
  if (!first) return "New chat";
  return first.length <= 60 ? first : first.slice(0, 57) + "…";
}

function newConvId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function imagesOf(m: { attachments?: { imageDataUrl?: string; capturedFilePath?: string; sourcePath?: string }[] }): ItemImage[] {
  return (m.attachments ?? [])
    .map((a) => ({ path: a.capturedFilePath ?? a.sourcePath ?? "", ...(a.imageDataUrl ? { dataUrl: a.imageDataUrl } : {}) }))
    .filter((x) => x.path || x.dataUrl);
}

/**
 * One message, written as the item it is: Carl's line (a user item), a line
 * from an agent (an assistant item), a system line (a notice). Voice
 * (server/voice.ts) and the engine's notices come through here. The message's
 * `mid` is the item's id (a client's own id when it sent one), so a repeat is a no-op.
 */
export async function appendMessage(vault: string, id: string, m: ChatMessage & { mid?: string }, meta: Partial<EngineConv> = {}): Promise<EngineConv | null> {
  const p = pictureOf(vault, id);
  if (!p) return null;
  const itemId = m.mid ?? newMessageId();
  if (!p.items.some((x) => x.id === itemId)) {
    const voice = p.meta.source === "voice";
    let item: Omit<Item, "at">;
    if (m.system) item = { id: itemId, kind: "notice", status: "done", text: m.content ?? "", level: m.failed ? "error" : "info" };
    else if (m.role === "user") {
      const images = imagesOf(m as any);
      item = { id: itemId, kind: "user", status: "done", text: m.content ?? "", via: voice ? "voice" : m.decision ? "answer" : "chat", ...(m.hidden ? { hidden: true } : {}), ...(images.length ? { images } : {}) };
    } else item = { id: itemId, kind: "assistant", status: "done", text: m.content ?? "", ...(voice ? { via: "voice" as const } : {}) };
    emitTo(vault, id, { type: "item.started", item: { ...item, at: 0 } as Item });
  }
  const patch = metaPatch(meta as Record<string, unknown>);
  if (Object.keys(patch).length) emitTo(vault, id, { type: "conv.updated", patch });
  return readConv(vault, id);
}

/**
 * Every conversation as the plain object the older readers take (the phone's
 * routes, CONTEXT's cost, voice): from the log; one not imported yet comes
 * from its older file as it is (reading never imports a whole vault).
 */
export function conversationObjects(vault: string): any[] {
  const log = convLog(vault);
  const legacy = new Map<string, any>();
  const out: any[] = [];
  for (const r of log.rows()) {
    if (r.legacy) {
      if (!legacy.size) for (const c of readConversationObjects(vault)) if (typeof c?.id === "string") legacy.set(c.id, c);
      const c = legacy.get(r.id);
      if (c) out.push(c);
      continue;
    }
    const p = log.picture(r.id);
    if (p?.exists && !p.meta.deleted) out.push(toEngineConv(p));
  }
  return out;
}

/** One conversation as that object (imported from its older file on the way). */
export function conversationObject(vault: string, id: string): any | null {
  const p = pictureOf(vault, id);
  return p && !p.meta.deleted ? toEngineConv(p) : null;
}
