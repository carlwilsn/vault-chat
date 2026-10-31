import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptedChanges, acceptedFailedRelease, prepareAcceptanceLocked, updateShippingJournal, type AcceptedChange } from "../changeShipping";
import { configureChangeDelivery, observeChangeDelivery, requestDeliveryRollback } from "../changeDelivery";

import { withRepoLock } from "../git";

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
    const c: AcceptedChange = { id, preparedAt: new Date().toISOString(), source: { base, head, tree, branch: `agent/${id}` }, review: { convId: "project-app", slug: "app", folder: repo, clone: "unused", base: "main", branch: `agent/${id}`, sha: head, title: id, at: new Date().toISOString() }, proofDir: join(root, id),  release: published };
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
  it.each(["missing", "wrong revision", "wrong version", "future", "stale", "nonfinite", "unknown", "unaccepted"])("automatic post-release controller refuses %s marker before selection or rollback", async kind => {
    const f = await fixture(), now = Date.now();
    const file = join(f.root, "state/release-failures", createHash("sha256").update(f.release.version).digest("hex") + ".json");
    const marker = { version: f.release.version, revision: f.release.revision, observedAt: now - 1 };
    if (kind === "wrong revision") marker.revision = "d".repeat(40);
    if (kind === "wrong version") marker.version = "9.9.9";
    if (kind === "future") marker.observedAt = now + 60_000;
    if (kind === "stale") marker.observedAt = Date.parse(f.release.publishedAt) - 1;
    if (kind === "nonfinite") marker.observedAt = NaN;
    if (kind === "missing") rmSync(file); else writeFileSync(file, JSON.stringify(marker));
    if (kind === "unknown") await updateShippingJournal(f.repo, j => { for (const c of j.changes) c.release = undefined; });
    if (kind === "unaccepted") {
      const tree = f.g("rev-parse", "HEAD^{tree}"), head = f.g("commit-tree", tree, "-p", f.g("rev-parse", "HEAD"), "-m", "unaccepted fixture branch");
      await updateShippingJournal(f.repo, j => { for (const c of j.changes) { c.acceptedAt = undefined; c.source.head = head; c.source.tree = tree; } });
    }
    vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      await observeChangeDelivery(f.repo);
      expect(f.rollback).not.toHaveBeenCalled();
      const j = await updateShippingJournal(f.repo, j => j);
      expect(j.recoverySelections).toBeUndefined(); expect(Object.keys(j.delivery?.rollbacks ?? {})).toEqual([]);
    } finally { vi.restoreAllMocks(); }
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
});
