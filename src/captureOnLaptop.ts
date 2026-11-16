// The laptop's half of the agent's Screen tool (server/screenTool.ts): the box puts a {type:"capture", id, to:"laptop",
// target, maxWidth} signal on the feed; src/boxChat.ts hands it here (loaded only then, so it costs nothing until the
// agent looks); the app draws its own window (src/screenCapture.ts) and the ack carries the picture:
// {ok, landed, image:{data, mimeType, width, height}} or {ok:false, error}.
import { useStore } from "./store";
import { CAPTURE_MAX_WIDTH, CAPTURE_TARGETS, type Capture, type CaptureTarget } from "./screenCapture";

export type CaptureSignal = { type: "capture"; id: string; to?: string; target?: unknown; maxWidth?: unknown };
export type CaptureAck = { ok: boolean; landed?: string; error?: string; image?: { data: string; mimeType: string; width: number; height: number } };
export type CaptureDeps = {
  /** Draws the window (default: the app's DOM, src/screenCapture.ts). */
  capture?: (target: CaptureTarget, o: { maxWidth: number; chatFullscreen: boolean; chatPoppedOut: boolean }) => Promise<Capture>;
  /** How long drawing may take before the laptop gives up and says so (default 15 s, under the box's 20 s wait). */
  timeoutMs?: number;
};

type Draw = NonNullable<CaptureDeps["capture"]>;
let driver: Draw | null = null;
/** Replace how this laptop draws its window (null: the app's DOM again). For hosts without a DOM to draw: tests, a
 *  future native capture. */
export function setCaptureDriver(d: Draw | null): void {
  driver = d;
}

export async function captureOnLaptop(sig: CaptureSignal, deps: CaptureDeps = {}): Promise<CaptureAck> {
  const target = (sig.target === undefined ? "window" : sig.target) as CaptureTarget;
  if (!CAPTURE_TARGETS.includes(target)) return { ok: false, error: `unknown capture target "${String(sig.target)}" (window, viewer or chat)` };
  const maxWidth = typeof sig.maxWidth === "number" && sig.maxWidth >= 100 ? Math.min(sig.maxWidth, CAPTURE_MAX_WIDTH) : CAPTURE_MAX_WIDTH;
  const s = useStore.getState();
  const draw = deps.capture ?? driver ?? (async (t, o) => (await import("./screenCapture")).captureWindow(t, o));
  const ms = deps.timeoutMs ?? 15_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const shot = await Promise.race([
      draw(target, { maxWidth, chatFullscreen: s.chatFullscreen, chatPoppedOut: s.popoutOpen }),
      new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error(`drawing the window took over ${Math.round(ms / 1000)} s`)), ms))),
    ]);
    if (shot.width > maxWidth) return { ok: false, error: `the picture came out ${shot.width} px wide, over the ${maxWidth} px cap` };
    return { ok: true, landed: shot.note ?? "", image: { data: shot.data, mimeType: shot.mimeType, width: shot.width, height: shot.height } };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
