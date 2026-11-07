// A recorded Claude Code turn, folded by the clients' own reducer.
//
// The fixture is a real stream from the Claude Agent SDK (0.3.319 with its
// bundled CLI 2.1.319), recorded on this box against a scripted fake Anthropic
// API so the model's words are fixed: one assistant message with a thinking
// block, commentary text and an MCP tool call, the tool's result, then the
// reply. Everything about what the CLI sends is genuine; only the model is
// scripted.
//
// The test puts that stream through the translator and then through the parts
// the three clients actually run — piSession for the transcript, the one
// reducer (src/convlog/reduce.ts) for the picture — and checks the picture is
// the one a pi turn would have produced: the same item kinds, the same stable
// `<message timestamp>:<content index>` ids while streaming and after the
// entry supersedes them, the tool's parsed arguments and its result.
import { describe, it, expect } from "vitest";
import { readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmp } from "./helpers";
import { ClaudeTranslator, type Emit } from "../engine/claude/translate";
import { appendEntries, newSessionFile, readEntries } from "../convlog/piSession";
import { emptyPicture, foldInto, type Picture } from "../../src/convlog/reduce";
import type { StoredRecord } from "../../src/convlog/protocol";

const stream = (name: string): any[] =>
  readFileSync(join(__dirname, "fixtures", name), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

/** The translator's output, and the picture the clients fold from it. */
function replay(messages: any[], conv = "claude-1"): { emits: Emit[]; picture: Picture; file: string; sessionIds: string[] } {
  const root = tmp("vcct-");
  const dir = join(root, "sessions");
  mkdirSync(dir, { recursive: true });
  const file = newSessionFile(join(dir, "claude.jsonl"), root);
  // A fixed clock, so the ids in the expectations are the ids the fold produces.
  let clock = 1_700_000_000_000;
  const t = new ClaudeTranslator(() => (clock += 1000));
  const emits: Emit[] = [];
  const records: StoredRecord[] = [];
  const sessionIds: string[] = [];
  let seq = 0;
  for (const m of messages) {
    for (const e of t.step(m)) {
      emits.push(e);
      seq += 1;
      if (e.kind === "live") records.push({ seq, conv, at: clock, type: "live", ev: e.ev } as StoredRecord);
      else if (e.kind === "entry") {
        // The host writes the entry into the thread's own session file, as pi does.
        const [written] = appendEntries(file, [e.entry]);
        records.push({ seq, conv, at: clock, type: "entry", file, entry: written! } as StoredRecord);
      } else if (e.kind === "session") sessionIds.push(e.id);
    }
  }
  const picture = foldInto(emptyPicture(conv), records);
  rmSync(root, { recursive: true, force: true });
  return { emits, picture, file, sessionIds };
}

describe("a Claude Code turn said in pi's words", () => {
  const messages = stream("claude-turn.jsonl");

  it("folds into the picture a pi turn would have produced: thinking, the tool with its args and result, then the reply", () => {
    const { picture, emits, sessionIds } = replay(messages);
    expect(sessionIds).toEqual(["e8cbd27b-563f-449e-b1f5-df02f75542b4"]);

    const items = picture.items.map((i: any) => ({ id: i.id, kind: i.kind, status: i.status, name: i.name, text: i.text, args: i.args, result: i.result }));
    expect(items).toEqual([
      // The first message's blocks, named `<its timestamp>:<content index>`.
      { id: "1700000001000:0", kind: "thinking", status: "done", name: undefined, text: "The note lives in the vault, so read it first.", args: undefined, result: undefined },
      // Text beside a tool call is commentary: the clients put it under "Thought", never in the reply.
      { id: "1700000001000:1", kind: "thinking", status: "done", name: undefined, text: "Reading the note now.", args: undefined, result: undefined },
      // vault-chat's own MCP namespace is stripped for the clients (src/mcpNames.ts), so the row says "echo".
      { id: "toolu_rec1", kind: "tool", status: "done", name: "echo", text: undefined, args: { text: "the note" }, result: "echo: the note" },
      // The reply, from the second message.
      { id: "1700000002000:0", kind: "assistant", status: "done", name: undefined, text: "The note says: the note.", args: undefined, result: undefined },
    ]);
    expect(picture.inflight).toEqual([]);
    expect(picture.inflightTs).toBeNull();

    // The turn ended once, and cleanly.
    expect(emits.filter((e) => e.kind === "done")).toEqual([{ kind: "done", status: "completed", error: null }]);
  });

  it("the ids a client draws while streaming are the ids the entry keeps", () => {
    const { emits } = replay(messages);
    const live = emits.filter((e): e is Extract<Emit, { kind: "live" }> => e.kind === "live").map((e) => e.ev as any);
    const starts = live.filter((e) => e.type === "message_start").map((e) => e.message.timestamp);
    expect(starts).toEqual([1_700_000_001_000, 1_700_000_002_000]);
    // Every entry for an assistant message carries its message_start timestamp, so
    // `<timestamp>:<index>` is the same before and after the entry lands.
    const entryTs = emits
      .filter((e): e is Extract<Emit, { kind: "entry" }> => e.kind === "entry")
      .map((e) => e.entry.message)
      .filter((m: any) => m?.role === "assistant")
      .map((m: any) => m.timestamp);
    expect(entryTs).toEqual(starts);

    // The deltas, in pi's own vocabulary.
    const updates = live.filter((e) => e.type === "message_update").map((e) => [e.assistantMessageEvent.type, e.assistantMessageEvent.contentIndex]);
    expect(updates).toEqual([
      ["thinking_start", 0], ["thinking_delta", 0], ["thinking_delta", 0], ["thinking_end", 0],
      ["text_start", 1], ["text_delta", 1], ["text_delta", 1], ["text_end", 1],
      ["toolcall_start", 2], ["toolcall_delta", 2], ["toolcall_delta", 2], ["toolcall_end", 2],
      ["text_start", 0], ["text_delta", 0], ["text_end", 0],
    ]);
    // A tool call's arguments reach the feed parsed, not as the JSON the model streamed.
    const end = live.find((e) => e.assistantMessageEvent?.type === "toolcall_end");
    expect(end.assistantMessageEvent.toolCall).toEqual({ type: "toolCall", id: "toolu_rec1", name: "mcp__vault_chat__echo", arguments: { text: "the note" } });
    // The tool runs after the message it was called in, and its result closes it.
    const toolEvents = live.filter((e) => String(e.type).startsWith("tool_execution_")).map((e) => [e.type, e.toolCallId]);
    expect(toolEvents).toEqual([["tool_execution_start", "toolu_rec1"], ["tool_execution_end", "toolu_rec1"]]);
  });

  it("writes a pi-format session file the transcript can be read back from", () => {
    const root = tmp("vcct2-");
    const dir = join(root, "sessions");
    mkdirSync(dir, { recursive: true });
    const file = newSessionFile(join(dir, "claude.jsonl"), root);
    let clock = 1_700_000_000_000;
    const t = new ClaudeTranslator(() => (clock += 1000));
    for (const m of messages) for (const e of t.step(m)) if (e.kind === "entry") appendEntries(file, [e.entry]);

    const entries = readEntries(file);
    expect(entries.map((e) => [e.type, e.message?.role])).toEqual([
      ["message", "assistant"],
      ["message", "toolResult"],
      ["message", "assistant"],
    ]);
    // Every entry is a child of the one before it, as pi's own files are.
    for (let i = 1; i < entries.length; i++) expect(entries[i]!.parentId).toBe(entries[i - 1]!.id);
    const first = entries[0]!.message!;
    expect((first.content as any[]).map((b) => b.type)).toEqual(["thinking", "text", "toolCall"]);
    expect(first.stopReason).toBe("toolUse");
    expect(first.usage).toEqual({ input: 1234, output: 42, cacheRead: 2000, cacheWrite: 7 });
    expect(entries[1]!.message).toMatchObject({ role: "toolResult", toolCallId: "toolu_rec1", toolName: "mcp__vault_chat__echo", isError: false });
    expect(entries[2]!.message!.stopReason).toBe("stop");
    rmSync(root, { recursive: true, force: true });
  });

  it("reports the context size of each model call, and the window as soon as it is known", () => {
    const { emits } = replay(messages);
    const usage = emits.filter((e): e is Extract<Emit, { kind: "usage" }> => e.kind === "usage");
    expect(usage.map((u) => u.usage.last)).toEqual([
      { totalTokens: 3283, inputTokens: 1234, cachedInputTokens: 2000, cacheWriteInputTokens: 7, outputTokens: 42 },
      { totalTokens: 3250, inputTokens: 1234, cachedInputTokens: 2000, cacheWriteInputTokens: 7, outputTokens: 9 },
      // Only the result names the window, so the last figure is said again with it:
      // the clients' context bar is right from the first turn, not the second.
      { totalTokens: 3250, inputTokens: 1234, cachedInputTokens: 2000, cacheWriteInputTokens: 7, outputTokens: 9 },
    ]);
    expect(usage.map((u) => u.usage.modelContextWindow)).toEqual([null, null, 1_000_000]);
  });

  it("a 30 s heartbeat on a long tool call shows as that call's progress, not a row of its own", () => {
    // The heartbeat shape the spike recorded on this box: its own tool_use_id is
    // per-heartbeat and the call it is about is parent_tool_use_id.
    const upTo = messages.slice(0, messages.findIndex((m) => m.type === "user"));
    const beat = (n: number) => ({ type: "tool_progress", tool_use_id: `toolu_rec1-heartbeat-${n}`, tool_name: "mcp__vault_chat__echo", parent_tool_use_id: "toolu_rec1", elapsed_time_seconds: 30 * (n + 1), heartbeat: true, session_id: "s", uuid: `u${n}` });
    const { picture, emits } = replay([...upTo, beat(0), beat(1), ...messages.slice(messages.findIndex((m) => m.type === "user"))]);
    const updates = emits.filter((e) => e.kind === "live" && (e as any).ev.type === "tool_execution_update").map((e) => (e as any).ev);
    expect(updates.map((u) => [u.toolCallId, u.partialResult.content[0].text])).toEqual([
      ["toolu_rec1", "still running (30s)"],
      ["toolu_rec1", "still running (60s)"],
    ]);
    // One tool row, and the result replaces the progress line.
    const tools = picture.items.filter((i: any) => i.kind === "tool");
    expect(tools.map((t: any) => [t.id, t.status, t.result, t.partial])).toEqual([["toolu_rec1", "done", "echo: the note", undefined]]);
  });

  it("a compaction becomes the divider the clients already draw", () => {
    const { picture } = replay([
      ...messages,
      { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 123456 }, session_id: "s", uuid: "u" },
    ]);
    const div = picture.items.filter((i: any) => i.kind === "compaction");
    expect(div.map((d: any) => [d.status, d.text])).toEqual([["done", "Summarized the earlier conversation automatically at 123,456 tokens."]]);
  });

  it("a subagent's own stream is never folded in as the parent's reply", () => {
    const t = new ClaudeTranslator();
    const child = messages.filter((m) => m.type === "stream_event" || m.type === "assistant" || m.type === "user").map((m) => ({ ...m, parent_tool_use_id: "toolu_parent" }));
    expect(child.flatMap((m) => t.step(m))).toEqual([]);
  });

  it("a tool result that overtakes the stream's tail still lands after its own message's entry", () => {
    // The same recording with the `user` result moved ahead of the message's last
    // stream events — the order another run of this same script produced on this box,
    // when the tool answered before the CLI had delivered the stream's tail. The
    // clients only keep a tool's result on a row the entry already placed, so the
    // translator must hold it until the calling message is closed.
    const i = messages.findIndex((m) => m.type === "user");
    const tail = messages.findIndex((m) => m.type === "stream_event" && m.event?.type === "content_block_stop" && m.event.index === 2);
    expect(i).toBeGreaterThan(tail);
    const raced = [...messages.slice(0, tail), messages[i], ...messages.slice(tail, i), ...messages.slice(i + 1)];
    const { picture, emits } = replay(raced);

    const order = emits
      .filter((e) => e.kind === "entry" || (e.kind === "live" && /message_end|tool_execution_/.test(String((e as any).ev.type))))
      .map((e) => (e.kind === "entry" ? `entry:${(e.entry.message as any)?.role}` : `live:${(e as any).ev.type}`));
    expect(order).toEqual([
      "entry:assistant",
      "live:message_end",
      "live:tool_execution_start",
      "entry:toolResult",
      "live:tool_execution_end",
      "entry:assistant",
      "live:message_end",
    ]);
    // Same picture as the unraced run: the result stuck.
    expect(picture.items.map((it: any) => [it.id, it.kind, it.status, it.result])).toEqual([
      ["1700000001000:0", "thinking", "done", undefined],
      ["1700000001000:1", "thinking", "done", undefined],
      ["toolu_rec1", "tool", "done", "echo: the note"],
      ["1700000002000:0", "assistant", "done", undefined],
    ]);
  });

  it("an interrupt mid-message still closes it, so no block is left streaming", () => {
    // Everything up to the first tool call, then the turn is cancelled.
    const cut = messages.slice(0, messages.findIndex((m) => m.type === "stream_event" && m.event?.type === "message_delta"));
    const { picture, emits } = replay([...cut, { type: "result", subtype: "success", terminal_reason: "cancelled", session_id: "s", modelUsage: {} }]);
    expect(emits.filter((e) => e.kind === "done")).toEqual([{ kind: "done", status: "interrupted", error: null }]);
    expect(picture.inflight).toEqual([]);
    // The blocks it had already streamed are in the transcript, with their ids.
    expect(picture.items.map((i: any) => [i.id, i.kind, i.status])).toEqual([
      ["1700000001000:0", "thinking", "done"],
      ["1700000001000:1", "thinking", "done"],
      ["toolu_rec1", "tool", "pending"],
    ]);
  });
});
