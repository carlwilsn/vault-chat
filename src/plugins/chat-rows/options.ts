// The options of the app's own plan and inline-page renderers (src/plugins/chat-rows/rows.tsx registers them; the
// registry keeps their values, src/chatRows.ts; app/chat-rows offers them to the agent and keeps what it sets as records,
// src/plugins/chat-rows/index.ts). Each default is what the chat did before, so nothing looks different until one is set.
import type { RowOptionDef } from "../../chatRows";
import { uiChoice } from "../../uiChoices";
import { parseFrameHint } from "../../inlineHtml";

export type PlanPlacement = "inline" | "pinned" | "hidden";
export type PlanDone = "line" | "full" | "hidden";
export type InlinePlacement = "inline" | "viewer";

export const planOptionDefs: Record<string, RowOptionDef> = {
  placement: {
    description: 'Where the agent\'s plan (TodoWrite) shows: "inline" a card under the reply that wrote it; "pinned" the current plan above the composer while the agent works or a step is left; "hidden" nowhere.',
    values: ["inline", "pinned", "hidden"],
    // The app's earlier switch (src/uiChoices.ts "todos"), read when asked: its default is still the default.
    default: (): PlanPlacement => (uiChoice("todos") === "pinned" ? "pinned" : "inline"),
  },
  done: {
    description: 'A plan with every step done: "line" one quiet "Plan · n/n done" line (click for the steps); "full" every step; "hidden" nothing.',
    values: ["line", "full", "hidden"],
    default: "line",
  },
};

export const inlineHtmlOptionDefs: Record<string, RowOptionDef> = {
  placement: {
    description: 'A vault page shown in a reply: "inline" live in the chat; "viewer" only an "Open in viewer" button (the page runs in the viewer, never in the chat).',
    values: ["inline", "viewer"],
    default: "inline",
  },
  foldInViewer: {
    description: "While the viewer shows the same page beside the chat, the chat's copy folds to an \"Open in viewer\" button (one live copy, not two).",
    values: [true, false],
    default: true,
  },
  size: {
    description: 'The frame\'s size when the page and the reply ask none: "auto" (about 16:10 of the chat\'s width, or the page\'s own height), or "aspect=W/H" / "height=N" (px), as a page\'s <meta name="vc-frame"> says it.',
    check: (v) => (v === "auto" || (typeof v === "string" && parseFrameHint(v) !== null) ? null : '"size" takes "auto", "aspect=W/H" (0.3 to 5) or "height=N"'),
    default: "auto",
  },
  viewerButton: {
    description: 'The "Open in viewer" button in the inline page\'s header.',
    values: [true, false],
    default: true,
  },
};
