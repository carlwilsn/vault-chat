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
  const kind = target.getAttribute("data-perf-target");
  return kind === "composer" ? "composer-key" : kind === "ctrl-k" ? "ctrl-k-key" : null;
}

/** Observational only: no React state, input values, key values, paths or conversation IDs. */
export function installLaptopPerf(): void {
  if (installed) return;
  installed = true;
  const native = isTauri();
  const ua = navigator.userAgent;
  const runtime: PerfBatch["runtime"] = !native ? "browser" : /Windows/.test(ua) ? "webview2" : /Linux/.test(ua) ? "webkitgtk" : /Macintosh/.test(ua) ? "wkwebview" : "unknown";
  const runtimeVersion = /(?:Chrome|AppleWebKit)\/([\d.]+)/.exec(ua)?.[1] ?? "unknown";
  // Observed positive clock step only, not a claim about physical resolution. May be unobservable.
  let previous = performance.now();
  let quantum = Infinity;
  for (let i = 0; i < 32; i++) {
    const now = performance.now();
    if (now > previous) quantum = Math.min(quantum, now - previous);
    previous = now;
  }
  const ship = new VoiceLogShipper({ device: "laptop-perf", only: /^perf$/, max: 32 });
  let eventTiming = false;
  ship.post = async body => {
    const link = await boxLinkFor(useStore.getState().vaultPath);
    if (!link) throw new Error("no box");
    const batch: PerfBatch = {
      schema: 1, version: typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "unknown",
      revision: typeof __APP_REVISION__ === "string" ? __APP_REVISION__ : "unknown", session: ship.session,
      surface: native ? import.meta.env.PROD ? "tauri-production" : "tauri-development" : "browser",
      runtime, runtimeVersion, eventTiming, clockQuantumMs: Number.isFinite(quantum) ? quantum : null,
      startupTemperature: "unknown",
      samples: body.events.map(e => ({ at: e.at, metric: e.metric, method: e.method, durationMs: e.durationMs, startPoint: e.startPoint })) as PerfSample[],
    };
    const r = await boxPost(link, "/api/v1/laptop-perf", batch);
    if (!r.ok) throw new Error("performance batch not sent");
  };
  ship.installPageHide();
  const add = (metric: PerfSample["metric"], method: PerfSample["method"], durationMs: number, startPoint: PerfSample["startPoint"]) => {
    if (Number.isFinite(durationMs) && durationMs >= 0 && durationMs <= 600_000) ship.add("perf", { metric, method, durationMs, startPoint });
  };
  // Event Timing durations are browser event-to-next-presentation measurements (8 ms quantized).
  // The API omits fast events below its minimum 16 ms threshold; do not infer zero latency from absence.
  try {
    if (PerformanceObserver.supportedEntryTypes.includes("event")) {
      const observer = new PerformanceObserver(list => {
        for (const e of list.getEntries()) {
          const entry = e as PerformanceEntry & { target: EventTarget | null };
          if (entry.name !== "keydown") continue;
          const metric = perfTarget(entry.target);
          if (metric) add(metric, "event-timing", entry.duration, "event");
        }
      });
      observer.observe({ type: "event", buffered: false, durationThreshold: 16 } as PerformanceObserverInit);
      eventTiming = true;
    }
  } catch { /* WebKit lacks Event Timing: only explicitly labelled estimates below. */ }
  // Two rAF callbacks straddle a rendering opportunity, not a physical/compositor paint guarantee.
  let pending = 0;
  const estimate = (metric: PerfSample["metric"], began: number, stillRelevant = () => true, startPoint: PerfSample["startPoint"] = "event") => {
    if (pending >= 16 || document.hidden) return;
    pending++;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      pending--;
      if (!document.hidden && stillRelevant()) add(metric, "double-raf-estimate", performance.now() - began, startPoint);
    }));
  };
  let fullscreenKeyAt = -Infinity;
  let panelKeyAt = -Infinity;
  document.addEventListener("keydown", e => {
    if (!e.isTrusted || document.hidden) return;
    const eventAt = e.timeStamp > performance.timeOrigin ? e.timeStamp - performance.timeOrigin : e.timeStamp;
    if (!e.repeat && hit(e, "view.fullscreen")) fullscreenKeyAt = eventAt;
    if (!e.repeat && hit(e, "view.chat")) panelKeyAt = eventAt;
    const metric = perfTarget(e.target);
    if (metric) {
      // Normalize old epoch-based WebKit timestamps without retaining the event or its key.
      const began = e.timeStamp > performance.timeOrigin ? e.timeStamp - performance.timeOrigin : e.timeStamp;
      estimate(metric, began);
    }
  }, true);
  // Existing store transitions cover shortcuts AND mouse opening. No extra UI/controller.
  useStore.subscribe((state, old) => {
    if (state.chatFullscreen !== old.chatFullscreen) {
      const expected = state.chatFullscreen;
      const fromKey = performance.now() - fullscreenKeyAt < 1000;
      estimate("fullscreen-transition", fromKey ? fullscreenKeyAt : performance.now(), () => useStore.getState().chatFullscreen === expected && !!document.querySelector('[data-perf-view="fullscreen"]') === expected, fromKey ? "event" : "state-change");
      fullscreenKeyAt = -Infinity;
    }
    maybeLaunch();
    if (old.rightCollapsed && !state.rightCollapsed && !state.popoutOpen) {
      const fromKey = performance.now() - panelKeyAt < 1000;
      estimate("chat-panel-open", fromKey ? panelKeyAt : performance.now(), () => !useStore.getState().rightCollapsed && !useStore.getState().popoutOpen && !!document.querySelector('[data-perf-target="composer"]')?.getClientRects().length, fromKey ? "event" : "state-change");
    }
  });
  // Reuse the actual tree+chats readiness marks, not an arbitrary React mount or timeout.
  let launchScheduled = false;
  function maybeLaunch() {
    const state = useStore.getState();
    if (launchScheduled || !hasBootMark("vault ready") || !state.conversationsLoaded || !state.vaultPath || document.hidden) return;
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
  void afterVaultReady(90_000).then(maybeLaunch);
}
