// Messages sent while the agent works (src/pendingInput.ts), laptop local: the
// scripted model holds its first step (a tool call) open; Carl types two
// messages into the composer, which stays open — Enter steers the running turn,
// Tab queues one for after it. Both show as chips above the composer. Then the
// step finishes: the steer goes into the same turn at its next step (the reply
// so far closes, his message follows, the agent answers it), and the queued one
// runs as the next turn. The before tree: Enter and Tab do nothing while it
// works (only Stop), so neither message goes.
import type { Scenario, Step } from "./types";
import * as P3 from "./phase3";

const ASK = "Find my notes on eigenvectors and tell me which one is the clearest.";
const STEER = "Only look in the courses folder.";
const QUEUE = "Then turn the clearest one into flashcards.";
const COMPOSER = "textarea[placeholder]";

const scripts = [
  { id: "steer-ask", match: /^Find my notes on eigenvectors/, steps: [{ text: "Let me look through the vault.", tools: [{ name: "Glob", args: { pattern: "**/*eigen*" } }], hold: true }] },
  { id: "steer-steer", match: /^Only look in the courses folder/, steps: [{ text: "Sticking to courses/: two notes there. **linear-algebra/eigenvectors.md** is the clearest — it builds the definition from a picture before the algebra." }] },
  { id: "steer-queue", match: /^Then turn the clearest one into flashcards/, steps: [{ text: "Eight flashcards from eigenvectors.md: definition, the characteristic polynomial, why det(A − λI) = 0, diagonalisation, and four worked examples." }] },
];

const fresh: Step = {
  run: async () => {
    const { useStore } = await import(/* @vite-ignore */ "/src/store.ts");
    useStore.getState().newConversation();
  },
};

const sendWhileWorking: Step[] = [
  { chat: true },
  fresh,
  { sleep: 400 },
  { type: ASK, into: COMPOSER },
  { key: "Enter", target: COMPOSER },
  { sleep: 1500 },
  { type: STEER, into: COMPOSER },
  { key: "Enter", target: COMPOSER },
  { sleep: 500 },
  { type: QUEUE, into: COMPOSER },
  { key: "Tab", target: COMPOSER },
  { sleep: 800 },
];

const base = {
  group: "Chat · while it works",
  clock: "2026-10-13T10:00:00",
  model: "anthropic/claude-sonnet-5.5",
  build: P3.build,
  llm: { scripts, chunkMs: 10 },
  surfaces: ["desktop" as const],
};

export const steerScenarios: Scenario[] = [
  {
    ...base,
    id: "steer-queue",
    title: "While it works — Enter steers, Tab queues (chips above the composer)",
    notes:
      "Laptop local, the model scripted. Carl asks; the agent's first step (a search) is held open, so the turn is running. The composer stays open (its placeholder says so): he types “Only look in the courses folder.” and presses Enter — a steer — then “Then turn the clearest one into flashcards.” and Tab — queued. Each is a chip above the composer (“Steering · next step”, “Queued · after this turn”) with Edit (back into the composer) and ×, until it is delivered. Esc stops. steer-queue-delivered plays the rest. Before: Enter and Tab did nothing while it worked.",
    open: sendWhileWorking,
  },
  {
    ...base,
    id: "steer-queue-delivered",
    title: "While it works — the steer lands in the turn, the queued one after it",
    notes:
      "steer-queue, then the held step finishes. The steer is taken at the turn's next step: the reply so far (“Let me look through the vault.” and its search) closes, Carl's message follows it, and the agent answers it in the same turn. Then the queued message runs as the next turn. No chips left. Box mode does the same through the box: a steer is its /message (pi steers the turn), a queued one is held by its engine (/message {queue: true}, the conversation's `queued`; × takes it back). The phone steers (a send while it works) and labels it “Steering · next step”.",
    open: [...sendWhileWorking, { run: () => (window as any).__preview?.release?.() }, { sleep: 3500 }],
  },
];
