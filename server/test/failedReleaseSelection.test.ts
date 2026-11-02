import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptedChanges, prepareAcceptanceLocked, updateShippingJournal, type AcceptedChange } from "../changeShipping";
import { configureChangeDelivery, observeChangeDelivery } from "../changeDelivery";

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
  const rollback = vi.fn(async (_repo: string, _id: string, _reason: string): Promise<{status:string}> => ({ status: "accepted" }));
  // Simulate a stale JS caller; the retired adapter must be ignored, not registered.
  configureChangeDelivery({ stateDir, vaults: () => [], boxHealth: async () => ({ version: "1.0.0", revision: "b".repeat(40), observedAt: Date.now(), ready: true }), requestSourceRollback: rollback } as Parameters<typeof configureChangeDelivery>[0]);
  return { root, repo, vault, g, release, add, first, second, rollback };
}
describe("failed-release source selection is retired, historical state is inert", () => {
  it.each(["requested", "running", "accepted", "failed"])("ignores frozen selections plus %s recovery across repeated cycles", async status => {
    const f = await fixture();
    const recoverySelections = { [f.release.id]: { revision: f.release.revision, changeIds: [f.second.id, f.first.id], selectedAt: new Date().toISOString() } };
    const rollbacks = { [f.second.id]: { status, jobId: "old-job" }, [f.first.id]: { status: "requested" } };
    await updateShippingJournal(f.repo, j => Object.assign(j, { recoverySelections, delivery: { releases: {}, rollbacks } }));
    await f.add("later", { ...f.release, id: "later-release", version: "1.0.2", revision: "c".repeat(40) });
    const refs = f.g("show-ref"), head = readFileSync(join(f.repo, ".git/HEAD"));
    await observeChangeDelivery(f.repo); await observeChangeDelivery(f.repo);
    expect(f.rollback).not.toHaveBeenCalled(); expect(f.g("show-ref")).toBe(refs);
    expect(readFileSync(join(f.repo, ".git/HEAD"))).toEqual(head);
    const j = await updateShippingJournal(f.repo, j => j) as unknown as {recoverySelections:unknown;delivery:{rollbacks:unknown}};
    expect(j.recoverySelections).toEqual(recoverySelections); expect(j.delivery.rollbacks).toEqual(rollbacks);
    expect(await acceptedChanges(f.repo)).toHaveLength(3);
    expect(readFileSync(join(f.repo, "first.txt"), "utf8")).toBe("first");
    expect(readFileSync(join(f.repo, "later.txt"), "utf8")).toBe("later");
  });
  it.each(["valid", "missing", "wrong revision"])("cannot dispatch from a %s old failure marker", async kind => {
    const f = await fixture();
    const file = join(f.root, "state/release-failures", createHash("sha256").update(f.release.version).digest("hex") + ".json");
    if (kind === "missing") rmSync(file);
    if (kind === "wrong revision") writeFileSync(file, JSON.stringify({version:f.release.version,revision:"f".repeat(40),observedAt:Date.now()}));
    if (kind === "malformed") writeFileSync(file, "not-json");
    const refs = f.g("show-ref"); await observeChangeDelivery(f.repo); await observeChangeDelivery(f.repo);
    expect(f.g("show-ref")).toBe(refs); expect(f.rollback).not.toHaveBeenCalled();
    const j = await updateShippingJournal(f.repo, j => j);
    expect(j).not.toHaveProperty("recoverySelections"); expect(j.delivery?.rollbacks).toEqual({});
  });
});
