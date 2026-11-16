// The in-app half of the agent's Timing tool (server/timingTool.ts): the five speeds the perf harness tracks
// (docs/perf-baseline.md), measured inside the real app (its Drive window, src/driveRunner.ts), so a release can be
// checked on the laptop's own WebView2 without Carl typing anything.
//
// Each sample is the perf probe's own quantity (src/laptopPerf.ts, scripts/typing-bench.mjs): from the moment the key
// event is dispatched until two animation frames later ("double-raf-estimate"; a rendering opportunity, not physical
// paint). The events are synthetic (dispatched in-page, not from the OS), so input-dispatch delay is not included; the
// render cost the harness compares is. The metric names and methods are the harness's, so the numbers sit next to a
// baseline; the source says "drive-synthetic" so they are never mixed with Carl's real keystrokes.
import { useStore } from "./store";
import { insertText, parseKey, press } from "./driveSteps";

export type TimingMetric = "composer-key" | "ctrl-k-key" | "fullscreen-transition" | "chat-panel-open";
export const TIMING_METRICS: TimingMetric[] = ["composer-key", "ctrl-k-key", "fullscreen-transition", "chat-panel-open"];
export type TimingSamples = { metric: TimingMetric; method: "double-raf-estimate"; samples: number[]; error?: string };
export type TimingResult = {
  source: "drive-synthetic";
  visibility: string;
  /** Median ms between animation frames in this window before measuring (16.7 at 60 Hz; far more: throttled/hidden). */
  frameMs: number | null;
  throttled: boolean;
  /** This window's own navigation-to-ready time (a renderer in the running app, not an app launch). */
  windowReadyMs?: number;
  metrics: TimingSamples[];
};

export type TimingOptions = { keys?: number; warmup?: number; toggles?: number; signal?: AbortSignal; metrics?: TimingMetric[] };

const raf = () => new Promise<number>((r) => requestAnimationFrame(() => r(performance.now())));
const timeout = <T>(p: Promise<T>, ms: number, fallback: T) => Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
/** ms from `t0` until two frames after `ready()` holds (polled each frame, at most 3 s). */
async function framesAfter(t0: number, ready: () => boolean = () => true): Promise<number> {
  const end = t0 + 3000;
  for (;;) {
    const t = await timeout(raf(), 1000, NaN);
    if (Number.isNaN(t)) throw new Error("no animation frame in 1 s (the window is hidden or throttled)");
    if (ready()) break;
    if (t > end) throw new Error("the screen did not change within 3 s");
  }
  await timeout(raf(), 1000, NaN);
  return performance.now() - t0;
}
async function waitFor<T>(fn: () => T | null | undefined | false, ms = 4000): Promise<T> {
  const end = performance.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (performance.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 30));
  }
}
const q = <T extends Element>(sel: string) => document.querySelector<T>(sel);
const shown = (el: Element | null) => !!el && el.getClientRects().length > 0;
const composer = () => q<HTMLTextAreaElement>('[data-perf-target="composer"]');
const pressKey = (spec: string) => press(document, parseKey(spec)!);

async function frameInterval(): Promise<number | null> {
  const ts: number[] = [];
  for (let i = 0; i < 11; i++) {
    const t = await timeout(raf(), 500, NaN);
    if (Number.isNaN(t)) return null;
    ts.push(t);
  }
  const d = ts.slice(1).map((t, i) => t - ts[i]!).sort((a, b) => a - b);
  return d[Math.floor(d.length / 2)]!;
}

/** Type `n` characters into the focused field, one sample per key. */
async function typeKeys(field: Element, n: number, warmup: number, signal?: AbortSignal): Promise<number[]> {
  const out: number[] = [];
  const text = "the quick brown fox jumps over the lazy dog ";
  for (let i = 0; i < n + warmup; i++) {
    if (signal?.aborted) break;
    const t0 = performance.now();
    insertText(field, text[i % text.length]!);
    const ms = await framesAfter(t0);
    if (i >= warmup) out.push(Math.round(ms * 10) / 10);
  }
  return out;
}

function clearField(el: HTMLTextAreaElement | HTMLElement) {
  el.focus();
  document.execCommand("selectAll");
  document.execCommand("delete");
}

async function measureComposer(o: Required<Pick<TimingOptions, "keys" | "warmup">> & TimingOptions): Promise<number[]> {
  const s = useStore.getState();
  if (s.chatFullscreen) s.toggleChatFullscreen();
  if (useStore.getState().rightCollapsed) useStore.getState().toggleRight();
  const c = await waitFor(() => (shown(composer()) && !composer()!.disabled ? composer() : null)).catch(() => {
    throw new Error("the chat composer is not on screen (or is disabled)");
  });
  c.focus();
  try {
    return await typeKeys(c, o.keys, o.warmup, o.signal);
  } finally {
    clearField(c);
  }
}

async function openSomeMarkdown(): Promise<void> {
  const s = useStore.getState();
  if (s.currentFile && /\.md$/i.test(s.currentFile)) return;
  const f = s.files.find((x) => !x.is_dir && !x.hidden && /\.md$/i.test(x.path));
  if (!f) throw new Error("no markdown file in the vault to open an editor on");
  const { invoke } = await import("@tauri-apps/api/core");
  const text = await invoke<string>("read_text_file", { path: f.path });
  useStore.getState().setCurrentFile(f.path, text);
}

async function measureCtrlK(o: Required<Pick<TimingOptions, "keys" | "warmup">> & TimingOptions): Promise<number[]> {
  const s = useStore.getState();
  if (s.chatFullscreen) s.toggleChatFullscreen();
  await openSomeMarkdown();
  // Ctrl+K lives in the editor: this copy's own view switches to edit (Carl's window is not this one).
  const st = useStore.getState();
  if (st.activePaneId && st.panes.some((p) => p.id === st.activePaneId)) {
    if (st.panes.find((p) => p.id === st.activePaneId)?.mode === "view") st.togglePaneMode(st.activePaneId);
  } else if (st.mode === "view") st.toggleMode();
  const editor = await waitFor(() => q<HTMLElement>(".cm-content")).catch(() => {
    throw new Error("no editor on screen to press Ctrl+K in");
  });
  editor.focus();
  pressKey("Control+K");
  const box = await waitFor(() => (shown(q('[data-perf-target="ctrl-k"]')) ? q<HTMLTextAreaElement>('[data-perf-target="ctrl-k"] textarea, textarea[data-perf-target="ctrl-k"]') ?? q<HTMLTextAreaElement>('[data-perf-target="ctrl-k"]') : null), 3000).catch(() => {
    throw new Error("Ctrl+K did not open its prompt");
  });
  box.focus();
  try {
    return await typeKeys(box, o.keys, o.warmup, o.signal);
  } finally {
    clearField(box);
    pressKey("Escape");
  }
}

async function measureFullscreen(toggles: number, signal?: AbortSignal): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < toggles * 2; i++) {
    if (signal?.aborted) break;
    const expected = !useStore.getState().chatFullscreen;
    document.body.focus();
    const t0 = performance.now();
    pressKey("Control+Shift+F");
    out.push(Math.round((await framesAfter(t0, () => useStore.getState().chatFullscreen === expected && !!q('[data-perf-view="fullscreen"]') === expected)) * 10) / 10);
  }
  if (useStore.getState().chatFullscreen) useStore.getState().toggleChatFullscreen();
  return out;
}

async function measureChatPanel(toggles: number, signal?: AbortSignal): Promise<number[]> {
  const out: number[] = [];
  if (useStore.getState().chatFullscreen) useStore.getState().toggleChatFullscreen();
  for (let i = 0; i < toggles; i++) {
    if (signal?.aborted) break;
    if (!useStore.getState().rightCollapsed) {
      useStore.getState().toggleRight();
      await raf();
      await raf();
    }
    document.body.focus();
    const t0 = performance.now();
    pressKey("Control+Shift+B");
    out.push(Math.round((await framesAfter(t0, () => !useStore.getState().rightCollapsed && shown(composer()))) * 10) / 10);
  }
  return out;
}

export async function runTiming(o: TimingOptions = {}, windowReadyMs?: number): Promise<TimingResult> {
  const keys = Math.max(1, Math.min(o.keys ?? 30, 200));
  const warmup = Math.max(0, Math.min(o.warmup ?? 5, 20));
  const toggles = Math.max(1, Math.min(o.toggles ?? 3, 10));
  const frameMs = await frameInterval();
  const throttled = frameMs === null || frameMs > 40 || document.visibilityState !== "visible";
  const metrics: TimingSamples[] = [];
  const want = o.metrics?.length ? o.metrics : TIMING_METRICS;
  for (const metric of TIMING_METRICS) {
    if (!want.includes(metric)) continue;
    if (o.signal?.aborted) break;
    try {
      const samples =
        metric === "composer-key" ? await measureComposer({ ...o, keys, warmup })
        : metric === "ctrl-k-key" ? await measureCtrlK({ ...o, keys, warmup })
        : metric === "fullscreen-transition" ? await measureFullscreen(toggles, o.signal)
        : await measureChatPanel(toggles, o.signal);
      metrics.push({ metric, method: "double-raf-estimate", samples });
    } catch (e) {
      metrics.push({ metric, method: "double-raf-estimate", samples: [], error: String((e as Error)?.message ?? e) });
    }
  }
  return { source: "drive-synthetic", visibility: document.visibilityState, frameMs: frameMs === null ? null : Math.round(frameMs * 10) / 10, throttled, ...(windowReadyMs !== undefined ? { windowReadyMs: Math.round(windowReadyMs) } : {}), metrics };
}
