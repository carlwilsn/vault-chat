/** Installed-host adapter for changeProof. No tool-supplied receipt, runner command or URL is authority.
 * This module runs on the service, NOT in pi. The only acceptance API it uses is projectChanges' locked ff.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants, chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createChangeProofService, CHANGE_COMMANDS, type AskCheck, type GateExecution, type ProofHost, type ProofSource, type UIReceipt } from "./changeProof";
import { HARNESS_REPORTER_SOURCE, parseHarnessReport, parseVitestReport } from "./changeTestReports";
import { git, withRepoLock } from "./git";
import { acceptProvenReview, baseBranch, type Review } from "./projectChanges";
import { killTree } from "./commands/proc";
import type { RecordArgs } from "./recordUI";
import { browserOnlyError } from "./recordUI";

const hash = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const inside = (p: string, root: string) => { const r = relative(root, p); return !isAbsolute(r) && r !== ".." && !r.startsWith("../"); };
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
export type ChangeHostOptions = {
  /** All are installed service configuration, never tool arguments. */
  shell: readonly string[]; home: string; privateRoot: string;
  installedEntry: string; dependencies: string; dependencyLock: string;
  node: string; npm: string; path: string; browser?: string;
  /** Installed credential-free npm provisioner; candidate only supplies committed manifests. */
  provision?: (manifest: string, lock: string) => Promise<{ dependencies: string; dependencyLock: string }>;
  timeoutMs?: number; signal?: AbortSignal;
  onProgress?: (text: string) => void;
};
export type SubmitCheck = { assessment: string; evidence: string[]; ui: Omit<RecordArgs, "url" | "out">; surface: "phone" | "board" | "desktop" };
export type PinnedChange = { vault: string; source: ProofSource; review: Review };

/** Pin under the SAME project mutex as acceptance and sync; never change the agent's checkout. */
export async function pinChange(o: { vault: string; convId: string; slug: string; folder: string; clone: string; title: string }): Promise<PinnedChange> {
  return withRepoLock(o.folder, async () => {
    const base = await baseBranch(o.folder);
    if (!base) throw new Error("Project must have its base branch checked out");
    for (const dir of [o.folder, o.clone]) if ((await git(dir, ["status", "--porcelain"])).trim()) throw new Error(`Commit or preserve local edits before submitting: ${dir}`);
    const branch = (await git(o.clone, ["symbolic-ref", "--short", "HEAD"])).trim();
    if (!/^agent\/[a-z0-9][a-z0-9._/-]{0,60}$/.test(branch)) throw new Error("Submit a committed agent/<name> branch");
    const head = (await git(o.clone, ["rev-parse", "HEAD"])).trim();
    const before = (await git(o.folder, ["rev-parse", "HEAD"])).trim();
    // A local fetch only. No credentials, push or reset; no merge until proof.consume under the lock.
    await git(o.folder, ["-c", "core.hooksPath=/dev/null", "-c", "gc.auto=0", "fetch", "--no-tags", o.clone, `refs/heads/${branch}:refs/heads/${branch}`]);
    if ((await git(o.folder, ["rev-parse", branch])).trim() !== head) throw new Error("Agent branch moved during pinning");
    await git(o.folder, ["merge-base", "--is-ancestor", before, head]);
    if (before === head) throw new Error("No change beyond the project's current main");
    const tree = (await git(o.folder, ["rev-parse", `${head}^{tree}`])).trim();
    return { vault: o.vault, source: { base: before, head, tree, branch }, review: { ...o, base, branch, sha: head, at: new Date().toISOString() } };
  });
}

/** Full uncapped raw logs belong to the host, not the agent's clipped runSandboxed output.
 * Same scrubbed environment rule as runSandboxed; no inherited API keys, npm config, NODE_OPTIONS or tokens.
 */
export async function runProofCommand(shell: readonly string[], argv: readonly string[], o: { cwd: string; env: Record<string, string>; timeoutMs: number; signal?: AbortSignal }): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  if (!shell.length || shell.at(-1) !== "--") throw new Error("Installed bubblewrap sandbox is required; unsafe native proof is forbidden");
  o.signal?.throwIfAborted();
  return new Promise((done, reject) => {
    let stdout = "", stderr = "", timedOut = false, aborted = false;
    const child = spawn(shell[0]!, [...shell.slice(1), ...argv], { cwd: o.cwd, env: o.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const stop = () => { aborted = true; killTree(child.pid); };
    o.signal?.addEventListener("abort", stop, { once: true });
    if (o.signal?.aborted) stop();
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, o.timeoutMs);
    child.stdout.on("data", d => { stdout += d; });
    child.stderr.on("data", d => { stderr += d; });
    const cleanup = () => { clearTimeout(timer); o.signal?.removeEventListener("abort", stop); };
    child.on("error", e => { cleanup(); reject(e); });
    child.on("close", code => { cleanup(); if (aborted) reject(new Error("Proof cancelled; no acceptance permit issued")); else done({ code: code ?? -1, stdout, stderr, timedOut }); });
  });
}

/** Refuse symlink escapes before exporting. In particular never cp a model-selected path on the host. */
export async function checkSourceLinks(repo: string, revision: string): Promise<void> {
  const entries = (await git(repo, ["ls-tree", "-rz", revision])).split("\0").filter(Boolean);
  for (const entry of entries) {
    const tab = entry.indexOf("\t"), [mode, , object] = entry.slice(0, tab).split(" "), name = entry.slice(tab + 1);
    if (mode === "160000") throw new Error(`Submodule needs explicit installed provisioning: ${name}`);
    if (mode !== "120000") continue;
    const target = (await git(repo, ["cat-file", "blob", object!])).replace(/\n$/, "");
    if (isAbsolute(target) || !inside(resolve("/source", dirname(name), target), "/source")) throw new Error(`Source symlink escapes snapshot: ${name}`);
  }
}

/** Real isolated runner. Installed dependencies are shared read-only only when BOTH lockfiles match that
 * installed dependency set. Dependency changes fail visibly until provisioned; never npm-exec host credentials.
 */
export async function createInstalledChangeHost(o: ChangeHostOptions, repo: string, source: ProofSource, check: SubmitCheck): Promise<{ host: ProofHost; root: string; close(): void }> {
  if (!o.shell.length || o.shell.at(-1) !== "--" || !o.shell[0]!.includes("bwrap")) throw new Error("Proof requires the installed bubblewrap guard");
  if (!isAbsolute(o.privateRoot) || !isAbsolute(o.installedEntry)) throw new Error("Installed absolute proof storage and entry are required");
  const entry = realpathSync(o.installedEntry);
  const installedDependencies = o.provision ? o.dependencies : realpathSync(o.dependencies);
  const lockBytes = readFileSync(o.dependencyLock);
  const lockHash = hash(lockBytes);
  const installedManifest = JSON.parse(readFileSync(join(dirname(o.dependencyLock), "package.json"), "utf8"));
  const dependencyFields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "overrides"];
  const normalized = (v: unknown): string => JSON.stringify(v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, JSON.parse(normalized(x))])) : v ?? null);
  const uiError = browserOnlyError({ ...check.ui, url: "http://127.0.0.1:19001" });
  if (uiError || check.ui.steps?.some(s => "goto" in s || "run" in s) || !check.ui.steps?.some(s => "waitFor" in s) || !check.ui.steps.some(s => "click" in s || "type" in s || "press" in s || "scroll" in s)) throw new Error(uiError || "UI proof needs actual input and assertions; navigation away from the candidate is forbidden");
  if (!["phone", "board", "desktop"].includes(check.surface)) throw new Error("Unknown proof UI surface");
  mkdirSync(o.privateRoot, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(o.privateRoot, "change-"));
  chmodSync(root, 0o700);
  const hostDir = join(root, "host"), logs = join(root, "logs"), evidence = join(root, "evidence");
  for (const d of [hostDir, logs, evidence]) mkdirSync(d);
  const dependencies = join(root, "dependencies");
  cpSync(entry, join(hostDir, "service.mjs"));
  writeFileSync(join(hostDir, "harness-reporter.mjs"), HARNESS_REPORTER_SOURCE);
  writeFileSync(join(hostDir, "npm-user"), "");
  writeFileSync(join(hostDir, "npm-global"), "");
  const snapshots = new Map<string, { dir: string; files: string[]; tree: string; dependencies: string }>();
  const dependencyCopies = new Map<string, string>();
  const sourceDependencies: Record<string, { manifest: string; lock: string }> = {};
  // npm invokes `node` from PATH. Insert reporter options BEFORE --test's file arguments, without modifying
  // pinned package.json or relying on candidate text as test results. The installed reporter owns stdout.
  writeFileSync(join(hostDir, "node"), `#!/bin/sh\nfor arg do\n if [ "$arg" = "--test" ]; then exec ${quote(o.node)} --test-reporter=${quote(join(hostDir, "harness-reporter.mjs"))} "$@"; fi\ndone\nexec ${quote(o.node)} "$@"\n`, { mode: 0o755 });
  const toolPath = o.path.split(":").filter(Boolean).map(p => { try { return realpathSync(p); } catch { return ""; } }).filter(p => p && !inside(p, o.home)).join(":");
  const env = (revision: string): Record<string, string> => ({
    PATH: `${hostDir}:${toolPath}`, HOME: "/tmp/proof-home", LANG: "C.UTF-8", TMPDIR: "/tmp", CI: "1",
    VC_REV: revision, VC_VOICE_PIPELINE: "off", VC_VOICE_PIPELINE_PORT: "19101", VC_PORT: "19001",
    npm_config_cache: "/tmp/npm-cache", npm_config_userconfig: join(hostDir, "npm-user"), npm_config_globalconfig: join(hostDir, "npm-global"),
    ...(o.browser ? { VC_HEADLESS_BROWSER: realpathSync(o.browser) } : {}),
  });
  /** Overlay the existing credential-hiding guard, additionally removing the host home, shared tmp/runtime
   * sockets and ALL host networking. Tests and UI use their own loopback inside this net namespace.
   * The service bundle/reporter/logs are never writable by candidate processes. */
  const sandbox = (s: { dir: string; files: string[]; dependencies: string }, writeEvidence = false): string[] => {
    const args = [...o.shell.slice(0, -1), "--unshare-net", "--tmpfs", o.home, "--tmpfs", "/tmp", "--tmpfs", "/run", "--tmpfs", "/var/tmp",
      "--ro-bind", hostDir, hostDir, "--bind", s.dir, s.dir, "--ro-bind", s.dependencies, join(s.dir, "node_modules"),
      "--ro-bind", join(s.dir, ".git"), join(s.dir, ".git")];
    for (const cache of [".vite", ".vite-temp", ".vite-preview-before"]) args.push("--tmpfs", join(s.dir, "node_modules", cache));
    for (const f of s.files) if (!lstatSync(join(s.dir, f)).isSymbolicLink()) args.push("--ro-bind", join(s.dir, f), join(s.dir, f));
    if (writeEvidence) args.push("--bind", evidence, evidence);
    return [...args, "--"];
  };
  try {
    for (const revision of new Set([source.base, source.head])) {
      await checkSourceLinks(repo, revision);
      const dir = join(root, revision);
      // --no-hardlinks avoids mutable object aliasing; local clone never contacts GitHub.
      await git(root, ["-c", "core.hooksPath=/dev/null", "clone", "--quiet", "--no-local", "--no-hardlinks", "--no-checkout", repo, dir]);
      await git(dir, ["-c", "core.hooksPath=/dev/null", "checkout", "--quiet", "--detach", revision]);
      const manifestBytes = readFileSync(join(dir, "package.json"), "utf8"), snapshotLock = readFileSync(join(dir, "package-lock.json"), "utf8");
      const manifest = JSON.parse(manifestBytes);
      sourceDependencies[revision] = { manifest: hash(manifestBytes), lock: hash(snapshotLock) };
      let provisioned = installedDependencies;
      if (o.provision) {
        o.onProgress?.(`${revision}: provision public integrity-checked dependencies (no install scripts)`);
        provisioned = (await o.provision(manifestBytes, snapshotLock)).dependencies;
        o.signal?.throwIfAborted();
      } else {
        if (hash(snapshotLock) !== lockHash) throw new Error(`Installed dependency lock does not match ${revision}; provision that lock before proof`);
        if (dependencyFields.some(field => normalized(manifest[field]) !== normalized(installedManifest[field]))) throw new Error(`Dependency manifest differs from installed lock at ${revision}; provision dependencies before proof`);
      }
      const dependencyKey = hash(snapshotLock + normalized(dependencyFields.map(f => manifest[f])));
      let copy = dependencyCopies.get(dependencyKey);
      if (!copy) {
        copy = join(dependencies, dependencyKey);
        cpSync(realpathSync(provisioned), copy, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE, filter: p => ![".vite", ".cache"].includes(p.split("/").at(-1)!) && !p.split("/").at(-1)!.startsWith(".vite-") });
        for (const cache of [".vite", ".vite-temp", ".vite-preview-before"]) mkdirSync(join(copy, cache), { recursive: true });
        dependencyCopies.set(dependencyKey, copy);
      }
      const modules = join(dir, "node_modules");
      if (existsSync(modules)) throw new Error("Tracked node_modules is not a trusted dependency set");
      mkdirSync(modules);
      const files = (await git(dir, ["ls-files", "-z"])).split("\0").filter(Boolean);
      const tree = (await git(dir, ["rev-parse", "HEAD^{tree}"])).trim();
      snapshots.set(revision, { dir, files, tree, dependencies: copy });
    }

  } catch (e) { rmSync(root, { recursive: true, force: true }); throw e; }
  if (snapshots.get(source.head)?.tree !== source.tree) { rmSync(root, { recursive: true, force: true }); throw new Error("Candidate tree does not match pinned source"); }
  const snapshot = (revision: string) => { const s = snapshots.get(revision); if (!s) throw new Error("Unknown source pin"); return s; };
  let recorded: UIReceipt | undefined;
  const host: ProofHost = {
    runnerVersion: `installed-change-host/1:${hash(readFileSync(entry))}`,
    environment: JSON.stringify({ node: o.node, version: process.version, installedLock: lockHash, dependencies: sourceDependencies, network: "private-loopback", voice: "off" }),
    async assertSource(revision) {
      const s = snapshot(revision);
      if ((await git(s.dir, ["rev-parse", "HEAD"])).trim() !== revision || (await git(s.dir, ["rev-parse", "HEAD^{tree}"])).trim() !== s.tree || (await git(s.dir, ["status", "--porcelain", "--untracked-files=no"])).trim()) throw new Error("Pinned snapshot changed during proof");
      await checkSourceLinks(s.dir, revision);
    },
    async execute(revision, gate, command): Promise<GateExecution> {
      if (JSON.stringify(command) !== JSON.stringify(CHANGE_COMMANDS[gate])) throw new Error("Only the fixed seven installed gates may run");
      const s = snapshot(revision);
      o.onProgress?.(`${revision}: ${gate}`);
      // Vitest supports reporter flags after `npm run ... --`. The harness needs the node shim above.
      const argv = command[0] === "npm" ? [o.node, o.npm, ...command.slice(1)] : [...command];
      if (gate === "test:server") argv.push("--", "--reporter=json", "--outputFile=/tmp/server-tests.json");
      const suffix = gate.replace(":", "-");
      // The report is copied to stdout by installed shell AFTER npm exits. A distinct host-owned file is kept
      // for each complete command; no clipped tool output or candidate-supplied path is parsed.
      const script = `${argv.map(quote).join(" ")}; code=$?; ${gate === "test:server" ? 'printf "\\n@@vc-vitest@@\\n"; cat /tmp/server-tests.json; ' : ""}exit "$code"`;
      const r = await runProofCommand(sandbox(s), ["sh", "-c", script], { cwd: s.dir, env: env(revision), timeoutMs: o.timeoutMs ?? 30 * 60_000, signal: o.signal });
      const logArtifact = join(logs, `${revision}-${suffix}.json`);
      writeFileSync(logArtifact, JSON.stringify({ command, argv, ...r }));
      let tests: ReturnType<typeof parseVitestReport> | undefined;
      if (gate === "test:server") tests = parseVitestReport(r.stdout.split("\n@@vc-vitest@@\n").at(-1) ?? "", s.dir);
      if (gate === "test:harness") {
        // npm's own script banner is not runner output. Only the installed reporter's NDJSON is parsed.
        const lines = r.stdout.split("\n").filter(l => l.startsWith('{"type":"test:') || l.startsWith('{"type":"vc:complete"'));
        tests = parseHarnessReport(lines.join("\n"), s.dir);
      }
      return { exitCode: r.code, stdout: r.stdout, stderr: r.stderr, logArtifact, timedOut: r.timedOut, complete: !r.timedOut && (tests?.complete ?? true), ...(tests ? { tests: tests.tests } : {}) };
    },
    async record(pins) {
      const s = snapshot(pins.head);
      o.onProgress?.(`${pins.head}: candidate-backed RecordUI (${check.surface})`);
      const request = { source: pins, snapshot: s.dir, evidence, buildHash: hash(readFileSync(join(s.dir, "dist-server", "vault-chat-server.mjs"))), surface: check.surface, ui: check.ui, node: o.node, bwrap: o.shell[0], hostDir };
      writeFileSync(join(hostDir, "ui-request.json"), JSON.stringify(request));
      const r = await runProofCommand(sandbox(s, true), [o.node, join(hostDir, "service.mjs"), "prove-change-ui", join(hostDir, "ui-request.json")], { cwd: s.dir, env: env(pins.head), timeoutMs: 240_000, signal: o.signal });
      writeFileSync(join(logs, "ui.json"), JSON.stringify(r));
      if (r.code !== 0 || r.timedOut) throw new Error(`Candidate UI recording failed: ${r.stderr.slice(0, 4000)}`);
      const receipt = JSON.parse(r.stdout) as UIReceipt;
      const file = realpathSync(receipt.artifact);
      if (!inside(file, evidence) || !lstatSync(file).isFile() || hash(readFileSync(file)) !== receipt.artifactHash) throw new Error("Recorder artifact escaped private evidence or changed");
      recorded = structuredClone(receipt);
      return receipt;
    },
    async assertArtifact(ui) {
      if (!recorded || JSON.stringify(recorded) !== JSON.stringify(ui)) throw new Error("No host-observed recording for this permit");
      const artifact = realpathSync(ui.artifact);
      if (!inside(artifact, evidence) || hash(readFileSync(artifact)) !== ui.artifactHash) throw new Error("Recorded artifact changed");
      // Same installed recorder process decodes the actual retained video again before acceptance.
      const s = snapshot(source.head);
      const r = await runProofCommand(sandbox(s, true), [o.node, join(hostDir, "service.mjs"), "verify-change-video", artifact], { cwd: s.dir, env: env(source.head), timeoutMs: 60_000, signal: o.signal });
      if (r.code !== 0 || r.timedOut) throw new Error("Retained real-UI recording no longer decodes");
    },
    async persist(receipt) { writeFileSync(join(root, "receipt.json"), JSON.stringify(receipt, null, 2), { flag: "wx", mode: 0o600 }); },
  };
  return { host, root, close() {
    // Retain full logs, UI and receipt. Snapshots alone are disposable; no vault/project files are removed.
    for (const s of snapshots.values()) rmSync(s.dir, { recursive: true, force: true });
    rmSync(dependencies, { recursive: true, force: true });
  } };
}

/** Concrete proof → same-process permit → existing locked acceptance. The caller must resolve AskCheck's
 * request from its conversation (not tool args). This never pushes and never labels acceptance Shipped.
 * Native submissions and source recovery both use this installed path.
 */
export async function proveAndAcceptChange(o: ChangeHostOptions, pinned: PinnedChange, ask: AskCheck, check: SubmitCheck, assertRequest?: () => Promise<void>, rollbackOf?: string): Promise<{ accepted: boolean; text: string; proofDir: string }> {
  const runner = await createInstalledChangeHost(o, pinned.review.folder, pinned.source, check);
  try {
    const proof = createChangeProofService(runner.host);
    const { permit } = await proof.prove(pinned.source, ask);
    const out = await acceptProvenReview(pinned.vault, pinned.review, proof, permit, assertRequest, { proofDir: runner.root, check, rollbackOf });
    return { accepted: out.ok, text: out.text, proofDir: runner.root };
  } finally { runner.close(); }
}
