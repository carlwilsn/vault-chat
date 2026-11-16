// Where the chat composer is mounted. The composer is a plugin (src/plugins/composer, app/composer), mounted by the chat
// pane (src/ChatPane.tsx) through the plugin host and the supervisor's records (src/PluginMount.tsx AppPluginMount).
// The composer is how Carl talks to the agent, so it never just disappears:
//  - while the records are not known yet (the first start in a vault), the composer itself is drawn here in the app's
//    own tree, so nothing is missing and nothing looks different; the plugin takes over with the same draft and focus;
//  - turned off, or failing to mount or render, a minimal built-in composer stands in (ComposerFallback): a plain text
//    box with Send / Stop on the same draft, New chat and the Chats toggle, and one line that says what happened with
//    Turn on / Reload.
import { memo, useEffect, useRef } from "react";
import { ArrowUp, Square } from "lucide-react";
import { useStore } from "./store";
import { COMPOSER_PLUGIN } from "./appPlugins";
import { AppPluginMount, type PluginFallbackInfo } from "./PluginMount";
import { PluginOff } from "./PluginOff";
import { Button, Textarea } from "./ui";
import { useChatGate } from "./chatGate";
import { ChatFooterTools } from "./ChatFooter";
import { ClaudeSignInPrompt } from "./ClaudeCodeSignIn";
import * as composerPlugin from "./plugins/composer";
import { Composer } from "./plugins/composer/Composer";
import { sendDraft, setInput, stopAgent, useDraft } from "./plugins/composer/draft";

/** The composer, in the chat pane under the thread. Memoized: the pane's own redraws (a streaming reply) never reach it. */
export const ComposerSlot = memo(function ComposerSlot() {
  return <AppPluginMount plugin={COMPOSER_PLUGIN} module={composerPlugin} fallback={(f) => (f.pending ? <Composer /> : <ComposerFallback info={f} />)} />;
});

/** The minimal built-in composer: the same draft's text, Enter or Send to send, Stop while the agent works. */
export function ComposerFallback({ info }: { info: PluginFallbackInfo }) {
  const busy = useStore((s) => s.busy);
  const { ready, aiBlocked, archived, held } = useChatGate();
  const input = useDraft((d) => d.input);
  const attached = useDraft((d) => d.images.length + d.files.length);
  const ref = useRef<HTMLTextAreaElement>(null);
  const hasDraft = !!input.trim() || attached > 0;
  useEffect(() => {
    const onFocus = () => ref.current?.focus();
    window.addEventListener("vc-focus-composer", onFocus);
    return () => window.removeEventListener("vc-focus-composer", onFocus);
  }, []);
  const send = () => {
    if (ready && !aiBlocked) void sendDraft();
  };
  return (
    <div data-el="composer-fallback">
      {info.off ? (
        <PluginOff path={COMPOSER_PLUGIN.id} desired={info.off} className="px-1" />
      ) : (
        <div data-el="composer-fallback-error" className="flex items-center gap-2 px-1 pb-1.5 text-[12px] text-muted-foreground">
          <span className="truncate" title={info.error ?? ""}>The composer stopped; a plain one until it is back.</span>
          <button type="button" data-el="plugin-reload" onClick={info.retry} className="shrink-0 rounded-md border border-border/60 px-2 py-0.5 text-[11.5px] hover:text-foreground">
            Reload
          </button>
        </div>
      )}
      {aiBlocked ? (
        <ClaudeSignInPrompt surface="chat" />
      ) : (
        <div className="relative flex items-end rounded-2xl border border-border bg-background focus-within:border-ring/40">
          <Textarea
            ref={ref}
            data-perf-target="composer"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !(e.nativeEvent as { isComposing?: boolean }).isComposing) {
                e.preventDefault();
                send();
              } else if ((busy || held) && e.key === "Escape") {
                e.preventDefault();
                stopAgent();
              }
            }}
            placeholder={ready ? "Ask anything…" : "The chat can't take a message now"}
            disabled={!ready}
            rows={1}
            className="composer-input border-0 bg-transparent min-h-0 max-h-[200px] focus-visible:ring-0 shadow-none !py-2 !pr-12"
          />
          <div className="absolute right-3 bottom-2">
            {(busy || held) && !hasDraft ? (
              <Button size="icon" variant="secondary" onClick={stopAgent} className="h-7 w-7 rounded-lg" title="Stop the agent (Esc)" data-el="composer-stop">
                <Square className="h-3 w-3 fill-current" />
              </Button>
            ) : (
              <Button size="icon" onClick={send} disabled={!ready || !hasDraft} className="h-7 w-7 rounded-lg" title="Send" data-el="composer-send">
                <ArrowUp className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>
      )}
      <div className="flex items-center justify-end px-1 pt-1.5 text-[11px] text-muted-foreground">
        <ChatFooterTools ready={ready} archived={archived} />
      </div>
    </div>
  );
}
