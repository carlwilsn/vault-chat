// The Landed card (src/UpdateBanner.tsx LandedCard): after the window runs a newer core (a hot core swap,
// src/coreFollow.ts, or a new installer's own), the bottom-right card says what landed: main's commit subjects between
// the core Carl last acknowledged and the one running now (the box's GET /api/v2/core/landed/<from>/<to>, server/
// coreBundles.ts coreLanded), and one OK. Once per new core: the acknowledged commit is kept in localStorage. The first
// run ever only records it (nothing to compare with). As state: app/titlebar's `landed`, dismissLanded, landedChanged.
export const LANDED_ACK_KEY = "vc.landedAck";
export const LANDED_FALLBACK = "A new version of the interface is live";

export type LandedSummary = { shown: boolean; revision?: string; what?: string[] };

/** A commit subject as Carl reads it: its first sentence, at most 120 characters. */
export function firstSentence(subject: string): string {
  const s = subject.replace(/\s+/g, " ").trim();
  const m = /[.!?](\s|$)/.exec(s);
  const head = m ? s.slice(0, m.index + 1) : s;
  return head.length > 120 ? `${head.slice(0, 117).trimEnd()}...` : head;
}

/** The card's lines: at most `max` first sentences, then "+N more". Empty subjects: the fallback line. */
export function landedLines(subjects: readonly string[] | null, max = 5): string[] {
  const list = (subjects ?? []).map(firstSentence).filter(Boolean);
  if (!list.length) return [LANDED_FALLBACK];
  return list.length > max ? [...list.slice(0, max - 1), `+${list.length - (max - 1)} more`] : list;
}

/** What to do at start: `running` is the core's main commit now, `ack` the one Carl last saw the card for. */
export function landedStep(ack: string | null, running: string | null): "none" | "seed" | "show" {
  if (!running) return "none";
  if (!ack) return "seed";
  return ack === running ? "none" : "show";
}

// ---------------------------------------------------------------- the card as state (as src/updateState.ts)

const KEY = "__vcLandedState";
type Slot = { now: LandedSummary; fns: Set<(s: LandedSummary) => void> };
const slot = (): Slot => ((globalThis as Record<string, unknown>)[KEY] as Slot | undefined) ?? (((globalThis as Record<string, unknown>)[KEY] = { now: { shown: false }, fns: new Set() }) as Slot);

export function publishLanded(s: LandedSummary): void {
  const x = slot();
  if (JSON.stringify(x.now) === JSON.stringify(s)) return;
  x.now = s;
  for (const f of [...x.fns]) f(s);
}
export const landedNow = (): LandedSummary => slot().now;
export function onLandedChanged(fn: (s: LandedSummary) => void): () => void {
  slot().fns.add(fn);
  return () => void slot().fns.delete(fn);
}

const store = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

/** Saves what is acknowledged; a full or denied storage only loses the acknowledgement (never throws). */
export function saveLandedAck(value: string | null): void {
  try {
    const ls = store();
    if (value) ls?.setItem(LANDED_ACK_KEY, value);
    else ls?.removeItem(LANDED_ACK_KEY);
  } catch (e) {
    console.warn("[landed] could not save the acknowledgement:", e);
  }
}

/** OK: this core is acknowledged, the card goes and does not come back for it. */
export function dismissLanded(): void {
  const r = landedNow().revision;
  if (r) saveLandedAck(r);
  publishLanded({ shown: false });
}

export type LandedDeps = {
  /** The core's main commit now, or null (no loader, or it can't say). */
  running: () => Promise<string | null>;
  /** Main's commit subjects in from..to, or null (no box, an older box, a commit it doesn't have). */
  subjects: (from: string, to: string) => Promise<string[] | null>;
};

/** At start (main window): show the card when the core is newer than the one acknowledged. Never throws. */
export async function checkLanded(d: LandedDeps): Promise<LandedSummary> {
  try {
    const running = await d.running();
    const ack = store()?.getItem(LANDED_ACK_KEY) ?? null;
    const step = landedStep(ack, running);
    if (step === "seed") saveLandedAck(running);
    if (step !== "show") return landedNow();
    const subjects = await d.subjects(ack!, running!).catch(() => null);
    // A switch back to an older core brings nothing new: acknowledged without a card.
    if (subjects && !subjects.length) {
      saveLandedAck(running);
      return landedNow();
    }
    publishLanded({ shown: true, revision: running!, what: landedLines(subjects) });
  } catch (e) {
    console.warn("[landed] could not check:", e);
  }
  return landedNow();
}

/** The real deps: the native loader's status and the box's commit list. */
export async function startLanded(): Promise<void> {
  const { coreStatus, defaultDeps } = await import("./coreFollow");
  const deps = await defaultDeps();
  await checkLanded({
    running: async () => {
      const s = await coreStatus(deps.native);
      return s ? s.activeCommit || s.baked.commit || null : null;
    },
    subjects: async (from, to) => {
      const link = await deps.link();
      if (!link) return null;
      const r = await deps.get(link, `/api/v2/core/landed/${from}/${to}`);
      return Array.isArray(r?.subjects) ? r.subjects.map(String) : null;
    },
  });
}
