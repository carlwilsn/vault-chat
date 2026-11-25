// the chat view for any chat, not only the active one. Inside <ChatScope value={id}>
// the transcript (src/plugins/chat/Transcript.tsx) reads that chat's messages and live tail (the box's projection keeps
// every opened chat's messages on its row, and a running one's stream in convRuntime: src/boxChat.ts project), so a
// chat tile is the same component as the chat panel. Outside a scope everything reads the active chat, as before.
import { createContext, useContext } from "react";
import { useStore, type ChatMessage, type LiveTool } from "./store";
import { lastReportedContext } from "./chatContext";

export const ChatScope = createContext<string | null>(null);
export const useChatScope = () => useContext(ChatScope);

type S = ReturnType<typeof useStore.getState>;
const NO_MESSAGES: ChatMessage[] = [];
const NO_TOOLS: LiveTool[] = [];

/** The store as a chat view for `id` sees it: the other fields unchanged (the prototype chain), the chat's own here. */
export function scopedState(s: S, id: string | null): S {
  if (!id || id === s.activeConversationId) return s;
  const conv = s.conversations.find((c) => c.id === id);
  const rt = s.convRuntime[id];
  const o = Object.create(s) as S;
  Object.assign(o, {
    activeConversationId: id,
    messages: conv?.messages ?? NO_MESSAGES,
    busy: conv?.status === "running",
    streamingText: rt?.streamingText ?? "",
    streamingReasoning: rt?.streamingReasoning ?? "",
    liveTools: rt?.liveTools ?? NO_TOOLS,
    // Its context dial and run clock (the composer's footer, src/ChatFooter.tsx), as switching to it would set them.
    lastContext: rt?.lastContext || lastReportedContext(conv?.messages ?? NO_MESSAGES),
    busyStartedAt: conv?.status === "running" ? rt?.startedAt ?? null : null,
  });
  return o;
}

/** useStore, as the chat view in scope sees it. */
export function useScopedStore<T>(selector: (s: S) => T): T {
  const id = useChatScope();
  return useStore((s) => selector(scopedState(s, id)));
}
