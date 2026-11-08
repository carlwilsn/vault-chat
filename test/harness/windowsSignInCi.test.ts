// The Windows sign-in proof: that it is set up to prove something.
//
// Three releases claimed "Sign in with Claude works on Windows" and three
// failed on Carl's laptop, because the driver is a pty around a real claude.exe
// and nothing on Linux can tell you how that behaves. So the proof is a job on
// windows-latest driving the real CLI
// (.github/workflows/windows-signin.yml) — and the thing that can quietly rot
// is not the fix, it is the proof: a live test compiled out on Windows, or a
// green job that ran no test at all.
//
// What is pinned here is therefore the shape of the proof, not the sign-in: the
// job runs on Windows, installs the CLI where a laptop has it, and refuses to
// pass a run in which the live test did not happen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");
const root = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const LIVE_TEST = "a_real_setup_token_hands_over_a_sign_in_url";
const wf = yaml.load(read(".github/workflows/windows-signin.yml")) as any;
const job = wf.jobs.sign_in;
const steps = job.steps as { name?: string; uses?: string; run?: string; shell?: string }[];
const runs = steps.map((s) => s.run ?? "").join("\n");

test("the proof runs on Windows, by hand or whenever the driver changes", () => {
  assert.equal(job["runs-on"], "windows-latest", "a Linux runner proves nothing about this");
  const on = wf.on ?? wf[true as unknown as string];
  assert.ok("workflow_dispatch" in on, "it has to be runnable on demand");
  assert.deepEqual(on.push.paths.includes("src-tauri/src/claude_login.rs"), true, "touching the driver re-runs the proof");
  assert.ok(job["timeout-minutes"] > 0 && job["timeout-minutes"] <= 60, "a hung pty must not hold a runner all day");
});

test("it installs Claude Code where a laptop really has it, and drives that one", () => {
  // ~/.local/bin/claude.exe is what the official installer leaves and what
  // Carl's laptop has; it is also the path the old lookup never tried.
  assert.match(runs, /\.local\\bin\\claude\.exe/, "the installed path a laptop has");
  assert.match(runs, /install\.ps1/, "the real installer, not an npm shim");
  assert.match(runs, /VC_CLAUDE_BIN=/, "the driver is pointed at that exact binary");
  assert.match(runs, /cargo test --lib claude_login -- --ignored/, "the real driver, through its live test");
});

test("a run that ran no live test fails instead of passing", () => {
  // The failure this guards against is the quiet one: --ignored with the test
  // compiled out prints "0 passed" and exits 0, and the job would be green
  // having proved nothing.
  assert.match(runs, new RegExp(LIVE_TEST), "the job checks the live test by name");
  assert.match(runs, /test result: ok/, "and that at least one test passed");
  assert.match(runs, /vacuous|proves nothing/i, "and says so when it did not");
});

test("the live test is not compiled out on the platform it exists for", () => {
  const src = read("src-tauri/src/claude_login.rs");
  const at = src.indexOf(`fn ${LIVE_TEST}`);
  assert.ok(at > 0, `${LIVE_TEST} is gone — the Windows job has nothing to run`);
  // The attributes directly above it: #[ignore] is how it is kept out of an
  // ordinary run, but #[cfg(unix)] would take it off Windows entirely, which is
  // how it sat while the button was broken there.
  const attrs = src.slice(0, at).split("\n").slice(-8).join("\n");
  assert.ok(!/#\[cfg\(unix\)\]/.test(attrs), "the live sign-in test must run on Windows too");
  assert.match(attrs, /#\[ignore/, "it still stays out of the ordinary test run");
});

test("the transcript is kept, and a token can never be in it", () => {
  const upload = steps.find((s) => s.uses?.startsWith("actions/upload-artifact"));
  assert.ok(upload, "the log is the evidence; it is uploaded");
  // The log holds a real authorize URL (harmless: PKCE, and nobody completes
  // the login) — but the job refuses a log with a token in it either way.
  assert.match(runs, /sk-ant/, "the run checks its own log for a token");
  assert.match(runs, /a token reached the log/, "and fails loudly if one is there");
});
