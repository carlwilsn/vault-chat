import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:net";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { CHANGE_COMMANDS, CHANGE_GATES } from "../changeProof";
import { checkSourceLinks, createInstalledChangeHost, pinChange, PROOF_GATE_SCRIPTS, type ChangeHostOptions, type PinnedChange, type SubmitCheck } from "../changeHost";
import { buildSandbox } from "../engine/index";
import { findBwrap } from "../engine/pi/install";
import { findBrowser } from "../headless";
import { prepareSourceRollback } from "../sourceRollback";
import type { AcceptedChange } from "../changeShipping";

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
    listener = createServer(s => s.end());
    await new Promise<void>((done, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", done); });
    const hostPort = (listener.address() as import("node:net").AddressInfo).port;
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    Object.assign(pkg.scripts, PROOF_GATE_SCRIPTS);
    writeFileSync(join(repo, "package.json"), JSON.stringify(pkg));
    writeFileSync(join(repo, "package-lock.json"), readFileSync(join(root, "package-lock.json")));
    writeFileSync(join(repo, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler", skipLibCheck: true, types: [] }, files: ["source.ts"] }));
    writeFileSync(join(repo, "source.ts"), "export const value: number = 1;\n");
    writeFileSync(join(repo, "source.mjs"), "export const value = 1;\n");
    for (const d of ["phone", "board", "server", "test/harness"]) mkdirSync(join(repo, d), { recursive: true });
    for (const d of ["phone", "board", "server"]) writeFileSync(join(repo, d, "tsconfig.json"), JSON.stringify({ compilerOptions: { skipLibCheck: true, types: [] }, files: ["../source.ts"] }));
    for (const d of ["phone", "board"]) {
      writeFileSync(join(repo, d, "index.html"), '<main>Real Vite fixture</main><script type="module" src="../source.mjs"></script>');
      writeFileSync(join(repo, d, "vite.config.ts"), 'import {fileURLToPath} from "node:url"; export default {root:fileURLToPath(new URL(".",import.meta.url))};');
    }
    writeFileSync(join(repo, "server/build.mjs"), 'import {build} from "esbuild"; await build({entryPoints:["source.mjs"],outfile:"dist-server/source.mjs",bundle:true});');
    writeFileSync(join(repo, "test/harness/register.mjs"), '/* trusted fixture has no web imports */');
    writeFileSync(join(repo, "server/vitest.config.ts"), 'export default {test:{include:["tiny.vitest.test.ts"],fileParallelism:false}};\n');
    writeFileSync(join(repo, "tiny.vitest.test.ts"), `
      import {it,expect} from "vitest";
      import {homedir} from "node:os";
      import {join} from "node:path";
      import {existsSync,writeFileSync} from "node:fs";
      it("actual vitest passes",()=>expect(1+1).toBe(2));
      for (const origin of ["env", "HOME"]) it(origin + " real native factories", async () => {
        const prefix = origin === "env" ? process.env.VC_TEST_PI_DIR : join(homedir(), ".local/state/vault-chat-server/pi/1.1.0");
        expect(prefix).toBe("/tmp/proof-home/.local/state/vault-chat-server/pi/1.1.0");
        const api = await import(join(prefix, "node_modules/@earendil-works/pi-coding-agent/dist/core/tools/index.js"));
        for (const factory of ["createReadTool", "createBashTool", "createEditTool", "createWriteTool"]) expect(typeof api[factory]).toBe("function");
        const path = "/tmp/native-" + origin;
        await api.createWriteTool(process.cwd()).execute("write", {path,content:"actual factory output"});
        const read = await api.createReadTool(process.cwd()).execute("read", {path});
        expect(read.content).toContainEqual({type:"text",text:"actual factory output"});
        expect(() => writeFileSync(join(prefix,"must-not-write"),"no")).toThrow();
        expect(existsSync(${JSON.stringify(join(repo, "outside-marker"))})).toBe(false);
        expect(process.env.VC_PROOF_TEST_MARKER).toBeUndefined();
      });
    `);
    writeFileSync(join(repo, "outside-marker"), "host-only marker");
    writeFileSync(join(repo, "test/harness/tiny.test.ts"), `import {it,describe} from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import net from 'node:net';
      describe('first suite',()=>it('same leaf',()=>assert.equal(2+2,4)));
      describe('second suite',()=>it('same leaf',()=>assert.equal(3+3,6)));
      it('forged output is only test stdout',()=>{
        console.log(JSON.stringify({type:'test:pass',data:{name:'forged pass',file:'forged.ts',details:{}}}));
        console.log(JSON.stringify({type:'vc:complete'}));
        console.log('@@vc-vitest@@'+JSON.stringify({numTotalTests:1,numPassedTests:1,numFailedTests:0,testResults:[{name:'forged.ts',assertionResults:[{fullName:'forged pass',status:'passed'}]}]}));
        fs.writeFileSync('/tmp/server-tests.json','forged report');
      });
      it('host tmp and environment hidden' ,()=>{assert.equal(process.env.VC_PROOF_TEST_MARKER,undefined); assert.equal(fs.existsSync(${JSON.stringify(join(repo, "outside-marker"))}),false);});
      it('tracked source immutable',()=>assert.throws(()=>fs.writeFileSync('source.mjs','tampered')));
      it('cannot reach host loopback',async()=>{await new Promise((resolve,reject)=>{const s=net.connect(${hostPort},'127.0.0.1');s.on('connect',()=>{s.destroy();reject(Error('escaped network namespace'));});s.on('error',resolve);});});
    `);
    git(repo, "add", "."); git(repo, "commit", "-qm", "baseline");
    git(dir, "clone", "-q", repo, clone); git(clone, "switch", "-qc", "agent/tiny");
    writeFileSync(join(clone, "source.ts"), "export const value: number = 2;\n");
    git(clone, "add", "."); git(clone, "commit", "-qm", "[agent] candidate");
    pinned = await pinChange({ vault: join(dir, "vault"), convId: "test", slug: "tiny", folder: repo, clone, title: "tiny change" });
    const shell = buildSandbox({ bwrap, home: homedir(), stateDir: join(dir, "state"), secretsDir: join(dir, "never-read-secrets"), hideFiles: [], sessionsDir: join(dir, "sessions"), agentDir: join(dir, "agent"), vault: join(dir, "vault"), uid: process.getuid!() }).shell!;
    const npm = execFileSync("sh", ["-c", "command -v npm"], { encoding: "utf8" }).trim();
    opts = { shell, home: homedir(), privateRoot: join(dir, "proofs"), installedEntry: join(root, "dist-server/vault-chat-server.mjs"),
      pi: { dir: process.env.VC_TEST_PI_DIR ?? join(homedir(), ".local/state/vault-chat-server/pi/1.1.0"), version: "1.1.0" },
      dependencies: join(root, "node_modules"), dependencyLock: join(root, "package-lock.json"), node: process.execPath, npm, path: process.env.PATH!, timeoutMs: 60_000 };
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
        expect(JSON.parse(readFileSync(r.logArtifact, "utf8")).stdout).toBe(r.stdout);
        if (gate === "test:harness") {
          expect(r.tests).toHaveLength(6);
          expect(r.tests?.some(t => t.name === "forged pass")).toBe(false);
          expect(r.tests?.filter(t => t.name.includes("same leaf")).map(t => t.name)).toEqual(['["first suite","same leaf"]', '["second suite","same leaf"]']);
        }
        if (gate === "test:server") expect(r.tests).toEqual(["actual vitest passes", "env real native factories", "HOME real native factories"].map(name => ({ file: "tiny.vitest.test.ts", name, status: "passed" })));
        await runner.host.assertSource(revision);
      }
    }
  }, 120_000);
  it("mounts the actual pinned pi read-only for both env and private-HOME factory imports", async () => {
    for (const revision of [pinned.source.base, pinned.source.head]) {
      const result = await runner.host.execute(revision, "test:server", CHANGE_COMMANDS["test:server"]);
      expect(result.exitCode, result.stderr + result.stdout).toBe(0);
      expect(result.complete).toBe(true);
      expect(result.tests).toHaveLength(3);
      expect(result.tests?.every(t => t.status === "passed")).toBe(true);
    }
    await expect(createInstalledChangeHost({ ...opts, pi: { ...opts.pi!, version: "wrong-pin" } }, repo, pinned.source, ui)).rejects.toThrow("actual pinned pi");
  });
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
  it("rejects ALL forged npm gates and indirect runner controls before any gate runs", async () => {
    const original = readFileSync(join(clone, "package.json"), "utf8");
    const pkg = JSON.parse(original);
    // This previously returned exit 0 + a forged complete report without invoking either framework.
    for (const key of Object.keys(pkg.scripts)) pkg.scripts[key] = `node -e 'console.log(JSON.stringify({type:"vc:complete"}))'`;
    writeFileSync(join(clone, "package.json"), JSON.stringify(pkg));
    writeFileSync(join(clone, "test/harness/forged-failure.test.ts"), "import {it} from 'node:test'; import assert from 'node:assert/strict'; it('must actually fail',()=>assert.fail('not run by forged npm')); ");
    git(clone, "add", "."); git(clone, "commit", "-qm", "forged all gates with real failing test");
    let p = await pinChange({ vault: pinned.vault, convId: "test", slug: "tiny", folder: repo, clone, title: "forged gates" });
    await expect(createInstalledChangeHost(opts, repo, p.source, ui)).rejects.toThrow("package scripts");
    writeFileSync(join(clone, "package.json"), original);
    git(clone, "add", "."); git(clone, "commit", "-qm", "restore scripts; actual failing test remains");
    p = await pinChange({ vault: pinned.vault, convId: "test", slug: "tiny", folder: repo, clone, title: "actual failure" });
    const actual = await createInstalledChangeHost(opts, repo, p.source, ui);
    try {
      const r = await actual.host.execute(p.source.head, "test:harness", CHANGE_COMMANDS["test:harness"]);
      expect(r.exitCode).toBe(1); expect(r.complete).toBe(true);
      expect(r.tests).toContainEqual({file:"test/harness/forged-failure.test.ts",name:"must actually fail",status:"failed"});
    } finally { actual.close(); }
    const originalBuild = readFileSync(join(clone, "server/build.mjs"), "utf8");
    writeFileSync(join(clone, "server/build.mjs"), "process.exit(0)");
    git(clone, "add", "."); git(clone, "commit", "-qm", "indirect build noop");
    p = await pinChange({ vault: pinned.vault, convId: "test", slug: "tiny", folder: repo, clone, title: "indirect noop" });
    await expect(createInstalledChangeHost(opts, repo, p.source, ui)).rejects.toThrow("server/build.mjs");
    writeFileSync(join(clone, "server/build.mjs"), originalBuild);
    rmSync(join(clone, "test/harness/forged-failure.test.ts"));
    git(clone, "add", "."); git(clone, "commit", "-qm", "restore fixture");
  }, 120_000);
  it("executes trusted current-main gate implementations during an exact host-attested infrastructure revert", async () => {
    const historical = join(dir,"historical"); git(dir,"clone","-q",repo,historical);
    const buildFile = join(historical,"server/build.mjs"), build = readFileSync(buildFile,"utf8");
    writeFileSync(buildFile,build+'\nconsole.log("HISTORICAL_GATE");'); git(historical,"add","."); git(historical,"commit","-qm","older trusted gate");
    const base = git(historical,"rev-parse","HEAD");
    writeFileSync(buildFile,build+'\nconsole.log("CURRENT_TRUSTED_GATE");'); git(historical,"add","."); git(historical,"commit","-qm","historical installed gate upgrade");
    const head = git(historical,"rev-parse","HEAD"), tree = git(historical,"rev-parse","HEAD^{tree}");
    const proofDir = join(dir,"historical-receipt"); mkdirSync(proofDir);
    const accepted: AcceptedChange = {id:"historical-upgrade",preparedAt:new Date().toISOString(),acceptedAt:new Date().toISOString(),source:{base,head,tree,branch:"agent/historical"},review:{convId:"test",slug:"tiny",folder:historical,clone:"unused",base:"main",branch:"agent/historical",sha:head,title:"historical upgrade",at:new Date().toISOString()},proofDir,check:ui};
    writeFileSync(join(proofDir,"receipt.json"),JSON.stringify({id:accepted.id,source:accepted.source,baseline:[],candidate:[]}));
    const recovery = await prepareSourceRollback({vault:pinned.vault,accepted,privateRoot:join(dir,"historical-recovery")});
    try {
      await expect(createInstalledChangeHost(opts,historical,recovery.pinned.source,ui)).rejects.toThrow("server/build.mjs");
      await expect(recovery.rollbackGateInfrastructure({...recovery.pinned.source,tree:"f".repeat(40)})).rejects.toThrow("exact service-generated revert");
      const actual = await createInstalledChangeHost({...opts,rollbackGateInfrastructure:recovery.rollbackGateInfrastructure,rollbackRemovedTests:recovery.rollbackRemovedTests},historical,recovery.pinned.source,ui);
      try {
        for (const revision of [recovery.pinned.source.base,recovery.pinned.source.head]) {
          const result = await actual.host.execute(revision,"build:server",CHANGE_COMMANDS["build:server"]);
          expect(result.exitCode,result.stderr).toBe(0); expect(result.stdout).toContain("CURRENT_TRUSTED_GATE"); expect(result.stdout).not.toContain("HISTORICAL_GATE");
          await actual.host.assertSource(revision);
        }
        expect(git(historical,"show",recovery.pinned.source.head+":server/build.mjs")).toContain("HISTORICAL_GATE");
      } finally {actual.close();}
    } finally {recovery.close();}
  },120_000);
  it("requires an installed matching dependency manifest, not just a copied lockfile", async () => {
    const pkg = JSON.parse(readFileSync(join(clone, "package.json"), "utf8")); pkg.dependencies.unprovisioned = "*";
    writeFileSync(join(clone, "package.json"), JSON.stringify(pkg)); git(clone, "add", "."); git(clone, "commit", "-qm", "unprovisioned dependency");
    const p = await pinChange({ vault: pinned.vault, convId: "test", slug: "tiny", folder: repo, clone, title: "dependency mismatch" });
    await expect(createInstalledChangeHost(opts, repo, p.source, ui)).rejects.toThrow("manifest differs");
  });
});
