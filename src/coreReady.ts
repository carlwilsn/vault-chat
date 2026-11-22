// The Ready card (src/UpdateBanner.tsx ReadyCard): the box has a newer core bundle than the window runs. Nothing swaps
// by itself any more: the follow (src/coreFollow.ts) only has the loader fetch and check it, and the bottom-right card
// says what it brings (main's commit subjects between the core running now and the offer's, the same list as the
// Landed card: GET /api/v2/core/landed/<from>/<to>), with OK (swap in now) and Later (hidden until a newer version or
// the next app start). OK acknowledges what landed (vc.landedAck = the offer's commit), so no Landed card follows
// the swap. The loader's safe-boot fallback is untouched. As state: app/titlebar's `ready`, acceptReady, laterReady,
// readyChanged.
import { BUILT_IN } from "./pluginDrafts";
import type { CoreStep } from "./coreBundle";
import { LANDED_ACK_KEY, LANDED_FALLBACK, landedLines, saveLandedAck } from "./landed";

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
}
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

export type ReadyDeps = {
  /** The core's main commit now, or null (it can't say). */
  running: () => Promise<string | null>;
  /** Main's commit subjects in from..to, or null (no box, an older box, a commit it doesn't have). */
  subjects: (from: string, to: string) => Promise<string[] | null>;
};

/** After each look at the box's offer: show the card for a new bundle, keep it for the same one, take it down when the
 *  offer is what runs again. Never throws. */
export async function offerReady(step: CoreStep | { kind: "none"; why: string }, bakedCommit: string | null, d: ReadyDeps): Promise<ReadySummary> {
  try {
    const now = readyNow();
    if (step.kind !== "install" && step.kind !== "baked") {
      if (now.shown && now.phase !== "switching") publishReady({ shown: false });
      return readyNow();
    }
    const version = step.kind === "install" ? step.offer.version : BUILT_IN;
    const commit = step.kind === "install" ? step.offer.commit : bakedCommit;
    if (slot().later.has(version)) return readyNow();
    if (now.shown && now.version === version) return now;
    const running = await d.running().catch(() => null);
    const subjects = running && commit ? await d.subjects(running, commit).catch(() => null) : null;
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
