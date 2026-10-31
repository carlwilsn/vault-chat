import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { join } from "node:path";
import { ConvLog } from "../../server/convlog/log.ts";
import { MAX_RECOVERY_BYTES } from "../../server/convlog/reader.ts";
const C = "budget";
function fixture(fn: (root: string, dir: string, file: string) => void) {
  const root = fs.mkdtempSync(join(os.tmpdir(), "vc-checkpoint-budget-"));
  const dir = join(root, "events"); fs.mkdirSync(dir);
  try { fn(root, dir, join(dir, C + ".jsonl")); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function originals(log: ConvLog) {
  const file = log.ownSession(C); fs.mkdirSync(log.sessionsDir, { recursive: true });
  const user = { type: "message", id: "native-user", message: { role: "user", content: "Original user body" } };
  const assistant = { type: "message", id: "native-assistant", message: { role: "assistant", timestamp: 7, content: [{ type: "text", text: "Original assistant body" }] } };
  fs.writeFileSync(file, JSON.stringify(user) + "\n" + JSON.stringify(assistant) + "\n");
  log.emit(C, { type: "meta", patch: { title: "Original", project: "vault-chat" } });
  log.emit(C, { type: "entry", file, entry: user, clientId: "canonical-user", shown: "Original user body" });
  log.emit(C, { type: "entry", file, entry: assistant });
  return file;
}
const workerBodies = ["a".repeat(3 * 1024 ** 2), "b".repeat(3 * 1024 ** 2)];
const largeWorker = (i: number) => ({ type: "meta" as const, patch: { subagents: [{ threadId: "native-worker", state: "running", summary: workerBodies[i % 2] }] } });

test("under 400 valid large records remain crash-recoverable by checkpoint byte budget", () => fixture((root, dir, file) => {
  const writer = new ConvLog(root, null, dir);
  const session = originals(writer); const seqs: number[] = [];
  try {
    for (let i = 1; i <= 12; i++) seqs.push(writer.emit(C, largeWorker(i)).seq);
    assert.ok(fs.statSync(file).size > MAX_RECOVERY_BYTES);
    // No close/checkpoint before reopening: equivalent to the disk state at process death.
    const cold = new ConvLog(root, null, dir);
    try {
      assert.deepEqual(cold.picture(C), writer.picture(C));
      assert.equal(cold.latest(), seqs.at(-1));
      assert.deepEqual([...cold.pointedIn(C, session)].sort(), ["native-assistant", "native-user"]);
      assert.deepEqual(cold.picture(C)!.items.map((i) => [i.id, i.kind, i.text]), [["canonical-user", "user", "Original user body"], ["7:0", "assistant", "Original assistant body"]]);
      const ck = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, ".ckpt.json"), "utf8"));
      assert.ok(fs.statSync(file).size - ck.position.offset <= MAX_RECOVERY_BYTES);
      assert.ok(ck.seq < cold.latest(), "test includes an actual uncheckpointed tail");
    } finally { cold.close(); }
  } finally { writer.close(); }
}));

for (const fault of ["write", "rename"] as const) test(`failed required checkpoint ${fault} rejects risky append before bytes or committed state change, then resumes`, () => fixture((root, dir, file) => {
  const writer = new ConvLog(root, null, dir); originals(writer); writer.checkpointNow(C);
  const ckFile = file.replace(/\.jsonl$/, ".ckpt.json");
  const previousCheckpoint = fs.readFileSync(ckFile, "utf8");
  try {
    for (let i = 1; i <= 5; i++) writer.emit(C, largeWorker(i));
    const before = fs.statSync(file).size, seq = writer.latest(), picture = writer.picture(C);
    const rename = fs.renameSync;
    if (fault === "write") fs.mkdirSync(ckFile + ".tmp"); // Genuine filesystem write fault.
    else {
      fs.renameSync = ((from: any, to: any) => {
        if (to === ckFile) throw Object.assign(new Error("injected rename I/O failure"), { code: "EIO" });
        return rename(from, to);
      }) as typeof fs.renameSync;
      syncBuiltinESMExports();
    }
    try { assert.throws(() => writer.emit(C, largeWorker(6)), /checkpoint.*before append/i); }
    finally { fs.renameSync = rename; syncBuiltinESMExports(); }
    assert.equal(fs.statSync(file).size, before);
    assert.equal(writer.latest(), seq); assert.strictEqual(writer.picture(C), picture);
    assert.equal(fs.readFileSync(ckFile, "utf8"), previousCheckpoint);
    const cold = new ConvLog(root, null, dir);
    try { assert.deepEqual(cold.picture(C), picture); } finally { cold.close(); }
    if (fault === "write") fs.rmdirSync(ckFile + ".tmp");
    const next = writer.emit(C, largeWorker(6));
    assert.ok(next.seq > seq, "reservation gaps are allowed; committed seqs never go back");
    const resumed = new ConvLog(root, null, dir);
    try { assert.deepEqual(resumed.picture(C), writer.picture(C)); } finally { resumed.close(); }
  } finally { writer.close(); }
}));

test("serial external appends update the owned offset used for the pre-append checkpoint budget", () => fixture((root, dir, file) => {
  const writer = new ConvLog(root, null, dir); originals(writer); writer.checkpointNow(C);
  try {
    for (let i = 1; i <= 5; i++) {
      const seq = writer.latest() + 1;
      fs.appendFileSync(file, JSON.stringify({ seq, conv: C, at: i, ...largeWorker(i) }) + "\n");
      assert.equal(writer.latest(), seq);
    }
    writer.emit(C, largeWorker(6));
    const cold = new ConvLog(root, null, dir);
    try { assert.deepEqual(cold.picture(C), writer.picture(C)); } finally { cold.close(); }
  } finally { writer.close(); }
}));

after(() => {
  const peak = process.resourceUsage().maxRSS * 1024;
  console.log(JSON.stringify({ checkpointBudgetPeakRssBytes: peak }));
  assert.ok(peak < 256 * 1024 ** 2, "synthetic regression stays below 256 MiB peak RSS");
});
