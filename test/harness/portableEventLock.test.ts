// The events-directory lock off Linux (macOS, Windows): holder files with O_EXCL, same rules as flock.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { acquirePortable, portableLockDir } from "../../server/convlog/maintenance.ts";

function fixture(fn: (dir: string, root: string) => void) {
  const base = fs.mkdtempSync(join(os.tmpdir(), "vc-portable-lock-"));
  const dir = join(base, "events"), root = join(base, "locks");
  fs.mkdirSync(dir);
  try { fn(dir, root); } finally { fs.rmSync(base, { recursive: true, force: true }); }
}

test("shared holders coexist; exclusive excludes both ways; release frees", () => fixture((dir, root) => {
  const a = acquirePortable(dir, "shared", root), b = acquirePortable(dir, "shared", root);
  assert.throws(() => acquirePortable(dir, "exclusive", root), /exclusive lock unavailable/);
  a(); assert.throws(() => acquirePortable(dir, "exclusive", root), /exclusive lock unavailable/);
  b(); b();
  const x = acquirePortable(dir, "exclusive", root);
  assert.throws(() => acquirePortable(dir, "shared", root), /shared lock unavailable/);
  assert.throws(() => acquirePortable(dir, "exclusive", root), /exclusive lock unavailable/);
  x();
  acquirePortable(dir, "exclusive", root)();
  acquirePortable(dir, "shared", root)();
  assert.deepEqual(fs.readdirSync(dir), [], "nothing is written into the events directory");
  assert.deepEqual(fs.readdirSync(portableLockDir(dir, root)), [], "released holders leave no files");
}));

test("a failed exclusive attempt leaves no exclusive holder behind", () => fixture((dir, root) => {
  const s = acquirePortable(dir, "shared", root);
  assert.throws(() => acquirePortable(dir, "exclusive", root), /exclusive lock unavailable/);
  acquirePortable(dir, "shared", root)(); // not blocked by a leftover exclusive file
  s();
}));

const MODULE = new URL("../../server/convlog/maintenance.ts", import.meta.url).href;
const holdAndDie = (dir: string, root: string, mode: string) => spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
  const { acquirePortable } = await import(${JSON.stringify(MODULE)});
  acquirePortable(process.argv[1], process.argv[3], process.argv[2]);
  process.kill(process.pid, "SIGKILL");
`, dir, root, mode], { timeout: 20000 });

for (const mode of ["shared", "exclusive"]) {
  test(`${mode === "shared" ? "a shared" : "an exclusive"} holder killed with SIGKILL is stale: the next acquirer removes it`, () => fixture((dir, root) => {
    const r = holdAndDie(dir, root, mode);
    assert.equal(r.signal, "SIGKILL", r.stderr?.toString());
    assert.equal(fs.readdirSync(portableLockDir(dir, root)).length, 1, "the dead holder's file is left behind");
    const x = acquirePortable(dir, "exclusive", root);
    assert.deepEqual(fs.readdirSync(portableLockDir(dir, root)), ["exclusive.lock"]);
    x();
  }));
}

test("a live holder in another process is respected; a normal exit releases it", async () => {
  const base = fs.mkdtempSync(join(os.tmpdir(), "vc-portable-lock-"));
  const dir = join(base, "events"), root = join(base, "locks");
  fs.mkdirSync(dir);
  try {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      const { acquirePortable } = await import(${JSON.stringify(MODULE)});
      acquirePortable(process.argv[1], "shared", process.argv[2]);
      process.stdin.on("data", () => process.exit(0));
    `, dir, root], { stdio: ["pipe", "ignore", "ignore"] });
    const exited = new Promise((r) => child.on("exit", r));
    const ld = portableLockDir(dir, root);
    await waitFor(() => fs.existsSync(ld) && fs.readdirSync(ld).length === 1);
    assert.throws(() => acquirePortable(dir, "exclusive", root), /exclusive lock unavailable/);
    child.stdin!.write("go\n");
    await exited;
    assert.deepEqual(fs.readdirSync(ld), [], "process.exit released it");
    acquirePortable(dir, "exclusive", root)();
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("a half-written holder (writer died between create and write) is held briefly, then stale", () => fixture((dir, root) => {
  const ld = portableLockDir(dir, root);
  fs.mkdirSync(ld, { recursive: true });
  const f = join(ld, "exclusive.lock");
  fs.writeFileSync(f, "");
  assert.throws(() => acquirePortable(dir, "shared", root), /shared lock unavailable/);
  const old = new Date(Date.now() - 60_000); fs.utimesSync(f, old, old);
  acquirePortable(dir, "shared", root)();
}));

test("the lock folder is one per events directory, outside it", () => fixture((dir, root) => {
  assert.equal(portableLockDir(dir, root), portableLockDir(join(dir, "."), root));
  assert.notEqual(portableLockDir(dir, root), portableLockDir(dir + "2", root));
  assert.ok(!portableLockDir(dir, root).startsWith(dir));
}));

async function waitFor(ok: () => boolean, ms = 20000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}
