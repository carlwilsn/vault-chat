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
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
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

test("latest.json names only the Windows/Linux installers, never a stray .zip", () => {
  // Run the real manifest builder over a release that carries a stray mac-proof.zip (and even a stray signature for it).
  const dir = mkdtempSync(join(tmpdir(), "vc-manifest-"));
  try {
    const v = "9.9.9";
    const files = [`vault-chat_${v}_x64-setup.exe`, `vault-chat_${v}_x64_en-US.msi`, `vault-chat_${v}_amd64.AppImage`, `vault-chat_${v}_amd64.deb`];
    mkdirSync(join(dir, "sigs"));
    for (const f of [...files, "mac-proof.zip"]) writeFileSync(join(dir, "sigs", `${f}.sig`), `sig-of-${f}`);
    writeFileSync(join(dir, "mac-proof.zip"), "PK");
    execFileSync(process.execPath, [join(root, "scripts/build-updater-manifest.mjs")], {
      cwd: dir,
      env: { ...process.env, VERSION: v, NOTES: "", GITHUB_REPOSITORY: "o/r" },
      stdio: "pipe",
    });
    const text = readFileSync(join(dir, "latest.json"), "utf8");
    assert.doesNotMatch(text, /mac-proof|\.zip/);
    const urls = Object.values<any>(JSON.parse(text).platforms).map((p) => p.url.split("/").pop());
    assert.deepEqual([...new Set(urls)].sort(), [...files].sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.doesNotMatch(read("scripts/build-updater-manifest.mjs"), /mac-proof|\.zip/);
});

test("a self-test launch never checks for updates", () => {
  const banner = read("src/UpdateBanner.tsx");
  assert.match(banner, /isSelfTestLaunch\(\)\.then\(\(selfTest\) => \{\s*if \(cancelled \|\| selfTest\) return;\s*void runCheck\(\);/);
  assert.equal(banner.match(/runCheck\(\)/g)?.length, 2, "runCheck runs only behind the self-test gate (first check, interval)");
  assert.match(read("src/selfTestLaunch.ts"), /invoke<unknown>\("selftest_config"\)/);
});

test("the first-run tutorial steps file passes each step by itself and keeps the sample paper", () => {
  const steps = JSON.parse(read("test/selftest/tutorial.json"));
  assert.equal(steps.firstRun, true);
  const labels = steps.steps.map((s: any) => s.label ?? "").join("\n");
  for (const n of [1, 2, 3, 4]) assert.match(labels, new RegExp(`step ${n} passed by itself`));
  assert.doesNotMatch(JSON.stringify(steps), /data-tutorial=skip/);
  assert.match(labels, /the tutorial is off the screen/);
  assert.match(labels, /Welcome\/sample-paper\.pdf stays/);
});

test("latest.json never has a darwin entry, even with a stray Mac signature on the release", () => {
  const dir = mkdtempSync(join(tmpdir(), "vc-manifest-mac-"));
  try {
    const v = "9.9.9";
    const files = [`vault-chat_${v}_x64-setup.exe`, `vault-chat_${v}_x64_en-US.msi`, `vault-chat_${v}_amd64.AppImage`, `vault-chat_${v}_amd64.deb`, `vault-chat_${v}_aarch64.app.tar.gz`];
    mkdirSync(join(dir, "sigs"));
    for (const f of files) writeFileSync(join(dir, "sigs", `${f}.sig`), `sig-of-${f}`);
    execFileSync(process.execPath, [join(root, "scripts/build-updater-manifest.mjs")], { cwd: dir, env: { ...process.env, VERSION: v, NOTES: "", GITHUB_REPOSITORY: "o/r" }, stdio: "pipe" });
    const text = readFileSync(join(dir, "latest.json"), "utf8");
    assert.doesNotMatch(text, /darwin|\.app\.tar\.gz/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // The shared config's updater reads latest.json.
  assert.deepEqual(json("src-tauri/tauri.conf.json").plugins.updater.endpoints, ["https://github.com/carlwilsn/vault-chat/releases/latest/download/latest.json"]);
  for (const f of ["tauri.windows.conf.json", "tauri.linux.conf.json"]) assert.equal(json(`src-tauri/${f}`).plugins?.updater, undefined, f);
});

test("a background app installs updates when idle; the app checks by itself (no manual Check for updates)", () => {
  const banner = read("src/UpdateBanner.tsx");
  assert.match(banner, /const unattended = isRunInBackground\(\);/);
  assert.match(banner, /if \(unattended\) await applyUnattended/);
  assert.match(banner, /window\.setInterval\(\(\) => void runCheck\(\), RECHECK_MS\)/);
  assert.doesNotMatch(banner, /vc:check-updates/);
  assert.doesNotMatch(read("src/plugins/settings/Pane.tsx"), /Check for updates|vc:check-updates/);
});
