// Older conversations (`.vault-chat/conversations/*.jsonl`, written before the
// feed) brought in once, the first time one is opened (or the engine reads
// it): the transcript is written as a pi-format session file (pi's own message
// and custom entries, ./piSession.ts) and the feed points into it. The original
// file is never touched.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readConversationObjects } from "../commands/conversations";
import type { EventBody, ItemImage, PiEntry } from "../../src/convlog/protocol";
import { VC_NOTE } from "../../src/convlog/protocol";
import { emptyRow, titleFrom, type RowState } from "../../src/convlog/reduce";
import { fileStem, type LegacySource } from "./log";

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** The conversation fields an older file carries that the feed keeps as they are. */
const KEPT = ["project", "state", "working", "nextWakeAt", "verdict", "threadId", "threadPath", "recap", "costMissingCalls", "role", "mission", "missionState", "surfaced"];

function images(m: any): ItemImage[] {
  return (Array.isArray(m?.attachments) ? m.attachments : [])
    .map((a: any) => {
      const path = str(a?.capturedFilePath) || str(a?.sourcePath);
      const dataUrl = str(a?.imageDataUrl);
      return path || dataUrl ? { path, ...(dataUrl && dataUrl.length < 600_000 ? { dataUrl } : {}) } : null;
    })
    .filter(Boolean) as ItemImage[];
}

type Line = { entry: Omit<PiEntry, "id" | "parentId" | "timestamp">; clientId?: string; shown?: string; via?: string; images?: ItemImage[] };

/** One older conversation → its transcript as pi entries (with the client ids the chat showed them under) and its fields. Pure. */
export function legacyTranscript(c: any): { meta: Record<string, unknown>; lines: Line[] } {
  const meta: Record<string, unknown> = { title: str(c.title) || "New chat", source: str(c.source) || "manual" };
  const createdAt = num(c.createdAt);
  const lastActivityAt = num(c.lastActivityAt);
  if (createdAt) meta.createdAt = createdAt;
  if (lastActivityAt) meta.lastActivityAt = lastActivityAt;
  for (const k of KEPT) {
    const v = c[k] ?? (k === "threadId" ? c.codexThreadId : k === "threadPath" ? c.codexThreadPath : undefined);
    if (v !== undefined && v !== null && v !== "") meta[k] = v;
  }
  // The total: the file's own, else what its messages carried.
  const perMsg = (Array.isArray(c.messages) ? c.messages : []).reduce((t: number, m: any) => t + (num(m?.costUsd) ?? num(m?.usage?.costUsd) ?? 0), 0);
  const total = num(c.costUsd) ?? (perMsg ? Math.round(perMsg * 1e7) / 1e7 : undefined);
  if (total) meta.costUsd = total;
  const subs = (Array.isArray(c.subagents) ? c.subagents : []).filter((s: any) => s && typeof s.threadId === "string");
  if (subs.length) meta.subagents = subs;

  const lines: Line[] = [];
  const msgs: any[] = Array.isArray(c.messages) ? c.messages : [];
  // pi's message timestamps name an assistant message's blocks: unique, in order.
  let ts = (createdAt ?? 0) || 1;
  const seen = new Set<string>();
  msgs.forEach((m, n) => {
    let base = str(m?.mid) || `imp${n}`;
    if (seen.has(base)) base = `${base}~${n}`;
    seen.add(base);
    const text = str(m?.content);
    ts++;
    if (m?.role === "user") {
      if (m.hidden) return; // context only, never shown
      if (m.system) {
        const via = text.startsWith("⏰") ? "wake" : "resume";
        const shown = text.replace(/^(⏰|↻)\s*/, "");
        lines.push({ entry: { type: "message", message: { role: "user", content: [{ type: "text", text: shown }], timestamp: ts } }, clientId: base, via, shown });
        return;
      }
      const imgs = images(m);
      lines.push({
        entry: { type: "message", message: { role: "user", content: [{ type: "text", text }], timestamp: ts } },
        clientId: base,
        via: m.decision ? "answer" : "import",
        ...(imgs.length ? { images: imgs } : {}),
      });
      return;
    }
    if (m?.system) {
      const summary = str(m.compaction?.summary) || str(m.rollover?.recap);
      if (m.compaction || m.rollover) lines.push({ entry: { type: "custom", customType: VC_NOTE, data: { kind: "divider", text: summary, ...(m.rollover ? { rollover: true } : {}) } } });
      else lines.push({ entry: { type: "custom", customType: VC_NOTE, data: { kind: "notice", text, level: m.failed ? "error" : "info" } } });
      return;
    }
    // An assistant message: its thinking, its text, its tool calls, then their results (pi's shape).
    const content: any[] = [];
    if (str(m?.thinking).trim()) content.push({ type: "thinking", thinking: m.thinking });
    if (text.trim()) content.push({ type: "text", text });
    const results: Line[] = [];
    (Array.isArray(m?.toolCalls) ? m.toolCalls : []).forEach((t: any, j: number) => {
      if (t?.name === "Subagent" && str(t?.id).startsWith("sub-")) return; // a legacy duplicate record
      const id = `imp_${n}_${j}`;
      const name = str(t?.name) || "tool";
      content.push({ type: "toolCall", id, name, arguments: t?.input ?? {} });
      results.push({ entry: { type: "message", message: { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: t?.result === undefined ? "" : String(t.result) }], isError: false, timestamp: ts } } });
    });
    if (!content.length) return;
    lines.push({ entry: { type: "message", message: { role: "assistant", content, stopReason: results.length ? "toolUse" : "stop", timestamp: ts } } });
    lines.push(...results);
  });
  // An open question survives as the question it was (answered, it starts a new turn).
  if (c.pendingAsk && typeof c.pendingAsk.question === "string") {
    const options = Array.isArray(c.pendingAsk.options) ? c.pendingAsk.options.map(String) : [];
    ts++;
    lines.push({ entry: { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "imp_ask", name: "AskUser", arguments: { question: c.pendingAsk.question, options } }], stopReason: "toolUse", timestamp: ts } } });
    meta.asking = { question: c.pendingAsk.question, options, toolCallId: "imp_ask", at: num(c.pendingAsk.at) ?? ts };
  }
  return { meta, lines };
}

/** Write the transcript as a pi session file under `dir`; the feed's records for it. */
export function importConversation(c: any, dir: string): EventBody[] {
  const { meta, lines } = legacyTranscript(c);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${fileStem(String(c.id))}.jsonl`);
  const at = new Date(num(c.createdAt) ?? Date.now()).toISOString();
  let parent: string | null = null;
  const out: EventBody[] = [{ type: "meta", patch: meta }];
  let raw = JSON.stringify({ type: "session", version: 3, id: randomUUID(), timestamp: at, cwd: "", importedFrom: `.vault-chat/conversations/${String(c.id)}.jsonl` }) + "\n";
  lines.forEach((l, i) => {
    const entry = { ...l.entry, id: `imp${i.toString(36)}`, parentId: parent, timestamp: at } as PiEntry;
    parent = entry.id;
    raw += JSON.stringify(entry) + "\n";
    out.push({ type: "entry", file, entry, ...(l.clientId ? { clientId: l.clientId } : {}), ...(l.shown !== undefined ? { shown: l.shown } : {}), ...(l.via ? { via: l.via } : {}), ...(l.images?.length ? { images: l.images } : {}) });
  });
  // Written whole (a crash mid-import leaves no records, and the next open writes it again).
  writeFileSync(file, raw);
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
    rows: () => {
      cache = null; // a fresh read: the list is asked for at boot and on a rescan
      return list().filter((c) => typeof c?.id === "string").map(rowOfLegacy);
    },
    records: (id, dir) => {
      let c = list().find((x) => x?.id === id);
      if (!c) {
        cache = null; // a file that arrived since the last read
        c = list().find((x) => x?.id === id);
      }
      return c ? importConversation(c, dir) : null;
    },
    at: (id) => {
      const c = list().find((x) => x?.id === id);
      return num(c?.lastActivityAt) ?? num(c?.createdAt) ?? Date.now();
    },
  };
}
