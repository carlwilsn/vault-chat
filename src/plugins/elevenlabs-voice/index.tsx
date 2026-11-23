// The ElevenLabs voice plugin (src/appPlugins.ts ELEVENLABS_VOICE_PLUGIN_ID, app/elevenlabs-voice). vault-chat's core
// voice is local and free (Kokoro TTS, voice af_heart; Whisper STT). ElevenLabs is this plugin: while it is on and
// Keys holds the key ELEVENLABS_API_KEY (an ordinary key, asked for by name), calls speak and hear with ElevenLabs (the
// box decides per call: server/voiceProvider.ts, from this plugin's supervisor record); turned off, calls are local.
//
// It draws nothing (Carl 11-23: its panel and ⋯ menu entry went, "gut it out"). The voice ElevenLabs speaks with is the
// `voice` setting (box:settings' "voice" key): Carl or the agent sets it there; this plugin's offers read and set the
// same record, with whether the key is there.
import type { PluginApi } from "../../mountHost";
import { keyNamed } from "../../store";
import { ELEVENLABS_VOICE_KEY } from "../../appPlugins";
import { onSettingsChanged, saveSetting, setting } from "../../settings";

/** The plugin's offers (exported for tests). */
export function elevenLabsVoiceOffers(emit: (event: string, data?: unknown) => void = () => {}) {
  const voice = () => ({ voiceId: setting("voice"), hasKey: !!keyNamed(ELEVENLABS_VOICE_KEY) });
  return {
    watch: (fn: () => void) => onSettingsChanged(fn),
    state: {
      voice: {
        description: "The voice ElevenLabs speaks with on every call (voiceId, the `voice` setting, as box:settings' voice) and whether Keys holds the key ELEVENLABS_API_KEY (hasKey; without one calls use the local voice).",
        read: voice,
      },
    },
    actions: {
      setVoice: {
        description: "Set the voice ElevenLabs speaks with (an ElevenLabs voice id; null: the default), the same as box:settings set voice. Only when Carl asks.",
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
      changed: { description: "The agent changed the voice: voiceId. Any other change (box:settings): stateChanged." },
    },
  };
}

export function mount(_el: HTMLElement, api: PluginApi): () => void {
  const offers = api.offer(elevenLabsVoiceOffers((name, data) => offers.emit(name, data)));
  return () => {};
}
