// Carl's Claude subscription usage: how much of the 5-hour window and of the
// weekly limit is used, and when each resets (the composer's context ring opens
// it: src/UsagePopover.tsx). Through the box's own sign-in (keys.ts
// claudeCodeToken, the token the CLI runs on): first the OAuth usage endpoint
// Claude Code's /usage reads; when that is refused (a setup-token has no
// profile scope) the rate-limit headers of the smallest possible call. The token
// is only ever an Authorization header: never logged, never returned.
export type Window = { percent: number; resetsAt: number | null };
export type PlanUsage = { fiveHour: Window | null; weekly: Window | null; at: number; source: "usage" | "headers" | null; error?: string };

/** VC_CLAUDE_API: a stand-in for tests; the box always asks Anthropic. */
const api = () => process.env.VC_CLAUDE_API || "https://api.anthropic.com";
const BETA = "oauth-2025-04-20";
const FRESH_MS = 120_000;
/** The model the header probe asks for one token on: the cheapest. */
const PROBE_MODEL = process.env.VC_TITLE_MODEL || "claude-haiku-5-5";

let cached: PlanUsage | null = null;
let inflight: Promise<PlanUsage> | null = null;

/** `scale`: the usage endpoint answers 0-100 (1), the headers 0-1 (100). */
const pct = (v: unknown, scale: number): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v) * scale;
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
};
const when = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
};
const win = (u: unknown, resets: unknown, scale = 1): Window | null => {
  const p = pct(u, scale);
  return p == null ? null : { percent: p, resetsAt: when(resets) };
};

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** From the OAuth usage endpoint ({five_hour:{utilization,resets_at}, seven_day:{…}}), or null. */
export function fromUsageBody(b: any): Pick<PlanUsage, "fiveHour" | "weekly"> | null {
  if (!b || typeof b !== "object") return null;
  const five = b.five_hour ? win(b.five_hour.utilization, b.five_hour.resets_at) : null;
  const week = b.seven_day ? win(b.seven_day.utilization, b.seven_day.resets_at) : null;
  return five || week ? { fiveHour: five, weekly: week } : null;
}

/** From a Messages response's unified rate-limit headers, or null. */
export function fromHeaders(h: { get(name: string): string | null }): Pick<PlanUsage, "fiveHour" | "weekly"> | null {
  const g = (k: string) => h.get(`anthropic-ratelimit-unified-${k}`);
  const five = win(g("5h-utilization"), g("5h-reset"), 100);
  const week = win(g("7d-utilization"), g("7d-reset"), 100);
  return five || week ? { fiveHour: five, weekly: week } : null;
}

async function ask(token: string, f: Fetch): Promise<PlanUsage> {
  const auth = { Authorization: `Bearer ${token}`, "anthropic-beta": BETA, "anthropic-version": "2023-06-01" };
  const now = Date.now();
  let why = "";
  try {
    const r = await f(`${api()}/api/oauth/usage`, { method: "GET", headers: auth, signal: AbortSignal.timeout(10_000) });
    if (r.ok) {
      const u = fromUsageBody(await r.json().catch(() => null));
      if (u) return { ...u, at: now, source: "usage" };
    } else why = `usage ${r.status}`;
  } catch (e) {
    why = `usage: ${(e as Error).name}`;
  }
  try {
    const r = await f(`${api()}/v1/messages`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      // A subscription token is only good for Claude Code's own calls: the same system line the CLI sends.
      body: JSON.stringify({ model: PROBE_MODEL, max_tokens: 1, system: "You are Claude Code, Anthropic's official CLI for Claude.", messages: [{ role: "user", content: "." }] }),
      signal: AbortSignal.timeout(15_000),
    });
    const u = fromHeaders(r.headers);
    if (u) return { ...u, at: now, source: "headers" };
    why = `${why}; messages ${r.status} without rate-limit headers`;
  } catch (e) {
    why = `${why}; messages: ${(e as Error).name}`;
  }
  return { fiveHour: null, weekly: null, at: now, source: null, error: why.replace(/^; /, "") };
}

/** The usage, at most FRESH_MS old; one request at a time. No sign-in: nothing to say. */
export async function planUsage(token: string | null, f: Fetch = fetch): Promise<PlanUsage> {
  if (!token) return { fiveHour: null, weekly: null, at: Date.now(), source: null, error: "not signed in to Claude" };
  if (cached && Date.now() - cached.at < FRESH_MS) return cached;
  inflight ??= ask(token, f).then((u) => {
    // A failure is not kept: the next opening asks again.
    if (u.source) cached = u;
    return u;
  }).finally(() => {
    inflight = null;
  });
  return inflight;
}

/** Tests: forget the cached answer. */
export function forgetPlanUsage(): void {
  cached = null;
}
