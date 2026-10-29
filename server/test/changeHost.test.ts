import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:net";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { CHANGE_COMMANDS, CHANGE_GATES } from "../changeProof";
import { checkSourceLinks, createInstalledChangeHost, pinChange, type ChangeHostOptions, type PinnedChange, type SubmitCheck } from "../changeHost";
import { buildSandbox } from "../engine/index";
import { findBwrap } from "../engine/pi/install";
import { findBrowser } from "../headless";

const root = resolve(".");
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@local", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@local" } }).trim();
const ui: SubmitCheck = { assessment: "Agent self-check", evidence: ["actual fixture checks"], surface: "phone", ui: { steps: [{ click: "button" }, { waitFor: "main" }] } };
let dir: string, repo: string, clone: string, pinned: PinnedChange, opts: ChangeHostOptions, listener: Server;
let runner: Awaited<ReturnType<typeof createInstalledChangeHost>>;

// These are real executions in tiny temporary git repos, NOT final application gates or real UI proof.
// No skips: a machine without the installed sandbox fails the test rather than silently declaring proof.
describe("installed change host: actual sandbox, git pins and seven fixed commands", () => {
  beforeAll(async () => {
    const bwrap = findBwrap();
    if (!bwrap) throw new Error("Installed bubblewrap required for host integration tests");
    if (!existsSync(join(root, "dist-server/vault-chat-server.mjs"))) throw new Error("Build the installed worker with node server/build.mjs first");
    dir = mkdtempSync(join(tmpdir(), "vc-change-host-test-"));
    repo = join(dir, "project"); clone = join(dir, "clone");
    mkdirSync(repo); mkdirSync(join(dir, "vault"));
    git(repo, "init", "-q", "-b", "main");
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    pkg.scripts = { "typecheck:phone": "tsc --noEmit -p .", "typecheck:board": "tsc --noEmit -p .", "typecheck:server": "tsc --noEmit -p .",
      "test:harness": "node --test tiny.node.test.mjs", "test:server": "vitest run --config tiny.config.mjs", "build:server": "node --check source.mjs" };
    writeFileSync(join(repo, "package.json"), JSON.stringify(pkg));
    writeFileSync(join(repo, "package-lock.json"), readFileSync(join(root, "package-lock.json")));
    writeFileSync(join(repo, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler", skipLibCheck: true, types: [] }, files: ["source.ts"] }));
    writeFileSync(join(repo, "source.ts"), "export const value: number = 1;\n");
    writeFileSync(join(repo, "source.mjs"), "export const value = 1;\n");
    writeFileSync(join(repo, "tiny.config.mjs"), 'export default {test:{include:["tiny.vitest.test.ts"],fileParallelism:false}};\n');
    writeFileSync(join(repo, "tiny.vitest.test.ts"), 'import {it,expect} from "vitest"; it("actual vitest passes",()=>expect(1+1).toBe(2));\n');
    writeFileSync(join(repo, "outside-marker"), "host-only marker");
    writeFileSync(join(repo, "tiny.node.test.mjs"), `import {it,describe} from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import net from 'node:net';
      describe('first suite',()=>it('same leaf',()=>assert.equal(2+2,4)));
      describe('second suite',()=>it('same leaf',()=>assert.equal(3+3,6)));
      it('host tmp and environment hidden',()=>{assert.equal(process.env.VC_PROOF_TEST_MARKER,undefined); assert.equal(fs.existsSync(${JSON.stringify(join(repo, "outside-marker"))}),false);});
      it('tracked source immutable',()=>assert.throws(()=>fs.writeFileSync('source.mjs','tampered')));
      it('cannot reach host loopback',async()=>{await new Promise((resolve,reject)=>{const s=net.connect(19096,'127.0.0.1');s.on('connect',()=>{s.destroy();reject(Error('escaped network namespace'));});s.on('error',resolve);});});
    `);
    git(repo, "add", "."); git(repo, "commit", "-qm", "baseline");
    git(dir, "clone", "-q", repo, clone); git(clone, "switch", "-qc", "agent/tiny");
    writeFileSync(join(clone, "source.ts"), "export const value: number = 2;\n");
    git(clone, "add", "."); git(clone, "commit", "-qm", "[agent] candidate");
    pinned = await pinChange({ vault: join(dir, "vault"), convId: "test", slug: "tiny", folder: repo, clone, title: "tiny change" });
    const shell = buildSandbox({ bwrap, home: homedir(), stateDir: join(dir, "state"), secretsDir: join(dir, "never-read-secrets"), hideFiles: [], sessionsDir: join(dir, "sessions"), agentDir: join(dir, "agent"), vault: join(dir, "vault"), uid: process.getuid!() }).shell!;
    const npm = execFileSync("sh", ["-c", "command -v npm"], { encoding: "utf8" }).trim();
    opts = { shell, home: homedir(), privateRoot: join(dir, "proofs"), installedEntry: join(root, "dist-server/vault-chat-server.mjs"),
      dependencies: join(root, "node_modules"), dependencyLock: join(root, "package-lock.json"), node: process.execPath, npm, path: process.env.PATH!, timeoutMs: 60_000 };
    listener = createServer(s => s.end());
    await new Promise<void>((done, reject) => { listener.once("error", reject); listener.listen(19096, "127.0.0.1", done); });
    process.env.VC_PROOF_TEST_MARKER = "must-not-inherit";
    runner = await createInstalledChangeHost(opts, repo, pinned.source, ui);
  });
  afterAll(async () => { delete process.env.VC_PROOF_TEST_MARKER; runner?.close(); if (listener?.listening) await new Promise<void>(done => listener.close(() => done())); if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("pins main and candidate without merging or pushing and does not reset the clone", () => {
    expect(git(repo, "rev-parse", "main")).toBe(pinned.source.base);
    expect(git(repo, "rev-parse", "agent/tiny")).toBe(pinned.source.head);
    expect(git(clone, "branch", "--show-current")).toBe("agent/tiny");
    expect(git(repo, "remote")).toBe("");
  });
  it("executes both pinned revisions' actual seven commands, parsing actual Vitest and node:test results", async () => {
    for (const revision of [pinned.source.base, pinned.source.head]) {
      for (const gate of CHANGE_GATES) {
        await runner.host.assertSource(revision);
        const r = await runner.host.execute(revision, gate, CHANGE_COMMANDS[gate]);
        expect(r.exitCode, `${revision} ${gate}: ${r.stderr}\n${r.stdout}`).toBe(0);
        expect(r.complete, `${gate}: ${r.stdout}`).toBe(true);
        expect(readFileSync(r.logArtifact, "utf8")).toContain(r.stdout.replaceAll("\n", "\\n").slice(0, 20));
        if (gate === "test:harness") {
          expect(r.tests).toHaveLength(5);
          expect(r.tests?.filter(t => t.name.includes("same leaf")).map(t => t.name)).toEqual(['["first suite","same leaf"]', '["second suite","same leaf"]']);
        }
        if (gate === "test:server") expect(r.tests).toEqual([{ file: "tiny.vitest.test.ts", name: "actual vitest passes", status: "passed" }]);
        await runner.host.assertSource(revision);
      }
    }
  }, 120_000);
  it("refuses a command override or a model-authored/prerecorded artifact", async () => {
    await expect(runner.host.execute(pinned.source.head, "build:server", ["sh", "-c", "true"])).rejects.toThrow("fixed seven");
    await expect(runner.host.assertArtifact({} as never)).rejects.toThrow("host-observed");
  });
  it("refuses native/unsafe fallback and UI with no real input/assertion or cross-origin goto", async () => {
    await expect(createInstalledChangeHost({ ...opts, shell: [] }, repo, pinned.source, ui)).rejects.toThrow("bubblewrap");
    await expect(createInstalledChangeHost(opts, repo, pinned.source, { ...ui, ui: { steps: [{ waitFor: "main" }] } })).rejects.toThrow("actual input");
    await expect(createInstalledChangeHost(opts, repo, pinned.source, { ...ui, ui: { steps: [{ click: "button" }, { waitFor: "main" }, { goto: "http://localhost:8857" }] } })).rejects.toThrow("navigation");
  });
  it("refuses tracked symlink escapes before any source is copied/executed", async () => {
    const linkRepo = join(dir, "links"); mkdirSync(linkRepo); git(linkRepo, "init", "-q");
    symlinkSync("/tmp/not-a-secret", join(linkRepo, "escape")); git(linkRepo, "add", "."); git(linkRepo, "commit", "-qm", "bad link");
    await expect(checkSourceLinks(linkRepo, "HEAD")).rejects.toThrow("escapes snapshot");
  });
  it("records actual phone input on a clean pinned vault-chat build and re-decodes retained evidence", async () => {
    const head = git(root, "rev-parse", "HEAD"), tree = git(root, "rev-parse", "HEAD^{tree}");
    const realSource = { base: head, head, tree, branch: "agent/recorder-test" };
    const browser = findBrowser();
    if (!browser) throw new Error("Actual Chromium required; a missing browser is not UI proof");
    const real = await createInstalledChangeHost({ ...opts, browser }, root, realSource, { ...ui, ui: { mobile: true, steps: [
      { waitFor: "#menuBtn" }, { click: "#menuBtn" }, { click: '[data-page="notes"]' }, { waitFor: "#noteInput" },
      { type: "Recorded through the real isolated box", into: "#noteInput" }, { click: "#noteAddBtn" },
      { waitFor: { text: "Recorded through the real isolated box" } },
    ] } });
    try {
      const build = await real.host.execute(head, "build:server", CHANGE_COMMANDS["build:server"]);
      expect(build.exitCode, build.stderr + build.stdout).toBe(0);
      const receipt = await real.host.record(realSource);
      expect(receipt).toMatchObject({ head, tree, sourceVerified: true, stepsPassed: true, recorder: "RecordUI", pageErrors: [] });
      expect(receipt.frames).toBeGreaterThan(1);
      await real.host.assertArtifact(receipt);
      // Optional retained proof for the coordinator; never changes pass/fail or authorizes acceptance.
      if (process.env.VC_CHANGE_HOST_TEST_PROOF) {
        const out = process.env.VC_CHANGE_HOST_TEST_PROOF; mkdirSync(out, { recursive: true });
        cpSync(receipt.artifact, join(out, receipt.artifact.endsWith(".mp4") ? "recording.mp4" : "recording.webm"));
        const shot = receipt.artifact.replace(/\.(mp4|webm)$/, ".png");
        if (existsSync(shot)) cpSync(shot, join(out, "recording.png"));
        cpSync(join(real.root, "evidence", "recording-meta.json"), join(out, "recording-meta.json"));
        writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 2));
      }
      writeFileSync(receipt.artifact, "corrupt");
      await expect(real.host.assertArtifact(receipt)).rejects.toThrow("changed");
    } finally { real.close(); }
  }, 120_000);
  it("requires an installed matching dependency manifest, not just a copied lockfile", async () => {
    const pkg = JSON.parse(readFileSync(join(clone, "package.json"), "utf8")); pkg.dependencies.unprovisioned = "*";
    writeFileSync(join(clone, "package.json"), JSON.stringify(pkg)); git(clone, "add", "."); git(clone, "commit", "-qm", "unprovisioned dependency");
    const p = await pinChange({ vault: pinned.vault, convId: "test", slug: "tiny", folder: repo, clone, title: "dependency mismatch" });
    await expect(createInstalledChangeHost(opts, repo, p.source, ui)).rejects.toThrow("manifest differs");
  });
});
