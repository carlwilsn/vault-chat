import { hostToolName } from "./mcpNames";

export const REVIEW_TOOL = "ReadyForReview";
export const KEEP = "Keep";
export const SEND_BACK = "Send back";
/** Between Carl's answer and what the server did with it, in the tool's result (his line is only the answer). */
export const OUTCOME_SEP = "\n\n---\n";

/** Only ordinary questions have actionable options. Historical review results are decoded below. */
export const ASK_TOOLS = new Set(["AskUser"]);

/** Carl's answer in a question tool's result ("Carl answered: …"), without what the server did after; null when none. */
export function answerOf(toolName: string | undefined, result: string): string | null {
  if (!toolName || !(ASK_TOOLS.has(hostToolName(toolName)) || hostToolName(toolName) === REVIEW_TOOL)) return null;
  const m = /^Carl answered: ([\s\S]*)$/.exec(result);
  if (!m) return null;
  return m[1]!.split(OUTCOME_SEP)[0]!.trim();
}
