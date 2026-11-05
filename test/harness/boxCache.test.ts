import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeBoxCache, CACHE_MAX_BYTES, type CacheFile } from "../../src/boxCache.ts";
import { emptyPicture, emptyRow } from "../../src/convlog/reduce.ts";

function fixture(): CacheFile {
  return { epoch: "owned-fixture", cursor: 42, rows: [emptyRow("active"), emptyRow("other")], pictures: [emptyPicture("active"), emptyPicture("other")] };
}

test("warm cache retains complete pictures, rows and their exact cursor without mutating live data", () => {
  const file = fixture();
  const before = structuredClone(file);
  assert.deepEqual(JSON.parse(encodeBoxCache(file)!), file);
  assert.deepEqual(file, before);
});

test("a huge active tool result is refused BEFORE encoding it or walking its later worker state", () => {
  const file = fixture();
  let laterReads = 0;
  Object.assign(file.pictures[0]!, { ownedHugeResult: "x".repeat(20_000_000) });
  Object.defineProperty(file.pictures[0], "laterWorkerState", { enumerable: true, get() { laterReads++; return "must not visit"; } });
  assert.equal(encodeBoxCache(file), null);
  assert.equal(laterReads, 0, "bounded traversal, not serialize-then-check");
  assert.equal(file.cursor, 42);
  assert.equal((file.pictures[0] as any).ownedHugeResult.length, 20_000_000, "no history truncation");
});

test("oversized inactive history leaves the active picture whole and each picture encoded at most once", () => {
  const file = fixture();
  let activeReads = 0;
  Object.defineProperty(file.pictures[0], "ownedText", { enumerable: true, get() { activeReads++; return "keep exactly"; } });
  Object.assign(file.pictures[1]!, { ownedHugeResult: "x".repeat(20_000_000) });
  const body = encodeBoxCache(file)!;
  assert.ok(body.length <= CACHE_MAX_BYTES);
  assert.equal(activeReads, 1);
  const saved = JSON.parse(body);
  assert.equal(saved.pictures.length, 1);
  assert.equal(saved.pictures[0].ownedText, "keep exactly");
  assert.deepEqual(saved.rows, file.rows);
  assert.equal(saved.cursor, 42);
  assert.equal(file.pictures.length, 2);
});

test("escaped strings cannot produce an over-budget cache and oversized rows do not discard the old snapshot", () => {
  const file = fixture();
  Object.assign(file.pictures[0]!, { ownedText: "\u0000".repeat(600_000) });
  assert.equal(encodeBoxCache(file), null);
  Object.assign(file.rows[0]!, { title: "x".repeat(20_000_000) });
  assert.equal(encodeBoxCache(file), null);
});

test("3819-item / 1329-message cache: legacy retries encode the same large history twelve times; bounded cache never does", () => {
  // Representative folded shape, not preview data or a substitute for real-A.
  const active = emptyPicture("active");
  active.seq = 3819;
  active.items = Array.from({ length: 3819 }, (_, n) => n < 1329
    ? { id: `human-${n}`, kind: n % 2 ? "assistant" as const : "user" as const, status: "done" as const, at: n, text: "original human body ".repeat(20) }
    : { id: `tool-${n}`, kind: "tool" as const, status: "done" as const, at: n, name: "read", args: { path: "owned.md", context: "retained tool arguments ".repeat(180) }, result: "bounded result" });
  let historyReads = 0;
  Object.defineProperty(active, "inflight", { enumerable: true, get() { historyReads++; return []; } });
  const file: CacheFile = { epoch: "realistic-owned", cursor: 123456, rows: [emptyRow("active")], pictures: [active, ...Array.from({ length: 11 }, (_, n) => emptyPicture(`inactive-${n}`))] };
  const legacy = { ...file, pictures: file.pictures.slice() };
  let oldBody = JSON.stringify(legacy);
  while (oldBody.length > CACHE_MAX_BYTES && legacy.pictures.length > 1) {
    legacy.pictures.pop();
    oldBody = JSON.stringify(legacy);
  }
  assert.ok(oldBody.length > 10_000_000, "legacy still writes an over-quota active snapshot");
  assert.equal(historyReads, 12, "deterministic repeated full-history traversal in the old algorithm");
  historyReads = 0;
  assert.equal(encodeBoxCache(file), null, "refuse the optional cache, never trim the live history");
  assert.equal(historyReads, 0, "the byte budget stops traversal before the later picture fields");
  assert.equal(file.pictures.length, 12);
  assert.equal(active.items.length, 3819);
  assert.equal(active.items.filter(x => x.kind === "user" || x.kind === "assistant").length, 1329);
  assert.equal(active.items[1329]!.args.context.length, 4320);
  assert.equal(file.cursor, 123456);
});
