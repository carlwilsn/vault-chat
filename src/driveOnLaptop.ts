// The laptop's half of the gate's UI runner (server/gate.ts). The box puts a
// {type:"drive", id, to:"laptop", ...} signal on the feed; src/boxChat.ts (Carl's main window) hands it here.
//   1. Carl first: if he has used the app's windows within `idleMs` (src/userActivity.ts) it refuses, saying when,
//      unless the agent passed `force`.
//   2. The work runs in the Drive copy of the app (src/driveHost.ts: a hidden second window, never his), so his window,
//      focus and layout are not touched.
//   3. The moment he types, clicks or moves the mouse in the app, the run is aborted (force or not) and the ack says so,
//      with the steps done so far.
// The ack: {ok, data:{where, steps, ...}, images} or {ok:false, error, data:{refused|aborted}}.
import { checkSteps, type Shot, type StepsResult } from "./driveSteps";
import { openDriveHost, releaseDriveHost } from "./driveHost";
import { cleanDriveTries } from "./driveGuard";
import type { DriveReply } from "./driveProtocol";
import { idleMs, noteInput, onInput } from "./userActivity";

export type DriveSignal = { type: "drive"; id: string; to?: string; steps?: unknown; force?: unknown; idleMs?: unknown; timeoutMs?: unknown; tries?: unknown };
export type DriveAckData = {
  where?: string;
  note?: string;
  refused?: boolean;
  aborted?: string;
  idleSec?: number | null;
  /** The drafts the Drive copy ran instead of the copies in effect (a gate run): an app that echoes them knows tries. */
  tries?: Record<string, string> | null;
  steps?: Omit<StepsResult, "shots"> & { shots: { name: string; width: number; height: number }[] };
};
export type DriveAck = { ok: boolean; error?: string; landed?: string; data?: DriveAckData; images?: { data: string; mimeType: string; name: string }[] };

const DEFAULT_IDLE_MS = 5 * 60_000;
const fmtIdle = (ms: number) => (ms < 90_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);

let queue: Promise<unknown> = Promise.resolve();
/** One run at a time (one Drive copy): a second request waits for the first. */
export function driveOnLaptop(sig: DriveSignal): Promise<DriveAck> {
  const next = queue.then(() => runDrive(sig), () => runDrive(sig));
  queue = next.catch(() => {});
  return next;
}

async function runDrive(sig: DriveSignal): Promise<DriveAck> {
  const steps = checkSteps(sig.steps);
  if (typeof steps === "string") return { ok: false, error: `bad steps: ${steps}` };
  const force = sig.force === true;
  const wantIdle = typeof sig.idleMs === "number" && sig.idleMs >= 0 ? Math.min(sig.idleMs, 60 * 60_000) : DEFAULT_IDLE_MS;
  const idle = idleMs();
  const idleSec = Number.isFinite(idle) ? Math.round(idle / 1000) : null;
  if (!force && idle < wantIdle) {
    return { ok: false, error: `Carl is using the laptop: his last key/click/mouse movement in the app was ${fmtIdle(idle)} ago (needs ${fmtIdle(wantIdle)} idle). Nothing was run. Try again later, or pass force if he asked for it now.`, data: { refused: true, idleSec } };
  }
  const timeoutMs = typeof sig.timeoutMs === "number" && sig.timeoutMs > 0 ? Math.min(sig.timeoutMs, 300_000) : 60_000;

  // A frame host (a browser) can pull focus into its hidden frame: give it back afterwards.
  const prevFocus = typeof document !== "undefined" ? document.activeElement : null;
  const giveBackFocus = () => {
    const a = typeof document !== "undefined" ? document.activeElement : null;
    if (a instanceof HTMLIFrameElement && a.dataset.vcDrive) {
      a.blur();
      if (prevFocus instanceof HTMLElement && prevFocus.isConnected) prevFocus.focus({ preventScroll: true });
    }
  };
  // Abort the moment he starts using the app (also while the Drive copy is still loading).
  let abortWhy: string | null = null;
  let abortRun: ((why: string) => void) | null = null;
  const offInput = onInput((kind) => {
    if (abortWhy) return;
    abortWhy = `Carl started using the laptop (${kind === "keydown" ? "typing" : kind === "pointermove" ? "moving the mouse" : kind === "wheel" ? "scrolling" : "clicking"})`;
    abortRun?.(abortWhy);
  });
  try {
    const tries = cleanDriveTries(sig.tries);
    const opened = await openDriveHost(tries);
    if (abortWhy) {
      releaseDriveHost(true);
      return { ok: false, error: `${abortWhy}; stopped before anything ran.`, data: { aborted: abortWhy, idleSec } };
    }
    if (opened.error) return { ok: false, error: `couldn't open the Drive copy of the app: ${opened.error}`, data: { where: opened.host.where, idleSec } };
    const host = opened.host;
    const reqId = `${sig.id}-${Math.random().toString(36).slice(2, 8)}`;
    const reply = await new Promise<Extract<DriveReply, { kind: "result" }> | { timeout: true }>((resolve) => {
      const off = host.onReply((m) => {
        if (m.kind === "result" && m.reqId === reqId) {
          clearTimeout(t);
          off();
          resolve(m);
        }
      });
      // Past the time limit the Drive copy is asked to stop and gets a moment to answer with what it did.
      const t = setTimeout(() => {
        host.send({ kind: "abort", reqId, reason: `the ${Math.round(timeoutMs / 1000)} s time limit` });
        setTimeout(() => (off(), resolve({ timeout: true })), 3000);
      }, timeoutMs);
      abortRun = (why) => host.send({ kind: "abort", reqId, reason: why });
      host.send({ kind: "run", reqId, mode: "steps", steps });
    });
    // Stopped inside the Drive copy because Carl's input reached it (a frame host has focus): the same as here.
    if (!abortWhy && "reqId" in reply && reply.aborted?.startsWith("Carl")) {
      abortWhy = reply.aborted;
      noteInput("keydown");
    }
    releaseDriveHost(!!abortWhy || !!tries);
    const base: DriveAckData = { where: host.where, ...(tries ? { tries } : {}), ...(opened.note ? { note: opened.note } : {}), idleSec, ...(abortWhy ? { aborted: abortWhy } : {}) };
    if ("timeout" in reply) return { ok: false, error: `the run did not finish within ${Math.round(timeoutMs / 1000)} s`, data: base };
    if (reply.error) return { ok: false, error: reply.error, data: base };
    if (reply.steps) {
      const { shots, ...rest } = reply.steps;
      return {
        ok: reply.steps.ok && !abortWhy,
        ...(abortWhy ? { error: `${abortWhy}; the run was stopped.` } : {}),
        data: { ...base, steps: { ...rest, shots: shots.map((s: Shot) => ({ name: s.name, width: s.width, height: s.height })) } },
        images: shots.map((s) => ({ data: s.data, mimeType: s.mimeType, name: s.name })),
      };
    }
    return { ok: false, error: "the Drive copy answered with nothing", data: base };
  } catch (e) {
    releaseDriveHost(true);
    return { ok: false, error: String((e as Error)?.message ?? e) };
  } finally {
    offInput();
    try {
      giveBackFocus();
    } catch { /* no DOM (tests) */ }
  }
}
