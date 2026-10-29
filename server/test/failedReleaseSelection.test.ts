import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptedChanges, acceptedFailedRelease, prepareAcceptanceLocked, updateShippingJournal, type AcceptedChange } from "../changeShipping";
import { configureChangeDelivery, observeChangeDelivery, requestDeliveryRollback } from "../changeDelivery";
import { prepareSourceRollback, ROLLBACK_CHECK } from "../sourceRollback";
import { withRepoLock } from "../git";
import type { GateReceipt, TestCase } from "../changeProof";
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vc-failed-release-")); roots.push(root);
  const repo = join(root, "repo"), vault = join(root, "vault"); mkdirSync(repo); mkdirSync(vault);
  const g = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=test", "-c", "user.email=test@local", ...args], { cwd: repo, encoding: "utf8" }).trim();
  g("init", "-qb", "main"); writeFileSync(join(repo, "base.txt"), "base"); g("add", "."); g("commit", "-qm", "base");
  const release = { id: "failed-release", version: "1.0.1", revision: "a".repeat(40), tag: "v1.0.1", publishedAt: new Date(Date.now() - 1000).toISOString() };
  const add = async (id: string, published: typeof release | undefined = release) => {
    const base = g("rev-parse", "HEAD"); writeFileSync(join(repo, `${id}.txt`), id); g("add", "."); g("commit", "-qm", id);
    const head = g("rev-parse", "HEAD"), tree = g("rev-parse", "HEAD^{tree}");
    const c: AcceptedChange = { id, preparedAt: new Date().toISOString(), source: { base, head, tree, branch: `agent/${id}` }, review: { convId: "project-app", slug: "app", folder: repo, clone: "unused", base: "main", branch: `agent/${id}`, sha: head, title: id, at: new Date().toISOString() }, proofDir: join(root, id), check: ROLLBACK_CHECK, release: published };
    await withRepoLock(repo, () => prepareAcceptanceLocked(repo, c)); await acceptedChanges(repo);
    return (await acceptedChanges(repo)).find(a => a.id === id)!;
  };
  const first = await add("first"), second = await add("second");
  const stateDir = join(root, "state"), markers = join(stateDir, "release-failures"); mkdirSync(markers, { recursive: true });
  writeFileSync(join(markers, createHash("sha256").update(release.version).digest("hex") + ".json"), JSON.stringify({ version: release.version, revision: release.revision, observedAt: Date.now() }));
  const rollback = vi.fn(async (_repo: string, _id: string, _reason: string): Promise<import("../../src/shippingProtocol").ShipmentRollback> => ({ status: "accepted" }));
  configureChangeDelivery({ stateDir, vaults: () => [], boxHealth: async () => ({ version: "1.0.0", revision: "b".repeat(40), observedAt: Date.now(), ready: true }), requestSourceRollback: rollback });
  return { root, repo, vault, g, release, add, first, second, rollback };
}
describe("one durable failed-release recovery selection", () => {
  it("uses the same newest-first selection in live service and retained CLI helper, excluding later releases", async () => {
    const f = await fixture();
    // Retained CLI freezes first. A later accepted release must survive either entry route.
    expect((await acceptedFailedRelease(f.repo, f.release.id, f.release.revision)).map(c => c.id)).toEqual(["second", "first"]);
    await f.add("later", { ...f.release, id: "newer-release", version: "1.0.2", revision: "c".repeat(40) });
    await observeChangeDelivery(f.repo); await observeChangeDelivery(f.repo);
    expect(f.rollback.mock.calls.map(c => c[1])).toEqual(["second", "first"]);
    expect((await acceptedFailedRelease(f.repo, f.release.id, f.release.revision)).map(c => c.id)).toEqual(["second", "first"]);
    const j = await updateShippingJournal(f.repo, j => j);
    expect(j.recoverySelections?.[f.release.id].changeIds).toEqual(["second", "first"]);
    expect(j.recoverySelections?.["newer-release"]).toBeUndefined();
  });
  it("manual card recovery remains only that card, not the release batch", async () => {
    const f = await fixture(); await requestDeliveryRollback(f.repo, f.first.id, "Carl selected this card");
    expect(f.rollback.mock.calls.map(c => c[1])).toEqual(["first"]);
    expect(await updateShippingJournal(f.repo, j => j.recoverySelections)).toBeUndefined();
  });
  it("does not start older dependent reverts while the newest is running, or retry a durable failure", async () => {
    const f = await fixture();
    f.rollback.mockImplementation(async () => ({ status: "running" }));
    await observeChangeDelivery(f.repo); expect(f.rollback.mock.calls.map(c => c[1])).toEqual(["second"]);
    await updateShippingJournal(f.repo, j => { j.delivery!.rollbacks.second = { status: "failed", error: "Needs attention" }; });
    await observeChangeDelivery(f.repo); expect(f.rollback).toHaveBeenCalledTimes(1);
    expect((await acceptedFailedRelease(f.repo, f.release.id, f.release.revision)).map(c => c.id)).toEqual(["second", "first"]);
  });
  it("recognizes accepted rollback identities after stale running state without double reversal", async () => {
    const f = await fixture();
    await updateShippingJournal(f.repo, j => { j.changes.push({ ...f.second, id: "already-reverted", rollbackOf: f.second.id, release: undefined }); });
    await observeChangeDelivery(f.repo); expect(f.rollback.mock.calls.map(c => c[1])).toEqual(["first"]);
    expect(await updateShippingJournal(f.repo, j => j.delivery!.rollbacks.second.status)).toBe("accepted");
  });
  it("actually reverts all failed-release source changes newest-first and preserves later unrelated work", async () => {
    const f = await fixture(); await f.add("later", { ...f.release, id: "newer-release", revision: "c".repeat(40) });
    for (const accepted of await acceptedFailedRelease(f.repo, f.release.id, f.release.revision)) {
      const r = await prepareSourceRollback({ vault: f.vault, accepted, privateRoot: join(f.root, "recovery") });
      try { f.g("merge", "--ff-only", r.pinned.source.head); } finally { r.close(); }
    }
    expect(f.g("ls-files").split("\n")).toEqual(["base.txt", "later.txt"]);
    expect(readFileSync(join(f.repo, "later.txt"), "utf8")).toBe("later");
  });
});
const t = (name: string): TestCase => ({ file: "server/test/feature.test.ts", name, status: "passed" });
const gates = (source: string, names: string[]): GateReceipt[] => ["test:harness", "test:server"].map(gate => ({ gate, source, complete: true, tests: names.map(t) } as GateReceipt));
describe("host-attested exact rollback test-removal authority", () => {
  it("permits only original receipt additions, never later unrelated tests, forged pins or mutated receipts", async () => {
    const f = await fixture(), a = f.second; mkdirSync(a.proofDir);
    const receipt = { id: a.id, source: a.source, baseline: gates(a.source.base, ["existing"]), candidate: gates(a.source.head, ["existing", "feature-added"]) };
    writeFileSync(join(a.proofDir, "receipt.json"), JSON.stringify(receipt));
    const r = await prepareSourceRollback({ vault: f.vault, accepted: a, privateRoot: join(f.root, "policy") });
    try {
      const baseline = gates(r.pinned.source.base, ["existing", "feature-added", "later-unrelated"]), candidate = gates(r.pinned.source.head, ["existing"]);
      expect(await r.rollbackRemovedTests(r.pinned.source, baseline, candidate)).toEqual({ "test:harness": [{ file: t("").file, name: "feature-added" }], "test:server": [{ file: t("").file, name: "feature-added" }] });
      await expect(r.rollbackRemovedTests({ ...r.pinned.source, tree: "f".repeat(40) }, baseline, candidate)).rejects.toThrow("exact service-generated revert");
      writeFileSync(join(a.proofDir, "receipt.json"), JSON.stringify({ ...receipt, id: "forged" }));
      await expect(r.rollbackRemovedTests(r.pinned.source, baseline, candidate)).rejects.toThrow("receipt changed");
    } finally { r.close(); }
  });
});
