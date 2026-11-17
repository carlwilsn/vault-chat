// The laptop's half of the hot core (src/coreBundle.ts): the main window follows the box's app/core bundle.
//
//   ready     src/main.tsx calls core_ready at the first paint: the native loader's handshake (src-tauri/src/core_loader.rs).
//             A box bundle that never gets here is the loader's to fall back from, not this code's.
//   follow    once the first screen is interactive, then every 5 minutes and on an app/core change record: the loader's
//             fallbacks are told to the box (a plugin.change switch by "auto", so the box stops offering what failed
//             here); the box's offer is checked against the installed shell (its commands and plugins), the box's API
//             and the installer's own core; a new bundle is fetched and checked by the loader in the background, and
//             taken at a quiet moment (no input for 5 minutes, nothing in the composer): the loader serves it and every
//             window reloads. No installer, no restart of the app. The offer is only what Carl kept: a new bundle waits
//             for him as Change ready (src/changeReady.ts), whose Try runs tryCore and whose Back / Discard / Switch
//             back run followCoreNow (at once, not at a quiet moment: he asked for it).
//   trying    while Carl tries a bundle (the Change ready card), following leaves it running; a loader fallback from
//             the tried bundle discards it (a discard by "auto", the card says why), like a plugin draft failing.
//   swap      before every swap the screen is kept (src/coreSwap.ts): the old picture stays up until the new bundle
//             has put back the open chat, its scroll, the composer draft and the panes.
// Only with a box (never a server this app runs itself), only in the native app's main window.
import { invoke, isTauri } from "@tauri-apps/api/core";
import { boxGet, boxLinkFor, boxPost, localServerLink, type Link } from "./boxChat";
import { CORE_PART, nextCoreStep, type CoreCandidate, type CoreOffer, type CoreStep } from "./coreBundle";
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
  /** The core version Carl tries now (the Change ready card), or null. */
  tried?: () => string | null;
  /** The tried bundle failed here (the loader fell back from it): discard it by "auto", with why. */
  triedFailed?: (version: string, why: string) => void;
  /** Just before the loader swaps: keep the screen (src/coreSwap.ts saveSwapState). */
  beforeSwap?: () => Promise<unknown>;
};

/** The loader's state now, or null (an installed app from before the loader). */
export async function coreStatus(native: CoreDeps["native"] = invoke): Promise<CoreStatus | null> {
  try {
    return await native<CoreStatus>("core_status");
  } catch {
    return null;
  }
}

/** Tell the box about the loader's fallbacks: a switch record while the box still offers what failed here; a discard
 *  (by "auto") when what failed is the bundle Carl was trying. */
export async function reportFallbacks(s: CoreStatus, link: Link, offer: CoreOffer | null, d: Pick<CoreDeps, "native" | "post" | "tried" | "triedFailed">): Promise<number> {
  if (!s.events.length) return 0;
  let wrote = 0;
  for (const ev of s.events) {
    const tried = d.tried?.() ?? null;
    if (tried && ev.from === tried && offer?.version !== ev.from) {
      d.triedFailed?.(tried, `the loader fell back from it: ${ev.reason}`.slice(0, 300));
      wrote++;
      continue;
    }
    if (offer?.version !== ev.from) continue;
    const r = await d.post(link, "/api/v2/supervisor", { plugin: CORE_PART, change: "switch", version: ev.to, by: "auto", reason: `the laptop's loader fell back from ${ev.from}: ${ev.reason}`.slice(0, 300) }).catch(() => null);
    if (r?.ok) wrote++;
  }
  await d.native("core_events_sent", { n: s.events.length }).catch(() => {});
  return wrote;
}

export type FollowResult = { step: CoreStep | { kind: "none"; why: string }; did: "nothing" | "installed" | "waiting" | "swapped" | "failed"; error?: string };

/** One look at the box's offer, and what follows from it. `swap`: take it now if quiet (else it waits for later);
 *  `now`: Carl asked for it (Back, Discard, Switch back on the card): take it whether quiet or not. */
export async function followCoreOnce(d: CoreDeps, o: { swap?: boolean; now?: boolean } = {}): Promise<FollowResult> {
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
  // Carl tries a bundle: it runs until he keeps, discards or stops trying it (a fallback from it discarded it above).
  const tried = d.tried?.() ?? null;
  if (tried && s.bad.includes(tried)) d.triedFailed?.(tried, "it failed to come up here");
  else if (tried) return { step: { kind: "stay", why: `Carl is trying ${tried}` }, did: "nothing" };
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
  if (!o.swap || (!o.now && !d.quiet())) return { step, did: step.kind === "install" ? "installed" : "waiting" };
  try {
    await d.beforeSwap?.().catch(() => {});
    await d.native("core_use", { version });
  } catch (e) {
    return { step, did: "failed", error: String((e as Error)?.message ?? e) };
  }
  return { step, did: "swapped" };
}

/** Try a bundle waiting as Change ready in Carl's windows: the loader fetches and checks it, the screen is kept, and
 *  every window loads it. Throws a plain reason when this laptop can't run it (the card says it). */
export async function tryCore(version: string, c: CoreCandidate, d: CoreDeps): Promise<void> {
  const s = await coreStatus(d.native);
  if (!s) throw new Error("this installed app has no core loader yet (it needs one newer installer)");
  const why = candidateProblem(version, c, s);
  if (why) throw new Error(why);
  const link = await d.link();
  if (!link) throw new Error("no box to fetch it from");
  if (s.active !== version) {
    await d.native("core_install", { baseUrl: link.url, token: link.token, version, sha256: c.sha256 });
    await d.beforeSwap?.().catch(() => {});
    await d.native("core_use", { version });
  }
}

/** Why this laptop can't run a bundle waiting as Change ready, or null (it can: the card offers Try). */
export function candidateProblem(version: string, c: CoreCandidate, s: Pick<CoreStatus, "bad" | "baked" | "commands" | "plugins">): string | null {
  const step = nextCoreStep({ offer: { version, sha256: c.sha256, commit: c.commit, commitTime: c.commitTime, needs: c.needs, seq: 0 }, active: null, bad: s.bad, bakedCommitTime: s.baked.commitTime, shell: { commands: s.commands, plugins: s.plugins }, boxApi: c.boxApi });
  return step.kind === "install" ? null : step.why;
}

/** Carl asked (Back, Discard, Switch back on the card): run what the box says is current now, at once. */
export async function followCoreNow(): Promise<FollowResult> {
  return followCoreOnce(await defaultDeps(), { swap: true, now: true });
}

const QUIET_MS = 5 * 60_000;

/** Change ready's side (src/changeReady.ts gives it at load; this module never imports the UI). */
let trying: Pick<CoreDeps, "tried" | "triedFailed"> = {};
export function provideCoreTrying(t: Pick<CoreDeps, "tried" | "triedFailed">): void {
  trying = t;
}

export async function defaultDeps(): Promise<CoreDeps> {
  const [{ idleMs }, { useDraft, hasDraft }, { saveSwapState }] = await Promise.all([import("./userActivity"), import("./plugins/composer/draft"), import("./coreSwap")]);
  return {
    tried: () => trying.tried?.() ?? null,
    triedFailed: (version, why) => trying.triedFailed?.(version, why),
    beforeSwap: () => saveSwapState(),
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
