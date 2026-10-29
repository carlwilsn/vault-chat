/** Contract for release verification adapters. Box HTTP reachability is NOT laptop/Tauri health.
 * Offline laptops stay pending, not healthy and not a reason to revert every release. Explicit fresh negative
 * reports do fail. No timers, second deployment state machine or network listener lives in this policy.
 */
export type ReleaseTarget = { id: string; version: string; revision: string; installedAt: number; previousVersion: string; rollbackOf?: string };
/** B owns pipeline lifecycle/readiness. Its adapter must report identity/exclusive ownership, not a foreign 200.
 * No port number or port allocation assumption belongs to release health.
 */
export type ReleaseVoiceHealth = {
  required: boolean; state: "disabled" | "starting" | "ready" | "failed";
  owned: boolean; error?: string; startupDeadline: number;
};
export type BoxReleaseHealth = {
  version: string; revision: string; observedAt: number; ready: boolean; error?: string;
  voice?: ReleaseVoiceHealth;
};
/** Captured from the ACTUAL authenticated Tauri client's post-update report, never box-side ping/heartbeat.
 * The host issues a fresh per-release challenge and binds reports to the paired client + version + source.
 */
export type LaptopReleaseHealth = {
  clientId: string; version: string; revision: string; observedAt: number; challenge: string;
  tauri: boolean; frontendMounted: boolean; boxConnected: boolean; syncReady: boolean; updaterReady: boolean;
  error?: string;
};
export type ReleaseHealthResult = {
  status: "pending" | "healthy" | "failed";
  action: "wait" | "confirm" | "revert-and-ship" | "needs-attention";
  reason: string; box: "pending" | "healthy" | "failed"; laptop: "pending" | "healthy" | "failed";
  /** A binary fallback is recovery only. It NEVER satisfies source rollback: ship the change-specific revert. */
  binaryFallback: boolean;
};
export function evaluateReleaseHealth(o: {
  target: ReleaseTarget; now: number; boxDeadline: number; maxReportAgeMs: number;
  laptopClientId: string; challenge: string; box?: BoxReleaseHealth; laptop?: LaptopReleaseHealth;
}): ReleaseHealthResult {
  const { target, now } = o;
  if (!target.id || !target.version || !target.revision || !target.previousVersion || !o.laptopClientId || !o.challenge || !Number.isFinite(now) || !Number.isFinite(o.boxDeadline) || !(o.maxReportAgeMs > 0)) throw new Error("Missing pinned release, paired laptop, challenge or health deadline");
  const matches = (r: { version: string; revision: string; observedAt: number }) => r.version === target.version && r.revision === target.revision && Number.isFinite(r.observedAt) && r.observedAt >= target.installedAt && r.observedAt <= now && now - r.observedAt <= o.maxReportAgeMs;
  let box: ReleaseHealthResult["box"] = "pending", laptop: ReleaseHealthResult["laptop"] = "pending";
  let boxReason = "Waiting for the box's matching release readiness", laptopReason = "Laptop offline, stale, or not yet reporting this release; health pending";
  if (o.box && matches(o.box)) {
    if (o.box.error) { box = "failed"; boxReason = o.box.error; }
    else if (o.box.ready) {
      const v = o.box.voice;
      if (!v?.required) box = "healthy";
      else if (v.state === "ready" && v.owned) box = "healthy";
      else if (v.state === "failed" || (v.state === "ready" && !v.owned) || now >= v.startupDeadline) {
        box = "failed"; boxReason = v.error || "Required voice pipeline is not ready and exclusively owned by this instance";
      } else boxReason = "Waiting for this instance's required voice pipeline setup/readiness";
    }
  }
  const voiceSetupDeadline = o.box && matches(o.box) && o.box.ready && o.box.voice?.required && o.box.voice.state === "starting" && Number.isFinite(o.box.voice.startupDeadline)
    ? Math.max(o.boxDeadline, o.box.voice.startupDeadline) : o.boxDeadline;
  if (box === "pending" && now >= voiceSetupDeadline) { box = "failed"; boxReason = "Box did not report matching release readiness before its deadline"; }
  const l = o.laptop;
  if (l && matches(l) && l.clientId === o.laptopClientId && l.challenge === o.challenge) {
    if (l.error || !l.tauri || !l.frontendMounted || !l.boxConnected || !l.syncReady || !l.updaterReady) { laptop = "failed"; laptopReason = l.error || "Actual laptop release readiness check failed"; }
    else laptop = "healthy";
  }
  if (box === "failed" || laptop === "failed") return {
    status: "failed", action: target.rollbackOf ? "needs-attention" : "revert-and-ship",
    reason: box === "failed" ? boxReason : laptopReason, box, laptop,
    // Keep the old box version for either device's confirmed failure. Source revert still travels laptop sync→CI.
    binaryFallback: !target.rollbackOf,
  };
  if (box === "healthy" && laptop === "healthy") return { status: "healthy", action: "confirm", reason: "Box and actual laptop verified this release", box, laptop, binaryFallback: false };
  return { status: "pending", action: "wait", reason: box === "pending" ? boxReason : laptopReason, box, laptop, binaryFallback: false };
}
