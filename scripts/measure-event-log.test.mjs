import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measureEventLog } from './measure-event-log.mjs';

async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'vc-event-log-stats-'));
  try { await fn(join(dir, 'events.jsonl')); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
const record = (seq, patch) => ({ seq, conv: 'fixture', at: seq, type: 'meta', patch });
const jsonl = (records) => records.map((r) => JSON.stringify(r) + '\n').join('');

test('80-worker snapshot corpus isolates amplification without dumping row contents', () => fixture(async (file) => {
  const rows = Array.from({ length: 80 }, (_, i) => ({ threadId: `worker-${i}`, task: 'PRIVATE_TASK'.repeat(40), summary: 'PRIVATE_REPORT'.repeat(30), activity: 'running' }));
  const records = [record(1, { subagents: structuredClone(rows) })];
  for (let i = 0; i < 100; i++) {
    rows[i % rows.length].activity = `step-${i}`;
    records.push(record(i + 2, { subagents: structuredClone(rows) }));
  }
  records.push(record(102, { subagents: rows })); // Exactly unchanged: not the dominant cause.
  const input = jsonl(records);
  await writeFile(file, input);
  const r = await measureEventLog(file);
  assert.equal(r.completeLines, 102);
  assert.equal(r.subagents.snapshots, 102);
  assert.equal(r.subagents.rows, 8160);
  assert.equal(r.subagents.changedRows, 180);
  assert.equal(r.subagents.identicalSnapshots, 1);
  assert.ok(r.subagents.bytes > r.subagents.changedRowsBytes * 40);
  assert.equal(r.inlineImageStringChars, 0);
  assert.equal(r.kinds.meta.bytes, Buffer.byteLength(input));
  assert.ok(!JSON.stringify(r).includes('PRIVATE_'));
  assert.equal(await readFile(file, 'utf8'), input);
}));

test('fixed byte cut excludes concurrent appends and preserves LF-only framing', () => fixture(async (file) => {
  const input = jsonl([record(1, { title: 'line\u2028separator\u2029stays inside JSON' })]);
  await writeFile(file, input);
  const r = await measureEventLog(file, { onCut: () => appendFile(file, jsonl([record(2, {})])) });
  assert.equal(r.completeLines, 1);
  assert.equal(r.cutBytes, Buffer.byteLength(input));
  assert.ok(r.endStat.bytes > r.cutBytes);
  assert.equal(r.maxSeq, 1);
}));

test('large inline media is counted, never copied to output; malformed/torn lines stay diagnostic', () => fixture(async (file) => {
  const data = 'SENSITIVE_MEDIA'.repeat(150_000);
  const input = jsonl([{ seq: 1, type: 'entry', images: [{ path: 'fixture.png', dataUrl: data }] }]) + 'invalid\n' + '{"seq":2';
  await writeFile(file, input);
  const r = await measureEventLog(file);
  assert.equal(r.inlineImageStringChars, data.length);
  assert.equal(r.invalidLines, 1);
  assert.equal(r.trailingBytes, 8);
  assert.ok(!JSON.stringify(r).includes('SENSITIVE_MEDIA'));
  assert.equal(r.stringFields['$.images[].dataUrl'].bytes, Buffer.byteLength(JSON.stringify(data)));
}));

test('bounds oversized lines, accepts empty files, masks unrecognized schema names/values', () => fixture(async (file) => {
  await writeFile(file, '');
  assert.equal((await measureEventLog(file)).completeLines, 0);
  await writeFile(file, jsonl([{ type: 'DO_NOT_PRINT', PRIVATE_KEY_NAME: 'PRIVATE_VALUE' }, record(2, { title: 'x'.repeat(1000) }), record(3, {})]));
  const r = await measureEventLog(file, { maxLineBytes: 100 });
  assert.equal(r.oversizedLines, 1);
  assert.equal(r.completeLines, 2);
  assert.ok(!JSON.stringify(r).includes('PRIVATE'));
  assert.ok(!JSON.stringify(r).includes('DO_NOT_PRINT'));
}));
