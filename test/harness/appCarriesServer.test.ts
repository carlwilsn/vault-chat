// What a packaged app has to carry to work with no box.
//
// With no box the app runs the vault-chat server itself, on loopback
// (src-tauri/src/local_server.rs). That server is a Node bundle — so a fresh
// Windows or Linux machine, which has neither Node nor the bundle, could only
// be told "connect a box instead". That is the one thing Carl should not have
// to do: "install, sign in, pick a vault, chat".
//
// The build is what fixes it, and a build is not something these tests run. So
// what is pinned here is the wiring: that the prebuild fetches both, and that
// the bundle ships both — the two ways this silently goes back to being broken.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const pkg = JSON.parse(read("package.json"));
const conf = JSON.parse(read("src-tauri/tauri.conf.json"));

test("the prebuild fetches the Node runtime and packs the server", () => {
  const pre = pkg.scripts["predev:tauri"];
  assert.ok(pre, "the Tauri prebuild hook is what runs before every build");
  assert.match(pre, /download-node\.mjs/, "the runtime the server runs on");
  assert.match(pre, /pack-server-into-app\.mjs/, "and the server itself, built from this commit");
  // It is the hook the build really uses, not a script nobody calls.
  assert.match(conf.build.beforeBuildCommand, /predev:tauri/);
});

test("the bundle ships them, beside the LaTeX engine it already shipped", () => {
  // The server bundle is the same file everywhere, so it sits in the shared
  // config; the runtime is not, so it sits in each platform's own. (Naming
  // both `binaries/node` and `binaries/node.exe` in the shared config was what
  // stopped v0.7.91 building at all — see releaseResources.test.ts, which pins
  // the shape of this, and the assertion below that it has not come back.)
  const res: string[] = conf.bundle.resources;
  assert.ok(res.includes("binaries/vault-chat-server.mjs"), `the server bundle is not shipped: ${res}`);
  assert.ok(!res.some((r) => /binaries\/node/.test(r)), `the runtime belongs in a platform config: ${res}`);
  const win: string[] = JSON.parse(read("src-tauri/tauri.windows.conf.json")).bundle.resources;
  const linux: string[] = JSON.parse(read("src-tauri/tauri.linux.conf.json")).bundle.resources;
  assert.ok(win.includes("binaries/node.exe"), "Windows carries node.exe");
  assert.ok(linux.includes("binaries/node"), "Linux carries node");
  for (const list of [win, linux]) assert.ok(list.includes("binaries/vault-chat-server.mjs"), "and the server with it");
});

test("the pinned Node is a real published version, named in one place", () => {
  const src = read("scripts/download-node.mjs");
  const version = src.match(/const NODE_VERSION = "([\d.]+)"/)?.[1];
  assert.ok(version, "the version is pinned, not 'latest'");
  assert.match(version!, /^\d+\.\d+\.\d+$/);
  // Checked against Node's own published sums before it is installed: a
  // truncated download must not become the runtime every no-box turn runs on.
  assert.match(src, /SHASUMS256\.txt/);
  assert.match(src, /sha256 mismatch/);
});

test("the Rust side looks for both where the build puts them", () => {
  const rs = read("src-tauri/src/local_server.rs");
  assert.match(rs, /binaries\/vault-chat-server\.mjs/, "the bundle, in the resource dir");
  assert.match(rs, /pub fn node_bin/, "and the runtime");
  assert.match(rs, /VC_LOCAL_SERVER_NODE/, "with a way to point at another one");
  // The app must not have gone back to assuming a Node on PATH.
  const lib = read("src-tauri/src/lib.rs");
  assert.match(lib, /local_server::node_bin\(/, "the command asks for the carried one");
});

test("and asks the server it started whether it is up without borrowing a program", () => {
  // The carried Node and bundle are the whole point: this machine has nothing.
  // The readiness probe used to run `curl`, which is one more thing the machine
  // may not have — and on the release's own test container it did not: the
  // server came up, every probe failed on the missing program, and 90 s later
  // the app told its owner to connect a box while its own server answered.
  const rs = read("src-tauri/src/local_server.rs");
  assert.doesNotMatch(rs, /Command::new\("curl"\)/, "the probe shelled out to curl again");
  assert.match(rs, /reqwest::blocking/, "it asks in-process");
});
