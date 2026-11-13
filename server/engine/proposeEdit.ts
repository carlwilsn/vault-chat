// ProposeEdit: the one tool that turns Ctrl+K / Ctrl+L into an edit. The agent calls it with the text that should
// replace the open file's selection (or be inserted at the cursor); nothing is written. The proposal reaches the
// popover (SideState.proposals, handled in claude/side.ts), where Carl accepts or rejects it; git is the undo.
import type { ToolSpec } from "./backend";

export const PROPOSE_EDIT = "ProposeEdit";

export const proposeEditSpec: ToolSpec = {
  type: "function",
  name: PROPOSE_EDIT,
  description:
    "Propose an edit to the file Carl has open: newText replaces his SELECTION, or is inserted at his CURSOR when nothing is selected. Nothing is written; he sees the proposal and accepts or rejects it. " +
    "newText is exactly the replacement (no code fences, no commentary), in the file's own style. Call it once per edit you want to offer, then say in a line what you proposed. " +
    "Use it when Carl asks for a change (rewrite, fix, shorten, translate, generate here); answer in words when he only asks a question.",
  inputSchema: {
    type: "object",
    properties: {
      newText: { type: "string", description: "The replacement text for the selection (or the text to insert at the cursor)." },
      note: { type: "string", description: "Optional: one short line saying what changed." },
    },
    required: ["newText"],
    additionalProperties: false,
  },
};
