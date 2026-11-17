// The voice plugin (Track 1; src/appPlugins.ts VOICE_PLUGIN_ID): the voice controls (./Controls.tsx: the title bar's mic
// and waves, the composer's Mute, fullscreen chat's waves; registered with src/voiceParts.tsx, which the title bar and
// the composer draw in their places) and the box to type to the voice agent (./TextPanel.tsx, drawn in its own root),
// mounted through the plugin host under the supervisor's records. src/VoiceSlot.tsx mounts it in the main window (voice
// runs there). The call itself is core (src/voiceCall.ts): turned off or failing, plain controls stand in (a mic, Mute)
// and voice still works; while the records are unknown the built-in controls are drawn.
//
// It declares what it offers (api.offer, src/pluginOffers.ts): the call (on, connecting, listening, speaking, thinking,
// muted, the tool it runs, its error, where voice went) and the text box as state; start, end, mute / unmute, open or
// close the text box and say a line in text as actions; the call starting, ending, muting and failing as events.
import { createRoot } from "react-dom/client";
import type { PluginApi } from "../../mountHost";
import { useStore } from "../../store";
import { endVoiceCall, isVoiceSessionActive, sendVoiceUserText, setVoiceMicMuted, toggleVoice } from "../../voiceCall";
import { registerVoiceParts } from "../../voiceParts";
import { InlineVoiceWaves, VoiceCockpit, VoiceMicGroup, VoiceMuteButton } from "./Controls";
import { VoiceTextPanel } from "./TextPanel";

type S = ReturnType<typeof useStore.getState>;
const callOf = (s: S) => ({
  on: s.voiceMode,
  connecting: s.voiceConnecting,
  listening: s.voiceListening,
  speaking: s.voiceSpeaking,
  thinking: s.voiceThinking,
  muted: s.voiceMicMuted,
  tool: s.voiceCurrentTool,
  error: s.voiceError,
  notice: s.voiceNotice,
});

/** The plugin's offers (exported for tests). */
export function voiceOffers() {
  const S = () => useStore.getState();
  const needCall = () => {
    if (!isVoiceSessionActive()) throw new Error(S().voiceConnecting ? "the call is still connecting" : "no voice call is live (start one first)");
  };
  return {
    state: {
      call: {
        description: "The voice call: on, connecting, listening, speaking, thinking, muted (the mic: nothing is sent), tool (what the voice agent runs now), error (why it failed), notice (voice moved to another device).",
        read: () => callOf(S()),
      },
      textPanel: {
        description: "The box to type to the voice agent: open.",
        read: () => ({ open: S().voiceTextPanelOpen }),
      },
    },
    actions: {
      start: {
        description: "Start a voice call here (as the mic or Ctrl+D). Only when Carl asks.",
        run: () => {
          const s = S();
          if (!s.vaultPath) throw new Error("no vault is open");
          if (s.voiceMode) return { ...callOf(S()), note: "already on" };
          toggleVoice("agent");
          return callOf(S());
        },
      },
      end: {
        description: "End the voice call.",
        run: async () => {
          if (!S().voiceMode && !isVoiceSessionActive()) return { ...callOf(S()), note: "no call" };
          await endVoiceCall("agent");
          return callOf(S());
        },
      },
      mute: {
        description: "Mute (true) or unmute (false) the mic of the live call (as Mute, Ctrl+Shift+M); left out: toggle.",
        args: { type: "object", properties: { muted: { type: "boolean" } }, additionalProperties: false },
        run: (a: Record<string, unknown>) => {
          needCall();
          setVoiceMicMuted(typeof a.muted === "boolean" ? a.muted : !S().voiceMicMuted);
          return { muted: S().voiceMicMuted };
        },
      },
      openTextPanel: {
        description: "Open (or close) the box to type to the voice agent; only while voice is on. Left out: toggle.",
        args: { type: "object", properties: { open: { type: "boolean" } }, additionalProperties: false },
        run: (a: Record<string, unknown>) => {
          const s = S();
          const open = typeof a.open === "boolean" ? a.open : !s.voiceTextPanelOpen;
          if (open && !s.voiceMode) throw new Error("voice is off (the text box is for a live call)");
          s.setVoiceTextPanelOpen(open);
          return { open: S().voiceTextPanelOpen };
        },
      },
      say: {
        description: "Send a typed line to the live call, as Carl typing it in the text box (a turn of the conversation; the voice says the reply). Only when Carl asks.",
        args: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
        run: (a: Record<string, unknown>) => {
          needCall();
          const text = String(a.text ?? "").trim();
          if (!text) throw new Error("say what");
          if (!sendVoiceUserText(text)) throw new Error("the call did not take it");
          return { sent: true };
        },
      },
    },
    events: {
      started: { description: "A call started (connected)." },
      ended: { description: "The call ended." },
      muted: { description: "The mic was muted or unmuted: muted." },
      failed: { description: "Voice failed: error." },
    },
  };
}

export function mount(el: HTMLElement, api: PluginApi): () => void {
  let alive = true;
  const offers = api.offer(voiceOffers());
  // The call's changes, as events.
  let was = callOf(useStore.getState());
  api.effect(
    useStore.subscribe((s) => {
      const now = callOf(s);
      if (now.on && !now.connecting && !(was.on && !was.connecting)) offers.emit("started");
      if (!now.on && was.on) offers.emit("ended");
      if (now.on && now.muted !== was.muted) offers.emit("muted", { muted: now.muted });
      if (now.error && now.error !== was.error) offers.emit("failed", { error: now.error });
      was = now;
    }),
  );
  // The controls the title bar and the composer draw (a throw in one is this plugin's failure).
  api.effect(registerVoiceParts({ cockpit: VoiceCockpit, mic: VoiceMicGroup, mute: VoiceMuteButton, inlineWaves: InlineVoiceWaves }, (e) => api.error(e)));
  const root = createRoot(el, { onUncaughtError: (e) => api.error(e) });
  queueMicrotask(() => alive && root.render(<VoiceTextPanel />));
  return () => {
    alive = false;
    queueMicrotask(() => root.unmount());
  };
}
