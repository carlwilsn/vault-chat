import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { provisionProofDependencies, validatePublicProofLock } from "../changeHostConfig";
const dirs: string[] = [];
const manifest = readFileSync(resolve("package.json"), "utf8"), lock = readFileSync(resolve("package-lock.json"), "utf8");
afterEach(() => { delete process.env.VC_INSTALL_CANARY; for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
describe("installed proof provisioning boundary", () => {
  it("accepts the actual release lock but rejects private URLs, missing integrity and local links", () => {
    expect(() => validatePublicProofLock(manifest, lock)).not.toThrow();
    for (const patch of [{ resolved: "https://private.invalid/package.tgz" }, { integrity: "" }, { link: true }]) {
      const parsed = JSON.parse(lock), entry = Object.keys(parsed.packages).find(k => !!k)!;
      Object.assign(parsed.packages[entry], patch);
      expect(() => validatePublicProofLock(manifest, JSON.stringify(parsed))).toThrow();
    }
  });
  it("uses isolated empty npm config and scrubbed env, disables hooks, dedupes and verifies cache manifests", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vc-provision-unit-")); dirs.push(dir);
    const npm = join(dir, "npm-fixture.cjs");
    writeFileSync(npm, `const fs=require('fs'),path=require('path'),assert=require('assert/strict');
      assert.equal(process.env.VC_INSTALL_CANARY,undefined); assert.equal(process.env.NODE_OPTIONS,undefined);
      assert.equal(fs.readFileSync(process.env.npm_config_userconfig,'utf8'),'');
      assert.equal(fs.readFileSync(process.env.npm_config_globalconfig,'utf8'),'');
      assert.notEqual(process.env.npm_config_userconfig,process.env.npm_config_globalconfig);
      for(const flag of ['ci','--ignore-scripts','--include=dev','--include=optional']) assert(process.argv.includes(flag));
      for(const file of ['typescript/bin/tsc','vitest/vitest.mjs','tsx/dist/loader.mjs','esbuild/bin/esbuild']) {const p=path.join('node_modules',file);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,'fixture');}
    `);
    process.env.VC_INSTALL_CANARY = "not-a-key";
    const opts = { root: join(dir, "cache"), node: process.execPath, npm, path: process.env.PATH! };
    const [a, b] = await Promise.all([provisionProofDependencies(opts, manifest, lock), provisionProofDependencies(opts, manifest, lock)]);
    expect(a).toEqual(b); expect(existsSync(join(a.dependencies, "typescript/bin/tsc"))).toBe(true);
    expect(await provisionProofDependencies(opts, manifest, lock)).toEqual(a);
    writeFileSync(a.dependencyLock, "{}");
    await expect(provisionProofDependencies(opts, manifest, lock)).rejects.toThrow("cache identity changed");
  });
});
