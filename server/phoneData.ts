// Disk readers behind the phone GET routes, ported from voice_server.rs so
// the phone sees exactly the JSON shapes it saw from the desktop app.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, basename } from "node:path";
import { readConversationObjects } from "./commands/conversations";
import { globFiles } from "./commands/glob";
import { runGit } from "./git";

/** voice_server.rs:613 norm_ms. */
export function normMs(ts: number): number {
  if (!ts) return 0;
  if (ts >= 1e15) return Math.floor(ts / 1e6);
  if (ts >= 1e12) return ts;
  if (ts >= 1e9) return ts * 1000;
  return ts;
}

function str(v: unknown, d = ""): string {
  return typeof v === "string" ? v : d;
}
function int(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
}

/** voice_server.rs:1731 truncate (chars). */
export function truncateChars(s: string, max: number): string {
  if (Buffer.byteLength(s) <= max) return s;
  return [...s].slice(0, max).join("") + "\n…[truncated]";
}

function collapse(t: string, n: number): string {
  return [...t.split(/\s+/).filter(Boolean).join(" ")].slice(0, n).join("");
}

/** The project and ongoing-work fields (Phase 3): the conversation's
 *  project slug, engine state, next wake, cost, and the reason of its last
 *  ScheduleWake — what the clients' ongoing-work line is built from. Absent
 *  fields are left out, so old clients see the same shape. */
function ongoingMeta(c: any, msgs: any[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof c.project === "string" && c.project) out.project = c.project;
  if (typeof c.state === "string" && c.state) out.state = c.state;
  if (typeof c.nextWakeAt === "number") out.nextWakeAt = c.nextWakeAt;
  if (typeof c.costUsd === "number") out.costUsd = c.costUsd;
  if (c.working === true) out.working = true;
  // The long-run parts of the ongoing line: the project's metric, a parent's workers.
  const progress = [c.long?.metric, c.long?.workers].filter((x: unknown) => typeof x === "string" && x).join(" · ");
  if (progress) out.progress = progress;
  if (c.state === "sleeping") {
    outer: for (let i = msgs.length - 1; i >= 0; i--) {
      const calls: any[] = Array.isArray(msgs[i]?.toolCalls) ? msgs[i].toolCalls : [];
      for (let j = calls.length - 1; j >= 0; j--) {
        const r = /ScheduleWake/i.test(str(calls[j]?.name)) ? calls[j]?.input?.reason : undefined;
        if (typeof r === "string" && r.trim()) {
          out.wakeReason = collapse(r, 80);
          break outer;
        }
      }
    }
  }
  return out;
}

/** voice_server.rs:2084 conversations_summary_json. */
export function conversationsSummary(vault: string): unknown {
  const convs = readConversationObjects(vault);
  convs.sort((a, b) => (int(b.lastActivityAt) ?? 0) - (int(a.lastActivityAt) ?? 0));
  // Workers (RunWorkers) show as their parent's "N workers" line, not chats of their own.
  const rows = convs.filter((c) => !c.parent).slice(0, 60).map((c) => {
    const msgs: any[] = Array.isArray(c.messages) ? c.messages : [];
    const visible = (m: any) => m?.hidden !== true && str(m?.content).trim() !== "";
    const last = [...msgs].reverse().find(visible);
    const firstUser = msgs.find((m) => m?.role === "user" && visible(m));
    return {
      id: str(c.id),
      title: str(c.title, "New chat"),
      lastActivityAt: int(c.lastActivityAt) ?? 0,
      source: str(c.source, "manual"),
      role: str(c.role),
      mission: str(c.mission),
      msgCount: msgs.length,
      preview: last ? collapse(str(last.content), 120) : "",
      goal: firstUser ? collapse(str(firstUser.content), 220) : "",
      taskSummary: str(c.taskSummary),
      statusSummary: str(c.statusSummary),
      doneWhenDone: c.doneWhenDone ?? [],
      completedAt: int(c.completedAt),
      missionState: str(c.missionState),
      billing: c.billing === true,
      surfaced: c.surfaced === true,
      ...ongoingMeta(c, msgs),
    };
  });
  return { vault: basename(vault.replace(/[\\/]+$/, "")) || vault, conversations: rows };
}

/** A tool call the phone lists. The legacy per-child "Subagent" records (an
 *  engine before 2026-10-13 added one beside the `subagent` call itself) are
 *  dropped: one entry per spawn. */
function shownTool(t: any): boolean {
  return !(t?.name === "Subagent" && typeof t?.id === "string" && t.id.startsWith("sub-"));
}

/** What the phone needs beyond the text: thinking, cost, the context size,
 *  a summarized-earlier divider (compaction or roll-over) and the subagents a
 *  turn spawned. Absent when empty, so old clients see the same shape. */
function phoneExtras(m: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof m.thinking === "string" && m.thinking.trim()) out.thinking = truncateChars(m.thinking, 8_000);
  const cost = typeof m.costUsd === "number" ? m.costUsd : typeof m.usage?.costUsd === "number" ? m.usage.costUsd : undefined;
  if (typeof cost === "number") out.costUsd = cost;
  if (typeof m.usage?.context === "number" && m.usage.context > 0) out.context = m.usage.context;
  if (typeof m.usage?.window === "number" && m.usage.window > 0) out.window = m.usage.window;
  const summary = typeof m.compaction?.summary === "string" ? m.compaction.summary : typeof m.rollover?.recap === "string" ? m.rollover.recap : null;
  if (m.system === true && summary !== null) out.divider = truncateChars(summary, 12_000);
  const spawns = (Array.isArray(m.toolCalls) ? m.toolCalls : []).flatMap((t: any) => (Array.isArray(t?.subagents) ? t.subagents : []));
  if (spawns.length) out.spawns = spawns;
  if (m.failed === true) out.failed = true;
  const imgs = (Array.isArray(m.attachments) ? m.attachments : []).map((a: any) => a?.capturedFilePath ?? a?.sourcePath).filter((p: unknown) => typeof p === "string" && p);
  if (imgs.length) out.images = imgs;
  return out;
}

/** voice_server.rs:2168 conversation_json. */
export function conversationDetail(vault: string, id: string, n: number, full = false): unknown | null {
  const c = readConversationObjects(vault).find((x) => x.id === id);
  if (!c) return null;
  const take = Math.min(Math.max(n, 1), 200);
  const msgs: any[] = Array.isArray(c.messages) ? c.messages : [];
  const visible = msgs.filter((m) => m?.hidden !== true).slice(-take);
  if (full) {
    // The desktop client (box mode): the stored meta line and ChatMessage
    // objects as written, hidden ones included. The phone never asks for this.
    // Meta fields renamed 2026-10-11: files written before carry codexThreadId/codexThreadPath.
    const { messages: _all, codexThreadId, codexThreadPath, ...rest } = c as Record<string, any>;
    const meta = { ...rest, threadId: rest.threadId ?? codexThreadId, threadPath: rest.threadPath ?? codexThreadPath };
    return { id, title: str(c.title, "New chat"), source: str(c.source, "manual"), status: str(c.status, "idle"), full: true, meta, messages: msgs.slice(-take) };
  }
  return {
    id,
    title: str(c.title, "New chat"),
    source: str(c.source, "manual"),
    status: str(c.status, "idle"),
    runStartedAt: int(c.runStartedAt),
    askOf: str(c.askOf),
    askNotifId: str(c.askNotifId),
    askDecided: str(c.askDecided),
    askDecidedAt: int(c.askDecidedAt),
    ...ongoingMeta(c, msgs),
    ...(c.verdict && typeof c.verdict === "object" ? { verdict: c.verdict } : {}),
    ...(Array.isArray(c.todos) && c.todos.length ? { todos: c.todos } : {}),
    ...(Array.isArray(c.subagents) && c.subagents.length ? { subagents: c.subagents.map((x: any) => ({ threadId: x.threadId, task: x.task ?? x.prompt, agent: x.agent, model: x.model, state: x.state ?? x.status, costUsd: x.costUsd, summary: x.summary, toolCallId: x.toolCallId, startedAt: x.startedAt, endedAt: x.endedAt })) } : {}),
    messages: visible.map((m) => ({
      role: str(m.role, "assistant"),
      content: truncateChars(str(m.content), 20_000),
      system: m.system === true,
      tools: Array.isArray(m.toolCalls) ? m.toolCalls.filter(shownTool).map((t: any) => t?.name).filter((x: unknown) => typeof x === "string") : [],
      timeline: m.timeline ?? null,
      direct: m.direct === true,
      decision: m.decision === true,
      askOptions: m.askOptions ?? null,
      ...phoneExtras(m),
    })),
  };
}

function jsonlLines(path: string): any[] {
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: any[] = [];
  for (const l of raw.split("\n")) {
    try {
      const v = JSON.parse(l);
      if (v && typeof v === "object") out.push(v);
    } catch {
      /* skip */
    }
  }
  return out;
}

/** voice_server.rs:1950 notifications_json. */
export function notificationsFeed(vault: string): unknown {
  const items: any[] = [];
  const readIds = new Set<string>();
  const readTs = new Map<string, number>();
  const hidden = new Set<string>();
  let clearBefore = 0;
  const answered = new Map<string, [string, number]>();
  const followups = new Map<string, string>();
  for (const v of jsonlLines(join(vault, ".vault-chat", "notifications.jsonl"))) {
    const id = typeof v.id === "string" ? v.id : null;
    switch (v.type) {
      case "read":
        if (id) {
          readIds.add(id);
          if (typeof v.ts === "number" && !readTs.has(id)) readTs.set(id, v.ts);
        }
        break;
      case "answered":
        if (id) {
          const ts = int(v.ts) ?? 0;
          answered.set(id, [str(v.answer), ts]);
          readIds.add(id);
          if (ts > 0 && !readTs.has(id)) readTs.set(id, ts);
        }
        break;
      case "followup":
        if (id && typeof v.convId === "string") followups.set(id, v.convId);
        break;
      case "clear":
        if (typeof v.ts === "number") clearBefore = Math.max(clearBefore, v.ts);
        break;
      case "hide":
        if (id) hidden.add(id);
        break;
      default:
        if (id) {
          if (typeof v.ts === "number" && v.ts > 0) v.ts = normMs(Math.trunc(v.ts));
          items.push(v);
        }
    }
  }
  const kept = items.filter((v) => {
    if (hidden.has(v.id)) return false;
    const ts = int(v.ts) ?? 0;
    return !(readIds.has(v.id) && ts <= clearBefore);
  });
  const byId = new Map<string, any>();
  for (const it of kept) byId.set(it.id, it);
  const list = [...byId.entries()].map(([id, v]) => {
    v.read = readIds.has(id);
    if (readTs.has(id)) v.readAt = readTs.get(id);
    const a = answered.get(id);
    if (a) {
      v.answeredWith = a[0];
      v.answeredAt = a[1];
    }
    if (followups.has(id)) v.followupConvId = followups.get(id);
    return v;
  });
  list.sort((a, b) => (int(b.ts) ?? 0) - (int(a.ts) ?? 0));
  const top = list.slice(0, 80);
  return { unread: top.filter((v) => v.read !== true).length, notifications: top };
}

/** voice_server.rs:1819-1834 note_status_rank / note_prefers. */
function noteRank(v: any): number {
  return v.status === "cleared" ? 2 : v.status === "resolved" ? 1 : 0;
}
function notePrefers(a: any, b: any): boolean {
  const ra = noteRank(a);
  const rb = noteRank(b);
  if (ra !== rb) return ra > rb;
  return str(a.last_updated) >= str(b.last_updated);
}

/** voice_server.rs:1842 notes_json + 1880 slim_note. */
export function notesFeed(vault: string): unknown {
  const byId = new Map<string, any>();
  for (const v of jsonlLines(join(vault, ".vault-chat", "notes.jsonl"))) {
    if (typeof v.id !== "string") continue;
    const prev = byId.get(v.id);
    if (!prev || notePrefers(v, prev)) byId.set(v.id, v);
  }
  const list = [...byId.values()]
    .filter((v) => v.status !== "cleared")
    .map((v) => ({
      id: v.id ?? null,
      timestamp: v.timestamp ?? null,
      last_updated: v.last_updated ?? null,
      status: str(v.status, "open"),
      user_draft: v.user_draft ?? null,
      formatted: v.formatted ?? null,
      title: v.title ?? null,
      anchors: (Array.isArray(v.anchors) ? v.anchors : []).map((a: any) => ({
        source_path: a?.source_path ?? null,
        source_kind: a?.source_kind ?? null,
        source_anchor: a?.source_anchor ?? null,
        source_selection: a?.source_selection ?? null,
      })),
      turns: (Array.isArray(v.turns) ? v.turns : []).map((t: any) => ({
        role: t?.role ?? null,
        content: [...str(t?.content)].slice(0, 4000).join(""),
      })),
    }));
  list.sort((a, b) => (str(b.last_updated) < str(a.last_updated) ? -1 : str(b.last_updated) > str(a.last_updated) ? 1 : 0));
  const top = list.slice(0, 200);
  return { open: top.filter((v) => v.status === "open").length, notes: top };
}

/** voice_server.rs:1335 within_vault. */
export function withinVault(vault: string, path: string): string | null {
  try {
    const root = realpathSync(vault);
    const target = realpathSync(isAbsolute(path) ? path : join(vault, path));
    const sep = root.includes("\\") ? "\\" : "/";
    if (target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)) return target;
    return null;
  } catch {
    return null;
  }
}

/** voice_server.rs:2237 mime_for. */
export function mimeFor(path: string): string {
  const ext = (path.split(".").pop() ?? "").toLowerCase();
  switch (ext) {
    case "md":
    case "txt":
    case "log":
    case "csv":
    case "tex":
      return "text/plain; charset=utf-8";
    case "html":
    case "htm":
      return "text/html; charset=utf-8";
    case "pdf":
      return "application/pdf";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "json":
    case "ipynb":
    case "jsonl":
      return "application/json";
    case "mp4":
      return "video/mp4";
    case "mp3":
      return "audio/mpeg";
    default:
      return "application/octet-stream";
  }
}

export function fileSize(p: string): number {
  return statSync(p).size;
}

/** voice_server.rs:1569 dispatch_tool — the read-only voice tool fallback
 * (there is no voice host headless, so this is the only path). */
export async function dispatchVoiceTool(vault: string, raw: string): Promise<string> {
  let v: any;
  try {
    v = JSON.parse(raw);
  } catch {
    return "error: malformed tool request";
  }
  const name = str(v?.name);
  const args = v?.arguments ?? v?.parameters ?? v;
  const s = (k: string) => str(args?.[k]);
  switch (name) {
    case "Read": {
      const path = s("path");
      const p = withinVault(vault, path);
      if (!p) return `error: ${path} is outside the vault`;
      try {
        return truncateChars(readFileSync(p, "utf8"), 12_000);
      } catch (e) {
        return `error reading ${path}: ${(e as Error).message}`;
      }
    }
    case "Glob": {
      const full = `${vault.replace(/\\/g, "/")}/${s("pattern").replace(/^\/+/, "")}`;
      const root = vault.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
      const out = globFiles(full)
        .map((p) => p.replace(/\\/g, "/"))
        .filter((p) => p.startsWith(root))
        .map((p) => p.slice(root.length))
        .sort()
        .slice(0, 200);
      return out.length ? out.join("\n") : "(no matches)";
    }
    case "GitLog": {
      const rel = s("subdir").trim();
      const dir = rel === "" || rel === "." ? vault : join(vault, rel);
      const a = ["log", "--oneline", "--no-color", `-n${Math.min(int(args?.max_count) ?? 30, 200)}`];
      if (s("since").trim()) a.push(`--since=${s("since").trim()}`);
      if (s("author").trim()) a.push(`--author=${s("author").trim()}`);
      try {
        const r = await runGit(dir, a);
        return r.code === 0 && r.stdout.trim() ? truncateChars(r.stdout.trim(), 6000) : "(no commits match)";
      } catch (e) {
        return `error: ${e}`;
      }
    }
    case "ListConversations": {
      const convs = readConversationObjects(vault).sort((a, b) => (int(b.lastActivityAt) ?? 0) - (int(a.lastActivityAt) ?? 0));
      const lines = convs.slice(0, 25).map((c) => `${str(c.id, "?")} — ${str(c.title, "(untitled)")} (${Array.isArray(c.messages) ? c.messages.length : 0} msgs)`);
      return lines.length ? lines.join("\n") : "(no conversations)";
    }
    case "ReadConversation": {
      const id = s("conversation_id");
      const n = Math.min(Math.max(int(args?.last_n) ?? 12, 1), 50);
      const c = readConversationObjects(vault).find((x) => x.id === id);
      if (!c) return `conversation ${id} not found`;
      const tail = (Array.isArray(c.messages) ? c.messages : []).slice(-n).map((m: any) => `[${str(m.role, "?")}] ${truncateChars(str(m.content), 600)}`);
      return `${str(c.title, "(untitled)")}\n\n${tail.join("\n\n")}`;
    }
    default:
      return `"${name}" isn't available over phone voice — this channel is read-only (read files, search, git history, conversations). Ask me to look things up or talk it through instead.`;
  }
}

