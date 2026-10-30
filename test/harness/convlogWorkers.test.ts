// Reader-first: production writes legacy metadata; compact records are offline fixtures only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConvLog, lastSeq } from "../../server/convlog/log.ts";
import { emptyPicture, fold, foldInto, reduce, rowFromPicture } from "../../src/convlog/reduce.ts";
import { frozenConvLog, OLD_SERVER } from "./frozenConvLog.ts";
import type { LogRecord, StoredRecord, StoredSubagentsRecord, SubagentRec } from "../../src/convlog/protocol.ts";

const C = "workers";
function fixture(run: (dir: string, log: ConvLog, file: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "vc-worker-disk-"));
  try { run(dir, new ConvLog(dir), join(dir, ".vault-chat/events", `${C}.jsonl`)); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
const disk = (file: string) => readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
function page(log: ConvLog, cursor = 0): LogRecord[] {
  const out: LogRecord[] = [];
  for (;;) {
    const answer = log.after(cursor, 7);
    assert.ok(answer.events.every((r) => r.seq > cursor));
    out.push(...answer.events);
    if (!answer.more) { assert.equal(answer.next, log.latest()); return out; }
    assert.ok(answer.next > cursor);
    cursor = answer.next;
  }
}

test("reader-first legacy writes survive frozen old SERVER; offline future deltas replay exactly", async () => {
  const OldConvLog = await frozenConvLog();
  fixture((dir, log, file) => {
    const wire: LogRecord[] = [];
    log.onRecord((r) => wire.push(r));
    log.emit(C, { type: "meta", patch: { title: "Worker history", createdAt: 10, source: "manual" } }, 10);
    let workers: SubagentRec[] = Array.from({ length: 80 }, (_, i) => ({
      threadId: `worker-${i}`, toolCallId: `call-${i}`, state: "completed", task: "task ".repeat(120),
      summary: `Retained report ${i}: ` + "report ".repeat(120), path: `/synthetic/pi/${i}`, sessionFile: `/synthetic/pi/${i}`,
    }));
    log.emit(C, { type: "meta", patch: { subagents: workers } }, 11);
    const oldPicture = log.picture(C)!;
    const oldRecord = wire.at(-1)!;
    const frozen = JSON.stringify([oldPicture, oldRecord]);
    for (let i = 0; i < 100; i++) {
      workers = workers.map((r, j) => j === 79 ? { ...r, state: i === 99 ? "completed" : "running", said: `Update ${i}` } : r);
      // Also exercise patch key order and unrelated fields.
      log.emit(C, { type: "meta", patch: { subagents: workers, costUsd: i / 100 } }, 12 + i);
      if (i === 49) log.checkpointNow(C);
    }
    assert.equal(JSON.stringify([oldPicture, oldRecord]), frozen, "no mutation of shared rows/records");
    const raw = readFileSync(file, "utf8");
    const legacy = wire.map((r) => JSON.stringify(r) + "\n").join("");
    const stored = disk(file);
    assert.ok(stored.every((r) => r.type === "meta"), "no new record types written");
    assert.equal(raw, legacy, "reader release has ZERO storage savings / legacy full metadata");
    const old = new OldConvLog(dir);
    assert.deepEqual(old.picture(C), log.picture(C), `frozen old SERVER ${OLD_SERVER} picture`);
    assert.deepEqual(old.rows(), log.rows());
    assert.equal(JSON.stringify(old.eventsOf(C)), JSON.stringify(wire));
    assert.equal(JSON.stringify(page(old)), JSON.stringify(wire));
    for (const cut of [0, 1, 2, 19, 51, 100, 102]) {
      assert.equal(JSON.stringify(page(old, cut)), JSON.stringify(wire.filter((r) => r.seq > cut)));
    }
    assert.deepEqual(old.checkpointOf(C), log.checkpointOf(C));
    assert.deepEqual(foldInto(old.checkpointOf(C)!.picture, old.eventsOf(C, old.checkpointOf(C)!.seq)), log.picture(C));
    const checkpointFile = file.replace(/\.jsonl$/, ".ckpt.json");
    const checkpoint = readFileSync(checkpointFile, "utf8");
    rmSync(checkpointFile);
    assert.deepEqual(new OldConvLog(dir).picture(C), log.picture(C), "old SERVER full replay without checkpoint");
    writeFileSync(checkpointFile, checkpoint);

    // Explicit offline future-format fixtures. Never emitted by this release.
    const compact: StoredRecord[] = wire.map((r, i) => {
      if (r.type !== "meta" || !Array.isArray(r.patch.subagents)) return r;
      return { seq: r.seq, conv: C, at: r.at, type: "subagents", base: wire[i - 1]!.seq,
        patch: { ...r.patch, subagents: null },
        updates: i === 1 ? r.patch.subagents : [r.patch.subagents[79]!],
        order: r.patch.subagents.map((row: SubagentRec) => row.threadId) };
    });
    writeFileSync(file, compact.map((r) => JSON.stringify(r) + "\n").join(""));
    assert.deepEqual(fold(compact, C), fold(wire, C));
    log = new ConvLog(dir);
    const expected = fold(wire, C);
    assert.deepEqual(log.picture(C), expected);
    assert.equal(JSON.stringify(log.eventsOf(C)), JSON.stringify(wire));
    assert.equal(JSON.stringify(page(log)), JSON.stringify(wire));
    const restarted = new ConvLog(dir);
    assert.deepEqual(restarted.picture(C), expected, "checkpoint plus changed-row tail");
    assert.deepEqual(restarted.rows(), [rowFromPicture(expected)]);
    assert.equal(JSON.stringify(page(restarted)), JSON.stringify(wire), "cold legacy consumer gets key-for-key full snapshots");
    for (const cut of [0, 1, 2, 19, 51, 100, 102]) {
      assert.equal(JSON.stringify(page(restarted, cut)), JSON.stringify(wire.filter((r) => r.seq > cut)));
      assert.deepEqual(foldInto(fold(wire.filter((r) => r.seq <= cut), C), restarted.eventsOf(C, cut)), expected);
    }
    const ck = restarted.checkpointOf(C)!;
    assert.deepEqual(foldInto(ck.picture, restarted.eventsOf(C, ck.seq)), expected);
    restarted.emit(C, { type: "meta", patch: { subagents: workers } }, 200);
    const next = restarted.latest();
    assert.ok(next > 102, "reserved cursor gap is allowed");
    assert.equal(page(restarted, 102)[0]!.seq, next);
    assert.deepEqual(new ConvLog(dir).picture(C), restarted.picture(C));
    rmSync(file.replace(/\.jsonl$/, ".ckpt.json"));
    assert.deepEqual(new ConvLog(dir).picture(C), restarted.picture(C), "no checkpoint replay");
    assert.equal(restarted.picture(C)!.meta.subagents!.length, 80);
    assert.equal(restarted.picture(C)!.meta.subagents![0]!.summary, workers[0]!.summary);
    assert.equal(restarted.picture(C)!.meta.subagents![0]!.task, workers[0]!.task);
  });
});

test("mixed legacy full snapshots and deltas preserve exact replacement, ordering, removal and completed reports", () => fixture((dir, log, file) => {
  const initial: LogRecord = { seq: 1, conv: C, at: 1, type: "meta", patch: {
    title: "Legacy", subagents: [{ threadId: "ended", state: "completed", summary: "Full old report", sessionFile: "pi/original" }],
  } };
  writeFileSync(file, JSON.stringify(initial) + "\n");
  const active: SubagentRec = { threadId: "active", state: "running" };
  const ended = initial.type === "meta" ? initial.patch.subagents![0]! : active;
  const a: LogRecord = { seq: 2, conv: C, at: 2, type: "meta", patch: { subagents: [ended, active] } };
  const b: LogRecord = { seq: 3, conv: C, at: 3, type: "meta", patch: { subagents: [active, ended] } };
  appendFileSync(file, JSON.stringify({ seq: 2, conv: C, at: 2, type: "subagents", base: 1,
    patch: { subagents: null }, updates: [active], order: ["ended", "active"] }) + "\n");
  appendFileSync(file, JSON.stringify({ seq: 3, conv: C, at: 3, type: "subagents", base: 2,
    patch: { subagents: null }, updates: [], order: ["active", "ended"] }) + "\n");
  log = new ConvLog(dir);
  const replacement: LogRecord = { seq: log.latest() + 1, conv: C, at: 4, type: "meta", patch: { subagents: [{ threadId: "ended", state: "completed", summary: "Replacement full report" }] } };
  appendFileSync(file, JSON.stringify(replacement) + "\n");
  log = new ConvLog(dir);
  const d: LogRecord = { seq: replacement.seq + 1, conv: C, at: 5, type: "meta", patch: { subagents: [] } };
  appendFileSync(file, JSON.stringify({ seq: d.seq, conv: C, at: 5, type: "subagents", base: replacement.seq,
    patch: { subagents: null }, updates: [], order: [] }) + "\n");
  log = new ConvLog(dir);
  const e = log.emit(C, { type: "meta", patch: { subagents: null } }, 6);
  const all = [initial, a, b, replacement, d, e];
  assert.equal(JSON.stringify(log.eventsOf(C)), JSON.stringify(all));
  assert.deepEqual(new ConvLog(dir).picture(C), fold(all, C));
  // The shared reducer itself folds both forms identically, not just the disk adapter.
  assert.deepEqual(fold(disk(file), C), fold(all, C));
  assert.equal((fold([initial, a, b], C).meta.subagents![1]!).summary, "Full old report");
}));

test("framed malformed/missing-base/reordered deltas fail closed; torn final append heals by existing rules", () => fixture((dir, log, file) => {
  const first = log.emit(C, { type: "meta", patch: { subagents: [{ threadId: "one", state: "completed", summary: "keep" }] } }, 1);
  const second = log.emit(C, { type: "meta", patch: { subagents: [{ threadId: "one", state: "completed", summary: "keep", said: "new" }] } }, 2);
  const original = readFileSync(file, "utf8");
  const delta: StoredSubagentsRecord = { seq: second.seq, conv: C, at: 2, type: "subagents", base: first.seq,
    patch: { subagents: null }, updates: [{ threadId: "one", state: "completed", summary: "keep", said: "new" }], order: ["one"] };
  const rows = [first, delta];
  for (const bad of [
    { ...delta, base: 99 }, { ...delta, updates: null }, { ...delta, updates: [{ summary: "missing id" }] },
    { ...delta, updates: [{ threadId: "one" }, { threadId: "one" }] },
    { ...delta, order: ["missing"] }, { ...delta, order: ["one", "one"] },
    { ...delta, order: [] }, { ...delta, patch: { subagents: [] } },
  ]) {
    writeFileSync(file, JSON.stringify(rows[0]) + "\n" + JSON.stringify(bad) + "\n");
    assert.throws(() => new ConvLog(dir), /Invalid subagents disk delta/);
    assert.throws(() => reduce(fold([first], C), bad as StoredSubagentsRecord), /Invalid subagents disk delta/);
  }
  writeFileSync(file, JSON.stringify(delta) + "\n" + JSON.stringify(rows[0]) + "\n");
  assert.throws(() => new ConvLog(dir), /Invalid subagents disk delta/);
  assert.throws(() => reduce(emptyPicture(C), delta), /Invalid subagents disk delta/);
  writeFileSync(file, original + '{"seq":3,"type":"subagents","updates":');
  const healed = new ConvLog(dir);
  assert.equal(readFileSync(file, "utf8"), original);
  assert.deepEqual(healed.picture(C), fold([first, second], C));
  healed.emit(C, { type: "meta", patch: { subagents: [{ threadId: "one", summary: "after healing", state: "completed" }] } }, 3);
  assert.deepEqual(new ConvLog(dir).picture(C), healed.picture(C));
}));

// Regression for the 44dc0048 long-tail fix interacting with checkpoint-seeded
// reader projection. All writes are disposable fixtures, never a live log.
test("over-64KB legacy and future-delta tails retain last seq and exact checkpoint replay", () => {
  for (const future of [false, true]) fixture((dir, log, file) => {
    const ended: SubagentRec = { threadId: "ended", state: "completed", task: "original task", summary: "retained report" };
    const first = log.emit(C, { type: "meta", patch: { title: "Long tail", subagents: [ended] } }, 1);
    log.checkpointNow(C);
    const ck = log.checkpointOf(C)!;
    assert.equal(ck.seq, first.seq);
    const worker = { ...ended, summary: "large completed report ".repeat(10_000) };
    const tail: LogRecord = { seq: first.seq + 1, conv: C, at: 2, type: "meta", patch: { subagents: [worker] } };
    const stored: StoredRecord = future ? { seq: tail.seq, conv: C, at: tail.at, type: "subagents", base: first.seq,
      patch: { subagents: null }, updates: [worker], order: [worker.threadId] } : tail;
    const line = JSON.stringify(stored) + "\n";
    assert.ok(Buffer.byteLength(line) > 1 << 16);
    appendFileSync(file, line);
    assert.equal(lastSeq(file), tail.seq, "must not return zero and refuse a valid checkpoint");
    const expected = fold([first, tail], C);
    const cold = new ConvLog(dir);
    assert.equal(cold.latest(), tail.seq);
    assert.deepEqual(cold.checkpointOf(C), ck, "original checkpoint is retained, not replaced");
    assert.deepEqual(cold.picture(C), expected, "checkpoint-seeded reader expands the long tail");
    assert.deepEqual(cold.eventsOf(C, ck.seq), [tail]);
    assert.deepEqual(foldInto(ck.picture, cold.eventsOf(C, ck.seq)), expected);
    assert.deepEqual(page(cold, ck.seq), [tail]);
    assert.deepEqual(page(cold), [first, tail]);
    rmSync(file.replace(/\.jsonl$/, ".ckpt.json"));
    const replay = new ConvLog(dir);
    assert.deepEqual(replay.picture(C), expected, "full replay and checkpoint plus tail agree");
    assert.deepEqual(replay.rows(), [rowFromPicture(expected)]);
    assert.equal(replay.picture(C)!.meta.subagents![0]!.task, ended.task);
    assert.equal(replay.picture(C)!.meta.subagents![0]!.summary, worker.summary);
    const next = replay.emit(C, { type: "meta", patch: { costUsd: 1 } }, 3);
    assert.ok(next.seq > tail.seq, "restart never reuses the last seq");
    assert.ok(disk(file).at(-1)!.type === "meta", "production writer stays legacy after future-format replay");
  });
});
