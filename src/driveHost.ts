// Carl's main window's handle on the agent's Drive window (src/driveRunner.ts runs inside it). Native: a second window
// of the app, index.html?view=drive, created off every screen, unfocused and out of the taskbar, so nothing of it is
// seen and his window keeps focus and layout. In a browser (the preview harness): a hidden same-origin frame. Kept warm
// for a few minutes after a run so a series of checks does not reload the app each time; then closed.
import { isTauri } from "@tauri-apps/api/core";
import { DRIVE_LABEL, DRIVE_TO_DRIVE, DRIVE_TO_MAIN, isDriveMsg, type DriveReply, type DriveRequest } from "./driveProtocol";

export type DriveHost = {
  /** "a hidden Drive window" / "a hidden Drive frame". */
  where: string;
  /** Resolves once the Drive copy of the app is loaded (or says why it can't run). */
  ready: Promise<Extract<DriveReply, { kind: "ready" }>>;
  send(m: DriveRequest): void;
  onReply(fn: (m: DriveReply) => void): () => void;
  close(): void;
};
export type DriveHostFactory = () => Promise<DriveHost>;

const KEEP_WARM_MS = 3 * 60_000;
const READY_MS = 60_000;

function readyFrom(onReply: DriveHost["onReply"], close: () => void): DriveHost["ready"] {
  return new Promise((resolve) => {
    const t = setTimeout(() => (off(), resolve({ kind: "ready", ok: false, error: `the Drive copy of the app did not load within ${READY_MS / 1000} s`, readyMs: 0 }), close()), READY_MS);
    const off = onReply((m) => {
      if (m.kind !== "ready") return;
      clearTimeout(t);
      off();
      resolve(m);
    });
  });
}

/** A screen rectangle in physical pixels (a monitor, or a window's outer frame). */
export type ScreenRect = { x: number; y: number; width: number; height: number };

/** Does `r` overlap any of `monitors`, even by one pixel (would any of it be seen)? */
export function onAnyMonitor(r: ScreenRect, monitors: ScreenRect[]): boolean {
  return monitors.some((m) => r.x < m.x + m.width && r.x + r.width > m.x && r.y < m.y + m.height && r.y + r.height > m.y);
}

/** Where to put a window of `size` so it is off every monitor: far above and left of all of them. */
export function offScreenSpot(size: { width: number; height: number }, monitors: ScreenRect[]): { x: number; y: number } {
  const minX = Math.min(0, ...monitors.map((m) => m.x));
  const minY = Math.min(0, ...monitors.map((m) => m.y));
  return { x: Math.min(-30000, minX - size.width - 1000), y: Math.min(-30000, minY - size.height - 1000) };
}

/** What placeOffScreen needs of a native window (Tauri's WebviewWindow, physical pixels). */
export type PlaceableWindow = {
  setPosition(x: number, y: number): Promise<void>;
  outerPosition(): Promise<{ x: number; y: number }>;
  outerSize(): Promise<{ width: number; height: number }>;
  show(): Promise<void>;
};

/** Move the (created hidden) Drive window off every monitor, check where it really is, and only then show it; null when
 * shown off-screen, else why it was not shown. Windows (tao) ignores a creation position that is on no monitor and puts
 * the window at the default spot on screen instead, so the position is set after creation (SetWindowPos does not clamp)
 * and read back: a window that would be seen is never shown. */
export async function placeOffScreen(win: PlaceableWindow, monitors: ScreenRect[]): Promise<string | null> {
  const size = await win.outerSize();
  const spot = offScreenSpot(size, monitors);
  await win.setPosition(spot.x, spot.y);
  // SetWindowPos is asynchronous on another thread (SWP_ASYNCWINDOWPOS): read back until it lands.
  for (let i = 0; i < 20; i++) {
    const at = await win.outerPosition();
    if (!onAnyMonitor({ ...at, ...size }, monitors)) {
      await win.show();
      return null;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  const at = await win.outerPosition();
  return `the Drive window could not be moved off the screen (it stayed at ${at.x},${at.y}), so it was not shown`;
}

/** How the Drive window is created: hidden until placeOffScreen has moved it off every monitor. */
export const DRIVE_WINDOW_OPTIONS = {
  url: "index.html?view=drive",
  title: "vault-chat (agent check)",
  visible: false,
  focus: false,
  skipTaskbar: true,
  decorations: false,
  resizable: false,
} as const;

async function nativeHost(): Promise<DriveHost> {
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const { availableMonitors, PhysicalPosition } = await import("@tauri-apps/api/window");
  const { listen, emitTo } = await import("@tauri-apps/api/event");
  const fns = new Set<(m: DriveReply) => void>();
  const unlisten = await listen<DriveReply>(DRIVE_TO_MAIN, (e) => fns.forEach((f) => f(e.payload)));
  const onReply = (fn: (m: DriveReply) => void) => (fns.add(fn), () => void fns.delete(fn));
  // Carl clicked or typed in it: it is in his way, so it goes now (an undecorated window has no close of its own).
  onReply((m) => {
    if (m.kind !== "close") return;
    if (warm && warm.host === host) releaseDriveHost(true);
    else close();
  });
  const old = await WebviewWindow.getByLabel(DRIVE_LABEL);
  if (old) await old.destroy().catch(() => {});
  const w = window.innerWidth || 1400;
  const h = window.innerHeight || 900;
  // No x/y here: Windows would ignore an off-monitor one and show the window on screen (2026-11-17, v0.9.38).
  const win = new WebviewWindow(DRIVE_LABEL, { ...DRIVE_WINDOW_OPTIONS, width: w, height: h });
  let host: DriveHost | null = null;
  const close = () => {
    unlisten();
    void win.destroy().catch(() => {});
  };
  // Closed some other way (its own close on Carl's input, the main window closing): forget the warm copy.
  void win.once("tauri://destroyed", () => {
    unlisten();
    if (warm && warm.host === host) {
      if (warm.timer) clearTimeout(warm.timer);
      warm = null;
    }
  });
  const created = new Promise<string | null>((resolve) => {
    void win.once("tauri://created", () => resolve(null));
    void win.once("tauri://error", (e) => resolve(String((e as { payload?: unknown }).payload ?? "could not open the Drive window")));
  });
  const placed = created.then(async (err) => {
    if (err) return err;
    try {
      const monitors = (await availableMonitors()).map((m) => ({ x: m.position.x, y: m.position.y, width: m.size.width, height: m.size.height }));
      return await placeOffScreen(
        {
          setPosition: (x, y) => win.setPosition(new PhysicalPosition(x, y)),
          outerPosition: () => win.outerPosition(),
          outerSize: () => win.outerSize(),
          show: () => win.show(),
        },
        monitors,
      );
    } catch (e) {
      return `the Drive window could not be placed off the screen: ${String((e as Error)?.message ?? e)}`;
    }
  });
  // Listen for its ready from the start: the copy may finish loading while it is still being placed.
  const loaded = readyFrom(onReply, close);
  const ready = placed.then((err) => (err ? (close(), { kind: "ready" as const, ok: false, error: err, readyMs: 0 }) : loaded));
  host = { where: "a hidden Drive window (a second, off-screen copy of the app)", ready, send: (m) => void emitTo(DRIVE_LABEL, DRIVE_TO_DRIVE, m).catch(() => {}), onReply, close };
  return host;
}

/** The Drive copy as a hidden same-origin frame of this page (a browser; the preview harness). */
export async function driveFrameHost(): Promise<DriveHost> {
  const f = document.createElement("iframe");
  const params = new URLSearchParams(location.search);
  params.set("view", "drive");
  f.src = `${location.pathname}?${params.toString()}`;
  f.setAttribute("aria-hidden", "true");
  f.tabIndex = -1;
  Object.assign(f.style, { position: "fixed", left: "-30000px", top: "0", width: `${window.innerWidth || 1400}px`, height: `${window.innerHeight || 900}px`, border: "0", pointerEvents: "none" });
  f.dataset.vcDrive = "1";
  const fns = new Set<(m: DriveReply) => void>();
  const onMsg = (e: MessageEvent) => {
    if (e.source !== f.contentWindow || e.origin !== location.origin || !isDriveMsg(e.data)) return;
    fns.forEach((fn) => fn(e.data.msg as DriveReply));
  };
  window.addEventListener("message", onMsg);
  const onReply = (fn: (m: DriveReply) => void) => (fns.add(fn), () => void fns.delete(fn));
  const close = () => {
    window.removeEventListener("message", onMsg);
    f.remove();
  };
  const ready = readyFrom(onReply, close);
  document.body.appendChild(f);
  return { where: "a hidden Drive frame (a second copy of the app)", ready, send: (m) => f.contentWindow?.postMessage({ __vcDrive: true, msg: m }, location.origin), onReply, close };
}

let factory: DriveHostFactory | null = null;
/** Replace how the Drive copy is opened (tests; null: native window, else a frame). */
export function setDriveHostFactory(f: DriveHostFactory | null): void {
  factory = f;
  warm?.host.close();
  warm = null;
}

let warm: { host: DriveHost; timer: ReturnType<typeof setTimeout> | null } | null = null;

/** The Drive copy, opened (or the warm one), and ready, or why not. */
export async function openDriveHost(): Promise<{ host: DriveHost; error?: string; note?: string }> {
  if (warm) {
    if (warm.timer) clearTimeout(warm.timer);
    warm.timer = null;
    const r = await warm.host.ready;
    if (r.ok) return { host: warm.host };
    warm.host.close();
    warm = null;
  }
  const host = await (factory ?? (isTauri() ? nativeHost : driveFrameHost))();
  warm = { host, timer: null };
  const r = await host.ready;
  if (!r.ok) {
    host.close();
    warm = null;
    return { host, error: r.error ?? "the Drive copy of the app could not start" };
  }
  return { host, ...(r.note ? { note: r.note } : {}) };
}

/** After a run: keep the Drive copy for a few minutes, then close it. `now`: close at once (an aborted run). */
export function releaseDriveHost(now = false): void {
  if (!warm) return;
  if (warm.timer) clearTimeout(warm.timer);
  if (now) {
    warm.host.close();
    warm = null;
    return;
  }
  const w = warm;
  w.timer = setTimeout(() => {
    w.host.close();
    if (warm === w) warm = null;
  }, KEEP_WARM_MS);
  (w.timer as { unref?: () => void }).unref?.();
}
