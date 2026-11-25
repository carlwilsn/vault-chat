// The composer of a chat tile that isn't the active chat. The full composer (src/plugins/composer) keeps one draft for
// the one active chat (module state its agent offers share); a chat tile that isn't active gets this one: the same
// box, text area and Send / Stop, sending to that chat (boxSend with its id). Clicking into its tile makes that chat
// the active one, and the full composer (attachments, @ and / menus, +) takes its place with its own draft.
import { useRef, useState } from "react";
import { ArrowUp, Square } from "lucide-react";
import { useStore } from "./store";
import { Button, Textarea } from "./ui";
import { cn } from "./lib/utils";
import { boxSend, BOX_UNREACHABLE, CONNECTING } from "./boxChat";
import { stopChat } from "./chat-controller";
import { chatGateOf } from "./chatGate";
import { scopedState } from "./chatScope";
import { ARCHIVED_THREAD, OLDER_CHAT } from "./conversations";
import { ChatModelPicker } from "./ChatModelPicker";
import { ChatFooterTools } from "./ChatFooter";

export function TileComposer({ chatId }: { chatId: string }) {
  const gate = useStore((s) => {
    const g = chatGateOf(scopedState(s, chatId));
    return `${g.ready ? 1 : 0}${g.archived ? 1 : 0}${g.older ? 1 : 0}${g.boxDown ? 1 : 0}`;
  });
  const [ready, archived, older, boxDown] = gate.split("").map((c) => c === "1");
  const busy = useStore((s) => scopedState(s, chatId).busy);
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const send = () => {
    const t = text.trim();
    if (!t || !ready) return;
    setText("");
    void boxSend({ text: t, convId: chatId });
  };
  const placeholder = archived ? (older ? OLDER_CHAT : ARCHIVED_THREAD) : boxDown ? BOX_UNREACHABLE : !ready ? CONNECTING : "Ask anything…";
  return (
    <>
    <div className="relative flex flex-col rounded-2xl border border-border bg-background focus-within:border-ring/40 focus-within:ring-[0.5px] focus-within:ring-ring/20 transition-colors" data-el="tile-composer">
      <div className="relative flex items-end">
        <Textarea
          ref={ref}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            const el = e.target;
            el.style.height = "auto";
            el.style.height = `${Math.min(200, el.scrollHeight)}px`;
          }}
          // Typing here focuses the tile, which makes this the active chat: the full composer takes its place and the focus.
          onFocus={() => setTimeout(() => window.dispatchEvent(new CustomEvent("vc-focus-composer")), 120)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            } else if (e.key === "Escape" && busy) {
              e.preventDefault();
              stopChat(chatId);
            }
          }}
          placeholder={placeholder}
          disabled={!ready && !boxDown}
          rows={1}
          className="composer-input border-0 bg-transparent min-h-0 max-h-[200px] focus-visible:ring-0 shadow-none !py-2 !pl-4 !pr-12"
        />
        <div className="absolute right-3 bottom-2 flex items-center gap-1">
          {busy && !text.trim() ? (
            <Button data-offer="app/composer.stop" size="icon" variant="secondary" onClick={() => stopChat(chatId)} className="h-7 w-7 rounded-lg" title="Stop the agent (Esc)" data-el="tile-composer-stop">
              <Square className="h-3 w-3 fill-current" />
            </Button>
          ) : (
            <Button data-offer="box:chats.post" size="icon" onClick={send} disabled={!ready || !text.trim()} className={cn("h-7 w-7 rounded-lg")} title="Send" data-el="tile-composer-send">
              <ArrowUp className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>
    </div>
    {/* The line under it, as under the chat panel's composer (src/plugins/composer/Composer.tsx): what this chat runs on,
        how hard it thinks, and its own context dial (src/ChatFooter.tsx reads this tile's chat: src/chatScope.ts). */}
    <div className="flex items-center justify-between px-1 pt-1.5 text-[11px] text-muted-foreground" data-el="tile-composer-footer">
      <div className="flex items-center gap-3 min-w-0">
        <ChatModelPicker convId={chatId} />
      </div>
      <ChatFooterTools ready={ready} archived={archived} />
    </div>
    </>
  );
}
