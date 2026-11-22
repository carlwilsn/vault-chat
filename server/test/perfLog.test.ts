import { describe, it, expect, afterAll } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordLaptopPerf } from "../laptopPerf";
import { perfBuilds, perfCompare, perfLaunch } from "../perfLog";
import { recordHostBuild } from "../hostBuild";
import { readBoxOffer, actBoxOffer } from "../boxOffers";

// Speed per build, from the app's own perf probe (server/perfLog.ts, box:perf): what replaced the Timing tool.
const root = mkdtempSync(join(tmpdir(), "vc-perf-log-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const A = "a".repeat(40), B = "b".repeat(40);
const sample = (metric: string, method: string, durationMs: number, extra = {}) => ({ at: new Date().toISOString(), metric, method, durationMs, startPoint: "event", visibility: "visible", ...extra });
const batch = (revision: string, samples: unknown[], over = {}) => ({ schema: 1, window: "main", version: revision === A ? "0.10.6" : "0.10.7", revision, session: "s1", surface: "tauri-production", runtime: "webview2", runtimeVersion: "130.0", eventTiming: true, clockQuantumMs: null, startupTemperature: "unknown", samples, ...over });
let clock = Date.now();

describe("box:perf", () => {
  it("folds each probe batch per build, keeps it past the raw log, and compares builds", async () => {
    const send = (b: unknown) => expect(recordLaptopPerf(root, b, true, (clock += 2000)).status).toBe(200);
    send(batch(A, [sample("composer-key", "double-raf-estimate", 20), sample("composer-key", "double-raf-estimate", 22), sample("chat-panel-open", "double-raf-estimate", 40)]));
    send(batch(A, [sample("composer-key", "double-raf-estimate", 99, { visibility: "hidden" })]));
    send(batch(A, [sample("composer-key", "event-timing", 500)], { surface: "browser" }));
    send(batch(B, [sample("composer-key", "double-raf-estimate", 21), sample("chat-panel-open", "double-raf-estimate", 80)]));
    expect(existsSync(join(root, "perf-builds.json"))).toBe(true);
    const builds = perfBuilds(root);
    expect(builds.map((b) => b.revision)).toEqual([B.slice(0, 12), A.slice(0, 12)]);
    expect(builds[1]!.speeds["composer-key/double-raf-estimate"]).toBe("median 21 ms, p95 22 ms (2)");
    expect(Object.keys(builds[1]!.speeds)).not.toContain("composer-key/event-timing");
    expect(builds[0]!.missing).toContain("launch-interactive");

    expect(perfCompare(root, {}).ok).toBe(false); // no margin, no default
    const c = perfCompare(root, { marginPct: 25 });
    expect(c.text).toMatch(/WORSE than the margin: chat-panel-open\/double-raf-estimate/);
    expect(c.text.split("WORSE")[1]).not.toMatch(/composer-key/);
    const base = join(root, "base.json");
    writeFileSync(base, JSON.stringify({ schema: 1, samples: [{ key: "composer-key/double-raf-estimate", ms: 10 }] }));
    expect(perfCompare(root, { baseline: base, marginMs: 5 }).text).toMatch(/WORSE than the margin: composer-key/);

    expect(perfLaunch(root)).toMatch(/no launch report/);
    recordHostBuild(root, { host: "laptop", version: "0.10.7", revision: B, surface: "tauri-production", launchMs: 1438, launchMethod: "native-entry-ready-ipc-upper-bound" });
    expect(perfLaunch(root)).toMatch(/^1438 ms \(native-entry-ready-ipc-upper-bound\)/);

    const r = await readBoxOffer({ vault: root, stateDir: root }, "box:perf");
    expect(r.ok).toBe(true);
    expect(Object.keys(r.state!)).toEqual(["builds", "launch"]);
    const act = await actBoxOffer({ vault: root, stateDir: root }, "box:perf", "compare", { from: "aaaa", to: "bbbb", marginMs: 10 });
    expect(act.text).toMatch(/chat-panel-open/);
  });
});
