import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IncomingMessage } from "node:http";
import { configureChangeDelivery, deliveryChallenge, laptopTransportIdentity, observeChangeDelivery, reportLaptopHealth, requestDeliveryRollback, shipmentCards, shipmentRepo } from "../changeDelivery";
import { acceptedChanges, followAcceptedRelease, prepareAcceptanceLocked, updateShippingJournal, type AcceptedChange } from "../changeShipping";
import { withRepoLock } from "../git";
import { registerFolder } from "../projectFolders";
import type { LaptopHealthReport } from "../../src/shippingProtocol";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vc-delivery-runtime-")); roots.push(root);
  const repo = join(root, "repo"), vault = join(root, "vault"), proof = join(root, "private-proof");
  for (const p of [repo, vault, proof, join(vault, "agent-projects", "app")]) mkdirSync(p, { recursive: true });
  const g = (...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@local", ...args], { cwd: repo, encoding: "utf8" }).trim();
  g("init", "-q", "-b", "main");
  writeFileSync(join(repo, "package.json"), '{"version":"1.0.0"}');
  writeFileSync(join(repo, "app.txt"), "before"); g("add", "."); g("commit", "-qm", "base");
  const base = g("rev-parse", "HEAD");
  writeFileSync(join(repo, "app.txt"), "after"); g("add", "."); g("commit", "-qm", "candidate");
  const head = g("rev-parse", "HEAD"), tree = g("rev-parse", "HEAD^{tree}");
  const now = Date.now();
  const release = { id: "published-release", version: "1.0.1", revision: head, tag: "v1.0.1", publishedAt: new Date(now - 1000).toISOString() };
  const c: AcceptedChange = { id: "actual-accepted", source: { base, head, tree, branch: "agent/change" }, review: { convId: "project-app", slug: "app", folder: repo, clone: "/not-exposed", base: "main", branch: "agent/change", sha: head, title: "Actual accepted change", at: new Date(now).toISOString() }, proofDir: proof, preparedAt: new Date(now).toISOString(), release, check: { assessment: "checked", evidence: ["app.txt"], surface: "phone", ui: { steps: [{ waitFor: "main" }] } } };
  await withRepoLock(repo, () => prepareAcceptanceLocked(repo, c)); await acceptedChanges(repo);
  expect(registerFolder(vault, "app", repo)).toEqual({ abs: repo });
  const rollback = vi.fn(async () => ({ status: "accepted" as const, jobId: "recovery-job" }));
  const box = { version: release.version, revision: release.revision, observedAt: now, ready: true };
  configureChangeDelivery({ boxHealth: async () => box, requestSourceRollback: rollback, vaults: () => [{ name: "school", path: vault }], stateDir: join(root, "state") });
  return { root, repo, vault, proof, c, release, rollback, box, g, now };
}
async function report(f: Awaited<ReturnType<typeof fixture>>, extra: Partial<LaptopHealthReport> = {}) {
  const c = await deliveryChallenge(f.repo, "paired-device", Date.now());
  expect(c).not.toBeNull();
  const b: LaptopHealthReport = { ...c!, tauri: true, frontendMounted: true, boxConnected: true, syncReady: true, updaterReady: true, ...extra };
  await reportLaptopHealth(f.repo, "paired-device", b, Date.now());
  return b;
}

describe("durable delivery observations, not synchronized card authority", () => {
  it("keeps an offline laptop pending across repeated cycles, without reverting or claiming Shipped", async () => {
    const f = await fixture(); await observeChangeDelivery(f.repo); await observeChangeDelivery(f.repo);
    const cards = await shipmentCards(f.vault, "school");
    expect(cards[0]).toMatchObject({ status: "health-pending", health: { laptop: "pending" } });
    expect(f.rollback).not.toHaveBeenCalled();
    expect(JSON.stringify(cards)).not.toContain(f.root);
  });
  it("binds one-use challenges to device, published version and source; persists across fresh reads", async () => {
    const f = await fixture(), now = Date.now();
    const challenge = await deliveryChallenge(f.repo, "paired-device", now);
    expect(await deliveryChallenge(f.repo, "paired-device", now + 1)).toEqual(challenge);
    const b = { ...challenge!, tauri: true, frontendMounted: true, boxConnected: true, syncReady: true, updaterReady: true };
    await expect(reportLaptopHealth(f.repo, "phone", b, now + 2)).rejects.toThrow("challenge");
    await expect(reportLaptopHealth(f.repo, "paired-device", { ...b, revision: "f".repeat(40) }, now + 2)).rejects.toThrow("challenge");
    await expect(reportLaptopHealth(f.repo, "paired-device", b, now + 600_000)).rejects.toThrow("challenge");
    await reportLaptopHealth(f.repo, "paired-device", b, now + 2);
    await expect(reportLaptopHealth(f.repo, "paired-device", b, now + 3)).rejects.toThrow("challenge");
  });
  it("emits Shipped only after both matching devices; stale/offline does not undo observed success", async () => {
    const f = await fixture(); await observeChangeDelivery(f.repo); await report(f); await observeChangeDelivery(f.repo);
    expect((await shipmentCards(f.vault, "school"))[0].status).toBe("shipped");
    const r = await updateShippingJournal(f.repo, j => j.delivery!.releases[f.release.id]);
    expect(r.result?.status).toBe("healthy");
    expect(f.rollback).not.toHaveBeenCalled();
  });
  it("retains a fresh negative and requests ONE source-specific recovery, even after later positive reports", async () => {
    const f = await fixture(); await observeChangeDelivery(f.repo); await report(f, { updaterReady: false });
    await observeChangeDelivery(f.repo); await report(f); await observeChangeDelivery(f.repo);
    expect(f.rollback).toHaveBeenCalledTimes(1);
    expect(f.rollback).toHaveBeenCalledWith(f.repo, f.c.id, expect.any(String));
    expect((await shipmentCards(f.vault, "school"))[0]).toMatchObject({ status: "rolling-back", health: { status: "failed" }, rollback: { status: "accepted" } });
  });
  it("a fresh native negative can fail the release before the offline box installs it", async () => {
    const f = await fixture(); f.box.version = "1.0.0"; f.box.revision = "f".repeat(40);
    await report(f, { updaterReady: false }); await observeChangeDelivery(f.repo);
    expect(f.rollback).toHaveBeenCalledTimes(1);
  });
  it("selects all accepted changes newest-first for one failed published release", async () => {
    const f = await fixture();
    writeFileSync(join(f.repo, "second.txt"), "second accepted change"); f.g("add", "."); f.g("commit", "-qm", "second candidate");
    const head = f.g("rev-parse", "HEAD"), tree = f.g("rev-parse", "HEAD^{tree}");
    const release = { ...f.release, revision: head };
    await updateShippingJournal(f.repo, j => { j.changes[0].release = release; });
    await withRepoLock(f.repo, () => prepareAcceptanceLocked(f.repo, { ...f.c, id: "second-accepted", source: { ...f.c.source, base: f.c.source.head, head, tree }, release }));
    // Match real acceptance: reconcile its prepared intent against actual main before delivery observes it.
    expect(await acceptedChanges(f.repo)).toHaveLength(2);
    f.release = release; f.box.revision = head;
    await observeChangeDelivery(f.repo); await report(f, { updaterReady: false }); await observeChangeDelivery(f.repo);
    expect(f.rollback).toHaveBeenCalledTimes(2);
    expect(f.rollback).toHaveBeenNthCalledWith(1, f.repo, "second-accepted", expect.any(String));
    expect(f.rollback).toHaveBeenNthCalledWith(2, f.repo, f.c.id, expect.any(String));
  });
  it("copies source-pinned proof media and a sanitized summary, never private receipt paths/request/environment", async () => {
    const f = await fixture(), artifact = join(f.proof, "recording.mp4"), bytes = Buffer.from("fixture-media-not-physical-proof");
    writeFileSync(artifact, bytes);
    writeFileSync(join(f.proof, "receipt.json"), JSON.stringify({ id: f.c.id, source: f.c.source, ask: { requestText: "PRIVATE_REQUEST" }, environment: "PRIVATE_ENVIRONMENT", baseline: [], candidate: [{ gate: "test:server", exitCode: 0, complete: true, tests: [{ status: "passed" }] }], ui: { artifact, artifactHash: createHash("sha256").update(bytes).digest("hex"), assertions: 2, frames: 30, sourceVerified: true } }));
    const [card] = await shipmentCards(f.vault, "school");
    expect(card.proof.mediaUrls).toHaveLength(1);
    const summaryPath = new URL(card.proof.summaryUrl, "http://fixture").searchParams.get("path")!;
    const summary = readFileSync(join(f.vault, summaryPath), "utf8");
    expect(summary).toContain("1 passed"); expect(summary).toContain("2 assertions");
    expect(summary).not.toContain(f.root); expect(summary).not.toContain("PRIVATE_");
    const target = join(f.vault, summaryPath), victim = join(f.root, "must-not-overwrite");
    writeFileSync(victim, "safe"); rmSync(target); symlinkSync(victim, target);
    await expect(shipmentCards(f.vault, "school")).rejects.toThrow("Unsafe");
    expect(readFileSync(victim, "utf8")).toBe("safe");
  });
  it.each(["receipt-id", "source-head", "source-tree", "artifact-root", "artifact-hash"])("keeps current receipt projection fail-closed: %s", async kind => {
    const f = await fixture(), artifact = join(f.proof, "recording.mp4"), bytes = Buffer.from("fixture-media-not-physical-proof");
    writeFileSync(artifact, bytes);
    const receipt = { id: f.c.id, source: { ...f.c.source }, baseline: [], candidate: [],
      ui: { artifact, artifactHash: createHash("sha256").update(bytes).digest("hex"), assertions: 2, frames: 30, sourceVerified: true } };
    if (kind === "receipt-id") receipt.id += "-other";
    if (kind === "source-head") receipt.source.head = "f".repeat(40);
    if (kind === "source-tree") receipt.source.tree = "f".repeat(40);
    if (kind === "artifact-root") { receipt.ui.artifact = join(f.root, "outside.mp4"); writeFileSync(receipt.ui.artifact, bytes); }
    if (kind === "artifact-hash") receipt.ui.artifactHash = "f".repeat(64);
    writeFileSync(join(f.proof, "receipt.json"), JSON.stringify(receipt));
    await expect(shipmentCards(f.vault, "school")).rejects.toThrow(kind === "artifact-root" ? "Invalid proof artifact" : kind === "artifact-hash" ? "Proof artifact changed" : "Proof source mismatch");
  });
  it("recovers a persisted requested rollback after a pre-dispatch crash, but never starts a second accepted recovery", async () => {
    const f = await fixture();
    await updateShippingJournal(f.repo, j => { j.delivery = { releases: {}, rollbacks: { [f.c.id]: { status: "requested" } } }; });
    await observeChangeDelivery(f.repo); await requestDeliveryRollback(f.repo, f.c.id, "duplicate click");
    expect(f.rollback).toHaveBeenCalledTimes(1);
  });
  it("shows failed source recovery, and a revert release failure cannot autorevert its revert", async () => {
    const f = await fixture();
    await updateShippingJournal(f.repo, j => { j.changes[0].rollbackOf = "original-change"; });
    await observeChangeDelivery(f.repo); await report(f, { updaterReady: false }); await observeChangeDelivery(f.repo);
    expect(f.rollback).not.toHaveBeenCalled();
    expect((await shipmentCards(f.vault, "school"))[0].status).toBe("needs-attention");
  });
  it("ignores forged synced Shipped and rollback cards; only private accepted identities resolve", async () => {
    const f = await fixture(); await observeChangeDelivery(f.repo);
    const file = join(f.vault, ".vault-chat", "shipments", "cards.jsonl");
    writeFileSync(file, JSON.stringify({ id: "forged", status: "shipped", rollback: { status: "accepted" } }) + "\n");
    const cards = await shipmentCards(f.vault, "school");
    expect(cards).toHaveLength(1); expect(cards[0].status).toBe("health-pending");
    expect(await shipmentRepo(f.vault, "forged")).toBeNull();
    await expect(requestDeliveryRollback(f.repo, "forged", "tampered client")).rejects.toThrow("not found");
    expect(readFileSync(file, "utf8")).toContain('"forged"'); // union log retains it, server never trusts it
  });
  it("consumes updater-private failed source pins even after binary restoration", async () => {
    const f = await fixture();
    f.box.version = "1.0.0"; f.box.revision = "a".repeat(40);
    const directory = join(f.root, "state", "release-failures"); mkdirSync(directory, { recursive: true });
    const marker = join(directory, createHash("sha256").update(f.release.version).digest("hex") + ".json");
    writeFileSync(marker, JSON.stringify({ version: f.release.version, revision: "f".repeat(40), observedAt: Date.now() }));
    await observeChangeDelivery(f.repo); expect(f.rollback).not.toHaveBeenCalled();
    writeFileSync(marker, JSON.stringify({ version: f.release.version, revision: f.release.revision, observedAt: Date.now() }));
    await observeChangeDelivery(f.repo); await observeChangeDelivery(f.repo); expect(f.rollback).toHaveBeenCalledTimes(1);
  });
});

describe("trusted device transport, not body platform attestation", () => {
  const request = (headers: Record<string, string>, address = "127.0.0.1") => ({ headers, socket: { remoteAddress: address } }) as IncomingMessage;
  it("rejects unauthenticated/token/loopback claims and binds existing Carl Serve authentication to the actual device source", () => {
    const headers = { "tailscale-user-login": "carwilson0929@gmail.com", "x-forwarded-for": "100.64.0.2" };
    expect(laptopTransportIdentity(request(headers))).toBe("tailscale:carwilson0929@gmail.com:100.64.0.2");
    expect(laptopTransportIdentity(request({ "x-vault-token": "not-a-real-credential", platform: "tauri" }))).toBeNull();
    expect(laptopTransportIdentity(request(headers, "100.64.0.2"))).toBeNull();
    expect(laptopTransportIdentity(request({ ...headers, "tailscale-user-login": "not-carl@example.com" }))).toBeNull();
    expect(laptopTransportIdentity(request({ ...headers, "x-forwarded-for": "100.64.0.2, 100.64.0.3" }))).toBeNull();
    expect(laptopTransportIdentity(request({ ...headers, "x-forwarded-for": "not-a-device" }))).toBeNull();
    expect(laptopTransportIdentity(request({ ...headers, "x-forwarded-for": "100.64.0.3" }))).not.toBe(laptopTransportIdentity(request(headers)));
  });
});

describe("published application release follows before acceptance-journal bootstrap", () => {
  it("fast-forwards the already-published version-only commit without inventing acceptance or pushing", async () => {
    const f = await fixture();
    rmSync(join(f.repo, ".git", "vault-chat-shipping"), { recursive: true });
    f.g("remote", "add", "origin", "https://github.com/carlwilsn/vault-chat.git");
    writeFileSync(join(f.repo, "package.json"), '{"version":"1.0.1"}'); f.g("add", "."); f.g("commit", "-qm", "v1.0.1 [skip ci]");
    const release = { ...f.release, revision: f.g("rev-parse", "HEAD") };
    f.g("reset", "--hard", f.c.source.head); // isolated fixture only, production follower NEVER resets
    await followAcceptedRelease(f.repo, { discover: async () => release, fetch: async () => {} });
    expect(f.g("rev-parse", "HEAD")).toBe(release.revision);
    expect(await acceptedChanges(f.repo)).toEqual([]);
  });
});
