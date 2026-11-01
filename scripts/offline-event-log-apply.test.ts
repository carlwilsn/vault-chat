import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, stat, appendFile, unlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareOffline, type PrepareOptions, type Stage } from "./offline-event-log.ts";
import { completePrepared } from "./event-log-offline-cohort.ts";
import { ConvLog } from "../server/convlog/log.ts";
import { acquireEventDirectory } from "../server/convlog/maintenance.ts";
import { PiFeed } from "../server/engine/piFeed.ts";
import { readEntries } from "../server/convlog/piSession.ts";
import { REDUCER_VERSION } from "../src/convlog/reduce.ts";
import { identity } from "./event-log-stream.ts";

const stopped = async () => {};
async function fixture(run: (o: PrepareOptions, vault: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "vc-offline-apply-"));
  const vault = join(root, "vault"), eventsDir = join(vault, ".vault-chat", "events"), backupsRoot = join(root, "backups");
  await mkdir(eventsDir, { recursive: true }); await mkdir(backupsRoot);
  try { await run({ source: join(eventsDir, "thread.jsonl"), eventsDir, backupsRoot, idleMs: 1, mode: "apply" }, vault); }
  finally { await rm(root, { recursive: true, force: true }); }
}
async function seed(o: PrepareOptions, vault: string, legacy = false) {
  const native = join(o.eventsDir, "native.session");
  const entries = [
    { id: "native-original-user", type: "message", message: { role: "user", content: "MODEL ONLY HIDDEN CONTEXT plus user", timestamp: 10 } },
    { id: "native-original-assistant", type: "message", message: { role: "assistant", content: [{ type: "text", text: "original assistant body" }], timestamp: 11 } },
  ];
  await writeFile(native, entries.map(e => JSON.stringify(e) + "\n").join(""));
  const workers = [{ threadId: "worker", task: "𐐀 café 🧪".repeat(10000), state: "completed", summary: "original summary", providerseq: 123 }];
  const records = [
    { seq: 7, conv: "thread", at: 50, type: "meta", patch: { title: "original", cleared: { at: 5, id: "original-clear" }, sessionFrom: { file: "native.session", after: "original-clear-boundary" }, subagents: workers } },
    { seq: 10, conv: "thread", at: 40, type: "entry", file: "native.session", id: entries[0]!.id, shown: "only Carl's shown words", clientId: "original-client", device: "phone", via: "chat" },
    { seq: 17, conv: "thread", at: 30, type: "entry", file: "native.session", id: entries[1]!.id },
    { seq: 29, conv: "thread", at: 20, type: "meta", patch: { subagents: workers, running: false } },
  ];
  const text = records.map(r => JSON.stringify(r) + "\n").join("");
  await writeFile(o.source, text);
  const log = new ConvLog(vault); const expected = log.picture("thread")!; log.close();
  if (legacy) {
    const ck = { v: 2, rv: REDUCER_VERSION, seq: expected.seq, picture: expected };
    await writeFile(o.source.replace(/\.jsonl$/, ".ckpt.json"), JSON.stringify(ck));
  } else {
    const cold = new ConvLog(vault); cold.checkpointNow("thread"); cold.close();
  }
  return { text, expected, native, entries };
}
async function intent(o: PrepareOptions) {
  const names = await readdir(o.backupsRoot); assert.equal(names.length, 1);
  return join(o.backupsRoot, names[0]!, "intent.json");
}

test("ordinary apply: verified dynamic original backup, same-FS candidate inode/EOF checkpoint, restart/poll preserves shown/native IDs", async () => fixture(async (o, vault) => {
  const { text, expected, native, entries } = await seed(o, vault);
  const old = await stat(o.source);
  let candidateInode = 0;
  const result = await prepareOffline(o, { assertStopped: stopped, onStage: async (stage, dir) => {
    if (stage === "before-log-rename") {
      const m = JSON.parse(await readFile(join(dir!, "intent.json"), "utf8"));
      candidateInode = (await stat(m.log.path)).ino;
      assert.notEqual(candidateInode, old.ino);
      assert.throws(() => new ConvLog(vault), /shared lock unavailable/);
      assert.equal(await readFile(m.backup.path, "utf8"), text);
      assert.equal(m.checkpointNew.identity.ino, (await stat(m.checkpointNew.path)).ino);
    }
  } });
  assert.equal(result.installed, true); assert.equal(result.writerExcluded, true);
  assert.equal((await stat(o.source)).ino, candidateInode);
  const ck = JSON.parse(await readFile(result.checkpoint, "utf8"));
  assert.equal(ck.v, 3); assert.equal(ck.position.ino, candidateInode); assert.equal(ck.position.offset, (await stat(o.source)).size);
  assert.deepEqual(ck.pointed, { "native.session": entries.map(e => e.id) });
  const cold = new ConvLog(vault);
  try {
    assert.deepEqual(cold.picture("thread"), expected);
    const beforeSeq = cold.picture("thread")!.seq;
    const feed = new PiFeed({ file: native, pointed: cold.pointedIn("thread", native), emit: body => cold.emit("thread", body), flushMs: 0 });
    try { feed.sync(true); } finally { feed.dispose(); }
    assert.equal(cold.picture("thread")!.seq, beforeSeq, "no old model-only context reimport");
    assert.deepEqual(cold.after(beforeSeq).events, []);
    assert.match(JSON.stringify(cold.picture("thread")!.items), /only Carl's shown words/);
    assert.doesNotMatch(JSON.stringify(cold.picture("thread")!.items), /MODEL ONLY HIDDEN CONTEXT/);
  } finally { cold.close(); }
  await completePrepared(await intent(o), { assertStopped: stopped }); // idempotent before any new writes
}));

test("checkpoint-only independently migrates v2 to complete v3 without changing a single original byte/inode", async () => fixture(async (o, vault) => {
  const { text, expected, native, entries } = await seed(o, vault, true);
  const before = identity(await stat(o.source));
  const result = await prepareOffline({ ...o, mode: "checkpoint-only" }, { assertStopped: stopped });
  assert.equal(result.installed, true); assert.equal(await readFile(o.source, "utf8"), text);
  assert.deepEqual(identity(await stat(o.source)), before);
  const ck = JSON.parse(await readFile(result.checkpoint, "utf8"));
  assert.deepEqual(ck.picture, expected);
  assert.deepEqual(ck.picture.meta.sessionFrom, { file: "native.session", after: "original-clear-boundary" });
  assert.deepEqual(ck.picture.meta.cleared, { at: 5, id: "original-clear" });
  assert.notEqual(ck.picture.items[0].id, entries[0]!.id, "rendered client ID is not the native pointer ID");
  assert.equal(ck.position.ino, before.ino); assert.equal(ck.position.offset, before.size);
  assert.deepEqual(ck.pointed, { "native.session": entries.map(e => e.id) });
  const log = new ConvLog(vault);
  try {
    const seq = log.picture("thread")!.seq;
    const feed = new PiFeed({ file: native, pointed: log.pointedIn("thread", native), emit: body => log.emit("thread", body) });
    try { feed.sync(true); } finally { feed.dispose(); }
    assert.deepEqual(log.picture("thread"), expected); assert.deepEqual(log.after(seq).events, []);
  } finally { log.close(); }
}));

for (const crash of ["before-log-rename", "between-renames", "after-renames"] as Stage[]) {
  test(`crash ${crash}: original retained, ordinary --recover completes ONLY recognized cohort under exclusion`, async () => fixture(async (o, vault) => {
    const { text, expected } = await seed(o, vault);
    const ckFile = o.source.replace(/\.jsonl$/, ".ckpt.json");
    const oldCheckpoint = await readFile(ckFile), oldInode = (await stat(o.source)).ino;
    await assert.rejects(prepareOffline(o, { assertStopped: stopped, onStage: async stage => { if (stage === crash) throw new Error("synthetic crash"); } }), /synthetic crash/);
    const mf = await intent(o), m = JSON.parse(await readFile(mf, "utf8"));
    assert.equal(await readFile(m.backup.path, "utf8"), text);
    assert.deepEqual(await readFile(m.originalCheckpoint.path), oldCheckpoint);
    if (crash === "before-log-rename") { assert.equal((await stat(o.source)).ino, oldInode); assert.deepEqual(await readFile(ckFile), oldCheckpoint); }
    if (crash === "between-renames") {
      assert.notEqual((await stat(o.source)).ino, oldInode); assert.deepEqual(await readFile(ckFile), oldCheckpoint);
      assert.throws(() => new ConvLog(vault), /identity\/size changed/);
    }
    const release = acquireEventDirectory(o.eventsDir, "shared");
    try { await assert.rejects(completePrepared(mf, { assertStopped: stopped }), /exclusive lock unavailable/); }
    finally { release(); }
    await completePrepared(mf, { assertStopped: stopped });
    const log = new ConvLog(vault); try { assert.deepEqual(log.picture("thread"), expected); } finally { log.close(); }
    await completePrepared(mf, { assertStopped: stopped });
  }));
}

test("v3 log-first crash rejects old checkpoint identity on actual runtime reopen; ordinary recovery succeeds", async () => fixture(async (o, vault) => {
  const { expected } = await seed(o, vault);
  const log = new ConvLog(vault); log.checkpointNow("thread"); log.close();
  await assert.rejects(prepareOffline(o, { assertStopped: stopped, onStage: async s => { if (s === "between-renames") throw new Error("crash"); } }), /crash/);
  assert.throws(() => new ConvLog(vault), /identity\/size changed/);
  await completePrepared(await intent(o), { assertStopped: stopped });
  const cold = new ConvLog(vault); try { assert.deepEqual(cold.picture("thread"), expected); } finally { cold.close(); }
}));

test("unknown changed source, checkpoint, candidate or backup cannot be blindly overwritten on recovery", async () => {
  for (const target of ["source", "checkpoint", "log", "checkpointNew", "backup"] as const) await fixture(async (o, vault) => {
    await seed(o, vault);
    await assert.rejects(prepareOffline(o, { assertStopped: stopped, onStage: async s => { if (s === "before-log-rename") throw new Error("crash"); } }));
    const mf = await intent(o), m = JSON.parse(await readFile(mf, "utf8"));
    const path = typeof m[target] === "string" ? m[target] : m[target].path;
    // Appending preserves backup permissions as our user but changes safety CAS.
    const { chmod } = await import("node:fs/promises"); await chmod(path, 0o600); await appendFile(path, "tamper\n");
    const changed = await readFile(path);
    await assert.rejects(completePrepared(mf, { assertStopped: stopped }));
    assert.deepEqual(await readFile(path), changed);
  });
});

test("authoritative old checkpoint prevents silent body loss even if source replay and candidate replay both lose the same native pointer", async () => {
  for (const missing of ["file", "entry", "checkpoint-body"] as const) await fixture(async (o, vault) => {
    const { text, native } = await seed(o, vault);
    const ck = o.source.replace(/\.jsonl$/, ".ckpt.json"), original = await readFile(ck);
    if (missing === "file") await unlink(native);
    if (missing === "entry") await writeFile(native, "");
    if (missing === "checkpoint-body") {
      const m = JSON.parse(original.toString()); m.picture.items.find((x: any) => x.kind === "assistant").text = "materialized original absent in raw native";
      await writeFile(ck, JSON.stringify(m));
    }
    const before = await readFile(ck);
    await assert.rejects(prepareOffline(o, { assertStopped: stopped }), /native-pointer-missing|authoritative-checkpoint-fold-mismatch/);
    assert.equal(await readFile(o.source, "utf8"), text); assert.deepEqual(await readFile(ck), before);
    const dirs = await readdir(o.backupsRoot); assert.equal(await readFile(join(o.backupsRoot, dirs[0]!, "original.jsonl"), "utf8"), text);
  });
});

test("offline native sequential resolver finds original prefix IDs beyond bounded suffix lookup; full native reads remain supported", async () => fixture(async (o, vault) => {
  const { expected, native } = await seed(o, vault, true);
  const filler = JSON.stringify({ type: "custom", id: "unpointed-padding", data: "z".repeat(1024 * 1024) }) + "\n";
  for (let i = 0; i < 20; i++) await appendFile(native, filler.replace("unpointed-padding", `padding-${i}`));
  assert.ok((await stat(native)).size > 20 * 1024 * 1024);
  assert.ok(readEntries(native).some(e => e.id === "native-original-user"), "full native history remains supported");
  assert.ok(!readEntries(native, true).some(e => e.id === "native-original-user"));
  const result = await prepareOffline({ ...o, mode: "checkpoint-only" }, { assertStopped: stopped });
  const ck = JSON.parse(await readFile(result.checkpoint, "utf8"));
  assert.deepEqual(ck.picture, expected); assert.deepEqual(ck.pointed["native.session"], ["native-original-user", "native-original-assistant"]);
  assert.ok(readEntries(native).some(e => e.id === "native-original-user"), "full native history remains supported");
}));

test("runtime SHARED vs offline EXCLUSIVE races: neither backup nor source access while another writer owns directory", async () => fixture(async (o, vault) => {
  await seed(o, vault);
  const log = new ConvLog(vault);
  try {
    await assert.rejects(prepareOffline(o, { assertStopped: stopped }), /exclusive lock unavailable/);
    assert.deepEqual(await readdir(o.backupsRoot), []);
    log.emit("thread", { type: "meta", patch: { title: "writer remained owner" } });
  } finally { log.close(); }
  await prepareOffline(o, { assertStopped: stopped, onStage: async stage => {
    if (stage === "idle" || stage === "backup-verified" || stage === "compacted" || stage === "after-renames") assert.throws(() => new ConvLog(vault), /shared lock unavailable/);
  } });
}));

test("legacy v2 compaction requires the independent checkpoint-only upgrade, then ordinary apply works on fresh dynamic bytes", async () => fixture(async (o, vault) => {
  const { text, expected } = await seed(o, vault, true);
  const originalCheckpoint = await readFile(o.source.replace(/\.jsonl$/, ".ckpt.json"));
  await assert.rejects(prepareOffline(o, { assertStopped: stopped }), /checkpoint-only-required-before-replacing-v2-log/);
  assert.equal(await readFile(o.source, "utf8"), text);
  assert.deepEqual(await readFile(o.source.replace(/\.jsonl$/, ".ckpt.json")), originalCheckpoint);
  await prepareOffline({ ...o, mode: "checkpoint-only" }, { assertStopped: stopped });
  // Not pinned to a historical SHA, size or sequence: include an unrelated fresh
  // canonical append after rebuilding the original checkpoint.
  const log = new ConvLog(vault);
  const fresh = log.emit("thread", { type: "meta", patch: { title: "fresh bytes after original proof" } }); log.close();
  const result = await prepareOffline(o, { assertStopped: stopped });
  assert.equal(result.installed, true); assert.equal(result.compact.lastSeq, fresh.seq);
  const cold = new ConvLog(vault);
  try { assert.deepEqual(cold.picture("thread")!.items, expected.items); assert.equal(cold.picture("thread")!.meta.title, "fresh bytes after original proof"); }
  finally { cold.close(); }
}));

test("record limits: never emit a candidate tail record above core 8MiB; checkpoint-only can leave old prefix unread at EOF", async () => fixture(async (o, vault) => {
  const { expected } = await seed(o, vault);
  const large = JSON.stringify({ seq: expected.seq + 1, conv: "thread", at: 80, type: "meta", patch: { activity: "x".repeat(9 * 1024 * 1024) } }) + "\n";
  await appendFile(o.source, large);
  const inode = (await stat(o.source)).ino, bytes = await readFile(o.source), checkpoint = await readFile(o.source.replace(/\.jsonl$/, ".ckpt.json"));
  await assert.rejects(prepareOffline(o, { assertStopped: stopped }), /candidate-record-exceeds-runtime-8MiB-limit/);
  assert.deepEqual(await readFile(o.source), bytes); assert.deepEqual(await readFile(o.source.replace(/\.jsonl$/, ".ckpt.json")), checkpoint);
  await prepareOffline({ ...o, mode: "checkpoint-only" }, { assertStopped: stopped });
  assert.equal((await stat(o.source)).ino, inode); assert.deepEqual(await readFile(o.source), bytes);
  const cold = new ConvLog(vault);
  try { assert.deepEqual(cold.picture("thread")!.items, expected.items); assert.equal(cold.picture("thread")!.seq, expected.seq + 1); }
  finally { cold.close(); }
}));

test("checkpoint-only accepts historical records above 32MiB below Node string ceiling without mutating original log", async () => fixture(async (o, vault) => {
  await seed(o, vault);
  await appendFile(o.source, JSON.stringify({ seq: 77, conv: "thread", at: 1, type: "meta", patch: { activity: "x".repeat(32 * 1024 * 1024) } }) + "\n");
  const before = identity(await stat(o.source)), checkpoint = await readFile(o.source.replace(/\.jsonl$/, ".ckpt.json"));
  await assert.rejects(prepareOffline(o, { assertStopped: stopped }), /candidate-record-exceeds-runtime-8MiB-limit/);
  assert.deepEqual(identity(await stat(o.source)), before); assert.deepEqual(await readFile(o.source.replace(/\.jsonl$/, ".ckpt.json")), checkpoint);
  await prepareOffline({ ...o, mode: "checkpoint-only" }, { assertStopped: stopped });
  assert.deepEqual(identity(await stat(o.source)), before);
  const cold = new ConvLog(vault);
  try { assert.equal(cold.picture("thread")!.seq, 77); assert.equal(String(cold.picture("thread")!.meta.activity).length, 32 * 1024 * 1024); }
  finally { cold.close(); }
}));

for (const stage of ["before-log-rename", "between-renames", "after-renames"]) {
  test(`actual child SIGKILL at ${stage}: kernel exclusion releases and durable intent reopens correct cohort`, async () => fixture(async (o, vault) => {
    const { expected, text } = await seed(o, vault);
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { prepareOffline } from './scripts/offline-event-log.ts';
      const [options, stage] = process.argv.slice(1);
      await prepareOffline(JSON.parse(options), { assertStopped: async () => {}, onStage: async s => { if (s === stage) process.kill(process.pid, 'SIGKILL'); } });
    `, JSON.stringify(o), stage], { cwd: join(import.meta.dirname, ".."), encoding: "utf8", timeout: 10000 });
    assert.equal(child.signal, "SIGKILL", child.stderr);
    const mf = await intent(o), m = JSON.parse(await readFile(mf, "utf8"));
    assert.equal(await readFile(m.backup.path, "utf8"), text);
    acquireEventDirectory(o.eventsDir, "exclusive")();
    if (stage === "between-renames") assert.throws(() => new ConvLog(vault), /identity\/size changed/);
    if (stage === "before-log-rename" || stage === "after-renames") {
      const cold = new ConvLog(vault); try { assert.deepEqual(cold.picture("thread"), expected); } finally { cold.close(); }
    }
    await completePrepared(mf, { assertStopped: stopped });
    const cold = new ConvLog(vault); try { assert.deepEqual(cold.picture("thread"), expected); } finally { cold.close(); }
  }));
}

test("authoritative checkpoint comparison uses canonical persisted optional fields, retaining completed tools", async () => fixture(async (o, vault) => {
  const { native } = await seed(o, vault);
  const toolCall = { id: "tool-call-native", type: "message", message: { role: "assistant", timestamp: 100, content: [{ type: "toolCall", id: "tool-id", name: "read", arguments: { path: "synthetic" } }] } };
  const toolResult = { id: "tool-result-native", type: "message", message: { role: "toolResult", timestamp: 101, toolCallId: "tool-id", toolName: "read", content: [{ type: "text", text: "original tool result" }] } };
  await appendFile(native, JSON.stringify(toolCall) + "\n" + JSON.stringify(toolResult) + "\n");
  const log = new ConvLog(vault);
  log.emit("thread", { type: "entry", file: native, entry: toolCall as any });
  log.emit("thread", { type: "entry", file: native, entry: toolResult as any });
  log.checkpointNow("thread");
  const expected = JSON.parse(JSON.stringify(log.picture("thread"))); log.close();
  await prepareOffline(o, { assertStopped: stopped });
  const cold = new ConvLog(vault);
  try { assert.deepEqual(cold.picture("thread"), expected); assert.match(JSON.stringify(cold.picture("thread")), /original tool result/); }
  finally { cold.close(); }
}));
