/** One separately installed box entry point. Candidate code only runs in a private network/filesystem.
 * Install this bundle once through Claude; it is never loaded from the submitted branch. */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync, lstatSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CHANGE_GATES, compareChangeGates, type GateReceipt, type ChangeGate } from "./shipGates";
import { HARNESS_REPORTER_SOURCE, VITEST_REPORTER_SOURCE, VITEST_REPORT_PREFIX, parseHarnessReport, parseVitestReport } from "./changeTestReports";
import { withShippingLock, prepareAcceptanceLocked, reconcileAcceptancesLocked } from "./changeShipping";
export { compareChangeGates } from "./shipGates";
import { withRepoLock, git as nativeGit } from "./git";
import { killTree } from "./commands/proc";

export type ShipConfig = {
  repo: string; remote: string; workRoot: string;
  dependencies: string; pi: string;
  node: string; npm: string; bash: string; bwrap: string; path: string;
};
export function checkBranch(branch: string): void {
  if (!/^agent\/[a-z0-9][a-z0-9._/-]{0,100}$/.test(branch) || branch.includes("..") || branch.includes("//") || branch.endsWith("/") || branch.endsWith(".lock")) throw new Error("Expected a pushed agent/<name> branch");
}
/** Argument vectors only; no command text from a branch, tool or client is evaluated on the host. */
function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout = 30 * 60_000, signal?: AbortSignal): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const stop = () => killTree(child.pid);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    const cleanup = () => signal?.removeEventListener("abort", stop);
    let stdout = "", stderr = "", timedOut = false;
    child.stdout.on("data", d => { stdout += d; }); child.stderr.on("data", d => { stderr += d; });
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeout);
    child.once("error", e => { clearTimeout(timer); cleanup(); reject(e); });
    child.once("close", code => { clearTimeout(timer); cleanup(); if (signal?.aborted) { reject(signal.reason); return; } resolve({ exitCode: code ?? -1, stdout, stderr, timedOut }); });
  });
}
function executable(path: string): string {
  const p = realpathSync(path);
  if (!isAbsolute(path) || !lstatSync(p).isFile()) throw new Error("Installed absolute executable required");
  return p;
}
async function snapshot(repo: string, revision: string, dir: string, signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted();
  const git = (cwd: string, args: string[]) => nativeGit(cwd, args, { signal });
  // Inspect links BEFORE extracting a candidate archive on the host. No submodules, absolute/traversing
  // symlinks, or tracked dependency directories. Nothing from .git/config is copied from the agent.
  const entries = (await git(repo, ["ls-tree", "-rz", revision])).split("\0").filter(Boolean);
  const files: string[] = [];
  for (const entry of entries) {
    const tab = entry.indexOf("\t"), [mode, , object] = entry.slice(0, tab).split(" "), name = entry.slice(tab + 1);
    if (!name || isAbsolute(name) || name.split("/").some(p => p === ".." || p === ".git" || p === "node_modules")) throw new Error("Unsafe source path");
    if (mode === "160000") throw new Error("Submodule provisioning unavailable");
    if (mode === "120000") {
      const target = (await git(repo, ["cat-file", "blob", object!])).replace(/\n$/, "");
      if (isAbsolute(target) || !resolve("/source", dirname(name), target).startsWith("/source/")) throw new Error(`Source link escapes snapshot: ${name}`);
    }
    files.push(name);
  }
  mkdirSync(dir);
  // Private clone keeps git-based tests working without sharing mutable metadata or any credentials.
  await git(dirname(dir), ["-c", "core.hooksPath=/dev/null", "clone", "--quiet", "--no-local", "--no-checkout", repo, dir]);
  // Submitted/native-revert heads live under private remote refs, not necessarily local branches.
  // A normal clone only transports branch tips; fetch the already pinned object explicitly.
  await git(dir, ["-c", "core.hooksPath=/dev/null", "fetch", "--quiet", "--no-tags", repo, revision]);
  await git(dir, ["-c", "core.hooksPath=/dev/null", "checkout", "--quiet", "--detach", revision]);
  mkdirSync(join(dir, "node_modules"));
  return files;
}
function gateCommands(o: ShipConfig, gate: ChangeGate): string[][] {
  const node = o.node, bin = "/host/node_modules";
  const tsc = [node, `${bin}/typescript/bin/tsc`];
  switch (gate) {
    case "typecheck:desktop": return [[...tsc, "--noEmit", "-p", "."]];
    case "typecheck:phone": return [[...tsc, "--noEmit", "-p", "phone"]];
    case "typecheck:board": return [[...tsc, "--noEmit", "-p", "board"]];
    case "typecheck:server": return [[...tsc, "-p", "server/tsconfig.json"]];
    case "test:harness": return [[node, "--import", `${bin}/tsx/dist/loader.mjs`, "--import", "./test/harness/register.mjs", "--test", "--test-reporter=/host/harness.mjs", "test/harness/*.test.ts"]];
    case "test:server": return [[node, "server/build.mjs"], [node, `${bin}/vitest/vitest.mjs`, "run", "--config", "server/vitest.config.ts", "--reporter=/host/vitest.mjs"]];
    case "build:server": return [[node, `${bin}/vite/bin/vite.js`, "build", "--config", "phone/vite.config.ts"], [node, `${bin}/vite/bin/vite.js`, "build", "--config", "board/vite.config.ts"], [node, "server/build.mjs", "--phone-app", "--board-app"]];
  }
}
/** Public npm's lock validation/extraction, never candidate install hooks or inherited credentials. */
async function sourceDependencies(o: ShipConfig, source: string, root: string, revision: string, signal?: AbortSignal): Promise<string> {
  const manifest = readFileSync(join(source, "package.json"), "utf8"), lock = readFileSync(join(source, "package-lock.json"), "utf8");
  const fields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "overrides"];
  const installed = JSON.parse(readFileSync(join(o.dependencies, "..", "package.json"), "utf8")), candidate = JSON.parse(manifest);
  if (lock === readFileSync(join(o.dependencies, "..", "package-lock.json"), "utf8") && fields.every(f => JSON.stringify(installed[f]) === JSON.stringify(candidate[f]))) return o.dependencies;
  const parsed = JSON.parse(lock);
  if (parsed.lockfileVersion !== 3 || !parsed.packages) throw new Error("A complete npm lockfile is required");
  for (const [name, value] of Object.entries(parsed.packages) as [string, { link?: boolean; resolved?: string; integrity?: string }][]) {
    if (!name) continue;
    if (value.link || !value.resolved) throw new Error("Dependency links/local packages are unavailable to the isolated runner");
    const url = new URL(value.resolved);
    if (url.origin !== "https://registry.npmjs.org" || url.username || url.password || url.search || url.hash || !/^sha512-[A-Za-z0-9+/]+=*$/.test(value.integrity ?? "")) throw new Error("Dependencies require public npm registry URLs and SHA-512 integrity");
  }
  const dir = join(root, `dependencies-${revision}`); mkdirSync(dir); mkdirSync(join(dir, "home"));
  writeFileSync(join(dir, "package.json"), manifest); writeFileSync(join(dir, "package-lock.json"), lock);
  for (const name of ["npm-user", "npm-global"]) writeFileSync(join(dir, name), "");
  const env = { PATH: o.path, HOME: join(dir, "home"), LANG: "C.UTF-8", CI: "1", npm_config_cache: join(dir, "cache"), npm_config_userconfig: join(dir, "npm-user"), npm_config_globalconfig: join(dir, "npm-global"), npm_config_registry: "https://registry.npmjs.org" };
  const result = await run(o.node, [o.npm, "ci", "--ignore-scripts", "--include=dev", "--include=optional", "--no-audit", "--no-fund"], dir, env, 10 * 60_000, signal);
  writeFileSync(join(dir, "install.log"), result.stdout + "\n" + result.stderr);
  if (result.exitCode !== 0 || result.timedOut) throw new Error(`npm ci failed; see ${dir}/install.log`);
  return join(dir, "node_modules");
}

export async function runShipGates(o: ShipConfig, repo: string, revision: string, root: string, signal?: AbortSignal): Promise<GateReceipt[]> {
  signal?.throwIfAborted();
  const dir = join(root, revision), files = await snapshot(repo, revision, dir, signal);
  const dependencies = await sourceDependencies(o, dir, root, revision, signal);
  for (const cache of [".vite", ".vite-temp", ".vite-preview-before"]) mkdirSync(join(dependencies, cache), { recursive: true });
  // Writable outputs, immutable tracked sources/dependencies/runtime; only private loopback and HOME.
  const args = ["--die-with-parent", "--unshare-all", "--new-session", "--tmpfs", "/", "--proc", "/proc", "--dev", "/dev", "--ro-bind", "/nix/store", "/nix/store", "--dir", "/run/current-system", "--ro-bind", "/run/current-system/sw", "/run/current-system/sw", "--ro-bind", "/etc/fonts", "/etc/fonts", "--dir", "/bin", "--ro-bind", o.bash, "/bin/sh", "--ro-bind", o.bash, "/bin/bash", "--tmpfs", "/tmp", "--dir", "/tmp/h", "--bind", dir, "/work", "--ro-bind", dependencies, "/work/node_modules", "--ro-bind", o.dependencies, o.dependencies, "--ro-bind", join(dir, ".git"), "/work/.git", "--ro-bind", join(root, "host"), "/host", "--ro-bind", join(root, "host", "hosts"), "/etc/hosts", "--ro-bind", o.pi, "/tmp/h/.local/state/vault-chat-server/pi/1.1.0", "--chdir", "/work"];
  for (const cache of [".vite", ".vite-temp", ".vite-preview-before"]) args.push("--tmpfs", `/work/node_modules/${cache}`);
  for (const file of files) if (!lstatSync(join(dir, file)).isSymbolicLink()) args.push("--ro-bind", join(dir, file), `/work/${file}`);
  args.push("--");
  const env = { PATH: `/work/node_modules/.bin:${o.path}`, HOME: "/tmp/h", TMPDIR: "/tmp", LANG: "C.UTF-8", CI: "1", VC_TEST_PI_DIR: "/tmp/h/.local/state/vault-chat-server/pi/1.1.0", VC_VOICE_PIPELINE: "off", VC_VOICE_PIPELINE_PORT: "19101", VC_PORT: "19001", npm_config_cache: "/tmp/npm-cache", npm_config_userconfig: "/host/npm-user", npm_config_globalconfig: "/host/npm-global" };
  const results: GateReceipt[] = [];
  for (const gate of CHANGE_GATES) {
    console.log(`${revision.slice(0, 12)} ${gate}`);
    let stdout = "", stderr = "", exitCode = 0, timedOut = false;
    for (const command of gateCommands(o, gate)) {
      const r = await run(o.bwrap, [...args, ...command], dir, env, undefined, signal);
      stdout += r.stdout; stderr += r.stderr; exitCode = r.exitCode; timedOut ||= r.timedOut;
      if (exitCode !== 0 || timedOut) break;
    }
    const logArtifact = join(root, `${revision}-${gate.replace(":", "-")}.log`);
    writeFileSync(logArtifact, stdout + "\n" + stderr);
    const report = gate === "test:harness" ? parseHarnessReport(stdout, "/work") : gate === "test:server" ? (() => {
      const lines = stdout.split("\n").filter(s => s.startsWith(VITEST_REPORT_PREFIX));
      return lines.length === 1 ? parseVitestReport(lines[0]!.slice(VITEST_REPORT_PREFIX.length), "/work") : { tests: [], complete: false };
    })() : null;
    results.push({ gate, exitCode, logArtifact, timedOut, complete: !timedOut && (report?.complete ?? true), ...(report ? { tests: report.tests } : {}) });
  }
  return results;
}

/** Git owns the reference lock and releases an uncommitted transaction on EOF/process loss.
 * Worktree + refs are not power-failure-atomic; failure remains visible, never a recovery permit. */
async function checkoutFastForward(repo: string, base: string, head: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const git = (cwd: string, args: string[]) => nativeGit(cwd, args, { signal });
  const child = spawn("git", ["-c", "credential.interactive=false", "update-ref", "--stdin"], {
    cwd: repo, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
    detached: true, stdio: ["pipe", "pipe", "pipe"],
  });
  // Until commit is submitted, abort closes Git's uncommitted native transaction.
  const stop = () => { child.stdin.end(); };
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) stop();
  child.stdin.on("error", () => {});
  let stderr = "", timedOut = false;
  child.stderr.on("data", data => { stderr += data; });
  const lines = createInterface({ input: child.stdout });
  const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, 90_000);
  const closed = new Promise<void>((done, fail) => {
    child.once("error", fail);
    child.once("close", code => code === 0 && !timedOut ? done() : fail(new Error(`Native git fast-forward failed${timedOut ? " (timeout)" : ""}: ${stderr.trim()}`)));
  });
  // Attach immediately; spawn/ref-lock failure must not become an unhandled rejection.
  const prepared = new Promise<void>((done, fail) => {
    lines.on("line", line => { if (line === "prepare: ok") done(); });
    void closed.then(() => fail(new Error("Git ref transaction ended before prepare")), fail);
  });
  try {
    child.stdin.write(`start\nupdate refs/heads/main ${head} ${base}\nprepare\n`);
    await prepared;
    await git(repo, ["-c", "core.hooksPath=/dev/null", "read-tree", "-u", "-m", base, head]);
    // No await between the last abort check and handing commit to native Git.
    signal?.throwIfAborted();
    signal?.removeEventListener("abort", stop);
    child.stdin.end("commit\n");
    await closed;
  } finally {
    // EOF aborts a prepared but uncommitted ref transaction, including any checkout failure.
    signal?.removeEventListener("abort", stop);
    child.stdin.end();
    await closed.catch(() => {});
    clearTimeout(timer); lines.close();
  }
}

export async function promote(repo: string, base: string, head: string, change: Parameters<typeof prepareAcceptanceLocked>[1], signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const git = (cwd: string, args: string[]) => nativeGit(cwd, args, { signal });
  await withShippingLock(repo, async () => {
    signal?.throwIfAborted();
    if ((await git(repo, ["rev-parse", "refs/heads/main"])).trim() !== base || (await git(repo, ["symbolic-ref", "--short", "HEAD"])).trim() !== "main" || (await git(repo, ["status", "--porcelain"])).trim()) throw new Error("Main changed during gates; update branch and resubmit");
    await git(repo, ["merge-base", "--is-ancestor", base, head]);
    signal?.throwIfAborted();
    await prepareAcceptanceLocked(repo, change);
    // Hold Git's native expected-old ref transaction while checkout takes its native index lock.
    // A split update-ref then read-tree advanced main on checkout failure; merge --ff-only alone
    // does not pin the original expected-old base across the journal write. No new authority/state.
    await checkoutFastForward(repo, base, head, signal);
    await reconcileAcceptancesLocked(repo);
  });
}

/** A commit's gate results depend only on its tree and this host's installed toolchain, so a commit
 * gated once (as one ship's candidate) is not gated again as the next ship's baseline: that re-run was
 * half of every ship. Only complete, untimed-out runs are kept, in the host's private work directory
 * (outside every agent sandbox), for 14 days; the comparison against the candidate is unchanged. */
const GATE_CACHE_DAYS = 14;
function gateCacheFile(o: ShipConfig, revision: string): string {
  const key = createHash("sha256").update(JSON.stringify([revision, o.dependencies, o.pi, o.node, o.npm, o.bash, o.bwrap, o.path, CHANGE_GATES])).digest("hex").slice(0, 40);
  // Beside the run directories, never among them (each entry of workRoot is one ship run).
  return join(`${o.workRoot}.gate-cache`, `${key}.json`);
}
export function cachedGates(o: ShipConfig, revision: string, now = Date.now()): GateReceipt[] | null {
  try {
    const r = JSON.parse(readFileSync(gateCacheFile(o, revision), "utf8"));
    if (r?.revision !== revision || typeof r.at !== "number" || now - r.at > GATE_CACHE_DAYS * 86_400_000) return null;
    const gates = r.gates as GateReceipt[];
    if (!Array.isArray(gates) || gates.length !== CHANGE_GATES.length || CHANGE_GATES.some((g) => !gates.find((x) => x.gate === g && x.complete && !x.timedOut))) return null;
    return gates;
  } catch { return null; }
}
export function rememberGates(o: ShipConfig, revision: string, gates: readonly GateReceipt[], now = Date.now()): void {
  if (gates.length !== CHANGE_GATES.length || gates.some((g) => !g.complete || g.timedOut)) return;
  const file = gateCacheFile(o, revision);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(`${file}.tmp`, JSON.stringify({ revision, at: now, gates }), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

/** Same runner used for first-install verification without touching a project ref. */
export function createRunRoot(o: ShipConfig): string {
  mkdirSync(o.workRoot, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(o.workRoot, "ship-"));
  console.log(`Logs: ${root}`);
  mkdirSync(join(root, "host"));
  writeFileSync(join(root, "host", "harness.mjs"), HARNESS_REPORTER_SOURCE);
  writeFileSync(join(root, "host", "vitest.mjs"), VITEST_REPORTER_SOURCE);
  // Private loopback still needs a localhost name; never expose the host's DNS/configuration.
  writeFileSync(join(root, "host", "hosts"), "127.0.0.1 localhost\n::1 localhost\n");
  // Vitest resolves its installed reporter through this read-only dependency location.
  // Put a real module next to installed dependencies at install time; bind host/node_modules below.
  symlinkSync(o.dependencies, join(root, "host", "node_modules"));
  for (const f of ["npm-user", "npm-global"]) writeFileSync(join(root, "host", f), "");
  return root;
}

export async function ship(o: ShipConfig, input: { branch: string; title: string; slug: string; convId: string }, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if ("rollback" in input) throw new Error("Source recovery is not supported; submit a proven branch");
  checkBranch(input.branch);
  const git = (cwd: string, args: string[]) => nativeGit(cwd, args, { signal });
  o = { ...o, repo: realpathSync(o.repo), dependencies: realpathSync(o.dependencies), pi: realpathSync(o.pi), node: executable(o.node), npm: executable(o.npm), bash: executable(o.bash), bwrap: executable(o.bwrap) };
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(o.remote)) throw new Error("Invalid installed remote name");
  if (!isAbsolute(o.workRoot) || resolve(o.workRoot) === o.repo || resolve(o.workRoot).startsWith(o.repo + "/")) throw new Error("Private host work directory required");
  const root = createRunRoot(o);
  let base = "", head = "";
  const branch = input.branch;
  await withRepoLock(o.repo, async () => {
    if ((await git(o.repo, ["symbolic-ref", "--short", "HEAD"])).trim() !== "main" || (await git(o.repo, ["status", "--porcelain"])).trim()) throw new Error("Main must be checked out and clean");
    base = (await git(o.repo, ["rev-parse", "refs/heads/main"])).trim();
    await git(o.repo, ["-c", "core.hooksPath=/dev/null", "fetch", "--no-tags", o.remote, `+refs/heads/${branch}:refs/remotes/simple-ship/${branch}`]);
    head = (await git(o.repo, ["rev-parse", `refs/remotes/simple-ship/${branch}^{commit}`])).trim();
  });
  if (base === head) throw new Error("Branch has no change");
  await git(o.repo, ["merge-base", "--is-ancestor", base, head]);
  const cached = cachedGates(o, base);
  if (cached) console.log(`Baseline ${base.slice(0, 12)}: gate results reused (already gated)`);
  const baseline = cached ?? await runShipGates(o, o.repo, base, root, signal);
  if (!cached) rememberGates(o, base, baseline);
  const candidate = await runShipGates(o, o.repo, head, root, signal);
  rememberGates(o, head, candidate);
  writeFileSync(join(root, "gates.json"), JSON.stringify({ base, head, baseline, candidate }, null, 2));
  compareChangeGates(baseline, candidate);
  const tree = (await git(o.repo, ["rev-parse", `${head}^{tree}`])).trim(), now = new Date().toISOString();
  await promote(o.repo, base, head, { id: head, source: { base, head, tree, branch }, review: { convId: input.convId, slug: input.slug, folder: o.repo, clone: o.repo, base: "main", branch, sha: head, title: input.title, at: now }, proofDir: root, preparedAt: now }, signal);
  return `Accepted ${head}. Laptop sync/CI and actual box/laptop health pending; not Shipped. Logs: ${root}`;
}

export async function simpleShipCli(args = process.argv.slice(2), signal?: AbortSignal): Promise<void> {
  const [config, repo, mode, value, title = "Source change", slug = "vault-chat", convId = ""] = args;
  if (!config || !repo || mode !== "--branch") throw new Error("Usage: simple-ship CONFIG REPO --branch agent/name [title slug conversation]");
  const o = JSON.parse(readFileSync(config, "utf8")) as ShipConfig;
  if (realpathSync(repo) !== realpathSync(o.repo)) throw new Error("Project does not match installed host configuration");
  console.log(await ship(o, { branch: value!, title, slug, convId }, signal));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // JobStop uses the existing service AbortSignal -> native SIGTERM -> this CLI signal.
  // Detached git helpers are cancelled explicitly; bwrap's PID namespace owns its descendants.
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("Shipping cancelled"));
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  void simpleShipCli(undefined, controller.signal).catch(e => { console.error(String(e)); process.exitCode = 1; })
    .finally(() => { process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop); });
}
