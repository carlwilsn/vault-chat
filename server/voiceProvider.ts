// Which voice a call speaks and hears with: the one place that decides. vault-chat is free out of the box, so the
// core voice is local (Kokoro TTS, voice af_heart, and Whisper STT, in voice-pipeline/local_voice.py). ElevenLabs is
// the ElevenLabs voice plugin (ELEVENLABS_VOICE_PLUGIN): when it is on and Keys holds an ElevenLabs key, it replaces
// the local voice. The plugin's on/off is its supervisor record (Plugins tool, "Turn off"), not a Settings field; with
// no record a plugin is on, so an install that already has an ElevenLabs key keeps sounding exactly as before.

export const ELEVENLABS_VOICE_PLUGIN = "app/elevenlabs-voice";

export type VoiceProvider = "local" | "elevenlabs";

export function voiceProvider(o: { elevenlabsPluginOn: boolean; elKey: string | null }): VoiceProvider {
  return o.elevenlabsPluginOn && !!o.elKey ? "elevenlabs" : "local";
}
