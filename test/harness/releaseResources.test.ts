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
    // Only the proof upload (mac_proof, below) follows it, and nothing follows that.
    if (name !== "mac_proof") assert.ok(!needs.includes("build_macos"), `${name} must never wait for the Mac job`);
    assert.ok(!needs.includes("mac_proof"), `${name} must never wait for the Mac proof`);
  }
  const text = JSON.stringify(mac);
  assert.doesNotMatch(text, /gh release|tauri-action|TAURI_SIGNING|releaseId|latest\.json/);
  assert.match(text, /createUpdaterArtifacts\\":false/);
  assert.doesNotMatch(read("scripts/build-updater-manifest.mjs"), /darwin/);
});

test("the macOS job self-tests the app on a fresh HOME and the Mac path hazards, and says so in its summary", () => {
  const wf = yaml.load(read(".github/workflows/ship.yml")) as any;
  const steps = wf.jobs.build_macos.steps as { name?: string; run?: string; if?: string }[];
  const i = steps.findIndex((s) => /Self-test/.test(s.name ?? ""));
  const launch = steps.findIndex((s) => /^Launch it/.test(s.name ?? ""));
  assert.ok(i > launch && launch >= 0, "the self-test runs after the launch check");
  const run = steps[i]!.run!;
  assert.match(steps[i]!.if ?? "", /!cancelled\(\)/, "it runs even when the launch check failed");
  assert.match(run, /test\/selftest\/smoke\.json/);
  assert.match(run, /VC_SELFTEST="\$steps" VC_SELFTEST_OUT=/);
  for (const v of ["fresh-home", "spaces-unicode", "case-sensitive-apfs"]) assert.match(run, new RegExp(`\\b${v}\\b`), v);
  assert.match(run, /Case-sensitive APFS/);
  assert.match(run, /GITHUB_STEP_SUMMARY/);
  assert.match(run, /\[ "\$failed" = 0 \]\s*$/, "a failing variant fails the (continue-on-error) Mac job");
  assert.ok(JSON.parse(read("test/selftest/smoke.json")).steps.length > 0);
  // The proof upload takes the whole proof folder, self-test results with it.
  const upload = steps.find((s: any) => s.uses?.startsWith("actions/upload-artifact")) as any;
  assert.equal(upload.if, "always()");
  assert.match(upload.with.path, /mac-proof$/);
});

test("the Mac proof is attached to the release as mac-proof.zip, after it is published, and blocks nothing", () => {
  const wf = yaml.load(read(".github/workflows/ship.yml")) as any;
  const job = wf.jobs.mac_proof;
  assert.deepEqual(job.needs, ["prepare", "build_macos", "manifest"]);
  assert.match(job.if, /^always\(\) && /);
  assert.equal(job["continue-on-error"], true);
  assert.equal(job.permissions.contents, "write");
  const run = (job.steps as { run?: string }[]).map((s) => s.run ?? "").join("\n");
  // One asset, by that name; never a manifest or an installer.
  assert.match(run, /gh release upload "v\$VERSION" --repo "\$\{\{ github\.repository \}\}" mac-proof\.zip --clobber/);
  assert.equal(run.match(/gh release upload/g)?.length, 1);
  assert.doesNotMatch(run, /latest\.json|\.sig\b|\.dmg|\.app\b|TAURI_SIGNING/);
});

test("latest.json never names the Mac proof (or anything but the six Windows/Linux installers)", () => {
  // Run the real manifest builder over a release that carries mac-proof.zip (and even a stray signature for it).
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
