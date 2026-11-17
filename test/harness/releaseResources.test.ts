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
const macos = json("src-tauri/tauri.macos.conf.json");

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
  assert.deepEqual(macos.bundle.resources, ["binaries/tectonic", "binaries/node", "binaries/vault-chat-server.mjs"]);
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

test("macOS gets native window buttons over the same window", () => {
  // A merge patch replaces the windows array whole, so the macOS window must
  // repeat the shared one: only the title bar differs (native traffic lights
  // over the app's own bar; Windows/Linux keep decorations off).
  const base = json("src-tauri/tauri.conf.json").app.windows[0];
  const mac = macos.app.windows[0];
  assert.equal(base.decorations, false);
  assert.equal(mac.decorations, true);
  assert.equal(mac.titleBarStyle, "Overlay");
  assert.equal(mac.hiddenTitle, true);
  // The lights end left of the bar's 76 px inset (src/plugins/titlebar/Bar.tsx).
  assert.ok(mac.trafficLightPosition.x + 54 <= 76);
  const { decorations: _a, hiddenTitle: _b, trafficLightPosition: _c, ...rest } = mac;
  const { decorations: _d, ...baseRest } = base;
  assert.deepEqual(rest, baseRest);
  assert.match(read("src/plugins/titlebar/Bar.tsx"), /isMac \? \{ paddingLeft: 76 \}/);
});

test("the macOS job checks a build and publishes nothing", () => {
  const wf = yaml.load(read(".github/workflows/ship.yml")) as any;
  const mac = wf.jobs.build_macos;
  assert.equal(mac["continue-on-error"], true);
  assert.match(mac["runs-on"], /^macos-/);
  for (const [name, job] of Object.entries<any>(wf.jobs)) {
    const needs = [job.needs ?? []].flat();
    assert.ok(!needs.includes("build_macos"), `${name} must never wait for the Mac job`);
  }
  const text = JSON.stringify(mac);
  assert.doesNotMatch(text, /gh release|tauri-action|TAURI_SIGNING|releaseId|latest\.json/);
  assert.match(text, /createUpdaterArtifacts\\":false/);
  assert.doesNotMatch(read("scripts/build-updater-manifest.mjs"), /darwin/);
});
