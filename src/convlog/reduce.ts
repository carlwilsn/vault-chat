// The one reducer: a conversation's picture is a pure fold of its log records.
// The box folds it to answer the engine's reads, the laptop, the popout and
// the phone fold it to render — all with this function, so no two of them can
// disagree about what a conversation holds or in which order.
//
//   reduce(picture, record) -> picture      (new object; unchanged parts shared)
//   fold(records, id)       -> picture      (from nothing)
//   foldInto(picture, records)              (a batch: one copy, then in place)
//
// A record at or below the picture's `seq` is skipped, so replaying an overlap
// (a reconnect, a checkpoint plus its tail) never applies anything twice.
import type { ConvMeta, ConvRow, Item, LogRecord, PendingInput, Todo, TurnEnd, TurnKind } from "./protocol";

export type Picture = {
  id: string;
  /** The last record applied. */
  seq: number;
  /** A conv.created was seen. */
  exists: boolean;
  meta: ConvMeta;
  /** In log order: the order every client shows. */
  items: Item[];
  /** The running turn; null = idle. */
  turn: { id: string; kind: TurnKind; startedAt: number } | null;
  lastTurn: { id: string; status: TurnEnd; error?: string; endedAt: number } | null;
  /** Steers and queued messages not delivered yet. */
  pending: PendingInput[];
  /** The latest context size and the model's window. */
  usage: { context: number; window?: number } | null;
  /** What each turn cost (USD). */
  turnCost: Record<string, number>;
};

const NEW_CHAT = "New chat";

/** Bumped when the fold's meaning changes: a checkpoint from another version is folded again. */
export const REDUCER_VERSION = 1;

export function emptyPicture(id: string): Picture {
  return {
    id,
    seq: 0,
    exists: false,
    meta: { title: NEW_CHAT, source: "manual", createdAt: 0, lastActivityAt: 0 },
    items: [],
    turn: null,
    lastTurn: null,
    pending: [],
    usage: null,
    turnCost: {},
  };
}

/** The title a first user message gives a new chat (src/conversations.ts deriveConversationTitle). */
export function titleFrom(text: string): string {
  const first = text.trim().split(/\r?\n/)[0] ?? "";
  if (!first) return NEW_CHAT;
  return first.length <= 60 ? first : first.slice(0, 57) + "…";
}

const OPEN = new Set(["streaming", "pending", "running"]);
export const isOpen = (it: Item): boolean => OPEN.has(it.status);

const round = (n: number) => Math.round(n * 1e7) / 1e7;

type Draft = Picture & { __idx?: Map<string, number> };

function index(d: Draft): Map<string, number> {
  if (!d.__idx) {
    const m = new Map<string, number>();
    d.items.forEach((it, i) => m.set(it.id, i));
    Object.defineProperty(d, "__idx", { value: m, enumerable: false, writable: true, configurable: true });
  }
  return d.__idx!;
}

function draft(p: Picture): Draft {
  return { ...p, items: p.items.slice() };
}

function setItem(d: Draft, i: number, next: Item): void {
  d.items[i] = next;
}

function touch(d: Draft, at: number): void {
  if (at > d.meta.lastActivityAt) d.meta = { ...d.meta, lastActivityAt: at };
}

/** Apply one record to a draft (mutates the draft's own arrays and replaces the objects it changes). */
function step(d: Draft, r: LogRecord): void {
  if (r.conv !== d.id || r.seq <= d.seq) return;
  d.seq = r.seq;
  switch (r.type) {
    case "conv.created": {
      // The conversation's fields as created (a second creation resets them); what the log itself
      // adds up (cost, subagents, the last activity) is kept.
      d.exists = true;
      const { costUsd: _c, subagents: _s, costMissingCalls: _m, createdAt, lastActivityAt, ...meta } = r.meta;
      const m: ConvMeta = { title: NEW_CHAT, source: "manual", createdAt: createdAt ?? r.at, lastActivityAt: Math.max(d.meta.lastActivityAt, lastActivityAt ?? r.at) };
      for (const k of ["costUsd", "costMissingCalls", "subagents"] as const) if (d.meta[k] !== undefined) (m as Record<string, unknown>)[k] = d.meta[k];
      for (const [k, v] of Object.entries(meta)) if (v !== null && v !== undefined) m[k] = v;
      if (typeof m.title !== "string" || !m.title) m.title = NEW_CHAT;
      if (typeof m.source !== "string" || !m.source) m.source = "manual";
      d.meta = m;
      return;
    }
    case "conv.updated": {
      const m: ConvMeta = { ...d.meta };
      for (const [k, v] of Object.entries(r.patch ?? {})) {
        if (k === "createdAt" || k === "lastActivityAt" || k === "costUsd" || k === "subagents") continue; // log-derived
        if (v === null || v === undefined) delete m[k];
        else m[k] = v;
      }
      if (typeof m.title !== "string" || !m.title) m.title = NEW_CHAT;
      if (typeof m.source !== "string" || !m.source) m.source = "manual";
      d.meta = m;
      return;
    }
    case "turn.started":
      d.turn = { id: r.turn, kind: r.kind, startedAt: r.at };
      touch(d, r.at);
      return;
    case "turn.ended": {
      if (d.turn && d.turn.id !== r.turn) return; // not the running turn's end (a stale one)
      d.turn = null;
      d.lastTurn = { id: r.turn, status: r.status, ...(r.error ? { error: r.error } : {}), endedAt: r.at };
      // A turn's end closes what it left open (a stop, a crash): nothing streams forever.
      // An open question outlives its turn (answered later, it starts a new one).
      for (let i = 0; i < d.items.length; i++) {
        const it = d.items[i]!;
        if (it.turn === r.turn && isOpen(it) && it.kind !== "ask") {
          const { partial: _p, ...rest } = it;
          setItem(d, i, { ...rest, status: "stopped" });
        }
      }
      return;
    }
    case "item.started": {
      const idx = index(d);
      const at = idx.get(r.item.id);
      const it: Item = { ...r.item, at: r.item.at || r.at };
      if (at !== undefined) {
        // Started twice (a retried write): the later fields win, the place stays.
        setItem(d, at, { ...d.items[at]!, ...it, at: d.items[at]!.at });
      } else {
        idx.set(it.id, d.items.length);
        d.items.push(it);
      }
      if ((it.kind === "user" || it.kind === "assistant") && !it.hidden) touch(d, r.at);
      if (it.kind === "user" && !it.hidden && d.meta.title === NEW_CHAT && it.text?.trim()) d.meta = { ...d.meta, title: titleFrom(it.text) };
      return;
    }
    case "item.delta": {
      const i = index(d).get(r.id);
      if (i === undefined) return;
      const cur = d.items[i]!;
      setItem(d, i, { ...cur, [r.field]: (cur[r.field] ?? "") + r.delta });
      return;
    }
    case "item.updated": {
      const i = index(d).get(r.id);
      if (i === undefined) return;
      setItem(d, i, { ...d.items[i]!, ...r.patch, id: r.id });
      return;
    }
    case "item.completed": {
      const i = index(d).get(r.id);
      if (i === undefined) return;
      const { partial: _p, ...cur } = d.items[i]!;
      const status = r.patch?.status ?? (cur.status === "error" ? "error" : "done");
      setItem(d, i, { ...cur, ...(r.patch ?? {}), id: r.id, status });
      return;
    }
    case "item.removed": {
      const i = index(d).get(r.id);
      if (i === undefined) return;
      d.items.splice(i, 1);
      d.__idx = undefined;
      return;
    }
    case "pending.added":
      if (d.pending.some((x) => x.id === r.pending.id)) return;
      d.pending = [...d.pending, { ...r.pending, at: r.pending.at || r.at }];
      return;
    case "pending.removed":
      if (!d.pending.some((x) => x.id === r.id)) return;
      d.pending = d.pending.filter((x) => x.id !== r.id);
      return;
    case "usage":
      d.usage = { context: r.context, ...(r.window ? { window: r.window } : d.usage?.window ? { window: d.usage.window } : {}) };
      return;
    case "cost": {
      const m: ConvMeta = { ...d.meta, costUsd: round((d.meta.costUsd ?? 0) + (r.usd || 0)) };
      if (r.missing) m.costMissingCalls = (m.costMissingCalls ?? 0) + r.missing;
      d.meta = m;
      if (r.turn) d.turnCost = { ...d.turnCost, [r.turn]: round((d.turnCost[r.turn] ?? 0) + (r.usd || 0)) };
      return;
    }
    case "subagent": {
      const list = [...(d.meta.subagents ?? [])];
      const i = list.findIndex((x) => x.threadId === r.threadId);
      if (i >= 0) list[i] = { ...list[i]!, ...r.patch, threadId: r.threadId };
      else list.push({ ...r.patch, threadId: r.threadId });
      d.meta = { ...d.meta, subagents: list };
      return;
    }
    case "signal":
      return;
  }
}

function finish(d: Draft): Picture {
  const { __idx: _i, ...p } = d as Draft & Record<string, unknown>;
  void _i;
  return p as Picture;
}

/** One record → a new picture (the old one is untouched). */
export function reduce(p: Picture, r: LogRecord): Picture {
  if (r.conv !== p.id || r.seq <= p.seq) return p;
  const d = draft(p);
  step(d, r);
  return finish(d);
}

/** Many records → a new picture, copying once. */
export function foldInto(p: Picture, records: Iterable<LogRecord>): Picture {
  let d: Draft | null = null;
  for (const r of records) {
    if (r.conv !== p.id || r.seq <= (d?.seq ?? p.seq)) continue;
    d ??= draft(p);
    step(d, r);
  }
  return d ? finish(d) : p;
}

export function fold(records: Iterable<LogRecord>, id: string): Picture {
  return foldInto(emptyPicture(id), records);
}

// ---------------------------------------------------------------- selectors

export const isRunning = (p: Picture): boolean => !!p.turn;

/** The open question, if one waits for Carl. */
export function openAsk(p: Picture): Item | null {
  for (let i = p.items.length - 1; i >= 0; i--) {
    const it = p.items[i]!;
    if (it.kind === "ask" && isOpen(it)) return it;
  }
  return null;
}

/** The agent's current to-do list (its last plan). */
export function planOf(p: Picture): Todo[] | null {
  for (let i = p.items.length - 1; i >= 0; i--) if (p.items[i]!.kind === "plan") return p.items[i]!.todos ?? [];
  return null;
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
    running: !!p.turn,
    asking: !!openAsk(p),
    seq: p.seq,
  };
}

// ---------------------------------------------------------------- the list

/** A list row folded from the records alone (a client keeps every row this way,
 *  without holding every conversation's items). Equal to rowOf(fold(records)). */
export type RowState = ConvRow & { asks: Record<string, boolean>; turnId: string | null };

export function rowFromPicture(p: Picture): RowState {
  const asks: Record<string, boolean> = {};
  for (const it of p.items) if (it.kind === "ask") asks[it.id] = isOpen(it);
  return { ...rowOf(p), asks, turnId: p.turn?.id ?? null };
}

export function emptyRow(id: string): RowState {
  return rowFromPicture(emptyPicture(id));
}

/** One record → the row (new object when it changed). */
export function reduceRow(row: RowState, r: LogRecord): RowState {
  if (r.conv !== row.id || r.seq <= row.seq) return row;
  const n: RowState = { ...row, seq: r.seq };
  const act = (at: number) => {
    if (at > n.lastActivityAt) n.lastActivityAt = at;
  };
  switch (r.type) {
    case "conv.created":
      n.title = NEW_CHAT;
      n.source = "manual";
      delete n.project;
      delete n.state;
      delete n.working;
      delete n.nextWakeAt;
      applyMeta(n, r.meta as Record<string, unknown>);
      n.createdAt = r.meta.createdAt ?? r.at;
      n.lastActivityAt = Math.max(row.lastActivityAt, r.meta.lastActivityAt ?? r.at);
      break;
    case "conv.updated":
      applyMeta(n, r.patch, true);
      break;
    case "turn.started":
      n.turnId = r.turn;
      n.running = true;
      act(r.at);
      break;
    case "turn.ended":
      if (n.turnId && n.turnId !== r.turn) break;
      n.turnId = null;
      n.running = false;
      break;
    case "item.started":
      if ((r.item.kind === "user" || r.item.kind === "assistant") && !r.item.hidden) act(r.at);
      if (r.item.kind === "user" && !r.item.hidden && n.title === NEW_CHAT && r.item.text?.trim()) n.title = titleFrom(r.item.text);
      if (r.item.kind === "ask" || r.item.id in n.asks) n.asks = { ...n.asks, [r.item.id]: OPEN.has(r.item.status) };
      break;
    case "item.completed":
      if (r.id in n.asks) n.asks = { ...n.asks, [r.id]: OPEN.has(r.patch?.status ?? "done") };
      break;
    case "item.updated":
      if (r.id in n.asks && r.patch.status) n.asks = { ...n.asks, [r.id]: OPEN.has(r.patch.status) };
      break;
    case "item.removed":
      if (r.id in n.asks) {
        const { [r.id]: _gone, ...rest } = n.asks;
        n.asks = rest;
      }
      break;
    case "cost":
      n.costUsd = round((n.costUsd ?? 0) + (r.usd || 0));
      break;
    default:
      break;
  }
  n.asking = Object.values(n.asks).some(Boolean);
  return n;
}

const ROW_META = ["title", "source", "project", "state", "working", "nextWakeAt"] as const;
function applyMeta(n: RowState, patch: Record<string, unknown>, nullable = false): void {
  for (const k of ROW_META) {
    if (!(k in patch)) continue;
    const v = patch[k];
    if (v === null || v === undefined) {
      if (!nullable) continue;
      if (k === "title") n.title = NEW_CHAT;
      else if (k === "source") n.source = "manual";
      else delete (n as Record<string, unknown>)[k];
      continue;
    }
    if (k === "working") {
      if (v) n.working = true;
      else delete n.working;
      continue;
    }
    (n as Record<string, unknown>)[k] = v;
  }
  if (!n.title) n.title = NEW_CHAT;
  if (!n.source) n.source = "manual";
}
