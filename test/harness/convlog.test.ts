// The one reducer (src/convlog/reduce.ts) on what the box's feed holds for pi's
// own sessions: pi's session entries (pointers to its file) and pi's live
// events for the message in flight, recorded by the engine's feed
// (server/engine/piFeed.ts) while a simulated pi (./piSim.ts) writes its file
// as pi does. Sequences: text and thinking deltas, tool calls with streamed
// arguments, parallel calls, a steer and a queued message delivered mid-run, a
// stop, a crash mid-stream, an error, AskUser, a compaction, a wake, a
// subagent. Then the properties every client relies on: any cut and any
// replay of overlapping windows (a reconnect at any N) folds to the same
// picture as one uninterrupted stream; nothing shown ever disappears; the list
// row folded alone equals the full fold's; a checkpoint equals the fold, and a
// feed reopened from disk (its pointers read back from pi's files) folds to the
// same picture.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConvLog } from "../../server/convlog/log.ts";
import { assistant, toolStart, toolEnd, toolUpdate, userMsg, compaction } from "../../server/test/fakePi.ts";
import type { EventBody, LogRecord, PendingInput } from "../../src/convlog/protocol.ts";
import { emptyRow, fold, foldInto, isOpen, pendingOf, reduce, reduceRow, rowFromPicture, shown } from "../../src/convlog/reduce.ts";
import { makeChatView, messagesOf } from "../../src/convlog/view.ts";
import { PiSim } from "./piSim.ts";

const C = "conv1";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "vc-convlog-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** A tiny box: records with a vault-wide sequence, and the engine's fields. */
class Log {
  recs: LogRecord[] = [];
  seq = 0;
  at = 1_000;
  pending: PendingInput[] = [];
  readonly sim: PiSim;
  constructor(readonly pfx = "") {
    this.sim = new PiSim(TMP, (b) => this.emit(b));
  }
  id = (x: string) => `${this.pfx}${x}`;
  emit = (b: EventBody, conv: string | null = C): void => {
    this.recs.push({ seq: ++this.seq, conv, at: (this.at += 10), ...b } as LogRecord);
  };
  meta(patch: Record<string, unknown>): void {
    this.emit({ type: "meta", patch });
  }
  setPending(add?: PendingInput, remove?: string): void {
    this.pending = this.pending.filter((x) => x.id !== remove);
    if (add) this.pending.push(add);
    this.meta({ pending: this.pending.length ? this.pending : null });
  }
}

/** One turn as the engine runs it: running, Carl's input expected back from pi, pi's events through the feed, the end. */
function turn(log: Log, id: string, userText: string, piEvents: any[], o: { kind?: string; via?: string; shown?: string; expect?: { kind: "steer" | "queue"; id: string; text: string }[]; flushMs?: number; end?: boolean } = {}) {
  const turnId = log.id(id);
  log.meta({ running: { turn: turnId, kind: o.kind ?? "user", startedAt: log.at } });
  const feed = log.sim.open({ flushMs: o.flushMs, delivered: (cid) => log.setPending(undefined, cid) });
  feed.expect({ kind: "prompt", text: userText, shown: o.shown ?? userText, via: o.via ?? "chat", ...(o.kind && o.kind !== "user" ? {} : { clientId: log.id(`${id}-u`) }) });
  for (const e of o.expect ?? []) {
    log.setPending({ id: log.id(e.id), kind: e.kind, text: e.text, at: log.at });
    feed.expect({ kind: e.kind, text: e.text, shown: e.text, via: e.kind, clientId: log.id(e.id) });
  }
  log.sim.play(piEvents);
  log.sim.close();
  if (o.end !== false) log.meta({ running: null, pending: null });
  return feed;
}

const view = (recs: LogRecord[]) => messagesOf(fold(recs, C)).map((m) => (m.toolCalls ? `tools:${m.toolCalls.map((t) => `${t.name}=${t.result ?? "…"}`).join(",")}` : m.thinking ? `thinking:${m.thinking}` : `${m.system ? "system" : m.role}:${m.content}`));

function created(log: Log): void {
  log.meta({ title: "New chat", source: "manual", createdAt: log.at });
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
    ...assistant([{ text: "Reading both." }, { toolCall: { id: log.id("c1"), name: "read", arguments: { path: "a.md" } } }, { toolCall: { id: log.id("c2"), name: "read", arguments: { path: "b.md" } } }], { chunks: 4 }),
    toolStart(log.id("c1"), "read", { path: "a.md" }),
    toolStart(log.id("c2"), "read", { path: "b.md" }),
    toolUpdate(log.id("c2"), "read", "partial b"),
    toolEnd(log.id("c2"), "read", "B"),
    toolEnd(log.id("c1"), "read", "A"),
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
      ...assistant([{ text: "Chapter one." }, { toolCall: { id: log.id("c1"), name: "bash", arguments: { command: "ls" } } }]),
      toolStart(log.id("c1"), "bash", { command: "ls" }),
      toolEnd(log.id("c1"), "bash", "ch1 ch2"),
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
  turn(
    log,
    "t1",
    "Write a long essay.",
    [
      ...userMsg("Write a long essay."),
      { type: "message_start", message: { role: "assistant", content: [] } },
      { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Once upon" } },
      // Stopped: pi's stream ends aborted, its message_end has what was written.
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Once upon" }], stopReason: "aborted" } },
    ],
    { end: false },
  );
  log.meta({ running: null, pending: null });
  log.sim.note({ kind: "notice", text: "Stopped.", level: "info" });
}

/** pi dies mid-stream (a crash): nothing more from it; the next boot ends the turn. */
function seqCrash(log: Log): void {
  created(log);
  turn(
    log,
    "t1",
    "Count to ten.",
    [
      ...userMsg("Count to ten."),
      { type: "message_start", message: { role: "assistant", content: [] } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Counting." } },
      { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 1 } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "One, two, three" } },
    ],
    { end: false },
  );
  // The next boot: the turn ends (what was in flight stays, closed), then the line saying why.
  log.meta({ running: null, pending: null });
  log.sim.note({ kind: "notice", text: "⚠️ Interrupted by a restart.", level: "error" });
}

function seqErrorAsk(log: Log) {
  created(log);
  const ask = log.id("ask1");
  log.meta({ running: { turn: log.id("t1"), kind: "user", startedAt: log.at } });
  const feed = log.sim.open();
  feed.expect({ kind: "prompt", text: "Pick a fruit.", shown: "Pick a fruit.", via: "chat", clientId: log.id("u1") });
  log.sim.play([...userMsg("Pick a fruit."), ...assistant([{ toolCall: { id: ask, name: "AskUser", arguments: { question: "Apple or pear?", options: ["apple", "pear"] } } }]), toolStart(ask, "AskUser", { question: "Apple or pear?", options: ["apple", "pear"] })]);
  // The engine parks the turn on the question; Carl answers under his client's id.
  log.meta({ asking: { question: "Apple or pear?", options: ["apple", "pear"], at: log.at }, state: "waiting_user" });
  feed.answered(log.id("ans1"));
  log.meta({ asking: null, state: "running" });
  log.sim.play([toolEnd(ask, "AskUser", "Carl answered: pear"), ...assistant([], { stopReason: "error", errorMessage: "upstream 529 overloaded" })]);
  log.sim.play([{ type: "auto_retry_start", attempt: 1, maxAttempts: 3, errorMessage: "529 overloaded" }, { type: "auto_retry_end", success: false, attempt: 3, finalError: "529 overloaded" }]);
  log.sim.close();
  log.meta({ running: null, pending: null, state: "idle" });
  return feed;
}

function seqCompactionWakeSubagent(log: Log): void {
  created(log);
  const sub = log.id("sub1");
  const child = log.id("child-1");
  turn(log, "t1", "Train it.", [...userMsg("Train it."), ...assistant([{ toolCall: { id: sub, name: "subagent", arguments: { agent: "researcher", task: "find lr" } } }]), toolStart(sub, "subagent", { agent: "researcher", task: "find lr" })], { end: false });
  // The engine lists the spawned child on the conversation, on the call that spawned it.
  log.meta({ subagents: [{ threadId: child, toolCallId: sub, task: "find lr", state: "running" }] });
  log.meta({ running: null, pending: null });
  log.meta({ subagents: [{ threadId: child, toolCallId: sub, task: "find lr", state: "completed", costUsd: 0.02 }], costUsd: 0.0123 });
  // A wake turn later: pi compacts and answers.
  turn(log, "t2", "Wake: check the run", [...userMsg("Wake: check the run"), ...compaction("Earlier: training started."), ...assistant([{ text: "Loss is 1.9." }])], { kind: "wake", via: "wake", shown: "check the run" });
}

const ALL: [string, (l: Log) => unknown][] = [
  ["text+thinking", seqTextThinking],
  ["tools", seqTools],
  ["steer+queue", seqSteerQueue],
  ["stop", seqStop],
  ["crash", seqCrash],
  ["error+ask", seqErrorAsk],
  ["compaction+wake+subagent", seqCompactionWakeSubagent],
];

const lives = (recs: LogRecord[], t: string) => recs.filter((r) => r.type === "live" && r.ev?.assistantMessageEvent?.type === t);

// ---------------------------------------------------------------- the sequences, folded

test("text and thinking deltas: streamed into one item each, then pi's entry for good", () => {
  const log = new Log();
  seqTextThinking(log);
  assert.ok(lives(log.recs, "text_delta").length >= 2, "deltas in the feed");
  assert.deepEqual(view(log.recs), ["user:Explain the KV cache.", "thinking:The user wants the cache explained.", "assistant:The KV cache keeps keys and values per token."]);
  // Mid-stream (cut just after the first text delta): the text so far, streaming.
  const cut = log.recs.indexOf(lives(log.recs, "text_delta")[0]!);
  const mid = fold(log.recs.slice(0, cut + 1), C);
  const t = shown(mid).find((x) => x.kind === "assistant")!;
  assert.equal(t.status, "streaming");
  assert.ok("The KV cache keeps keys and values per token.".startsWith(t.text!));
  assert.ok(mid.meta.running);
  // The entry takes the place of what was in flight: the same item (same id), nothing doubled.
  const p = fold(log.recs, C);
  assert.equal(p.inflight.length, 0);
  assert.equal(p.items.filter((x) => x.kind === "assistant").length, 1);
});

test("the feed coalesces deltas: a few records a second, never one per token", () => {
  const log = new Log();
  created(log);
  turn(log, "t1", "Long one.", [...userMsg("Long one."), ...assistant([{ text: "x".repeat(400) }], { chunks: 100 })], { flushMs: 1e9 });
  assert.equal(lives(log.recs, "text_delta").length, 1, "100 deltas in one record (the next event flushed it)");
  assert.equal(lives(log.recs, "text_delta")[0]!.ev.assistantMessageEvent.delta, "x".repeat(400));
  assert.deepEqual(view(log.recs), ["user:Long one.", `assistant:${"x".repeat(400)}`]);
  // pi wrote the message before its message_end reached the feed: the end is not repeated.
  assert.equal(log.recs.filter((r) => r.type === "live" && r.ev.type === "message_end").length, 0);
});

test("tool calls with streamed arguments, run in parallel: one item each, args parsed, results on them, in pi's order", () => {
  const log = new Log();
  seqTools(log);
  const p = fold(log.recs, C);
  const calls = p.items.filter((x) => x.kind === "tool");
  assert.deepEqual(calls.map((x) => [x.id, x.name, x.args, x.result, x.status]), [
    ["c1", "read", { path: "a.md" }, "A", "done"],
    ["c2", "read", { path: "b.md" }, "B", "done"],
  ]);
  assert.ok(lives(log.recs, "toolcall_delta").length >= 2, "the arguments streamed");
  // "Reading both." was written beside the tool calls: progress commentary, shown under Thought, never as the reply.
  assert.deepEqual(view(log.recs), ["user:Read both papers.", "thinking:Reading both.", "tools:Read=A,Read=B", "assistant:A is better."]);
  // While c2 runs: its partial output shows; when it ends, the partial is gone.
  const at = log.recs.findIndex((r) => r.type === "live" && r.ev.type === "tool_execution_update");
  assert.equal(fold(log.recs.slice(0, at + 1), C).items.find((x) => x.id === "c2")!.partial, "partial b");
  assert.equal(p.items.find((x) => x.id === "c2")!.partial, undefined);
  assert.equal(makeChatView()(fold(log.recs.slice(0, at + 1), C)).live.tools.find((x) => x.id === "c2")!.partial, "partial b");
  assert.ok(makeChatView()(p).live.tools.every((x) => x.partial === undefined));
  // The live tail while both run: the two calls, after the text.
  const run = log.recs.findIndex((r) => r.type === "live" && r.ev.type === "tool_execution_start" && r.ev.toolCallId === "c2");
  const v = makeChatView()(fold(log.recs.slice(0, run + 1), C));
  assert.deepEqual(v.live.tools.map((t) => t.id), ["c1", "c2"]);
  assert.deepEqual(v.messages.map((m) => m.content || `thinking:${m.thinking}`), ["Read both papers.", "thinking:Reading both."]);
  // The moment the message reaches for a tool, what it wrote so far leaves the reply (before pi writes it).
  const tc = log.recs.findIndex((r) => r.type === "live" && r.ev.type === "message_update" && r.ev.assistantMessageEvent?.type === "toolcall_start");
  const atTool = makeChatView()(fold(log.recs.slice(0, tc + 1), C));
  assert.equal(atTool.live.text, "");
  assert.equal(shown(fold(log.recs.slice(0, tc + 1), C)).find((x) => x.text === "Reading both.")?.kind, "thinking");
});

test("a steer and a queued message: pending, then Carl's message where pi delivers it, under the client's id", () => {
  const log = new Log();
  seqSteerQueue(log);
  const p = fold(log.recs, C);
  assert.deepEqual(pendingOf(p), []);
  assert.deepEqual(view(log.recs), ["user:Go through the chapters.", "thinking:Chapter one.", "tools:Bash=ch1 ch2", "user:Shorter.", "assistant:Short then.", "user:Then summarize.", "assistant:Summary."]);
  assert.deepEqual(p.items.filter((x) => x.kind === "user").map((x) => [x.id, x.via]), [["t1-u", "chat"], ["s1", "steer"], ["q1", "queue"]]);
  // Before pi delivered them: both pending, neither in the transcript.
  const firstSteer = log.recs.findIndex((r) => r.type === "entry" && r.clientId === "s1");
  const before = fold(log.recs.slice(0, firstSteer), C);
  assert.deepEqual(pendingOf(before).map((x) => [x.id, x.kind]), [["s1", "steer"], ["q1", "queue"]]);
  assert.ok(!before.items.some((x) => x.id === "s1"));
  // Delivered: the steer's chip goes in the same breath as its line appears.
  const after = fold(log.recs.slice(0, firstSteer + 2), C);
  assert.deepEqual(pendingOf(after).map((x) => x.id), ["q1"]);
});

test("stop: what was written stays, closed as stopped; the turn ends; nothing streams forever", () => {
  const log = new Log();
  seqStop(log);
  const p = fold(log.recs, C);
  assert.equal(p.meta.running, undefined);
  assert.deepEqual(view(log.recs), ["user:Write a long essay.", "assistant:Once upon", "system:Stopped."]);
  assert.equal(p.items.find((x) => x.kind === "assistant")!.status, "stopped");
  assert.ok(!shown(p).some(isOpen));
});

test("a crash mid-stream: what was shown stays (the feed kept pi's live events), closed; the restart's line after it", () => {
  const log = new Log();
  seqCrash(log);
  const p = fold(log.recs, C);
  assert.deepEqual(view(log.recs), ["user:Count to ten.", "thinking:Counting.", "assistant:One, two, three", "system:⚠️ Interrupted by a restart."]);
  assert.ok(!shown(p).some(isOpen));
  assert.deepEqual(
    p.items.filter((x) => x.kind === "assistant" || x.kind === "thinking").map((x) => x.status),
    ["stopped", "stopped"],
  );
});

test("AskUser and an error: the question waits, Carl's answer is his line under his id; the provider's error is said once", () => {
  const log = new Log();
  const feed = seqErrorAsk(log);
  assert.equal(feed.lastError, "upstream 529 overloaded");
  const p = fold(log.recs, C);
  assert.deepEqual(view(log.recs), ["user:Pick a fruit.", "tools:AskUser=Carl answered: pear", "assistant:**❓ Apple or pear?**\n\n1. apple\n2. pear", "user:pear", "system:Couldn't get a reply: upstream 529 overloaded"]);
  const ans = p.items.find((x) => x.id === "ans1")!;
  assert.deepEqual([ans.kind, ans.via, ans.text], ["user", "answer", "pear"]);
  const mid = fold(log.recs.slice(0, log.recs.findIndex((r) => r.type === "meta" && r.patch.asking === null)), C);
  assert.equal(makeChatView()(mid).waiting, true, "parked on the question: waiting, not running");
  assert.equal(p.items.filter((x) => x.kind === "notice").length, 1);
  assert.ok(!shown(p).some(isOpen));
});

test("a compaction, a wake turn and a subagent", () => {
  const log = new Log();
  seqCompactionWakeSubagent(log);
  const p = fold(log.recs, C);
  assert.deepEqual(view(log.recs), ["user:Train it.", "tools:subagent=(stopped)", "system:⏰ check the run", "system:Earlier conversation summarized", "assistant:Loss is 1.9."]);
  assert.equal(p.items.find((x) => x.kind === "compaction")!.text, "Earlier: training started.");
  // The subagent call was cut by its turn's end (no result): closed, not running forever.
  assert.equal(p.items.find((x) => x.id === "sub1")!.status, "stopped");
  assert.deepEqual(messagesOf(p).find((m) => m.toolCalls)!.toolCalls![0]!.subagents, ["child-1"]);
  assert.equal(p.meta.costUsd, 0.0123);
  // The title came from Carl's first message, never from the wake.
  assert.equal(p.meta.title, "Train it.");
});

// ---------------------------------------------------------------- the properties

/** A seeded random (reproducible). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** All the sequences in one vault feed (one conversation, back to back), interleaved with another conversation and vault signals. */
function vaultLog(seed: number): LogRecord[] {
  const r = rng(seed);
  const mine: LogRecord[] = [];
  ALL.forEach(([, make], i) => {
    const l = new Log(i ? `p${i}-` : "");
    make(l);
    mine.push(...l.recs.filter((_x, k) => !(i > 0 && k === 0)));
  });
  const o = new Log("o-");
  seqTools(o);
  const other = o.recs.map((x) => ({ ...x, conv: "other" }));
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
    for (let k = 0; k <= all.length; k++) assert.deepEqual(foldInto(fold(all.slice(0, k), C), all.slice(k)), whole, `seed ${seed} cut ${k}`);
    for (let trial = 0; trial < 20; trial++) {
      let p = fold([], C);
      let cursor = 0;
      while (cursor < all.length) {
        const back = Math.floor(r() * Math.min(cursor, 12));
        const from = cursor - back;
        const n = 1 + Math.floor(r() * 25);
        for (const x of all.slice(from, from + n)) p = reduce(p, x);
        cursor = Math.max(cursor, from + n);
      }
      assert.deepEqual(p, whole, `seed ${seed} trial ${trial}`);
    }
  }
});

test("nothing shown ever disappears (only pi's own passing status lines: a retry, 'summarizing'), and what stays keeps its order", () => {
  const passing = (id: string) => id.startsWith("retry:") || id.startsWith("compacting:");
  for (const seed of [11, 12, 13]) {
    const all = vaultLog(seed);
    let p = fold([], C);
    for (const x of all) {
      const next = reduce(p, x);
      const ids = new Set(shown(next).map((i) => i.id));
      for (const it of shown(p)) if (!ids.has(it.id)) assert.ok(passing(it.id), `seed ${seed}: ${it.id} vanished at seq ${x.seq} (${x.type})`);
      const before = shown(p).map((i) => i.id).filter((id) => ids.has(id));
      assert.deepEqual(shown(next).map((i) => i.id).filter((id) => before.includes(id)), before, `seed ${seed}: order changed at seq ${x.seq}`);
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

test("on disk an entry record is only a pointer; a checkpoint is exactly the fold; a feed reopened (a restart) reads pi's files back to the same picture", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-feed-"));
  try {
    const all = vaultLog(42);
    const log = new ConvLog(dir, null, path.join(dir, "events"));
    for (const x of all) log.emit(x.conv, Object.fromEntries(Object.entries(x).filter(([k]) => !["seq", "conv", "at"].includes(k))) as EventBody, x.at);
    // The transcript stays in pi's files: the feed's lines point into them.
    const lines = fs.readFileSync(path.join(dir, "events", `${C}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const entries = lines.filter((l) => l.type === "entry");
    assert.ok(entries.length > 20);
    assert.ok(entries.every((l) => typeof l.file === "string" && typeof l.id === "string" && !("entry" in l)), "pointers only");
    log.checkpointNow(C);
    const ck = log.checkpointOf(C)!;
    const recs = log.eventsOf(C, 0);
    assert.deepEqual(ck.picture, JSON.parse(JSON.stringify(fold(recs.filter((r) => r.seq <= ck.seq), C))));
    const every0 = log.after(0, 1e6).events;
    // More after the checkpoint; then a new process on the same directory.
    const sim = new PiSim(path.join(dir, "sessions"), (b) => log.emit(C, b));
    sim.note({ kind: "notice", text: "after the checkpoint", clientId: "late" });
    const again = new ConvLog(dir, null, path.join(dir, "events"));
    assert.deepEqual(JSON.parse(JSON.stringify(again.picture(C))), JSON.parse(JSON.stringify(fold(again.eventsOf(C, 0), C))));
    assert.deepEqual(JSON.parse(JSON.stringify(again.picture(C))), JSON.parse(JSON.stringify(log.picture(C))), "the same picture after the restart");
    assert.equal(again.picture(C)!.items.at(-1)!.id, "late");
    assert.equal(again.latest(), log.latest(), "the sequence goes on where it was");
    // Every record a client was handed before the restart comes back the same, key for key.
    assert.equal(JSON.stringify(again.after(0, 1e6).events.slice(0, every0.length)), JSON.stringify(every0));
    // /poll after any N is exact across the restart, entries resolved from pi's files.
    const every = again.after(0, 1e6).events;
    assert.ok(every.every((r) => r.type !== "entry" || r.entry.type !== "missing"));
    for (const n of [0, 1, 7, Math.floor(every.length / 2), every.length - 1]) assert.deepEqual(again.after(n, 1e6).events.map((r) => r.seq), every.filter((r) => r.seq > n).map((r) => r.seq));
    // A torn last line (a crash mid-write) is healed, never folded.
    fs.appendFileSync(path.join(dir, "events", `${C}.jsonl`), '{"seq":99999,"conv":"conv1","type":"me');
    const third = new ConvLog(dir, null, path.join(dir, "events"));
    assert.equal(third.picture(C)!.items.at(-1)!.id, "late");
    new PiSim(path.join(dir, "sessions"), (b) => third.emit(C, b)).note({ kind: "notice", text: "x", clientId: "after-crash" });
    const fourth = new ConvLog(dir, null, path.join(dir, "events"));
    assert.equal(fourth.picture(C)!.items.at(-1)!.id, "after-crash");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- a real pi recording

test("a real pi 1.1.0 recording (3 turns on the box: thinking, 9 shell/read calls, a steer, a queued follow-up): every block and call pi stored, in pi's order, Carl's under his ids", () => {
  // Recorded on the box's throwaway instance (VC_PI_RECORD); every letter and digit
  // of the content replaced by "x" (no vault content), structure, ids and timestamps intact.
  const evs = fs.readFileSync(path.join(import.meta.dirname, "fixtures", "pi-real-3turns.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const runs: any[][] = [[]];
  for (const e of evs) {
    runs.at(-1)!.push(e);
    if (e.type === "agent_settled") runs.push([]);
  }
  runs.pop();
  assert.equal(runs.length, 3);
  const log = new Log();
  created(log);
  const textOfMsg = (m: any) => (typeof m.content === "string" ? m.content : m.content.map((c: any) => c.text ?? "").join("\n"));
  const userTexts = (run: any[]) => run.filter((e) => e.type === "message_start" && e.message?.role === "user").map((e) => textOfMsg(e.message));
  runs.forEach((run, i) => {
    const [prompt, ...later] = userTexts(run);
    // Turn 2 had a steer, turn 3 a queued follow-up: what the engine expected pi to deliver.
    const expect = later.map((text, j) => ({ kind: (i === 1 ? "steer" : "queue") as "steer" | "queue", id: `carl-${i}-${j}`, text }));
    turn(log, `t${i + 1}`, prompt!, run, { expect, flushMs: 1e9 });
  });
  const p = fold(log.recs, C);
  const ends = evs.filter((e) => e.type === "message_end" && e.message?.role === "assistant").map((e) => e.message);
  const piText = ends.flatMap((m: any) => m.content.filter((c: any) => c.type === "text" && c.text.trim()).map((c: any) => c.text));
  const piThinking = ends.flatMap((m: any) => m.content.filter((c: any) => c.type === "thinking" && c.thinking.trim()).map((c: any) => c.thinking));
  const piCalls = ends.flatMap((m: any) => m.content.filter((c: any) => c.type === "toolCall").map((c: any) => c.id));
  assert.deepEqual(p.items.filter((x) => x.kind === "assistant" && x.text?.trim()).map((x) => x.text), piText);
  assert.deepEqual(p.items.filter((x) => x.kind === "thinking" && x.text?.trim()).map((x) => x.text), piThinking);
  assert.deepEqual(p.items.filter((x) => x.kind === "tool").map((x) => x.id), piCalls);
  assert.equal(piCalls.length, 9);
  assert.ok(p.items.filter((x) => x.kind === "tool").every((x) => x.status === "done" && typeof x.result === "string"));
  assert.ok(lives(log.recs, "toolcall_delta").length > 0, "arguments streamed");
  assert.deepEqual(p.items.filter((x) => x.kind === "user").map((x) => [x.id, x.via]), [["t1-u", "chat"], ["t2-u", "chat"], ["carl-1-0", "steer"], ["t3-u", "chat"], ["carl-2-0", "queue"]]);
  assert.deepEqual(pendingOf(p), []);
  assert.ok(!shown(p).some(isOpen));
  assert.equal(p.inflight.length, 0);
  // pi's entries in its file, one pointer each: every shown entry of the session, once.
  const pointers = log.recs.filter((r) => r.type === "entry");
  assert.equal(new Set(pointers.map((r) => r.type === "entry" && r.entry.id)).size, pointers.length);
  for (let k = 0; k <= log.recs.length; k += 3) assert.deepEqual(foldInto(fold(log.recs.slice(0, k), C), log.recs.slice(k)), p);
});
