// What each platform's bundle is told to carry.
//
// v0.7.91 never built: tauri.conf.json listed both `binaries/node` and
// `binaries/node.exe`, so every build asked for a file its own platform does
// not produce, and the Windows job died with "resource path `binaries\node`
// doesn't exist". Nothing has shipped since.
//
// The rule this pins: the shared config names only files every platform has,
// and each platform's own config names that platform's binaries — the ones its
// own build steps actually produce.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");
const root = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const json = (p: string) => JSON.parse(read(p));

const shared: string[] = json("src-tauri/tauri.conf.json").bundle.resources;
const windows: string[] = json("src-tauri/tauri.windows.conf.json").bundle.resources;
const linux: string[] = json("src-tauri/tauri.linux.conf.json").bundle.resources;

test("the shared config asks for nothing platform-specific", () => {
  // A name only one platform produces, in the config both read, is exactly what
  // broke the release.
  for (const r of shared) {
    assert.ok(!r.endsWith(".exe"), `${r} is Windows-only and must live in tauri.windows.conf.json`);
    assert.ok(!/binaries\/(node|tectonic)$/.test(r), `${r} is not produced on Windows`);
  }
  assert.ok(shared.includes("binaries/vault-chat-server.mjs"), "the server bundle is the same file everywhere");
});

test("each platform asks for the binaries its own build makes", () => {
  assert.deepEqual(windows, ["binaries/tectonic.exe", "binaries/node.exe", "binaries/vault-chat-server.mjs"]);
  assert.deepEqual(linux, ["binaries/tectonic", "binaries/node", "binaries/vault-chat-server.mjs"]);
  // The names the downloaders really write (scripts/download-node.mjs,
  // scripts/download-tectonic.mjs): .exe on Windows, bare on Linux.
  assert.match(read("scripts/download-node.mjs"), /IS_WINDOWS \? "node\.exe" : "node"/);
  assert.match(read("scripts/download-tectonic.mjs"), /IS_WINDOWS \? "tectonic\.exe" : "tectonic"/);
});

test("every release build makes them before anything asks for them", () => {
  // The Tauri prebuild hook fetches them too, but the resources are read while
  // the crate is built — so the workflow fetches them itself, as it always has
  // for tectonic.
  const wf = yaml.load(read(".github/workflows/ship.yml")) as any;
  for (const job of ["build_windows", "build_linux"]) {
    const runs = (wf.jobs[job].steps as { run?: string }[]).map((s) => s.run ?? "").join("\n");
    assert.match(runs, /download-tectonic\.mjs/, `${job} makes the LaTeX engine`);
    assert.match(runs, /download-node\.mjs/, `${job} makes the Node runtime`);
    assert.match(runs, /pack-server-into-app\.mjs/, `${job} makes the server bundle`);
  }
});

test("the app looks for them under the names its platform ships", () => {
  const rs = read("src-tauri/src/local_server.rs");
  assert.match(rs, /binaries\/vault-chat-server\.mjs/);
  assert.match(rs, /if cfg!\(windows\) \{ "node\.exe" \} else \{ "node" \}/);
});
