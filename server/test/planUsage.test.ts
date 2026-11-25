// The context ring's popover: Carl's plan usage from the usage endpoint, else from rate-limit headers;
// the token only ever travels as the Authorization header and never comes back.
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetPlanUsage, fromHeaders, fromUsageBody, keepPlanUsageIn, notePlanLimit, planUsage, refreshPlanUsage } from "../planUsage";

const TOKEN = "sk-ant-oat01-test-not-real";
beforeEach(() => forgetPlanUsage());

describe("plan usage", () => {
  it("reads the usage endpoint's 0-100 rows and ISO resets", () => {
    const u = fromUsageBody({ five_hour: { utilization: 37, resets_at: "2026-11-09T05:00:00Z" }, seven_day: { utilization: 12.34, resets_at: "2026-11-12T00:00:00Z" } })!;
    expect(u.fiveHour).toEqual({ percent: 37, resetsAt: Date.parse("2026-11-09T05:00:00Z") });
    expect(u.weekly?.percent).toBe(12.3);
  });

  it("reads the headers' 0-1 utilization (1 is 100%) and unix-second resets", () => {
    const h = new Headers({ "anthropic-ratelimit-unified-5h-utilization": "1", "anthropic-ratelimit-unified-5h-reset": "1794193200", "anthropic-ratelimit-unified-7d-utilization": "0.25" });
    const u = fromHeaders(h)!;
    expect(u.fiveHour).toEqual({ percent: 100, resetsAt: 1794193200 * 1000 });
    expect(u.weekly).toEqual({ percent: 25, resetsAt: null });
  });

  it("falls back to the headers when the usage endpoint refuses, sends the token only as a header, never returns it", async () => {
    const seen: RequestInit[] = [];
    const f = async (url: string, init: RequestInit) => {
      seen.push(init);
      if (url.endsWith("/api/oauth/usage")) return new Response("{}", { status: 403 });
      return new Response("{}", { status: 200, headers: { "anthropic-ratelimit-unified-5h-utilization": "0.4", "anthropic-ratelimit-unified-7d-utilization": "0.1" } });
    };
    const u = await planUsage(TOKEN, f);
    expect(u.source).toBe("headers");
    expect(u.fiveHour?.percent).toBe(40);
    expect(JSON.stringify(u)).not.toContain(TOKEN);
    expect((seen[0]!.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(String(seen[1]!.body)).not.toContain(TOKEN);
    // Cached: no second round.
    await planUsage(TOKEN, f);
    expect(seen.length).toBe(2);
  });

  it("no sign-in: says so, asks nothing", async () => {
    const u = await planUsage(null, async () => {
      throw new Error("must not be called");
    });
    expect(u.error).toBe("not signed in to Claude");
  });

  it("reads per-model weekly limits and extra usage; no running 5-hour window is 0% with no reset", () => {
    const u = fromUsageBody({
      five_hour: null,
      seven_day: { utilization: 40, resets_at: "2026-11-27T00:00:00Z" },
      seven_day_opus: { utilization: 55, resets_at: "2026-11-27T00:00:00Z" },
      seven_day_sonnet: null,
      seven_day_oauth_apps: null,
      extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1234, utilization: 24.68, currency: "USD" },
    })!;
    expect(u.fiveHour).toEqual({ percent: 0, resetsAt: null });
    expect(u.scoped).toEqual([{ label: "Opus", percent: 55, resetsAt: Date.parse("2026-11-27T00:00:00Z") }]);
    expect(u.extra).toEqual({ enabled: true, used: 12.34, limit: 50, percent: 24.7, currency: "USD" });
    // The server's rows win over the named windows, by the model's own label.
    const r = fromUsageBody({ seven_day: { utilization: 1 }, limits: [{ kind: "weekly_scoped", group: "weekly", percent: 9, resets_at: null, scope: { model: { display_name: "Fable" } } }, { kind: "session", percent: 3 }] })!;
    expect(r.scoped).toEqual([{ label: "Fable", percent: 9, resetsAt: null }]);
    // Extra usage that is off and unspent says nothing.
    expect(fromUsageBody({ seven_day: { utilization: 1 }, extra_usage: { is_enabled: false, used_credits: 0 } })!.extra).toBeUndefined();
  });

  it("a turn's rate-limit event updates its window at once, with no request", async () => {
    notePlanLimit({ rateLimitType: "five_hour", utilization: 0.62, resetsAt: 1794193200 });
    notePlanLimit({ rateLimitType: "seven_day", utilization: 0.2, resetsAt: 1794600000 });
    notePlanLimit({ rateLimitType: "overage", utilization: 0.9 });
    notePlanLimit({ rateLimitType: "five_hour" }); // no figure: nothing changes
    const u = await planUsage(TOKEN, async () => new Response("{}", { status: 500 }));
    expect(u.fiveHour).toEqual({ percent: 62, resetsAt: 1794193200 * 1000 });
    expect(u.weekly?.percent).toBe(20);
  });

  it("kept figures come back at once while a stale read refreshes in the background; fresh waits for it", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = async (url: string) => {
      calls++;
      if (url.endsWith("/api/oauth/usage")) {
        await gate;
        return new Response(JSON.stringify({ five_hour: { utilization: 80, resets_at: null }, seven_day: { utilization: 30 } }), { status: 200 });
      }
      throw new Error("no probe");
    };
    notePlanLimit({ rateLimitType: "five_hour", utilization: 0.5 });
    const quick = await planUsage(TOKEN, f);
    expect(quick.fiveHour?.percent).toBe(50);
    expect(calls).toBe(1); // the refresh started, the answer did not wait for it
    const fresh = planUsage(TOKEN, f, { fresh: true });
    release();
    expect((await fresh).fiveHour?.percent).toBe(80);
    expect(calls).toBe(1); // one read at a time
  });

  it("a failed read keeps the figures there were", async () => {
    notePlanLimit({ rateLimitType: "seven_day", utilization: 0.33 });
    const u = await planUsage(TOKEN, async () => new Response("{}", { status: 500 }), { fresh: true });
    expect(u.weekly?.percent).toBe(33);
    expect(u.error).toBeUndefined();
  });

  it("a 429 from the usage endpoint is not asked again before its retry-after; the headers answer meanwhile", async () => {
    const urls: string[] = [];
    const f = async (url: string) => {
      urls.push(url);
      if (url.endsWith("/api/oauth/usage")) return new Response("{}", { status: 429, headers: { "retry-after": "3600" } });
      return new Response("{}", { status: 200, headers: { "anthropic-ratelimit-unified-7d-utilization": "0.5" } });
    };
    const a = await planUsage(TOKEN, f);
    expect(a.source).toBe("headers");
    // Headers with no 5-hour figures: no window running.
    expect(a.fiveHour).toEqual({ percent: 0, resetsAt: null });
    forgetPlanUsage({ keepBackoff: true });
    await planUsage(TOKEN, f);
    expect(urls.filter((u) => u.endsWith("/api/oauth/usage")).length).toBe(1);
  });

  it("a token the usage endpoint refuses (no profile scope) goes straight to the headers next time", async () => {
    const urls: string[] = [];
    const f = async (url: string) => {
      urls.push(url);
      if (url.endsWith("/api/oauth/usage")) return new Response("{}", { status: 403 });
      return new Response("{}", { status: 200, headers: { "anthropic-ratelimit-unified-7d-utilization": "0.24" } });
    };
    await planUsage(TOKEN, f);
    forgetPlanUsage({ keepBackoff: true });
    const u = await planUsage(TOKEN, f);
    expect(u.weekly?.percent).toBe(24);
    expect(urls.filter((x) => x.endsWith("/api/oauth/usage")).length).toBe(1);
  });

  it("the box keeps the answer in a file and a restart starts from it; refresh asks only when stale", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "plan-usage-")), "plan-usage.json");
    keepPlanUsageIn(path);
    let calls = 0;
    const f = async () => {
      calls++;
      return new Response(JSON.stringify({ five_hour: { utilization: 12, resets_at: "2026-11-25T03:00:00Z" }, seven_day: { utilization: 7 } }), { status: 200 });
    };
    refreshPlanUsage(0, TOKEN, f);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(1);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).not.toContain(TOKEN);
    refreshPlanUsage(60_000, TOKEN, f); // fresh enough: no request
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(1);
    forgetPlanUsage();
    keepPlanUsageIn(path);
    const u = await planUsage(TOKEN, async () => {
      throw new Error("must not be called");
    });
    expect(u.fiveHour?.percent).toBe(12);
    expect(u.source).toBe("usage");
  });

  it("refresh asks nobody on an engine that keeps nothing (tests, no box)", async () => {
    refreshPlanUsage(0, TOKEN, async () => {
      throw new Error("must not be called");
    });
  });
});

