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

  // The messages Claude Code 2.1.321 (SDK 0.3.321) sends for a /compact, as recorded on this box
  // against a scripted API: "compacting" at the start (again every 30 s while it works), then a
  // status with compact_result, the boundary with the size before AND after, and the command's result.
  const compacting = { type: "system", subtype: "status", status: "compacting", session_id: "s", uuid: "u1" };
  it("a /compact shows from its start: one Summarizing line, then the divider with the size after (the dial's new reading)", () => {
    const { picture, emits } = replay([
      ...messages,
      compacting,
      { ...compacting, uuid: "u2" },
      { type: "system", subtype: "status", status: null, compact_result: "success", session_id: "s", uuid: "u3" },
      { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 3250, post_tokens: 2507, duration_ms: 3026 }, session_id: "s", uuid: "u4" },
      { type: "result", subtype: "success", is_error: false, result: "", session_id: "s", uuid: "u5" },
    ]);
    const live = emits.filter((e) => e.kind === "live" && /^compaction_/.test(String((e as any).ev.type))).map((e) => (e as any).ev.type);
    expect(live).toEqual(["compaction_start", "compaction_end"]);
    const div = picture.items.filter((i: any) => i.kind === "compaction");
    expect(div.map((d: any) => [d.status, d.text])).toEqual([["done", "Summarized the earlier conversation at 3,250 tokens, down to 2,507."]]);
    expect(picture.usage?.context).toBe(2507);
  });

  it("while it summarizes, the picture has the open line; a failed summary takes it down and says why, once", () => {
    const during = replay([...messages, compacting]).picture;
    expect([...during.items, ...during.inflight].filter((i: any) => i.kind === "compaction").map((i: any) => i.status)).toEqual(["streaming"]);
    const { picture } = replay([
      ...messages,
      compacting,
      { type: "system", subtype: "status", status: null, compact_result: "failed", compact_error: "Error during compaction: API Error: 400 refused", session_id: "s", uuid: "u3" },
      { type: "result", subtype: "success", is_error: false, result: "Error during compaction: API Error: 400 refused", session_id: "s", uuid: "u5" },
    ]);
    expect([...picture.items, ...picture.inflight].filter((i: any) => i.kind === "compaction")).toEqual([]);
    expect(picture.items.filter((i: any) => i.kind === "notice").map((i: any) => i.text)).toEqual(["Summarizing the earlier conversation failed: API Error: 400 refused"]);
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

describe("a background worker's notification", () => {
  it("becomes one quiet notice per report, before the reply, with interim ones marked", () => {
    const { emits } = replay(stream("claude-task-notification.jsonl"));
    const notices = emits.filter((e) => e.kind === "workerNotice").map((e: any) => e.text);
    expect(notices).toEqual([
      "Worker finished: Check the rainfall data", // the repeat of the same notice is dropped
      "Worker NOT finished, waiting on its own background work (interim notice): Build the thing",
      "Worker failed: Build the thing",
      "Worker stopped: Agent \"Old job\" was stopped", // never started here: the summary names it
      "Worker finished: Agent \"Replayed one\" completed", // the replayed <task-notification> user message
    ]);
    // The first notice is in the stream before the reply's message_start.
    const first = emits.findIndex((e) => e.kind === "workerNotice");
    const live = emits.findIndex((e) => e.kind === "live" && (e as any).ev.type === "message_start");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(live === -1 || first < live).toBe(true);
  });
});

// What the box's updater waits for (health busy.workers): a restart kills a worker mid-work.
describe("the background workers a session still has at work", () => {
  const started = (task_id: string, extra: Record<string, unknown> = {}) => ({ type: "system", subtype: "task_started", task_id, description: `do ${task_id}`, task_type: "local_agent", ...extra });
  const notice = (task_id: string, status: string, summary = `Agent "do ${task_id}" ${status}`, extra: Record<string, unknown> = {}) => ({ type: "system", subtype: "task_notification", task_id, status, summary, output_file: "/tmp/x", ...extra });
  const INTERIM = "This agent has not reported yet: it is waiting on its own background work and will deliver its report through a later notification";

  it("a worker is live from its start to its final report, whichever way it ends", () => {
    const t = new ClaudeTranslator();
    expect(t.workers()).toBe(0);
    for (const id of ["a", "b", "c"]) t.step(started(id));
    expect(t.workers()).toBe(3);
    t.step(notice("a", "completed"));
    expect(t.workers()).toBe(2);
    t.step(notice("b", "failed"));
    expect(t.workers()).toBe(1);
    t.step(notice("c", "stopped", undefined, { reason: "worker_restart" }));
    expect(t.workers()).toBe(0);
  });

  it("a background shell command ends without a notice line, but an agent still gets one", () => {
    const t = new ClaudeTranslator();
    t.step(started("sh", { task_type: "local_bash", description: "npm run test:server" }));
    t.step(started("ag"));
    const out = [...t.step(notice("sh", "completed")), ...t.step(notice("ag", "completed"))].filter((e) => e.kind === "workerNotice").map((e: any) => e.text);
    expect(out).toEqual(["Worker finished: do ag"]);
    expect(t.workers()).toBe(0);
  });

  it("an interim `completed` (it has not reported yet) keeps it live; its real report ends it", () => {
    const t = new ClaudeTranslator();
    t.step(started("a"));
    t.step(notice("a", "completed", INTERIM));
    expect(t.workers()).toBe(1);
    t.step(notice("a", "completed", INTERIM));
    expect(t.workers()).toBe(1);
    t.step(notice("a", "completed"));
    expect(t.workers()).toBe(0);
  });

  it("a start said twice is one worker, and a report said twice (or for a worker never started here) never goes below zero", () => {
    const t = new ClaudeTranslator();
    t.step(started("a"));
    t.step(started("a"));
    expect(t.workers()).toBe(1);
    t.step(notice("a", "completed"));
    t.step(notice("a", "completed"));
    t.step(notice("never-started", "stopped"));
    expect(t.workers()).toBe(0);
    // The other started worker is untouched by a stranger's report.
    t.step(started("b"));
    t.step(notice("never-started", "failed"));
    expect(t.workers()).toBe(1);
    // The same worker resumed (a new run of the same task) is live again.
    t.step(started("a"));
    expect(t.workers()).toBe(2);
  });

  it("the replayed <task-notification> user message ends it as the system message does", () => {
    const t = new ClaudeTranslator();
    t.step(started("zz9"));
    const replayed = (status: string, summary: string) => ({ type: "user", message: { role: "user", content: `<task-notification>\n<task-id>zz9</task-id>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>` }, origin: { kind: "task-notification" }, isReplay: true, parent_tool_use_id: null });
    t.step(replayed("completed", INTERIM));
    expect(t.workers()).toBe(1);
    t.step(replayed("completed", "Agent \"do zz9\" completed"));
    expect(t.workers()).toBe(0);
  });

  it("ambient and housekeeping tasks are not workers", () => {
    const t = new ClaudeTranslator();
    t.step(started("watcher", { ambient: true }));
    t.step(started("housekeeping", { skip_transcript: true }));
    t.step({ type: "system", subtype: "task_started", description: "no id" });
    expect(t.workers()).toBe(0);
    // And an ambient report takes nothing from a real worker's count, nor says anything.
    t.step(started("a"));
    expect(t.step(notice("watcher", "completed", "watcher done", { ambient: true }))).toEqual([]);
    expect(t.workers()).toBe(1);
  });

  it("a turn that ends, or is interrupted, leaves its background workers live", () => {
    const t = new ClaudeTranslator();
    t.step(started("a"));
    t.step({ type: "result", subtype: "success", is_error: false, result: "ok" });
    expect(t.workers()).toBe(1);
    t.expectInterrupt();
    t.step({ type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "interrupted" });
    expect(t.workers()).toBe(1);
    t.step(notice("a", "stopped"));
    expect(t.workers()).toBe(0);
  });

  it("the recorded stream ends with nothing left at work", () => {
    const t = new ClaudeTranslator();
    const seen: number[] = [];
    for (const m of stream("claude-task-notification.jsonl")) {
      t.step(m);
      seen.push(t.workers());
    }
    // a1b2c3 starts and finishes (twice said); d4 starts, is interim, then fails; the rest never started here.
    expect(seen).toEqual([1, 0, 0, 0, 1, 1, 0, 0, 0, 0]);
  });
});

describe("Carl's usage limit", () => {
  // The shape Claude Code gives it (seen in this box's session files on 2026-11-12): a synthetic
  // assistant message with `error: "rate_limit"` (its transcript adds apiError
  // "usage_limit_reached"), then a result that is_error, with the reset only in the words.
  const words = "You've hit your 5-hour limit · resets 1:30am (America/Chicago)";
  const limited = [
    { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1_794_195_000, rateLimitType: "five_hour" } },
    { type: "assistant", parent_tool_use_id: null, error: "rate_limit", message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: words }] } },
    { type: "result", subtype: "success", is_error: true, result: words },
  ];

  it("ends the turn as held for the limit, keyed on the structured error, with the reset in ms", () => {
    const { emits, picture } = replay(limited);
    expect(emits.find((e) => e.kind === "rateLimit")).toMatchObject({ status: "rejected", resetsAt: 1_794_195_000_000, kindOfLimit: "five_hour" });
    expect(emits.find((e) => e.kind === "done")).toMatchObject({ status: "failed", limited: true });
    // One quiet line, not a red "Couldn't get a reply".
    const notices = picture.items.filter((x) => x.kind === "notice");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ level: "info", text: "Usage limit reached. I'll pick this up at 1:30am (America/Chicago)." });
  });

  it("the same words without the structured error stay an ordinary failure", () => {
    const { emits, picture } = replay([{ type: "result", subtype: "success", is_error: true, result: words }]);
    expect((emits.find((e) => e.kind === "done") as any).limited).toBeUndefined();
    expect(picture.items.find((x) => x.kind === "notice")).toMatchObject({ level: "error" });
  });

  it("a rejection that paid overage carries is not a limit", () => {
    const t = new ClaudeTranslator();
    expect(t.step({ type: "rate_limit_event", rate_limit_info: { status: "rejected", overageStatus: "allowed", resetsAt: 1_794_195_000 } })[0]).toMatchObject({ status: "allowed_warning" });
    expect(t.step({ type: "result", subtype: "success", is_error: false, result: "ok" }).find((e) => e.kind === "done")).not.toHaveProperty("limited");
  });
});
