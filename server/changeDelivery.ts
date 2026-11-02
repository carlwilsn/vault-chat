/** Delivery observations, driven by the existing project sync cycle. The private git journal is authority;
 * per-vault JSONL is only a union-mergeable display projection and is never read back for decisions. */
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import { isLoopbackAddr, tailnetLoginOk } from "./auth";
import { acceptedChanges, updateShippingJournal, type AcceptedChange, type ShippingJournal } from "./changeShipping";
import { evaluateReleaseHealth, type BoxReleaseHealth, type LaptopReleaseHealth, type ReleaseHealthResult, type ReleaseTarget } from "./releaseHealth";
import type { LaptopHealthReport, ReleaseHealthChallenge, ShipmentCard, ShipmentRollback } from "../src/shippingProtocol";
import { readHistoricalProof } from "./historicalProof";
import { activeFolders } from "./projectFolders";

export type DeliveryRelease = {
  target: ReleaseTarget; box?: BoxReleaseHealth; result?: ReleaseHealthResult;
  devices: Record<string, { challenge: ReleaseHealthChallenge; used?: boolean; report?: LaptopReleaseHealth }>;
};
export type DeliveryState = { releases: Record<string, DeliveryRelease>; rollbacks: Record<string, ShipmentRollback> };
export type DeliveryAdapters = {
  boxHealth: () => Promise<BoxReleaseHealth>;
  vaults: () => { name: string; path: string }[];
  stateDir: string;
};
let adapters: DeliveryAdapters | undefined;
export function configureChangeDelivery(a: DeliveryAdapters): void { adapters = a; }
const MAX_AGE = 5 * 60_000;
const state = (j: ShippingJournal): DeliveryState => j.delivery ??= { releases: {}, rollbacks: {} };
const safeId = (s: string) => createHash("sha256").update(s).digest("hex");
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
    target: { id: c.release.id, version: c.release.version, revision: c.release.revision, installedAt: 0, previousVersion: "unknown" }, devices: {},
    result: { status: "pending", action: "wait", reason: "Published; waiting for matching box and actual paired laptop readiness (offline stays pending)", box: "pending", laptop: "pending" },
  };
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
/** Called by master.ts inside BoxSync's existing cycle, no new scheduling loop. */
export async function observeChangeDelivery(repo: string): Promise<void> {
  if (!adapters) return;
  const box = await adapters.boxHealth(), now = Date.now();
  await updateShippingJournal(repo, j => {
    for (const c of j.changes.filter(c => c.acceptedAt && c.release)) {
      const r = ensureRelease(j, c);
      if (box.version === r.target.version && box.revision === r.target.revision) {
        if (!r.target.installedAt) r.target.installedAt = box.observedAt;
        r.box = box;
      }
      // Private updater failure observations remain telemetry, never source-mutation requests.
      const marker = join(adapters!.stateDir, "release-failures", `${safeId(c.release!.version)}.json`);
      if (existsSync(marker)) {
        const f = JSON.parse(readFileSync(marker, "utf8"));
        if (f.version === c.release!.version && f.revision === c.release!.revision && Number.isFinite(f.observedAt) && f.observedAt >= Date.parse(c.release!.publishedAt) && f.observedAt <= now) {
          r.result = { status: "failed", action: "needs-attention", reason: "Box updater recorded failed matching release readiness", box: "failed", laptop: "pending" };
        }
      }
      evaluate(r, now);
    }
  });
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
    const stat = lstatSync(directory, { throwIfNoEntry: false });
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw new Error("Unsafe proof projection directory");
    mkdirSync(directory, { recursive: true });
  }
  for (const name of ["summary.md", "recording.mp4", "recording.webm", "recording.png"]) {
    // existsSync follows links and misses a dangling redirect before writeFileSync follows it.
    const stat = lstatSync(join(dest, name), { throwIfNoEntry: false });
    if (stat && (stat.isSymbolicLink() || !stat.isFile())) throw new Error("Unsafe proof projection file");
  }
  // Public summary intentionally excludes receipt request text, raw logs, private host paths/environment.
  let summary = `# ${c.review.title.replace(/[\r\n]/g, " ")}\n\nAccepted source: ${c.source.head}\n\nRelease and actual device health are tracked separately.\n`;
  const mediaUrls: string[] = [];
  const historical = readHistoricalProof(c);
  for (const side of ["baseline", "candidate"] as const) for (const g of historical.gates[side]) {
    summary += `\nHistorical ${side} ${g.gate}: exit ${g.exitCode}; ${g.complete ? "complete" : "incomplete"}; ${g.passed} passed, ${g.failed} named failures.\n`;
  }
  if (historical.ui) summary += `\nHistorical UI: ${historical.ui.assertions} assertions; ${historical.ui.frames} decoded frames (not fresh verification).\n`;
  for (const m of historical.media) {
    const target = join(dest, m.name), stat = lstatSync(target, { throwIfNoEntry: false });
    if (stat && (stat.isSymbolicLink() || !stat.isFile())) throw new Error("Unsafe proof projection file");
    writeFileSync(target, m.bytes);
  }
  // Preserve already-public historical media even when original private evidence is unavailable.
  for (const name of readdirSync(dest).filter(n => /^(?:recording\.(?:mp4|webm|png)|legacy-\d+\.(?:png|jpe?g|webp|mp4|webm))$/i.test(n))) {
    const stat = lstatSync(join(dest, name));
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Unsafe proof projection file");
    if (existsSync(join(dest, name))) mediaUrls.push(fileUrl(vaultName, `${rel}/${name}`));
  }
  summary += "\nDetailed historical evidence, if retained, remains on its original conversation card.\n";
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
  // Also validate empty-project history: proofProjection may not have visited these parents.
  let directory = vaultPath;
  for (const component of [".vault-chat", "shipments"]) {
    directory = join(directory, component);
    const stat = lstatSync(directory, { throwIfNoEntry: false });
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw new Error("Unsafe shipment projection directory");
    mkdirSync(directory, { recursive: true });
  }
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && (stat.isSymbolicLink() || !stat.isFile())) throw new Error("Unsafe shipment projection file");
  const previous = existsSync(path) ? readFileSync(path, "utf8") : "";
  for (const card of out.filter(c => c.health?.status !== "failed")) { const line = JSON.stringify(card); if (!previous.split("\n").includes(line)) appendFileSync(path, `${line}\n`); }
  return out.sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt));
}
/** Resolve only an already registered project in the authenticated vault; never an arbitrary repo path. */
export async function shipmentRepo(vaultPath: string, id: string): Promise<string | null> {
  for (const f of activeFolders(vaultPath).filter(f => existsSync(join(f.abs, ".git")))) if ((await acceptedChanges(f.abs)).some(c => c.id === id && c.acceptedAt && c.review.slug === f.slug)) return f.abs;
  return null;
}
export function deliveryRepos(vaultPath: string): string[] { return activeFolders(vaultPath).filter(f => existsSync(join(f.abs, ".git"))).map(f => f.abs); }

/** Read-only health detail for the updater. Offline laptop pending never turns box readiness into failure. */
export async function currentDeliveryHealth(version: string, revision: string): Promise<{ failed: boolean }> {
  if (!adapters) return { failed: false };
  let failed = false;
  for (const v of adapters.vaults()) for (const repo of deliveryRepos(v.path)) {
    const matching = await updateShippingJournal(repo, j => Object.values(state(j).releases).filter(r => r.target.version === version && r.target.revision === revision));
    for (const r of matching) {
      if (r.result?.status === "failed") failed = true;
    }
  }
  return { failed };
}
