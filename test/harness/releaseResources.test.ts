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
  // Content keeps clear of the traffic lights: the title bar and, with no title bar, the full-screen chat's frame.
  assert.match(read("src/macChrome.ts"), /TRAFFIC_LIGHTS_INSET = \{ left: 76, top: 36 \}/);
  assert.match(read("src/macChrome.ts"), /macBarInset[^=]*= isMac \? \{ paddingLeft: TRAFFIC_LIGHTS_INSET\.left \}/);
  assert.match(read("src/plugins/titlebar/Bar.tsx"), /style=\{macBarInset\}/);
  assert.match(read("src/Titlebar.tsx"), /style=\{macBarInset\}/);
  assert.match(read("src/plugins/chat/Frame.tsx"), /height: TRAFFIC_LIGHTS_INSET\.top/);
});

const macCheck = () => yaml.load(read(".github/workflows/mac-check.yml")) as any;

test("the macOS job checks a build and publishes nothing", () => {
  const wf = yaml.load(read(".github/workflows/ship.yml")) as any;
  // ship.yml calls the Mac check (mac-check.yml) on arm64, and nothing waits for it.
  const call = wf.jobs.build_macos;
  assert.equal(call.uses, "./.github/workflows/mac-check.yml");
  assert.deepEqual(call.with, { sha: "${{ needs.prepare.outputs.sha }}", version: "${{ needs.prepare.outputs.version }}", runner: "macos-15" });
  for (const [name, job] of Object.entries<any>(wf.jobs)) assert.ok(![job.needs ?? []].flat().includes("build_macos"), `${name} must never wait for the Mac job`);
  const mc = macCheck();
  const mac = mc.jobs.build_macos;
  assert.equal(mac["continue-on-error"], true);
  assert.equal(mc.jobs.mac_proof["continue-on-error"], true);
  assert.equal(mac["runs-on"], "${{ needs.pick.outputs.runner }}");
  const text = JSON.stringify(mac);
  // The Mac runner never holds the updater key and uploads nothing itself (mac_publish, on Linux, does).
  assert.doesNotMatch(text, /gh release|tauri-action|TAURI_SIGNING|releaseId|latest\.json/);
  assert.match(text, /createUpdaterArtifacts\\":false/);
  assert.doesNotMatch(read("scripts/build-updater-manifest.mjs"), /darwin/);
});

test("the macOS job self-tests the app on a fresh HOME and the Mac path hazards, and says so in its summary", () => {
  const steps = macCheck().jobs.build_macos.steps as { name?: string; run?: string; if?: string }[];
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
  const job = macCheck().jobs.mac_proof;
  assert.deepEqual(job.needs, ["pick", "build_macos"]);
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

test("a hung or runnerless Mac job still yields a readable mac-proof.zip", () => {
  const wf = macCheck();
  const steps = wf.jobs.build_macos.steps as any[];
  // Every long step fails on its own clock, well inside the job's.
  for (const name of [/^Build the \.app/, /^Launch it/, /^Self-test the app/, /^Self-test tour/, /^Package the \.dmg/]) {
    const s = steps.find((x) => name.test(x.name ?? ""));
    assert.ok(s && s["timeout-minutes"] > 0 && s["timeout-minutes"] < wf.jobs.build_macos["timeout-minutes"], String(name));
  }
  const status = steps.findIndex((s) => /status\.txt/.test(s.name ?? ""));
  const upload = steps.findIndex((s) => s.uses?.startsWith("actions/upload-artifact"));
  assert.ok(status >= 0 && status < upload && steps[status].if === "always()");
  // mac_proof: a missing artifact is not fatal, and the zip says what GitHub saw.
  const job = wf.jobs.mac_proof;
  const dl = job.steps.find((s: any) => s.uses?.startsWith("actions/download-artifact"));
  assert.equal(dl["continue-on-error"], true);
  const run = job.steps.map((s: any) => s.run ?? "").join("\n");
  assert.match(run, /mkdir -p mac-proof/);
  assert.match(run, /never gave this job a macOS runner/);
  // No arm64 runner: the same check is dispatched on Intel for the same tag, once (never from the Intel run).
  const fb = job.steps.find((s: any) => /Intel/.test(s.name ?? ""));
  assert.equal(fb.env.FALLBACK, "macos-15-intel");
  assert.match(fb.run, /grep -q "\^runner: NONE" mac-proof\/job\.txt && \[ "\$RUNNER_LABEL" != "\$FALLBACK" \]/);
  assert.match(fb.run, /gh workflow run mac-check\.yml --repo "\$REPO" --ref main -f tag="v\$VERSION" -f runner="\$FALLBACK"/);
  assert.equal(job.permissions.actions, "write");
  assert.ok(wf.on.workflow_dispatch.inputs.runner.options.includes("macos-15-intel"));
  // The proof says which runner and arch it ran on.
  assert.match(JSON.stringify(steps[status]), /runner label \$RUNNER_LABEL.*arch \$\(uname -m\)/);
  assert.match(run, /runner label: %s/);
});

test("the Mac job asks for a MacBook-like display before the launch, and says what it got", () => {
  const steps = macCheck().jobs.build_macos.steps as any[];
  const d = steps.findIndex((s) => s.id === "display");
  const launch = steps.findIndex((s) => s.id === "launch");
  assert.ok(d >= 0 && d < launch);
  assert.equal(steps[d]["continue-on-error"], true);
  assert.match(steps[d].run, /displayplacer list/);
  assert.match(steps[launch].run, /display-final\.txt.*checks\.txt/);
  const pick = (list: string) => execFileSync("python3", [join(root, "scripts/macos-pick-display-mode.py")], { input: list, encoding: "utf8" }).trim();
  const head = "Persistent screen id: S1\nResolutions for rotation 0:\n  mode 0: res:1024x768 hz:60 color_depth:8 <-- current mode\n";
  assert.equal(pick(head + "  mode 1: res:1920x1080 hz:60 color_depth:8\n  mode 2: res:1440x900 hz:60 color_depth:8 scaling:on\n"), "id:S1 mode:2");
  assert.equal(pick(head + "  mode 1: res:1920x1080 hz:60 color_depth:8\n  mode 3: res:1280x800 hz:60 color_depth:8\n"), "id:S1 mode:1");
  assert.equal(pick(head), "");
  // The picker is fetched from the workflow's own commit when the checked tag predates it.
  assert.match(steps[d].run, /\$GITHUB_WORKFLOW_SHA\/scripts\/\$1/);
  assert.match(steps[d].run, /helper macos-virtual-display\.m/);
  assert.match(steps[d].run, /helper macos-pick-display-mode\.py/);
  // The virtual display asks for a 1440x900-point HiDPI screen and makes it the main one.
  const vd = read("scripts/macos-virtual-display.m");
  assert.match(vd, /s\.hiDPI = 1;/);
  assert.match(vd, /CGConfigureDisplayOrigin\(cfg, vid, 0, 0\)/);
});

test("the tour is recorded in pieces that end by themselves, never stopped by a signal", () => {
  const tour = (macCheck().jobs.build_macos.steps as any[]).find((s) => s.id === "tour").run as string;
  assert.match(tour, /screencapture -v -V 180 -x "\$f"/);
  assert.doesNotMatch(tour, /kill -INT "\$REC"/);
});

test("a Mac update is published only from a Mac job where every check passed on Apple Silicon, signed off the Mac runner", () => {
  const ship = yaml.load(read(".github/workflows/ship.yml")) as any;
  assert.equal(ship.jobs.build_macos.secrets, "inherit", "mac-check's mac_publish needs the updater key");
  const wf = macCheck();
  const steps = wf.jobs.build_macos.steps as any[];
  // continue-on-error hides a failed job from `needs`: the gate is the output set by the LAST step, behind success().
  assert.equal(wf.jobs.build_macos.outputs.passed, "${{ steps.passed.outputs.passed }}");
  const passed = steps.findIndex((s) => s.id === "passed");
  assert.equal(passed, steps.length - 1);
  assert.equal(steps[passed].if, "success()");
  for (const id of [/^Self-test the app/, /^Self-test tour/, /^Launch it/, /^Package the \.dmg/]) assert.ok(steps.findIndex((s) => id.test(s.name ?? "")) < passed, String(id));
  const handOn = steps.filter((s) => s.uses?.startsWith("actions/upload-artifact") && s.with.name === "macos-update");
  assert.equal(handOn.length, 1);
  assert.equal(handOn[0].if, "success()");
  // The bundle is packed from the .app BEFORE the checks run on it: what passed is what ships.
  const pack = steps.findIndex((s) => s.id === "pack_update");
  assert.ok(pack > steps.findIndex((s) => s.id === "build_app") && pack < steps.findIndex((s) => s.id === "launch"));
  const pub = wf.jobs.mac_publish;
  assert.deepEqual(pub.needs, ["pick", "build_macos"]);
  assert.match(pub.if, /needs\.build_macos\.outputs\.passed == 'true'/);
  assert.match(pub.if, /needs\.build_macos\.outputs\.arch == 'aarch64'/, "an Intel fallback run publishes nothing");
  assert.doesNotMatch(pub.if, /always\(\)/);
  assert.equal(pub.steps.find((s: any) => s.uses?.startsWith("actions/checkout@")).with.ref, "${{ needs.pick.outputs.ref }}");
  const run = pub.steps.map((s: any) => s.run ?? "").join("\n");
  assert.match(run, /npx tauri signer sign "mac-update\/\$BUNDLE"/);
  assert.match(JSON.stringify(pub), /secrets\.TAURI_SIGNING_PRIVATE_KEY/);
  assert.doesNotMatch(run, /latest\.json|latest-mac\.json|mac-stable/, "publishing never moves any updater's manifest");
  const uploads = run.match(/gh release upload[^\n]*/g) ?? [];
  assert.equal(uploads.length, 2);
  assert.match(uploads[1]!, /mac-update\/mac-update\.json$/, "mac-update.json goes last: its presence means the Mac files are complete");
  // Nothing else touches the Mac files or the friend manifest.
  for (const [name, job] of [...Object.entries<any>(wf.jobs), ...Object.entries<any>(ship.jobs)]) if (name !== "mac_publish") assert.doesNotMatch(JSON.stringify(job.steps ?? []), /mac-update\.json|\.app\.tar\.gz\.sig|latest-mac/, name);
});

test("latest.json never has a darwin entry, even with the Mac update's signature on the release", () => {
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
  // The shared config's updater reads latest.json; only the Mac config points elsewhere, at the friend manifest.
  assert.deepEqual(json("src-tauri/tauri.conf.json").plugins.updater.endpoints, ["https://github.com/carlwilsn/vault-chat/releases/latest/download/latest.json"]);
  assert.deepEqual(macos.plugins.updater.endpoints, ["https://github.com/carlwilsn/vault-chat/releases/download/mac-stable/latest-mac.json"]);
  assert.equal(macos.plugins.updater.pubkey, undefined, "the merge keeps the one updater key");
  for (const f of ["tauri.windows.conf.json", "tauri.linux.conf.json"]) assert.equal(json(`src-tauri/${f}`).plugins?.updater, undefined, f);
});

test("mac-update.json: darwin only, signed, pointing into its own release", () => {
  const dir = mkdtempSync(join(tmpdir(), "vc-mac-manifest-"));
  try {
    const v = "9.9.9";
    writeFileSync(join(dir, "arch.txt"), "aarch64\n");
    const env = { ...process.env, VERSION: v, NOTES: "n", GITHUB_REPOSITORY: "o/r", DIR: dir };
    // No signature: no manifest.
    assert.throws(() => execFileSync(process.execPath, [join(root, "scripts/build-mac-manifest.mjs")], { env, stdio: "pipe" }));
    writeFileSync(join(dir, `vault-chat_${v}_aarch64.app.tar.gz.sig`), "SIG\n");
    execFileSync(process.execPath, [join(root, "scripts/build-mac-manifest.mjs")], { env, stdio: "pipe" });
    const m = JSON.parse(readFileSync(join(dir, "mac-update.json"), "utf8"));
    assert.equal(m.version, v);
    assert.deepEqual(Object.keys(m.platforms).sort(), ["darwin-aarch64", "darwin-aarch64-app"]);
    assert.deepEqual(m.platforms["darwin-aarch64"], { signature: "SIG", url: `https://github.com/o/r/releases/download/v${v}/vault-chat_${v}_aarch64.app.tar.gz` });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a promotion (mac-promote) re-checks the release and never moves the friend back", async () => {
  const { promoteManifest } = await import(join(root, "scripts/mac-promote.mjs"));
  const entry = (v: string) => ({ signature: "S", url: `https://github.com/o/r/releases/download/v${v}/vault-chat_${v}_aarch64.app.tar.gz` });
  const cand = (v: string) => ({ version: v, notes: "", platforms: { "darwin-aarch64": entry(v) } });
  assert.equal(typeof promoteManifest("1.0.2", cand("1.0.2"), { version: "1.0.0" }, "o/r"), "object");
  assert.equal(typeof promoteManifest("1.0.2", cand("1.0.2"), null, "o/r"), "object");
  assert.match(promoteManifest("1.0.2", null, null, "o/r"), /Mac checks did not pass/);
  assert.match(promoteManifest("1.0.2", cand("1.0.2"), { version: "1.0.2" }, "o/r"), /never the same or older/);
  assert.match(promoteManifest("1.0.2", cand("1.0.2"), { version: "1.0.10" }, "o/r"), /never the same or older/);
  assert.match(promoteManifest("1.0.3", cand("1.0.2"), null, "o/r"), /says v1\.0\.2/);
  assert.match(promoteManifest("1.0.2", { ...cand("1.0.2"), platforms: { "windows-x86_64": entry("1.0.2") } }, null, "o/r"), /only darwin/);
  assert.match(promoteManifest("1.0.2", { ...cand("1.0.2"), platforms: { "darwin-aarch64": entry("1.0.1") } }, null, "o/r"), /points outside/);
  const wf = yaml.load(read(".github/workflows/mac-promote.yml")) as any;
  assert.deepEqual(wf.on.push.tags, ["mac-friend-v*"]);
  const run = wf.jobs.promote.steps.map((s: any) => s.run ?? "").join("\n");
  assert.match(run, /node scripts\/mac-promote\.mjs/);
  assert.match(run, /--prerelease --latest=false/, "mac-stable never becomes the latest release");
  assert.match(run, /gh release upload mac-stable [^\n]*latest-mac\.json/);
  assert.doesNotMatch(run, /releases\/latest/);
});

test("the Mac app never installs an update by itself; Settings has Check for updates", () => {
  const banner = read("src/UpdateBanner.tsx");
  assert.match(banner, /const unattended = isRunInBackground\(\) && !isMacApp;/);
  assert.match(banner, /if \(unattended && !asked\) await applyUnattended/);
  assert.match(banner, /export const CHECK_UPDATES_EVENT = "vc:check-updates";/);
  assert.match(read("src/plugins/settings/Pane.tsx"), /onClick=\{\(\) => window\.dispatchEvent\(new Event\("vc:check-updates"\)\)\}/);
});
