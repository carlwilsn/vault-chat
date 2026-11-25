// Carl's Claude subscription usage: how much of the 5-hour window and of the
// weekly limit is used, and when each resets, plus a per-model weekly limit and
// extra usage when the plan has them (the composer's context ring opens it:
// src/UsagePopover.tsx). Through the box's own sign-in (keys.ts
// claudeCodeToken, the token the CLI runs on): first the OAuth usage endpoint
// Claude Code's /usage reads; when that is refused (a setup-token has no
// profile scope, or it is rate limited: then it is not asked again before its
// retry-after) the rate-limit headers of the smallest possible call. The token
// is only ever an Authorization header: never logged, never returned.
//
// Kept on the box so the popover never waits: every turn's rate-limit event
// updates the figures (notePlanLimit), a finished turn and the box's start read
// them again when they are stale (refreshPlanUsage), and the last answer
// outlives a restart (keepPlanUsageIn). A read returns the kept answer at once.
import { readFileSync } from "node:fs";
import { writeAtomic } from "./atomic";
import { claudeCodeToken } from "./keys";

export type Window = { percent: number; resetsAt: number | null };
/** A scoped weekly limit (one model's, e.g. "Opus"), as the endpoint names it. */
export type ScopedWindow = Window & { label: string };
/** Extra usage (paid past the plan): spent and the monthly cap, in the currency's major unit. */
export type Extra = { enabled: boolean; used: number | null; limit: number | null; percent: number | null; currency: string };
export type PlanUsage = {
  fiveHour: Window | null;
  weekly: Window | null;
  /** Per-model weekly limits, when the plan has them. */
  scoped?: ScopedWindow[];
  extra?: Extra | null;
  /** When the box last read it all from Anthropic (0: only a turn's figures so far). */
  at: number;
  /** When a turn's rate-limit event last updated a figure. */
  turnAt?: number;
  source: "usage" | "headers" | null;
  error?: string;
};
type Figures = Pick<PlanUsage, "fiveHour" | "weekly" | "scoped" | "extra">;

/** VC_CLAUDE_API: a stand-in for tests; the box always asks Anthropic. */
const api = () => process.env.VC_CLAUDE_API || "https://api.anthropic.com";
const BETA = "oauth-2025-04-20";
/** A read older than this is read again (in the background when there is one to show). */
const FRESH_MS = 120_000;
/** After a turn: read again only when the last read is older than this (a turn's own event keeps it current between). */
const TURN_STALE_MS = 5 * 60_000;
/** The usage endpoint said 429 without a retry-after: leave it this long. */
const USAGE_BACKOFF_MS = 15 * 60_000;
/** The model the header probe asks for one token on: the cheapest. */
const PROBE_MODEL = process.env.VC_TITLE_MODEL || "claude-haiku-5-5";

let cached: PlanUsage | null = null;
let inflight: Promise<PlanUsage> | null = null;
let usageBlockedUntil = 0;
let storePath: string | null = null;

/** `scale`: the usage endpoint answers 0-100 (1), the headers and turn events 0-1 (100). */
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
const num = (v: unknown): number | null => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** The per-model weekly limits: the endpoint's rows (limits[], kind weekly_scoped), else its seven_day_<model> windows. */
function scopedOf(b: any): ScopedWindow[] {
  const out: ScopedWindow[] = [];
  const add = (label: unknown, w: Window | null) => {
    const l = String(label ?? "").trim();
    if (l && w && !out.some((x) => x.label.toLowerCase() === l.toLowerCase())) out.push({ label: l, ...w });
  };
  if (Array.isArray(b.limits)) {
    for (const r of b.limits) {
      if (!r || typeof r !== "object" || r.kind !== "weekly_scoped") continue;
      add(r.scope?.model?.display_name ?? r.scope?.surface?.display_name ?? r.label, win(r.percent ?? r.utilization, r.resets_at));
    }
  }
  if (Array.isArray(b.model_scoped)) for (const r of b.model_scoped) add(r?.display_name, win(r?.utilization, r?.resets_at));
  for (const [k, label] of [["seven_day_opus", "Opus"], ["seven_day_sonnet", "Sonnet"]] as const) {
    if (b[k]) add(label, win(b[k].utilization, b[k].resets_at));
  }
  return out;
}

/** Extra usage, when the plan has it turned on or has spent some; amounts come in minor units (cents). */
function extraOf(e: any): Extra | null {
  if (!e || typeof e !== "object") return null;
  const used = num(e.used_credits);
  const limit = num(e.monthly_limit);
  if (!e.is_enabled && !used) return null;
  return {
    enabled: !!e.is_enabled,
    used: used == null ? null : used / 100,
    limit: limit == null ? null : limit / 100,
    percent: pct(e.utilization, 1),
    currency: typeof e.currency === "string" && /^[A-Z]{3}$/.test(e.currency) ? e.currency : "USD",
  };
}

/** From the OAuth usage endpoint ({five_hour:{utilization,resets_at}, seven_day:{…}, seven_day_opus, extra_usage, …}), or null. */
export function fromUsageBody(b: any): Figures | null {
  if (!b || typeof b !== "object") return null;
  let five = b.five_hour ? win(b.five_hour.utilization, b.five_hour.resets_at) : null;
  const week = b.seven_day ? win(b.seven_day.utilization, b.seven_day.resets_at) : null;
  if (!five && !week) return null;
  // No 5-hour window running (null, or no reset): nothing of it is used.
  if (!five) five = { percent: 0, resetsAt: null };
  const scoped = scopedOf(b);
  const extra = extraOf(b.extra_usage);
  return { fiveHour: five, weekly: week, ...(scoped.length ? { scoped } : {}), ...(extra ? { extra } : {}) };
}

/** From a Messages response's unified rate-limit headers, or null. */
export function fromHeaders(h: { get(name: string): string | null }): Figures | null {
  const g = (k: string) => h.get(`anthropic-ratelimit-unified-${k}`);
  const five = win(g("5h-utilization"), g("5h-reset"), 100);
  const week = win(g("7d-utilization"), g("7d-reset"), 100);
  return five || week ? { fiveHour: five ?? { percent: 0, resetsAt: null }, weekly: week } : null;
}

/**
 * A turn's rate-limit event (Claude Code's SDKRateLimitInfo: rateLimitType, utilization 0-1, resetsAt in
 * seconds): that window's figure, kept at once. Other kinds (overage) say nothing about a window shown here.
 */
export function notePlanLimit(info: { rateLimitType?: unknown; utilization?: unknown; resetsAt?: unknown } | null | undefined, now = Date.now()): void {
  if (!info) return;
  const w = win(info.utilization, info.resetsAt, 100);
  if (!w) return;
  const base: PlanUsage = cached ?? { fiveHour: null, weekly: null, at: 0, source: null };
  const next: PlanUsage = { ...base, turnAt: now };
  switch (info.rateLimitType) {
    case "five_hour":
      next.fiveHour = w;
      break;
    case "seven_day":
      next.weekly = w;
      break;
    case "seven_day_opus":
    case "seven_day_sonnet": {
      const label = info.rateLimitType === "seven_day_opus" ? "Opus" : "Sonnet";
      const rest = (base.scoped ?? []).filter((s) => s.label.toLowerCase() !== label.toLowerCase());
      next.scoped = [...rest, { label, ...w }];
      break;
    }
    default:
      return;
  }
  delete next.error;
  keep(next);
}

function keep(u: PlanUsage): void {
  cached = u;
  if (!storePath) return;
  try {
    writeAtomic(storePath, JSON.stringify(u));
  } catch (e) {
    console.warn("[planUsage] not kept:", (e as Error).message);
  }
}

/** The box keeps the last answer in this file, so a restart has one to show at once. */
export function keepPlanUsageIn(path: string): void {
  storePath = path;
  try {
    const u = JSON.parse(readFileSync(path, "utf8")) as PlanUsage;
    if (u && typeof u === "object" && typeof u.at === "number" && (u.fiveHour || u.weekly)) cached ??= u;
  } catch {
    /* none yet */
  }
}

async function ask(token: string, f: Fetch): Promise<PlanUsage> {
  const auth = { Authorization: `Bearer ${token}`, "anthropic-beta": BETA, "anthropic-version": "2023-06-01" };
  const now = Date.now();
  let why = "";
  if (now < usageBlockedUntil) why = "usage 429";
  else {
    try {
      const r = await f(`${api()}/api/oauth/usage`, { method: "GET", headers: auth, signal: AbortSignal.timeout(10_000) });
      if (r.ok) {
        const u = fromUsageBody(await r.json().catch(() => null));
        if (u) return { ...u, at: now, source: "usage" };
      } else {
        why = `usage ${r.status}`;
        // Rate limited: not asked again before it says (the headers carry the figures meanwhile).
        if (r.status === 429) {
          const after = num(r.headers.get("retry-after"));
          usageBlockedUntil = now + (after && after > 0 ? after * 1000 : USAGE_BACKOFF_MS);
        }
      }
    } catch (e) {
      why = `usage: ${(e as Error).name}`;
    }
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
    // The headers carry no per-model limit or extra usage: the last ones the endpoint gave stay.
    if (u) return { ...u, ...(cached?.scoped ? { scoped: cached.scoped } : {}), ...(cached?.extra ? { extra: cached.extra } : {}), at: now, source: "headers" };
    why = `${why}; messages ${r.status} without rate-limit headers`;
  } catch (e) {
    why = `${why}; messages: ${(e as Error).name}`;
  }
  return { fiveHour: null, weekly: null, at: now, source: null, error: why.replace(/^; /, "") };
}

/** Read it again now (one request at a time); a failure keeps what there was. */
function read(token: string, f: Fetch): Promise<PlanUsage> {
  inflight ??= ask(token, f)
    .then((u) => {
      if (u.source) {
        keep(u);
        return u;
      }
      return cached ?? u;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

const shown = (u: PlanUsage | null): u is PlanUsage => !!u && !!(u.fiveHour || u.weekly);

/**
 * The usage. With figures kept: those at once (a stale read is refreshed in the background), or, with `fresh`,
 * after reading again when they are older than FRESH_MS. With none yet: read now. No sign-in: nothing to say.
 */
export async function planUsage(token: string | null, f: Fetch = fetch, opts: { fresh?: boolean } = {}): Promise<PlanUsage> {
  if (!token) return { fiveHour: null, weekly: null, at: Date.now(), source: null, error: "not signed in to Claude" };
  if (shown(cached)) {
    if (Date.now() - cached.at < FRESH_MS) return cached;
    const again = read(token, f);
    return opts.fresh ? again : cached;
  }
  return read(token, f);
}

/** Read again in the background when the last read is older than `staleMs` (a finished turn, the box's start). */
export function refreshPlanUsage(staleMs = TURN_STALE_MS, token: string | null = claudeCodeToken(), f: Fetch = fetch): void {
  // Only on a box that keeps it (main.ts keepPlanUsageIn): a test's engine asks nobody.
  if (!storePath || !token || inflight) return;
  if (cached && Date.now() - cached.at < staleMs) return;
  void read(token, f).catch(() => {});
}

/** Tests: forget the kept answer and (unless keepBackoff) any back-off. */
export function forgetPlanUsage(opts: { keepBackoff?: boolean } = {}): void {
  cached = null;
  if (!opts.keepBackoff) usageBlockedUntil = 0;
  storePath = null;
}
