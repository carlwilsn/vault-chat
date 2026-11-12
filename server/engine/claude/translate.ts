// Claude Code's stream, said in pi's words.
//
// This is what keeps the three clients, SearchHistory and the turn log out of
// the refactor: vault-chat's feed speaks pi's live events and pi's session
// entries (src/convlog/protocol.ts, reduce.ts), so a Claude Code turn is
// translated into exactly those rather than given a shape of its own. Nothing
// here touches the SDK — it takes the messages the SDK yields as plain objects,
// so the whole mapping is testable against recorded streams
// (server/test/fixtures/claude-*.jsonl).
//
// What the mapping has to get right:
//
//   Block ids. Every client names a block `<message timestamp>:<content index>`
//   (reduce.ts blockId), so one assistant message gets ONE timestamp, chosen
//   when its message_start arrives and used again on its session entry. The
//   deltas a client already drew and the entry that supersedes them then carry
//   the same ids, and nothing jumps.
//
//   Block ends. The SDK sends a complete `assistant` message per block, with
//   that block's final content (and a tool call's input already parsed), just
//   before the block's content_block_stop. We buffer it and emit pi's
//   `*_end` at the stop, where the index is authoritative — falling back to the
//   deltas we accumulated if a producer sends no such message.
//
//   Tool calls, in pi's order. Every client assumes an assistant message's
//   entry is in the transcript BEFORE the tools it called run: that is what
//   moves the tool row out of the message in flight and lets its result stick
//   (reduce.ts place(), which only protects a tool's run state for a row
//   already placed). The SDK has no "tool started" event and does not promise
//   that order — a fast tool's result can arrive while the stream's tail is
//   still being delivered — so we hold a result until the message that called
//   it is closed, then emit pi's sequence: the entry, message_end,
//   tool_execution_start for each call, then each result. tool_execution_update
//   comes from the CLI's 30 s tool_progress heartbeats.
import type { PiBlock, PiEntry, PiMessage } from "../../../src/convlog/protocol";
import { authRefused, SIGN_IN_AGAIN } from "./auth";

/** Read once: this is checked for every message of every stream. */
const TRACE = process.env.VC_CLAUDE_TRACE === "1";
import type { ThreadTokenUsage } from "../context";

/** A session entry as piSession.appendEntries takes it (it assigns id, parentId and timestamp). */
export type NewEntry = Omit<PiEntry, "id" | "parentId" | "timestamp">;

/** What one SDK message means, in order. The caller writes entries and emits live events as they come. */
export type Emit =
  /** One live event in pi's shape: the engine sends it on as {kind:"pi"}. */
  | { kind: "live"; ev: Record<string, unknown> }
  /**
   * A background worker (SDK task) reported — a quiet line for the chat, written before the reply
   * that follows it. `text` is the line without its clock ("Worker finished: ...").
   */
  | { kind: "workerNotice"; taskId: string; text: string }
  /** One pi-format entry for the thread's session file, appended before any later live event. */
  | { kind: "entry"; entry: NewEntry }
  /** The context size of the last model call, and the model's window. */
  | { kind: "usage"; usage: ThreadTokenUsage }
  /** The session id this stream belongs to (resume uses it; it can change on a fork). */
  | { kind: "session"; id: string }
  /** The turn ended. */
  /**
   * The turn ended. `refused`: it failed because the API would not take this
   * box's sign-in — judged here, where the whole request is in view, and only
   * when the request was refused BEFORE any content (a 401 never arrives
   * half-way through an answer). A tool's output that happens to say "401"
   * therefore cannot sign Carl out.
   */
  | { kind: "done"; status: "completed" | "interrupted" | "failed"; error: string | null; refused?: boolean; limited?: boolean }
  /** Claude Code's own rate limit: the host backs wakes and schedules off until `resetsAt`. */
  | { kind: "rateLimit"; status: string; resetsAt: number | null; kindOfLimit: string | null }
  /** The API refused the sign-in (claude/auth.ts). The host stops the turn: the
   *  runtime itself retries this, for ever, on a credential that cannot work. */
  | { kind: "authRefused"; error: string | null };

type OpenBlock = {
  index: number;
  /** pi's name for it. */
  kind: "text" | "thinking" | "toolcall";
  /** The deltas so far (a tool call's are its input JSON). */
  acc: string;
  /** The complete block the SDK sent for it, if it did. */
  final?: PiBlock;
  /** A tool call's identity, known from content_block_start. */
  id?: string;
  name?: string;
  /** Its `*_end` has been emitted. */
  closed?: boolean;
};

type OpenMessage = {
  /** The one timestamp every id of this message is built from. */
  ts: number;
  blocks: Map<number, OpenBlock>;
  /** In index order, as the blocks closed: the entry's content. */
  content: PiBlock[];
  stopReason: string | null;
  errorMessage: string | null;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
};

/** pi's stopReason for the API's. */
function stopOf(reason: unknown, errored: boolean): string {
  if (errored) return "error";
  switch (String(reason ?? "")) {
    case "tool_use":
      return "toolUse";
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "maxTokens";
    case "refusal":
      return "refusal";
    case "":
      return "stop";
    default:
      return String(reason);
  }
}

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b: any) => (typeof b?.text === "string" ? b.text : "")).join("");
};

/**
 * The quiet line for a background worker's notification, or "" for one that says nothing.
 * `completed` with a summary saying the worker has not delivered yet ("waiting on its own background work")
 * is interim: the real report comes in a later notification for the same task.
 */
export function workerNoticeText(description: string, status: string, summary: string, reason?: unknown): string {
  const first = (x: string) => x.replace(/\s+/g, " ").trim().slice(0, 160);
  const what = first(description) || first(summary);
  const tail = what ? `: ${what}` : "";
  if (status === "completed") {
    if (interimNotice(status, summary)) return `Worker still working (interim notice)${tail}`;
    return `Worker finished${tail}`;
  }
  if (status === "failed") return `Worker failed${tail}`;
  if (status === "stopped") return `Worker stopped${reason === "worker_restart" ? " by a restart" : ""}${tail}`;
  return "";
}

/** A `completed` notice whose summary says the worker has not delivered yet: the task is still live. */
export function interimNotice(status: string, summary: string): boolean {
  return status === "completed" && /not reported yet|waiting on (its own|agents|background)|still (running|waiting|working)|background work/i.test(summary);
}

/** A notice that ends its task: the worker is done, for good or ill (an interim `completed` is not). */
export function finalNotice(status: string, summary: string): boolean {
  return status === "failed" || status === "stopped" || (status === "completed" && !interimNotice(status, summary));
}

/** The tool results of a `user` message, and nothing else (the SDK puts them in message.content). */
function toolResults(m: any): { id: string; isError: boolean; content: { type: "text"; text: string }[] }[] {
  const content = Array.isArray(m?.message?.content) ? m.message.content : [];
  return content
    .filter((b: any) => b?.type === "tool_result" && b.tool_use_id)
    .map((b: any) => ({ id: String(b.tool_use_id), isError: !!b.is_error, content: [{ type: "text" as const, text: textOf(b.content) }] }));
}

/**
 * One conversation's stream. Feed it every SDK message in order; it gives back
 * what the feed needs. It is stateful only within one assistant message and
 * the tool calls that message made.
 */
export class ClaudeTranslator {
  /** Monotonic, so two messages in the same millisecond still get distinct block ids. */
  private clock = 0;
  private open: OpenMessage | null = null;
  /** Tool calls of the message in flight, by their id: their names, for the result's entry. */
  private toolNames = new Map<string, string>();
  /** The last window the model reported (the result message says it; message_start does not). */
  private window: number | null = null;
  /** The last context size reported, so the window can be sent with it once known. */
  private lastUsage: ThreadTokenUsage["last"] | null = null;
  /** Results that arrived while their own message was still open: emitted once it closes. */
  private held: Emit[] = [];
  /** A retry Claude Code reported and the clients are showing as "Retrying…". */
  private retrying = false;
  /** Background tasks by id: what each was asked to do (task_started's description). */
  private tasks = new Map<string, string>();
  /** Notices already given (a task can be reported twice by two paths). */
  private noticed = new Set<string>();
  /**
   * Background tasks started and not reported finished yet. The box's updater waits for
   * these (health busy.workers): a restart would kill them mid-work.
   */
  private running = new Set<string>();
  /** The host asked for this turn to end (see expectInterrupt). */
  private stopping = false;
  /**
   * This turn was refused for Carl's usage limit: the SDK's synthetic assistant
   * message carried `error: "rate_limit"` (its text is "You've hit your 5-hour
   * limit · resets 1:30am (America/Chicago)"), or a rate_limit_event said
   * "rejected". The failure is then a wait, not an error (engine.ts holds it).
   */
  private limited = false;
  /** Claude Code said it is summarizing the session (status "compacting"; it repeats that every 30 s). */
  private compacting = false;

  constructor(private readonly now: () => number = () => Date.now()) {}

  private stamp(): number {
    return (this.clock = Math.max(this.now(), this.clock + 1));
  }

  /** What this SDK message means for the feed. */
  step(m: any): Emit[] {
    if (!m || typeof m !== "object") return [];
    // VC_CLAUDE_TRACE=1 prints every message the runtime sends, which is how the
    // retry below was found: `api_retry` was being read as a top-level type and
    // never arrived, so a refused sign-in retried ten times in silence.
    if (TRACE) console.log(`[trace] ${m.type}/${m.subtype ?? ""} ${JSON.stringify(m).slice(0, 400)}`);
    switch (m.type) {
      case "stream_event":
        // A subagent's own stream is reported under the subagent, never as the parent's reply.
        return m.parent_tool_use_id ? [] : this.streamEvent(m.event ?? {});
      case "assistant":
        return m.parent_tool_use_id ? [] : this.assistant(m);
      case "user":
        // A replayed task-notification (the same report the system message carries) is the same notice.
        return m.parent_tool_use_id ? [] : [...this.notificationText(m), ...this.toolResult(m)];
      case "system":
        return this.system(m);
      case "tool_progress":
        return this.toolProgress(m);
      case "result":
        return this.result(m);
      case "rate_limit_event": {
        // `rate_limit_info` is what the SDK sends (SDKRateLimitEvent). It was
        // read as `rate_limit` here, so every event looked like "allowed" and
        // the box never backed off a subscription that had said no.
        const info = m.rate_limit_info ?? m.rate_limit ?? m;
        // Rejected, but paid overage carries on: not a limit that stops work.
        const overage = info.overageStatus === "allowed" || info.overageStatus === "allowed_warning";
        const rejected = info.status === "rejected" && !overage;
        if (rejected) this.limited = true;
        // The SDK's resetsAt is unix SECONDS (the CLI computes it from the
        // `anthropic-ratelimit-unified-reset` header): held as ms like every
        // other time here, or usageLimit() would read every reset as past.
        const at = Number(info.resetsAt) || 0;
        return [{
          kind: "rateLimit",
          status: rejected ? "rejected" : info.status === "rejected" ? "allowed_warning" : String(info.status ?? "allowed"),
          resetsAt: at ? (at < 1e12 ? at * 1000 : at) : null,
          kindOfLimit: info.rateLimitType ?? null,
        }];
      }
      default:
        return [];
    }
  }

  // ------------------------------------------------------------ the model's own stream

  private streamEvent(e: any): Emit[] {
    switch (e.type) {
      case "message_start":
        return this.messageStart(e);
      case "content_block_start":
        return this.blockStart(e);
      case "content_block_delta":
        return this.blockDelta(e);
      case "content_block_stop":
        return this.blockStop(e);
      case "message_delta": {
        const o = this.open;
        if (!o) return [];
        if (e.delta?.stop_reason) o.stopReason = String(e.delta.stop_reason);
        o.usage.output = Number(e.usage?.output_tokens ?? o.usage.output) || o.usage.output;
        return [];
      }
      case "message_stop":
        return this.messageStop();
      default:
        return [];
    }
  }

  /** The host is aborting this turn: its end is a stop, not a failure. */
  expectInterrupt(): void {
    this.stopping = true;
  }

  /** Close a retry the clients are showing, if one is open. */
  private retryEnded(success: boolean): Emit[] {
    if (!this.retrying) return [];
    this.retrying = false;
    return [{ kind: "live", ev: { type: "auto_retry_end", success } }];
  }

  private messageStart(e: any): Emit[] {
    // A message that never stopped (a cut turn) is closed first, so its blocks are not orphaned.
    const out = this.open ? this.messageStop() : [];
    // The retry worked: the quiet "Retrying…" line goes away with its end event,
    // and nothing of the failed attempt is left in front of Carl.
    out.push(...this.retryEnded(true));
    const u = e.message?.usage ?? {};
    const ts = this.stamp();
    this.open = {
      ts,
      blocks: new Map(),
      content: [],
      stopReason: null,
      errorMessage: null,
      usage: {
        input: Number(u.input_tokens ?? 0),
        output: Number(u.output_tokens ?? 0),
        cacheRead: Number(u.cache_read_input_tokens ?? 0),
        cacheWrite: Number(u.cache_creation_input_tokens ?? 0),
      },
    };
    out.push({ kind: "live", ev: { type: "message_start", message: { role: "assistant", timestamp: ts } } });
    return out;
  }

  private blockStart(e: any): Emit[] {
    const o = this.open;
    if (!o) return [];
    const index = Number(e.index ?? 0);
    const b = e.content_block ?? {};
    if (b.type === "text") {
      o.blocks.set(index, { index, kind: "text", acc: "" });
      return [{ kind: "live", ev: { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: index } } }];
    }
    if (b.type === "thinking" || b.type === "redacted_thinking") {
      o.blocks.set(index, { index, kind: "thinking", acc: "" });
      return [{ kind: "live", ev: { type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: index } } }];
    }
    if (b.type === "tool_use" || b.type === "server_tool_use" || b.type === "mcp_tool_use") {
      const id = String(b.id ?? `${o.ts}:${index}`);
      const name = String(b.name ?? "tool");
      o.blocks.set(index, { index, kind: "toolcall", acc: "", id, name });
      this.toolNames.set(id, name);
      return [{ kind: "live", ev: { type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: index, id, toolName: name } } }];
    }
    return [];
  }

  private blockDelta(e: any): Emit[] {
    const o = this.open;
    const blk = o?.blocks.get(Number(e.index ?? 0));
    if (!o || !blk) return [];
    const d = e.delta ?? {};
    const piType = d.type === "text_delta" ? "text_delta" : d.type === "thinking_delta" ? "thinking_delta" : d.type === "input_json_delta" ? "toolcall_delta" : null;
    if (!piType) return []; // signature_delta and citations: nothing a client draws
    const delta = String(d.text ?? d.thinking ?? d.partial_json ?? "");
    blk.acc += delta;
    return [{ kind: "live", ev: { type: "message_update", assistantMessageEvent: { type: piType, contentIndex: blk.index, delta } } }];
  }

  /** The SDK's complete message for the block that is closing: its final content, a tool call's input parsed. */
  private assistant(m: any): Emit[] {
    const o = this.open;
    const blocks: PiBlock[] = Array.isArray(m?.message?.content) ? m.message.content : [];
    if (m?.error) {
      const text = String(m.message?.content?.find?.((b: any) => b?.type === "text")?.text ?? m.error);
      if (m.error === "rate_limit") this.limited = true;
      if (o) {
        o.errorMessage = text;
        o.stopReason = "error";
      }
      return [];
    }
    if (!o || !blocks.length) return [];
    // It names no index: it belongs to the one block still open (they close in order).
    const openBlk = [...o.blocks.values()].find((b) => b.final === undefined);
    if (openBlk) openBlk.final = blocks[0];
    return [];
  }

  private blockStop(e: any): Emit[] {
    const o = this.open;
    const blk = o?.blocks.get(Number(e.index ?? 0));
    if (!o || !blk) return [];
    return this.closeBlock(o, blk);
  }

  /** One block's pi `*_end`, from the complete block the SDK sent for it or from its deltas. */
  private closeBlock(o: OpenMessage, blk: OpenBlock): Emit[] {
    const ci = blk.index;
    if (o.content[ci]) return [];
    blk.closed = true;
    if (blk.kind === "text") {
      const content = typeof blk.final?.text === "string" ? blk.final.text : blk.acc;
      o.content[ci] = { type: "text", text: content };
      return [{ kind: "live", ev: { type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: ci, content } } }];
    }
    if (blk.kind === "thinking") {
      const content = typeof blk.final?.thinking === "string" ? blk.final.thinking : blk.acc;
      o.content[ci] = { type: "thinking", thinking: content, ...(blk.final?.signature ? { signature: blk.final.signature } : {}) };
      return [{ kind: "live", ev: { type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: ci, content } } }];
    }
    const args = blk.final?.input !== undefined ? blk.final.input : parseArgs(blk.acc);
    const toolCall = { type: "toolCall", id: blk.id!, name: blk.name!, arguments: args };
    o.content[ci] = toolCall as PiBlock;
    return [{ kind: "live", ev: { type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: ci, toolCall } } }];
  }

  /**
   * The message is complete: its entry goes into the session file FIRST, so the
   * feed sees the entry that supersedes the deltas before the message_end that
   * announces it (pi's own order), and only then the tool calls it made start.
   */
  private messageStop(dispatchTools = true): Emit[] {
    const o = this.open;
    if (!o) return [];
    const out: Emit[] = [];
    // A block the stream never closed (an interrupt, or a result that overtook the tail).
    for (const blk of o.blocks.values()) if (!blk.closed) out.push(...this.closeBlock(o, blk));
    this.open = null;
    const content = [...o.content].filter(Boolean);
    const message: PiMessage = {
      role: "assistant",
      timestamp: o.ts,
      content,
      stopReason: stopOf(o.stopReason ?? (content.some((b) => b.type === "toolCall") ? "tool_use" : null), !!o.errorMessage),
      ...(o.errorMessage ? { errorMessage: o.errorMessage } : {}),
      ...(o.errorMessage && this.limited ? { usageLimit: limitOf(o.errorMessage) } : {}),
      usage: { input: o.usage.input, output: o.usage.output, cacheRead: o.usage.cacheRead, cacheWrite: o.usage.cacheWrite },
    };
    out.push({ kind: "entry", entry: { type: "message", message } }, { kind: "live", ev: { type: "message_end", message } });
    const context = o.usage.input + o.usage.cacheRead + o.usage.cacheWrite;
    if (context > 0) {
      const last = { totalTokens: context + o.usage.output, inputTokens: o.usage.input, cachedInputTokens: o.usage.cacheRead, cacheWriteInputTokens: o.usage.cacheWrite, outputTokens: o.usage.output };
      this.lastUsage = last;
      out.push({ kind: "usage", usage: { last, modelContextWindow: this.window } });
    }
    // The tools this message called start now — unless the turn was cut before they ran.
    if (dispatchTools) {
      for (const b of content) {
        if (b.type === "toolCall" && b.id) out.push({ kind: "live", ev: { type: "tool_execution_start", toolCallId: b.id, toolName: b.name, args: b.arguments ?? {} } });
      }
    }
    out.push(...this.held.splice(0));
    return out;
  }

  // ------------------------------------------------------------ tools, the session, the turn's end

  private toolResult(m: any): Emit[] {
    const out: Emit[] = [];
    for (const r of toolResults(m)) {
      const toolName = this.toolNames.get(r.id) ?? "tool";
      const message: PiMessage = { role: "toolResult", toolCallId: r.id, toolName, isError: r.isError, content: r.content };
      out.push({ kind: "entry", entry: { type: "message", message } });
      out.push({ kind: "live", ev: { type: "tool_execution_end", toolCallId: r.id, toolName, isError: r.isError, result: { content: r.content } } });
      this.toolNames.delete(r.id);
    }
    // pi's order: the calling message's entry first. The stream's tail is imminent.
    if (this.open && out.length) {
      this.held.push(...out);
      return [];
    }
    return out;
  }

  /**
   * The CLI's 30 s heartbeat on a long tool call. Its own `tool_use_id` is
   * per-heartbeat (`<call>-heartbeat-0`, `-1`, …) and the call it is about is
   * `parent_tool_use_id`, so the row is found by trying both against the calls
   * this message actually made.
   */
  private toolProgress(m: any): Emit[] {
    const raw = String(m.tool_use_id ?? "");
    const candidates = [String(m.parent_tool_use_id ?? ""), raw.replace(/-heartbeat-\d+$/, ""), raw];
    const id = candidates.find((c) => c && this.toolNames.has(c)) ?? candidates.find(Boolean) ?? "";
    const secs = Number(m.elapsed_time_seconds);
    if (!id || !(secs > 0)) return [];
    return [{ kind: "live", ev: { type: "tool_execution_update", toolCallId: id, partialResult: { content: [{ type: "text", text: `still running (${secs}s)` }] } } }];
  }

  /** A user message that carries the model-facing <task-notification> block (replays only; the system message is the normal path). */
  private notificationText(m: any): Emit[] {
    if (m.parent_tool_use_id || (m.origin?.kind !== "task-notification" && !m.isReplay)) return [];
    const text = textOf(m.message?.content);
    if (!text.includes("<task-notification>")) return [];
    const tag = (n: string) => new RegExp(`<${n}>([\\s\\S]*?)</${n}>`).exec(text)?.[1]?.trim() ?? "";
    const status = tag("status");
    if (!status) return [];
    return this.workerNotice({ task_id: tag("task-id") || tag("task_id"), status, summary: tag("summary") });
  }

  /** Background workers started in this session and not finished: live from task_started to the final notice. */
  workers(): number {
    return this.running.size;
  }

  private workerNotice(m: any): Emit[] {
    const taskId = String(m.task_id ?? "");
    const status = String(m.status ?? "");
    const summary = String(m.summary ?? "");
    // Its final report ends it; an interim "not reported yet" keeps it live. Before the
    // ambient check: a task that ended is over whatever its notice is flagged as.
    if (finalNotice(status, summary)) this.running.delete(taskId);
    if (m.ambient || m.skip_transcript) return [];
    const text = workerNoticeText(this.tasks.get(taskId) ?? "", status, summary, m.reason);
    const key = `${taskId}\n${text}`;
    if (!text || this.noticed.has(key)) return [];
    this.noticed.add(key);
    return [{ kind: "workerNotice", taskId, text }];
  }

  private system(m: any): Emit[] {
    if (m.subtype === "task_started") {
      // Remember what the worker was asked to do: the notice names it by that, not by its report.
      if (m.task_id && !m.ambient && !m.skip_transcript) {
        this.tasks.set(String(m.task_id), String(m.description ?? "").trim());
        this.running.add(String(m.task_id));
      }
      return [];
    }
    if (m.subtype === "task_notification") return this.workerNotice(m);
    if (m.subtype === "init") return m.session_id ? [{ kind: "session", id: String(m.session_id) }] : [];
    if (m.subtype === "api_retry") return this.apiRetry(m);
    if (m.subtype === "status") {
      // Summarizing takes one to several minutes, and Claude Code says so when it
      // starts (status "compacting", then again every 30 s) and, when it fails,
      // with compact_result "failed". The clients draw the "Summarizing…" line on
      // compaction_start and take it down on compaction_end (a failure is a line).
      if (m.status === "compacting" && !this.compacting) {
        this.compacting = true;
        return [{ kind: "live", ev: { type: "compaction_start" } }];
      }
      if (m.compact_result === "failed") {
        this.compacting = false;
        const why = String(m.compact_error ?? "").replace(/^Error during compaction:\s*/i, "").trim() || "Claude Code could not write the summary";
        return [{ kind: "live", ev: { type: "compaction_end", aborted: false, errorMessage: why.slice(0, 500) } }];
      }
      return [];
    }
    if (m.subtype === "compact_boundary") {
      this.compacting = false;
      // Claude Code reports the boundary, not the summary it wrote, so the
      // transcript's divider says what happened in vault-chat's own words.
      // post_tokens is the context's size right after: the dial's new reading.
      const meta = m.compact_metadata ?? {};
      const before = Number(meta.pre_tokens) || 0;
      const after = Number(meta.post_tokens) || 0;
      const n = (x: number) => x.toLocaleString("en-US");
      const summary = `Summarized the earlier conversation${meta.trigger === "manual" ? "" : " automatically"}${before ? ` at ${n(before)} tokens` : ""}${after ? `, down to ${n(after)}` : ""}.`;
      return [
        { kind: "entry", entry: { type: "compaction", summary, ...(before ? { tokensBefore: before } : {}), ...(after ? { tokensAfter: after } : {}) } },
        { kind: "live", ev: { type: "compaction_end", aborted: false, result: { ok: true } } },
      ];
    }
    return [];
  }

  /**
   * A request the runtime is retrying by itself (SDKAPIRetryMessage: type
   * "system", subtype "api_retry" — it was read as a top-level type here, so
   * none of this ever ran and no retry was ever shown).
   *
   * A REFUSED SIGN-IN is retried like anything else, and will be refused every
   * time: measured against a 401, the runtime made 8 attempts in 90 seconds of
   * a budget of 10, backing off to 40 seconds apiece. So that one is not a
   * retry to show — it is told to the host at once, which stops the turn.
   */
  private apiRetry(m: any): Emit[] {
    // The SDK's own names, and its error which may be a string or an object
    // (stringifying the object put "[object Object]" in front of Carl).
    const why = typeof m.error === "string" ? m.error : String(m.error?.message ?? m.error?.type ?? m.message ?? "the request failed");
    const status = Number(m.error_status ?? 0);
    if (status === 401 || status === 403 || authRefused(why) || authRefused(m.error)) {
      return [{ kind: "authRefused", error: `${status || ""} ${why}`.trim().slice(0, 300) }];
    }
    this.retrying = true;
    return [{ kind: "live", ev: { type: "auto_retry_start", attempt: Number(m.attempt ?? 1), maxAttempts: Number(m.max_retries ?? m.maxAttempts ?? 0), errorMessage: why.slice(0, 500) } }];
  }

  private result(m: any): Emit[] {
    const out: Emit[] = [];
    // A message the stream never closed (an interrupt mid-block) is closed here.
    const wasOpen = !!this.open;
    if (this.open) out.push(...this.messageStop(false));
    // Only the result names the window, so the first turn's usage went out
    // without one: say it again here, and the context bar is right from turn one.
    const window = Object.values(m.modelUsage ?? {}).map((u: any) => Number(u?.contextWindow)).find((n) => n > 0);
    if (window && window !== this.window) {
      this.window = window;
      if (this.lastUsage) out.push({ kind: "usage", usage: { last: this.lastUsage, modelContextWindow: window } });
    }
    const subtype = String(m.subtype ?? (m.is_error ? "error" : "success"));
    const terminal = String(m.terminal_reason ?? "");
    const asked = this.stopping;
    this.stopping = false;
    const limited = this.limited;
    this.limited = false;
    const reported = terminal === "cancelled" || terminal === "interrupted" || subtype === "interrupted" ? "interrupted" : m.is_error || subtype.startsWith("error") ? "failed" : "completed";
    // Claude Code reports a turn the host aborted as a failure of its own; the
    // host knows better, because the host asked. Without this the chat shows a
    // red "the turn failed" where Carl pressed stop.
    const status = asked && reported !== "completed" ? "interrupted" : reported;
    const error = status === "failed" ? String(m.result ?? m.error ?? subtype).slice(0, 500) : null;
    // A sign-in the API refused is not an error to show Carl: it is the one
    // state the app already has for it. The raw text still goes to the host (it
    // is what health reports and what the log keeps); what the CHAT gets is the
    // sentence that tells him what to do (claude/auth.ts).
    const refused = !!error && !wasOpen && authRefused(error);
    const shown = refused ? SIGN_IN_AGAIN : error;
    // Every retry failed (or the turn ended while one was in flight): the end
    // event says so, and the red line is the one the engine writes.
    out.push(...this.retryEnded(status === "completed"));
    // A request that failed before the model said anything: the failure is the
    // reply, written the way one the model's own message carried is written, so
    // the chat shows ONE red line — with Try again — and not a bare error.
    if (status === "failed" && !wasOpen && error) {
      const message: PiMessage = { role: "assistant", timestamp: this.stamp(), content: [], stopReason: "error", errorMessage: shown ?? error, ...(limited ? { usageLimit: limitOf(error) } : {}), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      out.push({ kind: "entry", entry: { type: "message", message } }, { kind: "live", ev: { type: "message_end", message } });
    }
    out.push(...this.held.splice(0));
    out.push({ kind: "done", status, error, ...(refused ? { refused: true } : {}), ...(limited && status === "failed" ? { limited: true } : {}) });
    return out;
  }
}

/**
 * A usage-limit failure as the chat keeps it: the reset as the SDK words it
 * ("1:30am (America/Chicago)"), for the quiet line only — what the host does
 * keys on the structured error, never on this text.
 */
export function limitOf(text: string): { resets: string | null } {
  const m = /\bresets\s+(.+?)\s*$/i.exec(String(text ?? "").split(/\r?\n/)[0] ?? "");
  return { resets: m ? m[1]!.slice(0, 80) : null };
}

/** A tool call's input from its streamed JSON; `{}` if the stream was cut mid-object. */
function parseArgs(json: string): Record<string, unknown> {
  if (!json.trim()) return {};
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}
