// One running pi session → the conversation's feed (src/convlog/protocol.ts).
//
// The transcript is pi's session file: every entry pi writes there that the
// chat shows (a message, a compaction, vault-chat's own `vc-note`) gets one
// pointer record, in the file's order, the moment the feed sees it. The file is
// read before each of pi's events is passed on, so a pointer never comes after
// a live event about something later.
//
// pi's live events for the message in flight pass through as pi sent them (the
// clients reassemble them by pi's rule, src/convlog/reduce.ts), trimmed only
// where they repeat what pi will write anyway: text/thinking/argument deltas
// are coalesced (a few records a second, never per token), a running tool's
// output is throttled and capped, and a message_end whose entry is already
// pointed to is not repeated.
//
// Carl's messages come back from pi as user entries. The engine says what it
// sent (`expect`); the match puts his client's id, the text he typed (pi's copy
// carries the engine's prefixes) and how it came in on the pointer.
import type { EventBody, ItemImage, PiEntry } from "../../src/convlog/protocol";
import { VC_NOTE, VC_VOICE } from "../../src/convlog/protocol";
import { ASK_TOOLS } from "../../src/review";
import { SessionTail, shownEntry } from "../convlog/piSession";

export type Expected = {
  /** prompt: the turn's own input (the first user message of the turn); silent: an engine input given mid-turn. */
  kind: "prompt" | "silent" | "steer" | "queue";
  /** What pi was sent. */
  text: string;
  /** What the chat shows. */
  shown: string;
  via: string;
  clientId?: string;
  images?: ItemImage[];
  /** The surface Carl sent it from (laptop, phone, board, voice): two surfaces can talk in one thread at once. */
  device?: string;
};

export type FeedOpts = {
  file: string;
  emit: (b: EventBody) => void;
  /** Entries of `file` the feed already points to (skipped; updated as pointers are written). */
  pointed: Set<string>;
  /** A pi user message matched one of Carl's steers or queued messages. */
  delivered?: (clientId: string) => void;
  /** Coalescing window for deltas (ms); 0: every delta its own record (tests). */
  flushMs?: number;
  now?: () => number;
};

const RESULT_CAP = 4_000;
const PARTIAL_CAP = 2_000;
const PARTIAL_EVERY_MS = 1_500;
const cap = (s: string, n = RESULT_CAP) => (s.length > n ? s.slice(0, n) + `\n…[${s.length - n} more chars]` : s);
const DELTAS = new Set(["text_delta", "thinking_delta", "toolcall_delta"]);

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: any) => c?.type === "text" && typeof c.text === "string")
    .map((c: any) => c.text)
    .join("\n");
}

export class PiFeed {
  private tail: SessionTail;
  private expected: Expected[] = [];
  private answers: string[] = [];
  /** Entries read but not pointed to yet (a message whose events are still coming). */
  private held: PiEntry[] = [];
  /** The assistant messages whose message_end came (their timestamps). */
  private ended = new Set<number>();
  private buf: { ev: any; ci: number; type: string } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private partialAt = new Map<string, number>();
  private written = new Set<number>();
  private disposed = false;
  /** The texts of the assistant's replies this turn (the activity stream's reply). */
  readonly replies: string[] = [];
  /** The provider's error on the last assistant message (stopReason "error"). */
  lastError: string | null = null;

  constructor(private o: FeedOpts) {
    this.tail = new SessionTail(o.file, "start");
  }

  get file(): string {
    return this.o.file;
  }

  expect(e: Expected): void {
    this.expected.push(e);
  }

  /** Taken back before pi delivered it (unqueue, a stop): no longer expected. */
  forget(clientId: string): void {
    this.expected = this.expected.filter((e) => e.clientId !== clientId);
  }

  /** Carl answered the open question under this client id: the AskUser result pi writes next carries it. */
  answered(clientId: string): void {
    this.answers.push(clientId);
  }

  /** Carl's messages pi has not delivered. */
  undelivered(): Expected[] {
    return this.expected.filter((e) => e.kind === "steer" || e.kind === "queue");
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  // ---------------------------------------------------------------- pi's entries

  /** Point to every shown entry pi wrote since the last look. */
  sync(final = false): void {
    const list = [...this.held, ...this.tail.read()];
    this.held = [];
    for (let i = 0; i < list.length; i++) {
      const e = list[i]!;
      // pi writes a message to its file as its events are still on their way through the pipe: an
      // assistant message is pointed to once its message_end came (its live events first, then it).
      const ts = e.type === "message" && e.message?.role === "assistant" ? Number(e.message.timestamp) : null;
      if (!final && ts !== null && !this.ended.has(ts) && !this.o.pointed.has(e.id)) {
        this.held = list.slice(i);
        return;
      }
      this.entry(e);
    }
  }

  private entry(e: PiEntry): void {
    if (this.o.pointed.has(e.id)) return;
    if (!shownEntry(e)) return;
    this.o.pointed.add(e.id);
    const m = e.message;
    if (e.type === "message" && m?.role === "user") return this.userEntry(e, textOf(m.content));
    if (e.type === "message" && m?.role === "assistant") {
      if (typeof m.timestamp === "number") this.written.add(m.timestamp);
      for (const b of Array.isArray(m.content) ? m.content : []) if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) this.replies.push(b.text);
      this.lastError = m.stopReason === "error" && m.errorMessage ? String(m.errorMessage).slice(0, 500) : null;
    }
    if (e.type === "message" && m?.role === "toolResult" && ASK_TOOLS.has(String(m.toolName)) && this.answers.length) {
      return this.o.emit({ type: "entry", file: this.o.file, entry: e, clientId: this.answers.shift()! });
    }
    if (e.type === "custom" && e.customType === VC_NOTE && typeof e.data?.clientId === "string") {
      return this.o.emit({ type: "entry", file: this.o.file, entry: e, clientId: e.data.clientId });
    }
    const voice = e.type === "custom_message" && e.customType === VC_VOICE ? (e.details as { clientId?: unknown } | undefined) : undefined;
    if (typeof voice?.clientId === "string") return this.o.emit({ type: "entry", file: this.o.file, entry: e, clientId: voice.clientId });
    this.o.emit({ type: "entry", file: this.o.file, entry: e });
  }

  /** A user message pi put into the context: the turn's input, an engine input, or Carl's steer / queued message. */
  private userEntry(e: PiEntry, text: string): void {
    let i = this.expected[0]?.kind === "prompt" ? 0 : this.expected.findIndex((x) => x.text === text);
    if (i < 0) i = this.expected.findIndex((x) => x.text.trim() === text.trim());
    if (i < 0) {
      // Not something this server sent (pi's own): as it is.
      this.o.emit({ type: "entry", file: this.o.file, entry: e });
      return;
    }
    const [x] = this.expected.splice(i, 1);
    this.o.emit({
      type: "entry",
      file: this.o.file,
      entry: e,
      ...(x!.clientId ? { clientId: x!.clientId } : {}),
      shown: x!.shown,
      via: x!.via,
      ...(x!.images?.length ? { images: x!.images } : {}),
      ...(x!.device ? { device: x!.device } : {}),
    });
    if (x!.clientId && (x!.kind === "steer" || x!.kind === "queue")) this.o.delivered?.(x!.clientId);
  }

  // ---------------------------------------------------------------- pi's live events

  private live(ev: any): void {
    this.o.emit({ type: "live", ev });
  }

  /** Write the buffered deltas. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const b = this.buf;
    this.buf = null;
    if (b) this.live(b.ev);
  }

  private delta(ev: any): void {
    const ae = ev.assistantMessageEvent;
    const ci = Number(ae.contentIndex ?? 0);
    if (this.buf && this.buf.ci === ci && this.buf.type === ae.type) {
      this.buf.ev.assistantMessageEvent.delta += String(ae.delta ?? "");
    } else {
      this.flush();
      this.buf = { ci, type: ae.type, ev: { type: "message_update", assistantMessageEvent: { type: ae.type, contentIndex: ci, delta: String(ae.delta ?? "") } } };
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, this.o.flushMs ?? 120);
      this.timer.unref?.();
    }
  }

  onPi(ev: any): void {
    if (this.disposed) return;
    const t = ev?.type;
    if (t === "message_update" && DELTAS.has(ev.assistantMessageEvent?.type) && (this.o.flushMs ?? 120) > 0) return this.delta(ev);
    this.flush();
    if (t === "message_end" && ev.message?.role === "assistant" && typeof ev.message.timestamp === "number") this.ended.add(ev.message.timestamp);
    // What pi wrote before this event is in the feed before it.
    this.sync();
    switch (t) {
      case "message_start":
        if (ev.message?.role !== "assistant") return;
        return this.live({ type: t, message: { role: "assistant", timestamp: ev.message.timestamp } });
      case "message_update": {
        const ae = ev.assistantMessageEvent ?? {};
        const keep: Record<string, unknown> = { type: ae.type, contentIndex: ae.contentIndex };
        if (DELTAS.has(ae.type)) keep.delta = String(ae.delta ?? "");
        else if (ae.type === "text_end" || ae.type === "thinking_end") keep.content = ae.content;
        else if (ae.type === "toolcall_start") Object.assign(keep, { id: ae.id ?? ae.toolCall?.id, toolName: ae.toolName ?? ae.toolCall?.name });
        else if (ae.type === "toolcall_end") keep.toolCall = ae.toolCall;
        else if (ae.type !== "text_start" && ae.type !== "thinking_start") return;
        return this.live({ type: t, assistantMessageEvent: keep });
      }
      case "message_end": {
        const m = ev.message ?? {};
        if (m.role !== "assistant") return;
        // pi has written it already: the entry said it all.
        if (this.written.has(Number(m.timestamp))) return;
        return this.live({ type: t, message: m });
      }
      case "tool_execution_start":
        return this.live({ type: t, toolCallId: ev.toolCallId, toolName: ev.toolName, args: ev.args });
      case "tool_execution_update": {
        const id = String(ev.toolCallId ?? "");
        const now = this.now();
        if (now - (this.partialAt.get(id) ?? 0) < PARTIAL_EVERY_MS) return;
        const text = textOf(ev.partialResult?.content);
        if (!text) return;
        this.partialAt.set(id, now);
        return this.live({ type: t, toolCallId: id, partialResult: { content: [{ type: "text", text: text.slice(-PARTIAL_CAP) }] } });
      }
      case "tool_execution_end":
        this.partialAt.delete(String(ev.toolCallId ?? ""));
        return this.live({ type: t, toolCallId: ev.toolCallId, toolName: ev.toolName, isError: !!ev.isError, result: { content: [{ type: "text", text: cap(textOf(ev.result?.content)) }] } });
      case "compaction_start":
        return this.live({ type: t, reason: ev.reason });
      case "compaction_end":
        return this.live({ type: t, aborted: !!ev.aborted, ...(ev.result ? { result: { ok: true } } : {}), ...(ev.errorMessage ? { errorMessage: String(ev.errorMessage).slice(0, 500) } : {}) });
      case "auto_retry_start":
        return this.live({ type: t, attempt: ev.attempt, maxAttempts: ev.maxAttempts, errorMessage: String(ev.errorMessage ?? "").slice(0, 500) });
      case "auto_retry_end":
        return this.live({ type: t, success: ev.success, attempt: ev.attempt });
      default:
        return; // agent/turn lifecycle, queue updates, settles: the engine's own fields say those
    }
  }

  /** The turn is over: the last deltas, then everything pi wrote. */
  dispose(): void {
    this.flush();
    this.sync(true);
    this.disposed = true;
  }
}
