import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");
const { buildSync } = require("esbuild");
const root = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const workflow = yaml.load(read(".github/workflows/ship.yml"));
const steps = workflow.jobs.prepare.steps;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const run = (cwd: string, script: string, env = {}) => spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
function put(cwd: string, path: string, text: string) { mkdirSync(resolve(cwd, path, ".."), { recursive: true }); writeFileSync(join(cwd, path), text); }
function commit(cwd: string, title: string) { git(cwd, "add", "."); git(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", title); return git(cwd, "rev-parse", "HEAD"); }
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "vc-ci-tag-only-"));
  const box = join(dir, "box"), remote = join(dir, "github.git"), ci = join(dir, "ci");
  mkdirSync(box); git(box, "init", "-b", "main");
  put(box, "package.json", '{\n  "version": "0.7.22",\n  "scripts": {"test":"safe"}\n}\n');
  put(box, "src-tauri/tauri.conf.json", '{\n  "version": "0.7.22",\n  "productName": "Fixture"\n}\n');
  put(box, "src-tauri/Cargo.toml", '[package]\nname = "fixture"\nversion = "0.7.22"\n');
  put(box, "server/config.ts", read("server/config.ts"));
  put(box, "server/voicePorts.ts", read("server/voicePorts.ts"));
  const base = commit(box, "old accepted source"); git(box, "tag", "v0.7.22");
  git(dir, "init", "--bare", "--initial-branch=main", remote);
  git(box, "remote", "add", "origin", remote); git(box, "push", "origin", "main", "--tags");
  git(dir, "clone", "--no-local", remote, ci);
  return { dir, box, remote, ci, base };
}
function bump(cwd: string) { return execFileSync(process.execPath, [join(root, "scripts/bump-version.mjs")], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function stamp(f: ReturnType<typeof fixture>, source: string, main = source) {
  git(f.ci, "fetch", "origin", "--tags"); git(f.ci, "checkout", "--detach", source);
  const output = join(f.dir, "bump-output"); writeFileSync(output, "");
  const bumpStep = steps.find((s: any) => s.id === "bump").run.replace("node scripts/bump-version.mjs", `'${process.execPath}' '${join(root, "scripts/bump-version.mjs")}'`);
  const result = run(f.ci, bumpStep, { GITHUB_SHA: source, GITHUB_OUTPUT: output });
  assert.equal(result.status, 0, result.stderr);
  const version = readFileSync(output, "utf8").trim().split("=")[1];
  const script = steps.find((s: any) => s.id === "push").run.replaceAll("${{ steps.bump.outputs.version }}", version);
  const pushed = run(f.ci, script, { GITHUB_SHA: source, GITHUB_OUTPUT: output });
  assert.equal(pushed.status, 0, pushed.stderr);
  const child = git(f.ci, "rev-parse", "HEAD");
  assert.equal(git(f.ci, "rev-parse", "HEAD^"), source);
  assert.equal(git(f.dir, "--git-dir", f.remote, "rev-parse", "main"), main);
  assert.equal(git(f.dir, "--git-dir", f.remote, "rev-parse", `refs/tags/v${version}^{commit}`), child);
  assert.deepEqual(git(f.ci, "diff", "--name-only", source, child).split("\n"), ["package.json", "src-tauri/Cargo.toml", "src-tauri/tauri.conf.json"]);
  for (const path of ["package.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml"]) {
    const before = git(f.ci, "show", `${source}:${path}`), after = git(f.ci, "show", `${child}:${path}`);
    assert.equal(after, before.replace(path.endsWith(".json") ? /("version"\s*:\s*)"[^"]+"/ : /^(version\s*=\s*)"[^"]+"/m, `$1"${version}"`));
  }
  assert.equal(git(f.ci, "status", "--porcelain"), "");
  return { version, child, script };
}

test("CI pins accepted input, pushes ONLY the metadata child tag and builds that real child", () => {
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.equal(steps.find((s: any) => s.uses?.startsWith("actions/checkout@")).with.ref, "${{ github.sha }}");
  assert.equal(workflow.jobs.prepare.outputs.sha, "${{ steps.push.outputs.sha }}");
  const pushes: string[] = [];
  for (const [name, job] of Object.entries<any>(workflow.jobs)) {
    for (const step of job.steps) if (step.run) {
      assert.doesNotMatch(step.run, /git\s+(?:pull|rebase|merge|reset|branch)|HEAD:main|refs\/heads\/main|push[^\n]*(?:--force|--all|--mirror)/);
      pushes.push(...(step.run.match(/git push[^\n]*/g) ?? []));
    }
    if (name !== "prepare") assert.equal(job.steps.find((s: any) => s.uses?.startsWith("actions/checkout@")).with.ref, "${{ needs.prepare.outputs.sha }}");
  }
  assert.deepEqual(pushes, ['git push origin "refs/tags/v${{ steps.bump.outputs.version }}"']);
  const draft = steps.find((s: any) => s.id === "draft");
  assert.equal(draft.env.SHA, "${{ steps.push.outputs.sha }}"); assert.match(draft.run, /target_commitish="\$SHA"/);
  assert.equal(workflow.jobs.build_server.steps.find((s: any) => s.name === "Build the server bundle").env.VC_REV, "${{ needs.prepare.outputs.sha }}");
  assert.match(read("server/build.mjs"), /__VC_REV__: JSON.stringify\(rev\)/);
  assert.match(read("scripts/build-server-release.mjs"), /compiled.version !== version \|\| compiled.rev !== rev/);
});

test("RED: old CI metadata push to main forks the next accepted candidate", () => {
  const f = fixture();
  try {
    put(f.box, "feature.txt", "A\n"); const a = commit(f.box, "accepted A"); git(f.box, "push", "origin", "main");
    git(f.ci, "fetch", "origin"); git(f.ci, "checkout", "--detach", a);
    const version = bump(f.ci);
    const script = read("test/harness/fixtures/old-ci-version-push.sh").replaceAll("${{ steps.bump.outputs.version }}", version);
    const old = run(f.ci, script, { GITHUB_OUTPUT: join(f.dir, "old-output") }); assert.equal(old.status, 0, old.stderr);
    put(f.box, "feature.txt", "B\n"); const b = commit(f.box, "accepted B");
    const ff = spawnSync("git", ["push", "origin", "main"], { cwd: f.box, encoding: "utf8" });
    assert.notEqual(ff.status, 0); assert.match(ff.stderr!, /rejected/);
    git(f.box, "fetch", "origin");
    assert.equal(spawnSync("git", ["merge-base", "--is-ancestor", git(f.ci, "rev-parse", "HEAD"), b], { cwd: f.box }).status, 1);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("GREEN: A and B source main fast-forward; sibling metadata tags build with truthful clean identities", () => {
  const f = fixture();
  try {
    let previous = f.base;
    for (let n = 1; n <= 2; n++) {
      put(f.box, "feature.txt", `${n}\n`); const accepted = commit(f.box, `accepted ${n}`);
      assert.equal(git(f.box, "merge-base", previous, accepted), previous);
      git(f.box, "push", "origin", "main");
      const { version, child, script } = stamp(f, accepted);
      assert.equal(version, `0.7.${22 + n}`); assert.notEqual(child, accepted);
      const executable = join(f.dir, `build-info-${n}.mjs`);
      buildSync({ stdin: { contents: 'import { SERVER_VERSION, SERVER_REV } from "./server/config"; console.log(JSON.stringify({version:SERVER_VERSION,rev:SERVER_REV}));', resolveDir: f.ci, loader: "ts" }, outfile: executable, bundle: true, platform: "node", format: "esm", define: { __VC_VERSION__: JSON.stringify(version), __VC_REV__: JSON.stringify(child) } });
      assert.deepEqual(JSON.parse(execFileSync(process.execPath, [executable], { encoding: "utf8" })), { version, rev: child });
      // Retry cannot force or overwrite an immutable release tag.
      const collision = run(f.ci, script, { GITHUB_SHA: accepted, GITHUB_OUTPUT: join(f.dir, "retry") });
      assert.notEqual(collision.status, 0); assert.equal(git(f.dir, "--git-dir", f.remote, "rev-parse", "main"), accepted);
      const output = join(f.dir, "changes"); writeFileSync(output, "");
      const unchanged = run(f.ci, steps.find((s: any) => s.id === "changes").run, { GITHUB_OUTPUT: output, GITHUB_EVENT_NAME: "push" });
      assert.equal(unchanged.status, 0, unchanged.stderr); assert.match(readFileSync(output, "utf8"), /has_changes=false/);
      writeFileSync(output, "");
      const manual = run(f.ci, steps.find((s: any) => s.id === "changes").run, { GITHUB_OUTPUT: output, GITHUB_EVENT_NAME: "workflow_dispatch" });
      assert.equal(manual.status, 0, manual.stderr); assert.match(readFileSync(output, "utf8"), /has_changes=true/);
      previous = accepted;
    }
    assert.equal(git(f.dir, "--git-dir", f.remote, "for-each-ref", "--format=%(refname)", "refs/heads"), "refs/heads/main");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("CI started for A never rebases onto or overwrites already-accepted B main", () => {
  const f = fixture();
  try {
    put(f.box, "feature.txt", "A\n"); const a = commit(f.box, "accepted A"); git(f.box, "push", "origin", "main");
    put(f.box, "feature.txt", "B\n"); const b = commit(f.box, "accepted B"); git(f.box, "push", "origin", "main");
    const release = stamp(f, a, b);
    assert.equal(git(f.ci, "show", `${release.child}:feature.txt`), "A");
    assert.equal(git(f.dir, "--git-dir", f.remote, "rev-parse", "main"), b);
    assert.equal(stamp(f, b).version, "0.7.24");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("exact native rollback tree at old v22 ships a fresh v26 child above all tags, without source edits", () => {
  const f = fixture();
  try {
    put(f.box, "feature.txt", "A\n"); const a = commit(f.box, "accepted A"); git(f.box, "push", "origin", "main"); stamp(f, a);
    put(f.box, "feature.txt", "B\n"); const b = commit(f.box, "accepted B"); git(f.box, "push", "origin", "main"); const built = stamp(f, b);
    git(f.ci, "tag", "v0.7.25", built.child); git(f.ci, "tag", "v0.7.25-rc.9", built.child); git(f.ci, "push", "origin", "--tags");
    git(f.box, "revert", "--no-commit", `${f.base}..${b}`);
    const nativeTree = git(f.box, "write-tree"); assert.equal(nativeTree, git(f.box, "rev-parse", `${f.base}^{tree}`));
    const rollback = commit(f.box, "native exact source rollback");
    assert.equal(git(f.box, "rev-list", "--parents", "-n", "1", rollback), `${rollback} ${b}`);
    assert.equal(git(f.box, "rev-parse", `${rollback}^{tree}`), nativeTree);
    git(f.box, "push", "origin", "main"); const release = stamp(f, rollback);
    assert.equal(release.version, "0.7.26");
    assert.equal(git(f.box, "rev-parse", "HEAD^{tree}"), nativeTree);
    assert.equal(JSON.parse(git(f.box, "show", "HEAD:package.json")).version, "0.7.22");
    assert.equal(git(f.ci, "diff", rollback, release.child, "--", "feature.txt", "server/config.ts"), "");
    assert.equal(git(f.ci, "status", "--porcelain"), "");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("version selection handles global prerelease maximum and rollover; mismatches fail before writes", () => {
  const f = fixture();
  try {
    git(f.box, "tag", "v0.7.99-rc.1"); git(f.box, "tag", "vnot-a-version");
    assert.equal(bump(f.box), "0.8.0");
    git(f.box, "restore", ".");
    put(f.box, "src-tauri/Cargo.toml", '[package]\nversion = "9.9.9"\n');
    const before = readFileSync(join(f.box, "package.json"), "utf8");
    assert.throws(() => bump(f.box), /same valid version/);
    assert.equal(readFileSync(join(f.box, "package.json"), "utf8"), before);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
