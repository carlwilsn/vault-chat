// Where the voice plugin (src/plugins/voice, app/voice) is mounted: the main window's overlays (src/App.tsx; voice runs in
// the main window). Its controls are drawn by the title bar and the composer through src/voiceParts.tsx; its text box is
// drawn by the plugin itself. Turned off or failing, plain controls stand in there (voiceParts), and nothing here: the
// call is core and still works by the mic and Ctrl+D.
import { useEffect } from "react";
import { VOICE_PLUGIN } from "./appPlugins";
import { AppPluginMount, type PluginFallbackInfo } from "./PluginMount";
import { setVoicePartsFailed } from "./voiceParts";
import * as voicePlugin from "./plugins/voice";
import { VoiceTextPanel } from "./plugins/voice/TextPanel";

export function VoiceSlot() {
  return <AppPluginMount plugin={VOICE_PLUGIN} module={voicePlugin} fallback={(f) => (f.pending ? <VoiceTextPanel /> : <VoiceFallback info={f} />)} />;
}

/** Off or failed: tell the controls to draw plain (until the plugin runs again); nothing of its own. */
export function VoiceFallback({ info }: { info: PluginFallbackInfo }) {
  const why = info.off ? null : info.error;
  useEffect(() => {
    if (why) setVoicePartsFailed(why);
    return () => setVoicePartsFailed(null);
  }, [why]);
  return null;
}
