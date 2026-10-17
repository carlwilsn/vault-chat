// The one reducer (src/convlog/reduce.ts) on pi's own event sequences, as the
// box maps them into the log (server/engine/piMap.ts): text and thinking
// deltas, tool calls with streamed arguments, parallel calls, a steer and a
// queued message delivered mid-run, a stop, an error, AskUser, a compaction, a
// wake, a subagent. Then the properties every client relies on: any cut and
// any replay of overlapping windows (a reconnect at any N) folds to the same
// picture as one uninterrupted stream; nothing shown ever disappears except by
// an explicit item.removed; the list row folded alone equals the full fold's;
// a checkpoint on disk equals the fold.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PiMapper } from "../../server/engine/piMap.ts";
import { ConvLog } from "../../server/convlog/log.ts";
import { assistant, toolStart, toolEnd, toolUpdate, userMsg, compaction } from "../../server/test/fakePi.ts";
import type { EventBody, LogRecord } from "../../src/convlog/protocol.ts";
import { emptyRow, fold, foldInto, isOpen, reduce, reduceRow, rowFromPicture } from "../../src/convlog/reduce.ts";
import { makeChatView, messagesOf } from "../../src/convlog/view.ts";

const C = "conv1";

/** A tiny box: records with a vault-wide sequence. */
class Log {
  recs: LogRecord[] = [];
  seq = 0;
  at = 1_000;
  emit = (b: EventBody, conv: string | null = C): void => {
    this.recs.push({ seq: ++this.seq, conv, at: (this.at += 10), ...b } as LogRecord);
  };
}

/** One turn: the engine's records around pi's events mapped 1:1. */
function turn(log: Log, id: string, userText: string, piEvents: any[], o: { clientId?: string; expect?: { kind: "steer" | "queue"; id: string; text: string }[]; end?: "completed" | "stopped" | "failed" } = {}): PiMapper {
  log.emit({ type: "turn.started", turn: id, kind: "user" });
  log.emit({ type: "item.started", item: { id: o.clientId ?? `${id}-u`, kind: "user", status: "done", text: userText, via: "chat", turn: id, at: 0 } });
  const m = new PiMapper({ turn: id, emit: (b) => log.emit(b), flushMs: 1e9, now: () => (log.at += 2_000) });
  m.expect({ kind: "prompt", text: userText });
  for (const e of o.expect ?? []) {
    log.emit({ type: "pending.added", pending: { id: e.id, kind: e.kind, text: e.text, at: 0 } });
    m.expect({ kind: e.kind, text: e.text, id: e.id, shown: e.text });
  }
  for (const ev of piEvents) m.onPi(ev);
  m.dispose();
  if (o.end !== undefined || true) log.emit({ type: "turn.ended", turn: id, status: o.end ?? "completed" });
  return m;
}

const view = (recs: LogRecord[]) => messagesOf(fold(recs, C)).map((m) => (m.toolCalls ? `tools:${m.toolCalls.map((t) => `${t.name}=${t.result ?? "…"}`).join(",")}` : m.thinking ? `thinking:${m.thinking}` : `${m.system ? "system" : m.role}:${m.content}`));

function created(log: Log): void {
  log.emit({ type: "conv.created", meta: { title: "New chat", source: "manual" } });
}

// ---------------------------------------------------------------- sequences

function seqTextThinking(log: Log): void {
  created(log);
  turn(log, "t1", "Explain the KV cache.", [...userMsg("Explain the KV cache."), ...assistant([{ thinking: "The user wants the cache explained." }, { text: "The KV cache keeps keys and values per token." }], { chunks: 5 })]);
}

function seqTools(log: Log): void {
  created(log);
  turn(log, "t1", "Read both papers.", [
    ...userMsg("Read both papers."),
    ...assistant([{ text: "Reading both." }, { toolCall: { id: "c1", name: "read", arguments: { path: "a.md" } } }, { toolCall: { id: "c2", name: "read", arguments: { path: "b.md" } } }], { chunks: 4 }),
    toolStart("c1", "read", { path: "a.md" }),
    toolStart("c2", "read", { path: "b.md" }),
    toolUpdate("c2", "read", "partial b"),
    toolEnd("c2", "read", "B"),
    toolEnd("c1", "read", "A"),
    ...assistant([{ text: "A is better." }]),
  ]);
}

function seqSteerQueue(log: Log): void {
  created(log);
  turn(
    log,
    "t1",
    "Go through the chapters.",
    [
      ...userMsg("Go through the chapters."),
      ...assistant([{ text: "Chapter one." }, { toolCall: { id: "c1", name: "bash", arguments: { command: "ls" } } }]),
      toolStart("c1", "bash", { command: "ls" }),
      toolEnd("c1", "bash", "ch1 ch2"),
      // pi delivers the steer after the tool calls, the follow-up when it would stop.
      ...userMsg("Shorter."),
      ...assistant([{ text: "Short then." }]),
      ...userMsg("Then summarize."),
      ...assistant([{ text: "Summary." }]),
    ],
    { expect: [{ kind: "steer", id: "s1", text: "Shorter." }, { kind: "queue", id: "q1", text: "Then summarize." }] },
  );
}

function seqStop(log: Log): void {
  created(log);
  log.emit({ type: "turn.started", turn: "t1", kind: "user" });
  log.emit({ type: "item.started", item: { id: "u1", kind: "user", status: "done", text: "Write a long essay.", turn: "t1", at: 0 } });
  const m = new PiMapper({ turn: "t1", emit: (b) => log.emit(b), flushMs: 1e9 });
  m.expect({ kind: "prompt", text: "Write a long essay." });
  for (const ev of userMsg("Write a long essay.")) m.onPi(ev);
  m.onPi({ type: "message_start", message: { role: "assistant", content: [] } });
  m.onPi({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
  m.onPi({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Once upon" } });
  // Stopped: pi's stream ends aborted, its message_end has what was written.
  m.onPi({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Once upon" }], stopReason: "aborted" } });
  m.dispose();
  log.emit({ type: "item.started", item: { id: "n1", kind: "notice", status: "done", text: "Stopped.", turn: "t1", at: 0 } });
  log.emit({ type: "turn.ended", turn: "t1", status: "stopped" });
}

function seqErrorAsk(log: Log): PiMapper {
  created(log);
  log.emit({ type: "turn.started", turn: "t1", kind: "user" });
  log.emit({ type: "item.started", item: { id: "u1", kind: "user", status: "done", text: "Pick a fruit.", turn: "t1", at: 0 } });
  const m = new PiMapper({ turn: "t1", emit: (b) => log.emit(b), flushMs: 1e9 });
  for (const ev of [...assistant([{ toolCall: { id: "ask1", name: "AskUser", arguments: { question: "Apple or pear?", options: ["apple", "pear"] } } }]), toolStart("ask1", "AskUser", { question: "Apple or pear?" })]) m.onPi(ev);
  // The engine parks the turn on the question (its own item).
  log.emit({ type: "item.started", item: { id: "t1:ask:1", kind: "ask", status: "pending", question: "Apple or pear?", options: ["apple", "pear"], turn: "t1", at: 0 } });
  log.emit({ type: "item.started", item: { id: "ans1", kind: "user", status: "done", text: "pear", via: "answer", turn: "t1", at: 0 } });
  log.emit({ type: "item.completed", id: "t1:ask:1", patch: { answer: "pear" } });
  for (const ev of [toolEnd("ask1", "AskUser", "Carl answered: pear"), ...assistant([], { stopReason: "error", errorMessage: "upstream 529 overloaded" })]) m.onPi(ev);
  m.onPi({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, errorMessage: "529 overloaded" });
  m.onPi({ type: "auto_retry_end", success: false, attempt: 3, finalError: "529 overloaded" });
  m.dispose();
  log.emit({ type: "item.started", item: { id: "n1", kind: "notice", status: "done", text: "⚠️ The turn failed: upstream 529 overloaded", level: "error", turn: "t1", at: 0 } });
  log.emit({ type: "turn.ended", turn: "t1", status: "failed", error: "upstream 529 overloaded" });
  return m;
}

function seqCompactionWakeSubagent(log: Log): void {
  created(log);
  turn(log, "t1", "Train it.", [
    ...userMsg("Train it."),
    ...assistant([{ toolCall: { id: "sub1", name: "subagent", arguments: { agent: "researcher", task: "find lr" } } }]),
    toolStart("sub1", "subagent", { agent: "researcher", task: "find lr" }),
  ]);
  // The engine attaches the spawned child to its call, and lists it on the conversation.
  log.emit({ type: "item.updated", id: "sub1", patch: { subagents: ["child-1"] } });
  log.emit({ type: "subagent", threadId: "child-1", patch: { task: "find lr", state: "running" } });
  log.emit({ type: "subagent", threadId: "child-1", patch: { state: "completed", costUsd: 0.02 } });
  log.emit({ type: "cost", turn: "t1", usd: 0.0123 });
  // A wake turn later: its own item, then pi compacts and answers.
  log.emit({ type: "turn.started", turn: "t2", kind: "wake" });
  log.emit({ type: "item.started", item: { id: "w1", kind: "wake", status: "done", wake: "wake", text: "check the run", turn: "t2", at: 0 } });
  const m = new PiMapper({ turn: "t2", emit: (b) => log.emit(b), flushMs: 1e9 });
  m.expect({ kind: "prompt", text: "Wake: check the run" });
  for (const ev of [...userMsg("Wake: check the run"), ...compaction("Earlier: training started."), ...assistant([{ text: "Loss is 1.9." }])]) m.onPi(ev);
  m.dispose();
  log.emit({ type: "turn.ended", turn: "t2", status: "completed" });
}

const ALL: [string, (l: Log) => unknown][] = [
  ["text+thinking", seqTextThinking],
  ["tools", seqTools],
  ["steer+queue", seqSteerQueue],
  ["stop", seqStop],
  ["error+ask", seqErrorAsk],
  ["compaction+wake+subagent", seqCompactionWakeSubagent],
];

// ---------------------------------------------------------------- the sequences, folded

test("text and thinking deltas: streamed into one item each, pi's final text wins", () => {
  const log = new Log();
  seqTextThinking(log);
  assert.ok(log.recs.filter((r) => r.type === "item.delta").length >= 2, "deltas in the log");
  assert.deepEqual(view(log.recs), ["user:Explain the KV cache.", "thinking:The user wants the cache explained.", "assistant:The KV cache keeps keys and values per token."]);
  // Mid-stream (cut just after the first delta): the text so far, streaming.
  const cut = log.recs.findIndex((r) => r.type === "item.delta" && (r as any).id.endsWith(":1"));
  const mid = fold(log.recs.slice(0, cut + 1), C);
  const t = mid.items.find((x) => x.kind === "assistant")!;
  assert.equal(t.status, "streaming");
  assert.ok("The KV cache keeps keys and values per token.".startsWith(t.text!));
  assert.ok(mid.turn);
});

test("tool calls with streamed arguments, run in parallel: one item each, args parsed, results on them, in pi's order", () => {
  const log = new Log();
  seqTools(log);
  const p = fold(log.recs, C);
  const calls = p.items.filter((x) => x.kind === "tool");
  assert.deepEqual(calls.map((x) => [x.id, x.name, x.args, x.result, x.status]), [
    ["c1", "Read", { path: "a.md" }, "A", "done"],
    ["c2", "Read", { path: "b.md" }, "B", "done"],
  ]);
  assert.ok(log.recs.some((r) => r.type === "item.delta" && (r as any).field === "argsText"), "the arguments streamed");
  assert.deepEqual(view(log.recs), ["user:Read both papers.", "assistant:Reading both.", "tools:Read=A,Read=B", "assistant:A is better."]);
  // While c2 runs: its partial output shows; when it ends, the partial is gone.
  const at = log.recs.findIndex((r) => r.type === "item.updated" && (r as any).patch.partial);
  assert.equal(fold(log.recs.slice(0, at + 1), C).items.find((x) => x.id === "c2")!.partial, "partial b");
  assert.equal(p.items.find((x) => x.id === "c2")!.partial, undefined);
  // The live tail while both run: the two calls, after the text.
  const run = log.recs.findIndex((r) => r.type === "item.updated" && (r as any).id === "c2" && (r as any).patch.status === "running");
  const v = makeChatView()(fold(log.recs.slice(0, run + 1), C));
  assert.deepEqual(v.live.tools.map((t) => t.id), ["c1", "c2"]);
  assert.deepEqual(v.messages.map((m) => m.content), ["Read both papers.", "Reading both."]);
});

test("a steer and a queued message: pending, then Carl's message where pi delivers it, under the client's id", () => {
  const log = new Log();
  seqSteerQueue(log);
  const p = fold(log.recs, C);
  assert.deepEqual(p.pending, []);
  assert.deepEqual(view(log.recs), ["user:Go through the chapters.", "assistant:Chapter one.", "tools:Bash=ch1 ch2", "user:Shorter.", "assistant:Short then.", "user:Then summarize.", "assistant:Summary."]);
  assert.deepEqual(p.items.filter((x) => x.kind === "user").map((x) => [x.id, x.via]), [["t1-u", "chat"], ["s1", "steer"], ["q1", "queue"]]);
  // Before pi delivered them: both pending, neither in the transcript.
  const before = fold(log.recs.slice(0, log.recs.findIndex((r) => r.type === "pending.removed")), C);
  assert.deepEqual(before.pending.map((x) => [x.id, x.kind]), [["s1", "steer"], ["q1", "queue"]]);
  assert.ok(!before.items.some((x) => x.id === "s1"));
});

test("stop: what was written stays, closed as stopped; the turn ends; nothing streams forever", () => {
  const log = new Log();
  seqStop(log);
  const p = fold(log.recs, C);
  assert.equal(p.turn, null);
  assert.equal(p.lastTurn?.status, "stopped");
  assert.deepEqual(view(log.recs), ["user:Write a long essay.", "assistant:Once upon", "system:Stopped."]);
  assert.equal(p.items.find((x) => x.kind === "assistant")!.status, "stopped");
  assert.ok(!p.items.some(isOpen));
});

test("AskUser and an error: the question opens and is answered in place; the provider's error, retries and the failure are said once", () => {
  const log = new Log();
  const m = seqErrorAsk(log);
  assert.equal(m.lastError, "upstream 529 overloaded");
  const p = fold(log.recs, C);
  const ask = p.items.find((x) => x.kind === "ask")!;
  assert.deepEqual([ask.status, ask.answer], ["done", "pear"]);
  const mid = fold(log.recs.slice(0, log.recs.findIndex((r) => r.type === "item.started" && (r as any).item.id === "ans1")), C);
  assert.equal(makeChatView()(mid).waiting, true, "parked on the question: waiting, not running");
  assert.equal(p.lastTurn?.status, "failed");
  const notices = p.items.filter((x) => x.kind === "notice").map((x) => x.text);
  assert.deepEqual(notices, ["Gave up after 3 attempts: 529 overloaded", "⚠️ The turn failed: upstream 529 overloaded"]);
});

test("a compaction, a wake turn and a subagent", () => {
  const log = new Log();
  seqCompactionWakeSubagent(log);
  const p = fold(log.recs, C);
  assert.deepEqual(view(log.recs), ["user:Train it.", "tools:subagent=(stopped)", "system:⏰ check the run", "system:Earlier conversation summarized", "assistant:Loss is 1.9."]);
  assert.equal(p.items.find((x) => x.kind === "compaction")!.text, "Earlier: training started.");
  // The subagent call was cut by its turn's end (no result): closed, not running forever.
  assert.equal(p.items.find((x) => x.id === "sub1")!.status, "stopped");
  assert.deepEqual(p.items.find((x) => x.id === "sub1")!.subagents, ["child-1"]);
  assert.deepEqual(p.meta.subagents, [{ threadId: "child-1", task: "find lr", state: "completed", costUsd: 0.02 }]);
  assert.equal(p.meta.costUsd, 0.0123);
  assert.equal(p.turnCost.t1, 0.0123);
});

// ---------------------------------------------------------------- the properties

/** A seeded random (reproducible). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** All the sequences in one vault log, interleaved with another conversation and vault signals. */
function vaultLog(seed: number): LogRecord[] {
  const r = rng(seed);
  const parts: LogRecord[][] = [];
  for (const [, make] of ALL) {
    const l = new Log();
    make(l);
    parts.push(l.recs.map((x) => ({ ...x, conv: C })));
  }
  // One conversation made of all the sequences back to back (turns renamed), others interleaved.
  const mine: LogRecord[] = [];
  parts.forEach((rs, i) => {
    for (const x of rs) {
      if (i > 0 && x.type === "conv.created") continue;
      const y = JSON.parse(JSON.stringify(x).replace(/"(t[12])((?::[^"]*)?)"/g, `"$1-p${i}$2"`).replace(/"(u1|n1|c1|c2|s1|q1|ans1|ask1|sub1|w1|t1-u|t2-u)"/g, `"$1-p${i}"`));
      mine.push(y);
    }
  });
  const other: LogRecord[] = [];
  const o = new Log();
  seqTools(o);
  other.push(...o.recs.map((x) => ({ ...x, conv: "other" })));
  // Interleave with a vault-wide sequence.
  const out: LogRecord[] = [];
  let i = 0;
  let j = 0;
  let seq = 0;
  while (i < mine.length || j < other.length) {
    const pick = j >= other.length || (i < mine.length && r() < 0.7) ? mine[i++]! : other[j++]!;
    out.push({ ...pick, seq: ++seq });
    if (r() < 0.05) out.push({ seq: ++seq, conv: null, at: 0, type: "signal", signal: { type: "notif" } } as LogRecord);
  }
  return out;
}

test("a reconnect at any N, any cut, any overlap: the same picture as one uninterrupted stream", () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const all = vaultLog(seed);
    const whole = fold(all, C);
    const r = rng(seed * 31);
    // Every single cut: the head folded, then the rest.
    for (let k = 0; k <= all.length; k++) assert.deepEqual(foldInto(fold(all.slice(0, k), C), all.slice(k)), whole, `seed ${seed} cut ${k}`);
    // A client that reconnects at random cursors and gets overlapping windows (after=N replays what it had).
    for (let trial = 0; trial < 20; trial++) {
      let p = fold([], C);
      let cursor = 0;
      while (cursor < all.length) {
        const back = Math.floor(r() * Math.min(cursor, 12)); // a reconnect from an older cursor
        const from = cursor - back;
        const n = 1 + Math.floor(r() * 25);
        for (const x of all.slice(from, from + n)) p = reduce(p, x);
        cursor = Math.max(cursor, from + n);
      }
      assert.deepEqual(p, whole, `seed ${seed} trial ${trial}`);
    }
  }
});

test("nothing shown ever disappears, except by an explicit item.removed", () => {
  for (const seed of [11, 12, 13]) {
    const all = vaultLog(seed);
    // An explicit delete in the middle (the one way an item may go).
    const victim = fold(all, C).items[2]!.id;
    all.splice(Math.floor(all.length / 2), 0, { seq: 0, conv: C, at: 0, type: "item.removed", id: victim } as LogRecord);
    all.forEach((x, i) => (x.seq = i + 1));
    let p = fold([], C);
    for (const x of all) {
      const next = reduce(p, x);
      const ids = new Set(next.items.map((i) => i.id));
      for (const it of p.items) if (!ids.has(it.id)) assert.ok(x.type === "item.removed" && (x as any).id === it.id, `seed ${seed}: ${it.id} vanished at seq ${x.seq} (${x.type})`);
      // The order of what stays never changes.
      const before = p.items.map((i) => i.id).filter((id) => ids.has(id));
      assert.deepEqual(next.items.map((i) => i.id).filter((id) => before.includes(id)), before);
      p = next;
    }
  }
});

test("the list row folded from the records alone equals the full fold's row, at every record", () => {
  for (const seed of [21, 22]) {
    const all = vaultLog(seed);
    let row = emptyRow(C);
    let p = fold([], C);
    for (const x of all) {
      row = reduceRow(row, x);
      p = reduce(p, x);
      assert.deepEqual(row, rowFromPicture(p), `seed ${seed} at seq ${x.seq} (${x.type})`);
    }
  }
});

test("a checkpoint on disk is exactly the fold; a log reopened (a restart) folds to the same picture", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-convlog-"));
  try {
    const all = vaultLog(42);
    const log = new ConvLog(dir, null, path.join(dir, "events"));
    for (const x of all) log.emit(x.conv, Object.fromEntries(Object.entries(x).filter(([k]) => !["seq", "conv", "at"].includes(k))) as EventBody, x.at);
    log.checkpointNow(C);
    const ck = log.checkpointOf(C)!;
    const recs = log.eventsOf(C, 0);
    assert.deepEqual(ck.picture, JSON.parse(JSON.stringify(fold(recs.filter((r) => r.seq <= ck.seq), C))));
    // More records after the checkpoint; a new process on the same directory.
    log.emit(C, { type: "item.started", item: { id: "late", kind: "notice", status: "done", text: "after the checkpoint", at: 0 } });
    const again = new ConvLog(dir, null, path.join(dir, "events"));
    assert.deepEqual(JSON.parse(JSON.stringify(again.picture(C))), JSON.parse(JSON.stringify(fold(again.eventsOf(C, 0), C))));
    assert.equal(again.picture(C)!.items.at(-1)!.id, "late");
    assert.equal(again.latest(), log.latest(), "the sequence goes on where it was");
    // /poll after any N is exact across the restart.
    const every = again.after(0, 1e6).events;
    for (const n of [0, 1, 7, Math.floor(every.length / 2), every.length - 1]) assert.deepEqual(again.after(n, 1e6).events.map((r) => r.seq), every.filter((r) => r.seq > n).map((r) => r.seq));
    // A torn last line (a crash mid-write) is healed, never folded.
    fs.appendFileSync(path.join(dir, "events", `${C}.jsonl`), '{"seq":99999,"conv":"conv1","type":"item.sta');
    const third = new ConvLog(dir, null, path.join(dir, "events"));
    assert.equal(third.picture(C)!.items.at(-1)!.id, "late");
    third.emit(C, { type: "item.started", item: { id: "after-crash", kind: "notice", status: "done", text: "x", at: 0 } });
    const fourth = new ConvLog(dir, null, path.join(dir, "events"));
    assert.equal(fourth.picture(C)!.items.at(-1)!.id, "after-crash");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
