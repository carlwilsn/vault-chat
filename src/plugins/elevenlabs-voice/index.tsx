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
import { onSettingsChanged, saveSetting, setting } from "../../settings";
import { ElevenLabsVoicePanel } from "./Panel";
import { createPanelView, onPanelChanged, panelAct, panelParts, type PanelView } from "./view";

/** The plugin's offers over its panel's view (exported for tests). */
export function elevenLabsVoiceOffers(view: PanelView, emit: (event: string, data?: unknown) => void = () => {}) {
  const voice = () => ({ voiceId: setting("voice"), hasKey: !!keyNamed(ELEVENLABS_VOICE_KEY) });
  return {
    watch: (fn: () => void) => {
      const offs = [view.subscribe(fn), onPanelChanged(fn), onSettingsChanged(fn)];
      return () => offs.forEach((f) => f());
    },
    state: {
      panel: {
        description: "The ElevenLabs voice panel on Carl's screen: open, and its parts while drawn: voices (the account's voices: id, name, unfit?; voiceId chosen, loading, browsing the library, testing, error), health (the Voice health dialog open, pipeline ready, error, failure) and library (while browsing: query, anyUse, results and recommended voices (id, name, accent, gender, sample), playing, adding, loading, error).",
        read: () => ({ open: view.get(), parts: panelParts() }),
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
          view.set(true);
          return { open: true };
        },
      },
      close: {
        description: "Close the panel.",
        run: () => {
          view.set(false);
          return { open: false };
        },
      },
      test: {
        description: "The panel's Test: the chosen voice says a short line on this laptop's speakers.",
        run: async () => {
          await panelAct("voices", "test");
          return panelParts().voices ?? null;
        },
      },
      browseLibrary: {
        description: "Open (or close, open false) the voice library in the panel (its picker's Browse the voice library…).",
        args: { type: "object", properties: { open: { type: "boolean" } }, additionalProperties: false },
        run: (a: Record<string, unknown>) => {
          if (a.open === false && panelParts().library) panelAct("library", "close");
          else panelAct("voices", "browse", { open: a.open !== false });
          return { browsing: a.open !== false };
        },
      },
      searchLibrary: {
        description: "Search the open voice library (its search box; anyUse: its any-use switch); the results are in parts.library.",
        args: { type: "object", properties: { query: { type: "string" }, anyUse: { type: "boolean" } }, additionalProperties: false },
        run: (a: Record<string, unknown>) => {
          panelAct("library", "search", a);
          return { query: a.query ?? null };
        },
      },
      previewLibraryVoice: {
        description: "Play (or stop) a library voice's sample on this laptop (its ▶).",
        args: { type: "object", properties: { voiceId: { type: "string" } }, required: ["voiceId"], additionalProperties: false },
        run: (a: Record<string, unknown>) => {
          panelAct("library", "preview", a);
          return { playing: (panelParts().library as { playing?: unknown } | undefined)?.playing ?? null };
        },
      },
      addLibraryVoice: {
        description: "Pick a library voice (its row): it is added to the account and becomes the voice. Only when Carl asks.",
        args: { type: "object", properties: { voiceId: { type: "string" } }, required: ["voiceId"], additionalProperties: false },
        run: async (a: Record<string, unknown>) => {
          await panelAct("library", "add", a);
          return voice();
        },
      },
      openHealth: {
        description: "Open (or close, open false) the panel's Voice health dialog.",
        args: { type: "object", properties: { open: { type: "boolean" } }, additionalProperties: false },
        run: (a: Record<string, unknown>) => {
          panelAct("health", "open", { open: a.open !== false });
          return { open: a.open !== false };
        },
      },
      setVoice: {
        description: "Set the voice ElevenLabs speaks with (an ElevenLabs voice id; null: the default). Only when Carl asks.",
        args: { type: "object", properties: { voiceId: { type: ["string", "null"] } }, required: ["voiceId"], additionalProperties: false },
        run: async (a: Record<string, unknown>) => {
          // The picker's own choose when the panel is drawn (it checks the voice fits); else the same setting.
          if (typeof a.voiceId === "string" && panelParts().voices) await panelAct("voices", "choose", { voiceId: a.voiceId });
          else {
            const why = await saveSetting("voice", (a.voiceId ?? null) as string | null);
            if (why) throw new Error(why);
          }
          emit("changed", { voiceId: setting("voice") });
          return voice();
        },
      },
    },
    events: {
      changed: { description: "The agent changed the voice: voiceId. Carl's own changes (the panel, its library, health): stateChanged." },
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
