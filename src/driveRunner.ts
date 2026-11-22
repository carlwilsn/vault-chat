// The Drive window's side (index.html?view=drive, src/windowKind.ts): a sandboxed copy of the app (src/driveGuard.ts)
// that waits for its vault to load, says it is ready, and runs what the main window asks: scripted steps
// (src/driveSteps.ts). It answers only its own main window, never the box.
import { isTauri } from "@tauri-apps/api/core";
import { hasBootMark } from "./bootTiming";
import { driveStorageIsolated } from "./driveGuard";
import { DRIVE_TO_DRIVE, DRIVE_TO_MAIN, isDriveMsg, type DriveReply, type DriveRequest } from "./driveProtocol";
import { runSteps, type Shot } from "./driveSteps";
import { useStore } from "./store";

/** Why this window may not run steps (null: it may): its storage must be its own and, native, its commands guarded. */
export function driveUnsafe(native = isTauri()): string | null {
  if (!driveStorageIsolated) return "its storage could not be separated from Carl's window";
  if (native && (globalThis as { __vcInvokeGuard?: boolean }).__vcInvokeGuard !== true) return "this build has no read-only guard on its native commands (a dev build?)";
  return null;
}

async function shot(name: string): Promise<Shot> {
  const { captureWindow } = await import("./screenCapture");
  const c = await captureWindow("window", { maxWidth: 1280 });
  return { name, data: c.data, mimeType: c.mimeType, width: c.width, height: c.height };
}

async function appReady(ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (hasBootMark("vault ready") && useStore.getState().conversationsLoaded) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

const why = (ac: AbortController) => (ac.signal.aborted ? { aborted: String(ac.signal.reason ?? "aborted") } : {});

export function installDriveRunner(): void {
  // A hidden frame (the browser host, src/driveHost.ts) talks to its parent page; Tauri gives a frame no native IPC of
  // its own, so only a top-level Drive window is native.
  const native = isTauri() && window.parent === window;
  const runs = new Map<string, AbortController>();
  let send: (m: DriveReply) => void = () => {};
  const handle = async (m: DriveRequest) => {
    if (m.kind === "abort") {
      runs.get(m.reqId)?.abort(m.reason);
      return;
    }
    const ac = new AbortController();
    runs.set(m.reqId, ac);
    // Real input that reaches this window (it has focus: the browser's frame host) is Carl, never the steps.
    const onReal = (e: Event) => {
      if (e.isTrusted) ac.abort(`Carl started using the laptop (${e.type === "keydown" ? "typing" : "clicking"}, in the Drive window)`);
    };
    for (const t of ["keydown", "pointerdown", "wheel"]) window.addEventListener(t, onReal, true);
    try {
      const r = await runSteps(document, m.steps, { signal: ac.signal, shot });
      send({ kind: "result", reqId: m.reqId, steps: r, ...why(ac) });
    } catch (e) {
      send({ kind: "result", reqId: m.reqId, error: String((e as Error)?.message ?? e) });
    } finally {
      for (const t of ["keydown", "pointerdown", "wheel"]) window.removeEventListener(t, onReal, true);
      runs.delete(m.reqId);
    }
  };
  // Carl's own click or key in the Drive window means it is on his screen and in his way (it never should be: it is
  // placed off every monitor, src/driveHost.ts): stop what runs and have the main window close it.
  if (native) {
    let asked = false;
    const onHuman = (e: Event) => {
      if (!e.isTrusted || asked) return;
      asked = true;
      for (const ac of runs.values()) ac.abort("Carl clicked or typed in the Drive window");
      // Give an aborted run a moment to report before the window goes.
      setTimeout(() => send({ kind: "close", reason: `Carl's ${e.type} in the Drive window` }), 300);
    };
    for (const t of ["keydown", "pointerdown"]) window.addEventListener(t, onHuman, true);
  }
  let readyMs = 0;
  const start = async () => {
    const unsafe = driveUnsafe(native);
    const loaded = unsafe ? false : await appReady(45_000);
    readyMs = performance.now();
    send(unsafe ? { kind: "ready", ok: false, error: `the Drive window refuses to run: ${unsafe}`, readyMs } : { kind: "ready", ok: true, readyMs, ...(loaded ? {} : { note: "the app had not finished loading its vault after 45 s" }) });
  };
  if (native) {
    void (async () => {
      const { listen, emitTo } = await import("@tauri-apps/api/event");
      send = (m) => void emitTo("main", DRIVE_TO_MAIN, m).catch((e) => console.warn("[drive] reply failed:", e));
      await listen<DriveRequest>(DRIVE_TO_DRIVE, (e) => void handle(e.payload));
      await start();
    })();
  } else {
    const parent = window.parent;
    if (!parent || parent === window) return;
    send = (m) => parent.postMessage({ __vcDrive: true, msg: m }, location.origin);
    window.addEventListener("message", (e) => {
      if (e.source !== parent || e.origin !== location.origin || !isDriveMsg(e.data)) return;
      void handle(e.data.msg as DriveRequest);
    });
    void start();
  }
}
