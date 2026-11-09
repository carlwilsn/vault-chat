// The context ring's popover: Carl's plan usage from the usage endpoint, else from rate-limit headers;
// the token only ever travels as the Authorization header and never comes back.
import { describe, it, expect, beforeEach } from "vitest";
import { forgetPlanUsage, fromHeaders, fromUsageBody, planUsage } from "../planUsage";

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
});
