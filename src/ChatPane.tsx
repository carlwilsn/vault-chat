// The chat pane. Settings in its place when open (src/SettingsPane.tsx, app/settings); otherwise the transcript, part
// `transcript` of the chat pane plugin (src/plugins/chat/Transcript.tsx, app/chat), mounted through the plugin host and
// the supervisor's records (src/PluginMount.tsx AppPluginMount). The transcript is how Carl reads the chat, so it never just disappears:
//  - while the records are not known yet, or app/chat is turned off, the same transcript is drawn here in the app's own
//    tree (nothing flashes, nothing looks different; off, the header's plain stand-in says so, and the agent cannot
//    reach the pane's offers);
//  - failing to mount or render (the built-in copy too), a plain transcript stands in (TranscriptFallback): the
//    messages as text, the composer, and one line that says what happened with Reload.
// The rows' offers (app/chat-rows) are mounted here beside it; they draw nothing.
//
// One pane, moved, never remounted: in the main window App mounts ChatPaneHost once, which draws the pane into a
// detached element; every <ChatPane /> there (the docked column, fullscreen chat's frame, even in a plugin's own React
// root) is only a slot that the element moves into. Ctrl+Shift+F used to unmount the pane in one layout and mount a
// new one in the other, re-rendering the last 60 rows' markdown and code highlighting each time (most of the toggle's
// cost, growing with how heavy the newest replies are). Other windows (the popout) draw the pane in place as before.
import { memo, useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useStore } from "./store";
import { loadSkills } from "./skills";
import { SettingsPane } from "./SettingsPane";
import { CHAT_PLUGIN } from "./appPlugins";
import * as chatPlugin from "./plugins/chat";
import { Transcript } from "./plugins/chat/Transcript";
import { MessageBubble } from "./plugins/chat-rows/rows";
import { PlaceMount, type PluginFallbackInfo } from "./PluginMount";
import { placeModule } from "./places";
import { ComposerSlot } from "./ComposerPanel";

// The built-in module(s) of the places below (src/places.ts).
placeModule(CHAT_PLUGIN, () => chatPlugin.transcript, "transcript");

/** The transcript's row (src/plugins/chat-rows/rows.tsx); exported here as it always was. */
export { MessageBubble };

/** The one moved pane of the main window (ChatPaneHost), its element, and its transcript's last scroll. */
const chatHost: { active: boolean; el: HTMLDivElement | null; scroll: { top: number; atBottom: boolean } | null } = { active: false, el: null, scroll: null };

function hostElement(): HTMLDivElement {
  if (chatHost.el) return chatHost.el;
  const el = document.createElement("div");
  el.className = "h-full w-full";
  el.dataset.el = "chat-pane-host";
  // A moved element loses its scroll offsets: keep the transcript's, to put back where it lands.
  el.addEventListener("scroll", (e) => {
    const t = e.target as HTMLElement;
    if (t instanceof HTMLElement && t.dataset.el === "chat-scroll" && t.isConnected && t.clientHeight > 0) {
      chatHost.scroll = { top: t.scrollTop, atBottom: t.scrollHeight - t.scrollTop - t.clientHeight < 40 };
    }
  }, true);
  chatHost.el = el;
  return el;
}

/** The main window's one chat pane (src/App.tsx), drawn into an element that the <ChatPane /> slots move. */
export function ChatPaneHost() {
  chatHost.active = true;
  useEffect(() => {
    chatHost.active = true;
    return () => { chatHost.active = false; };
  }, []);
  return createPortal(<ChatPaneView />, hostElement());
}

/** Where the main window shows the chat: the host's element moves in, the pane keeps its state and rows. */
function ChatPaneSlot() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const slot = ref.current;
    if (!slot) return;
    const el = hostElement();
    slot.appendChild(el);
    const scroller = el.querySelector<HTMLElement>('[data-el="chat-scroll"]');
    const saved = chatHost.scroll;
    if (scroller && saved) {
      scroller.scrollTop = saved.atBottom ? scroller.scrollHeight : saved.top;
      // Rows rewrap to the new width over the next frame: one at the bottom stays there.
      if (saved.atBottom) requestAnimationFrame(() => { if (scroller.isConnected) scroller.scrollTop = scroller.scrollHeight; });
    }
    return () => {
      if (el.parentNode === slot) slot.removeChild(el);
    };
  }, []);
  return <div ref={ref} className="h-full w-full" data-el="chat-pane-slot" />;
}

export function ChatPane() {
  // The main window: a slot for its one pane. Elsewhere (the popout window): the pane itself.
  return chatHost.active ? <ChatPaneSlot /> : <ChatPaneView />;
}

function ChatPaneView() {
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
        <button data-offer="app/titlebar.reloadPart" type="button" data-el="plugin-reload" onClick={info.retry} className="shrink-0 rounded-md border border-border/60 px-2 py-0.5 text-[11.5px] hover:text-foreground">
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
