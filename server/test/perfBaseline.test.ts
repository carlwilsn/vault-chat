import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error plain .mjs scripts, no declarations
import { median, percentile, parseBatches, flatten, dedupe, summarize, compare, main } from "../../scripts/perf-baseline.mjs";
// @ts-expect-error plain .mjs scripts, no declarations
import { checkUrl, stats, summarizeRuns } from "../../scripts/typing-bench.mjs";
import { recordLaptopPerf } from "../laptopPerf";

const root = mkdtempSync(join(tmpdir(), "vc-perf-baseline-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const REV = "a".repeat(40);
const sample = (metric: string, method: string, durationMs: number, at: string, extra = {}) => ({ at, metric, method, durationMs, startPoint: method === "event-timing" ? "event" : method === "native-entry-ready-ipc-upper-bound" ? "native-entry" : "event", ...extra });
const batch = (samples: unknown[], over = {}) => ({ schema: 1, version: "0.8.0", revision: REV, session: "s1", surface: "tauri-production", runtime: "webview2", runtimeVersion: "130.0", eventTiming: true, clockQuantumMs: 0.1, startupTemperature: "unknown", samples, ...over });
/** Write batches with the box's own writer, so the script reads the real stored shape. */
let clock = 1_000_000; // the writer's rate limit wants a later "now" every time
function store(dir: string, batches: unknown[]) {
  for (const b of batches) expect(recordLaptopPerf(dir, b, true, (clock += 2000)).status).toBe(200);
}
const run = (...argv: string[]) => { const lines: string[] = []; const code = main(argv, (s: string) => lines.push(s)); return { code, text: lines.join("\n") }; };

describe("perf-baseline statistics", () => {
  it("median and nearest-rank p95", () => {
    expect(median([1, 2, 3])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(v, 0.95)).toBe(95);
    expect(percentile([7], 0.95)).toBe(7);
  });
  it("groups by metric and method, drops hidden, other surfaces and other revisions", () => {
    const b = [
      batch([sample("composer-key", "event-timing", 20, "2026-11-12T01:00:00.000Z"), sample("composer-key", "double-raf-estimate", 10, "2026-11-12T01:00:00.001Z"), sample("composer-key", "event-timing", 99, "2026-11-12T01:00:00.002Z", { visibility: "hidden" })]),
      batch([sample("composer-key", "event-timing", 500, "2026-11-12T01:00:01.000Z")], { surface: "browser", session: "s2" }),
      batch([sample("composer-key", "event-timing", 600, "2026-11-12T01:00:02.000Z")], { revision: "b".repeat(40), session: "s3" }),
    ];
    expect(summarize(flatten(b))["composer-key/event-timing"]).toMatchObject({ count: 2, medianMs: 310 });
    expect(Object.keys(summarize(flatten(b)))).toEqual(["composer-key/double-raf-estimate", "composer-key/event-timing"]);
    expect(summarize(flatten(b, { revision: "aaaa" }))["composer-key/event-timing"].count).toBe(1);
    expect(summarize(flatten(b, { surface: "any", includeHidden: true }))["composer-key/event-timing"].count).toBe(4);
  });
  it("dedupe counts a repeated sample once", () => {
    const s = flatten([batch([sample("composer-key", "event-timing", 20, "2026-11-12T01:00:00.000Z")])]);
    expect(dedupe([...s, ...s])).toHaveLength(1);
    expect(parseBatches('{"samples":[]}\nnot json\n\n{"x":1}\n')).toHaveLength(1);
  });
});

describe("compare", () => {
  const stat = (medianMs: number, p95Ms = medianMs) => ({ count: 10, medianMs, p95Ms, minMs: 1, maxMs: 99 });
  it("has no default margin", () => {
    expect(() => compare({}, {}, {})).toThrow(/margin/);
  });
  it("flags a metric worse than the percent or ms margin, on median or p95, and never a missing one", () => {
    const base = { "composer-key/event-timing": stat(20, 30), "launch-interactive/navigation-ready-estimate": stat(1000), "ctrl-k-key/event-timing": stat(20) };
    const now = { "composer-key/event-timing": stat(21, 40), "launch-interactive/navigation-ready-estimate": stat(900), "chat-panel-open/double-raf-estimate": stat(5) };
    const flags = (m: object) => Object.fromEntries(compare(base, now, m).map((r: any) => [r.key, r.flags]));
    expect(flags({ marginPct: 10 })["composer-key/event-timing"]).toEqual(["p95"]);
    expect(flags({ marginPct: 50 })["composer-key/event-timing"]).toEqual([]);
    expect(flags({ marginMs: 0.5 })["composer-key/event-timing"]).toEqual(["median", "p95"]);
    expect(flags({ marginPct: 0 })["launch-interactive/navigation-ready-estimate"]).toEqual([]); // faster is never flagged
    const rows = compare(base, now, { marginPct: 0 });
    expect(rows.find((r: any) => r.key === "ctrl-k-key/event-timing")).toMatchObject({ flags: [], note: "not in now" });
    expect(rows.find((r: any) => r.key === "chat-panel-open/double-raf-estimate")).toMatchObject({ flags: [], note: "not in baseline" });
  });
});

describe("command line over the box's real stored records", () => {
  it("records a baseline, merges later records without double counting, compares with exit codes", () => {
    const dir = join(root, "state1"), out = join(root, "base.json");
    store(dir, [batch([sample("composer-key", "event-timing", 20, "2026-11-12T01:00:00.000Z"), sample("composer-key", "event-timing", 30, "2026-11-12T01:00:00.100Z"), sample("launch-interactive", "native-entry-ready-ipc-upper-bound", 2000, "2026-11-12T01:00:00.200Z")])]);
    const rec = run("record", "--dir", dir, "--out", out);
    expect(rec.code).toBe(0);
    expect(rec.text).toMatch(/\| composer-key\/event-timing \| 2 \| 25\.0 \|/);
    expect(rec.text).toMatch(/No samples for: ctrl-k-key, fullscreen-transition, chat-panel-open\./);
    expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({ schema: 1, revisions: ["aaaaaaaa"], metrics: { "launch-interactive/native-entry-ready-ipc-upper-bound": { count: 1 } } });
    // Same records again plus a new session: merged, not doubled.
    store(dir, [batch([sample("composer-key", "event-timing", 40, "2026-11-12T02:00:00.000Z")], { session: "s9" })]);
    run("record", "--dir", dir, "--out", out, "--merge");
    expect(JSON.parse(readFileSync(out, "utf8")).metrics["composer-key/event-timing"].count).toBe(3);
    // Compare against a "now" with slower composer keys.
    const dir2 = join(root, "state2");
    store(dir2, [batch([sample("composer-key", "event-timing", 60, "2026-11-12T03:00:00.000Z"), sample("composer-key", "event-timing", 70, "2026-11-12T03:00:00.100Z")])]);
    const slow = run("compare", "--baseline", out, "--dir", dir2, "--margin-pct", "20");
    expect(slow.code).toBe(1);
    expect(slow.text).toMatch(/WORSE \(median, p95\)/);
    expect(run("compare", "--baseline", out, "--dir", dir2, "--margin-pct", "500").code).toBe(0);
    expect(() => run("compare", "--baseline", out, "--dir", dir2)).toThrow(/no default margin/);
    expect(() => run("show", "--dir", join(root, "nothing"))).toThrow(/no laptop-perf records/);
  });
});

describe("typing-bench guards and numbers", () => {
  it("only loopback test instances, never the live ports", () => {
    expect(checkUrl("http://127.0.0.1:1531/after/?scenario=conv-a")).toContain("1531");
    expect(() => checkUrl("http://127.0.0.1:8848/")).toThrow(/8848/);
    expect(() => checkUrl("http://localhost:8857/x")).toThrow(/8857/);
    expect(() => checkUrl("https://example.com/")).toThrow(/loopback/);
  });
  it("summarizes runs", () => {
    expect(stats([30, 10, 20])).toMatchObject({ count: 3, medianMs: 20, minMs: 10, maxMs: 30 });
    expect(summarizeRuns([[10, 12], [20, 22]])).toMatchObject({ count: 4, runs: 2, runMedianMs: 16 });
  });
});
