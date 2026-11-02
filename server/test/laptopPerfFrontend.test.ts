import { it, expect, vi } from "vitest";
const h = vi.hoisted(() => ({ state: { vaultPath: "fixture", conversationsLoaded: true, chatFullscreen: false, rightCollapsed: true, popoutOpen: false }, subscribe: null as any, posted: null as any, observer: null as any }));
vi.mock("../../src/store", () => ({ useStore: { getState: () => h.state, subscribe: (f: any) => { h.subscribe = f; } } }));
vi.mock("../../src/boxChat", () => ({ boxLinkFor: async () => ({}), boxPost: async (_link: any, path: string, body: any) => { h.posted = { path, body }; return { ok: true }; } }));
vi.mock("../../src/bootTiming", () => ({ afterVaultReady: () => Promise.resolve(), hasBootMark: () => true }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false, invoke: vi.fn() }));
import { installLaptopPerf, perfTarget } from "../../src/laptopPerf";
import { validPerfBatch } from "../../src/laptopPerfProtocol";

it("observes target-only keys, Event Timing and state transitions; bounded batching uses the existing box transport", async () => {
  vi.useFakeTimers();
  class TestElement {
    constructor(private kind: string) {}
    getAttribute(name: string) { return name === "data-perf-target" ? this.kind : null; }
  }
  const listeners: Record<string, Function> = {};
  vi.stubGlobal("Element", TestElement);
  vi.stubGlobal("document", { hidden: false, addEventListener: (name: string, f: Function) => { listeners[name] = f; }, querySelector: () => ({ disabled: false, getClientRects: () => [1] }), getElementById: () => ({ firstElementChild: {} }) });
  vi.stubGlobal("window", { addEventListener: vi.fn() });
  vi.stubGlobal("requestAnimationFrame", (f: Function) => setTimeout(f, 16));
  vi.stubGlobal("PerformanceObserver", class {
    static supportedEntryTypes = ["event"];
    constructor(callback: Function) { h.observer = callback; }
    observe(o: any) { expect(o).toEqual({ type: "event", buffered: false, durationThreshold: 16 }); }
  });
  installLaptopPerf();
  installLaptopPerf();
  expect(perfTarget(new TestElement("other") as any)).toBeNull();
  const target = new TestElement("composer");
  const key = { isTrusted: true, target, timeStamp: performance.now(), get key() { throw new Error("Probe must not read typed keys"); } };
  // No shortcut modifiers: hit() short circuits without reading the typed key.
  listeners.keydown(key);
  listeners.keydown({ isTrusted: false });
  h.observer({ getEntries: () => [{ name: "keydown", target, duration: 24 }, { name: "keydown", target: new TestElement("ctrl-k"), duration: 32 }, { name: "keydown", target: null, duration: 40 }] });
  const old = { ...h.state };
  h.state.chatFullscreen = true;
  h.state.rightCollapsed = false;
  h.subscribe(h.state, old);
  await vi.advanceTimersByTimeAsync(15050);
  expect(h.posted.path).toBe("/api/v1/laptop-perf");
  expect(validPerfBatch(h.posted.body)).toBe(true);
  expect(h.posted.body.surface).toBe("browser");
  const samples = h.posted.body.samples;
  expect(samples).toEqual(expect.arrayContaining([
    expect.objectContaining({ metric: "composer-key", method: "event-timing", durationMs: 24 }),
    expect.objectContaining({ metric: "ctrl-k-key", method: "event-timing", durationMs: 32 }),
    expect.objectContaining({ metric: "fullscreen-transition", method: "double-raf-estimate", startPoint: "state-change" }),
    expect.objectContaining({ metric: "chat-panel-open" }),
    expect.objectContaining({ metric: "launch-interactive", method: "navigation-ready-estimate" }),
  ]));
  expect(JSON.stringify(h.posted.body)).not.toContain("fixture");
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
