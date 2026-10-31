import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { join } from "node:path";
import { ConvLog } from "../../server/convlog/log.ts";
import { constants as bufferConstants } from "node:buffer";
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
test("checkpoint state over 16 MiB loads complete native bodies and pointer index without log prefix reads", () => fixture((root, dir, file) => {
  const writer = new ConvLog(root, null, dir); const session = originals(writer);
  const body = "z".repeat(3 * 1024 ** 2);
  try {
    for (let i = 0; i < 6; i++) {
      const entry = { type: "message", id: `large-native-${i}`, message: { role: "assistant", timestamp: 20 + i, content: [{ type: "text", text: body }] } };
      fs.appendFileSync(session, JSON.stringify(entry) + "\n");
      writer.emit(C, { type: "entry", file: session, entry });
    }
    writer.checkpointNow(C);
    const ckFile = file.replace(/\.jsonl$/, ".ckpt.json");
    assert.ok(fs.statSync(ckFile).size > MAX_RECOVERY_BYTES);
    const boundary = fs.statSync(file).size;
    writer.emit(C, { type: "meta", patch: { state: "stopping" } });
    const read = fs.readSync, whole = fs.readFileSync, ino = fs.statSync(file).ino;
    let bytes = 0;
    fs.readSync = ((fd: number, b: Buffer, o: number, n: number, p: number) => {
      if (fs.fstatSync(fd).ino === ino) { assert.ok(p >= boundary, "zero prefix reads"); bytes += n; }
      return read(fd, b, o, n, p);
    }) as typeof fs.readSync;
    fs.readFileSync = ((p: any, ...args: any[]) => { assert.notEqual(p, file); return (whole as any)(p, ...args); }) as typeof fs.readFileSync;
    syncBuiltinESMExports();
    try {
      const cold = new ConvLog(root, null, dir);
      try {
        const picture = cold.picture(C)!;
        assert.equal(picture.items.length, 8);
        assert.equal(picture.meta.state, "stopping");
        for (let i = 0; i < 6; i++) assert.equal(picture.items[i + 2]!.text, body);
        assert.deepEqual([...cold.pointedIn(C, session)].sort(), ["native-user", "native-assistant", ...Array.from({ length: 6 }, (_, i) => `large-native-${i}`)].sort());
        assert.ok(bytes > 0 && bytes < 1024);
      } finally { cold.close(); }
    } finally { fs.readSync = read; fs.readFileSync = whole; syncBuiltinESMExports(); }
  } finally { writer.close(); }
}));

test("checkpoint decoder ceiling fails actionably without allocating the checkpoint or reading history", () => fixture((root, dir, file) => {
  fs.writeFileSync(file, '{"seq":1,"conv":"budget","at":1,"type":"meta","patch":{}}\n');
  const ckFile = file.replace(/\.jsonl$/, ".ckpt.json");
  const fd = fs.openSync(ckFile, "w");
  fs.ftruncateSync(fd, bufferConstants.MAX_STRING_LENGTH + 1); fs.closeSync(fd);
  const whole = fs.readFileSync;
  fs.readFileSync = ((p: any, ...args: any[]) => {
    assert.notEqual(p, file); assert.notEqual(p, ckFile, "reject before allocating an unrepresentable string");
    return (whole as any)(p, ...args);
  }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  try { assert.throws(() => new ConvLog(root, null, dir), /checkpoint exceeds the Node.js string decoding limit/); }
  finally { fs.readFileSync = whole; syncBuiltinESMExports(); }
}));

after(() => {
  const peak = process.resourceUsage().maxRSS * 1024;
  console.log(JSON.stringify({ checkpointStatePeakRssBytes: peak }));
  assert.ok(peak < 256 * 1024 ** 2, "synthetic regression stays below 256 MiB peak RSS");
});
