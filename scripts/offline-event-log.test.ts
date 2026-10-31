import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, rename, chmod, stat, truncate, appendFile, symlink, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { prepareOffline, parseArgs, assertHostStopped, type PrepareOptions, type Stage } from "./offline-event-log.ts";
import { digest, hashFile, lines, type File } from "./event-log-stream.ts";
import { ConvLog } from "../server/convlog/log.ts";
import { fold } from "../src/convlog/reduce.ts";

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const stopped = async () => {};
const row = (seq: number, title = "fixture 🧪 exact user string\nkeep") => JSON.stringify({ seq, conv: "thread", at: seq, type: "meta", patch: { title } }) + "\n";
async function fixture(run: (options: PrepareOptions, text: string, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "vc-offline-ordinary-"));
  try {
    const eventsDir = join(dir, "vault/.vault-chat/events"), backupsRoot = join(dir, "external-backups");
    await mkdir(eventsDir, { recursive: true }); await mkdir(backupsRoot);
    const options = { source: join(eventsDir, "thread.jsonl"), eventsDir, backupsRoot, idleMs: 5 };
    const text = row(7) + row(413, "changed"); await writeFile(options.source, text);
    await run(options, text, dir);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test("ordinary CLI has dynamic flags and refuses a host preflight failure before source access", () => {
  const args = ["--source", "/nonexistent-private-source", "--events-dir", "/nonexistent", "--backups-root", "/nonexistent", "--idle-ms", "25", "--apply"];
  assert.equal(parseArgs(args).idleMs, 25);
  for (const bad of [[], [...args, "--dry-run"], [...args, "--old-sha", "a"], [...args.slice(0, -1), "--idle-ms", "0", "--dry-run"]]) assert.throws(() => parseArgs(bad));
  const cli = spawnSync(process.execPath, ["--import", "tsx", "scripts/offline-event-log.ts", ...args], { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8", timeout: 10000 });
  assert.equal(cli.status, 1); assert.match(cli.stderr, /reason=host-|reason=server-and-updater-/); assert.equal(cli.stdout, "");
});

test("fresh backup FIRST, arbitrary current sizes/hashes/sequences; dry run never changes source/checkpoint", async () => fixture(async (options, text) => {
  const checkpoint = options.source.replace(/\.jsonl$/, ".ckpt.json"), checkpointText = "existing cache must not be changed\n";
  await writeFile(checkpoint, checkpointText);
  const sourceStat = await stat(options.source), stages: Stage[] = [];
  const first = await prepareOffline(options, { assertStopped: stopped, onStage: async (stage, dir) => {
    stages.push(stage);
    if (stage === "backup-verified") {
      assert.equal(await readFile(join(dir!, "original.jsonl"), "utf8"), text);
      assert.equal(JSON.parse(await readFile(join(dir!, "backup.json"), "utf8")).verified, true);
      assert.ok(!(await readdir(dir!)).includes("candidate"));
    }
  } });
  assert.deepEqual(stages, ["idle", "copied", "backup-verified", "compacted"]);
  assert.equal(first.installed, false); assert.equal(first.writerExcluded, true); assert.equal(first.compact.foldVerified, true);
  assert.equal(first.backup.sha256, sha(text)); assert.equal(first.compact.lastSeq, 413);
  assert.equal(await readFile(checkpoint, "utf8"), checkpointText);
  assert.equal((await stat(options.source)).ino, sourceStat.ino); assert.equal((await stat(options.source)).mtimeMs, sourceStat.mtimeMs);
  const different = text + row(992270, "another dynamic current identity".repeat(100)); await writeFile(options.source, different);
  const second = await prepareOffline(options, { assertStopped: stopped });
  assert.notEqual(first.backup.path, second.backup.path); assert.notEqual(first.backup.sha256, second.backup.sha256);
  assert.ok(second.backup.bytes > first.backup.bytes); assert.equal(second.compact.lastSeq, 992270);
  assert.equal(await readFile(first.backup.path, "utf8"), text); assert.equal(await readFile(options.source, "utf8"), different);
}));

test("refuse active primary/worker/checker failure before opening even a nonexistent source", async () => {
  for (const reason of ["primary active", "worker active", "service checker unavailable"]) {
    await assert.rejects(prepareOffline({ source: "/nonexistent", eventsDir: "/nonexistent", backupsRoot: "/nonexistent", idleMs: 1 }, { assertStopped: async () => { throw new Error(reason); } }), new RegExp(reason));
  }
});

test("append during idle, after backup, during final verification; rotation/truncate/in-place mutation refuse without tool replacement", async () => {
  for (const [stage, mutation] of [["idle", "append"], ["backup-verified", "append"], ["compacted", "append"], ["copied", "rotate"], ["backup-verified", "truncate"], ["compacted", "rewrite"]] as const) {
    await fixture(async (options, text) => {
      let expected = text;
      await assert.rejects(prepareOffline(options, { assertStopped: stopped, onStage: async current => {
        if (current !== stage) return;
        if (mutation === "append") { expected += row(999999); await appendFile(options.source, row(999999)); }
        if (mutation === "rotate") { await rename(options.source, options.source + ".rotated"); await writeFile(options.source, text); }
        if (mutation === "truncate") { await truncate(options.source, 0); expected = ""; }
        if (mutation === "rewrite") { expected = text.replace("changed", "CHANGED"); await writeFile(options.source, expected); }
      } }), /source-changed-or-rotated/);
      assert.equal(await readFile(options.source, "utf8"), expected, "compactor never replaces or repairs externally changed source");
      if (mutation === "rotate") assert.equal(await readFile(options.source + ".rotated", "utf8"), text);
      const artifacts = await readdir(options.backupsRoot);
      if (stage === "idle") assert.deepEqual(artifacts, []);
      else assert.equal(JSON.parse(await readFile(join(options.backupsRoot, artifacts[0], "FAILED.json"), "utf8")).installed, false);
    });
  }
});

test("worker restarts after backup: check failure leaves complete original backup and unchanged source", async () => fixture(async (options, text) => {
  let active = false, artifact = "";
  await assert.rejects(prepareOffline(options, { assertStopped: async () => { if (active) throw new Error("worker restarted"); }, onStage: async (stage, dir) => { if (stage === "backup-verified") { active = true; artifact = dir!; } } }), /worker restarted/);
  assert.equal(await readFile(join(artifact, "original.jsonl"), "utf8"), text);
  assert.equal(await readFile(options.source, "utf8"), text);
}));

test("tampered backup/candidate and injected failure preserve source and do not emit prepared success", async () => {
  for (const mode of ["backup-before-verify", "backup-after-verify", "candidate", "crash-before-transform"] as const) {
    await fixture(async (options, text) => {
      let artifact = "";
      await assert.rejects(prepareOffline(options, { assertStopped: stopped, onStage: async (stage, dir) => {
        if (dir) artifact = dir;
        if (mode === "backup-before-verify" && stage === "copied") await writeFile(join(dir!, "original.partial"), "tampered\n");
        if (mode === "backup-after-verify" && stage === "backup-verified") { await chmod(join(dir!, "original.jsonl"), 0o600); await writeFile(join(dir!, "original.jsonl"), "tampered\n"); }
        if (mode === "candidate" && stage === "compacted") await appendFile(join(dir!, "candidate/compacted.jsonl"), row(9999));
        if (mode === "crash-before-transform" && stage === "backup-verified") throw new Error("simulated process failure");
      } }));
      assert.equal(await readFile(options.source, "utf8"), text);
      await assert.rejects(readFile(join(artifact, "prepared.json")));
      if (mode === "candidate" || mode === "crash-before-transform") assert.equal(await readFile(join(artifact, "original.jsonl"), "utf8"), text);
    });
  }
});

test("no symlink source or in-vault backup directory", async () => fixture(async (options) => {
  await mkdir(join(options.eventsDir, "backups"));
  await assert.rejects(prepareOffline({ ...options, backupsRoot: join(options.eventsDir, "backups") }, { assertStopped: stopped }), /outside-vault/);
  const target = options.source + ".real"; await rename(options.source, target); await symlink(target, options.source);
  await assert.rejects(prepareOffline(options, { assertStopped: stopped }), /conversation-file/);
}));

test("canonical full fold includes native pointers/user strings, workers, tools/live reasoning and >64KB payload; no metadata-only equality claim", async () => fixture(async (options, _, dir) => {
  const session = join(options.eventsDir, "native.json");
  const entry = { id: "native-user", type: "message", message: { role: "user", content: [{ type: "text", text: "EXACT\n𐐀 café user's native text" }], timestamp: 3 }, timestamp: "2026-01-01T00:00:00Z" };
  await writeFile(session, JSON.stringify(entry) + "\n");
  const records = [
    { seq: 2, conv: "thread", at: 1, type: "meta", patch: { subagents: [{ threadId: "worker", task: "important".repeat(10000), state: "running", providerseq: 923, lseq: 82 }] } },
    { seq: 9, conv: "thread", at: 2, type: "entry", file: "native.json", id: "native-user" },
    { seq: 13, conv: "thread", at: 3, type: "live", ev: { type: "tool_execution_end", toolCallId: "t1", result: { text: "retained".repeat(10000) } } },
    { seq: 81, conv: "thread", at: 4, type: "meta", patch: { subagents: [{ threadId: "worker", task: "important".repeat(10000), state: "running", providerseq: 923, lseq: 82 }] } },
  ];
  await writeFile(options.source, records.map(r => JSON.stringify(r) + "\n").join(""));
  const expectedLog = new ConvLog(join(dir, "vault")), expected = expectedLog.picture("thread")!;
  const expanded = expectedLog.eventsOf("thread");
  expectedLog.close();
  const result = await prepareOffline(options, { assertStopped: stopped });
  assert.equal(result.compact.foldSha256, sha(JSON.stringify(expected)));
  assert.equal(result.compact.logicalSha256, sha(records.map(r => JSON.stringify(r) + "\n").join("")));
  assert.ok(result.compact.changedRecords > 0);
  assert.match(JSON.stringify(expected.items), /EXACT/);
  assert.deepEqual(fold(expanded, "thread"), expected);
  await assert.rejects(prepareOffline(options, { assertStopped: stopped, onStage: async stage => {
    if (stage === "compacted") await appendFile(session, "\n");
  } }), /native-session-changed-after-fold-verification/);
}));

test("torn final JSON, dangling/invalid UTF-8, invalid delta: refuse clearly, never discard source bytes", async () => fixture(async (options) => {
  for (const bytes of [Buffer.from(row(2).trimEnd()), Buffer.concat([Buffer.from(row(2)), Buffer.from([0xf0, 0x9f])]), Buffer.concat([Buffer.from(row(2).slice(0, -1)), Buffer.from([0xff, 10])]), Buffer.from(row(2) + '{"seq":8,"conv":"thread","at":8,"type":"subagents","patch":{},"subagents":{}}\n')]) {
    await writeFile(options.source, bytes);
    await assert.rejects(prepareOffline(options, { assertStopped: stopped }));
    assert.deepEqual(await readFile(options.source), bytes);
  }
}));

test("bounded I/O handles offsets beyond 5GiB without an old-size cap (virtual file, not a physical live-log test)", async () => {
  const size = 5 * 1024 ** 3 + 117, block = Buffer.alloc(256 * 1024, 0x61);
  let calls = 0, maximumRead = 0, end = 0;
  const virtual = { read: async (buffer: Buffer, offset: number, length: number, position: number) => {
    assert.ok(position <= size); maximumRead = Math.max(maximumRead, length); calls++;
    const bytesRead = Math.min(length, size - position); block.copy(buffer, offset, 0, bytesRead); end = position + bytesRead; return { bytesRead, buffer };
  } } as unknown as File;
  const hash = await hashFile(virtual, size);
  assert.match(hash, /^[a-f0-9]{64}$/); assert.equal(end, size); assert.ok(calls > 20000); assert.equal(maximumRead, 256 * 1024);
});

test("line scanner bounds a crossing-chunk large valid JSON record and decodes UTF-8 only at full line boundaries", async () => fixture(async (options) => {
  const text = row(35, "🧪".repeat(180000)); await writeFile(options.source, text);
  const fd = await open(options.source, "r"), hash = digest();
  try {
    let count = 0;
    for await (const line of lines(fd, Buffer.byteLength(text), hash)) { assert.equal(line.toString("utf8"), text); count++; }
    assert.equal(count, 1); assert.equal(hash.digest("hex"), sha(text));
  } finally { await fd.close(); }
}));

// Intentionally opt-in: parent schedules long commands via StartJob, never run a live log.
const largeMiB = Number(process.env.VC_OFFLINE_LARGE_FIXTURE_MIB ?? 0);
test("physical streamed valid snapshot fixture exceeds historical-size boundaries", { skip: largeMiB <= 0 }, async () => fixture(async (options) => {
  assert.ok(largeMiB >= 513);
  const fd = await open(options.source, "w"); let bytes = 0, seq = 2;
  const worker = { threadId: "synthetic-worker", state: "completed", task: "synthetic-only".repeat(80000), summary: "complete report" };
  try {
    while (bytes < largeMiB * 1024 ** 2) { const line = JSON.stringify({ seq: seq++, conv: "thread", at: 1, type: "meta", patch: { subagents: [worker] } }) + "\n"; await fd.writeFile(line); bytes += Buffer.byteLength(line); }
    await fd.sync();
  } finally { await fd.close(); }
  const originalInode = (await stat(options.source)).ino;
  const result = await prepareOffline({ ...options, mode: "apply" }, { assertStopped: stopped });
  assert.equal(result.installed, true);
  assert.notEqual((await stat(options.source)).ino, originalInode);
  const cold = new ConvLog(resolve(options.eventsDir, "../.."));
  try { assert.equal(cold.picture("thread")!.seq, seq - 1); } finally { cold.close(); }
  assert.ok(result.backup.bytes > 512 * 1024 ** 2); assert.equal(result.compact.foldVerified, true); assert.equal(result.compact.records, seq - 2);
  console.log(JSON.stringify({ syntheticOnly: true, inputBytes: bytes, compactedBytes: result.compact.output.bytes, records: result.compact.records, originalBackupPreserved: true, installed: result.installed }));
}));

test("host checker is fail-closed in an agent/non-systemd PID namespace", async () => {
  const pid1 = (await readFile("/proc/1/comm", "utf8")).trim();
  if (pid1 !== "systemd") await assert.rejects(assertHostStopped(), /host-process-namespace-required/);
});
