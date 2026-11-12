// The supervisor (base spec change 1.6; src/pluginSupervisor.ts): desired state is records, a reconciler makes each host
// match them, and what a plugin did to a host is undone in reverse order when it stops. Disable takes a plugin down in
// every kind of view (an in-process mount, an iframe with the live bridge, its own link) and leaves no listener behind;
// enable mounts it again. End dates and budgets are records too: nothing here holds policy of its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { Effects, offLine, pluginIdOf, Reconciler, Supervisor, desiredSignal, budgetSignal, type Desired } from "../../src/pluginSupervisor.ts";
import { mountPlugin, type LoadModule } from "../../src/mountHost.ts";

let seq = 0;
const word = (plugin: string, state: "running" | "stopped", extra: Record<string, unknown> = {}, at = 1000) => ({ seq: ++seq, at, type: "signal", signal: { type: "plugin.desired", plugin, state, at, ...extra } });
const budget = (plugin: string, callsPerMinute: number | null) => ({ seq: ++seq, at: 1000, type: "signal", signal: { type: "plugin.budget", plugin, callsPerMinute, at: 1000 } });

/** A clock the test moves. */
function fakeClock(start = 10_000) {
  let now = start;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let id = 0;
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => (timers.set(++id, { at: now + ms, fn }), id),
    clearTimeout: (t: unknown) => void timers.delete(t as number),
    pending: () => timers.size,
    advance(ms: number) {
      now += ms;
      for (const [k, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) if (t.at <= now && timers.delete(k)) t.fn();
    },
  };
}

test("no record: running; disable and enable are records, the newest in effect wins; other records are ignored", () => {
  const s = new Supervisor();
  assert.deepEqual(s.desired("v/lab.html", 0), { state: "running", by: null, reason: null, seq: 0, next: null });
  assert.equal(s.fold({ seq: 1, type: "signal", signal: { type: "file_changed", path: "x" } }), false);
  assert.equal(s.fold({ seq: 2, type: "entry" }), false);
  const off = word("v/lab.html", "stopped", { by: "carl", reason: "not now" });
  assert.equal(s.fold(off), true);
  assert.equal(s.fold(off), false, "a record seen twice (the snapshot and the feed) folds once");
  assert.deepEqual(s.desired("v/lab.html", 5000), { state: "stopped", by: "carl", reason: "not now", seq: off.seq, next: null });
  assert.equal(s.desired(".\\v\\lab.html", 5000).state, "stopped", "one id however a host spells the path");
  assert.equal(s.desired("v/other.html", 5000).state, "running", "only that plugin");
  s.fold(word("v/lab.html", "running", { by: "agent" }));
  assert.equal(s.desired("v/lab.html", 5000).state, "running");
  assert.deepEqual(s.plugins(), ["v/lab.html"]);
  assert.deepEqual(s.records().map((r) => r.seq), [off.seq, seq], "the raw records, for a host to fold the same way");
});

test("an end date is a word for later: it waits for its time; 'enable' written after it cancels it; an end date written after 'enable' still comes", () => {
  const s = new Supervisor();
  s.fold(word("p.html", "stopped", { from: 50_000 }));
  assert.deepEqual(s.desired("p.html", 10_000), { state: "running", by: null, reason: null, seq: 0, next: 50_000 });
  assert.equal(s.desired("p.html", 50_000).state, "stopped");
  s.fold(word("p.html", "running"));
  assert.equal(s.desired("p.html", 60_000).state, "running", "enable after the end date was set: the end date is cancelled");
  assert.equal(s.desired("p.html", 10_000).next, null);
  const s2 = new Supervisor();
  s2.fold(word("q.html", "running"));
  s2.fold(word("q.html", "stopped", { from: 50_000, reason: "end date" }));
  assert.equal(s2.desired("q.html", 49_999).state, "running");
  assert.deepEqual(s2.desired("q.html", 50_000), { state: "stopped", by: null, reason: "end date", seq, next: null });
});

test("a budget is a record (null removes it); the words a request may write are checked", () => {
  const s = new Supervisor();
  s.fold(budget("p.html", 30));
  assert.equal(s.budget("p.html"), 30);
  s.fold(budget("p.html", null));
  assert.equal(s.budget("p.html"), null);
  assert.deepEqual(desiredSignal({ plugin: "./a/b.html", state: "stopped", reason: " r " }, "carl", 5), { type: "plugin.desired", plugin: "a/b.html", state: "stopped", at: 5, by: "carl", reason: "r" });
  assert.deepEqual(desiredSignal({ plugin: "a.html", state: "stopped", from: 3 }, "carl", 5), { type: "plugin.desired", plugin: "a.html", state: "stopped", at: 5, by: "carl" }, "a time already past is now");
  assert.equal((desiredSignal({ plugin: "a.html", state: "stopped", from: "2030-01-01T00:00Z" }, "agent", 5) as { from: number }).from, Date.parse("2030-01-01T00:00Z"));
  for (const bad of [{ state: "stopped" }, { plugin: "a.html", state: "off" }, { plugin: "../a.html", state: "stopped" }, { plugin: "a.html", state: "stopped", from: "soon" }]) assert.ok("error" in desiredSignal(bad, "carl", 5), JSON.stringify(bad));
  assert.ok("error" in budgetSignal({ plugin: "a.html", callsPerMinute: 0 }, "carl", 5));
  assert.ok("error" in budgetSignal({ plugin: "a.html", callsPerMinute: 1.5 }, "carl", 5));
  assert.equal(offLine("v/html-lab.html", { by: "carl", reason: null }), "html-lab.html is turned off");
  assert.equal(offLine("v/html-lab.html", { by: "budget", reason: null }), "html-lab.html is turned off: over its budget");
  assert.equal(pluginIdOf("C:\\x\\..\\y"), "C:/x/../y");
});

test("the reconciler tells a host only when what it should be changes, at a record or when a word's time comes; let go, it holds no timer", () => {
  const clock = fakeClock();
  const s = new Supervisor();
  const r = new Reconciler(s, clock);
  const seen: Desired["state"][] = [];
  const unwatch = r.watch("p.html", (d) => seen.push(d.state));
  s.fold(word("p.html", "running"));
  r.changed();
  assert.deepEqual(seen, [], "running → running is no change");
  s.fold(word("p.html", "stopped"));
  r.changed();
  s.fold(word("p.html", "running"));
  r.changed();
  assert.deepEqual(seen, ["stopped", "running"]);
  s.fold(word("p.html", "stopped", { from: clock.now() + 5_000 }));
  r.changed();
  assert.equal(clock.pending(), 1, "one timer, for the end date");
  clock.advance(4_000);
  assert.deepEqual(seen, ["stopped", "running"]);
  clock.advance(1_100);
  assert.deepEqual(seen, ["stopped", "running", "stopped"], "the end date came: the host was told");
  s.fold(word("p.html", "stopped", { from: clock.now() + 9_000 }));
  r.changed();
  unwatch();
  assert.equal(r.watching, 0);
  assert.equal(clock.pending(), 0, "no plugin watched: no timer left");
});

test("effects are undone newest first, every one even when one throws; listeners and timers through it leave nothing", async () => {
  const fx = new Effects();
  const order: string[] = [];
  fx.add("a", () => order.push("a"));
  fx.add("b", () => {
    order.push("b");
    throw new Error("undo broke");
  });
  const undoC = fx.add("c", () => order.push("c"));
  fx.add("d", () => order.push("d"));
  undoC();
  assert.deepEqual(order, ["c"]);
  fx.revert();
  assert.deepEqual(order, ["c", "d", "b", "a"]);
  assert.deepEqual(fx.live, []);
  const { window } = parseHTML("<html><body></body></html>");
  let ticks = 0;
  const fx2 = new Effects();
  fx2.listen(window as any, "keydown", () => ticks++);
  fx2.timer(() => ticks++, 5, true);
  assert.deepEqual(fx2.live, ["listener keydown", "interval"]);
  fx2.revert();
  window.dispatchEvent(new (window as any).Event("keydown"));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ticks, 0);
});

/** A window that counts its listeners, and a document to mount into (as the in-process host's own tests). */
function world() {
  const { window, document } = parseHTML("<!doctype html><html><head></head><body><div id=host></div><div id=app>the app</div></body></html>");
  const listeners: Record<string, Set<unknown>> = {};
  const win = {
    DOMParser: (window as any).DOMParser,
    addEventListener: (k: string, f: unknown) => (listeners[k] ??= new Set()).add(f),
    removeEventListener: (k: string, f: unknown) => void listeners[k]?.delete(f),
  };
  const count = () => Object.values(listeners).reduce((n, s) => n + s.size, 0);
  return { document, win, listeners, count, host: document.getElementById("host") as any as HTMLElement };
}
const dataLoad: LoadModule = async (code) => {
  const url = "data:text/javascript;base64," + Buffer.from(code).toString("base64");
  return { module: await import(url), url, dispose() {} };
};
const THEME = { mode: "dark" as const, vars: {} };
const page = (mod: string) => `<!doctype html><html><head><meta name="vc-mount" content="in-process"><title>Lab</title></head><body><div class="n">0</div><script type="module">${mod}</script></body></html>`;

test("in-process: disable unmounts the plugin and reverts every effect it made through the host (no listener, no timer); enable mounts it afresh", async () => {
  const { host, win, count, listeners, document } = world();
  const clock = fakeClock();
  const s = new Supervisor();
  const r = new Reconciler(s, clock);
  const mod = `export function mount(el, api) {
    globalThis.__sv = (globalThis.__sv ?? 0) + 1;
    api.listen(api.win, "keydown", () => { el.querySelector(".n").textContent = "key"; });
    api.timer(() => { globalThis.__svTicks = (globalThis.__svTicks ?? 0) + 1; }, 5, true);
    api.effect(() => { globalThis.__svOrder = [...(globalThis.__svOrder ?? []), "effect"]; });
    return () => { globalThis.__svOrder = [...(globalThis.__svOrder ?? []), "cleanup"]; };
  }`;
  // The view: mounted while running, taken down when stopped (as src/PluginMount.tsx under usePluginDesired).
  const baseline = count();
  let h: ReturnType<typeof mountPlugin> | null = null;
  const show = () => {
    if (r.desired("v/lab.html").state === "running") h ??= mountPlugin(host, page(mod.replace("api.win", "globalThis.__svWin")), { path: "v/lab.html", theme: () => THEME, win: win as any, load: dataLoad });
    else if (h) {
      h.unmount();
      h = null;
    }
  };
  (globalThis as any).__svWin = win;
  r.watch("v/lab.html", show);
  show();
  await h!.ready;
  assert.equal(h!.error, null);
  assert.equal((globalThis as any).__sv, 1);
  assert.ok(listeners.keydown?.size === 1, "its own listener, through the api");
  assert.deepEqual(h!.effects, ["module", "markup", "listener error", "listener unhandledrejection", "listener keydown", "interval", "effect", "cleanup"]);
  assert.ok(count() > baseline);
  await new Promise((res) => setTimeout(res, 20));
  assert.ok((globalThis as any).__svTicks > 0);

  // Disable: a record. The reconciler takes it down.
  s.fold(word("v/lab.html", "stopped", { by: "carl" }));
  r.changed();
  assert.equal(h, null);
  assert.equal(count(), baseline, "no listener left behind");
  assert.deepEqual((globalThis as any).__svOrder, ["cleanup", "effect"], "undone newest first");
  const ticks = (globalThis as any).__svTicks;
  await new Promise((res) => setTimeout(res, 25));
  assert.equal((globalThis as any).__svTicks, ticks, "its timer is gone");
  assert.equal(host.shadowRoot!.innerHTML, "", "nothing of it on screen");
  assert.equal(document.getElementById("app")!.textContent, "the app");

  // Enable: a record. It mounts again, fresh.
  s.fold(word("v/lab.html", "running", { by: "carl" }));
  r.changed();
  await h!.ready;
  assert.equal((globalThis as any).__sv, 2);
  assert.equal(listeners.keydown?.size, 1);
  (h as any).unmount();
  assert.equal(count(), baseline);
});

test("iframe: when its plugin stops, the live bridge lets go of what it held for the plugin's frames (observer, recording)", async () => {
  const { installLiveBridge, PLUGIN_STOPPED_EVENT, LIVE_ATTR } = await import("../../src/liveBridge.ts");
  const { window, document } = parseHTML(`<!doctype html><html><body><iframe ${"data-vc-live"}="v/lab.html"></iframe><iframe data-vc-live="v/other.html"></iframe></body></html>`);
  const frames = Array.from(document.querySelectorAll("iframe")) as any[];
  // A frame's window, as a sandboxed page's would be (the bridge knows a frame by its contentWindow).
  for (const f of frames) Object.defineProperty(f, "contentWindow", { value: { postMessage() {} } });
  const observers: { target: unknown; off: boolean }[] = [];
  (globalThis as any).ResizeObserver = class {
    o = { target: null as unknown, off: false };
    constructor() { observers.push(this.o); }
    observe(t: unknown) { this.o.target = t; }
    disconnect() { this.o.off = true; }
  };
  (window as any).MutationObserver ??= class { observe() {} disconnect() {} };
  (window as any).getComputedStyle ??= () => ({ getPropertyValue: () => "" });
  const host = { post: async (path: string) => ({ status: 200, json: path.endsWith("manifest") ? { caps: [], refused: ["x"], hash: "h" } : {} }) };
  const uninstall = installLiveBridge(host as any, document as any);
  for (const f of frames) {
    window.dispatchEvent(Object.assign(new (window as any).Event("message"), { data: { "vc-live": 1, op: "hello" }, origin: "null", source: f.contentWindow }));
  }
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(observers.length, 2, "one observer per frame while it is shown");
  window.dispatchEvent(new (window as any).CustomEvent(PLUGIN_STOPPED_EVENT, { detail: { plugin: "v/lab.html" } }));
  assert.equal(observers.find((o) => (o.target as any)?.getAttribute(LIVE_ATTR) === "v/lab.html")!.off, true, "the stopped plugin's frame: let go");
  assert.equal(observers.find((o) => (o.target as any)?.getAttribute(LIVE_ATTR) === "v/other.html")!.off, false, "another plugin's: untouched");
  uninstall();
  delete (globalThis as any).ResizeObserver;
});

test("its own link: the host takes the page's frame down when the plugin stops and puts it back when it runs; served stopped, it starts off", async () => {
  for (const servedStopped of [false, true]) {
    const frameHtml = `<iframe sandbox="allow-scripts" title="Lab" data-vc-live="v/lab.html" srcdoc="&lt;p&gt;lab&lt;/p&gt;"></iframe>`;
    const { window, document } = parseHTML(`<!doctype html><html data-theme="dark"><head></head><body>${servedStopped ? `<template data-vc-page>${frameHtml}</template>` : frameHtml}</body></html>`);
    // The box: the first GET answers what is there, each next one waits for the test's record.
    const queue: { seq: number; records: unknown[] }[] = [{ seq: 0, records: servedStopped ? [word("v/lab.html", "stopped", { by: "carl" })] : [] }];
    let wake: (() => void) | null = null;
    const posts: unknown[] = [];
    const fetchFake = async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === "POST") {
        posts.push(JSON.parse(init.body ?? "{}"));
        return { status: 200, json: async () => ({ ok: true }) };
      }
      assert.match(url, /^\/api\/v2\/supervisor/);
      while (!queue.length) await new Promise<void>((r) => (wake = r));
      return { status: 200, json: async () => queue.shift()! };
    };
    const push = (records: unknown[]) => {
      queue.push({ seq: ++seq, records });
      wake?.();
      return new Promise((r) => setTimeout(r, 20));
    };
    const stopped: unknown[] = [];
    window.addEventListener("vc-plugin-stopped", (e: any) => stopped.push(e.detail.plugin));
    (window as any).MutationObserver ??= class { observe() {} disconnect() {} };
    Object.assign(globalThis, { document, window, fetch: fetchFake, CustomEvent: (window as any).CustomEvent });
    await import(`../../src/pageLinkHost.ts?link=${servedStopped}`);
    await new Promise((r) => setTimeout(r, 20));
    const live = () => document.querySelector("body > iframe[data-vc-live]");
    const off = () => document.querySelector('[data-el="plugin-off"]');
    if (servedStopped) {
      assert.equal(live(), null, "served stopped: the page does not run");
      assert.match(off()!.textContent ?? "", /lab\.html is turned off/);
      (off()!.querySelector('[data-el="plugin-turn-on"]') as any).click();
      assert.deepEqual(posts, [{ plugin: "v/lab.html", state: "running" }], "Turn on is Carl's word: a record");
      await push([word("v/lab.html", "running", { by: "carl" })]);
      assert.ok(live(), "running: the frame is back");
      assert.match(live()!.getAttribute("srcdoc")!, /lab/);
      assert.equal(off(), null);
    } else {
      assert.ok(live());
      await push([word("v/lab.html", "stopped", { by: "agent" })]);
      assert.equal(live(), null, "stopped: the frame is gone");
      assert.deepEqual(stopped, ["v/lab.html"], "and the bridge was told to let go of it");
      assert.ok(off());
      await push([word("v/lab.html", "running", { by: "agent" })]);
      assert.ok(live());
      assert.equal(off(), null);
    }
  }
  delete (globalThis as any).document;
  delete (globalThis as any).window;
});
