// The ElevenLabs voice plugin (src/appPlugins.ts ELEVENLABS_VOICE_PLUGIN_ID, app/elevenlabs-voice). vault-chat's core
// voice is local and free (Kokoro TTS, voice af_heart; Whisper STT): nothing to pick, no voice setting in Settings.
// ElevenLabs is this plugin: while it is on and Keys holds the key ELEVENLABS_API_KEY (an ordinary key, asked for by
// name), calls speak and hear with ElevenLabs
// (the box decides per call: server/voiceProvider.ts, from this plugin's supervisor record); turned off (Plugins tool,
// "Turn off"), calls are local again and this panel and its menu entry go.
//
// What Carl sees: an "ElevenLabs voice" entry in the chat's ⋯ menu (api.host.chat.menuItem) that opens the panel
// (./Panel.tsx: the account's voices, the voice library, Test, the box's voice health), mounted in the app's overlays
// (the daily preset's "overlay" place). The voice it picks is the `voice` setting record (box:settings' "voice"
// key), unchanged from when the picker was in Settings.
//
// It declares what it offers (api.offer, src/pluginOffers.ts): the panel and the voice as state; open, close and
// setVoice as actions; opened / closed / changed as events.
import { createRoot } from "react-dom/client";
import type { PluginApi } from "../../mountHost";
import { keyNamed } from "../../store";
import { ELEVENLABS_VOICE_KEY } from "../../appPlugins";
import { saveSetting, setting } from "../../settings";
import { ElevenLabsVoicePanel } from "./Panel";
import { createPanelView, type PanelView } from "./view";

/** The plugin's offers over its panel's view (exported for tests). */
export function elevenLabsVoiceOffers(view: PanelView, emit: (event: string, data?: unknown) => void = () => {}) {
  const voice = () => ({ voiceId: setting("voice"), hasKey: !!keyNamed(ELEVENLABS_VOICE_KEY) });
  return {
    state: {
      panel: {
        description: "The ElevenLabs voice panel on Carl's screen: open.",
        read: () => ({ open: view.get() }),
      },
      voice: {
        description: "The voice ElevenLabs speaks with on every call (voiceId, the `voice` setting) and whether Keys holds the key ELEVENLABS_API_KEY (hasKey; without one calls use the local voice).",
        read: voice,
      },
    },
    actions: {
      open: {
        description: "Open the ElevenLabs voice panel (the voice picker, the voice library, Test, voice health).",
        run: () => {
          if (!view.get()) {
            view.set(true);
            emit("opened");
          }
          return { open: true };
        },
      },
      close: {
        description: "Close the panel.",
        run: () => {
          if (view.get()) {
            view.set(false);
            emit("closed");
          }
          return { open: false };
        },
      },
      setVoice: {
        description: "Set the voice ElevenLabs speaks with (an ElevenLabs voice id; null: the default). Only when Carl asks.",
        args: { type: "object", properties: { voiceId: { type: ["string", "null"] } }, required: ["voiceId"], additionalProperties: false },
        run: async (a: Record<string, unknown>) => {
          const why = await saveSetting("voice", (a.voiceId ?? null) as string | null);
          if (why) throw new Error(why);
          emit("changed", { voiceId: setting("voice") });
          return voice();
        },
      },
    },
    events: {
      opened: { description: "The panel opened." },
      closed: { description: "The panel closed." },
      changed: { description: "The agent changed the voice: voiceId." },
    },
  };
}

export function mount(el: HTMLElement, api: PluginApi): () => void {
  let alive = true;
  const view = createPanelView();
  const offers = api.offer(elevenLabsVoiceOffers(view, (name, data) => offers.emit(name, data)));
  // The way in: an entry in the chat's ⋯ menu (gone when the plugin stops).
  try {
    api.host.chat.menuItem({ id: "elevenlabs-voice", label: "ElevenLabs voice", title: "Pick the voice ElevenLabs speaks with on calls", order: 50, onClick: () => view.set(true) });
  } catch {
    // No chat menu in this window: the panel still opens through the plugin's open action.
  }
  const root = createRoot(el, { onUncaughtError: (e) => api.error(e) });
  queueMicrotask(() => alive && root.render(<ElevenLabsVoicePanel view={view} />));
  return () => {
    alive = false;
    view.set(false);
    queueMicrotask(() => root.unmount());
  };
}
