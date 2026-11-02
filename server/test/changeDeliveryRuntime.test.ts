import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IncomingMessage } from "node:http";
import { configureChangeDelivery, deliveryChallenge, laptopTransportIdentity, observeChangeDelivery, reportLaptopHealth, shipmentCards, shipmentRepo } from "../changeDelivery";
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
  it("retains a fresh negative without source recovery, even after later positive reports", async () => {
    const f = await fixture(); await observeChangeDelivery(f.repo); await report(f, { updaterReady: false });
    await observeChangeDelivery(f.repo); await report(f); await observeChangeDelivery(f.repo);
    expect(f.rollback).not.toHaveBeenCalled();
    expect((await shipmentCards(f.vault, "school"))[0]).toMatchObject({ status: "needs-attention", health: { status: "failed" } });
    expect(readFileSync(join(f.vault, ".vault-chat/shipments/cards.jsonl"), "utf8")).not.toContain('"status":"needs-attention"');
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
  it("keeps malformed historical evidence readable without reviving receipt authority", async () => {
    const f = await fixture();
    writeFileSync(join(f.proof, "receipt.json"), "INVALID obsolete receipt; not authority");
    await observeChangeDelivery(f.repo); await observeChangeDelivery(f.repo);
    const [card] = await shipmentCards(f.vault, "school");
    expect(card.proof.mediaUrls).toHaveLength(0);
    const summaryPath = new URL(card.proof.summaryUrl, "http://fixture").searchParams.get("path")!;
    const summary = readFileSync(join(f.vault, summaryPath), "utf8");
    expect(summary).toContain(f.c.source.head); expect(summary).toContain("original conversation card");
    expect(summary).not.toContain(f.root); expect(summary).not.toContain("INVALID");
    const target = join(f.vault, summaryPath), victim = join(f.root, "must-not-overwrite");
    writeFileSync(victim, "safe"); rmSync(target); symlinkSync(victim, target);
    await expect(shipmentCards(f.vault, "school")).rejects.toThrow("Unsafe");
    expect(readFileSync(victim, "utf8")).toBe("safe");
  });
  it("keeps existing historical projected media and original evidence files readable without revalidation", async () => {
    const f = await fixture(); const dest = join(f.vault, ".vault-chat/shipments/proof", createHash("sha256").update(f.c.id).digest("hex"));
    mkdirSync(dest, { recursive: true }); writeFileSync(join(dest, "recording.mp4"), "retained projected fixture");
    writeFileSync(join(f.proof, "receipt.json"), "malformed historical receipt");
    const [card] = await shipmentCards(f.vault, "school");
    expect(card.proof.mediaUrls).toHaveLength(1);
    expect(readFileSync(join(dest, "recording.mp4"), "utf8")).toBe("retained projected fixture");
    expect(readFileSync(join(f.proof, "receipt.json"), "utf8")).toBe("malformed historical receipt");
  });
  it("excludes private request, environment and log sentinels from the historical summary and media listing", async () => {
    const f = await fixture();
    const sentinel = "OFFLINE_FIXTURE_PRIVATE_SENTINEL";
    writeFileSync(join(f.proof, "receipt.json"), JSON.stringify({ request: sentinel, environment: { FIXTURE_SECRET: sentinel }, path: f.root }));
    writeFileSync(join(f.proof, "gate.log"), sentinel);
    writeFileSync(join(f.proof, "recording.mp4"), sentinel);
    const [card] = await shipmentCards(f.vault, "school");
    const path = new URL(card.proof.summaryUrl, "http://fixture").searchParams.get("path")!;
    const projection = JSON.stringify(card) + readFileSync(join(f.vault, path), "utf8");
    expect(projection).not.toContain(sentinel); expect(projection).not.toContain(f.root);
    expect(card.proof.mediaUrls).toEqual([]); // Private/unprojected files are NOT silently made public.
    expect(readFileSync(join(f.proof, "recording.mp4"), "utf8")).toBe(sentinel);
  });
  it("reads the original historical receipt schema into a public numeric summary and real image, not private metadata", async () => {
    const f = await fixture(), sentinel = "SYNTHETIC_PRIVATE_TOKEN_ENV_COMMAND_PATH";
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
    const artifact = join(f.proof, "recording.png"); writeFileSync(artifact, bytes);
    const receipt = { id: f.c.id, source: f.c.source, ask: { requestText: sentinel }, environment: sentinel,
      baseline: [], candidate: [{ gate: "test:server", command: [sentinel], logArtifact: sentinel, stdout: sentinel,
        exitCode: 0, complete: true, tests: [{ file: sentinel, name: sentinel, status: "passed" }] }],
      ui: { artifact, artifactHash: createHash("sha256").update(bytes).digest("hex"), assertions: 2, frames: 30, sourceVerified: true, command: sentinel }, privatePath: f.root };
    writeFileSync(join(f.proof, "receipt.json"), JSON.stringify(receipt));
    const refs = f.g("show-ref"); const before = await acceptedChanges(f.repo);
    const [card] = await shipmentCards(f.vault, "school");
    const publicPath = (url: string) => join(f.vault, new URL(url, "http://fixture").searchParams.get("path")!);
    const summary = readFileSync(publicPath(card.proof.summaryUrl), "utf8");
    expect(summary).toContain("1 passed"); expect(summary).toContain("2 assertions");
    expect(card.proof.mediaUrls).toHaveLength(1); expect(readFileSync(publicPath(card.proof.mediaUrls[0]))).toEqual(bytes);
    expect(summary + JSON.stringify(card)).not.toContain(sentinel); expect(summary + JSON.stringify(card)).not.toContain(f.root);
    expect(f.g("show-ref")).toBe(refs); expect(await acceptedChanges(f.repo)).toEqual(before);
    expect(JSON.parse(readFileSync(join(f.proof, "receipt.json"), "utf8"))).toEqual(receipt);
    // Actual old reader path: valid hash does not turn a link to private data into public media.
    rmSync(artifact); const victim = join(f.root, "private.png"); writeFileSync(victim, bytes); symlinkSync(victim, artifact);
    rmSync(publicPath(card.proof.mediaUrls[0]));
    const [unsafe] = await shipmentCards(f.vault, "school"); expect(unsafe.proof.mediaUrls).toEqual([]);
    expect(readFileSync(victim)).toEqual(bytes);
    rmSync(victim); const [dangling] = await shipmentCards(f.vault, "school"); expect(dangling.proof.mediaUrls).toEqual([]);
  });
  it("projects original legacy public-media metadata without reviving its deleted bootstrap importer", async () => {
    const f = await fixture(), bytes = Buffer.from("historical JPEG fixture bytes"), name = "1-actual-ui.jpg";
    writeFileSync(join(f.proof,name),bytes);
    await updateShippingJournal(f.repo,j => { Object.assign(j.changes[0], {basis:"legacy-bootstrap",bootstrap:{proofId:"old-display-only",toolCallId:"PRIVATE_TOKEN_COMMAND",media:[{name,hash:createHash("sha256").update(bytes).digest("hex"),environment:"PRIVATE_TOKEN_COMMAND"}]}}); });
    const [card] = await shipmentCards(f.vault,"school"); expect(card.proof.mediaUrls).toHaveLength(1);
    const path = new URL(card.proof.mediaUrls[0],"http://fixture").searchParams.get("path")!;
    expect(readFileSync(join(f.vault,path))).toEqual(bytes); expect(JSON.stringify(card)).not.toContain("PRIVATE_TOKEN_COMMAND");
    rmSync(join(f.vault,path)); rmSync(join(f.proof,name)); symlinkSync(join(f.root,"absent-private.jpg"),join(f.proof,name));
    expect((await shipmentCards(f.vault,"school"))[0].proof.mediaUrls).toEqual([]);
  });
  it.each(["summary.md", "recording.mp4", "recording.webm", "recording.png"])("refuses live and dangling historical projection links: %s", async name => {
    const f = await fixture(), victim = join(f.root, "private-victim");
    await shipmentCards(f.vault, "school");
    const dest = join(f.vault, ".vault-chat/shipments/proof", createHash("sha256").update(f.c.id).digest("hex"));
    for (const live of [true, false]) {
      if (live) writeFileSync(victim, "FIXTURE_PRIVATE_DO_NOT_COPY"); else rmSync(victim);
      rmSync(join(dest, name), { force: true }); symlinkSync(victim, join(dest, name));
      await expect(shipmentCards(f.vault, "school")).rejects.toThrow("Unsafe");
      if (live) expect(readFileSync(victim, "utf8")).toBe("FIXTURE_PRIVATE_DO_NOT_COPY");
    }
  });
  it.each([".vault-chat/shipments", ".vault-chat/shipments/proof"])("refuses historical projection directory redirects: %s", async relative => {
    const f = await fixture(), outside = join(f.root, "outside"); mkdirSync(outside);
    const path = join(f.vault, relative); mkdirSync(join(path, ".."), { recursive: true }); symlinkSync(outside, path);
    await expect(shipmentCards(f.vault, "school")).rejects.toThrow("Unsafe");
    expect(readFileSync(join(f.proof, "../repo/app.txt"), "utf8")).toBe("after");
  });
  it("refuses a dangling card-history append redirect without creating its outside target", async () => {
    const f=await fixture();await shipmentCards(f.vault,"school");
    const path=join(f.vault,".vault-chat/shipments/cards.jsonl"), victim=join(f.root,"absent-private-target");
    rmSync(path);symlinkSync(victim,path);
    await expect(shipmentCards(f.vault,"school")).rejects.toThrow("Unsafe");
    expect(() => readFileSync(victim,"utf8")).toThrow();
  });
  it("refuses history parent redirects even when no accepted project produces a proof projection", async () => {
    const root=mkdtempSync(join(tmpdir(),"vc-empty-history-"));roots.push(root);
    const vault=join(root,"vault"), outside=join(root,"outside");mkdirSync(join(vault,".vault-chat"),{recursive:true});mkdirSync(outside);
    writeFileSync(join(outside,"cards.jsonl"),"PRIVATE_EMPTY_PROJECT_SENTINEL");symlinkSync(outside,join(vault,".vault-chat/shipments"));
    await expect(shipmentCards(vault,"school")).rejects.toThrow("Unsafe");
    expect(readFileSync(join(outside,"cards.jsonl"),"utf8")).toBe("PRIVATE_EMPTY_PROJECT_SENTINEL");
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
    expect((await shipmentCards(f.vault, "school"))[0].status).toBe("needs-attention");
  });
  it("ignores forged synced Shipped and rollback cards; only private accepted identities resolve", async () => {
    const f = await fixture(); await observeChangeDelivery(f.repo);
    const file = join(f.vault, ".vault-chat", "shipments", "cards.jsonl");
    writeFileSync(file, JSON.stringify({ id: "forged", status: "shipped", rollback: { status: "accepted" } }) + "\n");
    const cards = await shipmentCards(f.vault, "school");
    expect(cards).toHaveLength(1); expect(cards[0].status).toBe("health-pending");
    expect(await shipmentRepo(f.vault, "forged")).toBeNull();
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
