// The one reducer: a conversation's picture is a pure fold of its feed records
// (./protocol.ts) — pi's own session entries, pi's own live events for the
// message in flight, and the conversation's fields. The box folds it to answer
// the engine's reads; the laptop, the popout and the phone fold it to render.
//
// pi's streaming rule (json.md), applied as written: a message_start opens the
// message in flight; each block grows by its deltas and takes its *_end
// content; message_end is the whole message; the entry pi then writes is the
// message for good and takes the place of the one in flight (same ids: a
// block is `<message timestamp>:<content index>`, a tool call its own id).
//
//   reduce(picture, record) -> picture      (new object; unchanged parts shared)
//   fold(records, id)       -> picture
//   foldInto(picture, records)              (a batch: one copy, then in place)
//
// A record at or below the picture's `seq` is skipped: replaying an overlap (a
// reconnect, a checkpoint plus its tail) never applies anything twice.
import type { ConvMeta, ConvRow, ItemImage, LogRecord, PendingInput, PiBlock, PiEntry, PiMessage, Todo } from "./protocol";
import { VC_NOTE, VC_VOICE } from "./protocol";
import { answerOf } from "../review";
import { hostToolName } from "../mcpNames";

/** Bumped when the fold's meaning changes: a checkpoint from another version is folded again. */
export const REDUCER_VERSION = 6;

export type ItemKind = "user" | "assistant" | "thinking" | "tool" | "compaction" | "notice";
export type ItemStatus = "streaming" | "pending" | "running" | "done" | "error" | "stopped";

/** One thing the transcript shows, from pi's entries (or its message in flight). */
export type Item = {
  id: string;
  kind: ItemKind;
  status: ItemStatus;
  at: number;
  text?: string;
  /** user: how it came in (chat, steer, queue, answer, voice, wake, nudge, resume, job). */
  via?: string;
  /** user: the surface it was sent from (laptop, phone, board, voice), when the box knows it. */
  device?: string;
  images?: ItemImage[];
  // tool
  name?: string;
  argsText?: string;
  args?: any;
  result?: string;
  partial?: string;
  // notice
  level?: "info" | "warn" | "error";
  rollover?: boolean;
};

export type Picture = {
  id: string;
  seq: number;
  exists: boolean;
  meta: ConvMeta;
  /** What pi's session holds, in its order. */
  items: Item[];
  /** The message in flight (pi's live events), after the items. */
  inflight: Item[];
  /** Its pi timestamp (the ids of its blocks). */
  inflightTs: number | null;
  /** The last assistant messages pi wrote (their timestamps): a live event about one of them comes late and changes nothing. */
  written: number[];
  /** The context size of the last reply. */
  usage: { context: number } | null;
};

const NEW_CHAT = "New chat";
const OPEN = new Set(["streaming", "pending", "running"]);
export const isOpen = (it: Item): boolean => OPEN.has(it.status);

export function emptyPicture(id: string): Picture {
  return { id, seq: 0, exists: false, meta: { title: NEW_CHAT, source: "manual", createdAt: 0, lastActivityAt: 0 }, items: [], inflight: [], inflightTs: null, written: [], usage: null };
}

/** The title a first message of Carl's gives a new chat. */
export function titleFrom(text: string): string {
  const first = text.trim().split(/\r?\n/)[0] ?? "";
  if (!first) return NEW_CHAT;
  return first.length <= 60 ? first : first.slice(0, 57) + "…";
}

export function textOf(content: PiMessage["content"]): string {
  if (typeof content === "string") return content;
  return (content ?? []).filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
}

const RESULT_CAP = 4_000;
const cap = (s: string, n = RESULT_CAP) => (s.length > n ? s.slice(0, n) + `\n…[${s.length - n} more chars]` : s);
const blockId = (ts: number | null | undefined, ci: number) => `${ts ?? 0}:${ci}`;

type Draft = Picture;

function draft(p: Picture): Draft {
  return { ...p, items: p.items.slice(), inflight: p.inflight.slice() };
}

function find(d: Draft, id: string): { list: Item[]; i: number } | null {
  let i = d.items.findIndex((x) => x.id === id);
  if (i >= 0) return { list: d.items, i };
  i = d.inflight.findIndex((x) => x.id === id);
  return i >= 0 ? { list: d.inflight, i } : null;
}

function patchItem(d: Draft, id: string, patch: Partial<Item>): boolean {
  const f = find(d, id);
  if (!f) return false;
  f.list[f.i] = { ...f.list[f.i]!, ...patch };
  return true;
}

function touch(d: Draft, at: number): void {
  if (at > d.meta.lastActivityAt) d.meta = { ...d.meta, lastActivityAt: at };
}

/** The id of the line an assistant message that failed shows (`<message timestamp>:-1`). */
const failId = (ts: number | null | undefined) => blockId(ts, -1);
const isFailLine = (it: Item) => it.kind === "notice" && it.level === "error" && it.id.endsWith(":-1");

/** An assistant message's blocks as items (the entry's, or message_end's). A failed request's line is
 *  provisional (`pending`) while its turn runs: pi may retry it (auto_retry), and a retry that recovers
 *  takes it away. Only a turn that ends on it shows it (closeOpen). */
function blocksOf(m: PiMessage, at: number, status: ItemStatus, running = false): Item[] {
  const out: Item[] = [];
  const content = Array.isArray(m.content) ? m.content : [];
  const stopped = m.stopReason === "aborted";
  content.forEach((b: PiBlock, ci) => {
    const id = blockId(m.timestamp, ci);
    if (b.type === "text" && typeof b.text === "string") {
      if (b.text.trim() || stopped) out.push({ id, kind: "assistant", status: stopped ? "stopped" : status, text: b.text, at });
    } else if (b.type === "thinking" && typeof b.thinking === "string") {
      if (b.thinking.trim()) out.push({ id, kind: "thinking", status: stopped ? "stopped" : status, text: b.thinking, at });
    } else if (b.type === "toolCall" && b.id) {
      out.push({ id: String(b.id), kind: "tool", status: "pending", name: hostToolName(b.name) || "tool", args: b.arguments ?? {}, at });
    }
  });
  if (m.stopReason === "error") out.push({ id: failId(m.timestamp), kind: "notice", status: running ? "pending" : "done", level: "error", text: failText(m.errorMessage), at });
  return out;
}

/** A failed request, said once and plainly (pi's own text, its first line, capped). */
function failText(msg: string | undefined, tries = 1): string {
  const first = String(msg ?? "").trim().split(/\r?\n/)[0]!.slice(0, 240) || "the model's request failed";
  return `Couldn't get a reply${tries > 1 ? ` (tried ${tries} times)` : ""}: ${first}`;
}

/** A retry recovered (or a later reply came): the failed requests of this turn are not shown. */
function dropFailLines(d: Draft): void {
  if (d.items.some((x) => isFailLine(x) && isOpen(x))) d.items = d.items.filter((x) => !(isFailLine(x) && isOpen(x)));
  if (d.inflight.some(isFailLine)) d.inflight = d.inflight.filter((x) => !isFailLine(x));
}

/** Put items in place: an item already there (from the message in flight) keeps its place and takes the new fields. */
function place(d: Draft, items: Item[]): void {
  for (const it of items) {
    const f = find(d, it.id);
    if (f && f.list === d.items) {
      const cur = f.list[f.i]!;
      // A tool call's run (live) is kept over the call's own "pending".
      f.list[f.i] = { ...cur, ...it, ...(cur.kind === "tool" && it.status === "pending" && cur.status !== "pending" ? { status: cur.status, result: cur.result, partial: cur.partial } : {}), at: cur.at };
    } else {
      if (f) f.list.splice(f.i, 1);
      d.items.push(it);
    }
  }
}

function onEntry(d: Draft, r: Extract<LogRecord, { type: "entry" }>): void {
  const e: PiEntry = r.entry;
  if (e.type === "message" && e.message) {
    const m = e.message;
    if (m.role === "user") {
      const text = r.shown ?? textOf(m.content);
      const fromContent: ItemImage[] = Array.isArray(m.content)
        ? m.content.filter((b) => b.type === "image" && b.data).map((b) => ({ path: "", dataUrl: `data:${b.mimeType ?? "image/png"};base64,${b.data}` }))
        : [];
      // The feed keeps an image's path; pi's entry holds its pixels.
      const images = r.images ? r.images.map((im, i) => (im.dataUrl || !fromContent[i] ? im : { ...im, dataUrl: fromContent[i]!.dataUrl })) : fromContent;
      place(d, [{ id: r.clientId ?? e.id, kind: "user", status: "done", text, via: r.via ?? "chat", ...(r.device ? { device: r.device } : {}), ...(images.length ? { images } : {}), at: r.at }]);
      touch(d, r.at);
      if (d.meta.title === NEW_CHAT && text.trim() && !["wake", "nudge", "resume", "job"].includes(r.via ?? "")) d.meta = { ...d.meta, title: titleFrom(text) };
      return;
    }
    if (m.role === "assistant") {
      // The message for good: what was in flight is this message.
      if (d.inflightTs === (m.timestamp ?? null)) {
        d.inflight = d.inflight.filter((x) => x.kind === "compaction" || x.kind === "notice");
        d.inflightTs = null;
      }
      if (typeof m.timestamp === "number") d.written = [...d.written.slice(-7), m.timestamp];
      // A reply after a failed request: pi's retry worked; the failure is not this turn's.
      if (m.stopReason !== "error") dropFailLines(d);
      place(d, blocksOf(m, r.at, "done", !!d.meta.running));
      const u = m.usage;
      if (u) {
        const ctx = Number(u.input ?? 0) + Number(u.cacheRead ?? 0) + Number(u.cacheWrite ?? 0);
        if (ctx > 0) d.usage = { context: ctx };
      }
      touch(d, r.at);
      return;
    }
    if (m.role === "toolResult" && m.toolCallId) {
      const res = cap(`${m.isError ? "[error] " : ""}${textOf(m.content)}`);
      if (!patchItem(d, m.toolCallId, { result: res, status: m.isError ? "error" : "done", partial: undefined })) {
        d.items.push({ id: m.toolCallId, kind: "tool", status: m.isError ? "error" : "done", name: hostToolName(m.toolName) || "tool", args: {}, result: res, at: r.at });
      }
      // Carl's answer to a question: his line, under the id his client sent it with.
      const ans = answerOf(m.toolName, textOf(m.content));
      if (ans !== null) {
        place(d, [{ id: r.clientId ?? `${m.toolCallId}:answer`, kind: "user", status: "done", text: ans, via: "answer", at: r.at }]);
        touch(d, r.at);
      }
      return;
    }
    return; // system messages: the prompt, never shown
  }
  if (e.type === "compaction") {
    d.inflight = d.inflight.filter((x) => x.kind !== "compaction");
    place(d, [{ id: e.id, kind: "compaction", status: "done", text: String(e.summary ?? ""), at: r.at }]);
    return;
  }
  // A line said on a voice call: in pi's context (a custom_message), shown as the line it is.
  const voiceLine = e.type === "custom_message" && e.customType === VC_VOICE;
  if ((e.type === "custom" && e.customType === VC_NOTE) || voiceLine) {
    const data = (voiceLine ? (e.details as any) : e.data) ?? {};
    if (data.kind === "line") {
      // A line vault-chat wrote (voice, a message pi never took): Carl's or an agent's.
      const user = data.role === "user";
      const text = String(r.shown ?? data.text ?? "");
      place(d, [{ id: r.clientId ?? data.clientId ?? e.id, kind: user ? "user" : "assistant", status: "done", text, via: r.via ?? data.via ?? (user ? "chat" : undefined), ...((r.images ?? data.images)?.length ? { images: r.images ?? data.images } : {}), at: r.at }]);
      touch(d, r.at);
      if (user && d.meta.title === NEW_CHAT && text.trim()) d.meta = { ...d.meta, title: titleFrom(text) };
      return;
    }
    if (data.kind === "tool") {
      // A tool call voice made (its result with it): a tool row, as the text agent's are.
      const result = String(data.result ?? "");
      place(d, [{ id: r.clientId ?? data.clientId ?? e.id, kind: "tool", status: data.status === "running" ? "pending" : data.isError || /^error\b/i.test(result) ? "error" : "done", name: String(data.name ?? "tool"), args: data.args ?? {}, result: cap(result), ...(data.via ? { via: String(data.via) } : {}), at: r.at }]);
      return;
    }
    if (data.kind === "divider") place(d, [{ id: r.clientId ?? data.clientId ?? e.id, kind: "compaction", status: "done", text: String(data.text ?? ""), ...(data.rollover ? { rollover: true } : {}), at: r.at }]);
    else place(d, [{ id: r.clientId ?? data.clientId ?? e.id, kind: "notice", status: "done", text: String(data.text ?? ""), level: data.level === "error" ? "error" : data.level === "warn" ? "warn" : "info", at: r.at }]);
  }
}

/** One of pi's live events, by pi's streaming rule. */
function onLive(d: Draft, r: Extract<LogRecord, { type: "live" }>): void {
  const ev = r.ev ?? {};
  // About a message pi already wrote: late, and nothing to add.
  if ((ev.type === "message_start" || ev.type === "message_end") && d.written.includes(Number(ev.message?.timestamp))) return;
  if (ev.type === "message_update" && d.inflightTs === null) return;
  switch (ev.type) {
    case "message_start":
      if (ev.message?.role !== "assistant") return;
      d.inflight = d.inflight.filter((x) => x.kind === "compaction" || x.kind === "notice");
      d.inflightTs = Number(ev.message.timestamp ?? r.at);
      return;
    case "message_update": {
      const ae = ev.assistantMessageEvent ?? {};
      const ci = Number(ae.contentIndex ?? 0);
      const id = blockId(d.inflightTs, ci);
      const upsert = (it: Item) => {
        const i = d.inflight.findIndex((x) => x.id === it.id);
        if (i >= 0) d.inflight[i] = { ...d.inflight[i]!, ...it, at: d.inflight[i]!.at };
        else d.inflight.push(it);
      };
      const grow = (kind: ItemKind, delta: string) => {
        const cur = d.inflight.find((x) => x.id === id);
        upsert({ id, kind, status: "streaming", text: (cur?.text ?? "") + delta, at: r.at });
      };
      switch (ae.type) {
        case "text_start":
          return upsert({ id, kind: "assistant", status: "streaming", text: "", at: r.at });
        case "text_delta":
          return grow("assistant", String(ae.delta ?? ""));
        case "text_end":
          return upsert({ id, kind: "assistant", status: "done", text: String(ae.content ?? ""), at: r.at });
        case "thinking_start":
          return upsert({ id, kind: "thinking", status: "streaming", text: "", at: r.at });
        case "thinking_delta":
          return grow("thinking", String(ae.delta ?? ""));
        case "thinking_end":
          return upsert({ id, kind: "thinking", status: "done", text: String(ae.content ?? ""), at: r.at });
        case "toolcall_start": {
          const tid = String(ae.id ?? ae.toolCall?.id ?? id);
          return upsert({ id: tid, kind: "tool", status: "streaming", name: hostToolName(ae.toolName) || "tool", argsText: "", at: r.at });
        }
        case "toolcall_delta": {
          const t = [...d.inflight].reverse().find((x) => x.kind === "tool" && x.status === "streaming");
          if (t) upsert({ ...t, argsText: (t.argsText ?? "") + String(ae.delta ?? "") });
          return;
        }
        case "toolcall_end": {
          const tc = ae.toolCall ?? {};
          if (tc.id) upsert({ id: String(tc.id), kind: "tool", status: "pending", name: hostToolName(tc.name) || "tool", args: tc.arguments ?? {}, at: r.at });
          return;
        }
        default:
          return;
      }
    }
    case "message_end": {
      const m = ev.message ?? {};
      if (m.role !== "assistant") return;
      d.inflightTs = Number(m.timestamp ?? d.inflightTs);
      const keep = d.inflight.filter((x) => x.kind === "compaction" || x.kind === "notice");
      if (m.stopReason !== "error") dropFailLines(d);
      d.inflight = [...keep, ...blocksOf(m, r.at, "done", !!d.meta.running)];
      return;
    }
    case "tool_execution_start": {
      const id = String(ev.toolCallId ?? "");
      if (!id) return;
      if (!patchItem(d, id, { status: "running", ...(ev.args !== undefined ? { args: ev.args } : {}) })) d.items.push({ id, kind: "tool", status: "running", name: hostToolName(ev.toolName) || "tool", args: ev.args ?? {}, at: r.at });
      return;
    }
    case "tool_execution_update": {
      const id = String(ev.toolCallId ?? "");
      const text = textOf(ev.partialResult?.content);
      if (id && text) patchItem(d, id, { partial: text.slice(-2_000) });
      return;
    }
    case "tool_execution_end": {
      const id = String(ev.toolCallId ?? "");
      if (!id) return;
      const f = find(d, id);
      if (f && f.list[f.i]!.result !== undefined) return; // the entry's result is already there
      patchItem(d, id, { status: ev.isError ? "error" : "done", result: cap(`${ev.isError ? "[error] " : ""}${textOf(ev.result?.content)}`), partial: undefined });
      return;
    }
    case "compaction_start":
      d.inflight = [...d.inflight.filter((x) => x.kind !== "compaction"), { id: `compacting:${r.seq}`, kind: "compaction", status: "streaming", at: r.at }];
      return;
    case "compaction_end":
      d.inflight = d.inflight.filter((x) => x.kind !== "compaction");
      if (!ev.result && !ev.aborted && ev.errorMessage) d.items.push({ id: `compaction-failed:${r.seq}`, kind: "notice", status: "done", level: "warn", text: `Summarizing the earlier conversation failed: ${String(ev.errorMessage).slice(0, 300)}`, at: r.at });
      return;
    case "auto_retry_start":
      // pi retries a failed request: one quiet line while it does (the failure itself is not shown unless the turn ends on it).
      d.inflight = [...d.inflight.filter((x) => !x.id.startsWith("retry:")), { id: `retry:${r.seq}`, kind: "notice", status: "running", level: "info", text: "Retrying…", at: r.at }];
      return;
    case "auto_retry_end":
      d.inflight = d.inflight.filter((x) => !x.id.startsWith("retry:"));
      if (ev.success) dropFailLines(d);
      return;
    default:
      return;
  }
}

/** The turn is over: what was in flight and never written stays, closed (a stop, a crash); nothing streams or runs forever. */
function closeOpen(d: Draft): void {
  // The turn ended on a failed request (every retry failed too): one line, the last failure, said once.
  const fails = [...d.items, ...d.inflight].filter((x) => isFailLine(x) && isOpen(x));
  if (fails.length) {
    const last = fails[fails.length - 1]!;
    d.items = d.items.filter((x) => !(isFailLine(x) && isOpen(x)));
    d.inflight = d.inflight.filter((x) => !isFailLine(x));
    const msg = (last.text ?? "").replace(/^Couldn't get a reply(?: \(tried \d+ times\))?: /, "");
    d.items.push({ ...last, status: "done", text: failText(msg, fails.length) });
  }
  if (d.inflight.length) {
    const kept = d.inflight.filter((x) => x.kind !== "compaction" && !(x.kind === "notice" && x.id.startsWith("retry:")) && (x.kind !== "assistant" || (x.text ?? "").trim()));
    for (const it of kept) d.items.push({ ...it, status: isOpen(it) ? "stopped" : it.status });
    d.inflight = [];
    d.inflightTs = null;
  }
  d.items.forEach((it, i) => {
    if (isOpen(it)) {
      const { partial: _p, ...rest } = it;
      d.items[i] = { ...rest, status: "stopped" };
    }
  });
}

function step(d: Draft, r: LogRecord): void {
  if (r.conv !== d.id || r.seq <= d.seq) return;
  d.seq = r.seq;
  switch (r.type) {
    case "meta": {
      const was = d.meta.running;
      const wasCleared = d.meta.cleared;
      const m: ConvMeta = { ...d.meta };
      for (const [k, v] of Object.entries(r.patch ?? {})) {
        if (k === "lastActivityAt") {
          if (typeof v === "number" && v > m.lastActivityAt) m.lastActivityAt = v;
          continue;
        }
        if (v === null || v === undefined) delete m[k];
        else m[k] = v;
      }
      if (typeof m.title !== "string" || !m.title) m.title = NEW_CHAT;
      if (typeof m.source !== "string" || !m.source) m.source = "manual";
      if (!m.createdAt) m.createdAt = r.at;
      if (!m.lastActivityAt) m.lastActivityAt = m.createdAt;
      d.meta = m;
      d.exists = true;
      // Clear: the view is blank from here (nothing to scroll back into); pi's file keeps everything.
      if (m.cleared && JSON.stringify(m.cleared) !== JSON.stringify(wasCleared ?? null)) {
        d.items = [];
        d.inflight = [];
        d.inflightTs = null;
        d.usage = null;
      }
      if (was && !m.running) closeOpen(d);
      if (m.running && (!was || was.turn !== m.running.turn)) touch(d, r.at);
      return;
    }
    case "entry":
      // Clear's work behind the blank view (its save turn, its note, compaction) is never shown.
      if (!d.meta.clearing) onEntry(d, r);
      return;
    case "live":
      if (!d.meta.clearing) onLive(d, r);
      return;
    case "signal":
      return;
  }
}

/** One record → a new picture (the old one is untouched). */
export function reduce(p: Picture, r: LogRecord): Picture {
  if (r.conv !== p.id || r.seq <= p.seq) return p;
  const d = draft(p);
  step(d, r);
  return d;
}

/** Many records → a new picture, copying once. */
export function foldInto(p: Picture, records: Iterable<LogRecord>): Picture {
  let d: Draft | null = null;
  for (const r of records) {
    if (r.conv !== p.id || r.seq <= (d?.seq ?? p.seq)) continue;
    d ??= draft(p);
    step(d, r);
  }
  return d ?? p;
}

export function fold(records: Iterable<LogRecord>, id: string): Picture {
  return foldInto(emptyPicture(id), records);
}

// ---------------------------------------------------------------- selectors

export const isRunning = (p: Picture): boolean => !!p.meta.running;

/** Everything shown, in order: what pi wrote, then what is in flight. */
export const shown = (p: Picture): Item[] => (p.inflight.length ? [...p.items, ...p.inflight] : p.items);

/** The agent's current to-do list (its last TodoWrite). */
export function planOf(p: Picture): Todo[] | null {
  const all = shown(p);
  for (let i = all.length - 1; i >= 0; i--) {
    const it = all[i]!;
    if (it.kind === "tool" && it.name === "TodoWrite" && Array.isArray(it.args?.todos)) return it.args.todos;
  }
  return null;
}

export function pendingOf(p: Picture): PendingInput[] {
  return (p.meta.pending as PendingInput[] | undefined) ?? [];
}

export function rowOf(p: Picture): ConvRow {
  const m = p.meta;
  return {
    id: p.id,
    title: m.title || NEW_CHAT,
    source: m.source || "manual",
    createdAt: m.createdAt,
    lastActivityAt: m.lastActivityAt,
    ...(m.project ? { project: m.project } : {}),
    ...(m.state ? { state: m.state } : {}),
    ...(m.working ? { working: true } : {}),
    ...(typeof m.nextWakeAt === "number" ? { nextWakeAt: m.nextWakeAt } : {}),
    ...(typeof m.costUsd === "number" ? { costUsd: m.costUsd } : {}),
    ...(m.deleted ? { deleted: true } : {}),
    ...(typeof m.kind === "string" && m.kind ? { kind: m.kind } : {}),
    ...(m.clearing ? { clearing: true } : {}),
    running: !!m.running && !m.clearing,
    asking: !!m.asking,
    seq: p.seq,
  };
}

// ---------------------------------------------------------------- the list

/** A list row folded from the records alone (a client keeps every row this
 *  way, without holding every conversation's transcript). Equal to rowOf(fold(records)). */
export type RowState = ConvRow;

export function emptyRow(id: string): RowState {
  return rowOf(emptyPicture(id));
}

export const rowFromPicture = rowOf;

/** One record → the row (new object when it changed). */
export function reduceRow(row: RowState, r: LogRecord): RowState {
  if (r.conv !== row.id || r.seq <= row.seq) return row;
  // The row is the fold of a picture that keeps only the fields a row needs.
  const p = emptyPicture(row.id);
  p.seq = row.seq;
  p.exists = row.seq > 0 || !!row.createdAt;
  p.meta = {
    title: row.title,
    source: row.source,
    createdAt: row.createdAt,
    lastActivityAt: row.lastActivityAt,
    ...(row.project ? { project: row.project } : {}),
    ...(row.state ? { state: row.state } : {}),
    ...(row.working ? { working: true } : {}),
    ...(typeof row.nextWakeAt === "number" ? { nextWakeAt: row.nextWakeAt } : {}),
    ...(typeof row.costUsd === "number" ? { costUsd: row.costUsd } : {}),
    ...(row.deleted ? { deleted: true } : {}),
    ...(row.kind ? { kind: row.kind } : {}),
    ...(row.clearing ? { clearing: true } : {}),
    ...(row.running ? { running: { turn: "?", kind: "?", startedAt: 0 } } : {}),
    ...(row.asking ? { asking: { question: "", options: [], at: 0 } } : {}),
  };
  // Only what changes a row: its fields, its activity and title (Carl's and the agent's messages).
  if (r.type === "live" || r.type === "signal" || (r.type === "entry" && row.clearing)) return { ...row, seq: r.seq };
  if (r.type === "entry") {
    // Carl's answer to a question (the AskUser result): his line, so activity.
    const m = r.entry.message;
    if (r.entry.type === "message" && m?.role === "toolResult" && answerOf(m.toolName, textOf(m.content)) !== null) {
      return { ...row, seq: r.seq, lastActivityAt: Math.max(row.lastActivityAt, r.at) };
    }
    const voice = r.entry.type === "custom_message" && r.entry.customType === VC_VOICE;
    const data = voice ? (r.entry.details as any) : r.entry.data;
    const line = (voice || (r.entry.type === "custom" && r.entry.customType === VC_NOTE)) && data?.kind === "line";
    const role = line ? (data.role === "user" ? "user" : "assistant") : r.entry.message?.role;
    if (!line && (r.entry.type !== "message" || (role !== "user" && role !== "assistant"))) return { ...row, seq: r.seq };
    const n = { ...row, seq: r.seq };
    if (r.at > n.lastActivityAt) n.lastActivityAt = r.at;
    if (role === "user" && n.title === NEW_CHAT) {
      const text = line ? String(r.shown ?? data.text ?? "") : (r.shown ?? textOf(r.entry.message!.content));
      if (text.trim() && (line || !["wake", "nudge", "resume", "job"].includes(r.via ?? ""))) n.title = titleFrom(text);
    }
    return n;
  }
  const q = reduce(p, r);
  const out = rowOf(q);
  return out;
}
