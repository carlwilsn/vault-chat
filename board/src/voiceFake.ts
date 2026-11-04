// A fake call for the board's preview (`?voice=fake`): the call's shape (src/voiceBrainClient.ts), no network, no
// audio. It connects after a beat, "speaks" for a moment now and then (so the waves show), and records what happened:
// window.__voiceFake. The checks drive it: __voiceFake.drop(why) is the connection closing from the other side
// in the preview.
import type { BrainOptions } from "../../src/voiceBrainClient";
import type { VoiceConv } from "./voice";

export type FakeLog = {
  started: number;
  ended: number;
  muted: boolean;
  /** The conversation each call was started on. */
  convs: string[];
  /** The call closing from the other side. */
  drop?: (why: string) => void;
};

export function fakeCall(): (o: BrainOptions) => Promise<VoiceConv> {
  const w = window as unknown as { __voiceFake?: FakeLog };
  const log: FakeLog = (w.__voiceFake ??= { started: 0, ended: 0, muted: false, convs: [] });
  return async (o) => {
    log.started++;
    log.convs.push(o.convId);
    let open = true;
    let level = 0;
    let speakT = 0;
    const speak = () => {
      if (!open) return;
      o.onMode?.("speaking");
      level = 0.35;
      speakT = window.setTimeout(() => {
        level = 0;
        if (open) o.onMode?.("listening");
        speakT = window.setTimeout(speak, 6000);
      }, 1800);
    };
    const conv: VoiceConv = {
      async endSession() {
        if (!open) return;
        open = false;
        clearTimeout(speakT);
        log.ended++;
      },
      setMicMuted(m) {
        log.muted = m;
      },
      getOutputVolume: () => level * (0.6 + 0.4 * Math.random()),
      getInputVolume: () => 0,
    };
    log.drop = (why) => {
      if (!open) return;
      open = false;
      clearTimeout(speakT);
      o.onDisconnect?.({ reason: "error", message: why });
    };
    setTimeout(() => {
      o.onConnect?.();
      o.onMode?.("listening");
      speakT = window.setTimeout(speak, 2500);
    }, 400);
    return conv;
  };
}
