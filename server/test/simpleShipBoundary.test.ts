/** Offline argv/source boundary tests. Capture programs are NOT provisioning, sandbox or device proof. */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRunRoot, runShipGates, type ShipConfig } from "../simpleShipHost";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vc-boundary-")); roots.push(root);
  const repo = join(root, "repo"), installed = join(root, "installed");
  mkdirSync(repo); mkdirSync(join(installed, "node_modules"), { recursive: true });
  const manifest = { name: "offline-fixture", version: "1.0.0", scripts: { "test:server": "FORGED_NPM_GATE" } };
  const lock = { name: manifest.name, version: manifest.version, lockfileVersion: 3, packages: { "": { name: manifest.name, version: manifest.version } } };
  for (const dir of [repo, installed]) {
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest)); writeFileSync(join(dir, "package-lock.json"), JSON.stringify(lock));
  }
  const captures = join(root, "captures"); mkdirSync(captures);
  const capture = join(root, "capture.mjs");
  writeFileSync(capture, `import fs from 'node:fs'; import path from 'node:path';
fs.writeFileSync(path.join(${JSON.stringify(captures)},String(Date.now())+'-'+process.pid+'.json'),JSON.stringify({argv:process.argv.slice(2),env:process.env,cwd:process.cwd()}));
if(process.argv[2]==='ci')fs.mkdirSync('node_modules');`);
  const runner = join(root, "capture-runner");
  writeFileSync(runner, `#!${realpathSync("/run/current-system/sw/bin/bash")}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(capture)} "$@"\n`, { mode: 0o700 });
  const g = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=test", "-c", "user.email=test@local", ...args], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  g("init", "-qb", "main");
  const o: ShipConfig = { repo, remote: "origin", workRoot: join(root, "runs"), dependencies: join(installed, "node_modules"), pi: "/fixture-readonly-sdk", node: realpathSync(process.execPath), npm: capture, bash: realpathSync("/run/current-system/sw/bin/bash"), bwrap: runner, path: process.env.PATH! };
  const execute = async (stage = true) => { if (stage) g("add", "."); g("commit", "-qm", "offline source fixture"); return runShipGates(o, repo, g("rev-parse", "HEAD"), createRunRoot(o)); };
  const observations = () => readdirSync(captures).map(f => JSON.parse(readFileSync(join(captures, f), "utf8")) as { argv: string[]; env: Record<string, string>; cwd: string });
  return { root, repo, installed, o, g, lock, execute, observations };
}
describe("external script source and argv boundary (offline)", () => {
  it.each(["/outside", "../../outside", "../outside"])("rejects an escaping tracked source link before invoking any candidate command: %s", async target => {
    const f = fixture(); symlinkSync(target, join(f.repo, "escape"));
    await expect(f.execute()).rejects.toThrow("Source link escapes"); expect(f.observations()).toEqual([]);
  });
  it("rejects tracked dependency paths and submodules before extraction or commands", async () => {
    const f = fixture(); mkdirSync(join(f.repo, "node_modules")); writeFileSync(join(f.repo, "node_modules/forged"), "not installed");
    await expect(f.execute()).rejects.toThrow("Unsafe source path"); expect(f.observations()).toEqual([]);
    rmSync(join(f.repo, "node_modules"), { recursive: true }); f.g("add", ".");
    const commit = f.g("rev-parse", "HEAD"); f.g("update-index", "--add", "--cacheinfo", `160000,${commit},submodule`);
    await expect(f.execute(false)).rejects.toThrow("Submodule provisioning unavailable"); expect(f.observations()).toEqual([]);
  });
  it.each([
    { resolved: "https://private.example/pkg.tgz", integrity: "sha512-YQ==" },
    { resolved: "https://registry.npmjs.org.evil.example/pkg.tgz", integrity: "sha512-YQ==" },
    { resolved: "http://registry.npmjs.org/pkg.tgz", integrity: "sha512-YQ==" },
    { resolved: "https://user:fixture-password@registry.npmjs.org/pkg.tgz", integrity: "sha512-YQ==" },
    { resolved: "https://registry.npmjs.org/pkg.tgz?fixture=sentinel", integrity: "sha512-YQ==" },
    { resolved: "https://registry.npmjs.org/pkg.tgz#fragment", integrity: "sha512-YQ==" },
    { resolved: "file:../private.tgz", integrity: "sha512-YQ==" },
    { resolved: "https://registry.npmjs.org/pkg.tgz", integrity: "sha1-unsafe" },
    { resolved: "https://registry.npmjs.org/pkg.tgz" },
    { link: true, resolved: "../local" },
  ])("rejects non-public or unverified lock entries before npm/any gate: %j", async entry => {
    const f = fixture(); const lock = { ...f.lock, packages: { ...f.lock.packages, "node_modules/pkg": entry } };
    writeFileSync(join(f.repo, "package-lock.json"), JSON.stringify(lock));
    await expect(f.execute()).rejects.toThrow(); expect(f.observations()).toEqual([]);
  });
  it("validates the actual release lock against the public-registry boundary before isolated npm argv", async () => {
    const f = fixture(), dependencies = realpathSync("node_modules");
    for (const name of ["package.json", "package-lock.json"]) writeFileSync(join(f.repo, name), readFileSync(join(dirname(dependencies), name)));
    await f.execute(); expect(f.observations().filter(r => r.argv[0] === "ci")).toHaveLength(1);
    // Capture installer does not provision or verify package bytes; public npm owns integrity enforcement.
  });
  it.each([{ lockfileVersion: 2, packages: {} }, { lockfileVersion: 3 }])("requires a complete v3 package map before npm: %j", async lock => {
    const f = fixture(); writeFileSync(join(f.repo, "package-lock.json"), JSON.stringify(lock));
    await expect(f.execute()).rejects.toThrow("complete npm lockfile"); expect(f.observations()).toEqual([]);
  });
  it("passes npm only private empty configs, scrubbed env, public registry and disabled install scripts", async () => {
    const f = fixture(); writeFileSync(join(f.repo, "package-lock.json"), JSON.stringify({ ...f.lock, offlineFixture: true }));
    await f.execute(); const install = f.observations().find(r => r.argv[0] === "ci")!;
    expect(install.argv).toEqual(["ci", "--ignore-scripts", "--include=dev", "--include=optional", "--no-audit", "--no-fund"]);
    expect(Object.keys(install.env).sort()).toEqual(["CI", "HOME", "LANG", "PATH", "npm_config_cache", "npm_config_globalconfig", "npm_config_registry", "npm_config_userconfig"].sort());
    expect(install.env.npm_config_registry).toBe("https://registry.npmjs.org");
    expect(install.env.npm_config_userconfig).not.toBe(install.env.npm_config_globalconfig);
    for (const key of ["npm_config_userconfig", "npm_config_globalconfig"]) expect(readFileSync(install.env[key], "utf8")).toBe("");
    for (const key of ["HOME", "npm_config_cache", "npm_config_userconfig", "npm_config_globalconfig"]) expect(install.env[key].startsWith(f.o.workRoot + "/")).toBe(true);
    expect(existsSync(join(install.cwd, ".npmrc"))).toBe(false);
  });
  it("does not reuse host dependencies when dependency fields differ despite an identical lock", async () => {
    const f = fixture(); const pkg = JSON.parse(readFileSync(join(f.repo, "package.json"), "utf8")); pkg.dependencies = { unprovisioned: "*" };
    writeFileSync(join(f.repo, "package.json"), JSON.stringify(pkg)); await f.execute();
    expect(f.observations().filter(r => r.argv[0] === "ci")).toHaveLength(1);
    // Capture npm is only an argv fixture; real npm ci must reject this mismatch, not silently use the host tree.
  });
  it("uses fixed installed tool argv despite forged npm scripts/config and treats missing reports as incomplete", async () => {
    const f = fixture(); writeFileSync(join(f.repo, ".npmrc"), "node-options=--import=FORGED_CONTROL\nregistry=https://private.example\n");
    const results = await f.execute(), calls = f.observations();
    expect(calls).toHaveLength(10); // 4 typechecks, harness, server build + vitest, 3 final build commands
    const commands = calls.map(r => r.argv.slice(r.argv.indexOf("--") + 1));
    expect(commands.map(c => c.slice(0, 2))).toEqual([
      ...Array.from({ length: 4 }, () => [f.o.node, "/host/node_modules/typescript/bin/tsc"]),
      [f.o.node, "--import"], [f.o.node, "server/build.mjs"], [f.o.node, "/host/node_modules/vitest/vitest.mjs"],
      [f.o.node, "/host/node_modules/vite/bin/vite.js"], [f.o.node, "/host/node_modules/vite/bin/vite.js"], [f.o.node, "server/build.mjs"],
    ]);
    expect(commands.flat().join(" ")).not.toMatch(/FORGED|npm run/);
    for (const r of calls) {
      expect(r.env.NODE_OPTIONS).toBeUndefined(); expect(r.env.VITEST).toBeUndefined();
      expect(r.env.npm_config_userconfig).toBe("/host/npm-user"); expect(r.env.npm_config_globalconfig).toBe("/host/npm-global");
      for (const flag of ["--unshare-all", "--die-with-parent", "--new-session"]) expect(r.argv).toContain(flag);
      expect(r.argv.join(" ")).toContain("--ro-bind " + f.o.pi);
    }
    expect(results).toHaveLength(7);
    for (const name of ["test:harness", "test:server"]) expect(results.find(r => r.gate === name)).toMatchObject({ exitCode: 0, complete: false });
  });
});
