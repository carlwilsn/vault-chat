// The laptop's half of the hot core (src/coreBundle.ts): the main window follows the box's app/core bundle.
//
//   ready     src/main.tsx calls core_ready at the first paint: the native loader's handshake (src-tauri/src/core_loader.rs).
//             A box bundle that never gets here is the loader's to fall back from, not this code's.
//   follow    once the first screen is interactive, then every 5 minutes and on an app/core change record: the loader's
//             fallbacks are told to the box (a plugin.change switch by "auto", so the box stops offering what failed
//             here); the box's offer is checked against the installed shell (its commands and plugins), the box's API
//             and the installer's own core; a new bundle is fetched and checked by the loader in the background, and
//             the bottom-right Ready card (src/coreReady.ts) says what it brings. Nothing swaps without Carl's OK
//             there: OK has the loader serve it and every window reloads (Later hides the card until a newer version
//             or the next start). No installer, no restart of the app. The offer is what the records keep: a new
//             bundle that passed the gate is kept by "gate" on the box (server/gate.ts landCore); a switch back
//             (Carl's or the agent's explicit word) runs followCoreNow at once.
//   swap      before every swap the screen is kept (src/coreSwap.ts): the old frame stays up until the new bundle
//             has put back the open chat, its scroll, the composer draft and the panes.
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
  /** Each command's signature version (an installed shell from before it: absent). */
  abi?: Record<string, string>;
  baked: { commit: string; commitTime: number | null };
};

export type CoreDeps = {
  native: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  link: () => Promise<Link | null>;
  get: (link: Link, path: string) => Promise<any>;
  post: (link: Link, path: string, body: Record<string, unknown>) => Promise<any>;
  /** Just before the loader swaps: keep the screen (src/coreSwap.ts saveSwapState). */
  beforeSwap?: () => Promise<unknown>;
  /** Just before the loader swaps: what the window should run after the load, so the new page says plainly whether it
   *  does (checkSwapOutcome). */
  expect?: (e: Omit<SwapExpect, "at">) => void;
};

// ---------------------------------------------------------------- what the swap was for, said after the load

/** The main window's sessionStorage (it survives the load): what the swap was to run. */
export const EXPECT_KEY = "vc.coreExpect";
/** Older than this, a kept expectation is not about this load (a crash, a later launch). */
const EXPECT_MAX_MS = 3 * 60_000;
export type SwapExpect = { to: string; kind: "back" | "follow"; what?: string; at: number };

const session = (): Storage | null => {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
};

export function expectSwap(e: Omit<SwapExpect, "at">, now = Date.now()): void {
  try {
    session()?.setItem(EXPECT_KEY, JSON.stringify({ ...e, at: now }));
  } catch {
    /* no storage: nothing said after the load */
  }
}
export function clearSwapExpect(): void {
  try {
    session()?.removeItem(EXPECT_KEY);
  } catch {
    /* none */
  }
}
/** The kept expectation, once (it is removed), or null when none or too old. */
export function takeSwapExpect(now = Date.now()): SwapExpect | null {
  let e: SwapExpect | null = null;
  try {
    const raw = session()?.getItem(EXPECT_KEY);
    e = raw ? (JSON.parse(raw) as SwapExpect) : null;
  } catch {
    e = null;
  }
  clearSwapExpect();
  return e && typeof e.to === "string" && typeof e.at === "number" && Math.abs(now - e.at) <= EXPECT_MAX_MS ? e : null;
}

const coreLabel = (v: string) => (v === BUILT_IN ? "the installed app's own frontend" : `frontend ${v}`);

/** What to tell Carl after a swap's load, from what the loader runs now. Never silent: a swap that did not take says why. */
export function swapOutcome(e: SwapExpect, s: Pick<CoreStatus, "active" | "bad" | "events">): { ok: boolean; text: string } {
  if (s.active === e.to) {
    return { ok: true, text: e.to === BUILT_IN ? "Back on the installed app's own frontend." : `Now running ${coreLabel(e.to)}${e.what ? `: ${e.what}` : ""}.` };
  }
  const ev = [...s.events].reverse().find((x) => x.from === e.to);
  const why = ev ? ev.reason : s.bad.includes(e.to) ? `${e.to} failed to come up here` : "the app's loader kept the one it ran";
  return { ok: false, text: `Couldn't switch: ${why}. Still on ${coreLabel(s.active)}.` };
}

/** Main window, once after its load: a swap just happened here, so say what runs now. Waits for this load to have
 *  said ready to the loader (a bundle that loads but never comes up is not "running"). Null: no swap, or no loader. */
export async function checkSwapOutcome(native: CoreDeps["native"] = invoke, o: { waitMs?: number; stepMs?: number } = {}): Promise<{ ok: boolean; text: string } | null> {
  const e = takeSwapExpect();
  if (!e) return null;
  const end = Date.now() + (o.waitMs ?? 35_000);
  for (;;) {
    const s = await coreStatus(native);
    if (!s) return null;
    // Not the bundle it was to run: the loader chose another one (or fell back already): say so now.
    if (s.active !== e.to || s.ready || Date.now() > end) return swapOutcome(e, s);
    await new Promise((r) => setTimeout(r, o.stepMs ?? 300));
  }
}


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

export type FollowResult = { step: CoreStep | { kind: "none"; why: string }; did: "nothing" | "installed" | "waiting" | "swapped" | "failed"; error?: string; /** the loader's state it looked at */ status?: CoreStatus };

/** One look at the box's offer, and what follows from it. Without `swap` a new bundle is only fetched and checked
 *  (the Ready card asks Carl); `swap`: take it now (Carl pressed OK, or a switch back); `now`: it is a switch back. */
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
  // Carl turned the box's core publishing off: the installed app's own core again.
  const step: CoreStep = box.publish === false && s.active !== BUILT_IN ? { kind: "baked", why: "the box's core publishing is off" } : nextCoreStep({
    offer,
    active: s.active === BUILT_IN ? null : s.active,
    bad: s.bad,
    bakedCommitTime: s.baked.commitTime,
    shell: { commands: s.commands, plugins: s.plugins, abi: s.abi },
    boxApi: typeof box.boxApi === "number" ? box.boxApi : null,
  });
  if (step.kind === "stay") return { step, did: "nothing", status: s };
  const version = step.kind === "install" ? step.offer.version : null;
  if (step.kind === "install") {
    try {
      await d.native("core_install", { baseUrl: link.url, token: link.token, version: step.offer.version, sha256: step.offer.sha256 });
    } catch (e) {
      return { step, did: "failed", error: String((e as Error)?.message ?? e), status: s };
    }
  }
  if (!o.swap) return { step, did: step.kind === "install" ? "installed" : "waiting", status: s };
  try {
    await d.beforeSwap?.().catch(() => {});
    d.expect?.({ to: version ?? BUILT_IN, kind: o.now ? "back" : "follow" });
    await d.native("core_use", { version });
  } catch (e) {
    clearSwapExpect();
    return { step, did: "failed", error: String((e as Error)?.message ?? e) };
  }
  return { step, did: "swapped", status: s };
}

/** A switch back: run what the box says is current now, at once. */
export async function followCoreNow(): Promise<FollowResult> {
  return followCoreOnce(await defaultDeps(), { swap: true, now: true });
}

/** Carl pressed OK on the Ready card (or the agent did, when he asked): swap in what the box offers now. */
export async function acceptCoreNow(): Promise<FollowResult> {
  return followCoreOnce(await defaultDeps(), { swap: true });
}

/** The Ready card's commit list: the box's GET /api/v2/core/landed/<from>/<to>. */
export function readyDeps(deps: CoreDeps, s: CoreStatus | null | undefined): import("./coreReady").ReadyDeps {
  return {
    running: async () => (s ? s.activeCommit || s.baked.commit || null : null),
    subjects: async (from, to) => {
      const link = await deps.link();
      if (!link) return null;
      const r = await deps.get(link, `/api/v2/core/landed/${from}/${to}`);
      return Array.isArray(r?.subjects) ? r.subjects.map(String) : null;
    },
  };
}

const LOOK_MS = 5 * 60_000;

export async function defaultDeps(): Promise<CoreDeps> {
  const { saveSwapState } = await import("./coreSwap");
  return {
    beforeSwap: () => saveSwapState(),
    expect: (e) => expectSwap(e),
    native: invoke,
    link: async () => {
      const vault = useStore.getState().vaultPath;
      const l = await boxLinkFor(vault).catch(() => null);
      // The core comes only from his box, never from a server this app runs itself.
      return l && l.url !== localServerLink(vault)?.url ? l : null;
    },
    get: (l, p) => boxGet(l, p, 15_000),
    post: (l, p, b) => boxPost(l, p, b),
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
      const deps = await defaultDeps();
      const r = await followCoreOnce(deps);
      if (r.did !== "nothing") console.info(`[core] ${r.did}${r.error ? `: ${r.error}` : ""}`);
      // A fetched and checked bundle waits for Carl's OK on the Ready card; a failed fetch shows nothing.
      if (r.did !== "failed") await (await import("./coreReady")).offerReady(r.step, r.status?.baked.commit ?? null, readyDeps(deps, r.status));
    } catch (e) {
      console.warn("[core] follow failed:", e);
    } finally {
      running = false;
    }
  };
  void look();
  // A newer core than the one Carl last acknowledged (a new installer's own; a swap's OK already acknowledged it): say what landed.
  void import("./landed").then((m) => m.startLanded()).catch(() => {});
  // Every 5 minutes: a new offer (the Ready card), or the offer gone back to what runs (the card goes).
  window.setInterval(() => void look(), LOOK_MS);
  window.addEventListener("vc-core-changed", () => void look());
}
