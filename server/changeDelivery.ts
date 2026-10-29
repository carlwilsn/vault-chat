/** Delivery observations, driven by the existing project sync cycle. The private git journal is authority;
 * per-vault JSONL is only a union-mergeable display projection and is never read back for decisions. */
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, extname, join, resolve, sep } from "node:path";
import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import { isLoopbackAddr, tailnetLoginOk } from "./auth";
import { acceptedChanges, updateShippingJournal, type AcceptedChange, type ShippingJournal } from "./changeShipping";
import { evaluateReleaseHealth, type BoxReleaseHealth, type LaptopReleaseHealth, type ReleaseHealthResult, type ReleaseTarget } from "./releaseHealth";
import type { LaptopHealthReport, ReleaseHealthChallenge, ShipmentCard, ShipmentRollback } from "../src/shippingProtocol";
import { activeFolders } from "./projectFolders";

export type DeliveryRelease = {
  target: ReleaseTarget; box?: BoxReleaseHealth; result?: ReleaseHealthResult;
  devices: Record<string, { challenge: ReleaseHealthChallenge; used?: boolean; report?: LaptopReleaseHealth }>;
};
export type DeliveryState = { releases: Record<string, DeliveryRelease>; rollbacks: Record<string, ShipmentRollback> };
export type DeliveryAdapters = {
  boxHealth: () => Promise<BoxReleaseHealth>;
  requestSourceRollback: (repo: string, changeId: string, reason: string) => Promise<ShipmentRollback>;
  vaults: () => { name: string; path: string }[];
  stateDir: string;
};
let adapters: DeliveryAdapters | undefined;
let rollbackHandler: DeliveryAdapters["requestSourceRollback"] | undefined;
/** Native core host configuration registers its existing job/proof route, never a client hook. */
export function setDeliveryRollbackHandler(handler: DeliveryAdapters["requestSourceRollback"]): void { rollbackHandler = handler; }
export async function dispatchSourceRollback(repo: string, id: string, reason: string): Promise<ShipmentRollback> {
  if (!rollbackHandler) return { status: "requested", error: "Source recovery host is not configured; needs attention" };
  return rollbackHandler(repo, id, reason);
}
export function configureChangeDelivery(a: DeliveryAdapters): void { adapters = a; }
const MAX_AGE = 5 * 60_000;
const state = (j: ShippingJournal): DeliveryState => j.delivery ??= { releases: {}, rollbacks: {} };
const safeId = (s: string) => createHash("sha256").update(s).digest("hex");
function publicError(error: unknown): string {
  // Never send raw git/runner errors (which may include host paths) through a card.
  return error instanceof Error ? "Source recovery failed; check the server delivery logs" : "Source recovery failed";
}
/** Normal app reports use Carl's existing authenticated Tailscale transport. Serve strips caller
 * identity headers; the local proxy's exact device source binds the challenge/report, not a body label.
 * This is trusted application telemetry, not cryptographic binary attestation (an IP pin would not be
 * binary attestation either). No new pairing registry/operator knob is needed. Plain loopback, shared
 * phone-token-only requests and browser previews cannot establish a native release report transport. */
export function laptopTransportIdentity(req: IncomingMessage): string | null {
  if (!isLoopbackAddr(req.socket.remoteAddress) || !tailnetLoginOk(req)) return null;
  const forwarded = req.headers["x-forwarded-for"], login = req.headers["tailscale-user-login"];
  if (typeof forwarded !== "string" || !isIP(forwarded.trim()) || typeof login !== "string") return null;
  return `tailscale:${login.trim().toLowerCase()}:${forwarded.trim()}`;
}

function releaseState(j: ShippingJournal, c: AcceptedChange): DeliveryRelease | undefined {
  return c.release ? state(j).releases[c.release.id] : undefined;
}
function ensureRelease(j: ShippingJournal, c: AcceptedChange): DeliveryRelease {
  if (!c.release) throw new Error("Release not published");
  const r = state(j).releases[c.release.id] ??= {
    target: { id: c.release.id, version: c.release.version, revision: c.release.revision, installedAt: 0, previousVersion: "unknown", ...(c.rollbackOf ? { rollbackOf: c.rollbackOf } : {}) }, devices: {},
    result: { status: "pending", action: "wait", reason: "Published; waiting for matching box and actual paired laptop readiness (offline stays pending)", box: "pending", laptop: "pending", binaryFallback: false },
  };
  if (c.rollbackOf) r.target.rollbackOf = c.rollbackOf;
  return r;
}
function evaluate(r: DeliveryRelease, now: number): void {
  // Publication isn't installation. An offline/different box must not generate a synthetic failed install.
  if (r.result?.status === "failed") return;
  const device = Object.entries(r.devices).find(([, d]) => !!d.report);
  const l = device?.[1].report;
  const negative = l && (l.error || !l.frontendMounted || !l.boxConnected || !l.syncReady || !l.updaterReady);
  if (!r.target.installedAt && !negative) return;
  const installedAt = Math.min(r.target.installedAt || now, l?.observedAt ?? now);
  const next = evaluateReleaseHealth({ target: { ...r.target, installedAt }, now, boxDeadline: (r.target.installedAt || now) + 10 * 60_000,
    maxReportAgeMs: MAX_AGE, laptopClientId: device?.[0] ?? "unpaired-laptop", challenge: device?.[1].challenge.challenge ?? "awaiting-challenge",
    box: r.box, laptop: device?.[1].report });
  // Once verified, stale/offline heartbeats cannot erase successful delivery; a fresh actual negative can.
  if (r.result?.status !== "healthy" || next.status === "failed") r.result = next;
}
export async function deliveryChallenge(repo: string, clientId: string, now = Date.now()): Promise<ReleaseHealthChallenge | null> {
  return updateShippingJournal(repo, j => {
    const c = j.changes.filter(c => c.acceptedAt && c.release).at(-1);
    if (!c?.release) return null;
    const r = ensureRelease(j, c);
    const previous = r.devices[clientId];
    if (previous && !previous.used && previous.challenge.expiresAt > now) return structuredClone(previous.challenge);
    const challenge: ReleaseHealthChallenge = { releaseId: c.release.id, version: c.release.version, revision: c.release.revision, challenge: randomUUID(), issuedAt: now, expiresAt: now + MAX_AGE };
    r.devices[clientId] = { challenge, report: previous?.report };
    return challenge;
  });
}
export async function reportLaptopHealth(repo: string, clientId: string, b: LaptopHealthReport, now = Date.now()): Promise<void> {
  await updateShippingJournal(repo, j => {
    const r = state(j).releases[b.releaseId], d = r?.devices[clientId];
    if (!r || !d || d.used || d.challenge.challenge !== b.challenge || d.challenge.expiresAt <= now || d.challenge.issuedAt > now || r.target.version !== b.version || r.target.revision !== b.revision) throw new Error("Expired, consumed or mismatched release challenge");
    for (const k of ["tauri", "frontendMounted", "boxConnected", "syncReady", "updaterReady"] as const) if (typeof b[k] !== "boolean") throw new Error("Missing actual native readiness check");
    if (!b.tauri) throw new Error("Native laptop report required");
    d.used = true;
    // Server time/identity only, not client-supplied observedAt/platform/clientId.
    d.report = { clientId, version: b.version, revision: b.revision, observedAt: now, challenge: b.challenge,
      tauri: b.tauri, frontendMounted: b.frontendMounted, boxConnected: b.boxConnected, syncReady: b.syncReady, updaterReady: b.updaterReady,
      ...(b.error ? { error: "Actual laptop release readiness check failed" } : {}) };
    evaluate(r, now);
  });
}
/** Persist before calling the core's idempotent, change-specific source revert. Crash recovery reuses the
 * same accepted identity; the core owns proof/acceptance/jobs, not this display/delivery adapter. */
export async function requestDeliveryRollback(repo: string, id: string, reason: string, automatic = false): Promise<ShipmentRollback> {
  const old = await updateShippingJournal(repo, j => {
    const c = j.changes.find(c => c.id === id && c.acceptedAt);
    if (!c) throw new Error("Accepted change not found");
    if (c.rollbackOf && automatic) {
      return state(j).rollbacks[id] ??= { status: "failed", error: "A recovery release failed; needs attention, no automatic revert of a revert" };
    }
    return state(j).rollbacks[id] ??= { status: "requested" };
  });
  if (old.status === "accepted" || old.status === "failed") return old;
  if (!adapters) return old;
  let outcome: ShipmentRollback;
  try { outcome = await adapters.requestSourceRollback(repo, id, reason); }
  catch (e) { console.error("[delivery] source recovery failed", e); outcome = { status: "failed", error: publicError(e) }; }
  if (outcome.error) outcome.error = outcome.status === "requested" ? "Source recovery host is unavailable; needs attention" : "Source recovery failed; needs attention";
  return updateShippingJournal(repo, j => {
    const current = state(j).rollbacks[id];
    if (current?.status === "accepted" || current?.status === "failed") return current;
    state(j).rollbacks[id] = outcome;
    return outcome;
  });
}

/** Called by master.ts inside BoxSync's existing cycle, no new scheduling loop. */
export async function observeChangeDelivery(repo: string): Promise<void> {
  if (!adapters) return;
  const box = await adapters.boxHealth(), now = Date.now();
  const requests = await updateShippingJournal(repo, j => {
    const requests: { id: string; reason: string; automatic: boolean }[] = [];
    for (const c of j.changes.filter(c => c.acceptedAt)) {
      if (c.release) {
        const r = ensureRelease(j, c);
        if (box.version === r.target.version && box.revision === r.target.revision) {
          if (!r.target.installedAt) r.target.installedAt = box.observedAt;
          r.box = box;
        }
        // Updater writes this in host-private state BEFORE binary fallback, never a client API.
        const marker = join(adapters!.stateDir, "release-failures", `${safeId(c.release.version)}.json`);
        if (existsSync(marker)) {
          const f = JSON.parse(readFileSync(marker, "utf8"));
          if (f.version === c.release.version && f.revision === c.release.revision && Number.isFinite(f.observedAt) && f.observedAt >= Date.parse(c.release.publishedAt) && f.observedAt <= now) {
            r.result = { status: "failed", action: c.rollbackOf ? "needs-attention" : "revert-and-ship", reason: "Box updater recorded failed matching release readiness; retained binary recovery is not source rollback", box: "failed", laptop: "pending", binaryFallback: !c.rollbackOf };
          }
        }
        evaluate(r, now);
        const releaseOwner = j.changes.filter(other => other.acceptedAt && other.release?.id === c.release!.id).at(-1);
        if (r.result?.status === "failed" && releaseOwner?.id === c.id && !state(j).rollbacks[c.id]) requests.push({ id: c.id, reason: r.result.reason, automatic: true });
      }
      const rb = state(j).rollbacks[c.id];
      if (rb?.status === "requested" || rb?.status === "running") requests.push({ id: c.id, reason: "Resume durable source recovery request", automatic: false });
    }
    return requests;
  });
  for (const request of requests) await requestDeliveryRollback(repo, request.id, request.reason, request.automatic);
  // Project may be associated with more than one vault. Publish only into its registered vault contexts.
  for (const v of adapters.vaults()) if (activeFolders(v.path).some(f => resolve(f.abs) === resolve(repo))) await shipmentCards(v.path, v.name);
}

function fileUrl(vault: string, path: string): string { return `/file?vault=${encodeURIComponent(vault)}&path=${encodeURIComponent(path)}`; }
function proofProjection(vaultPath: string, vaultName: string, c: AcceptedChange): ShipmentCard["proof"] {
  const rel = `.vault-chat/shipments/proof/${safeId(c.id)}`, dest = join(vaultPath, rel);
  // Refuse symlinks in projection destinations: a synced/client-written path must never redirect a host write.
  let directory = vaultPath;
  for (const component of rel.split("/")) {
    directory = join(directory, component);
    if (existsSync(directory) && (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory())) throw new Error("Unsafe proof projection directory");
    mkdirSync(directory, { recursive: true });
  }
  for (const name of ["summary.md", "recording.mp4", "recording.webm", "recording.png"]) if (existsSync(join(dest, name)) && (lstatSync(join(dest, name)).isSymbolicLink() || !lstatSync(join(dest, name)).isFile())) throw new Error("Unsafe proof projection file");
  // Public summary intentionally excludes receipt request text, raw logs, private host paths/environment.
  let summary = `# ${c.review.title.replace(/[\r\n]/g, " ")}\n\nAccepted source: ${c.source.head}\n\nRelease and actual device health are tracked separately.\n`;
  const mediaUrls: string[] = [];
  const receiptFile = join(c.proofDir, "receipt.json");
  if (existsSync(receiptFile)) {
    const receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
    if (receipt.id !== c.id || receipt.source?.head !== c.source.head || receipt.source?.tree !== c.source.tree) throw new Error("Proof source mismatch");
    for (const side of ["baseline", "candidate"] as const) {
      summary += `\n## ${side === "baseline" ? "Baseline" : "Candidate"} gates\n`;
      for (const gate of receipt[side] ?? []) {
        const tests = Array.isArray(gate.tests) ? gate.tests : [];
        const passed = tests.filter((t: { status: string }) => t.status === "passed").length;
        const failed = tests.filter((t: { status: string }) => t.status === "failed").length;
        const label = String(gate.gate).replace(/[^a-zA-Z0-9:._-]/g, "").slice(0, 80);
        summary += `- ${label}: exit ${Number(gate.exitCode)}; ${gate.complete ? "complete" : "incomplete"}${tests.length ? `; ${passed} passed, ${failed} named failures` : ""}.\n`;
      }
    }
    summary += `\n## Actual recorded UI\n${Number(receipt.ui.assertions)} assertions; ${Number(receipt.ui.frames)} decoded frames. Candidate source verified: ${receipt.ui.sourceVerified === true ? "yes" : "no"}.\n`;
    const artifact = realpathSync(receipt.ui.artifact), root = realpathSync(c.proofDir);
    if (!artifact.startsWith(root + sep) || ![".webm", ".mp4", ".png"].includes(extname(artifact))) throw new Error("Invalid proof artifact");
    const bytes = readFileSync(artifact);
    if (createHash("sha256").update(bytes).digest("hex") !== receipt.ui.artifactHash) throw new Error("Proof artifact changed");
    const name = `recording${extname(artifact)}`;
    const target = join(dest, name);
    if (!existsSync(target) || createHash("sha256").update(readFileSync(target)).digest("hex") !== receipt.ui.artifactHash) writeFileSync(target, bytes);
    mediaUrls.push(fileUrl(vaultName, `${rel}/${name}`));
  }
  if (!existsSync(receiptFile)) summary += "\nRetained detailed proof is unavailable; acceptance is recorded in the service journal.\n";
  writeFileSync(join(dest, "summary.md"), summary);
  return { summaryUrl: fileUrl(vaultName, `${rel}/summary.md`), mediaUrls };
}
export async function shipmentCards(vaultPath: string, vaultName: string, project?: string): Promise<ShipmentCard[]> {
  const out: ShipmentCard[] = [];
  for (const f of activeFolders(vaultPath).filter(f => existsSync(join(f.abs, ".git")) && (!project || f.slug === project))) {
    const cards = await updateShippingJournal(f.abs, j => j.changes.filter(c => c.acceptedAt && c.review.slug === f.slug).map(c => {
      const r = releaseState(j, c), rollback = state(j).rollbacks[c.id];
      const reverted = j.changes.some(other => other.acceptedAt && other.rollbackOf === c.id && releaseState(j, other)?.result?.status === "healthy");
      const card: ShipmentCard = { id: c.id, project: c.review.slug, convId: c.review.convId, title: c.review.title, acceptedAt: c.acceptedAt!, sourceRevision: c.source.head,
        status: reverted ? "rolled-back" : rollback?.error || rollback?.status === "failed" ? "needs-attention" : rollback ? "rolling-back" : r?.result?.status === "failed" ? "needs-attention" : r?.result?.status === "healthy" ? "shipped" : c.release ? "health-pending" : "accepted",
        ...(c.release ? { release: c.release } : {}), ...(r?.result ? { health: { status: r.result.status, reason: r.result.reason, box: r.result.box, laptop: r.result.laptop } } : {}),
        ...(rollback ? { rollback } : {}), proof: proofProjection(vaultPath, vaultName, c) };
      return card;
    }));
    out.push(...cards);
  }
  // One append-only projection log, compatible with existing *.jsonl union merge. Tampering can change
  // offline display only: backend NEVER reads this file or accepts it as rollback/health/acceptance input.
  const path = join(vaultPath, ".vault-chat", "shipments", "cards.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile())) throw new Error("Unsafe shipment projection file");
  const previous = existsSync(path) ? readFileSync(path, "utf8") : "";
  for (const card of out) { const line = JSON.stringify(card); if (!previous.split("\n").includes(line)) appendFileSync(path, `${line}\n`); }
  return out.sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt));
}
/** Resolve only an already registered project in the authenticated vault; never an arbitrary repo path. */
export async function shipmentRepo(vaultPath: string, id: string): Promise<string | null> {
  for (const f of activeFolders(vaultPath).filter(f => existsSync(join(f.abs, ".git")))) if ((await acceptedChanges(f.abs)).some(c => c.id === id && c.acceptedAt && c.review.slug === f.slug)) return f.abs;
  return null;
}
export function deliveryRepos(vaultPath: string): string[] { return activeFolders(vaultPath).filter(f => existsSync(join(f.abs, ".git"))).map(f => f.abs); }

/** Read-only health detail for the updater. Offline laptop pending never turns box readiness into failure. */
export async function currentDeliveryRecovery(version: string, revision: string): Promise<{ failed: boolean; binaryFallback: boolean }> {
  if (!adapters) return { failed: false, binaryFallback: true };
  let failed = false, binaryFallback = true;
  for (const v of adapters.vaults()) for (const repo of deliveryRepos(v.path)) {
    const matching = await updateShippingJournal(repo, j => Object.values(state(j).releases).filter(r => r.target.version === version && r.target.revision === revision));
    for (const r of matching) {
      if (r.result?.status === "failed") failed = true;
      if (r.target.rollbackOf) binaryFallback = false;
    }
  }
  return { failed, binaryFallback };
}
