// Whether the chat can take a message now, and why not: read by the chat pane (src/ChatPane.tsx: its starting / no box /
// box out of reach screens) and by the composer (src/plugins/composer: its placeholder, Send / Stop, the agent's send).
// One rule, read from the store, so the pane and the composer (a plugin, in its own React root) always agree.
import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "./store";
import { unreachableWhy } from "./boxChat";
import { tailscaleCheck, type TailscaleState } from "./vaultSync";
import { isArchivedThread } from "./conversations";
import { isOlderChat } from "./threads";
import { useAiBlocked } from "./ClaudeCodeSignIn";
import { claudeSignedInNow } from "./claudeAuthLive";

type StoreState = ReturnType<typeof useStore.getState>;

export type ChatGateCore = {
  /** Starting the server this machine runs itself: not on yet, and not a reason to tell him to connect a box. */
  starting: boolean;
  /** No box: nothing to chat with. */
  noBox: boolean;
  /** Connecting to the box (the app just opened, or a failed poll within the grace: src/boxChat.ts connectTiming):
   *  said calmly, and a message sent now waits and goes the moment the box answers. */
  connecting: boolean;
  /** The box out of reach past the grace: Send is off (with the reason) and the feed retries. */
  boxDown: boolean;
  /** The box's own words for why it is out of reach. */
  reason: string;
  /** An older chat (from before one main conversation): readable, not continued. */
  older: boolean;
  /** An old mission thread, or an older chat. */
  archived: boolean;
  /** A message can go now. */
  ready: boolean;
  /** Held for the usage limit (the box picks it up at the reset): Stop cancels that, as it stops a run. */
  held: boolean;
};

/** The gate from the store's state now (no hooks: the composer's agent actions read it too). */
export function chatGateOf(s: Pick<StoreState, "vaultPath" | "boxChat" | "conversations" | "activeConversationId" | "busy" | "messages">): ChatGateCore {
  const vaultPath = s.vaultPath;
  const boxChat = s.boxChat;
  const activeConv = s.conversations.find((c) => c.id === s.activeConversationId);
  const starting = !!vaultPath && boxChat?.starting === true;
  const noBox = !!vaultPath && boxChat?.on === false && !starting;
  const boxDown = !!boxChat?.on && boxChat.reachable === false;
  const connecting = !!boxChat?.on && boxChat.reachable === null;
  const older = !!activeConv && !isArchivedThread(activeConv) && isOlderChat(activeConv);
  const archived = !!activeConv && (isArchivedThread(activeConv) || older);
  const ready = Boolean(vaultPath && boxChat?.on) && !boxDown && !archived;
  const last = s.messages[s.messages.length - 1];
  const held = !s.busy && activeConv?.state === "sleeping" && !!last?.mid?.startsWith("limit:");
  return { starting, noBox, connecting, boxDown, reason: boxChat?.reason ?? "", older, archived, ready, held };
}

/** Signed out of Claude, known now (code that cannot use the hook). */
export const aiBlockedNow = () => claudeSignedInNow() === false;

// Why the box is out of reach (Tailscale, the box itself, or the wait): one check per reason, shared by every reader.
let tsFor: { reason: string; got: Promise<TailscaleState | null> } | null = null;
function tailscaleFor(reason: string): Promise<TailscaleState | null> {
  if (!tsFor || tsFor.reason !== reason) tsFor = { reason, got: tailscaleCheck().catch(() => null) };
  return tsFor.got;
}

export type ChatGate = ChatGateCore & { downWhy: string; aiBlocked: boolean };

/** The gate, live. */
export function useChatGate(): ChatGate {
  const core = useStore(useShallow(chatGateOf));
  // Signed out of Claude: the composer is replaced by the sign-in prompt (the thread stays readable). False until the
  // answer is actually known, so a signed-in Carl never sees "sign in" flash (src/claudeAuthLive.ts).
  const aiBlocked = useAiBlocked();
  const [tailscale, setTailscale] = useState<TailscaleState | null>(null);
  useEffect(() => {
    if (!core.boxDown) {
      tsFor = null; // the next time it is out of reach, asked afresh
      return;
    }
    let alive = true;
    void tailscaleFor(core.reason).then((t) => alive && setTailscale(t));
    return () => {
      alive = false;
    };
  }, [core.boxDown, core.reason]);
  const downWhy = core.boxDown ? unreachableWhy(core.reason, tailscale) : "";
  return { ...core, downWhy, aiBlocked };
}
