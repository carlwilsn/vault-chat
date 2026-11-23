// The Ready card (src/UpdateBanner.tsx ReadyCard): the box has a newer core bundle than the window runs. Nothing swaps
// by itself any more: the follow (src/coreFollow.ts) only has the loader fetch and check it, and the bottom-right card
// says what it brings (main's commit subjects between the core running now and the offer's, the same list as the
// Landed card: GET /api/v2/core/landed/<from>/<to>), with OK (swap in now) and Later (hidden until a newer version or
// the next app start). OK acknowledges what landed (vc.landedAck = the offer's commit), so no Landed card follows
// the swap. One card at a time: a Landed card (a core that arrived without his OK, e.g. an installer's own) never
// shows beside a pending Ready card: what landed joins the Ready card's list and is acknowledged (absorbLanded).
// The loader's safe-boot fallback is untouched. As state: app/titlebar's `ready`, acceptReady, laterReady,
// readyChanged.
import { BUILT_IN } from "./pluginDrafts";
import type { CoreStep } from "./coreBundle";
import { LANDED_ACK_KEY, LANDED_FALLBACK, dismissLanded, landedLines, landedNow, saveLandedAck, setLandedAbsorber } from "./landed";

export type ReadySummary = {
  shown: boolean;
  /** The bundle it would run (BUILT_IN: the installed app's own core). */
  version?: string;
  /** Its main commit (what OK acknowledges), or null when unknown. */
  commit?: string | null;
  what?: string[];
  /** ready: waiting for OK; switching: OK pressed, the loader is swapping; failed: the swap did not start (error). */
  phase?: "ready" | "switching" | "failed";
  error?: string;
};

// ---------------------------------------------------------------- the card as state (as src/landed.ts)

const KEY = "__vcReadyState";
type Slot = { now: ReadySummary; fns: Set<(s: ReadySummary) => void>; later: Set<string> };
const slot = (): Slot => ((globalThis as Record<string, unknown>)[KEY] as Slot | undefined) ?? (((globalThis as Record<string, unknown>)[KEY] = { now: { shown: false }, fns: new Set(), later: new Set() }) as Slot);

export function publishReady(s: ReadySummary): void {
  const x = slot();
  if (JSON.stringify(x.now) === JSON.stringify(s)) return;
  x.now = s;
  for (const f of [...x.fns]) f(s);
  absorbLanded();
}

const FALLBACKS = new Set([LANDED_FALLBACK, LANDED_FALLBACK.replace("is live", "is ready")]);
/** One card at a time: while a Ready card is up, a Landed card's lines join its list (what landed first, then what
 *  the offer brings) and that landing is acknowledged, so the Landed card goes. Runs whenever either card changes. */
export function absorbLanded(): void {
  const r = readyNow();
  const l = landedNow();
  if (!r.shown || !l.shown) return;
  dismissLanded();
  publishReady({ ...r, what: mergeLines(l.what ?? [], r.what ?? []) });
}
/** What landed, then what the offer brings; the plain fallback lines only when there is nothing else. */
function mergeLines(landed: readonly string[], ready: readonly string[]): string[] {
  const real = [...new Set([...landed, ...ready])].filter((x) => !FALLBACKS.has(x));
  return real.length ? real : [...ready];
}
// A Landed card about to show while a Ready card is up joins it instead (src/landed.ts checkLanded asks first).
setLandedAbsorber((what) => {
  const r = readyNow();
  if (!r.shown) return false;
  publishReady({ ...r, what: mergeLines(what, r.what ?? []) });
  return true;
});
export const readyNow = (): ReadySummary => slot().now;
export function onReadyChanged(fn: (s: ReadySummary) => void): () => void {
  slot().fns.add(fn);
  return () => void slot().fns.delete(fn);
}
/** Tests: a fresh app start (nothing put off for Later). */
export function _resetReady(): void {
  slot().later.clear();
  publishReady({ shown: false });
}

/** Later: the card goes until the box offers another version, or the app starts again (kept in memory only). */
export function laterReady(): void {
  const v = readyNow().version;
  if (v) slot().later.add(v);
  publishReady({ shown: false });
}

/** Two main commits are the same one (either may be abbreviated, at least 7 characters). */
export function sameCommit(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (!x || !y) return false;
  return x === y || (Math.min(x.length, y.length) >= 7 && (x.startsWith(y) || y.startsWith(x)));
}

/** The card goes (unless OK is swapping right now). */
function takeDown(): ReadySummary {
  const now = readyNow();
  if (now.shown && now.phase !== "switching") publishReady({ shown: false });
  return readyNow();
}

export type ReadyDeps = {
  /** The core's main commit now, or null (it can't say). */
  running: () => Promise<string | null>;
  /** Main's commit subjects in from..to, or null (no box, an older box, a commit it doesn't have). */
  subjects: (from: string, to: string) => Promise<string[] | null>;
};

/** After each look at the box's offer: show the card for a new bundle, keep it for the same one, take it down when the
 *  offer is what runs again: the same main revision as the running core, or (a box bundle) one whose commits the
 *  running core has all (the box's running..offer list is empty). Never throws. */
export async function offerReady(step: CoreStep | { kind: "none"; why: string }, bakedCommit: string | null, d: ReadyDeps): Promise<ReadySummary> {
  try {
    const now = readyNow();
    if (step.kind !== "install" && step.kind !== "baked") return takeDown();
    const version = step.kind === "install" ? step.offer.version : BUILT_IN;
    const commit = step.kind === "install" ? step.offer.commit : bakedCommit;
    if (slot().later.has(version)) return readyNow();
    const running = await d.running().catch(() => null);
    // The card is "offered core vs running core": an offer of the main revision that runs already brings nothing.
    if (running && commit && sameCommit(running, commit)) return takeDown();
    if (now.shown && now.version === version) return now;
    const subjects = running && commit ? await d.subjects(running, commit).catch(() => null) : null;
    // A box bundle whose commits are all in the running core already (running..offer is empty): nothing to land.
    // (A switch back to the installed app's own core may be older on purpose: that one is still offered.)
    if (step.kind === "install" && subjects && !subjects.length) return takeDown();
    const what = subjects && subjects.length ? landedLines(subjects) : step.kind === "baked" ? ["Back to the installed app's own interface."] : [LANDED_FALLBACK.replace("is live", "is ready")];
    publishReady({ shown: true, version, commit: commit ?? null, what, phase: "ready" });
  } catch (e) {
    console.warn("[ready] could not check:", e);
  }
  return readyNow();
}

const store = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

/** How long OK may say "Switching…" before the card says the swap did not happen. */
export const SWITCH_TIMEOUT_MS = 30_000;

/** OK: swap in now. `swap` runs the loader (src/coreFollow.ts followCoreOnce with swap); on success the window
 *  reloads. What landed is acknowledged first, so the new page shows no Landed card; a swap that did not start puts the
 *  old acknowledgement back and the card says why. Storage is optional: a full localStorage (QuotaExceededError) only
 *  loses the acknowledgement, the swap still runs. A swap that neither reloads nor answers within SWITCH_TIMEOUT_MS
 *  leaves "Switching…" for "failed" with the reason. */
export async function acceptReady(swap: () => Promise<{ did: string; error?: string }>, timeoutMs = SWITCH_TIMEOUT_MS): Promise<ReadySummary> {
  const r = readyNow();
  if (!r.shown || r.phase === "switching") return r;
  publishReady({ ...r, phase: "switching", error: undefined });
  let prevAck: string | null = null;
  try {
    prevAck = store()?.getItem(LANDED_ACK_KEY) ?? null;
  } catch {
    prevAck = null;
  }
  if (r.commit) saveLandedAck(r.commit);
  let res: { did: string; error?: string };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    res = await Promise.race([
      swap(),
      new Promise<{ did: string; error: string }>((ok) => {
        timer = setTimeout(() => ok({ did: "failed", error: `the switch did not finish within ${Math.round(timeoutMs / 1000)} s` }), timeoutMs);
      }),
    ]);
  } catch (e) {
    res = { did: "failed", error: String((e as Error)?.message ?? e) };
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (res.did === "swapped") return readyNow();
  saveLandedAck(prevAck);
  // Nothing to swap to any more (the box switched back meanwhile): the card goes.
  if (res.did === "nothing") publishReady({ shown: false });
  else publishReady({ ...r, phase: "failed", error: res.error ?? "the loader did not take it" });
  return readyNow();
}

/** OK on the Ready card (the card, or app/titlebar acceptReady): the loader swaps in the box's core now. */
export const pressReadyOk = () => acceptReady(async () => (await import("./coreFollow")).acceptCoreNow());
