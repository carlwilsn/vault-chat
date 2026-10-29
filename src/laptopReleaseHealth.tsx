import { useEffect } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { check } from "@tauri-apps/plugin-updater";
import { boxGet, boxLinkFor, boxPost, type Link } from "./boxChat";
import { boxSyncStates, subscribeBoxSync } from "./vaultSync";
import { useStore } from "./store";
import type { LaptopHealthReport, ReleaseHealthChallenge } from "./shippingProtocol";

declare const __APP_REVISION__: string | undefined;
declare const __APP_VERSION__: string | undefined;
const revision = typeof __APP_REVISION__ === "string" ? __APP_REVISION__ : "";
const buildVersion = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "";
let mounted = false;
let checking = false;
let lastAttempt = 0;
const reported = new Set<string>();

/** Installed main window only. A browser/preview/dev build never reports Tauri health. */
export function LaptopReleaseHealthMount() {
  useEffect(() => {
    if (!isTauri() || !import.meta.env.PROD) return;
    let live = true;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        if (!live) return;
        const root = document.getElementById("root");
        mounted = !!root?.firstElementChild && root.getBoundingClientRect().height > 0;
        void probeCurrent();
      });
    });
    const off = subscribeBoxSync(() => { if (mounted) void probeCurrent(); });
    return () => { live = false; mounted = false; cancelAnimationFrame(frame); off(); };
  }, []);
  return null;
}

async function probeCurrent() {
  const vault = useStore.getState().vaultPath;
  const link = await boxLinkFor(vault);
  if (vault && link) await probeLaptopReleaseHealth(vault, link);
}

/** Called by the existing box feed and sync cycle, never a second health poller. */
export async function probeLaptopReleaseHealth(vault: string, link: Link): Promise<void> {
  if (!isTauri() || !import.meta.env.PROD || !mounted || checking || Date.now() - lastAttempt < 10_000 || !/^[0-9a-f]{40}$/.test(revision)) return;
  if (useStore.getState().vaultPath !== vault || useStore.getState().boxChat?.reachable !== true) return;
  // Sync in flight/offline/behind is pending, not grounds to revert a release.
  const sync = boxSyncStates().get(vault);
  if (!sync?.lastOkAt || !sync.report?.configured || !sync.report.ok || sync.report.conflict || sync.running) return;
  checking = true;
  lastAttempt = Date.now();
  try {
    const { challenge: c } = await boxGet(link, "/api/v1/release-health/challenge") as { challenge: ReleaseHealthChallenge | null };
    if (!c || reported.has(c.challenge) || c.expiresAt <= Date.now()) return;
    const version = await getVersion(); // Native app metadata, not the challenge or the box's version.
    if (version !== c.version || revision !== c.revision || buildVersion !== version) return;
    let updaterReady = false;
    let error: string | undefined;
    try {
      const update = await check({ timeout: 15_000 });
      // Exercise the installed plugin and release endpoint without downloading/installing anything.
      updaterReady = !update || update.currentVersion === version;
      if (update) await update.close();
      if (!updaterReady) error = "Installed updater reports a different running version";
    } catch (e) {
      const message = String(e);
      // A transient manifest/network outage stays pending. Missing/forbidden native APIs are an actual negative.
      if (!/not (?:allowed|found|registered)|unknown (?:plugin|command)|permission denied|forbidden/i.test(message)) return;
      error = "Installed updater API unavailable";
    }
    // Recheck after the async native calls: switching vaults or losing the box cannot certify readiness.
    const state = useStore.getState();
    const currentSync = boxSyncStates().get(vault);
    if (state.vaultPath !== vault || state.boxChat?.reachable !== true || !currentSync?.report?.ok || currentSync.running || !mounted || Date.now() >= c.expiresAt) return;
    const report: LaptopHealthReport = {
      releaseId: c.releaseId, challenge: c.challenge, version, revision,
      tauri: true, frontendMounted: mounted, boxConnected: true, syncReady: true, updaterReady,
      ...(error ? { error } : {}),
    };
    const result = await boxPost(link, "/api/v1/release-health/laptop", report);
    if (result.ok) reported.add(c.challenge);
  } catch {
    // No challenge, offline, unpaired device, old box: honest pending. Never synthesize a success.
  } finally { checking = false; }
}
