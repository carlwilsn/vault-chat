// Older conversations (`.vault-chat/conversations/*.jsonl`, written before the
// event log) as log records: imported once, the first time one is opened (or
// the engine reads it); the original file is never touched. Pure: the same
// conversation always gives the same records.
import { readConversationObjects } from "../commands/conversations";
import type { EventBody, Item, ItemImage } from "../../src/convlog/protocol";
import { META_FIELDS } from "../../src/convlog/protocol";
import { emptyRow, titleFrom, type RowState } from "../../src/convlog/reduce";
import type { LegacySource } from "./log";

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function images(m: any): ItemImage[] {
  return (Array.isArray(m?.attachments) ? m.attachments : [])
    .map((a: any) => {
      const path = str(a?.capturedFilePath) || str(a?.sourcePath);
      const dataUrl = str(a?.imageDataUrl);
      return path || dataUrl ? { path, ...(dataUrl && dataUrl.length < 600_000 ? { dataUrl } : {}) } : null;
    })
    .filter(Boolean) as ItemImage[];
}

/** One older conversation → its records. */
export function legacyRecords(c: any): EventBody[] {
  const out: EventBody[] = [];
  const meta: Record<string, unknown> = { title: str(c.title) || "New chat", source: str(c.source) || "manual" };
  const createdAt = num(c.createdAt);
  const lastActivityAt = num(c.lastActivityAt);
  if (createdAt) meta.createdAt = createdAt;
  if (lastActivityAt) meta.lastActivityAt = lastActivityAt;
  for (const k of META_FIELDS) {
    if (k === "title" || k === "source") continue;
    const v = c[k] ?? (k === "threadId" ? c.codexThreadId : k === "threadPath" ? c.codexThreadPath : undefined);
    if (v !== undefined && v !== null && v !== "") meta[k] = v;
  }
  out.push({ type: "conv.created", meta: meta as any });
  const msgs: any[] = Array.isArray(c.messages) ? c.messages : [];
  const seen = new Set<string>();
  msgs.forEach((m, n) => {
    let base = str(m?.mid) || `imp${n}`;
    if (seen.has(base)) base = `${base}~${n}`;
    seen.add(base);
    const turn = `imp-${n}`;
    const text = str(m?.content);
    const add = (it: Omit<Item, "at">) => out.push({ type: "item.started", item: { ...it, at: 0 } as Item });
    if (m?.role === "user") {
      if (m.system) {
        const wake = text.startsWith("⏰") ? "wake" : "resume";
        add({ id: base, kind: "wake", status: "done", wake, text: text.replace(/^(⏰|↻)\s*/, "") });
        return;
      }
      const imgs = images(m);
      add({
        id: base,
        kind: "user",
        status: "done",
        text,
        via: m.decision ? "answer" : "import",
        ...(m.hidden ? { hidden: true } : {}),
        ...(imgs.length ? { images: imgs } : {}),
      });
      return;
    }
    // An assistant message: its system lines, else its thinking, its text and its tool calls (as the chat showed them).
    if (m?.system) {
      const summary = str(m.compaction?.summary) || str(m.rollover?.recap);
      if (m.compaction || m.rollover) add({ id: base, kind: "compaction", status: "done", text: summary, ...(m.rollover ? { rollover: true } : {}) });
      else add({ id: base, kind: "notice", status: "done", text, level: m.failed ? "error" : "info" });
      return;
    }
    if (str(m?.thinking).trim()) add({ id: `${base}:th`, kind: "thinking", status: "done", text: m.thinking, turn });
    if (text.trim()) add({ id: `${base}:a`, kind: "assistant", status: "done", text, turn });
    (Array.isArray(m?.toolCalls) ? m.toolCalls : []).forEach((t: any, j: number) => {
      if (t?.name === "Subagent" && str(t?.id).startsWith("sub-")) return; // a legacy duplicate record
      add({
        id: `${base}:tool:${j}`,
        kind: "tool",
        status: "done",
        turn,
        name: str(t?.name) || "tool",
        args: t?.input ?? {},
        ...(t?.result !== undefined ? { result: String(t.result) } : {}),
        ...(Array.isArray(t?.subagents) && t.subagents.length ? { subagents: t.subagents.map(String) } : {}),
      });
    });
    const cost = num(m?.costUsd) ?? num(m?.usage?.costUsd);
    if (cost) out.push({ type: "cost", turn, usd: cost });
  });
  // The conversation's own total where the messages did not carry it.
  const perMsg = msgs.reduce((s, m) => s + (num(m?.costUsd) ?? num(m?.usage?.costUsd) ?? 0), 0);
  const total = num(c.costUsd);
  if (total && total - perMsg > 1e-9) out.push({ type: "cost", usd: Math.round((total - perMsg) * 1e7) / 1e7, ...(num(c.costMissingCalls) ? { missing: num(c.costMissingCalls) } : {}) });
  for (const s of Array.isArray(c.subagents) ? c.subagents : []) {
    if (s && typeof s.threadId === "string") {
      const { threadId, ...patch } = s;
      out.push({ type: "subagent", threadId, patch });
    }
  }
  if (Array.isArray(c.todos) && c.todos.length) out.push({ type: "item.started", item: { id: "imp-plan", kind: "plan", status: "done", todos: c.todos, at: 0 } });
  // An open question survives (answered, it starts a new turn).
  if (c.pendingAsk && typeof c.pendingAsk.question === "string") {
    out.push({
      type: "item.started",
      item: { id: "imp-ask", kind: "ask", status: "pending", question: c.pendingAsk.question, options: Array.isArray(c.pendingAsk.options) ? c.pendingAsk.options.map(String) : [], at: 0 },
    });
  }
  return out;
}

function rowOfLegacy(c: any): RowState {
  const r = emptyRow(String(c.id));
  r.title = str(c.title) || "New chat";
  if (r.title === "New chat") {
    const first = (Array.isArray(c.messages) ? c.messages : []).find((m: any) => m?.role === "user" && !m.hidden && !m.system && str(m.content).trim());
    if (first) r.title = titleFrom(first.content);
  }
  r.source = str(c.source) || "manual";
  r.createdAt = num(c.createdAt) ?? 0;
  r.lastActivityAt = num(c.lastActivityAt) ?? r.createdAt;
  if (str(c.project)) r.project = c.project;
  if (str(c.state)) r.state = c.state;
  if (c.working === true) r.working = true;
  if (num(c.nextWakeAt)) r.nextWakeAt = c.nextWakeAt;
  if (num(c.costUsd)) r.costUsd = c.costUsd;
  r.asking = !!c.pendingAsk;
  r.legacy = true;
  return r;
}

/** The importer for one vault. */
export function legacySource(vault: string): LegacySource {
  let cache: { at: number; list: any[] } | null = null;
  const list = () => {
    if (!cache || Date.now() - cache.at > 5_000) cache = { at: Date.now(), list: readConversationObjects(vault) };
    return cache.list;
  };
  return {
    rows: () => list().filter((c) => typeof c?.id === "string").map(rowOfLegacy),
    records: (id) => {
      const c = list().find((x) => x?.id === id);
      return c ? legacyRecords(c) : null;
    },
    at: (id) => {
      const c = list().find((x) => x?.id === id);
      return num(c?.lastActivityAt) ?? num(c?.createdAt) ?? Date.now();
    },
  };
}
