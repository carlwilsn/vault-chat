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

async function nativeHost(): Promise<DriveHost> {
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const { listen, emitTo } = await import("@tauri-apps/api/event");
  const fns = new Set<(m: DriveReply) => void>();
  const unlisten = await listen<DriveReply>(DRIVE_TO_MAIN, (e) => fns.forEach((f) => f(e.payload)));
  const onReply = (fn: (m: DriveReply) => void) => (fns.add(fn), () => void fns.delete(fn));
  const old = await WebviewWindow.getByLabel(DRIVE_LABEL);
  if (old) await old.destroy().catch(() => {});
  const w = window.innerWidth || 1400;
  const h = window.innerHeight || 900;
  const win = new WebviewWindow(DRIVE_LABEL, {
    url: "index.html?view=drive",
    title: "vault-chat (agent check)",
    width: w,
    height: h,
    // Far off every monitor (a monitor left of or above the main one has small negative coordinates).
    x: -30000,
    y: -30000,
    visible: true,
    focus: false,
    skipTaskbar: true,
    decorations: false,
    resizable: false,
  });
  const close = () => {
    unlisten();
    void win.destroy().catch(() => {});
  };
  const created = new Promise<string | null>((resolve) => {
    void win.once("tauri://created", () => resolve(null));
    void win.once("tauri://error", (e) => resolve(String((e as { payload?: unknown }).payload ?? "could not open the Drive window")));
  });
  const ready = created.then((err) => (err ? (close(), { kind: "ready" as const, ok: false, error: err, readyMs: 0 }) : readyFrom(onReply, close)));
  return { where: "a hidden Drive window (a second, off-screen copy of the app)", ready, send: (m) => void emitTo(DRIVE_LABEL, DRIVE_TO_DRIVE, m).catch(() => {}), onReply, close };
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
