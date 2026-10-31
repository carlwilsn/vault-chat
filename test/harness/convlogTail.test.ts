import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { join } from "node:path";
import { ConvLog, GlobalFeed, lastSeq } from "../../server/convlog/log.ts";
import { position, MAX_RECORD_BYTES } from "../../server/convlog/reader.ts";
import { emptyPicture, fold, foldInto, REDUCER_VERSION, pendingOf } from "../../src/convlog/reduce.ts";
import type { LogRecord, StoredRecord } from "../../src/convlog/protocol.ts";
const C = "project-vault-chat";
function fixture(fn: (root: string, dir: string, file: string) => void) {
  const root = fs.mkdtempSync(join(os.tmpdir(), "vc-byte-tail-"));
  const dir = join(root, "events"); fs.mkdirSync(dir);
  try { fn(root, dir, join(dir, C + ".jsonl")); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}
const meta = (seq: number, patch: Record<string, unknown>): LogRecord => ({ seq, conv: C, at: 10000 - seq, type: "meta", patch });
function checkpoint(file: string, offset: number, picture: ReturnType<typeof emptyPicture>, v = 3) {
  fs.writeFileSync(file.replace(/\.jsonl$/, ".ckpt.json"), JSON.stringify({ v, rv: REDUCER_VERSION,
    seq: picture.seq, picture, ...(v === 3 ? { position: position(file, offset, picture.seq), pointed: {} } : {}) }));
}
/** Instrument real filesystem calls, not a fake history or mocked reader. */
function observe(file: string, fn: (reads: { at: number; bytes: number }[]) => void) {
  const ino = fs.statSync(file).ino;
  const original = fs.readSync, originalWhole = fs.readFileSync;
  const reads: { at: number; bytes: number }[] = [];
  fs.readSync = ((fd: number, b: Buffer, o: number, n: number, p: number) => {
    const got = original(fd, b, o, n, p);
    if (fs.fstatSync(fd).ino === ino) reads.push({ at: p, bytes: got });
    return got;
  }) as typeof fs.readSync;
  fs.readFileSync = ((p: any, ...args: any[]) => {
    assert.notEqual(p, file, "never whole-file-read the log");
    return (originalWhole as any)(p, ...args);
  }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  try { fn(reads); }
  finally { fs.readSync = original; fs.readFileSync = originalWhole; syncBuiltinESMExports(); }
}

test("5 GiB sparse prefix: startup and repeated polls read ZERO prefix bytes; appends consume only new tail", () => fixture((root, dir, file) => {
  const offset = 5 * 1024 ** 3 + 123;
  const first = meta(1001, { title: "Canonical root", source: "manual", createdAt: 1,
    subagents: [{ threadId: "completed", summary: "original report", state: "completed" }] });
  const base = fold([first], C);
  const fd = fs.openSync(file, "w");
  fs.ftruncateSync(fd, offset);
  const firstBytes = Buffer.from(JSON.stringify(first) + "\n");
  fs.writeSync(fd, Buffer.from("\n"), 0, 1, offset - firstBytes.length - 1);
  fs.writeSync(fd, firstBytes, 0, firstBytes.length, offset - firstBytes.length); fs.closeSync(fd);
  checkpoint(file, offset, base);
  const tail: StoredRecord = { seq: 1002, conv: C, at: 1, type: "subagents", base: 1001,
    patch: { subagents: null }, updates: [{ threadId: "completed", state: "completed", summary: "🧠".repeat(40000) }], order: ["completed"] };
  const wireTail = JSON.stringify(tail) + "\n"; fs.appendFileSync(file, wireTail);
  observe(file, (reads) => {
    const start = performance.now();
    const log = new ConvLog(root, null, dir);
    assert.deepEqual(log.picture(C), foldInto(base, [tail]));
    assert.equal(log.latest(), 1002);
    assert.ok(reads.length > 0 && reads.every((r) => r.at >= offset), "not even checkpoint boundary is reread");
    const bytes = reads.reduce((n, r) => n + r.bytes, 0);
    assert.ok(bytes <= Buffer.byteLength(wireTail) * 2);
    reads.length = 0;
    for (let i = 0; i < 20; i++) {
      assert.equal(log.eventsOf(C, 1001).length, 1);
      assert.equal(log.after(1001).events.length, 1);
      assert.equal(log.after(1002).events.length, 0);
    }
    assert.equal(reads.length, 0, "unchanged polls do not read any log bytes");
    const oldEnd = fs.statSync(file).size;
    const next = meta(1003, { state: "stopping", project: "vault-chat" });
    fs.appendFileSync(file, JSON.stringify(next) + "\n");
    assert.deepEqual(log.eventsOf(C, 1002), [next]);
    assert.ok(reads.every((r) => r.at >= oldEnd));
    reads.length = 0;
    assert.deepEqual(log.after(1002).events, [next]);
    assert.equal(reads.length, 0);
    assert.equal(new GlobalFeed(() => log, () => [log]).after(0).reset, true, "global poll must propagate checkpoint resets");
    assert.equal(log.after(0).reset, true, "old cursors request a checkpoint, never silently omit history");
    assert.throws(() => log.eventsOf(C, 0), /reload the conversation checkpoint/);
    assert.ok(process.resourceUsage().maxRSS * 1024 < 256 * 1024 ** 2, "sparse prefix must not drive resident memory");
    console.log(JSON.stringify({ syntheticSparseBytes: offset, startupReadBytes: bytes, prefixReadBytes: 0,
      unchangedPollReadBytes: 0, elapsedMs: Math.round(performance.now() - start), rss: process.memoryUsage().rss, peakRss: process.resourceUsage().maxRSS * 1024 }));
  });
  assert.equal(lastSeq(file), 1003);
}));

test("legacy sequence-only checkpoint migrates by bounded suffix lookup, not prefix fold", () => fixture((root, dir, file) => {
  const first = meta(10, { title: "Migrated" }); const offset = 600 * 1024 ** 2;
  const fd = fs.openSync(file, "w"); fs.ftruncateSync(fd, offset);
  const b = Buffer.from("\n" + JSON.stringify(first) + "\n"); fs.writeSync(fd, b, 0, b.length, offset - b.length); fs.closeSync(fd);
  checkpoint(file, offset, fold([first], C), 2);
  fs.appendFileSync(file, JSON.stringify(meta(11, { state: "stopped" })) + "\n");
  observe(file, (reads) => {
    const log = new ConvLog(root, null, dir); assert.equal(log.latest(), 11);
    assert.equal(log.picture(C)!.meta.state, "stopped", "checkpoint tail must not disappear on whole-file read failure");
    assert.ok(reads.every((r) => r.at >= offset - 16 * 1024 ** 2));
    reads.length = 0; log.eventsOf(C, 10); log.after(10); assert.equal(reads.length, 0);
  });
  const before = fs.readFileSync(file.replace(/\.jsonl$/, ".ckpt.json"), "utf8");
  assert.equal(JSON.parse(before).v, 2, "read-only boot never rewrites legacy checkpoint");
}));

test("missing/incompatible/stale/rotated checkpoint fails actionable without prefix replay", () => fixture((root, dir, file) => {
  const fd = fs.openSync(file, "w"); fs.ftruncateSync(fd, 5 * 1024 ** 3); fs.closeSync(fd);
  observe(file, (reads) => { assert.throws(() => new ConvLog(root, null, dir), /checkpoint required/); assert.equal(reads.length, 0); });
  const first = meta(10, { title: "Root" }); fs.writeFileSync(file, JSON.stringify(first) + "\n");
  checkpoint(file, fs.statSync(file).size, fold([first], C));
  const ckFile = file.replace(/\.jsonl$/, ".ckpt.json"); const ck = JSON.parse(fs.readFileSync(ckFile, "utf8"));
  ck.position.seq++; fs.writeFileSync(ckFile, JSON.stringify(ck));
  assert.throws(() => new ConvLog(root, null, dir), /sequence.*mismatch/);
  checkpoint(file, fs.statSync(file).size, fold([first], C));
  fs.renameSync(file, file + ".old"); fs.writeFileSync(file, JSON.stringify(first) + "\n");
  assert.throws(() => new ConvLog(root, null, dir), /identity/);
  fs.renameSync(file + ".old", file); fs.truncateSync(file, 1);
  assert.throws(() => new ConvLog(root, null, dir), /identity\/size/);
}));

test("original roles/body/IDs and FIFO pending survive checkpoint, unicode split, partial append and worker delta", () => fixture((root, dir, file) => {
  const session = join(root, "pi.jsonl");
  const user = { type: "message", id: "pi-user", message: { role: "user", content: "[Carl, on his laptop]\nhidden context\nOriginal exact user body" } };
  const assistant = { type: "message", id: "pi-answer", message: { role: "assistant", timestamp: 5, content: [{ type: "text", text: "Original assistant reply" }] } };
  fs.writeFileSync(session, JSON.stringify(user) + "\n" + JSON.stringify(assistant) + "\n");
  const log = new ConvLog(root, null, dir);
  log.emit(C, { type: "meta", patch: { title: "Root", createdAt: 1, project: "vault-chat" } });
  log.emit(C, { type: "entry", file: session, entry: user, clientId: "canonical-client", shown: "Original exact user body", device: "laptop", via: "chat" });
  log.emit(C, { type: "entry", file: session, entry: assistant });
  const queue = [1, 2, 3].map((i) => ({ id: `q${i}`, kind: "queue" as const, text: `Input ${i}`, at: 10 - i }));
  log.emit(C, { type: "meta", patch: { pending: queue, subagents: [{ threadId: "worker", state: "running" }] } });
  log.checkpointNow(C);
  const cold = new ConvLog(root, null, dir);
  assert.deepEqual(cold.picture(C), log.picture(C));
  assert.deepEqual(pendingOf(cold.picture(C)!).map((p) => p.id), ["q1", "q2", "q3"]);
  assert.deepEqual(cold.picture(C)!.items.map((i) => [i.id, i.kind, i.text]), [["canonical-client", "user", "Original exact user body"], ["5:0", "assistant", "Original assistant reply"]]);
  assert.deepEqual([...cold.pointedIn(C, session)].sort(), ["pi-answer", "pi-user"]);
  let seq = cold.latest();
  for (let i = 0; i < queue.length; i++) {
    const r = meta(++seq, { pending: queue.slice(i + 1) });
    fs.appendFileSync(file, JSON.stringify(r) + "\n");
    assert.deepEqual(pendingOf(cold.picture(C)!).map((p) => p.id), queue.slice(i + 1).map((p) => p.id));
  }
  const unicode = meta(++seq, { title: "a".repeat(65500) + "🧠".repeat(1000) });
  const bytes = Buffer.from(JSON.stringify(unicode) + "\n"); const cut = bytes.indexOf(Buffer.from("🧠")) + 2;
  fs.appendFileSync(file, bytes.subarray(0, cut)); const stable = cold.picture(C);
  assert.equal(cold.latest(), seq - 1, "incomplete UTF8/line is not committed");
  fs.appendFileSync(file, bytes.subarray(cut)); assert.equal(cold.picture(C)!.meta.title, (unicode as any).patch.title);
  assert.notDeepEqual(cold.picture(C), stable);
  const events = cold.eventsOf(C); assert.ok(events.every((r, i) => !i || r.seq > events[i - 1]!.seq));
  assert.deepEqual(fold(events, C), cold.picture(C));
  cold.checkpointNow(C); assert.deepEqual(new ConvLog(root, null, dir).picture(C), cold.picture(C));
}));

test("oversized new record fails explicitly; no giant string and no silent history loss", () => fixture((root, dir, file) => {
  const first = meta(1, { title: "Root" }); fs.writeFileSync(file, JSON.stringify(first) + "\n");
  checkpoint(file, fs.statSync(file).size, fold([first], C));
  fs.appendFileSync(file, Buffer.alloc(MAX_RECORD_BYTES + 1, 120));
  assert.throws(() => new ConvLog(root, null, dir), /record exceeds 8 MiB/);
}));

test("partial crash checkpoint commits exact complete-byte offset and pointer metadata atomically", () => fixture((root, dir, file) => {
  const log = new ConvLog(root, null, dir);
  const first = log.emit(C, { type: "meta", patch: { title: "Original", sessionFrom: { file: "canonical", seq: 9 }, cleared: { at: 1, id: "clear-id" } } });
  const completeSize = fs.statSync(file).size;
  fs.appendFileSync(file, '{"seq":9999,"conv":"project-vault-chat","type":');
  log.checkpointNow(C);
  const ckFile = file.replace(/\.jsonl$/, ".ckpt.json");
  const ck = JSON.parse(fs.readFileSync(ckFile, "utf8"));
  assert.equal(ck.position.offset, completeSize); assert.equal(ck.position.seq, ck.picture.seq); assert.equal(ck.seq, first.seq);
  assert.deepEqual(ck.picture.meta.sessionFrom, { file: "canonical", seq: 9 });
  assert.deepEqual(ck.picture.meta.cleared, { at: 1, id: "clear-id" });
  fs.writeFileSync(ckFile + ".tmp", '{"v":3,"seq":99999');
  const cold = new ConvLog(root, null, dir); assert.equal(cold.latest(), first.seq);
  const next = cold.emit(C, { type: "meta", patch: { state: "stopped" } });
  const final = new ConvLog(root, null, dir); assert.equal(final.latest(), next.seq);
  assert.deepEqual(final.eventsOf(C), [first, next]);
}));

test("bounded large-session pointer lookup preserves original shown/body and never hides an out-of-window entry", () => fixture((root, dir, file) => {
  const session = join(root, "pi-large.jsonl"); const prefix = 600 * 1024 ** 2;
  const fd = fs.openSync(session, "w"); fs.ftruncateSync(fd, prefix); fs.writeSync(fd, Buffer.from("\n"), 0, 1, prefix - 1); fs.closeSync(fd);
  const entry = { type: "message", id: "native-user", message: { role: "user", content: "[Carl, on his laptop]\nNative prompt" } };
  fs.appendFileSync(session, JSON.stringify(entry) + "\n");
  const first = meta(100, { title: "Root" }); fs.writeFileSync(file, JSON.stringify(first) + "\n");
  checkpoint(file, fs.statSync(file).size, fold([first], C));
  fs.appendFileSync(file, JSON.stringify({ seq: 101, conv: C, at: 2, type: "entry", file: session, id: entry.id,
    shown: "Exact original text", clientId: "canonical-id", via: "queue", device: "laptop" }) + "\n");
  const cold = new ConvLog(root, null, dir);
  assert.deepEqual(cold.picture(C)!.items.map((i) => [i.id, i.text]), [["canonical-id", "Exact original text"]]);
  fs.appendFileSync(file, JSON.stringify({ seq: 102, conv: C, at: 3, type: "entry", file: session, id: "outside-window" }) + "\n");
  assert.throws(() => cold.picture(C), /entry pointer is outside the bounded session suffix/, "cannot replace original assistant with an invisible missing-entry fallback for an unsearched huge session");
}));

test("multiple conversations retain global seq order and root owner/project through stop and queue delivery", () => fixture((root, dir) => {
  const log = new ConvLog(root, null, dir); const events: LogRecord[] = [];
  events.push(log.emit(C, { type: "meta", patch: { project: "vault-chat", owner: "original-owner", running: { turn: "t", kind: "user", startedAt: 1 } } }, 100));
  events.push(log.emit("another", { type: "meta", patch: { title: "Other conversation" } }, 90));
  const pending = ["one", "two", "three"].map((id, i) => ({ id, text: id, kind: "queue" as const, at: 30 - i }));
  events.push(log.emit(C, { type: "meta", patch: { pending } }, 80)); log.checkpointNow(C); log.checkpointNow("another");
  const seq = log.latest(); const cold = new ConvLog(root, null, dir);
  events.push(cold.emit("another", { type: "meta", patch: { state: "stopping" } }, 70));
  events.push(cold.emit(C, { type: "meta", patch: { state: "stopping", pending: pending.slice(1) } }, 60));
  events.push(cold.emit(C, { type: "meta", patch: { running: null, state: "stopped", pending: pending.slice(2) } }, 50));
  const received: LogRecord[] = []; let cursor = seq;
  for (;;) { const answer = cold.after(cursor, 1); received.push(...answer.events); cursor = answer.next; if (!answer.more) break; }
  assert.deepEqual(received, events.filter((e) => e.seq > seq));
  assert.ok(received.every((r, i) => !i || r.seq > received[i - 1]!.seq));
  assert.deepEqual(cold.picture(C)!.meta.pending, pending.slice(2));
  assert.equal(cold.picture(C)!.meta.owner, "original-owner"); assert.equal(cold.picture(C)!.meta.project, "vault-chat");
  assert.deepEqual(new ConvLog(root, null, dir).picture(C), cold.picture(C));
}));
