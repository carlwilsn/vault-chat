import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertRecoveryCompletion, runPublishedRecoveryCli, verifiedRecoveryFailure, verifyRetainedRecoveryBundle } from "../publishedRecovery";
import type { AcceptedChange } from "../changeShipping";
const dirs: string[] = [];
const hash = (b: string) => createHash("sha256").update(b).digest("hex");
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function installed() {
  const stateDir = mkdtempSync(join(tmpdir(), "vc-installed-recovery-")); dirs.push(stateDir);
  const version = "0.7.999", revision = "a".repeat(40), dir = join(stateDir, "versions", version);
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, "vault-chat-server.mjs"); writeFileSync(entry, "trusted installed bundle");
  const meta = { version, rev: revision, sha256: hash("trusted installed bundle") };
  writeFileSync(join(dir, "server-version.json"), JSON.stringify(meta));
  return { stateDir, version, revision, entry, meta, dir };
}
describe("retained installed recovery authority", () => {
  it("requires the exact retained installed bundle/source/version/checksum, never a developer sidecar", () => {
    const o = installed(); expect(() => verifyRetainedRecoveryBundle(o)).not.toThrow();
    const dev = join(o.stateDir, "developer.mjs"); copyFileSync(o.entry, dev);
    expect(() => verifyRetainedRecoveryBundle({ ...o, entry: dev })).toThrow("never a candidate/developer");
    writeFileSync(o.entry, "modified bundle"); expect(() => verifyRetainedRecoveryBundle(o)).toThrow("checksum/version/source");
    expect(() => verifyRetainedRecoveryBundle({ ...o, revision: "short" })).toThrow("full installed release");
    writeFileSync(o.entry, "trusted installed bundle");
    writeFileSync(join(o.dir, "server-version.json"), JSON.stringify({ ...o.meta, rev: "b".repeat(40) }));
    expect(() => verifyRetainedRecoveryBundle(o)).toThrow("checksum/version/source");
  });
  it("requires a durable fresh host failure matched to an accepted published identity", () => {
    const o = installed(), now = Date.now();
    const c = { acceptedAt: new Date(now - 20_000).toISOString(), release: { id: "published", version: o.version, revision: o.revision, tag: `v${o.version}`, publishedAt: new Date(now - 10_000).toISOString() } } as AcceptedChange;
    expect(verifiedRecoveryFailure(o.stateDir, c, now)).toBeNull();
    const root = join(o.stateDir, "release-failures"); mkdirSync(root);
    const file = join(root, `${hash(o.version)}.json`);
    const marker = { version: o.version, revision: o.revision, observedAt: now - 1_000 };
    writeFileSync(file, JSON.stringify(marker));
    expect(verifiedRecoveryFailure(o.stateDir, c, now)).toContain("specific accepted source change");
    expect(verifiedRecoveryFailure(o.stateDir, { ...c, acceptedAt: undefined }, now)).toBeNull();
    for (const bad of [{ ...marker, revision: "b".repeat(40) }, { ...marker, observedAt: now + 1 }, { ...marker, observedAt: now - 30_000 }]) {
      writeFileSync(file, JSON.stringify(bad)); expect(() => verifiedRecoveryFailure(o.stateDir, c, now)).toThrow("identity/timestamp");
    }
  });
  it("cannot report recovery success for no accepted identity, or only partial accepted/transported results", () => {
    expect(() => assertRecoveryCompletion(0, 0)).toThrow("no verified accepted source identity");
    expect(() => assertRecoveryCompletion(2, 1)).toThrow("Not every matching");
    expect(() => assertRecoveryCompletion(1, 1)).not.toThrow();
    expect(() => assertRecoveryCompletion(2, 2)).not.toThrow();
  });
  it("refuses ordinary/manual invocation before any project, model, listener or key-store work", async () => {
    vi.stubEnv("VC_UPDATER_RECOVERY", ""); vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runPublishedRecoveryCli()).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Only the installed updater"));
  });
});
