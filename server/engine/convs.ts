// Conversations on the box. A conversation's transcript is pi's session files;
// the vault's feed (server/convlog/log.ts) points into them and holds the
// conversation's own fields, and this server is its only writer. What the
// engine and the routes read is the feed's fold (src/convlog/reduce.ts),
// projected to the conversation shape they already know (src/convlog/view.ts).
//
// Lines vault-chat itself adds to a transcript (a voice exchange, a notice, a
// line brought in from Ctrl+K) are pi custom entries (`vc-note`): written by pi
// when a pi process has the session open (the engine's note writer), else
// appended in pi's format to the session file, or to the conversation's own
// session file when it has no pi session at all.
//
// Older conversation files are imported the first time one is read
// (server/convlog/importer.ts); the files themselves are never written.
import { existsSync } from "node:fs";
import type { ChatMessage } from "../../src/store";
import { newMessageId } from "../../src/conversations";
import type { EventBody, ItemImage, LogRecord } from "../../src/convlog/protocol";
import { pendingOf, planOf, type Picture } from "../../src/convlog/reduce";
import { messagesOf } from "../../src/convlog/view";
import { convLog, type ConvLog } from "../convlog/log";
import { appendEntries, newSessionFile, vcNote } from "../convlog/piSession";
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
  const todos = planOf(p);
  const queued = pendingOf(p)
    .filter((x) => x.kind === "queue")
    .map((x) => ({ id: x.id, text: x.text }));
  const { subagents, running, asking, pending: _p, ...rest } = m;
  return {
    ...(rest as Record<string, unknown>),
    id: p.id,
    title: m.title,
    source: m.source as EngineConv["source"],
    createdAt: m.createdAt,
    lastActivityAt: m.lastActivityAt,
    unread: false,
    messages: messagesOf(p) as ChatMessage[],
    status: running ? "running" : "idle",
    ...(running ? { runStartedAt: running.startedAt } : {}),
    ...(asking ? { pendingAsk: { question: asking.question ?? "", options: asking.options ?? [], at: asking.at } } : {}),
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

/** What the fold derives itself (the transcript, the turn, the question …): never set by a patch from outside the engine. */
const DERIVED = new Set(["id", "messages", "status", "runStartedAt", "pendingAsk", "todos", "queued", "createdAt", "lastActivityAt", "unread"]);

/** The conversation fields of a patch (undefined → null: removes it). */
function metaPatch(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) if (!DERIVED.has(k)) out[k] = v === undefined ? null : v;
  return out;
}

export async function patchMeta(vault: string, id: string, meta: Partial<EngineConv> | Record<string, unknown>): Promise<EngineConv | null> {
  if (!pictureOf(vault, id)) return null;
  const patch = metaPatch(meta as Record<string, unknown>);
  if (Object.keys(patch).length) emitTo(vault, id, { type: "meta", patch });
  return readConv(vault, id);
}

export async function createConv(vault: string, init: Partial<EngineConv>, firstText: string, id?: string): Promise<EngineConv> {
  const convId = id ?? newConvId();
  const meta: Record<string, unknown> = { ...metaPatch(init as Record<string, unknown>), title: init.title ?? titleOf(firstText), source: init.source ?? "phone" };
  for (const [k, v] of Object.entries(meta)) if (v === null) delete meta[k];
  const now = Date.now();
  emitTo(vault, convId, { type: "meta", patch: { ...meta, createdAt: now, lastActivityAt: now } });
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

// ---------------------------------------------------------------- vault-chat's own entries

/** A vc-note: a line (Carl's or an agent's), a notice, a divider, a tool call voice made. `clientId`: the id a client shows it under. */
export type NoteData = { kind: "line" | "notice" | "divider" | "tool"; clientId?: string; images?: ItemImage[]; [k: string]: unknown };

/** The engine's writer: the notes through pi (true) while a pi process has the conversation's session open. */
export type NoteWriter = (convId: string, notes: NoteData[]) => Promise<boolean>;
const writers = new Map<string, NoteWriter>();

export function setNoteWriter(vault: string, fn: NoteWriter | null): void {
  if (fn) writers.set(vault, fn);
  else writers.delete(vault);
}

/** Write notes into the conversation's transcript: through pi when it has the session, else straight into a pi-format file. */
export async function writeNotes(vault: string, convId: string, notes: NoteData[]): Promise<void> {
  if (!notes.length) return;
  const w = writers.get(vault);
  if (w && (await w(convId, notes))) return;
  appendNotes(vault, convId, notes);
}

/** The notes appended in pi's format (no pi has the session): to its pi session file, or the conversation's own. */
export function appendNotes(vault: string, convId: string, notes: NoteData[]): void {
  const log = convLog(vault);
  const p = log.picture(convId);
  const thread = typeof p?.meta.threadPath === "string" && existsSync(p.meta.threadPath) ? p.meta.threadPath : null;
  const file = thread ?? log.ownSession(convId);
  if (!thread && !existsSync(file)) newSessionFile(file, vault);
  const written = appendEntries(
    file,
    notes.map(({ images: _i, ...d }) => vcNote(d as NoteData)),
  );
  written.forEach((entry, i) => {
    const n = notes[i]!;
    emitTo(vault, convId, { type: "entry", file, entry, ...(n.clientId ? { clientId: n.clientId } : {}), ...(n.images?.length ? { images: n.images } : {}) });
  });
}

/**
 * One message, written as the line it is: Carl's line, a line from an agent,
 * a system line (a notice). Voice (server/voice.ts) and lines a client brings
 * in come through here. The message's `mid` is the line's id (a client's own
 * id when it sent one), so a repeat is a no-op.
 */
export async function appendMessage(vault: string, id: string, m: ChatMessage & { mid?: string }, meta: Partial<EngineConv> = {}): Promise<EngineConv | null> {
  const p = pictureOf(vault, id);
  if (!p) return null;
  const itemId = m.mid ?? newMessageId();
  if (!p.items.some((x) => x.id === itemId) && !(m.role === "user" && m.hidden)) {
    const voice = p.meta.source === "voice";
    let note: NoteData;
    const call = m.toolCalls?.[0];
    // A tool call voice made: a tool row like the text agent's (name, input, result).
    if (call) note = { kind: "tool", name: String(call.name || "tool"), args: call.input ?? {}, result: String(call.result ?? ""), ...(voice ? { via: "voice" } : {}), clientId: itemId };
    else if (m.system) note = { kind: "notice", text: m.content ?? "", level: m.failed ? "error" : "info", clientId: itemId };
    else if (m.role === "user") {
      const images = imagesOf(m as any);
      note = { kind: "line", role: "user", text: m.content ?? "", via: voice ? "voice" : m.decision ? "answer" : "chat", clientId: itemId, ...(images.length ? { images } : {}) };
    } else note = { kind: "line", role: "assistant", text: m.content ?? "", ...(voice ? { via: "voice" } : {}), clientId: itemId };
    await writeNotes(vault, id, [note]);
  }
  const patch = metaPatch(meta as Record<string, unknown>);
  if (Object.keys(patch).length) emitTo(vault, id, { type: "meta", patch });
  return readConv(vault, id);
}

/**
 * Every conversation as the plain object the older readers take (the phone's
 * routes, CONTEXT's cost, voice): from the feed; one not imported yet comes
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
