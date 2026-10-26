// A request that fails and pi retries it (pi's auto_retry, src/convlog/reduce.ts): while it retries, one quiet
// grey "Retrying…" and no red line; a retry that recovers leaves nothing of it; a turn that ends on the failure
// shows one red line, said once, with Try again (a turn that continues, shown as "↻ Trying again").
import type { Scenario, Step } from "./types";
import * as P3 from "./phase3";

const ASK = "Which of my linear algebra notes covers the spectral theorem?";
const COMPOSER = "textarea[placeholder]";

const fresh: Step = {
  run: async () => {
    const { useStore } = await import(/* @vite-ignore */ "/src/store.ts");
    useStore.getState().newConversation();
  },
};

/** Play records on the fake box for the open chat (what pi writes and emits). */
const onBox = (f: (box: any, conv: string) => void): Step => ({
  run: async () => {
    const { useStore } = await import(/* @vite-ignore */ "/src/store.ts");
    const conv = useStore.getState().activeConversationId as string;
    (window as any).__preview.boxPlay({ log: (box: any) => f(box, conv) });
  },
});

/** pi's failed request: its error message (written), then its auto_retry_start (live). */
const failed = (box: any, conv: string, attempt: number) => {
  box.entry(conv, { type: "message", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Connection error.", timestamp: box.stamp() } });
  box.live(conv, { type: "auto_retry_start", attempt, maxAttempts: 4, delayMs: 2000, errorMessage: "Connection error." });
};

const asked: Step[] = [
  { chat: true },
  fresh,
  { sleep: 400 },
  { type: ASK, into: COMPOSER },
  { key: "Enter", target: COMPOSER },
  { sleep: 800 },
  onBox((box, conv) => {
    box.tool(conv, "glob-1", "Glob", { pattern: "**/*spectral*" }, "courses/linear-algebra/spectral.md");
  }),
  { sleep: 300 },
];

const retrying: Step[] = [...asked, onBox((box, conv) => failed(box, conv, 1)), { sleep: 500 }];

const recovered: Step[] = [
  ...retrying,
  onBox((box, conv) => {
    box.say(conv, "**courses/linear-algebra/spectral.md** — it states the spectral theorem for real symmetric matrices and proves it by induction on the dimension.");
    box.live(conv, { type: "auto_retry_end", success: true, attempt: 1 });
    box.endTurn(conv);
  }),
  { sleep: 600 },
];

const gaveUp: Step[] = [
  ...retrying,
  onBox((box, conv) => {
    for (const a of [2, 3, 4]) failed(box, conv, a);
    box.entry(conv, { type: "message", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Connection error.", timestamp: box.stamp() } });
    box.live(conv, { type: "auto_retry_end", success: false, attempt: 4, finalError: "Connection error." });
    box.endTurn(conv, "failed");
  }),
  { sleep: 600 },
];

const base = {
  group: "Chat · a failed request",
  clock: "2026-10-26T10:00:00",
  model: "openai/gpt-6.1-sol",
  build: P3.build,
  surfaces: ["desktop" as const],
};

export const retryScenarios: Scenario[] = [
  {
    ...base,
    id: "retry-running",
    title: "A request failed and pi retries it — one quiet line",
    notes: "The model's request dropped (the box's \"Connection error.\") and pi retries it: one grey “Retrying…” under the work, no red line, no error text.",
    open: retrying,
  },
  {
    ...base,
    id: "retry-recovered",
    title: "The retry worked — nothing of it is left",
    notes: "retry-running, then the retry answers: the reply, and no trace of the failed request or the retry.",
    open: recovered,
  },
  {
    ...base,
    id: "retry-failed",
    title: "Every retry failed — one red line, with Try again",
    notes: "Five tries, all dropped: the turn ends on one red line, said once (“Couldn't get a reply (tried 5 times): Connection error.”), with Try again.",
    open: gaveUp,
  },
];
