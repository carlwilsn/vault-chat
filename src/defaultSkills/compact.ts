// /compact: compact the conversation's context now (pi's own summary; the raw history stays in its file).
// Typed, the app sends it as a command, not a message (src/chat-controller.ts, the phone's send); asked for in
// words or by voice, the agent runs its Compact tool.
import type { DefaultSkill } from "./index";

export const COMPACT: DefaultSkill = {
  name: "compact",
  description: "Compact the conversation's context now; anything after /compact is what the summary must keep",
  body: "Carl asked to compact this conversation's context now. Call the Compact tool once (put anything he said the summary must keep in `focus`), then tell him in one line that it is done when this turn ends.",
};
