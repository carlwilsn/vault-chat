// A fake voice session for the board's preview (`?voice=fake`): the ElevenLabs SDK's shape, no
// network, no audio. It connects after a beat, "speaks" for a moment now and then (so the waves
// and the held pushes show), and records what the board sent: window.__voiceFake.
import type { SessionOpts, VoiceConv, VoiceSdk } from "./voice";

export type FakeLog = { started: number; ended: number; updates: { text: string; contextId?: string }[]; files: number; messages: { text?: string; files: number }[]; muted: boolean };

export function fakeSdk(): VoiceSdk {
  const w = window as unknown as { __voiceFake?: FakeLog };
  const log: FakeLog = (w.__voiceFake ??= { started: 0, ended: 0, updates: [], files: 0, messages: [], muted: false });
  return {
    Conversation: {
      async startSession(o: SessionOpts): Promise<VoiceConv> {
        log.started++;
        let open = true;
        let level = 0;
        let speakT = 0;
        const speak = () => {
          if (!open) return;
          o.onModeChange({ mode: "speaking" });
          level = 0.35;
          speakT = window.setTimeout(() => {
            level = 0;
            if (open) o.onModeChange({ mode: "listening" });
            speakT = window.setTimeout(speak, 6000);
          }, 1800);
        };
        const conv: VoiceConv & { connection: { sendMessage(m: Record<string, unknown>): void } } = {
          async endSession() {
            if (!open) return;
            open = false;
            clearTimeout(speakT);
            log.ended++;
            o.onDisconnect();
          },
          setMicMuted(m) {
            log.muted = m;
          },
          sendContextualUpdate(text, opt) {
            log.updates.push({ text, contextId: opt?.contextId });
          },
          async uploadFile() {
            log.files++;
            return { fileId: `fake-${log.files}` };
          },
          sendMultimodalMessage(m) {
            log.messages.push({ text: m.text, files: 1 });
          },
          connection: {
            sendMessage(m) {
              log.messages.push({ text: (m.text as { text?: string } | undefined)?.text, files: Array.isArray(m.files) ? m.files.length : 0 });
            },
          },
          getOutputVolume: () => level * (0.6 + 0.4 * Math.random()),
        };
        setTimeout(() => {
          o.onConnect();
          o.onModeChange({ mode: "listening" });
          speakT = window.setTimeout(speak, 2500);
        }, 400);
        return conv;
      },
    },
  };
}
