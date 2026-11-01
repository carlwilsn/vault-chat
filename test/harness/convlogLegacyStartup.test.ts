import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { join } from "node:path";
import { ConvLog } from "../../server/convlog/log.ts";
import { MAX_RECOVERY_BYTES, position } from "../../server/convlog/reader.ts";
import { foldInto, REDUCER_VERSION } from "../../src/convlog/reduce.ts";
const C = "legacy";
function fixture(fn: (root: string, dir: string, file: string, session: string, base: any) => void) {
  const root = fs.mkdtempSync(join(os.tmpdir(), "vc-legacy-startup-")), dir = join(root, "events");
  const writer = new ConvLog(root, null, dir), file = join(dir, C + ".jsonl");
  const session = writer.ownSession(C); fs.mkdirSync(writer.sessionsDir, { recursive: true });
  const entry = { type: "message", id: "original", message: { role: "user", content: "Original user body" } };
  fs.writeFileSync(session, JSON.stringify(entry) + "\n");
  writer.emit(C, { type: "meta", patch: { title: "Original", project: "vault-chat" } });
  writer.emit(C, { type: "entry", file: session, entry, clientId: "original-client" });
  const base = writer.picture(C)!; writer.close();
  try { fn(root, dir, file, session, base); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function legacyCheckpoint(file: string, picture: any) {
  fs.writeFileSync(file.replace(/\.jsonl$/, ".ckpt.json"), JSON.stringify({ v: 2, rv: REDUCER_VERSION, seq: picture.seq, picture }));
}
function tail(file: string, base: any) {
  let picture = base;
  for (let i = 1; i <= 48; i++) {
    const rec = { seq: base.seq + i, conv: C, at: i, type: "meta" as const,
      patch: { subagents: [{ threadId: "worker", state: "running", summary: String(i) + "x".repeat(768 * 1024) }] } };
    fs.appendFileSync(file, JSON.stringify(rec) + "\n"); picture = foldInto(picture, [rec]);
  }
  return picture;
}

test("old writer can outgrow the 16 MiB window before release: stream exact legacy replay and all pointers", () => fixture((root, dir, file, session, base) => {
  legacyCheckpoint(file, base);
  const expected = tail(file, base); assert.ok(fs.statSync(file).size > MAX_RECOVERY_BYTES * 2);
  const original = fs.readFileSync;
  fs.readFileSync = ((p: any, ...args: any[]) => { assert.notEqual(p, file, "no whole-log allocation"); return (original as any)(p, ...args); }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  let cold: ConvLog | undefined;
  try {
    cold = new ConvLog(root, null, dir);
    assert.deepEqual(cold.picture(C), expected);
    assert.deepEqual([...cold.pointedIn(C, session)], ["original"]);
    assert.equal(cold.after(0).reset, true, "trimmed replay cache must request full checkpoint");
    assert.equal(JSON.parse(original(file.replace(/\.jsonl$/, ".ckpt.json"), "utf8")).v, 2, "read-only boot does not migrate files");
    // Ordinary first append must commit a positioned checkpoint BEFORE extending
    // an already-large recovery tail; no live compaction or log replacement.
    const before = fs.statSync(file), prefix = original(file);
    cold.emit(C, { type: "meta", patch: { title: "Next" } });
    const ck = JSON.parse(original(file.replace(/\.jsonl$/, ".ckpt.json"), "utf8"));
    assert.equal(ck.v, 3); assert.equal(ck.position.offset, before.size);
    assert.deepEqual(ck.pointed["sessions/legacy.jsonl"], ["original"]);
    assert.equal(fs.statSync(file).ino, before.ino);
    assert.deepEqual(original(file).subarray(0, before.size), prefix, "original log bytes untouched");
    const reopened = new ConvLog(root, null, dir);
    try { assert.deepEqual(reopened.picture(C), cold.picture(C)); assert.deepEqual([...reopened.pointedIn(C, session)], ["original"]); }
    finally { reopened.close(); }
  } finally { cold?.close(); fs.readFileSync = original; syncBuiltinESMExports(); }
}));

test("legacy checkpoint near the tail still rebuilds the complete large-root pointer index", () => fixture((root, dir, file, session, base) => {
  legacyCheckpoint(file, tail(file, base));
  const cold = new ConvLog(root, null, dir);
  try {
    // Checkpoint itself must rebuild the index, without a prior pointedIn call.
    cold.checkpointNow(C);
    assert.deepEqual([...cold.pointedIn(C, session)], ["original"]);
    const ck = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, ".ckpt.json"), "utf8"));
    assert.equal(ck.v, 3); assert.deepEqual(ck.pointed["sessions/legacy.jsonl"], ["original"]);
  } finally { cold.close(); }
}));

test("positioned checkpoint keeps strict tail budget; absent legacy boundary still fails closed", () => fixture((root, dir, file, _session, base) => {
  const ckFile = file.replace(/\.jsonl$/, ".ckpt.json");
  fs.writeFileSync(ckFile, JSON.stringify({ v: 3, rv: REDUCER_VERSION, seq: base.seq, picture: base, pointed: {}, position: position(file, fs.statSync(file).size, base.seq) }));
  tail(file, base);
  assert.throws(() => new ConvLog(root, null, dir), /checkpoint tail exceeds 16 MiB/);
  legacyCheckpoint(file, { ...base, seq: base.seq + 1000 });
  assert.throws(() => new ConvLog(root, null, dir), /legacy checkpoint sequence is absent/);
}));
