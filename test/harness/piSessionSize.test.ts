import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConvLog } from "../../server/convlog/log.ts";
import { PiFeed } from "../../server/engine/piFeed.ts";
import { readEntries, appendEntries, SessionTail, offlineEntries, vcNote } from "../../server/convlog/piSession.ts";
import { lines, MAX_RECORD_BYTES } from "../../server/convlog/reader.ts";

function fixture(run: (root: string, dir: string, native: string) => void) {
  const root = fs.mkdtempSync(join(tmpdir(), "vc-native-size-"));
  const dir = join(root, "events"); fs.mkdirSync(dir);
  try { run(root, dir, join(root, "native.jsonl")); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// Instrument real reads, and prohibit allocating the whole native file as one string.
function observe(file: string, run: (reads: number[]) => void) {
  const ino = fs.statSync(file).ino, original = fs.readSync, whole = fs.readFileSync;
  const reads: number[] = [];
  fs.readSync = ((fd: number, b: Buffer, o: number, n: number, p: number) => {
    const got = original(fd, b, o, n, p);
    if (fs.fstatSync(fd).ino === ino) reads.push(got);
    return got;
  }) as typeof fs.readSync;
  fs.readFileSync = ((p: any, ...args: any[]) => {
    assert.notEqual(p, file, "no whole native-file read");
    return (whole as any)(p, ...args);
  }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  try { run(reads); }
  finally { fs.readSync = original; fs.readFileSync = whole; syncBuiltinESMExports(); }
}

test("native >16 MiB: checkpointed PiFeed skips all known originals, imports new entry once, unchanged sync reads zero bytes; explicit reads/append preserve chain", () => fixture((root, dir, native) => {
  const log = new ConvLog(root, null, dir);
  try {
    for (let i = 0; i < 18; i++) {
      const e = { id: `original-user-${i}`, type: "message", message: { role: "user", content: "MODEL ONLY HIDDEN CONTEXT" + "x".repeat(1024 ** 2), timestamp: i + 1 } };
      fs.appendFileSync(native, JSON.stringify(e) + "\n");
      log.emit("thread", { type: "entry", file: native, entry: e, clientId: `client-${i}`, shown: `Carl's original words ${i}` });
    }
    const answer = { id: "original-assistant", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Original answer" }], timestamp: 50 } };
    fs.appendFileSync(native, JSON.stringify(answer) + "\n");
    log.emit("thread", { type: "entry", file: native, entry: answer });
    log.checkpointNow("thread");
  } finally { log.close(); }
  assert.ok(fs.statSync(native).size > 16 * 1024 ** 2);
  const fresh = { id: "new-unpointed", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Fresh answer" }], timestamp: 51 } };
  fs.appendFileSync(native, JSON.stringify(fresh) + "\n");
  const cold = new ConvLog(root, null, dir);
  try {
    const before = cold.picture("thread")!, seq = before.seq;
    observe(native, reads => {
      const feed = new PiFeed({ file: native, pointed: cold.pointedIn("thread", native), emit: body => cold.emit("thread", body), flushMs: 0 });
      try {
        feed.sync(true);
        assert.ok(cold.picture("thread")!.seq > seq);
        assert.deepEqual(cold.picture("thread")!.items.slice(0, before.items.length), before.items);
        const events = cold.after(seq).events;
        assert.equal(events.length, 1); assert.equal((events[0] as any).entry.id, fresh.id);
        assert.doesNotMatch(JSON.stringify(cold.picture("thread")), /MODEL ONLY HIDDEN CONTEXT/);
        assert.ok(reads.length > 0); reads.length = 0;
        feed.sync(true); feed.sync(true);
        assert.deepEqual(reads, [], "unchanged native sync reads zero bytes");
        assert.equal(cold.after(seq).events.length, 1);
      } finally { feed.dispose(); }
      assert.equal(readEntries(native).length, 20);
      const appended = appendEntries(native, [vcNote({ kind: "notice", text: "first" }), vcNote({ kind: "notice", text: "second" })]);
      assert.equal(appended[0]!.parentId, fresh.id); assert.equal(appended[1]!.parentId, appended[0]!.id);
      assert.equal(readEntries(native).at(-1)!.id, appended[1]!.id);
    });
  } finally { cold.close(); }
}));

test("native single >8 MiB JSON record round-trips unchanged via full read, SessionTail and offline iterator; root keeps 8 MiB guard", () => fixture((_root, _dir, native) => {
  const body = "x".repeat(9 * 1024 ** 2); // A native plain-text JSON record larger than the root budget
  assert.ok(Buffer.byteLength(body) > MAX_RECORD_BYTES);
  const e = { id: "large-native-user", type: "message", message: { role: "user", content: body } };
  fs.writeFileSync(native, JSON.stringify(e) + "\n");
  observe(native, reads => {
    assert.equal(readEntries(native)[0]!.message!.content, body);
    const tail = new SessionTail(native);
    assert.equal(tail.read()[0]!.message!.content, body);
    reads.length = 0; assert.deepEqual(tail.read(), []); assert.deepEqual(reads, []);
    let count = 0;
    for (const entry of offlineEntries(native)) { assert.equal(entry.message!.content, body); count++; }
    assert.equal(count, 1);
    assert.throws(() => [...lines(native)], /record exceeds 8 MiB/, "default canonical-root reader budget unchanged");
    const next = { id: "unicode-partial", type: "message", message: { role: "user", content: "x".repeat(65500) + "🧠".repeat(1000) } };
    const bytes = Buffer.from(JSON.stringify(next) + "\n");
    const cut = bytes.indexOf(Buffer.from("🧠")) + 2;
    fs.appendFileSync(native, "malformed-record\n");
    fs.appendFileSync(native, bytes.subarray(0, cut));
    assert.deepEqual(tail.read(), [], "malformed record drops; partial UTF-8 entry remains unread");
    fs.appendFileSync(native, bytes.subarray(cut));
    assert.deepEqual(tail.read(), [next], "partial UTF-8 entry rereads original bytes intact");
    reads.length = 0; assert.deepEqual(tail.read(), []); assert.deepEqual(reads, []);
  });
  console.log(JSON.stringify({ nativeFixtureBytes: fs.statSync(native).size, peakRss: process.resourceUsage().maxRSS * 1024 }));
}));
