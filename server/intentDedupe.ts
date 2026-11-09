// Client retry keys for POST /api/v2/intent.
const INTENT_DEDUPE_MS = 3 * 60_000;
const intentsByRid = new Map<string, { at: number; out: Promise<Record<string, unknown>> }>();
/** Run `run` once per client retry key; no key: always run. Entries expire after a few minutes. */
export function dedupeIntent(key: string, run: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  if (key.endsWith(":")) return run();
  const now = Date.now();
  for (const [k, v] of intentsByRid) if (now - v.at > INTENT_DEDUPE_MS) intentsByRid.delete(k);
  const seen = intentsByRid.get(key);
  if (seen) return seen.out;
  const out = run();
  intentsByRid.set(key, { at: now, out });
  return out;
}
