import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import cp from "node:child_process";
import os from "node:os";
import { join } from "node:path";
import { acquireEventDirectory } from "../../server/convlog/maintenance.ts";
import { ConvLog, checkpointFor } from "../../server/convlog/log.ts";
function fixture(fn: (dir: string) => void) {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "vc-event-exclusion-"));
  try { fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const exclusive = (dir: string) => spawnSync("flock", ["--exclusive", "--nonblock", dir, "true"]).status;

test("kernel directory flock excludes maintenance for runtime lifetime, with no per-event subprocess", () => fixture((dir) => {
  const original = cp.spawnSync; let acquisitions = 0;
  cp.spawnSync = ((...args: any[]) => { if (args[0] === "flock") acquisitions++; return (original as any)(...args); }) as typeof cp.spawnSync;
  syncBuiltinESMExports();
  try {
    const log = new ConvLog(dir, null, dir);
    assert.equal(acquisitions, 1);
    for (let i = 0; i < 30; i++) log.emit("root", { type: "meta", patch: { title: `Update ${i}` } });
    log.checkpointNow("root"); assert.equal(acquisitions, 1, "emit/checkpoint reuse lifetime lock");
    assert.equal(exclusive(dir), 1, "parent FD retains lock after flock helper exits");
    log.close(); log.close(); assert.equal(exclusive(dir), 0);
    assert.throws(() => log.emit("root", { type: "meta", patch: { title: "unlocked" } }), /writer is closed/);
    assert.throws(() => log.checkpointNow("root"), /writer is closed/);
  } finally { cp.spawnSync = original; syncBuiltinESMExports(); }
}));

test("exclusive maintenance blocks startup BEFORE epoch/floor/heal/checkpoint mutation", () => fixture((dir) => {
  const release = acquireEventDirectory(dir, "exclusive");
  try {
    assert.throws(() => new ConvLog(dir, null, dir), /shared lock unavailable/);
    assert.deepEqual(fs.readdirSync(dir), [], "blocked startup leaves no metadata or canonical files");
    assert.throws(() => acquireEventDirectory(dir, "exclusive"), /exclusive lock unavailable/);
  } finally { release(); }
  const log = new ConvLog(dir, null, dir); log.close();
}));

test("failed startup releases lock and process crash releases kernel ownership without stale lease cleanup", () => fixture((dir) => {
  fs.writeFileSync(join(dir, "root.jsonl"), '{"seq":2,"conv":"root","at":0,"type":"meta","patch":{}}\n{"seq":1,"conv":"root","at":0,"type":"meta","patch":{}}\n');
  assert.throws(() => new ConvLog(dir, null, dir), /non-increasing/); assert.equal(exclusive(dir), 0);
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import fs from 'node:fs'; import {spawnSync} from 'node:child_process';
    const fd=fs.openSync(process.argv[1],'r');
    if(spawnSync('flock',['--shared','--nonblock','3'],{stdio:['ignore','ignore','ignore',fd]}).status!==0)process.exit(2);
    process.kill(process.pid,'SIGKILL');
  `, dir], { timeout: 5000 });
  assert.equal(r.signal, "SIGKILL"); assert.equal(exclusive(dir), 0);
}));

test("offline replacement cohort rejects interrupted log-only rename and loads matching owner-built checkpoint", () => fixture((dir) => {
  const log = new ConvLog(dir, null, dir);
  log.emit("root", { type: "meta", patch: { title: "Original", project: "vault-chat" } }); log.checkpointNow("root");
  const picture = log.picture("root")!; log.close();
  const release = acquireEventDirectory(dir, "exclusive");
  const source = join(dir, "root.jsonl"), candidate = join(dir, "candidate.partial");
  try {
    fs.copyFileSync(source, candidate); // synthetic same-record candidate, distinct inode
    const ck = checkpointFor(candidate, picture, fs.statSync(candidate).size, {});
    fs.renameSync(candidate, source);
    assert.equal(ck.position.ino, fs.statSync(source).ino);
    release();
    assert.throws(() => new ConvLog(dir, null, dir), /identity\/size changed/, "old checkpoint must not attach to a replaced log");
    const again = acquireEventDirectory(dir, "exclusive");
    try { fs.writeFileSync(join(dir, "root.ckpt.json.tmp"), JSON.stringify(ck)); fs.renameSync(join(dir, "root.ckpt.json.tmp"), join(dir, "root.ckpt.json")); }
    finally { again(); }
    const cold = new ConvLog(dir, null, dir); assert.deepEqual(cold.picture("root"), picture); cold.close();
  } finally { release(); }
}));
