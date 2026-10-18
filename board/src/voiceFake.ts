// A fake voice session for the board's preview (`?voice=fake`): the ElevenLabs SDK's shape, no
// network, no audio. It connects after a beat, "speaks" for a moment now and then (so the waves
// and the held pushes show), and records what the board sent: window.__voiceFake. The checks drive it:
// __voiceFake.say(role, text) is a line said in the call, __voiceFake.drop(why) the connection closing from
// the other side (board/preview/voice-thread.mjs).
import type { SessionOpts, VoiceConv, VoiceSdk } from "./voice";

export type FakeLog = {
  started: number;
  ended: number;
  updates: { text: string; contextId?: string }[];
  files: number;
  messages: { text?: string; files: number }[];
  muted: boolean;
  /** A line said in the live call (the SDK's onMessage). */
  say?: (role: "user" | "agent", text: string) => void;
  /** The call closing from the other side (the SDK's onDisconnect with reason "error"). */
  drop?: (why: string) => void;
  /** The agent calling one of the session's client tools (what it returns to the agent). */
  tool?: (name: string, params?: unknown) => Promise<string>;
  /** The client tools the session was given, and its prompt. */
  tools?: string[];
  prompt?: string;
};

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
        log.say = (role, text) => open && o.onMessage({ role, message: text });
        log.tools = Object.keys(o.clientTools);
        log.prompt = (o.overrides as { agent?: { prompt?: { prompt?: string } } })?.agent?.prompt?.prompt ?? "";
        log.tool = async (name, params) => {
          const fn = o.clientTools[name];
          return fn ? fn(params ?? {}) : `no client tool ${name}`;
        };
        log.drop = (why) => {
          if (!open) return;
          open = false;
          clearTimeout(speakT);
          o.onDisconnect({ reason: "error", message: why, closeCode: 1006 });
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
