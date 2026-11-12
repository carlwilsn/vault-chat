// The in-process mount host (base spec change 1.5): a vault page that declares
//   <meta name="vc-mount" content="in-process">        (src/liveBridge.ts parseLiveMount)
// runs in the app itself, not in an iframe. Its <style>s and body markup go into a shadow root on the host element
// (its CSS stays its own; the app's theme variables still reach it), its inline <script type="module"> is loaded as one
// module, and that module's `mount(el, api)` is called: the whiteboard widget contract (src/widgetHost.ts), found the
// same way (a `mount` export, `default.mount`, or a default function). `mount` may return a cleanup function (or a
// promise of one); unmount runs it.
//
//   api: size() → {w, h}, onResize(fn), theme {mode, vars}, onTheme(fn), path,
//        listen(target, type, fn, opts) → off, timer(fn, ms, repeat?) → cancel, effect(undo) → undo now   (change 1.6)
//
// Everything a run does to the app is a revertible effect (src/pluginSupervisor.ts Effects): its markup, the host's
// listeners and observer, the module's URL, the plugin's own listeners and timers made through the api, its cleanup.
// Unmount (the supervisor stopping it, the page closing, a failure, a reload) reverts them newest first, so a stopped
// plugin leaves nothing behind. (A listener the plugin adds with window.addEventListener itself is its own to remove in
// its cleanup; through api.listen the host removes it.)
//
// The error boundary: whatever the plugin throws (the module failing to parse or load, mount throwing or rejecting, a
// callback the host runs, or later on its own from a handler or timer, told apart by the module's URL) is caught,
// the plugin is taken down (its cleanup run) and an error card with a Reload button stands in its place. Nothing the
// plugin throws reaches the app. (A plugin that loops forever still blocks the page: in-process has no hard stop.)
// Pages without the declaration are iframes exactly as before (HtmlView, InlineHtmlFrame).

import { LIVE_THEME_VARS } from "./liveBridge";
import { Effects } from "./pluginSupervisor";

export type PluginTheme = { mode: "light" | "dark"; vars: Record<string, string> };
export type PluginApi = {
  /** The page's vault path (the plugin's id). */
  path: string;
  size(): { w: number; h: number };
  onResize(fn: (size: { w: number; h: number }) => void): void;
  theme: PluginTheme;
  onTheme(fn: (theme: PluginTheme) => void): void;
  /** addEventListener on any target, removed when the plugin stops. Returns a function that removes it now. */
  listen(target: EventTarget, type: string, fn: (e: any) => void, opts?: boolean | AddEventListenerOptions): () => void;
  /** setTimeout (or setInterval with `repeat`), cleared when the plugin stops. Returns a function that clears it now. */
  timer(fn: () => void, ms: number, repeat?: boolean): () => void;
  /** Any other effect: `undo` runs when the plugin stops (newest first). Returns a function that runs it now. */
  effect(undo: () => void): () => void;
};
/** Load the module's code: the module, the URL it was loaded from (errors name it), and a release of that URL. */
export type LoadModule = (code: string) => Promise<{ module: any; url: string; dispose(): void }>;
export type PluginHandle = {
  /** Settles when the first mount has (or failed); never rejects. */
  readonly ready: Promise<void>;
  /** The error that took it down, or null while it runs. */
  readonly error: string | null;
  setTheme(theme: PluginTheme): void;
  reload(): Promise<void>;
  unmount(): void;
  /** What the current run still has in effect on the app (labels; empty once it is unmounted). */
  readonly effects: readonly string[];
};
type Win = Pick<Window, "addEventListener" | "removeEventListener"> & { DOMParser: typeof DOMParser };

/** The app's own: a blob: URL per load. */
export const blobLoad: LoadModule = async (code) => {
  const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
  try {
    return { module: await import(/* @vite-ignore */ url), url, dispose: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
};

/** The page's parts: its name (<title>, else the file's), its <style>s, its markup without scripts, its module code. */
export function pluginParts(html: string, win: Pick<Win, "DOMParser">, path: string): { name: string; styles: string[]; body: string; code: string } {
  const doc = new win.DOMParser().parseFromString(html, "text/html");
  const code: string[] = [];
  for (const s of Array.from(doc.querySelectorAll("script"))) {
    if ((s.getAttribute("type") ?? "").trim().toLowerCase() === "module" && !s.hasAttribute("src")) code.push(s.textContent ?? "");
    s.remove();
  }
  const styles = Array.from(doc.querySelectorAll("style")).map((s) => s.textContent ?? "");
  for (const s of Array.from(doc.body?.querySelectorAll("style") ?? [])) s.remove();
  const name = (doc.querySelector("title")?.textContent ?? "").trim() || path.split(/[\\/]/).pop() || "page";
  return { name, styles, body: doc.body?.innerHTML ?? "", code: code.join("\n") };
}

/** The app's theme as a plugin sees it (the live pages' vc.theme): light/dark and the app's CSS variables. */
export function hostTheme(doc: Document = document): PluginTheme {
  const cs = doc.defaultView!.getComputedStyle(doc.documentElement);
  const vars: Record<string, string> = {};
  for (const n of LIVE_THEME_VARS) {
    const v = cs.getPropertyValue(`--${n}`).trim();
    if (v) vars[n] = v;
  }
  return { mode: doc.documentElement.dataset.theme === "light" ? "light" : "dark", vars };
}

const message = (e: unknown): string => {
  const x = e as { stack?: unknown; message?: unknown } | null;
  return String((x && (x.stack || x.message)) || e || "error");
};

const HOST_CSS = `:host{display:block;position:relative}[data-el="plugin-root"]{position:relative}
[data-el="plugin-error"]{margin:8px;padding:10px 12px;border-radius:8px;border:1px solid hsl(var(--destructive,0 70% 50%) / .5);background:hsl(var(--card,0 0% 13%));color:hsl(var(--foreground,0 0% 92%));font:12.5px/1.45 system-ui,sans-serif}
[data-el="plugin-error"] b{display:block;margin-bottom:4px}
[data-el="plugin-error"] pre{margin:0 0 8px;max-height:9em;overflow:auto;white-space:pre-wrap;word-break:break-word;font:11px/1.4 ui-monospace,monospace;color:hsl(var(--muted-foreground,0 0% 65%))}
[data-el="plugin-reload"]{font:inherit;padding:3px 10px;border-radius:6px;border:1px solid hsl(var(--border,0 0% 30%));background:transparent;color:inherit;cursor:pointer}`;

/** Mount the page `html` into `host` (in its shadow root). Never throws; a failure is the handle's `error` and a card. */
export function mountPlugin(
  host: HTMLElement,
  html: string,
  opts: { path: string; theme: () => PluginTheme; win?: Win; load?: LoadModule; onError?: (message: string) => void },
): PluginHandle {
  const win = opts.win ?? (window as unknown as Win);
  const load = opts.load ?? blobLoad;
  const doc = host.ownerDocument;
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  let gen = 0;
  let error: string | null = null;
  let theme = opts.theme();
  // What the current run holds: its effects, undone by stop() newest first.
  type Run = { effects: Effects; url: string; resizeFns: ((s: { w: number; h: number }) => void)[]; themeFns: ((t: PluginTheme) => void)[] };
  let run: Run | null = null;
  let parts: ReturnType<typeof pluginParts> | null = null;

  const ownError = (url: string, filename: unknown, err: unknown) => !!url && (filename === url || message(err).includes(url));
  const onWinError = (e: ErrorEvent) => {
    if (!run || !ownError(run.url, e.filename, e.error)) return;
    e.preventDefault?.();
    fail(e.error ?? e.message);
  };
  const onRejection = (e: PromiseRejectionEvent) => {
    if (!run || !ownError(run.url, null, e.reason)) return;
    e.preventDefault?.();
    fail(e.reason);
  };

  const stop = () => {
    const r = run;
    run = null;
    r?.effects.revert();
  };
  const clear = () => {
    while (shadow.firstChild) shadow.removeChild(shadow.firstChild);
  };
  const style = (css: string) => {
    const s = doc.createElement("style");
    s.textContent = css;
    return s;
  };

  function fail(e: unknown): void {
    if (error !== null) return;
    gen++;
    error = message(e);
    stop();
    clear();
    const card = doc.createElement("div");
    card.setAttribute("data-el", "plugin-error");
    const title = doc.createElement("b");
    title.textContent = `${parts?.name ?? opts.path} stopped`;
    const pre = doc.createElement("pre");
    pre.textContent = error;
    const btn = doc.createElement("button");
    btn.setAttribute("data-el", "plugin-reload");
    btn.setAttribute("type", "button");
    btn.textContent = "Reload";
    btn.addEventListener("click", () => void reload());
    card.append(title, pre, btn);
    shadow.append(style(HOST_CSS), card);
    try {
      opts.onError?.(error);
    } catch {
      /* a report, nothing more */
    }
  }

  const guard = <A extends unknown[]>(f: (...a: A) => void) => (...a: A) => {
    try {
      f(...a);
    } catch (e) {
      fail(e);
    }
  };

  async function start(): Promise<void> {
    const my = ++gen;
    stop();
    error = null;
    clear();
    try {
      parts = pluginParts(html, win, opts.path);
      const root = doc.createElement("div");
      root.setAttribute("data-el", "plugin-root");
      root.innerHTML = parts.body;
      shadow.append(style(HOST_CSS), ...parts.styles.map(style), root);
      if (!parts.code.trim()) throw new Error('the page has no <script type="module"> exporting mount(el, api)');
      const loaded = await load(parts.code);
      if (my !== gen) return loaded.dispose();
      const fx = new Effects();
      const r: Run = { effects: fx, url: loaded.url, resizeFns: [], themeFns: [] };
      run = r;
      fx.add("module", loaded.dispose);
      fx.add("markup", clear);
      fx.listen(win, "error", onWinError);
      fx.listen(win, "unhandledrejection", onRejection);
      const m = loaded.module ?? {};
      const f = typeof m.mount === "function" ? m.mount : m.default && typeof m.default.mount === "function" ? m.default.mount : typeof m.default === "function" ? m.default : null;
      if (!f) throw new Error("the module exports no mount(el, api)");
      const size = () => ({ w: root.clientWidth || 0, h: root.clientHeight || 0 });
      const api: PluginApi = {
        path: opts.path,
        size,
        onResize: (fn) => void (typeof fn === "function" && r.resizeFns.push(fn)),
        get theme() {
          return theme;
        },
        onTheme: (fn) => void (typeof fn === "function" && r.themeFns.push(fn)),
        // The plugin's own effects: guarded (a throw is its failure, not the app's) and reverted when it stops.
        listen: (target, type, fn, o) => (run === r ? fx.listen(target, String(type), guard(fn), o) : () => {}),
        timer: (fn, ms, repeat) => (run === r ? fx.timer(guard(fn), Math.max(0, Number(ms) || 0), !!repeat) : () => {}),
        effect: (undo) => (run === r && typeof undo === "function" ? fx.add("effect", undo) : () => {}),
      };
      if (typeof ResizeObserver !== "undefined") {
        const ro = new ResizeObserver(guard(() => {
          for (const fn of r.resizeFns) fn(size());
        }));
        ro.observe(root);
        fx.add("resize observer", () => ro.disconnect());
      }
      let out = f.call(m, root, api);
      if (out && typeof out.then === "function") out = await out;
      if (my !== gen || run !== r) {
        // Unmounted (or failed) while it was mounting: undo what it just did.
        if (typeof out === "function") guard(out)();
        return;
      }
      if (typeof out === "function") fx.add("cleanup", out);
    } catch (e) {
      if (my === gen) fail(e);
    }
  }

  const ready = start();
  function reload(): Promise<void> {
    error = null;
    return start();
  }

  return {
    ready,
    get error() {
      return error;
    },
    setTheme(t) {
      theme = t;
      const r = run;
      if (r) guard(() => { for (const fn of r.themeFns) fn(t); })();
    },
    reload,
    get effects() {
      return run?.effects.live ?? [];
    },
    unmount() {
      gen++;
      stop();
      clear();
    },
  };
}
