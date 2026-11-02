import { afterEach, beforeEach, it, expect, vi } from "vitest";
const h = vi.hoisted(() => ({ state: { currentFile: null as string | null, vaultPath: "fixture", conversationsLoaded: true, chatFullscreen: false, rightCollapsed: true, popoutOpen: false }, subscribe: null as any, posts: [] as any[], observers: {} as Record<string, Function>, link: vi.fn() }));
vi.mock("../../src/store", () => ({ useStore: { getState: () => h.state, subscribe: (f: any) => { h.subscribe = f; } } }));
vi.mock("../../src/boxChat", () => ({ boxLinkFor: h.link, boxPost: async (_link: any, path: string, body: any) => { h.posts.push({ path, body }); return { ok: true }; } }));
vi.mock("../../src/bootTiming", () => ({ afterVaultReady: () => Promise.resolve(), hasBootMark: () => true }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false, invoke: vi.fn() }));
import { validPerfBatch } from "../../src/laptopPerfProtocol";
class TestElement {
  constructor(private kind: string) {}
  closest() { return this; }
  getAttribute(name: string) { return name === "data-perf-target" ? this.kind : null; }
}
let listeners: Record<string, Function>;
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers();
  h.state = { currentFile: null as string | null, vaultPath: "fixture", conversationsLoaded: true, chatFullscreen: false, rightCollapsed: true, popoutOpen: false };
  h.posts = []; h.observers = {}; h.link.mockReset().mockResolvedValue({}); listeners = {};
  vi.stubGlobal("Element", TestElement);
  vi.stubGlobal("document", { hidden: false, addEventListener: (name: string, f: Function) => { listeners[name] = f; }, querySelector: () => ({ disabled: false, getClientRects: () => [1] }), getElementById: () => ({ firstElementChild: {} }) });
  vi.stubGlobal("window", { addEventListener: (name: string, f: Function) => { listeners[name] = f; } });
  vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => setTimeout(f, 16));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  vi.stubGlobal("PerformanceObserver", class {
    static supportedEntryTypes = ["event", "longtask"];
    constructor(private callback: Function) {}
    observe(o: any) { h.observers[o.type] = this.callback; }
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const key = (kind = "composer", timeStamp = performance.now()) => ({ isTrusted: true, target: new TestElement(kind), timeStamp, get key() { throw new Error("Probe must not read typed keys"); } });
const samples = () => h.posts.flatMap(p => p.body.samples);
it("records target-only keys, Event Timing, long tasks and transitions and sends within five seconds", async () => {
  const { installLaptopPerf, perfTarget, runtimeVersionFor } = await import("../../src/laptopPerf");
  expect(runtimeVersionFor("Windows AppleWebKit/537.36 Chrome/140.0.7339.41 Safari/537.36")).toBe("140.0.7339.41");
  expect(runtimeVersionFor("AppleWebKit/616.2.1")).toBe("616.2.1");
  installLaptopPerf(); installLaptopPerf();
  expect(perfTarget(new TestElement("other") as any)).toBeNull();
  const began = performance.now();
  listeners.keydown(key("composer", began)); listeners.keydown({ isTrusted: false });
  h.observers.event({ getEntries: () => [{ name: "keydown", target: new TestElement("composer"), duration: 24, startTime: began }, { name: "keydown", target: new TestElement("ctrl-k"), duration: 32, startTime: began }, { name: "keydown", target: null, duration: 40 }] });
  h.observers.longtask({ getEntries: () => [{ startTime: began, duration: 52 }, { startTime: began + 10, duration: 60 }] });
  const old = { ...h.state }; h.state.chatFullscreen = true; h.state.rightCollapsed = false; h.subscribe(h.state, old);
  await vi.advanceTimersByTimeAsync(4500);
  expect(h.posts).toHaveLength(1);
  expect(h.posts[0].path).toBe("/api/v1/laptop-perf");
  expect(validPerfBatch(h.posts[0].body)).toBe(true);
  expect(h.posts[0].body).toMatchObject({ surface: "browser", window: "main", eventTiming: true });
  expect(samples()).toEqual(expect.arrayContaining([
    expect.objectContaining({ metric: "composer-key", method: "double-raf-estimate", at: new Date(performance.timeOrigin + began).toISOString() }),
    expect.objectContaining({ metric: "composer-key", method: "event-timing", durationMs: 24 }),
    expect.objectContaining({ metric: "ctrl-k-key", method: "event-timing", durationMs: 32 }),
    expect.objectContaining({ metric: "fullscreen-transition", method: "double-raf-estimate", startPoint: "state-change" }),
    expect.objectContaining({ metric: "chat-panel-open" }),
    expect.objectContaining({ metric: "launch-interactive", method: "navigation-ready-estimate" }),
    expect.objectContaining({ metric: "main-thread-long-task", durationMs: 52 }),
  ]));
  expect(samples().filter(s => s.metric === "main-thread-long-task")).toHaveLength(1);
  expect(JSON.stringify(h.posts)).not.toContain("fixture");
});
it("hidden or stalled webviews still report explicitly labelled rAF timeouts dated at the original event", async () => {
  const { installLaptopPerf } = await import("../../src/laptopPerf");
  vi.stubGlobal("requestAnimationFrame", () => 1); Object.assign(document, { hidden: true });
  installLaptopPerf({ popout: true });
  const began = performance.now();
  listeners.keydown(key("ctrl-k", performance.timeOrigin + began));
  await vi.advanceTimersByTimeAsync(5000);
  expect(samples()).toContainEqual(expect.objectContaining({ metric: "ctrl-k-key", method: "raf-timeout-observation", visibility: "hidden", at: new Date(performance.timeOrigin + began).toISOString() }));
  expect(samples().some(s => s.metric === "launch-interactive")).toBe(false);
  expect(h.posts[0].body.window).toBe("popout");
});
it("retries startup config discovery without another key and bounds a hung lookup to five seconds", async () => {
  const { installLaptopPerf } = await import("../../src/laptopPerf");
  let finish!: (link: unknown) => void;
  h.link.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(null);
  installLaptopPerf({ popout: true }); listeners.keydown(key());
  await vi.advanceTimersByTimeAsync(11000);
  expect(h.posts).toHaveLength(0);
  expect(h.link).toHaveBeenCalledTimes(1);
  finish({});
  h.link.mockResolvedValue({});
  await vi.advanceTimersByTimeAsync(5000);
  expect(samples()).toContainEqual(expect.objectContaining({ metric: "composer-key" }));
});
it("a slow shortcut dispatch preserves the event start and a remounted root can settle next frame", async () => {
  const { installLaptopPerf } = await import("../../src/laptopPerf");
  installLaptopPerf({ popout: false });
  const began = performance.now() - 2000;
  listeners.keydown({ isTrusted: true, target: new TestElement("other"), ctrlKey: true, shiftKey: true, altKey: false, key: "f", timeStamp: began });
  const old = { ...h.state }; h.state.chatFullscreen = true;
  const query = vi.spyOn(document, "querySelector").mockReturnValueOnce(null);
  h.subscribe(h.state, old);
  await vi.advanceTimersByTimeAsync(4000);
  expect(samples()).toContainEqual(expect.objectContaining({ metric: "fullscreen-transition", startPoint: "event", at: new Date(performance.timeOrigin + began).toISOString() }));
  query.mockRestore();
});

it("marks file-open after the viewer action, correlates subsequent keys/tasks for one minute, and sends no paths", async () => {
  const { installLaptopPerf } = await import("../../src/laptopPerf");
  installLaptopPerf();
  const old = { ...h.state }; h.state.currentFile = "/private/never-ship.md";
  h.subscribe(h.state, old);
  const opened = performance.now();
  await vi.advanceTimersByTimeAsync(100);
  listeners.keydown(key());
  h.observers.longtask({ getEntries: () => [{ startTime: opened + 10, duration: 80 }] });
  await vi.advanceTimersByTimeAsync(4000);
  expect(samples()).toContainEqual(expect.objectContaining({ metric: "file-open", startPoint: "state-change", fileOpenAgeMs: 0 }));
  expect(samples()).toContainEqual(expect.objectContaining({ metric: "composer-key", fileOpenAgeMs: 100 }));
  expect(samples()).toContainEqual(expect.objectContaining({ metric: "main-thread-long-task", fileOpenAgeMs: 10 }));
  expect(JSON.stringify(h.posts)).not.toContain("never-ship");
  await vi.advanceTimersByTimeAsync(60000); listeners.keydown(key()); await vi.advanceTimersByTimeAsync(4000);
  expect(samples().at(-1).fileOpenAgeMs).toBeUndefined();
});
