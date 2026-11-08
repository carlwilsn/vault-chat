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
  const res: string[] = conf.bundle.resources;
  assert.ok(res.includes("binaries/vault-chat-server.mjs"), `the server bundle is not shipped: ${res}`);
  // Both names: the build that runs produces one of them, and a resource that
  // matches nothing is simply not copied.
  assert.ok(res.includes("binaries/node"), "Linux has no .exe");
  assert.ok(res.includes("binaries/node.exe"), "Windows has nothing else");
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
