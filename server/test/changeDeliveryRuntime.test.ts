import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IncomingMessage } from "node:http";
import { configureChangeDelivery, deliveryChallenge, laptopTransportIdentity, observeChangeDelivery, reportLaptopHealth } from "../changeDelivery";
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
  const c: AcceptedChange = { id: "actual-accepted", source: { base, head, tree, branch: "agent/change" }, review: { convId: "project-app", slug: "app", folder: repo, clone: "/not-exposed", base: "main", branch: "agent/change", sha: head, title: "Actual accepted change", at: new Date(now).toISOString() }, proofDir: proof, preparedAt: new Date(now).toISOString(), release };
  await withRepoLock(repo, () => prepareAcceptanceLocked(repo, c)); await acceptedChanges(repo);
  expect(registerFolder(vault, "app", repo)).toEqual({ abs: repo });
  const rollback = vi.fn(async () => ({ status: "accepted" as const, jobId: "recovery-job" }));
  const box = { version: release.version, revision: release.revision, observedAt: now, ready: true };
  configureChangeDelivery({ boxHealth: async () => box, vaults: () => [{ name: "school", path: vault }], stateDir: join(root, "state") });
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
    const health = await updateShippingJournal(f.repo, j => j.delivery!.releases[f.release.id].result);
    expect(health).toMatchObject({ status: "pending", laptop: "pending" });
    expect(f.rollback).not.toHaveBeenCalled();
    expect(existsSync(join(f.vault, ".vault-chat/shipments"))).toBe(false);
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
    expect(existsSync(join(f.vault, ".vault-chat/shipments"))).toBe(false);
    const r = await updateShippingJournal(f.repo, j => j.delivery!.releases[f.release.id]);
    expect(r.result?.status).toBe("healthy");
    expect(f.rollback).not.toHaveBeenCalled();
  });
  it("retains a fresh negative without source recovery, even after later positive reports", async () => {
    const f = await fixture(); await observeChangeDelivery(f.repo); await report(f, { updaterReady: false });
    await observeChangeDelivery(f.repo); await report(f); await observeChangeDelivery(f.repo);
    expect(f.rollback).not.toHaveBeenCalled();
    expect(await updateShippingJournal(f.repo, j => j.delivery!.releases[f.release.id].result?.status)).toBe("failed");
    expect(existsSync(join(f.vault, ".vault-chat/shipments"))).toBe(false);
  });
  it("a fresh native negative can fail the release before the offline box installs it", async () => {
    const f = await fixture(); f.box.version = "1.0.0"; f.box.revision = "f".repeat(40);
    await report(f, { updaterReady: false }); await observeChangeDelivery(f.repo);
    expect(f.rollback).not.toHaveBeenCalled();
  });
  it("does not select accepted ranges for a failed release", async () => {
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
    expect(f.rollback).not.toHaveBeenCalled();
    expect(await updateShippingJournal(f.repo, j => j)).not.toHaveProperty("recoverySelections");
  });
  // Retired copy/projection cases now prove that health cycles never touch historical public
  // files, private proof inputs or redirected destinations. No new receipt/summary is made.
  it("keeps malformed historical evidence readable without reviving receipt authority", async () => {
    const f = await fixture(), original = "INVALID obsolete receipt; not authority";
    writeFileSync(join(f.proof, "receipt.json"), original);
    await observeChangeDelivery(f.repo);
    expect(readFileSync(join(f.proof, "receipt.json"), "utf8")).toBe(original);
    expect(existsSync(join(f.vault, ".vault-chat/shipments"))).toBe(false);
  });
  it("keeps existing historical projected media and original evidence files readable without revalidation", async () => {
    const f = await fixture(), dest = join(f.vault, ".vault-chat/shipments/proof/old");
    mkdirSync(dest, { recursive: true }); writeFileSync(join(dest, "recording.mp4"), "retained projected fixture");
    writeFileSync(join(f.proof, "receipt.json"), "malformed historical receipt");
    await observeChangeDelivery(f.repo); await report(f); await observeChangeDelivery(f.repo);
    expect(readFileSync(join(dest, "recording.mp4"), "utf8")).toBe("retained projected fixture");
    expect(readFileSync(join(f.proof, "receipt.json"), "utf8")).toBe("malformed historical receipt");
    expect(existsSync(join(f.vault, ".vault-chat/shipments/cards.jsonl"))).toBe(false);
  });
  it("excludes private request, environment and log sentinels from the historical summary and media listing", async () => {
    const f = await fixture(), sentinel = "OFFLINE_FIXTURE_PRIVATE_SENTINEL";
    for (const name of ["receipt.json", "gate.log", "recording.mp4"]) writeFileSync(join(f.proof, name), sentinel);
    await observeChangeDelivery(f.repo);
    expect(existsSync(join(f.vault, ".vault-chat/shipments"))).toBe(false);
    for (const name of ["receipt.json", "gate.log", "recording.mp4"]) expect(readFileSync(join(f.proof, name), "utf8")).toBe(sentinel);
  });
  it("reads the original historical receipt schema into a public numeric summary and real image, not private metadata", async () => {
    const f = await fixture(), receipt = { id: f.c.id, source: f.c.source, baseline: [], candidate: [], ui: { artifact: join(f.proof, "recording.png"), assertions: 2 } };
    writeFileSync(join(f.proof, "receipt.json"), JSON.stringify(receipt));
    writeFileSync(join(f.proof, "recording.png"), "original image bytes");
    const refs = f.g("show-ref"); await observeChangeDelivery(f.repo);
    expect(f.g("show-ref")).toBe(refs);
    expect(JSON.parse(readFileSync(join(f.proof, "receipt.json"), "utf8"))).toEqual(receipt);
    expect(readFileSync(join(f.proof, "recording.png"), "utf8")).toBe("original image bytes");
    expect(existsSync(join(f.vault, ".vault-chat/shipments"))).toBe(false);
  });
  it("projects original legacy public-media metadata without reviving its deleted bootstrap importer", async () => {
    const f = await fixture();
    const metadata = { basis: "legacy-bootstrap", bootstrap: { proofId: "old-display-only", media: [{ name: "1-ui.jpg", hash: "old" }] } };
    await updateShippingJournal(f.repo, j => { Object.assign(j.changes[0], metadata); });
    const victim = join(f.root, "private.jpg"); writeFileSync(victim, "private bytes");
    symlinkSync(victim, join(f.proof, "1-ui.jpg")); await observeChangeDelivery(f.repo);
    expect(readFileSync(victim, "utf8")).toBe("private bytes");
    expect((await acceptedChanges(f.repo))[0]).toMatchObject(metadata);
    expect(existsSync(join(f.vault, ".vault-chat/shipments"))).toBe(false);
  });
  it.each(["summary.md", "recording.mp4", "recording.webm", "recording.png"])("refuses live and dangling historical projection links: %s", async name => {
    const f = await fixture(), victim = join(f.root, "private-victim"), dest = join(f.vault, ".vault-chat/shipments/proof/old");
    mkdirSync(dest, { recursive: true }); symlinkSync(victim, join(dest, name));
    for (const live of [true, false]) {
      if (live) writeFileSync(victim, "FIXTURE_PRIVATE_DO_NOT_COPY"); else rmSync(victim);
      await observeChangeDelivery(f.repo);
      if (live) expect(readFileSync(victim, "utf8")).toBe("FIXTURE_PRIVATE_DO_NOT_COPY");
      else expect(existsSync(victim)).toBe(false);
    }
  });
  it.each([".vault-chat/shipments", ".vault-chat/shipments/proof"])("refuses historical projection directory redirects: %s", async relative => {
    const f = await fixture(), outside = join(f.root, "outside"); mkdirSync(outside);
    const path = join(f.vault, relative); mkdirSync(join(path, ".."), { recursive: true }); symlinkSync(outside, path);
    writeFileSync(join(outside, "summary.md"), "original");
    await observeChangeDelivery(f.repo);
    expect(readFileSync(join(outside, "summary.md"), "utf8")).toBe("original");
    expect(existsSync(join(outside, "cards.jsonl"))).toBe(false);
  });
  it("refuses a dangling card-history append redirect without creating its outside target", async () => {
    const f = await fixture(), dest = join(f.vault, ".vault-chat/shipments"), victim = join(f.root, "absent-private-target");
    mkdirSync(dest, { recursive: true }); symlinkSync(victim, join(dest, "cards.jsonl"));
    await observeChangeDelivery(f.repo); expect(existsSync(victim)).toBe(false);
  });
  it("refuses history parent redirects even when no accepted project produces a proof projection", async () => {
    const f = await fixture(), outside = join(f.root, "outside"); mkdirSync(outside);
    writeFileSync(join(outside, "cards.jsonl"), "PRIVATE_EMPTY_PROJECT_SENTINEL");
    symlinkSync(outside, join(f.vault, ".vault-chat/shipments"));
    await observeChangeDelivery(f.repo);
    expect(readFileSync(join(outside, "cards.jsonl"), "utf8")).toBe("PRIVATE_EMPTY_PROJECT_SENTINEL");
  });
  it("leaves a historical requested rollback inert across repeated cycles", async () => {
    const f = await fixture();
    await updateShippingJournal(f.repo, j => { j.delivery = { releases: {}, rollbacks: { [f.c.id]: { status: "requested" } } }; });
    await observeChangeDelivery(f.repo); await observeChangeDelivery(f.repo);
    expect(await updateShippingJournal(f.repo, j => j.delivery!.rollbacks[f.c.id])).toEqual({ status: "requested" });
    expect(f.rollback).not.toHaveBeenCalled();
  });
  it("shows failed source recovery, and a revert release failure cannot autorevert its revert", async () => {
    const f = await fixture();
    await updateShippingJournal(f.repo, j => { j.changes[0].rollbackOf = "original-change"; });
    await observeChangeDelivery(f.repo); await report(f, { updaterReady: false }); await observeChangeDelivery(f.repo);
    expect(f.rollback).not.toHaveBeenCalled();
    expect(await updateShippingJournal(f.repo, j => j.delivery!.releases[f.release.id].result?.status)).toBe("failed");
  });
  it("ignores forged synced Shipped and rollback cards; only private accepted identities resolve", async () => {
    const f = await fixture(); await observeChangeDelivery(f.repo);
    const file = join(f.vault, ".vault-chat", "shipments", "cards.jsonl");
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify({ id: "forged", status: "shipped", rollback: { status: "accepted" } }) + "\n");
    await observeChangeDelivery(f.repo);
    expect(await updateShippingJournal(f.repo, j => j.delivery!.releases[f.release.id].result?.status)).toBe("pending");
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
    await observeChangeDelivery(f.repo); await observeChangeDelivery(f.repo); expect(f.rollback).not.toHaveBeenCalled();
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
  it("observes the already-published version-only tag without moving source main or inventing acceptance", async () => {
    const f = await fixture();
    rmSync(join(f.repo, ".git", "vault-chat-shipping"), { recursive: true });
    f.g("remote", "add", "origin", "https://github.com/carlwilsn/vault-chat.git");
    writeFileSync(join(f.repo, "package.json"), '{"version":"1.0.1"}'); f.g("add", "."); f.g("commit", "-qm", "v1.0.1 [skip ci]");
    const release = { ...f.release, revision: f.g("rev-parse", "HEAD") };
    f.g("reset", "--hard", f.c.source.head); // isolated fixture only, production follower NEVER resets
    await followAcceptedRelease(f.repo, { discover: async () => release, fetch: async () => {} });
    expect(f.g("rev-parse", "HEAD")).toBe(f.c.source.head);
    expect(await acceptedChanges(f.repo)).toEqual([]);
  });
});
