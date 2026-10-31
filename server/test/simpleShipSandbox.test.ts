/** Actual restricted-runner isolation fixture, NOT application/release/device proof. */
import { describe, expect, it } from "vitest";
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
      mkdirSync(join(repo, "server"));
      const hostOnly = join(root, "host-only-fixture.txt"); writeFileSync(hostOnly, "ordinary fixture data, not a credential");
      const port = (listener.address() as { port: number }).port;
      // This is candidate BUILD code: observing its environment demonstrates where host argv executes it.
      writeFileSync(join(repo, "server/build.mjs"), `import fs from 'node:fs'; import net from 'node:net';
const sdk=process.env.VC_TEST_PI_DIR+'/node_modules/@earendil-works/pi-coding-agent/package.json';
let readonly=false;try{fs.accessSync(sdk,fs.constants.W_OK)}catch{readonly=true}
const connected=await new Promise(done=>{const s=net.connect({host:'127.0.0.1',port:${port}});s.once('connect',()=>{s.destroy();done(true)});s.once('error',()=>done(false));s.setTimeout(1000,()=>{s.destroy();done(false)})});
fs.writeFileSync('observation.json',JSON.stringify({home:process.env.HOME,hostFile:fs.existsSync(${JSON.stringify(hostOnly)}),sdk:fs.existsSync(sdk),readonly,connected,liveVault:fs.existsSync('/home/carlwilsn/vc/vaults/vault-chat'),keyNames:Object.keys(process.env).filter(k=>/KEY|TOKEN|SECRET/.test(k))}));
`);
      const g = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=test", "-c", "user.email=test@local", ...args], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      g("init", "-qb", "main"); g("add", "."); g("commit", "-qm", "isolated runner fixture");
      const revision = g("rev-parse", "HEAD");
      const bwrap = readdirSync("/nix/store").filter(n => /-bubblewrap-[0-9]/.test(n)).map(n => join("/nix/store", n, "bin/bwrap")).find(existsSync);
      if (!bwrap) throw new Error("Required installed bubblewrap unavailable");
      const npm = realpathSync(execFileSync("bash", ["-c", "command -v npm"], { encoding: "utf8" }).trim());
      const path = (process.env.PATH ?? "").split(":").map(p => { try { return realpathSync(p); } catch { return ""; } }).filter(p => p.startsWith("/nix/store/")).join(":");
      const o: ShipConfig = { repo, remote: "origin", workRoot: join(root, "runs"), dependencies, pi: process.env.VC_TEST_PI_DIR ?? join(homedir(), ".local/state/vault-chat-server/pi/1.1.0"), node: realpathSync(process.execPath), npm, bash: realpathSync("/run/current-system/sw/bin/bash"), bwrap, path };
      const run = createRunRoot(o), results = await runShipGates(o, repo, revision, run);
      expect(JSON.parse(readFileSync(join(run, revision, "observation.json"), "utf8"))).toEqual({ home: "/tmp/h", hostFile: false, sdk: true, readonly: true, connected: false, liveVault: false, keyNames: [] });
      expect(results).toHaveLength(7);
      expect(results.find(r => r.gate === "test:server")?.complete).toBe(false);
      expect(results.find(r => r.gate === "build:server")?.exitCode).not.toBe(0);
    } finally { await new Promise<void>(done => listener.close(() => done())); rmSync(root, { recursive: true, force: true }); }
  }, 25_000);
});
