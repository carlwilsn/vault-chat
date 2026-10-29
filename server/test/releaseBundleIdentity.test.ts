import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve("."), bundle = join(root, "dist-server/vault-chat-server.mjs");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const rev = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
let work: string;
const env = () => ({ PATH: process.env.PATH!, HOME: work, VC_LOCALSTORAGE: join(work, "must-not-read"), VC_STATE_DIR: work, VC_VOICE_PIPELINE: "0", VC_PORT: "invalid-no-listen" });
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "vc-bundle-identity-"));
  // CI's default build, deliberately WITHOUT VC_REV. No production startup.
  execFileSync(process.execPath, ["server/build.mjs"], { cwd: root, env: env(), timeout: 120_000 });
}, 120_000);
afterAll(() => rmSync(work, { recursive: true, force: true }));
describe("executed server release identity", () => {
  it("returns full compiled HEAD with no application initialization or state writes", () => {
    const info = JSON.parse(execFileSync(process.execPath, ["--permission", `--allow-fs-read=${bundle}`, bundle, "build-info"], { cwd: root, env: env(), encoding: "utf8", timeout: 10_000 }));
    expect(info).toEqual({ version, rev }); expect(rev).toMatch(/^[a-f0-9]{40}$/);
    expect(readdirSync(work)).toEqual([]);
  });
  it("rejects an explicitly supplied short compilation revision", () => {
    const r = spawnSync(process.execPath, ["server/build.mjs"], { cwd: root, env: { ...env(), VC_REV: rev.slice(0, 8) }, encoding: "utf8" });
    expect(r.status).not.toBe(0); expect(r.stderr).toContain("full 40-character");
  });
  it("rejects forged package identity before creating release output", () => {
    for (const identity of [{ VERSION: version, REV: "f".repeat(40) }, { VERSION: "999.0.0", REV: rev }, { VERSION: version, REV: rev.slice(0, 8) }]) {
      const r = spawnSync(process.execPath, ["scripts/build-server-release.mjs"], { cwd: root, env: { ...env(), ...identity, OUT_DIR: join(work, "rejected") }, encoding: "utf8", timeout: 20_000 });
      expect(r.status).not.toBe(0); expect(r.stderr).toMatch(/compiled bundle identity|full git sha/);
    }
    expect(readdirSync(work)).toEqual([]);
  });
  it("packages precisely the executable identity and bytes it verified", () => {
    const out = join(work, "release");
    execFileSync(process.execPath, ["scripts/build-server-release.mjs"], { cwd: root, env: { ...env(), VERSION: version, REV: rev, OUT_DIR: out }, timeout: 20_000 });
    const meta = JSON.parse(readFileSync(join(out, "server-version.json"), "utf8"));
    const info = JSON.parse(execFileSync(process.execPath, [join(out, "vault-chat-server.mjs"), "build-info"], { env: env(), encoding: "utf8", timeout: 10_000 }));
    expect(info).toEqual({ version: meta.version, rev: meta.rev });
    expect(meta.sha256).toBe(createHash("sha256").update(readFileSync(join(out, "vault-chat-server.mjs"))).digest("hex"));
  });
});
