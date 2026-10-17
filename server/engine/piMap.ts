// pi's RPC events → the conversation log (src/convlog/protocol.ts), 1:1.
// One mapper per running turn. pi's own lifecycle is kept: a content block is
// an item that starts (text_start / thinking_start / toolcall_start), grows by
// deltas, and ends with pi's authoritative content (text_end / thinking_end /
// toolcall_end, then message_end); a tool call is the same item when it runs
// (tool_execution_start / _update / _end, keyed by pi's toolCallId).
//
// Deltas are coalesced (a few writes a second per item, never per token); any
// other record first flushes what is buffered, so the order on disk is pi's.
//
// Carl's messages that pi delivers mid-run (a steer, a queued follow-up) enter
// the transcript where pi puts them: at its user message_start. The engine
// says what it sent (`expect`); the match carries the client's id onto the item.
import type { EventBody, Item, ItemImage } from "../../src/convlog/protocol";

/** pi's tool names → the names the clients know. */
export const TOOL_NAMES: Record<string, string> = { bash: "Bash", read: "Read", write: "Write", edit: "Edit", grep: "Grep", find: "Glob", ls: "LS" };
export const toolName = (n: unknown): string => TOOL_NAMES[String(n ?? "")] ?? (String(n ?? "") || "tool");

const RESULT_CAP = 4_000;
const PARTIAL_CAP = 2_000;
const PARTIAL_EVERY_MS = 1_500;
const cap = (s: string, n = RESULT_CAP) => (s.length > n ? s.slice(0, n) + `\n…[${s.length - n} more chars]` : s);

/** What the engine sent pi that will come back as a user message. */
export type Expected =
  /** The turn's prompt (its user item is already in the log). */
  | { kind: "prompt"; text: string }
  /** An engine input (a wake, a nudge; its own item is in the log). */
  | { kind: "silent"; text: string }
  /** Carl's steer or queued message: becomes his user item, under his client's id. */
  | { kind: "steer" | "queue"; text: string; id: string; shown: string; images?: ItemImage[] };

export type MapperOpts = {
  turn: string;
  emit: (b: EventBody) => void;
  /** Coalescing window for deltas (ms). */
  flushMs?: number;
  now?: () => number;
};

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: any) => c?.type === "text" && typeof c.text === "string")
    .map((c: any) => c.text)
    .join("\n");
}

export class PiMapper {
  private msg = 0;
  private blocks = new Map<number, { id: string; kind: "assistant" | "thinking" | "tool" }>();
  private started = new Set<string>();
  private done = new Set<string>();
  private buf = new Map<string, { field: "text" | "argsText"; text: string }>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private expected: Expected[] = [];
  private partialAt = new Map<string, number>();
  private compactions = 0;
  private userN = 0;
  /** The provider's error on the last assistant message (stopReason "error"). */
  lastError: string | null = null;
  /** The texts of this turn's assistant items, in order (the activity stream's reply). */
  readonly replies: string[] = [];

  constructor(private o: MapperOpts) {}

  get turn(): string {
    return this.o.turn;
  }

  expect(e: Expected): void {
    this.expected.push(e);
  }

  /** Taken back before pi delivered it (unqueue, a stop): no longer expected. */
  forget(id: string): void {
    this.expected = this.expected.filter((e) => !("id" in e) || e.id !== id);
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  // ---------------------------------------------------------------- writing

  private out(b: EventBody): void {
    this.flush();
    this.o.emit(b);
  }

  /** Write the buffered deltas (in the order their items first buffered). */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.buf.size) return;
    const all = [...this.buf.entries()];
    this.buf.clear();
    for (const [id, d] of all) if (d.text) this.o.emit({ type: "item.delta", id, field: d.field, delta: d.text });
  }

  private delta(id: string, field: "text" | "argsText", text: string): void {
    if (!text) return;
    const cur = this.buf.get(id);
    if (cur && cur.field === field) cur.text += text;
    else {
      if (cur) this.flush();
      this.buf.set(id, { field, text });
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, this.o.flushMs ?? 120);
      this.timer.unref?.();
    }
  }

  private start(item: Omit<Item, "at">): void {
    if (this.started.has(item.id)) return;
    this.started.add(item.id);
    this.out({ type: "item.started", item: { ...item, turn: this.o.turn, at: this.now() } as Item });
  }

  private complete(id: string, patch?: Partial<Item>): void {
    if (this.done.has(id)) {
      if (patch && Object.keys(patch).length) this.out({ type: "item.updated", id, patch });
      return;
    }
    this.done.add(id);
    this.partialAt.delete(id);
    this.out({ type: "item.completed", id, ...(patch && Object.keys(patch).length ? { patch } : {}) });
  }

  private blockId(ci: number): string {
    return `${this.o.turn}:${this.msg}:${ci}`;
  }

  private ensureBlock(ci: number, kind: "assistant" | "thinking"): string {
    const b = this.blocks.get(ci);
    if (b) return b.id;
    const id = this.blockId(ci);
    this.blocks.set(ci, { id, kind });
    this.start({ id, kind, status: "streaming", text: "" });
    return id;
  }

  // ---------------------------------------------------------------- pi events

  onPi(ev: any): void {
    switch (ev?.type) {
      case "message_start": {
        const role = ev.message?.role;
        if (role === "assistant") {
          this.msg++;
          this.blocks.clear();
        } else if (role === "user") this.userMessage(textOf(ev.message?.content));
        return;
      }
      case "message_update":
        return this.update(ev.assistantMessageEvent ?? {});
      case "message_end": {
        const m = ev.message ?? {};
        if (m.role !== "assistant") return;
        this.endMessage(m);
        return;
      }
      case "tool_execution_start": {
        const id = String(ev.toolCallId ?? "");
        if (!id) return;
        if (!this.started.has(id)) this.start({ id, kind: "tool", status: "running", name: toolName(ev.toolName), args: ev.args ?? {} });
        else this.out({ type: "item.updated", id, patch: { status: "running", ...(ev.args !== undefined ? { args: ev.args } : {}) } });
        return;
      }
      case "tool_execution_update": {
        const id = String(ev.toolCallId ?? "");
        if (!id || !this.started.has(id) || this.done.has(id)) return;
        const t = this.now();
        if (t - (this.partialAt.get(id) ?? 0) < PARTIAL_EVERY_MS) return;
        const text = textOf(ev.partialResult?.content);
        if (!text) return;
        this.partialAt.set(id, t);
        this.out({ type: "item.updated", id, patch: { partial: text.slice(-PARTIAL_CAP) } });
        return;
      }
      case "tool_execution_end": {
        const id = String(ev.toolCallId ?? "");
        if (!id) return;
        if (!this.started.has(id)) this.start({ id, kind: "tool", status: "running", name: toolName(ev.toolName), args: ev.args ?? {} });
        const text = textOf(ev.result?.content);
        this.complete(id, { result: cap(`${ev.isError ? "[error] " : ""}${text}`), status: ev.isError ? "error" : "done" });
        return;
      }
      case "compaction_start": {
        this.compactions++;
        this.start({ id: `${this.o.turn}:compact:${this.compactions}`, kind: "compaction", status: "streaming" });
        return;
      }
      case "compaction_end": {
        const id = `${this.o.turn}:compact:${this.compactions}`;
        if (!this.started.has(id)) {
          this.compactions++;
          return this.compactionEnd(`${this.o.turn}:compact:${this.compactions}`, ev, true);
        }
        return this.compactionEnd(id, ev, false);
      }
      case "auto_retry_start": {
        const id = `${this.o.turn}:retry:${this.msg}:${ev.attempt ?? 0}`;
        this.start({ id, kind: "notice", status: "running", level: "warn", text: `Retrying (${ev.attempt ?? "?"}/${ev.maxAttempts ?? "?"}): ${String(ev.errorMessage ?? "the provider failed").slice(0, 300)}` });
        return;
      }
      case "auto_retry_end": {
        const ids = [...this.started].filter((x) => x.startsWith(`${this.o.turn}:retry:`) && !this.done.has(x));
        for (const id of ids) {
          if (ev.success === false) this.complete(id, { level: "error", status: "error", text: `Gave up after ${ev.attempt ?? "?"} attempts: ${String(ev.finalError ?? "the provider failed").slice(0, 300)}` });
          else this.complete(id);
        }
        return;
      }
      default:
        return;
    }
  }

  private compactionEnd(id: string, ev: any, fresh: boolean): void {
    if (ev.result && typeof ev.result.summary === "string") {
      if (fresh) this.start({ id, kind: "compaction", status: "streaming" });
      this.complete(id, { text: ev.result.summary });
      return;
    }
    if (fresh) return; // nothing was shown
    // Aborted or failed: the "summarizing" line becomes what happened.
    this.complete(id, { kind: "notice", level: ev.aborted ? "info" : "warn", text: ev.aborted ? "Summarizing the earlier conversation was stopped." : `Summarizing the earlier conversation failed: ${String(ev.errorMessage ?? "").slice(0, 300)}` });
  }

  private update(ae: any): void {
    const ci = Number(ae.contentIndex ?? 0);
    switch (ae.type) {
      case "text_start":
        this.ensureBlock(ci, "assistant");
        return;
      case "text_delta":
        this.delta(this.ensureBlock(ci, "assistant"), "text", String(ae.delta ?? ""));
        return;
      case "text_end": {
        const id = this.ensureBlock(ci, "assistant");
        if (typeof ae.content === "string") this.complete(id, { text: ae.content });
        return;
      }
      case "thinking_start":
        this.ensureBlock(ci, "thinking");
        return;
      case "thinking_delta":
        this.delta(this.ensureBlock(ci, "thinking"), "text", String(ae.delta ?? ""));
        return;
      case "thinking_end": {
        const id = this.ensureBlock(ci, "thinking");
        if (typeof ae.content === "string") this.complete(id, { text: ae.content });
        return;
      }
      case "toolcall_start": {
        const id = String(ae.id ?? ae.toolCall?.id ?? "") || this.blockId(ci);
        this.blocks.set(ci, { id, kind: "tool" });
        this.start({ id, kind: "tool", status: "streaming", name: toolName(ae.toolName ?? ae.toolCall?.name), argsText: "" });
        return;
      }
      case "toolcall_delta": {
        const b = this.blocks.get(ci);
        if (b?.kind === "tool") this.delta(b.id, "argsText", String(ae.delta ?? ""));
        return;
      }
      case "toolcall_end": {
        const tc = ae.toolCall ?? {};
        const id = String(tc.id ?? this.blocks.get(ci)?.id ?? "");
        if (!id) return;
        if (!this.started.has(id)) this.start({ id, kind: "tool", status: "pending", name: toolName(tc.name), args: tc.arguments ?? {} });
        else this.out({ type: "item.updated", id, patch: { status: "pending", args: tc.arguments ?? {}, ...(tc.name ? { name: toolName(tc.name) } : {}) } });
        this.blocks.set(ci, { id, kind: "tool" });
        return;
      }
      default:
        return;
    }
  }

  /** message_end: pi's authoritative message. Anything a delta missed is set right here. */
  private endMessage(m: any): void {
    const content: any[] = Array.isArray(m.content) ? m.content : [];
    content.forEach((c, i) => {
      if (c?.type === "text" && typeof c.text === "string") {
        const b = this.blocks.get(i);
        if (!b && !c.text.trim()) return;
        const id = b?.id ?? this.ensureBlock(i, "assistant");
        this.complete(id, { text: c.text });
        if (c.text.trim()) this.replies.push(c.text);
      } else if (c?.type === "thinking" && typeof c.thinking === "string") {
        const b = this.blocks.get(i);
        if (!b && !c.thinking.trim()) return;
        const id = b?.id ?? this.ensureBlock(i, "thinking");
        this.complete(id, { text: c.thinking });
      } else if (c?.type === "toolCall" && c.id) {
        const id = String(c.id);
        if (!this.started.has(id)) this.start({ id, kind: "tool", status: "pending", name: toolName(c.name), args: c.arguments ?? {} });
      }
    });
    // A block that never got its final content (an aborted stream): it ends as it stands.
    for (const b of this.blocks.values()) if (b.kind !== "tool" && !this.done.has(b.id)) this.complete(b.id, m.stopReason === "aborted" ? { status: "stopped" } : undefined);
    this.flush();
    const u = m.usage ?? {};
    const input = Number(u.input ?? 0) + Number(u.cacheRead ?? 0) + Number(u.cacheWrite ?? 0);
    if (input > 0) this.out({ type: "usage", turn: this.o.turn, context: input });
    this.lastError = m.stopReason === "error" && m.errorMessage ? String(m.errorMessage).slice(0, 500) : null;
  }

  /** A user message pi put into the context: the prompt, an engine input, or Carl's steer / queued message. */
  private userMessage(text: string): void {
    let i = -1;
    if (this.expected[0]?.kind === "prompt") i = 0;
    else {
      i = this.expected.findIndex((e) => e.text === text);
      if (i < 0) i = this.expected.findIndex((e) => e.text.trim() === text.trim());
    }
    if (i < 0) {
      // Not something this server sent (pi's own): shown as it is.
      if (!text.trim()) return;
      this.userN++;
      this.start({ id: `${this.o.turn}:u:${this.userN}`, kind: "user", status: "done", text, via: "chat" });
      return;
    }
    const [e] = this.expected.splice(i, 1);
    if (!e || e.kind === "prompt" || e.kind === "silent") return;
    this.out({ type: "pending.removed", id: e.id, reason: "delivered" });
    this.start({ id: e.id, kind: "user", status: "done", text: e.shown, via: e.kind, ...(e.images?.length ? { images: e.images } : {}) });
  }

  /** What is still expected (pending when the turn ends: not delivered). */
  undelivered(): Expected[] {
    return this.expected.filter((e) => e.kind === "steer" || e.kind === "queue");
  }

  dispose(): void {
    this.flush();
  }
}
