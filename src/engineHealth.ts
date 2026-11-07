// What the box says about the engines it can run, read out of /api/v1/health.
//
// The shape moved once: the router's `engines` record used to sit only under
// whichever engine led (engine.pi.engines), and Engine.health now also hoists it
// to engine.engines. A client must not care which box version it is talking to,
// so every reader goes through here and accepts both.
export type EngineInfo = { signedIn: boolean; version: string | null };

type Bag = Record<string, unknown>;
const bag = (v: unknown): Bag | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Bag) : null);

/** The `engines` record: `{default, pi, claude?}` by name, or null on a box that has none. */
export function enginesOf(health: unknown): Bag | null {
  const eng = bag(bag(health)?.engine);
  if (!eng) return null;
  const hoisted = bag(eng.engines);
  if (hoisted) return hoisted;
  // An older box: nested under the engine in charge, whichever that is.
  for (const v of Object.values(eng)) {
    const nested = bag(bag(v)?.engines);
    if (nested) return nested;
  }
  return null;
}

/** The engine a conversation that has made no choice of its own runs on. */
export function defaultEngineOf(health: unknown): "pi" | "claude" | null {
  const d = enginesOf(health)?.default;
  return d === "claude" || d === "pi" ? d : null;
}

/** Claude Code as the box reports it, or null on a box that has none it can run. */
export function claudeOf(health: unknown): EngineInfo | null {
  const c = bag(enginesOf(health)?.claude);
  if (!c) return null;
  return { signedIn: c.signedIn === true, version: typeof c.version === "string" ? c.version : null };
}
