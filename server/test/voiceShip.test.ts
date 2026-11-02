import { afterEach, expect, it, vi } from "vitest";
import { VoiceLogShipper } from "../../src/voiceShip";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const shipper = () => new VoiceLogShipper({ device: "laptop-perf", only: /^perf$/, max: 32, everyMs: 2000 });
it("retries offline startup without another event and preserves capture time", async () => {
  vi.useFakeTimers();
  const ship = shipper();
  const at = "2026-11-02T12:00:00.000Z";
  ship.add("perf", { durationMs: 20 }, at);
  await vi.advanceTimersByTimeAsync(6000); // No post installed yet.
  ship.post = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
  await vi.advanceTimersByTimeAsync(4000);
  expect(ship.post).toHaveBeenCalledTimes(2);
  expect(vi.mocked(ship.post).mock.calls[1][0].events[0].at).toBe(at);
  expect(ship.pending).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
it.each([false, true])("drains arrivals during an in-flight POST, including a cleared hide timer (failure=%s)", async failure => {
  vi.useFakeTimers();
  const ship = shipper();
  let finish!: () => void;
  ship.post = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve, reject) => { finish = () => failure ? reject(Error("offline")) : resolve(); })).mockResolvedValue(undefined);
  ship.add("perf", { durationMs: 1 });
  await vi.advanceTimersByTimeAsync(2000);
  ship.add("perf", { durationMs: 2 });
  await vi.advanceTimersByTimeAsync(6000);
  await ship.flush(true); // Re-entrant pagehide must not discard pending work.
  expect(ship.post).toHaveBeenCalledTimes(1);
  finish(); await vi.advanceTimersByTimeAsync(2000);
  expect(ship.post).toHaveBeenCalledTimes(2);
  const events = vi.mocked(ship.post).mock.calls[1][0].events;
  expect(events.map(e => e.durationMs)).toEqual(failure ? [1, 2] : [2]);
  expect(ship.pending).toBe(0);
});
it("bounds a failed batch plus arrivals, retries HTTP refusal and does not send per key", async () => {
  vi.useFakeTimers();
  const ship = shipper();
  let fail!: () => void;
  ship.post = vi.fn().mockImplementationOnce(() => new Promise<void>((_, reject) => { fail = () => reject(Error("429")); })).mockResolvedValue(undefined);
  for (let i = 0; i < 100; i++) ship.add("perf", { durationMs: i });
  expect(ship.post).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2000);
  expect(vi.mocked(ship.post).mock.calls[0][0].events).toHaveLength(32);
  for (let i = 100; i < 200; i++) ship.add("perf", { durationMs: i });
  fail(); await vi.advanceTimersByTimeAsync(2000);
  expect(vi.mocked(ship.post).mock.calls[1][0].events.map(e => e.durationMs)).toEqual(Array.from({ length: 32 }, (_, i) => i + 168));
  expect(ship.pending).toBe(0);
});
it("pagehide uses existing transport's keepalive flag and normal batching remains scheduled", async () => {
  vi.useFakeTimers();
  const handlers: Record<string, () => void> = {};
  vi.stubGlobal("window", { addEventListener: (name: string, f: () => void) => { handlers[name] = f; } });
  vi.stubGlobal("document", { hidden: true, addEventListener: (name: string, f: () => void) => { handlers[name] = f; } });
  const ship = shipper(); ship.installPageHide(); ship.installPageHide();
  ship.post = vi.fn().mockResolvedValue(undefined);
  ship.add("perf"); handlers.visibilitychange(); await vi.advanceTimersByTimeAsync(0);
  expect(ship.post).toHaveBeenCalledWith(expect.anything(), true);
  ship.add("perf"); await vi.advanceTimersByTimeAsync(2000);
  expect(ship.post).toHaveBeenCalledTimes(2);
});
