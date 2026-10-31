import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateProjects, migrateBack, type Manifest } from "../server/projectsMigrate.ts";
import { acquireEventDirectory } from "../server/convlog/maintenance.ts";
import { ConvLog } from "../server/convlog/log.ts";
function fixture(fn: (root: string, vaults: { name: string; path: string; main: boolean }[], dirs: string[]) => void) {
  const root = fs.mkdtempSync(join(tmpdir(), "vc-migration-exclusion-"));
  const vaults = ["a", "z"].map(name => ({ name, path: join(root, name), main: false }));
  const dirs = vaults.map(v => join(v.path, ".vault-chat", "events"));
  for (const dir of dirs) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(join(dir, "main.jsonl"), '{"seq":1,"conv":"main","at":1,"type":"meta","patch":{}}\n'); }
  try { fn(root, vaults, dirs); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
const noShared = (dirs: string[]) => { for (const d of dirs) assert.throws(() => acquireEventDirectory(d, "shared"), /shared lock unavailable/); };
const allFree = (dirs: string[]) => { for (const d of dirs) acquireEventDirectory(d, "exclusive")(); };
test("projects migrate locks ALL sorted event inodes before first canonical read/write, and releases finally", () => fixture((root, vaults, dirs) => {
  const originalRead = fs.readFileSync;
  let observed = 0;
  fs.readFileSync = ((p: any, ...args: any[]) => {
    if (typeof p === "string" && dirs.some(d => p.startsWith(d + "/"))) { noShared(dirs); observed++; }
    return (originalRead as any)(p, ...args);
  }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  try {
    migrateProjects({ vaults: [...vaults].reverse(), stateDir: join(root, "state"), dryRun: true });
    assert.ok(observed >= 2);
  } finally { fs.readFileSync = originalRead; syncBuiltinESMExports(); }
  allFree(dirs);
  assert.throws(() => migrateProjects({ vaults, stateDir: join(root, "state"), log: () => { noShared(dirs); throw new Error("injected migration failure"); } }), /injected migration failure/);
  allFree(dirs);
}));

test("active runtime in LAST directory blocks migration before reading/changing ANY source; partial locks released", () => fixture((root, vaults, dirs) => {
  const log = new ConvLog(vaults[1]!.path), original = fs.readFileSync(join(dirs[0]!, "main.jsonl"));
  let reported = false;
  try {
    assert.throws(() => migrateProjects({ vaults, stateDir: join(root, "state"), log: () => { reported = true; } }), /exclusive lock unavailable/);
    assert.equal(reported, false); assert.equal(fs.existsSync(join(root, "state")), false);
    assert.deepEqual(fs.readFileSync(join(dirs[0]!, "main.jsonl")), original);
    acquireEventDirectory(dirs[0]!, "exclusive")();
  } finally { log.close(); }
  allFree(dirs);
}));

test("projects back discovers paths only from external manifest then excludes ALL destinations before any restoration", () => fixture((root, _vaults, dirs) => {
  const stateDir = join(root, "state"), stamp = "synthetic", backup = join(stateDir, "migrations", `projects-${stamp}`);
  fs.mkdirSync(backup, { recursive: true });
  const man: Manifest = { stamp, at: "synthetic", dryRun: false, report: [], changes: dirs.map((d, i) => {
    const kept = join(backup, `original-${i}`); fs.writeFileSync(kept, `original ${i}`);
    return { kind: "changed" as const, path: join(d, "main.jsonl"), kept };
  }) };
  fs.writeFileSync(join(backup, "manifest.json"), JSON.stringify(man));
  const before = dirs.map(d => fs.readFileSync(join(d, "main.jsonl")));
  const release = acquireEventDirectory(dirs[1]!, "shared");
  try {
    assert.throws(() => migrateBack({ stateDir, stamp }), /exclusive lock unavailable/);
    dirs.forEach((d, i) => assert.deepEqual(fs.readFileSync(join(d, "main.jsonl")), before[i]));
    acquireEventDirectory(dirs[0]!, "exclusive")();
  } finally { release(); }
  const originalCopy = fs.cpSync; let copies = 0;
  fs.cpSync = ((...args: any[]) => { noShared(dirs); copies++; return (originalCopy as any)(...args); }) as typeof fs.cpSync;
  syncBuiltinESMExports();
  try { assert.equal(migrateBack({ stateDir, stamp }).restored, 2); assert.equal(copies, 2); }
  finally { fs.cpSync = originalCopy; syncBuiltinESMExports(); }
  allFree(dirs);
}));
