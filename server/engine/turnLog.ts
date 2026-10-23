// One structured line per agent turn (the box's turn log, server/boxLogs.ts),
// built from pi's own events as they pass through the engine: nothing is
// recomputed that pi already says. The model, the stop reason, the tokens and
// the dollar cost are pi's (each assistant message's `model`, `stopReason`,
// `usage` and `usage.cost.total`); the timings are when pi's events arrived.
//
//   {at, ev:"turn", v, vault, conv, turn, session, mode, via, cmid,
//    model, start, end, ms, ttft_ms, calls, tools:[{name, ms, ok}],
//    stop, status, outcome, state, error, retries, compactions,
//    tokens:{in, out, cacheRead, cacheWrite}, cost, queue:[{t, ev, cmid}]}
//
// `turn` is the id the feed's `running` meta carries (the laptop logs it when
// it sees the turn start), `cmid` the client's message id of the turn's own
// input (the laptop logs it when it sends), `session` pi's session id (its
// file is the transcript). `queue` is every steer / queued message / take-back
// / delivery during the turn, by client id, at its offset (ms) from the start.
// Names, ids, counts and timings only: no message text, no tool arguments.

export type TurnTool = { name: string; ms: number | null; ok: boolean | null };
export type QueueEv = { t: number; ev: "steer" | "queue" | "unqueue" | "delivered" | "refused"; cmid: string };

export type TurnLine = {
  at: string;
  ev: "turn";
  v: string;
  vault: string;
  conv: string;
  turn: string;
  session: string | null;
  mode: string;
  via: string | null;
  cmid: string | null;
  model: string | null;
  start: string;
  end: string;
  ms: number;
  ttft_ms: number | null;
  calls: number;
  tools: TurnTool[];
  stop: string | null;
  status: string;
  outcome: string;
  /** The conversation's state after it (idle, sleeping, waiting_user, done, blocked). */
  state: string | null;
  error: string | null;
  retries: number;
  compactions: number;
  tokens: { in: number; out: number; cacheRead: number; cacheWrite: number };
  cost: number | null;
  queue: QueueEv[];
  /** A side thread's (mode "side"): whether it had the write tools, and pi's tools it was given. */
  act?: boolean;
  allowed?: string[];
};

const MAX_TOOLS = 60;
const MAX_QUEUE = 40;

export class TurnRecorder {
  private firstAt: number | null = null;
  private calls = 0;
  private model: string | null = null;
  private stop: string | null = null;
  private err: string | null = null;
  private retries = 0;
  private compactions = 0;
  private tokens = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
  private cost: number | null = null;
  private open = new Map<string, { name: string; at: number }>();
  private tools: TurnTool[] = [];
  private more = 0;
  private queue: QueueEv[] = [];

  constructor(
    private o: { vault: string; conv: string; turn: string; session: string | null; mode: string; via: string | null; cmid: string | null; model: string | null; start: number; version: string },
    private now: () => number = Date.now,
  ) {}

  /** One of pi's events, as the engine received it. */
  pi(ev: any): void {
    const t = ev?.type;
    if (t === "message_update" && this.firstAt === null) {
      const k = ev.assistantMessageEvent?.type;
      if (k === "text_delta" || k === "thinking_delta" || k === "toolcall_start" || k === "toolcall_delta" || k === "text_start" || k === "thinking_start") this.firstAt = this.now();
      return;
    }
    if (t === "message_end" && ev.message?.role === "assistant") {
      const m = ev.message;
      if (this.firstAt === null) this.firstAt = this.now();
      this.calls++;
      if (typeof m.model === "string" && m.model) this.model = m.provider && !String(m.model).includes("/") ? `${m.provider}/${m.model}` : m.model;
      if (typeof m.stopReason === "string") this.stop = m.stopReason;
      if (m.stopReason === "error" && m.errorMessage) this.err = String(m.errorMessage).slice(0, 300);
      const u = m.usage ?? {};
      this.tokens.in += Number(u.input) || 0;
      this.tokens.out += Number(u.output) || 0;
      this.tokens.cacheRead += Number(u.cacheRead) || 0;
      this.tokens.cacheWrite += Number(u.cacheWrite) || 0;
      const c = Number(u.cost?.total);
      if (Number.isFinite(c)) this.cost = Math.round(((this.cost ?? 0) + c) * 1e7) / 1e7;
      return;
    }
    if (t === "tool_execution_start") {
      this.open.set(String(ev.toolCallId ?? ""), { name: String(ev.toolName ?? "?"), at: this.now() });
      return;
    }
    if (t === "tool_execution_end") {
      const id = String(ev.toolCallId ?? "");
      const o = this.open.get(id);
      this.open.delete(id);
      this.addTool({ name: o?.name ?? String(ev.toolName ?? "?"), ms: o ? this.now() - o.at : null, ok: !ev.isError });
      return;
    }
    if (t === "auto_retry_start") {
      this.retries++;
      if (ev.errorMessage) this.err = String(ev.errorMessage).slice(0, 300);
      return;
    }
    if (t === "auto_retry_end" && ev.success) {
      // Recovered: the error that caused the retry is not the turn's.
      if (this.stop !== "error") this.err = null;
      return;
    }
    if (t === "compaction_end") {
      this.compactions++;
      if (ev.errorMessage && !ev.result) this.err = `compaction: ${String(ev.errorMessage).slice(0, 280)}`;
    }
  }

  private addTool(x: TurnTool): void {
    if (this.tools.length < MAX_TOOLS) this.tools.push(x);
    else this.more++;
  }

  /** A steer / queued message / take-back / delivery, by its client id. */
  q(ev: QueueEv["ev"], cmid: string): void {
    if (this.queue.length < MAX_QUEUE) this.queue.push({ t: this.now() - this.o.start, ev, cmid: String(cmid).slice(0, 80) });
  }

  /** The turn ended: its line. `status` is pi's (completed / interrupted / failed); `outcome` the engine's reading of it. */
  line(end: { status: string; outcome: string; state?: string | null; error?: string | null }): TurnLine {
    const now = this.now();
    for (const o of this.open.values()) this.addTool({ name: o.name, ms: now - o.at, ok: null });
    this.open.clear();
    const tools = this.more ? [...this.tools, { name: `…+${this.more}`, ms: null, ok: null }] : this.tools;
    return {
      at: new Date(now).toISOString(),
      ev: "turn",
      v: this.o.version,
      vault: this.o.vault,
      conv: this.o.conv,
      turn: this.o.turn,
      session: this.o.session,
      mode: this.o.mode,
      via: this.o.via,
      cmid: this.o.cmid,
      model: this.model ?? this.o.model,
      start: new Date(this.o.start).toISOString(),
      end: new Date(now).toISOString(),
      ms: now - this.o.start,
      ttft_ms: this.firstAt === null ? null : this.firstAt - this.o.start,
      calls: this.calls,
      tools,
      stop: this.stop,
      status: end.status,
      outcome: end.outcome,
      state: end.state ?? null,
      error: (end.error ? String(end.error).slice(0, 300) : null) ?? this.err,
      retries: this.retries,
      compactions: this.compactions,
      tokens: this.tokens,
      cost: this.cost,
      queue: this.queue,
    };
  }
}

/** The one-line journal form of a turn line (the full record is in turns.jsonl). */
export function turnSummary(l: TurnLine): string {
  const tools = l.tools.length ? ` tools=${l.tools.length}${l.tools.some((t) => t.ok === false) ? `(${l.tools.filter((t) => t.ok === false).length} failed)` : ""}` : "";
  const cost = l.cost === null ? "" : ` $${l.cost.toFixed(4)}`;
  return `[turn] ${l.vault}/${l.conv} ${l.turn} ${l.mode}${l.via ? `/${l.via}` : ""} ${l.outcome} ${l.ms}ms ttft=${l.ttft_ms ?? "-"}ms ${l.model ?? "?"} calls=${l.calls}${tools} in=${l.tokens.in} out=${l.tokens.out}${cost}${l.stop ? ` stop=${l.stop}` : ""}${l.error ? ` error=${JSON.stringify(l.error.slice(0, 160))}` : ""}`;
}
