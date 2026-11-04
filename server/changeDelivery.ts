/** Native release health, driven by the project sync cycle.
 * No per-vault display projections or proof artifact copies are produced. */
import { existsSync, readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import { isLoopbackAddr, tailnetLoginOk } from "./auth";
import { updateShippingJournal, type AcceptedChange, type ShippingJournal } from "./changeShipping";
import { evaluateReleaseHealth, type BoxReleaseHealth, type LaptopReleaseHealth, type ReleaseHealthResult, type ReleaseTarget } from "./releaseHealth";
import type { LaptopHealthReport, ReleaseHealthChallenge } from "../src/shippingProtocol";
import { activeFolders } from "./projectFolders";

export type DeliveryRelease = {
  target: ReleaseTarget; box?: BoxReleaseHealth; result?: ReleaseHealthResult;
  devices: Record<string, { challenge: ReleaseHealthChallenge; used?: boolean; report?: LaptopReleaseHealth }>;
};
export type DeliveryState = {
  releases: Record<string, DeliveryRelease>;
  /** Archived metadata only; no rollback dispatcher or UI. */
  rollbacks: Record<string, { status: "requested" | "running" | "accepted" | "failed"; jobId?: string; error?: string }>;
};
export type DeliveryAdapters = {
  boxHealth: () => Promise<BoxReleaseHealth>;
  vaults: () => { name: string; path: string }[];
  stateDir: string;
};
let adapters: DeliveryAdapters | undefined;
export function configureChangeDelivery(a: DeliveryAdapters): void { adapters = a; }
// Existing updater failure marker identity, not a public proof projection.
const safeId = (s: string) => createHash("sha256").update(s).digest("hex");
const MAX_AGE = 5 * 60_000;
const state = (j: ShippingJournal): DeliveryState => j.delivery ??= { releases: {}, rollbacks: {} };
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
