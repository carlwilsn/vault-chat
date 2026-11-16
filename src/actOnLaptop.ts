// The laptop's half of the agent's Act tool (server/actTool.ts): scripted steps in Carl's REAL app window, for what no
// plugin offers (PluginAct) or Layout covers. The box puts a {type:"act", id, to:"laptop", steps, force, idleMs,
// timeoutMs} signal on the feed; src/boxChat.ts (his main window) hands it here, loaded only then.
//   1. Carl first: if he typed, clicked, scrolled or moved the mouse in the app within `idleMs` (src/userActivity.ts),
//      it refuses, saying when, unless the agent passed `force` (he asked for it now).
//   2. The steps run in this window's own DOM (src/driveSteps.ts): synthetic events only, so nothing outside the app
//      window (other programs, the OS, the desktop) can be touched, and his input detector never mistakes them for him.
//   3. The moment he types, clicks or scrolls in the app the run stops before its next step (mouse movement stops it
//      too, unless forced: he may be watching it work); the ack says so with the steps done so far. The listener exists
//      only while a run is going.
//   4. Read-back: each step's outcome, the app's errors, its visible text, any shot steps, and a picture of the window
//      at the end (the Screen tool's capture).
import { checkSteps, runSteps, type Shot, type Step, type StepsResult } from "./driveSteps";
import { captureOnLaptop } from "./captureOnLaptop";
import { idleMs, onInput } from "./userActivity";

export type ActSignal = { type: "act"; id: string; to?: string; steps?: unknown; force?: unknown; idleMs?: unknown; timeoutMs?: unknown };
export type ActAckData = {
  refused?: boolean;
  aborted?: string;
  idleSec?: number | null;
  steps?: Omit<StepsResult, "shots"> & { shots: { name: string; width: number; height: number }[] };
  /** The picture of the window after the run (the last image), or why there is none. */
  final?: { width: number; height: number } | { error: string };
};
export type ActAck = { ok: boolean; error?: string; data?: ActAckData; images?: { data: string; mimeType: string; name: string }[] };

export type ActRunner = (steps: Step[], o: { signal: AbortSignal; shot: (name: string) => Promise<Shot> }) => Promise<StepsResult>;
let runner: ActRunner | null = null;
/** Replace how the steps run (null: this window's DOM again). For tests, which have no laid-out DOM. */
export function setActRunner(r: ActRunner | null): void {
  runner = r;
}

export const ACT_DEFAULT_IDLE_MS = 30_000;
const fmtIdle = (ms: number) => (ms < 90_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);
const how = (kind: string) => (kind === "keydown" ? "typing" : kind === "pointermove" ? "moving the mouse" : kind === "wheel" ? "scrolling" : "clicking");

let queue: Promise<unknown> = Promise.resolve();
/** One run at a time: a second request waits for the first. */
export function actOnLaptop(sig: ActSignal): Promise<ActAck> {
  const next = queue.then(() => runAct(sig), () => runAct(sig));
  queue = next.catch(() => {});
  return next;
}

async function shot(name: string): Promise<Shot> {
  const c = await captureOnLaptop({ type: "capture", id: `act-shot-${name}`, target: "window", maxWidth: 1600 });
  if (!c.ok || !c.image) throw new Error(`couldn't draw the window: ${c.error ?? "no picture"}`);
  return { name, ...c.image };
}

async function runAct(sig: ActSignal): Promise<ActAck> {
  const steps = checkSteps(sig.steps);
  if (typeof steps === "string") return { ok: false, error: `bad steps: ${steps}` };
  const force = sig.force === true;
  const wantIdle = typeof sig.idleMs === "number" && sig.idleMs >= 0 ? Math.min(sig.idleMs, 60 * 60_000) : ACT_DEFAULT_IDLE_MS;
  const idle = idleMs();
  const idleSec = Number.isFinite(idle) ? Math.round(idle / 1000) : null;
  if (!force && idle < wantIdle) {
    return { ok: false, error: `Carl is using the laptop app: his last key/click/scroll/mouse movement in it was ${fmtIdle(idle)} ago (needs ${fmtIdle(wantIdle)} idle). Nothing was done. Try again later, or pass force if he asked for it now.`, data: { refused: true, idleSec } };
  }
  const timeoutMs = typeof sig.timeoutMs === "number" && sig.timeoutMs > 0 ? Math.min(sig.timeoutMs, 180_000) : 60_000;

  const ac = new AbortController();
  let carl: string | null = null;
  const offInput = onInput((kind) => {
    if (carl || (force && kind === "pointermove")) return;
    carl = `Carl started using the laptop (${how(kind)})`;
    ac.abort(carl);
  });
  const timer = setTimeout(() => ac.abort(`the ${Math.round(timeoutMs / 1000)} s time limit`), timeoutMs);
  let r: StepsResult;
  try {
    const run = runner ?? ((s, o) => runSteps(document, s, o));
    r = await run(steps, { signal: ac.signal, shot });
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e), data: { idleSec } };
  } finally {
    clearTimeout(timer);
    offInput();
  }
  const aborted = r.aborted ?? (ac.signal.aborted ? String(ac.signal.reason) : undefined);
  const images = r.shots.map((s) => ({ data: s.data, mimeType: s.mimeType, name: s.name }));
  // What the window looks like now, whatever happened.
  const fin = await captureOnLaptop({ type: "capture", id: `act-${sig.id}`, target: "window", maxWidth: 1600 });
  let final: ActAckData["final"];
  if (fin.ok && fin.image) {
    images.push({ data: fin.image.data, mimeType: fin.image.mimeType, name: "after" });
    final = { width: fin.image.width, height: fin.image.height };
  } else final = { error: fin.error ?? "no picture" };
  const { shots, ...rest } = r;
  return {
    ok: r.ok && !aborted,
    ...(aborted ? { error: `${aborted}; the run was stopped.` } : {}),
    data: { idleSec, ...(aborted ? { aborted } : {}), steps: { ...rest, shots: shots.map((s) => ({ name: s.name, width: s.width, height: s.height })) }, final },
    images,
  };
}
