// pi's RPC session events, as pi 1.1.0 sends them (its docs: json.md), for the
// engine tests' fake backends. A test writes what the model did in shorthand;
// the engine receives exactly what real pi would send (a `pi` backend event).
// Recorded sequences from the real pi live in ./fixtures/pi-*.jsonl.

/** One assistant message: its blocks streamed (start, deltas, end), then message_end. */
export function assistant(blocks: ({ text: string } | { thinking: string } | { toolCall: { id: string; name: string; arguments: any } })[], opts: { usage?: number; stopReason?: string; errorMessage?: string; chunks?: number } = {}): any[] {
  const out: any[] = [{ type: "message_start", message: { role: "assistant", content: [], stopReason: "pending" } }];
  const split = (s: string) => {
    const n = Math.max(1, opts.chunks ?? 3);
    const size = Math.max(1, Math.ceil(s.length / n));
    const parts: string[] = [];
    for (let i = 0; i < s.length; i += size) parts.push(s.slice(i, i + size));
    return parts.length ? parts : [""];
  };
  blocks.forEach((b, ci) => {
    if ("text" in b) {
      out.push({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: ci } });
      for (const d of split(b.text)) out.push({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: ci, delta: d } });
      out.push({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: ci, content: b.text } });
    } else if ("thinking" in b) {
      out.push({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: ci } });
      for (const d of split(b.thinking)) out.push({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: ci, delta: d } });
      out.push({ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: ci, content: b.thinking } });
    } else {
      const tc = b.toolCall;
      out.push({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: ci, id: tc.id, toolName: tc.name } });
      for (const d of split(JSON.stringify(tc.arguments ?? {}))) out.push({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: ci, delta: d } });
      out.push({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: ci, toolCall: { type: "toolCall", ...tc } } });
    }
  });
  const content = blocks.map((b) => ("text" in b ? { type: "text", text: b.text } : "thinking" in b ? { type: "thinking", thinking: b.thinking } : { type: "toolCall", ...b.toolCall }));
  out.push({
    type: "message_end",
    message: { role: "assistant", content, stopReason: opts.stopReason ?? (blocks.some((b) => "toolCall" in b) ? "toolUse" : "stop"), ...(opts.errorMessage ? { errorMessage: opts.errorMessage } : {}), usage: { input: opts.usage ?? 1000, output: 50, cacheRead: 0, cacheWrite: 0 } },
  });
  return out;
}

export const toolStart = (id: string, name: string, args: any) => ({ type: "tool_execution_start", toolCallId: id, toolName: name, args });
export const toolUpdate = (id: string, name: string, partial: string) => ({ type: "tool_execution_update", toolCallId: id, toolName: name, args: {}, partialResult: { content: [{ type: "text", text: partial }] } });
export const toolEnd = (id: string, name: string, result: string, isError = false) => ({ type: "tool_execution_end", toolCallId: id, toolName: name, result: { content: [{ type: "text", text: result }], details: {} }, isError });
export const userMsg = (text: string) => [
  { type: "message_start", message: { role: "user", content: text } },
  { type: "message_end", message: { role: "user", content: text } },
];
export const compaction = (summary: string) => [
  { type: "compaction_start", reason: "threshold" },
  { type: "compaction_end", reason: "threshold", result: { summary, firstKeptEntryId: "e1", tokensBefore: 150000 }, aborted: false, willRetry: false },
];

/**
 * The older tests' shorthand → the pi events real pi sends for it:
 *   text / textDelta → an assistant message with that text;  reasoning / reasoningDelta → one with that thinking;
 *   tool without result → the model's call (streamed) and its execution start;  tool with result → its execution end;
 *   toolProgress → an execution update;  compaction → compaction start + end.
 * Anything else (usage, subagents, turnCompleted, threadLost …) passes as it is.
 */
export function piOf(e: any): any[] {
  const pi = (ev: any) => ({ kind: "pi", ev });
  switch (e.kind) {
    case "text":
      return assistant([{ text: e.text }]).map(pi);
    case "textDelta":
      return assistant([{ text: e.delta }]).map(pi);
    case "reasoning":
      return assistant([{ thinking: e.text }]).map(pi);
    case "reasoningDelta":
      return assistant([{ thinking: e.delta }]).map(pi);
    case "tool":
      if (e.result === undefined) return [...assistant([{ toolCall: { id: e.itemId, name: e.name, arguments: e.input ?? {} } }]), toolStart(e.itemId, e.name, e.input ?? {})].map(pi);
      return [pi(toolEnd(e.itemId, e.name, String(e.result).replace(/^\[error\] /, ""), String(e.result).startsWith("[error]")))];
    case "toolProgress":
      return [pi(toolUpdate(e.itemId, e.name ?? "Bash", "…"))];
    case "compaction":
      return compaction(e.summary).map(pi);
    default:
      return [e];
  }
}
