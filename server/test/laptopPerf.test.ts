import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordLaptopPerf, readLaptopPerf } from "../laptopPerf";
import { validPerfBatch, type PerfBatch } from "../../src/laptopPerfProtocol";
const root = mkdtempSync(join(tmpdir(), "vc-laptop-perf-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const batch = (): PerfBatch => ({ schema: 1, version: "0.7.25", revision: "a".repeat(40), session: "testsession", surface: "browser", runtime: "browser", runtimeVersion: "130.0", eventTiming: true, clockQuantumMs: 0.1, startupTemperature: "unknown", samples: [{ at: "2026-11-02T12:00:00.000Z", metric: "composer-key", method: "event-timing", durationMs: 24, startPoint: "event" }] });

describe("bounded content-free laptop performance storage", () => {
  it("rejects invalid, extra/content fields, impossible durations, versions and oversized lists atomically", () => {
    for (const value of [null, {}, { ...batch(), input: "private" }, { ...batch(), version: "private words" }, { ...batch(), session: "../path" }, { ...batch(), samples: [] }, { ...batch(), samples: Array(33).fill(batch().samples[0]) }, ...[NaN, Infinity, -1, 600001, "24"].map(durationMs => ({ ...batch(), samples: [{ ...batch().samples[0], durationMs }] })), { ...batch(), samples: [{ ...batch().samples[0], key: "a" }] }, { ...batch(), samples: [{ ...batch().samples[0], startPoint: "native-entry" }] }]) {
      expect(validPerfBatch(value)).toBe(false);
      expect(recordLaptopPerf(root, value, true).status).toBe(400);
    }
    expect(readdirSync(root)).toEqual([]);
  });
  it("does not treat a browser or unpaired native report as the real laptop", () => {
    const native = { ...batch(), surface: "tauri-production" };
    expect(recordLaptopPerf(root, native, false).status).toBe(403);
    expect(recordLaptopPerf(root, batch(), false, 10000).status).toBe(200);
    expect(readLaptopPerf(root)[0]).toMatchObject({ surface: "browser", nativeTransport: false });
    expect(recordLaptopPerf(root, native, true, 10001).status).toBe(429);
    expect(recordLaptopPerf(root, native, true, 11000).status).toBe(200);
  });
  it("preserves all raw durations and metadata, rotates at 256 KiB with one older file and caps reads", () => {
    const b = batch();
    b.samples = Array.from({ length: 32 }, (_, i) => ({ ...b.samples[0], durationMs: i + 0.12345 }));
    for (let i = 0; i < 150; i++) expect(recordLaptopPerf(root, b, false, 20000 + i * 1000).status).toBe(200);
    const files = readdirSync(join(root, "logs"));
    expect(files.sort()).toEqual(["laptop-perf.jsonl", "laptop-perf.jsonl.1"]);
    for (const f of files) expect(statSync(join(root, "logs", f)).size).toBeLessThanOrEqual(256 * 1024);
    const rows = readLaptopPerf(root);
    expect(rows.length).toBeLessThanOrEqual(100);
    expect(rows.at(-1)).toMatchObject({ schema: 1, revision: b.revision, session: b.session, samples: b.samples });
    expect(readFileSync(join(root, "logs", files[0]), "utf8")).not.toContain("private");
  });
});
