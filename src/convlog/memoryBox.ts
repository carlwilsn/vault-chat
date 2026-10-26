// A box in memory, for the previews (the phone's ?mock=1 page, the preview
// harness's fake box): the box's conversation routes over an in-memory feed —
// GET /poll?after=N, GET /api/v2/conversations, GET /api/v2/conversations/<id>/
// checkpoint, POST /api/v2/intent — with the same records and the same fold as
// the real one (src/convlog/reduce.ts). The transcript is an in-memory pi
// session per conversation: what pi would write (its message entries, its live
// events while a message streams) and vault-chat's own `vc-note` entries.
// Scripts write what pi would make of a turn through its helpers. Never part of
// the server: the real feed is server/convlog/log.ts.
import type { EventBody, ItemImage, LogRecord, PendingInput, PiBlock, PiEntry, PiMessage } from "./protocol";
import { VC_NOTE } from "./protocol";
import { emptyPicture, emptyRow, foldInto, pendingOf, reduce, reduceRow, shown, type Picture, type RowState } from "./reduce";

export type Answer = { status: number; body: unknown };

/** A message as the older fixtures write one (src/store.ts ChatMessage-like). */
export type FixtureMessage = {
  role: "user" | "assistant";
  content?: string;
  mid?: string;
  system?: boolean;
  hidden?: boolean;
  decision?: boolean;
  thinking?: string;
  toolCalls?: { id?: string; name: string; input?: any; result?: string; subagents?: string[] }[];
  attachments?: { imageDataUrl?: string; capturedFilePath?: string }[];
  images?: string[];
  compaction?: { summary: string };
  rollover?: { recap?: string };
  askOptions?: { answer: string }[];
  costUsd?: number;
};

type Block = { ts: number; ci: number; kind: "assistant" | "thinking"; text: string };

export class MemoryBox {
  epoch = "mem-" + Math.random().toString(36).slice(2, 8);
  recs: LogRecord[] = [];
  private pics = new Map<string, Picture>();
  private rowsById = new Map<string, RowState>();
  private waiters = new Set<() => void>();
  private n = 0;
  private entryN = 0;
  private clock = Date.now();
  /** Every intent a client sent. */
  intents: any[] = [];
  /** Files a client uploaded with a message (POST /api/v2/attachment). */
  attachments: { path: string; size: number; dataBase64: string }[] = [];
  /** What a send does after Carl's message (default: nothing — the script replies). */
  onSend: (conv: string, intent: any) => void = () => {};
  now: () => number = () => Date.now();

  emit(conv: string | null, body: EventBody): LogRecord {
    const rec = { seq: this.recs.length + 1, conv, at: this.now(), ...body } as LogRecord;
    this.recs.push(rec);
    if (conv) {
      this.pics.set(conv, reduce(this.pics.get(conv) ?? emptyPicture(conv), rec));
      this.rowsById.set(conv, reduceRow(this.rowsById.get(conv) ?? emptyRow(conv), rec));
    }
    for (const w of [...this.waiters]) w();
    return rec;
  }

  picture(conv: string): Picture | null {
    const p = this.pics.get(conv);
    return p?.exists ? p : null;
  }

  latest(): number {
    return this.recs.length;
  }

  private meta(conv: string, patch: Record<string, unknown>): void {
    this.emit(conv, { type: "meta", patch });
  }

  /** pi's message timestamps (an assistant message's blocks are named by it). */
  private stamp(): number {
    return (this.clock = Math.max(Date.now(), this.clock + 1));
  }

  /** One entry of the conversation's (in-memory) pi session, and its pointer. */
  private entry(conv: string, e: Omit<PiEntry, "id">, extra: { clientId?: string; shown?: string; via?: string; images?: ItemImage[] } = {}): PiEntry {
    const entry = { ...e, id: `e${++this.entryN}` } as PiEntry;
    this.emit(conv, { type: "entry", file: `mem:${conv}`, entry, ...extra });
    return entry;
  }

  private live(conv: string, ev: any): void {
    this.emit(conv, { type: "live", ev });
  }

  // ---------- what pi would make of a turn ----------

  create(conv: string, meta: Record<string, unknown> & { title?: string; source?: string } = {}): void {
    const at = this.now();
    this.meta(conv, { title: meta.title ?? "New chat", source: meta.source ?? "phone", createdAt: at, lastActivityAt: at, ...meta });
  }

  turnOf(conv: string): string | undefined {
    return this.picture(conv)?.meta.running?.turn;
  }

  startTurn(conv: string, kind: "user" | "wake" | "nudge" | "resume" = "user"): string {
    const turn = `t${++this.n}`;
    this.meta(conv, { running: { turn, kind, startedAt: this.now() }, state: "running" });
    return turn;
  }

  endTurn(conv: string, _status: "completed" | "stopped" | "failed" | "cut" = "completed"): void {
    const p = this.picture(conv);
    if (!p?.meta.running) return;
    this.endLive(conv);
    this.meta(conv, { running: null, pending: null, state: "idle" });
  }

  /** Carl's message as pi's user entry (under his client's id). */
  userLine(conv: string, id: string, text: string, via = "chat", images: ItemImage[] = []): void {
    this.entry(conv, { type: "message", message: { role: "user", content: [{ type: "text", text }], timestamp: this.stamp() } }, { clientId: id, shown: text, via, ...(images.length ? { images } : {}) });
  }

  /** vault-chat's own line (voice, a line brought in, a notice): a vc-note entry. */
  note(conv: string, id: string, data: { kind: "line" | "notice" | "divider" | "tool"; [k: string]: unknown }): void {
    this.entry(conv, { type: "custom", customType: VC_NOTE, data: { ...data, clientId: id } }, { clientId: id });
  }

  /** A block of a reply that starts streaming (pi's live events): deltas, then its end, then pi's entry. */
  open(conv: string, kind: "assistant" | "thinking"): { id: string; delta: (s: string) => void; end: () => void } {
    if (!this.picture(conv)?.meta.running) this.startTurn(conv);
    const b: Block = { ts: this.stamp(), ci: 0, kind, text: "" };
    const t = kind === "assistant" ? "text" : "thinking";
    this.live(conv, { type: "message_start", message: { role: "assistant", timestamp: b.ts } });
    this.live(conv, { type: "message_update", assistantMessageEvent: { type: `${t}_start`, contentIndex: 0 } });
    return {
      id: `${b.ts}:0`,
      delta: (s) => {
        b.text += s;
        this.live(conv, { type: "message_update", assistantMessageEvent: { type: `${t}_delta`, contentIndex: 0, delta: s } });
      },
      end: () => {
        this.live(conv, { type: "message_update", assistantMessageEvent: { type: `${t}_end`, contentIndex: 0, content: b.text } });
        const block: PiBlock = kind === "assistant" ? { type: "text", text: b.text } : { type: "thinking", thinking: b.text };
        this.entry(conv, { type: "message", message: { role: "assistant", content: [block], stopReason: "stop", timestamp: b.ts } });
      },
    };
  }

  say(conv: string, text: string, chunks = 1): string {
    const b = this.open(conv, "assistant");
    const size = Math.max(1, Math.ceil(text.length / chunks));
    for (let i = 0; i < text.length; i += size) b.delta(text.slice(i, i + size));
    b.end();
    return b.id;
  }

  /** A tool call the model made (pi's entry), running; with its result, done (pi's toolResult). */
  tool(conv: string, id: string, name: string, args: unknown, result?: string): void {
    this.entry(conv, { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args ?? {} }], stopReason: "toolUse", timestamp: this.stamp() } });
    this.live(conv, { type: "tool_execution_start", toolCallId: id, toolName: name, args });
    if (result !== undefined) this.toolResult(conv, id, name, result);
  }

  /** The tool call ends: pi's event, then its toolResult entry. */
  toolDone(conv: string, id: string, result: string): void {
    const call = shown(this.picture(conv) ?? emptyPicture(conv)).find((x) => x.id === id);
    this.live(conv, { type: "tool_execution_end", toolCallId: id, toolName: call?.name, isError: false, result: { content: [{ type: "text", text: result }] } });
    this.toolResult(conv, id, call?.name ?? "tool", result);
  }

  private toolResult(conv: string, id: string, name: string, result: string, clientId?: string): void {
    this.entry(conv, { type: "message", message: { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: result }], isError: false, timestamp: this.stamp() } }, clientId ? { clientId } : {});
  }

  /** pi delivered Carl's steer / queued message: his message where pi put it. */
  deliver(conv: string, id: string): void {
    const p = this.picture(conv);
    const x = p ? pendingOf(p).find((y) => y.id === id) : undefined;
    if (!x) return;
    this.setPending(conv, undefined, id);
    this.userLine(conv, id, x.text, x.kind);
  }

  private setPending(conv: string, add?: PendingInput, remove?: string): void {
    const cur = pendingOf(this.picture(conv) ?? emptyPicture(conv)).filter((x) => x.id !== remove);
    const next = add ? [...cur, add] : cur;
    this.meta(conv, { pending: next.length ? next : null });
  }

  /** An older fixture's messages as the entries pi would have written (server/convlog/importer.ts shapes). */
  import(conv: string, meta: Record<string, unknown> & { title?: string; source?: string }, messages: FixtureMessage[]): void {
    const { messages: _m, status: _s, todos, subagents, costUsd, ...rest } = meta as any;
    this.create(conv, rest);
    this.append(conv, messages);
    this.applyMeta(conv, { todos, subagents, ...(typeof costUsd === "number" && costUsd > 0 ? { costUsd } : {}) });
  }

  private fixtureN = 0;
  /** Messages added to a conversation, as pi's entries. `withoutText`: the text is already a streamed message. */
  append(conv: string, messages: FixtureMessage[], o: { withoutText?: boolean } = {}): void {
    messages.forEach((m, n) => {
      const base = m.mid ?? `${conv}-f${++this.fixtureN}`;
      const images: ItemImage[] = [...(m.attachments ?? []).map((a) => ({ path: a.capturedFilePath ?? "", ...(a.imageDataUrl ? { dataUrl: a.imageDataUrl } : {}) })), ...(m.images ?? []).map((u) => (/^data:/.test(u) ? { path: "", dataUrl: u } : { path: u }))];
      if (m.role === "user") {
        if (m.hidden) return;
        if (m.system) this.userLine(conv, base, String(m.content ?? "").replace(/^(⏰|↻)\s*/, ""), "wake");
        else this.userLine(conv, base, m.content ?? "", m.decision ? "answer" : "chat", images);
        return;
      }
      if (m.system) {
        const summary = m.compaction?.summary ?? m.rollover?.recap;
        if (summary !== undefined) this.note(conv, base, { kind: "divider", text: summary, ...(m.rollover ? { rollover: true } : {}) });
        else this.note(conv, base, { kind: "notice", text: m.content ?? "" });
        return;
      }
      const content: PiBlock[] = [];
      if (m.thinking?.trim()) content.push({ type: "thinking", thinking: m.thinking });
      const asking = !!m.askOptions?.length;
      if ((m.content ?? "").trim() && !o.withoutText && !asking) content.push({ type: "text", text: m.content ?? "" });
      const calls = (m.toolCalls ?? []).map((t, j) => ({ id: t.id ?? `${base}:tool:${j}`, t }));
      for (const { id, t } of calls) content.push({ type: "toolCall", id, name: t.name, arguments: t.input ?? {} });
      const askId = `${base}:ask`;
      if (asking) content.push({ type: "toolCall", id: askId, name: "AskUser", arguments: { question: m.content ?? "", options: m.askOptions!.map((x) => x.answer) } });
      if (content.length) this.entry(conv, { type: "message", message: { role: "assistant", content, stopReason: calls.length || asking ? "toolUse" : "stop", timestamp: this.stamp() } as PiMessage });
      for (const { id, t } of calls) if (t.result !== undefined) this.toolResult(conv, id, t.name, t.result);
      for (const { id, t } of calls) if (t.subagents?.length) this.applyMeta(conv, { subagents: t.subagents.map((s) => ({ threadId: s, toolCallId: id })) });
      if (asking) {
        if (n === messages.length - 1) this.meta(conv, { asking: { question: m.content ?? "", options: m.askOptions!.map((x) => x.answer), toolCallId: askId, at: this.now() } });
        else this.toolResult(conv, askId, "AskUser", "");
      }
      if (typeof m.costUsd === "number") this.applyMeta(conv, { costUsd: m.costUsd });
    });
  }

  /** Conversation fields a fixture changes: the plan (pi's TodoWrite call), subagents and cost (fields), the rest as they are. */
  applyMeta(conv: string, meta: Record<string, unknown>): void {
    const { todos, subagents, costUsd, title, ...rest } = meta as any;
    if (Array.isArray(todos)) {
      const id = `${conv}-plan-${++this.fixtureN}`;
      this.tool(conv, id, "TodoWrite", { todos }, `updated: ${todos.length} items`);
    }
    const m = this.picture(conv)?.meta;
    const patch: Record<string, unknown> = { ...(title ? { title } : {}) };
    if (Array.isArray(subagents) && subagents.length) {
      const subs = ((m?.subagents ?? []) as any[]).slice();
      for (const s of subagents as any[]) {
        const i = subs.findIndex((x) => x.threadId === s.threadId);
        if (i >= 0) subs[i] = { ...subs[i], ...s };
        else subs.push(s);
      }
      patch.subagents = subs;
    }
    if (typeof costUsd === "number" && costUsd) patch.costUsd = Math.round(((Number(m?.costUsd) || 0) + costUsd) * 1e7) / 1e7;
    for (const k of ["state", "project", "working", "nextWakeAt", "verdict"]) if (k in rest) patch[k] = rest[k] ?? null;
    if (Object.keys(patch).length) this.meta(conv, patch);
  }

  /**
   * One step of an older preview script ({append, meta, status, events} in the
   * shapes the box sent before the feed): what the box's feed carries for it
   * now. The live text of `runtime` events streams as pi's live events; the
   * reply a `message` event announces is pi's entry for it (its tools and
   * thinking added); running/idle are the turn's start and end.
   */
  private streams = new Map<string, { text?: { b: ReturnType<MemoryBox["open"]>; s: string }; think?: { b: ReturnType<MemoryBox["open"]>; s: string }; tools: { id: string; name: string; done: boolean }[] }>();
  private liveOf(id: string) {
    let l = this.streams.get(id);
    if (!l) this.streams.set(id, (l = { tools: [] }));
    return l;
  }
  /** The live blocks end: the text with the reply's final text, the thinking, the tool calls (with the reply's results). */
  private endLive(id: string, m?: FixtureMessage): { text: boolean; thinking: boolean; matched: Set<number> } {
    const l = this.streams.get(id);
    const matched = new Set<number>();
    if (!l) return { text: false, thinking: false, matched };
    const out = { text: !!l.text, thinking: !!l.think, matched };
    if (l.think) {
      const fin = m?.thinking;
      if (fin && fin.startsWith(l.think.s)) l.think.b.delta(fin.slice(l.think.s.length));
      l.think.b.end();
    }
    for (const t of l.tools) {
      if (t.done) continue;
      const j = (m?.toolCalls ?? []).findIndex((c, k) => !matched.has(k) && c.name === t.name);
      const c = j >= 0 ? m!.toolCalls![j]! : undefined;
      if (j >= 0) matched.add(j);
      this.toolResult(id, t.id, t.name, c?.result ?? "");
      if (c?.subagents?.length) this.applyMeta(id, { subagents: c.subagents.map((s) => ({ threadId: s, toolCallId: t.id })) });
      t.done = true;
    }
    if (l.text) {
      const fin = m?.content ?? "";
      if (fin.startsWith(l.text.s)) l.text.b.delta(fin.slice(l.text.s.length));
      l.text.b.end();
    }
    this.streams.delete(id);
    return out;
  }
  /** A reply the script appends: what streamed live becomes it; the rest of it is added. */
  private landReply(id: string, m: FixtureMessage): void {
    const done = this.endLive(id, m);
    const rest: FixtureMessage = { ...m, ...(done.thinking ? { thinking: undefined } : {}), toolCalls: (m.toolCalls ?? []).filter((_, k) => !done.matched.has(k)) };
    this.append(id, [rest], { withoutText: done.text });
  }
  applyLegacyStep(st: { append?: Record<string, FixtureMessage[]>; meta?: Record<string, Record<string, unknown>>; status?: Record<string, string>; events?: any[] }): void {
    for (const [id, m] of Object.entries(st.meta ?? {})) if (this.picture(id)) this.applyMeta(id, m);
    const appended = new Map(Object.entries(st.append ?? {}).map(([id, ms]) => [id, [...ms]]));
    const take = (id: string, role?: string) => {
      const list = appended.get(id) ?? [];
      const i = role ? list.findIndex((m) => m.role === role) : 0;
      return i >= 0 ? list.splice(i, 1)[0] : undefined;
    };
    for (const ev of st.events ?? []) {
      const id = String(ev.convId ?? "");
      if (!id || !this.picture(id)) continue;
      const running = !!this.picture(id)!.meta.running;
      if ((ev.type === "status" && ev.status === "running") || (ev.type === "chat" && ev.phase === "start")) {
        if (!running) this.startTurn(id);
      } else if (ev.type === "runtime" || (ev.type === "chat" && (ev.phase === "stream" || ev.phase === "delta"))) {
        if (!running) this.startTurn(id);
        const l = this.liveOf(id);
        // Its thinking so far.
        if (typeof ev.reasoning === "string" && ev.reasoning) {
          l.think ??= { b: this.open(id, "thinking"), s: "" };
          if (ev.reasoning.startsWith(l.think.s) && ev.reasoning.length > l.think.s.length) {
            l.think.b.delta(ev.reasoning.slice(l.think.s.length));
            l.think.s = ev.reasoning;
          }
        }
        // The tool call it is on (a new name: the one before it is over).
        const tool = String(ev.tool ?? "");
        const cur = l.tools.find((t) => !t.done);
        if (tool && (!cur || cur.name !== tool)) {
          if (cur) {
            this.toolResult(id, cur.id, cur.name, "");
            cur.done = true;
          }
          const tid = `${id}-live-${++this.fixtureN}`;
          this.tool(id, tid, tool, ev.toolArg ? { path: String(ev.toolArg) } : {});
          l.tools.push({ id: tid, name: tool, done: false });
        } else if (tool && cur && ev.toolArg) this.live(id, { type: "tool_execution_start", toolCallId: cur.id, toolName: cur.name, args: { path: String(ev.toolArg) } });
        // Its text so far (offset + delta pieces, or the whole text).
        const prev = l.text?.s ?? "";
        const full = typeof ev.offset === "number" && typeof ev.delta === "string" ? (ev.offset === 0 ? ev.delta : prev.slice(0, ev.offset) + ev.delta) : String(ev.text ?? "");
        if (full && full.startsWith(prev) && full.length > prev.length) {
          l.text ??= { b: this.open(id, "assistant"), s: "" };
          l.text.b.delta(full.slice(l.text.s.length));
          l.text.s = full;
        }
      } else if (ev.type === "message") {
        const m = take(id, ev.role);
        if (!m) continue;
        if (m.role === "assistant" && !m.system) this.landReply(id, m);
        else this.append(id, [m]);
      } else if ((ev.type === "status" && ev.status === "idle") || (ev.type === "chat" && ev.phase === "end")) {
        this.endLive(id);
        this.endTurn(id);
      }
    }
    for (const [id, rest] of appended) {
      if (!rest.length || !this.picture(id)) continue;
      for (const m of rest) {
        if (m.role === "assistant" && !m.system && this.streams.has(id)) this.landReply(id, m);
        else this.append(id, [m]);
      }
    }
    for (const [id, s] of Object.entries(st.status ?? {})) {
      const p = this.picture(id);
      if (!p) continue;
      if (s === "running" && !p.meta.running) this.startTurn(id);
      if (s === "idle" && p.meta.running) {
        this.endLive(id);
        this.endTurn(id);
      }
    }
  }

  // ---------- intents (the engine's answers, server/engine/engine.ts intent()) ----------

  intent(b: any): Record<string, unknown> {
    this.intents.push(b);
    // As the engine: no conversation named is Main's; a new id is a separate chat (src/threads.ts).
    const conv = String(b.convId ?? "") || "main";
    const p = this.picture(conv);
    switch (b.type) {
      case "send": {
        if (p && (shown(p).some((x) => x.id === b.clientId) || pendingOf(p).some((x) => x.id === b.clientId))) return { ok: true, convId: conv, duplicate: true };
        if (!p) this.create(conv, conv === "main" ? { title: "Main", source: "main", kind: "main" } : { kind: "separate", ...(b.project ? { project: String(b.project) } : {}) });
        if (p?.meta.asking) return this.intent({ ...b, type: "answer", convId: conv });
        if (p?.meta.running) return this.intent({ ...b, type: "steer", convId: conv });
        this.startTurn(conv);
        const images: ItemImage[] = (b.images ?? []).map((i: any) => ({ path: "", dataUrl: `data:${i.mime};base64,${i.dataBase64}` }));
        this.userLine(conv, b.clientId, String(b.text ?? "").trim() || "(image)", typeof b.via === "string" && b.via ? b.via : "chat", images);
        this.onSend(conv, b);
        return { ok: true, convId: conv };
      }
      case "steer":
      case "queue":
        if (!p?.meta.running) return this.intent({ ...b, type: "send" });
        this.setPending(conv, { id: b.clientId, kind: b.type, text: String(b.text ?? ""), at: this.now() });
        return { ok: true, convId: conv, ...(b.type === "queue" ? { queued: true, qid: b.clientId } : { steered: true }) };
      case "unqueue":
        if (!p || !pendingOf(p).some((x) => x.id === b.id)) return { ok: false, error: "already delivered" };
        this.setPending(conv, undefined, b.id);
        return { ok: true };
      case "now": {
        // The engine's sendNow: the step is cut (no "Stopped." line), the message starts the next turn.
        const x = p && pendingOf(p).find((y) => y.id === b.id);
        if (!x || !p?.meta.running) return { ok: false, error: "already delivered" };
        this.endTurn(conv, "stopped");
        this.startTurn(conv);
        this.userLine(conv, x.id, x.text);
        this.onSend(conv, { ...b, type: "send", clientId: x.id, text: x.text });
        return { ok: true, convId: conv, now: x.id };
      }
      case "stop":
        if (p?.meta.running) {
          this.endTurn(conv, "stopped");
          this.note(conv, `${p.meta.running.turn}:stopped`, { kind: "notice", text: "Stopped." });
        }
        return { ok: true, result: p?.meta.running ? "Stopped." : "Nothing running on that thread." };
      case "answer": {
        const ask = p?.meta.asking;
        if (ask?.toolCallId) this.toolResult(conv, ask.toolCallId, "AskUser", `Carl answered: ${String(b.text ?? "")}`, b.clientId);
        else this.userLine(conv, b.clientId, String(b.text ?? ""), "answer");
        if (ask) this.meta(conv, { asking: null });
        return { ok: true, convId: conv, answered: true };
      }
      case "lines":
        if (!p) this.create(conv, { source: "manual" });
        (b.lines ?? []).forEach((l: any, i: number) => {
          if (!l.hidden) this.note(conv, `${b.clientId}:${i}`, { kind: "line", role: l.role === "assistant" ? "assistant" : "user", text: l.text });
        });
        return { ok: true, convId: conv };
      case "delete":
        this.meta(conv, { deleted: true });
        return { ok: true };
      case "deleteProject": {
        // Engine.deleteProject: the thread gone (every surface on it lands on Main), the clients told; Main can't be.
        const id = `project-${String(b.slug ?? "")}`;
        if (!b.slug || !this.picture(id) || this.picture(id)!.meta.deleted) return { ok: false, error: `no project ${b.slug}` };
        this.meta(id, { deleted: true });
        this.emit(null, { type: "signal", signal: { type: "project", slug: b.slug, deleted: true, convId: id, to: "main" } });
        return { ok: true, slug: b.slug, convId: id, to: "main" };
      }
      case "restoreProject": {
        // Engine.restoreProject (the agent's RestoreProject): the thread back as it was, the clients told.
        const id = `project-${String(b.slug ?? "")}`;
        if (!this.picture(id)?.meta.deleted) return { ok: false, error: `nothing deleted under "${b.slug}"` };
        this.meta(id, { deleted: null, deletedProject: null });
        this.emit(null, { type: "signal", signal: { type: "project", slug: b.slug, restored: true, convId: id } });
        return { ok: true, slug: b.slug, convId: id, name: this.picture(id)!.meta.title };
      }
      case "renameProject": {
        const id = `project-${String(b.slug ?? "")}`;
        const name = String(b.name ?? "").trim();
        if (!name || !this.picture(id)) return { ok: false, error: "a project needs a name" };
        this.meta(id, { title: name });
        this.emit(null, { type: "signal", signal: { type: "project", slug: b.slug, renamed: name } });
        return { ok: true, slug: b.slug, name };
      }
      default:
        return { error: "unknown intent" };
    }
  }

  // ---------- the routes ----------

  rows(): RowState[] {
    return [...this.rowsById.values()].filter((r) => this.picture(r.id) && !this.picture(r.id)!.meta.deleted).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  /** Exactly the records after `after` (a long poll: waits up to `waitMs` for one). */
  async poll(after: number, waitMs = 1500, epoch?: string | null): Promise<Record<string, unknown>> {
    if (epoch && epoch !== this.epoch) return { next: this.latest(), events: [], epoch: this.epoch, reset: true };
    if (after > this.latest()) return { next: this.latest(), events: [], epoch: this.epoch, reset: true };
    if (after === this.latest() && waitMs > 0) {
      await new Promise<void>((r) => {
        const done = () => {
          clearTimeout(t);
          this.waiters.delete(done);
          r();
        };
        const t = setTimeout(done, waitMs);
        this.waiters.add(done);
      });
    }
    return { next: this.latest(), events: this.recs.slice(after), epoch: this.epoch };
  }

  /** The box's conversation routes; null for any other path. */
  async route(method: string, path: string, query: URLSearchParams, body: any, waitMs = 1500): Promise<Answer | null> {
    if (method === "GET" && path === "/poll") {
      const a = query.get("after") ?? "latest";
      if (a === "latest") return { status: 200, body: { next: this.latest(), events: [], epoch: this.epoch } };
      return { status: 200, body: await this.poll(Number(a) || 0, waitMs, query.get("epoch")) };
    }
    if (method === "GET" && path === "/api/v2/conversations") return { status: 200, body: { rows: this.rows(), seq: this.latest(), epoch: this.epoch } };
    const m = /^\/api\/v2\/conversations\/([^/]+)\/(checkpoint|events)$/.exec(path);
    if (m && method === "GET") {
      const id = decodeURIComponent(m[1]!);
      const p = this.picture(id);
      if (!p) return { status: 404, body: { error: "conversation not found" } };
      if (m[2] === "checkpoint") return { status: 200, body: { seq: p.seq, picture: JSON.parse(JSON.stringify(p)), next: this.latest(), epoch: this.epoch } };
      const after = Number(query.get("after")) || 0;
      return { status: 200, body: { events: this.recs.filter((r) => r.conv === id && r.seq > after), next: this.latest(), epoch: this.epoch } };
    }
    if (method === "POST" && path === "/api/v2/intent") {
      const out = this.intent(body ?? {});
      return { status: (out as any).error ? 409 : 200, body: out };
    }
    if (method === "POST" && path === "/api/v2/attachment") {
      // As server/attachments.ts names it (the bytes are kept in memory for a check to read back).
      const name = String(body?.name ?? "attachment").replace(/[\\/]/g, "_");
      const size = Math.floor((String(body?.dataBase64 ?? "").length * 3) / 4);
      const rel = `.vault-chat/attachments/${new Date(this.now()).toISOString().slice(0, 10)}/${name}`;
      this.attachments.push({ path: rel, size, dataBase64: String(body?.dataBase64 ?? "") });
      return { status: 200, body: { ok: true, path: rel, abs: `/home/carl/vault/${rel}`, name, size } };
    }
    return null;
  }

  /** Tests: the fold of everything (a picture built from scratch, to compare a client's to). */
  fold(conv: string): Picture {
    return foldInto(emptyPicture(conv), this.recs);
  }
}
