import { invoke, isTauri } from "@tauri-apps/api/core";
import { afterVaultReady, hasBootMark } from "./bootTiming";
import { boxLinkFor, boxPost } from "./boxChat";
import { hit } from "./shortcuts";
import { useStore } from "./store";
import { VoiceLogShipper } from "./voiceShip";
import type { PerfBatch, PerfSample } from "./laptopPerfProtocol";

declare const __APP_REVISION__: string;
declare const __APP_VERSION__: string;
let installed = false;

export function perfTarget(target: EventTarget | null): "composer-key" | "ctrl-k-key" | null {
  if (!(target instanceof Element)) return null;
  const kind = target.closest("[data-perf-target]")?.getAttribute("data-perf-target");
  return kind === "composer" ? "composer-key" : kind === "ctrl-k" ? "ctrl-k-key" : null;
}

/** Observational only: no React state, input values, key values, paths or conversation IDs. */
export function installLaptopPerf({ popout = false }: { popout?: boolean } = {}): void {
  if (installed) return;
  installed = true;
  const native = isTauri();
  const ua = navigator.userAgent;
  const runtime: PerfBatch["runtime"] = !native ? "browser" : /Windows/.test(ua) ? "webview2" : /Linux/.test(ua) ? "webkitgtk" : /Macintosh/.test(ua) ? "wkwebview" : "unknown";
  const runtimeVersion = runtimeVersionFor(ua);
  // Observed positive clock step only, not a claim about physical resolution. May be unobservable.
  let previous = performance.now();
  let quantum = Infinity;
  for (let i = 0; i < 32; i++) {
    const now = performance.now();
    if (now > previous) quantum = Math.min(quantum, now - previous);
    previous = now;
  }
  const ship = new VoiceLogShipper({ device: "laptop-perf", only: /^perf$/, max: 32, everyMs: popout ? 3500 : 2000 });
  let eventTiming = false;
  let linkLookup: ReturnType<typeof boxLinkFor> | null = null;
  ship.post = async body => {
    // Native POST already has a 20 s whole-response deadline (box_sync::post_json).
    // Bound config lookup too: a sample cannot wait forever for startup vault discovery.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const link = await Promise.race([
      // Reuse a still-pending native lookup instead of accumulating IPC on a stuck startup.
      linkLookup ??= boxLinkFor(useStore.getState().vaultPath).finally(() => { linkLookup = null; }),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 5000); }),
    ]).finally(() => clearTimeout(timer));
    if (!link) throw new Error("no box");
    const batch: PerfBatch = {
      schema: 1, window: popout ? "popout" : "main", version: typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "unknown",
      revision: typeof __APP_REVISION__ === "string" ? __APP_REVISION__ : "unknown", session: ship.session,
      surface: native ? import.meta.env.PROD ? "tauri-production" : "tauri-development" : "browser",
      runtime, runtimeVersion, eventTiming, clockQuantumMs: Number.isFinite(quantum) ? quantum : null,
      startupTemperature: "unknown",
      samples: body.events.map(e => ({ at: e.at, metric: e.metric, method: e.method, durationMs: e.durationMs, startPoint: e.startPoint, visibility: e.visibility })) as PerfSample[],
    };
    const r = await boxPost(link, "/api/v1/laptop-perf", batch);
    if (!r.ok) throw new Error("performance batch not sent");
  };
  // Native IPC uses the paired Rust HTTP client, not a renderer fetch to cancel on pagehide.
  ship.installPageHide();
  const add = (metric: PerfSample["metric"], method: PerfSample["method"], durationMs: number, startPoint: PerfSample["startPoint"], began = performance.now(), visibility = document.hidden ? "hidden" : "visible") => {
    // Date the observation at its native event/task clock, not after a blocked renderer resumes.
    if (Number.isFinite(durationMs) && durationMs >= 0 && durationMs <= 600_000 && Number.isFinite(began)) ship.add("perf", { metric, method, durationMs, startPoint, visibility }, new Date(performance.timeOrigin + began).toISOString());
  };
  // Bounded, content-free evidence of main-thread blocking; not a count of ALL long tasks.
  // At most one task per second avoids flooding the 32-sample delivery queue.
  try {
    if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
      let lastTask = -Infinity;
      new PerformanceObserver(list => {
        for (const e of list.getEntries()) {
          if (e.startTime - lastTask < 1000) continue;
          lastTask = e.startTime;
          add("main-thread-long-task", "long-task", e.duration, "task", e.startTime);
        }
      }).observe({ type: "longtask", buffered: true });
    }
  } catch { /* Unsupported runtimes provide no long-task data, never zero. */ }
  // Event Timing durations are browser event-to-next-presentation measurements (8 ms quantized).
  // The API omits fast events below its minimum 16 ms threshold; do not infer zero latency from absence.
  try {
    if (PerformanceObserver.supportedEntryTypes.includes("event")) {
      const observer = new PerformanceObserver(list => {
        for (const e of list.getEntries()) {
          const entry = e as PerformanceEntry & { target: EventTarget | null };
          if (entry.name !== "keydown") continue;
          const metric = perfTarget(entry.target);
          if (metric) add(metric, "event-timing", entry.duration, "event", entry.startTime);
        }
      });
      observer.observe({ type: "event", buffered: false, durationThreshold: 16 } as PerformanceObserverInit);
      eventTiming = true;
    }
  } catch { /* WebKit lacks Event Timing: only explicitly labelled estimates below. */ }
  // Two rAF callbacks straddle a rendering opportunity, not a physical/compositor paint guarantee.
  let pending = 0;
  const estimate = (metric: PerfSample["metric"], began: number, stillRelevant = () => true, startPoint: PerfSample["startPoint"] = "event") => {
    if (pending >= 16) return;
    pending++;
    const visibility = document.hidden ? "hidden" : "visible";
    let done = false;
    let frame = 0;
    const finish = (method: "double-raf-estimate" | "raf-timeout-observation") => {
      if (done) return;
      done = true;
      pending--;
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      add(metric, method, performance.now() - began, startPoint, began, visibility);
    };
    // A hidden/throttled webview must still report. Elapsed time at the 1 s fallback includes intentional waiting; NOT input latency or paint.
    const timer = setTimeout(() => finish("raf-timeout-observation"), 1000);
    frame = requestAnimationFrame(() => {
      const afterFrame = () => {
        if (done) return;
        if (stillRelevant()) finish("double-raf-estimate");
        else frame = requestAnimationFrame(afterFrame);
      };
      frame = requestAnimationFrame(afterFrame);
    });
  };
  let fullscreenKeyAt = -Infinity;
  let panelKeyAt = -Infinity;
  window.addEventListener("keydown", e => {
    if (!e.isTrusted) return;
    const eventAt = e.timeStamp >= performance.timeOrigin ? e.timeStamp - performance.timeOrigin : e.timeStamp;
    if (!e.repeat && (e.ctrlKey || e.metaKey)) {
      if (hit(e, "view.fullscreen")) fullscreenKeyAt = eventAt;
      if (hit(e, "view.chat")) panelKeyAt = eventAt;
      // Store shortcut actions run in this dispatch; do not reuse an old unrelated key.
      queueMicrotask(() => { fullscreenKeyAt = panelKeyAt = -Infinity; });
    }
    const metric = perfTarget(e.target);
    if (metric) {
      // Normalize old epoch-based WebKit timestamps without retaining the event or its key.
      estimate(metric, eventAt);
    }
  }, true);
  // Existing store transitions cover shortcuts AND mouse opening. No extra UI/controller.
  useStore.subscribe((state, old) => {
    if (!popout && state.chatFullscreen !== old.chatFullscreen) {
      const expected = state.chatFullscreen;
      const fromKey = Number.isFinite(fullscreenKeyAt);
      estimate("fullscreen-transition", fromKey ? fullscreenKeyAt : performance.now(), () => useStore.getState().chatFullscreen === expected && !!document.querySelector('[data-perf-view="fullscreen"]') === expected, fromKey ? "event" : "state-change");
      fullscreenKeyAt = -Infinity;
    }
    maybeLaunch();
    if (!popout && old.rightCollapsed && !state.rightCollapsed && !state.popoutOpen) {
      const fromKey = Number.isFinite(panelKeyAt);
      estimate("chat-panel-open", fromKey ? panelKeyAt : performance.now(), () => !useStore.getState().rightCollapsed && !useStore.getState().popoutOpen && !!document.querySelector('[data-perf-target="composer"]')?.getClientRects().length, fromKey ? "event" : "state-change");
      panelKeyAt = -Infinity;
    }
  });
  // Reuse the actual tree+chats readiness marks, not an arbitrary React mount or timeout.
  let launchScheduled = false;
  function maybeLaunch() {
    const state = useStore.getState();
    if (popout || launchScheduled || !hasBootMark("vault ready") || !state.conversationsLoaded || !state.vaultPath || document.hidden) return;
    launchScheduled = true;
    requestAnimationFrame(() => requestAnimationFrame(async () => {
      const composer = document.querySelector<HTMLTextAreaElement>('[data-perf-target="composer"]');
      const root = document.getElementById("root");
      if (document.hidden || !root?.firstElementChild || (composer && composer.disabled)) { launchScheduled = false; return; }
      if (native) {
        try {
          // Existing Rust Instant begins at run() entry. Includes command dispatch/IPC until native read.
          const timing = await invoke<{ uptime_ms: number }>("boot_timing");
          add("launch-interactive", "native-entry-ready-ipc-upper-bound", timing.uptime_ms, "native-entry");
        } catch { /* Never relabel renderer age as native launch. */ }
      } else add("launch-interactive", "navigation-ready-estimate", performance.now(), "navigation");
    }));
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) maybeLaunch(); });
  void afterVaultReady(90_000).then(maybeLaunch);
}

/** Chromium UAs put AppleWebKit first; never mislabel its compatibility token as WebView2. */
export function runtimeVersionFor(ua: string): string {
  return /(?:Chrome|Chromium)\/([\d.]+)/.exec(ua)?.[1] ?? /AppleWebKit\/([\d.]+)/.exec(ua)?.[1] ?? "unknown";
}
