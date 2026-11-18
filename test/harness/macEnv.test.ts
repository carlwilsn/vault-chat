// macOS GUI launch: PATH from the login shell + Homebrew, and git without Apple's install dialog.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { GIT_STUB, fixedMacDirs, loginShellPath, macGitState, macGitStatus, mergePath, parseLoginPath, prepareMacEnv, whichGit } from "../../server/macEnv.ts";

test("login PATH is read between markers, ignoring what rc files print", () => {
  assert.deepEqual(parseLoginPath("Welcome!\n__VC_PATH__/opt/homebrew/bin:/usr/bin:relative:/bin__VC_PATH__\nbye"), ["/opt/homebrew/bin", "/usr/bin", "/bin"]);
  assert.deepEqual(parseLoginPath("no markers"), []);
});

test("a real login shell gives its PATH; a hanging or missing shell gives [] within the time limit", () => {
  const sh = fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
  assert.ok(loginShellPath(sh).length > 0);
  assert.deepEqual(loginShellPath("/nonexistent/shell"), []);
  const dir = fs.mkdtempSync(join(os.tmpdir(), "vc-macenv-"));
  try {
    const hang = join(dir, "hang.sh"); fs.writeFileSync(hang, "#!/bin/sh\nsleep 30\n"); fs.chmodSync(hang, 0o755);
    const t = Date.now(); assert.deepEqual(loginShellPath(hang, 500), []); assert.ok(Date.now() - t < 5000);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("merged PATH: login first, then Homebrew/local before launchd's /usr/bin, each once", () => {
  const merged = mergePath(["/Users/f/.nvm/bin", "/usr/bin"], fixedMacDirs("/Users/f"), "/usr/bin:/bin:/usr/sbin:/sbin").split(":");
  assert.deepEqual(merged, ["/Users/f/.nvm/bin", "/usr/bin", "/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/Users/f/.local/bin", "/bin", "/usr/sbin", "/sbin"]);
  // Login shell failed: Homebrew still comes before the stub's /usr/bin.
  const fallback = mergePath([], fixedMacDirs("/Users/f"), "/usr/bin:/bin").split(":");
  assert.ok(fallback.indexOf("/opt/homebrew/bin") < fallback.indexOf("/usr/bin"));
});

test("git state never runs /usr/bin/git: Homebrew git ok, stub ok only with Command Line Tools", () => {
  let asked = 0; const clt = (ok: boolean) => () => { asked++; return ok; };
  assert.equal(macGitState("/opt/homebrew/bin/git", clt(false)), "ok"); assert.equal(asked, 0);
  assert.equal(macGitState("/usr/bin/git", clt(true)), "ok");
  assert.equal(macGitState("/usr/bin/git", clt(false)), "needs-command-line-tools");
  assert.equal(macGitState(null, clt(true)), "missing");
  const have = new Set(["/opt/homebrew/bin/git", "/usr/bin/git"]);
  assert.equal(whichGit("/usr/local/bin:/opt/homebrew/bin:/usr/bin", (p) => have.has(String(p))), "/opt/homebrew/bin/git");
  assert.equal(whichGit("/bin", (p) => have.has(String(p))), null);
});

test("the stand-in git says what to do and fails", () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "vc-macenv-"));
  try {
    const f = join(dir, "git"); fs.writeFileSync(f, GIT_STUB); fs.chmodSync(f, 0o755);
    const r = spawnSync(f, ["status"], { encoding: "utf8" });
    assert.equal(r.status, 127); assert.match(r.stderr, /xcode-select --install/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("off macOS nothing changes", () => {
  const before = process.env.PATH;
  prepareMacEnv("/nonexistent", "linux"); prepareMacEnv("/nonexistent", "win32");
  assert.equal(process.env.PATH, before);
});

test("the stand-in git is first on PATH exactly while the Command Line Tools are missing", () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), "vc-macenv-")), stub = join(dir, "bin");
  const before = process.env.PATH;
  const only = (p: fs.PathLike) => String(p) === "/usr/bin/git";
  try {
    process.env.PATH = "/opt/homebrew/bin:/usr/bin:/bin";
    assert.equal(macGitStatus(stub, () => false, only), "needs-command-line-tools");
    assert.equal(process.env.PATH, `${stub}:/opt/homebrew/bin:/usr/bin:/bin`);
    assert.equal(fs.readFileSync(join(stub, "git"), "utf8"), GIT_STUB);
    assert.equal(macGitStatus(stub, () => false, only), "needs-command-line-tools");
    assert.equal(process.env.PATH, `${stub}:/opt/homebrew/bin:/usr/bin:/bin`, "added once");
    assert.equal(macGitStatus(stub, () => true, only), "ok", "tools installed later");
    assert.equal(process.env.PATH, "/opt/homebrew/bin:/usr/bin:/bin");
  } finally { process.env.PATH = before; fs.rmSync(dir, { recursive: true, force: true }); }
});
