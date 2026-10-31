/** Actual restricted-runner isolation fixture, NOT application/release/device proof. */
import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { createRunRoot, runShipGates, type ShipConfig } from "../simpleShipHost";

describe("real private box gate runner", () => {
  it("isolates HOME, host files, environment and host loopback, mounts SDK read-only, and reports unavailable suites as failures", async () => {
    const root = mkdtempSync(join(tmpdir(), "vc-ship-isolation-")), repo = join(root, "repo"); mkdirSync(repo);
    const listener = createServer(); await new Promise<void>(done => listener.listen(0, "127.0.0.1", done));
    try {
      const dependencies = realpathSync(resolve("node_modules")), manifestRoot = dirname(dependencies);
      for (const name of ["package.json", "package-lock.json"]) writeFileSync(join(repo, name), readFileSync(join(manifestRoot, name)));
      const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
      for (const key of Object.keys(pkg.scripts)) pkg.scripts[key] = "FORGED_NPM_GATE";
      writeFileSync(join(repo, "package.json"), JSON.stringify(pkg));
      mkdirSync(join(repo, "test/harness"), { recursive: true });
      writeFileSync(join(repo, "test/harness/register.mjs"), "// fixture: no loader hooks");
      writeFileSync(join(repo, "test/harness/real-failure.test.ts"), "import {it} from 'node:test'; import assert from 'node:assert/strict'; it('real failing fixture cannot be replaced by npm scripts',()=>assert.fail('actual assertion executed')); ");
      mkdirSync(join(repo, "server"));
      const hostOnly = join(root, "host-only-fixture.txt"); writeFileSync(hostOnly, "ordinary fixture data, not a credential");
      const port = (listener.address() as { port: number }).port;
      // This is candidate BUILD code: observing its environment demonstrates where host argv executes it.
      writeFileSync(join(repo, "server/build.mjs"), `import fs from 'node:fs'; import net from 'node:net';
const sdk=process.env.VC_TEST_PI_DIR+'/node_modules/@earendil-works/pi-coding-agent/package.json';
let readonly=false;try{fs.accessSync(sdk,fs.constants.W_OK)}catch{readonly=true}
const immutable=['server/build.mjs','node_modules/typescript/bin/tsc','.git/config'].every(p=>{try{fs.accessSync(p,fs.constants.W_OK);return false}catch{return true}});
const connected=await new Promise(done=>{const s=net.connect({host:'127.0.0.1',port:${port}});s.once('connect',()=>{s.destroy();done(true)});s.once('error',()=>done(false));s.setTimeout(1000,()=>{s.destroy();done(false)})});
fs.writeFileSync('observation.json',JSON.stringify({home:process.env.HOME,hostFile:fs.existsSync(${JSON.stringify(hostOnly)}),sdk:fs.existsSync(sdk),readonly,immutable,connected,liveVault:fs.existsSync('/home/carlwilsn/vc/vaults/vault-chat'),keyNames:Object.keys(process.env).filter(k=>/KEY|TOKEN|SECRET/.test(k)),registry:process.env.npm_config_registry??null}));
`);
      const g = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=test", "-c", "user.email=test@local", ...args], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      g("init", "-qb", "main"); g("add", "."); g("commit", "-qm", "isolated runner fixture");
      const revision = g("rev-parse", "HEAD");
      const bwrap = readdirSync("/nix/store").filter(n => /-bubblewrap-[0-9]/.test(n)).map(n => join("/nix/store", n, "bin/bwrap")).find(existsSync);
      if (!bwrap) throw new Error("Required installed bubblewrap unavailable");
      // Resolve from the supplied installed PATH; a Nix bash startup can replace it under private HOME.
      const npmEntry = (process.env.PATH ?? "").split(":").map(p => join(p, "npm")).find(existsSync);
      if (!npmEntry) throw new Error("Required installed npm unavailable in PATH");
      const npm = realpathSync(npmEntry);
      const path = (process.env.PATH ?? "").split(":").map(p => { try { return realpathSync(p); } catch { return ""; } }).filter(p => p.startsWith("/nix/store/")).join(":");
      const o: ShipConfig = { repo, remote: "origin", workRoot: join(root, "runs"), dependencies, pi: process.env.VC_TEST_PI_DIR ?? join(homedir(), ".local/state/vault-chat-server/pi/1.1.0"), node: realpathSync(process.execPath), npm, bash: realpathSync("/run/current-system/sw/bin/bash"), bwrap, path };
      vi.stubEnv("OFFLINE_FIXTURE_SECRET", "ordinary-fake-sentinel-not-a-credential");
      vi.stubEnv("npm_config_registry", "https://must-not-inherit.invalid");
      const run = createRunRoot(o), results = await runShipGates(o, repo, revision, run);
      expect(JSON.parse(readFileSync(join(run, revision, "observation.json"), "utf8"))).toEqual({ home: "/tmp/h", hostFile: false, sdk: true, readonly: true, immutable: true, connected: false, liveVault: false, keyNames: [], registry: null });
      expect(results).toHaveLength(7);
      const harness = results.find(r => r.gate === "test:harness")!;
      expect(harness).toMatchObject({ exitCode: 1, complete: true });
      expect(harness.tests).toContainEqual({ file: "test/harness/real-failure.test.ts", name: "real failing fixture cannot be replaced by npm scripts", status: "failed" });
      for (const result of results) expect(readFileSync(result.logArtifact, "utf8")).not.toContain("FORGED_NPM_GATE");
      expect(results.find(r => r.gate === "test:server")?.complete).toBe(false);
      expect(results.find(r => r.gate === "build:server")?.exitCode).not.toBe(0);
    } finally { vi.unstubAllEnvs(); await new Promise<void>(done => listener.close(() => done())); rmSync(root, { recursive: true, force: true }); }
  }, 25_000);
});
