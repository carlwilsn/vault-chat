// /compact on the box (src/chat-controller.ts → the engine's compact()): the chat
// says "Summarizing the earlier conversation…" with the working spinner from the
// moment it starts, a message Carl sends meanwhile is his message at once, shown
// waiting, and runs right after; when the summary lands the line becomes the
// divider and the context dial reads the size after it.
import type { Scenario, Step } from "./types";
import * as P3 from "./phase3";

const COMPOSER = "textarea[placeholder]";

const fresh: Step = {
  run: async () => {
    const { useStore } = await import(/* @vite-ignore */ "/src/store.ts");
    useStore.getState().newConversation();
  },
};

/** Play records on the fake box for the open chat (what the engine would write). */
const onBox = (f: (box: any, conv: string) => void): Step => ({
  run: async () => {
    const { useStore } = await import(/* @vite-ignore */ "/src/store.ts");
    const conv = useStore.getState().activeConversationId as string;
    (window as any).__preview.boxPlay({ log: (box: any) => f(box, conv) });
  },
});

const send = (text: string): Step[] => [{ type: text, into: COMPOSER }, { sleep: 500 }, { key: "Enter", target: COMPOSER }];

const compacting: Step[] = [
  { chat: true },
  fresh,
  { sleep: 400 },
  ...send("Help me plan the essay on Kant's categorical imperative."),
  { sleep: 700 },
  // A long conversation already: the reply reports a big context (the dial near full).
  onBox((box, conv) => {
    box.append(conv, [{ role: "assistant", content: "Here is a plan in three parts: the formula of universal law, humanity as an end, and the kingdom of ends.", usage: { context: 182_000 } }]);
    box.endTurn(conv);
  }),
  { sleep: 1500 },
  // As Carl types it: "/compact" opens the commands list, Enter picks it, Enter sends it.
  ...send("/compact"),
  { sleep: 500 },
  { key: "Enter", target: COMPOSER },
  { sleep: 2200 },
  ...send("Then list the three sections with one source each."),
  { sleep: 3000 },
];

const landed: Step[] = [
  ...compacting,
  onBox((box, conv) => box.compacted(conv, { before: 182_000, after: 14_200 })),
  { sleep: 1200 },
  onBox((box, conv) => {
    box.say(conv, "1. **Universal law** — *Groundwork* §4:421.\n2. **Humanity as an end** — *Groundwork* §4:429.\n3. **Kingdom of ends** — *Groundwork* §4:433.");
    box.endTurn(conv);
  }),
  { sleep: 1500 },
];

const base = {
  group: "Chat · compaction",
  clock: "2026-11-12T10:00:00",
  model: "anthropic/claude-sonnet-5.5",
  build: P3.build,
  surfaces: ["desktop" as const],
};

export const compactScenarios: Scenario[] = [
  {
    ...base,
    id: "compact-running",
    title: "/compact — the chat says it is summarizing; a message sent meanwhile waits",
    notes: "Carl typed /compact: one quiet line “Summarizing the earlier conversation…” with the working spinner and its time, from the moment it starts. He sent a message meanwhile: it is his message at once, dimmed and marked queued.",
    open: compacting,
  },
  {
    ...base,
    id: "compact-landed",
    title: "/compact — the summary lands: the divider, the new context size, then his message is answered",
    notes: "compact-running, then the summary lands: the line becomes “Earlier conversation summarized” (the sizes before and after under it), the context dial drops from 182k to 14.2k at once, and the message he sent meanwhile runs and is answered.",
    open: landed,
  },
];
