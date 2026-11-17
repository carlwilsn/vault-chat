// The laptop's half of the hot core (src/coreBundle.ts): the main window follows the box's app/core bundle.
//
//   ready     src/main.tsx calls core_ready at the first paint: the native loader's handshake (src-tauri/src/core_loader.rs).
//             A box bundle that never gets here is the loader's to fall back from, not this code's.
//   follow    once the first screen is interactive, then every 5 minutes and on an app/core change record: the loader's
//             fallbacks are told to the box (a plugin.change switch by "auto", so the box stops offering what failed
//             here); the box's offer is checked against the installed shell (its commands and plugins), the box's API
//             and the installer's own core; a new bundle is fetched and checked by the loader in the background, and
//             taken at a quiet moment (no input for 5 minutes, nothing in the composer): the loader serves it and every
//             window reloads. No installer, no restart of the app.
// Only with a box (never a server this app runs itself), only in the native app's main window.
import { invoke, isTauri } from "@tauri-apps/api/core";
import { boxGet, boxLinkFor, boxPost, localServerLink, type Link } from "./boxChat";
import { CORE_PART, nextCoreStep, type CoreOffer, type CoreStep } from "./coreBundle";
import { BUILT_IN } from "./pluginDrafts";
import { useStore } from "./store";

export type CoreStatus = {
  shell: string;
  active: string;
  activeCommit: string | null;
  ready: boolean;
  current: string | null;
  previous: string | null;
  bad: string[];
  events: { from: string; to: string; reason: string; at_ms: number }[];
  commands: string[];
  plugins: string[];
  baked: { commit: string; commitTime: number | null };
};

export type CoreDeps = {
  native: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  link: () => Promise<Link | null>;
  get: (link: Link, path: string) => Promise<any>;
  post: (link: Link, path: string, body: Record<string, unknown>) => Promise<any>;
  /** Whether now is a moment to reload every window (Carl away, nothing typed in the composer). */
  quiet: () => boolean;
};

/** The loader's state now, or null (an installed app from before the loader). */
export async function coreStatus(native: CoreDeps["native"] = invoke): Promise<CoreStatus | null> {
  try {
    return await native<CoreStatus>("core_status");
  } catch {
    return null;
  }
}

/** Tell the box about the loader's fallbacks: a switch record while the box still offers what failed here. */
export async function reportFallbacks(s: CoreStatus, link: Link, offer: CoreOffer | null, d: Pick<CoreDeps, "native" | "post">): Promise<number> {
  if (!s.events.length) return 0;
  let wrote = 0;
  for (const ev of s.events) {
    if (offer?.version !== ev.from) continue;
    const r = await d.post(link, "/api/v2/supervisor", { plugin: CORE_PART, change: "switch", version: ev.to, by: "auto", reason: `the laptop's loader fell back from ${ev.from}: ${ev.reason}`.slice(0, 300) }).catch(() => null);
    if (r?.ok) wrote++;
  }
  await d.native("core_events_sent", { n: s.events.length }).catch(() => {});
  return wrote;
}

export type FollowResult = { step: CoreStep | { kind: "none"; why: string }; did: "nothing" | "installed" | "waiting" | "swapped" | "failed"; error?: string };

/** One look at the box's offer, and what follows from it. `swap`: take it now if quiet (else it waits for later). */
export async function followCoreOnce(d: CoreDeps, o: { swap?: boolean } = {}): Promise<FollowResult> {
  const s = await coreStatus(d.native);
  if (!s) return { step: { kind: "none", why: "an installed app from before the core loader" }, did: "nothing" };
  const link = await d.link();
  if (!link) return { step: { kind: "none", why: "no box" }, did: "nothing" };
  let box: { boxApi?: number; offer?: CoreOffer | null; publish?: boolean };
  try {
    box = (await d.get(link, "/api/v2/core")) ?? {};
  } catch (e) {
    return { step: { kind: "none", why: "the box has no core bundles (an older box) or is out of reach" }, did: "nothing", error: String((e as Error)?.message ?? e) };
  }
  const offer = box.offer ?? null;
  await reportFallbacks(s, link, offer, d);
  // Carl turned the box's core publishing off: the installed app's own core again.
  const step: CoreStep = box.publish === false && s.active !== BUILT_IN ? { kind: "baked", why: "the box's core publishing is off" } : nextCoreStep({
    offer,
    active: s.active === BUILT_IN ? null : s.active,
    bad: s.bad,
    bakedCommitTime: s.baked.commitTime,
    shell: { commands: s.commands, plugins: s.plugins },
    boxApi: typeof box.boxApi === "number" ? box.boxApi : null,
  });
  if (step.kind === "stay") return { step, did: "nothing" };
  const version = step.kind === "install" ? step.offer.version : null;
  if (step.kind === "install") {
    try {
      await d.native("core_install", { baseUrl: link.url, token: link.token, version: step.offer.version, sha256: step.offer.sha256 });
    } catch (e) {
      return { step, did: "failed", error: String((e as Error)?.message ?? e) };
    }
  }
  if (!o.swap || !d.quiet()) return { step, did: step.kind === "install" ? "installed" : "waiting" };
  try {
    await d.native("core_use", { version });
  } catch (e) {
    return { step, did: "failed", error: String((e as Error)?.message ?? e) };
  }
  return { step, did: "swapped" };
}

const QUIET_MS = 5 * 60_000;

async function defaultDeps(): Promise<CoreDeps> {
  const [{ idleMs }, { useDraft, hasDraft }] = await Promise.all([import("./userActivity"), import("./plugins/composer/draft")]);
  return {
    native: invoke,
    link: async () => {
      const vault = useStore.getState().vaultPath;
      const l = await boxLinkFor(vault).catch(() => null);
      // The core comes only from his box, never from a server this app runs itself.
      return l && l.url !== localServerLink(vault)?.url ? l : null;
    },
    get: (l, p) => boxGet(l, p, 15_000),
    post: (l, p, b) => boxPost(l, p, b),
    quiet: () => idleMs() >= QUIET_MS && !hasDraft(useDraft.getState()),
  };
}

let started = false;
/** Main window, native app: follow the box's core from now on. */
export function startCoreFollow(): void {
  if (started || !isTauri()) return;
  started = true;
  let running = false;
  const look = async () => {
    if (running) return;
    running = true;
    try {
      const r = await followCoreOnce(await defaultDeps(), { swap: true });
      if (r.did !== "nothing") console.info(`[core] ${r.did}${r.error ? `: ${r.error}` : ""}`);
    } catch (e) {
      console.warn("[core] follow failed:", e);
    } finally {
      running = false;
    }
  };
  void look();
  // Every 5 minutes: a new offer, or a bundle installed but not yet taken now that Carl has been away long enough.
  window.setInterval(() => void look(), QUIET_MS);
  window.addEventListener("vc-core-changed", () => void look());
}
