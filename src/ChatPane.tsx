// The chat pane. Settings in its place when open (src/SettingsPane.tsx, app/settings); otherwise the transcript, part
// `transcript` of the chat pane plugin (src/plugins/chat/Transcript.tsx, app/chat), mounted through the plugin host and
// the supervisor's records (src/PluginMount.tsx AppPluginMount), so a live copy of app/chat runs instead of the
// built-in one. The transcript is how Carl reads the chat, so it never just disappears:
//  - while the records are not known yet, or app/chat is turned off, the same transcript is drawn here in the app's own
//    tree (nothing flashes, nothing looks different; off, the header's plain stand-in says so, and the agent cannot
//    reach the pane's offers);
//  - failing to mount or render (the built-in copy too), a plain transcript stands in (TranscriptFallback): the
//    messages as text, the composer, and one line that says what happened with Reload.
// The rows' offers (app/chat-rows) are mounted here beside it; they draw nothing.
import { memo, useEffect, useRef } from "react";
import { useStore } from "./store";
import { loadSkills } from "./skills";
import { SettingsPane } from "./SettingsPane";
import { CHAT_PLUGIN, CHAT_ROWS_PLUGIN } from "./appPlugins";
import * as chatRowsPlugin from "./plugins/chat-rows";
import * as chatPlugin from "./plugins/chat";
import { Transcript } from "./plugins/chat/Transcript";
import { MessageBubble } from "./plugins/chat-rows/rows";
import { PlaceMount, type PluginFallbackInfo } from "./PluginMount";
import { placeModule } from "./presetApp";
import { ComposerSlot } from "./ComposerPanel";

// The built-in module(s) the preset can mount (src/appPreset.ts; the daily preset puts them in the places below).
placeModule(CHAT_ROWS_PLUGIN, () => chatRowsPlugin);
placeModule(CHAT_PLUGIN, () => chatPlugin.transcript, "transcript");

/** The transcript's row (src/plugins/chat-rows/rows.tsx); exported here as it always was. */
export { MessageBubble };

export function ChatPane() {
  const vaultPath = useStore((s) => s.vaultPath);
  const showSettings = useStore((s) => s.showSettings);
  const setSkills = useStore((s) => s.setSkills);

  useEffect(() => {
    if (vaultPath) {
      loadSkills(vaultPath).then(setSkills).catch(() => setSkills([]));
    } else {
      setSkills([]);
    }
  }, [vaultPath, setSkills]);

  if (showSettings) return <SettingsPane />;
  return (
    <>
      {/* The transcript's rows as a plugin the agent reaches (offers only; it draws nothing of its own). */}
      <PlaceMount place="chat.rows" />
      <TranscriptSlot />
    </>
  );
}

/** The transcript, mounted as app/chat's part `transcript`. Memoized: it reads the store itself. */
export const TranscriptSlot = memo(function TranscriptSlot() {
  return (
    <PlaceMount
      place="chat.transcript"
      fallback={(f) => (f.error === null ? <Transcript /> : <TranscriptFallback info={f} />)}
    />
  );
});

/** The plain transcript: each message's text, the composer, and why the plugin's transcript is not there. */
export function TranscriptFallback({ info }: { info: PluginFallbackInfo }) {
  const messages = useStore((s) => s.messages);
  const streamingText = useStore((s) => s.streamingText);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [messages, streamingText]);
  const shown = messages.filter((m) => !m.hidden && !m.waiting).slice(-200);
  return (
    <div className="h-full flex flex-col bg-card border-l border-border relative" data-el="transcript-fallback">
      <div data-el="transcript-fallback-error" className="shrink-0 flex items-center gap-2 px-3 h-8 text-[12px] text-muted-foreground">
        <span className="truncate" title={info.error ?? ""}>The chat stopped; a plain view until it is back.</span>
        <button type="button" data-el="plugin-reload" onClick={info.retry} className="shrink-0 rounded-md border border-border/60 px-2 py-0.5 text-[11.5px] hover:text-foreground">
          Reload
        </button>
      </div>
      <div ref={ref} className="flex-1 min-h-0 overflow-auto px-3 py-4">
        <div className="max-w-[820px] mx-auto space-y-3 text-[13px]">
          {shown.map((m, i) => (
            <div key={m.mid ?? i} className={m.role === "user" ? "rounded-lg bg-muted/60 px-3 py-2 whitespace-pre-wrap break-words" : "whitespace-pre-wrap break-words"}>
              {m.content}
            </div>
          ))}
          {streamingText && <div className="whitespace-pre-wrap break-words">{streamingText}</div>}
        </div>
      </div>
      <div className="p-3 max-w-[820px] mx-auto w-full">
        <ComposerSlot />
      </div>
    </div>
  );
}
