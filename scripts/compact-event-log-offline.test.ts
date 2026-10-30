import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { compactOffline } from "./compact-event-log-offline.ts";
import { ConvLog, lastSeq } from "../server/convlog/log.ts";
import { fold, foldInto } from "../src/convlog/reduce.ts";
import type { LogRecord, SubagentRec } from "../src/convlog/protocol.ts";

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
async function fixture(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "vc-offline-compaction-"));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("offline copy: exact every-record replay, arbitrary cursors/gaps, >64KiB tail, pi pointers/tools/reasoning retained", async () => fixture(async dir => {
  const C = "workers";
  let workers: SubagentRec[] = Array.from({ length: 175 }, (_, i) => ({ threadId: `worker-${i}`, task: "prompt ".repeat(700),
    state: "completed", summary: "retained report ".repeat(120), sessionFile: `/pi/session-${i}` }));
  const records: LogRecord[] = [{ seq: 2, conv: C, at: 1, type: "meta", patch: { title: "Preserved", subagents: workers } }];
  for (let i = 0; i < 18; i++) {
    workers = workers.map((r, j) => j === 174 ? { ...r, said: `update ${i}`, state: i === 17 ? "killed" : "running" } : r);
    records.push({ seq: 20 + i * 3, conv: C, at: 2 + i, type: "meta", patch: { subagents: workers, costUsd: i } });
  }
  records.push({ seq: 90, conv: C, at: 30, type: "live", ev: { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "retain reasoning" } } });
  records.push({ seq: 91, conv: C, at: 31, type: "live", ev: { type: "tool_execution_end", toolCallId: "caller-1", result: { text: "retain tool history" } } });
  records.push({ seq: 92, conv: C, at: 32, type: "meta", patch: { activity: "long tail ".repeat(10000) } });
  // A raw canonical pointer is preserved byte-for-byte, not resolved or re-authored.
  const pointer = { seq: 89, conv: C, at: 29, type: "entry", file: "/pi/retained.jsonl", id: "native-entry", clientId: "original-request" };
  const rawRecords = [...records.slice(0, 19), pointer, ...records.slice(19)];
  const text = rawRecords.map(r => JSON.stringify(r) + "\n").join("");
  const input = join(dir, "verified-backup.jsonl");
  await writeFile(input, text);
  const m = await compactOffline({ input, outDir: join(dir, "new-output"), sha256: sha(text), bytes: Buffer.byteLength(text) });
  assert.equal(m.records, rawRecords.length);
  assert.ok(m.output.bytes < m.input.bytes / 8);
  assert.equal(sha(await readFile(input)), m.input.sha256, "backup never modified");
  const compact = await readFile(m.output.path, "utf8");
  assert.ok(compact.includes(JSON.stringify(pointer) + "\n"));
  assert.equal(lastSeq(m.output.path), 92, "long tail keeps last seq");
  const vault = join(dir, "disposable-vault");
  const events = join(vault, ".vault-chat/events");
  await mkdir(events, { recursive: true });
  // Reuse the same pi pointer with missing target: BOTH readers have identical missing-entry behavior.
  await writeFile(join(events, `${C}.jsonl`), text);
  const old = new ConvLog(vault);
  const expected = old.picture(C)!;
  const full = old.eventsOf(C);
  old.checkpointNow(C);
  const ck = old.checkpointOf(C)!;
  await writeFile(join(events, `${C}.jsonl`), compact);
  const cold = new ConvLog(vault);
  assert.deepEqual(cold.picture(C), expected);
  assert.deepEqual(cold.eventsOf(C), full);
  for (const cursor of [0, 2, 23, 24, 66, 89, 90, 91, 92]) {
    assert.deepEqual(cold.eventsOf(C, cursor), full.filter(r => r.seq > cursor));
    let after = cursor;
    const paged = [];
    for (;;) {
      const answer = cold.after(after, 3);
      paged.push(...answer.events);
      if (!answer.more) { assert.equal(answer.next, 92); break; }
      assert.ok(answer.next > after); after = answer.next;
    }
    assert.deepEqual(paged, full.filter(r => r.seq > cursor));
    assert.deepEqual(foldInto(fold(full.filter(r => r.seq <= cursor), C), cold.eventsOf(C, cursor)), expected);
  }
  assert.deepEqual(cold.checkpointOf(C), ck);
  await rm(join(events, `${C}.ckpt.json`));
  assert.deepEqual(new ConvLog(vault).picture(C), expected);
  assert.equal(expected.meta.subagents![0]!.task, workers[0]!.task);
  const resumed = new ConvLog(vault);
  const next = resumed.emit(C, { type: "meta", patch: { costUsd: 99 } });
  assert.ok(next.seq > 92);
}));

test("offline compactor fails closed for hash/size mismatch, torn/invalid/reordered rows; never overwrites output", async () => fixture(async dir => {
  const record = JSON.stringify({ seq: 2, conv: "one", at: 1, type: "meta", patch: { title: "keep" } });
  let n = 0;
  for (const text of [record, record + "\nBAD\n", record + "\n" + record + "\n", record + "\n\n"]) {
    const input = join(dir, `bad-${n}.jsonl`); await writeFile(input, text);
    const outDir = join(dir, `bad-out-${n++}`);
    await assert.rejects(compactOffline({ input, outDir, sha256: sha(text), bytes: Buffer.byteLength(text) }));
    await assert.rejects(readFile(join(outDir, "manifest.json")));
    assert.equal(await readFile(input, "utf8"), text);
  }
  const text = record + "\n", input = join(dir, "good.jsonl"); await writeFile(input, text);
  await assert.rejects(compactOffline({ input, outDir: join(dir, "bad-size"), sha256: sha(text), bytes: 1 }));
  const badHashOut = join(dir, "bad-hash");
  await assert.rejects(compactOffline({ input, outDir: badHashOut, sha256: "0".repeat(64), bytes: Buffer.byteLength(text) }));
  await assert.rejects(readFile(join(badHashOut, "manifest.json")));
  const good = { input, outDir: join(dir, "good-out"), sha256: sha(text), bytes: Buffer.byteLength(text) };
  await compactOffline(good);
  await assert.rejects(compactOffline(good));
  assert.equal(await readFile(input, "utf8"), text);
}));

test("offline compactor refuses live .vault-chat paths", async () => fixture(async dir => {
  const live = join(dir, ".vault-chat"); await mkdir(live);
  const input = join(live, "live.jsonl"), text = "{}\n"; await writeFile(input, text);
  await assert.rejects(compactOffline({ input, outDir: join(dir, "out"), sha256: sha(text), bytes: text.length }), /Offline only/);
  assert.equal(await readFile(input, "utf8"), text);
}));
