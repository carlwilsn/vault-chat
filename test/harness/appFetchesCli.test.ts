// The app gets Claude Code itself.
//
// Carl's setup is "install vault-chat, sign in, pick a vault". On his Windows
// laptop it was not: the sign-in only worked because he had separately
// installed Claude Code, and the box only ran it because one was copied in by
// hand. So the app fetches the pinned CLI for its platform when there is none.
//
// What is pinned here is the wiring: that the version it fetches is the version
// the rest of vault-chat runs, and that what it fetches is found by both the
// sign-in and the server. The fetch itself lives in the server bundle
// (server/engine/claude/cliFetch.ts, tested in server/test/cliFetch.test.ts);
// the shell only runs it (src-tauri/src/claude_cli.rs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const rs = read("src-tauri/src/claude_cli.rs");
const ts = read("server/engine/claude/cliFetch.ts");

test("the CLI the app fetches is the CLI the rest of vault-chat runs", () => {
  const pinned = ts.match(/export const CLI_VERSION = "([\d.]+)"/)?.[1];
  assert.ok(pinned, "the version is pinned in one place");
  const pkg = JSON.parse(read("package.json"));
  const sdk = String(pkg.dependencies["@anthropic-ai/claude-agent-sdk"]).replace(/^[^\d]*/, "");
  assert.equal(pinned, sdk, "the fetched CLI and the SDK's own CLI must be the same build");
});

test("every machine the app ships for has a CLI to fetch", () => {
  for (const want of ["win32-x64", "darwin-arm64", "darwin-x64", "linux-x64"]) {
    assert.ok(ts.includes(`"${want}"`), `no package for ${want}`);
  }
  assert.match(ts, /registry\.npmjs\.org/, "from the registry the SDK itself pins");
});

test("a download is checked before it becomes the thing every turn runs on", () => {
  assert.match(ts, /sha512-/, "against the hash npm publishes for that exact version");
  assert.match(ts, /did not match what npm published/);
  // And it has to actually run here before it replaces anything.
  assert.match(ts, /would not run here/);
});

test("what it fetches is what the sign-in and the server then use", () => {
  // One environment variable, honoured by every lookup, so there is one copy.
  assert.match(rs, /VC_CLAUDE_BIN/);
  assert.match(read("src-tauri/src/lib.rs"), /claude_cli::adopt/, "and it is picked up at startup, not only after a fetch");
  assert.match(read("server/engine/claude/install.ts"), /VC_CLAUDE_BIN/, "the server reads the same one");
  assert.match(read("src-tauri/src/claude_login.rs"), /VC_CLAUDE_BIN/, "and so does the lookup Settings shows");
});

test("the sign-in offers to get one, and never downloads by itself", () => {
  const ui = read("src/ClaudeCodeSignIn.tsx");
  // 350 MB is his decision: the surface asks whether there is one, and only
  // fetches when he says so. (What the command then reads is pinned in
  // claudeSignIn.test.ts, which can import the module.)
  assert.match(ui, /claude_setup_token_cli/, "it asks whether this machine has one");
  assert.match(ui, /data-el="claude-cli-get"/, "and offers to get one when it has not");
  const effect = ui.slice(ui.indexOf("useEffect("), ui.indexOf("const command ="));
  assert.doesNotMatch(effect, /ensureCli/, "nothing downloads Claude Code just because Settings was opened");
});

test("the shell runs the fetch from the server bundle (the slot's, then the installer's), it does not carry it", () => {
  assert.match(rs, /"fetch-claude-cli"/, "the shell starts the server bundle's fetch-claude-cli");
  assert.match(rs, /server_bundles/, "from the server bundles the app can run, the slot's first");
  assert.doesNotMatch(rs, /registry\.npmjs\.org|Sha512|reqwest/, "no download logic is left in the shell");
  assert.match(read("server/build.mjs"), /process\.argv\[2\] === "fetch-claude-cli"[\s\S]*cliFetch/, "the bundle's entry routes it without loading the server");
});
