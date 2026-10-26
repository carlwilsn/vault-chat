// The chat while the agent works, as in Claude Code (src/ChatPane.tsx, src/boxChat.ts):
// the turn runs on the (fake) box; Carl types into the open composer. With text
// the button is Send; with the box empty it is Stop (Esc stops too). A message
// sent goes in at once (pi's steer) and shows in the thread as sent, marked
// "pending" until the agent takes it at its next step; on hover it has Send now
// (cut the step: it starts the next turn), Edit and Cancel. No chips above the
// composer, no Tab-to-queue.
//
// And a file from outside the vault (a PDF in Downloads), attached with + : it
// is read when attached (a chip in the composer) and uploaded to the box with the
// message (src/attachFiles.ts → POST /api/v2/attachment); the message carries it
// as a chip, and the agent gets the box's path.
import type { Scenario, Step } from "./types";
import * as P3 from "./phase3";

const ASK = "Find my notes on eigenvectors and tell me which one is the clearest.";
const STEER = "Only look in the courses folder.";
const COMPOSER = "textarea[placeholder]";
const OUTSIDE_PDF = "/home/carl/Downloads/Discussion_5_Supplementary Notes.pdf";

const fresh: Step = {
  run: async () => {
    const { useStore } = await import(/* @vite-ignore */ "/src/store.ts");
    useStore.getState().newConversation();
  },
};

/** Play records on the fake box for the open chat (what pi would write). */
const onBox = (f: (box: any, conv: string) => void): Step => ({
  run: async () => {
    const { useStore } = await import(/* @vite-ignore */ "/src/store.ts");
    const conv = useStore.getState().activeConversationId as string;
    (window as any).__preview.boxPlay({ log: (box: any) => f(box, conv) });
  },
});

/** Carl asks; the agent starts working (a line, then a search still running). */
const working: Step[] = [
  { chat: true },
  fresh,
  { sleep: 400 },
  { type: ASK, into: COMPOSER },
  { key: "Enter", target: COMPOSER },
  { sleep: 800 },
  onBox((box, conv) => {
    box.say(conv, "Let me look through the vault.");
    box.tool(conv, "glob-1", "Glob", { pattern: "**/*eigen*" });
  }),
  { sleep: 500 },
];

const sent: Step[] = [...working, { type: STEER, into: COMPOSER }, { key: "Enter", target: COMPOSER }, { sleep: 800 }];

const delivered: Step[] = [
  ...sent,
  // pi takes it after the search: the log's message there, then the agent answers it.
  onBox((box, conv) => {
    box.toolDone(conv, "glob-1", "courses/linear-algebra/eigenvectors.md\ncourses/linear-algebra/spectral.md\nscratch/eigen-notes.md");
    const p = box.picture(conv);
    const w = (p?.meta?.pending ?? [])[0];
    if (w) box.deliver(conv, w.id);
    box.say(conv, "Sticking to courses/: two notes there. **linear-algebra/eigenvectors.md** is the clearest — it builds the definition from a picture before the algebra.");
    box.endTurn(conv);
  }),
  { sleep: 800 },
];

const base = {
  group: "Chat · while it works",
  clock: "2026-10-13T10:00:00",
  model: "anthropic/claude-sonnet-5.5",
  build: P3.build,
  surfaces: ["desktop" as const],
};

/** A small PDF (a page of text) at a path outside the vault, for the + picker to return. */
const outsidePdf: Step = {
  run: async () => {
    const fs = await import(/* @vite-ignore */ "/preview/runtime/shims/memfs.ts");
    const text = "BT /F1 12 Tf 72 720 Td (Gauss law: the flux through a closed surface is Q over epsilon zero.) Tj ET";
    const pdf = `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R>>endobj\n4 0 obj<</Length ${text.length}>>stream\n${text}\nendstream endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`;
    fs.mkdirSync("/home/carl/Downloads", { recursive: true });
    fs.writeFileSync(OUTSIDE_PDF, new TextEncoder().encode(pdf));
  },
};

const attach: Step[] = [
  { chat: true },
  fresh,
  outsidePdf,
  { sleep: 300 },
  { click: '[data-el="composer-plus"]' },
  { click: '[data-el="composer-plus-menu"] button', text: /Add photos & files/ },
  { wait: '[data-el="attached-file"]' },
  { type: "What does this say about Gauss's law?", into: COMPOSER },
  { sleep: 300 },
];

export const steerScenarios: Scenario[] = [
  {
    ...base,
    id: "steer-typing",
    title: "While it works — with text, the button is Send",
    notes: "The agent is working (a search running). Carl has typed a message: the button is Send (Enter or a click delivers it to the running agent at once). The placeholder is the ordinary one.",
    open: [...working, { type: STEER, into: COMPOSER }, { sleep: 300 }],
  },
  {
    ...base,
    id: "steer-empty",
    title: "While it works — with nothing typed, the button is Stop",
    notes: "The agent is working and the composer is empty: the button is Stop (Esc stops too).",
    open: working,
  },
  {
    ...base,
    id: "steer-sent",
    title: "While it works — a message sent shows at once, pending until the agent's next step",
    notes: "Carl sent “Only look in the courses folder.” while the search runs: it is in the thread as his message at once, slightly dimmed with a small “pending” mark, below what the agent is doing. Hover it: Send now (cut the current step; the agent answers it next), Edit, Cancel. No chip above the composer.",
    open: sent,
  },
  {
    ...base,
    id: "steer-delivered",
    title: "While it works — taken at the next step, it is an ordinary message",
    notes: "steer-sent, then the search finishes: pi takes the message at its next step — it is a normal message right after the search, and the agent answers it in the same turn.",
    open: delivered,
  },
  {
    ...base,
    id: "attach-outside",
    title: "Attach a PDF from outside the vault",
    notes: "+ → Add photos & files picks /home/carl/Downloads/Discussion_5_Supplementary Notes.pdf (not in the vault). It is read at once and shows as a chip in the composer (name, size, ×). Sent, its bytes go to the box (POST /api/v2/attachment → .vault-chat/attachments/<date>/), and the message names it by that path — never the laptop's path.",
    host: { dialogOpen: OUTSIDE_PDF },
    open: attach,
  },
];
