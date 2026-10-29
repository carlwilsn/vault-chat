// What of an assistant message is the reply Carl sees and hears, and what is the agent's progress commentary.
//
// GPT-family models (GPT-6.1 Sol and its kin) write a running commentary as plain text in the same message as
// their tool calls ("I'll check the file first…", "Reconnaissance: …"). OpenAI's own API marks it
// `phase: "commentary"`, but vault-chat reaches every model through OpenRouter's chat completions, where that mark
// is gone: it arrives as ordinary text, and every surface showed it as the reply and the voice read it aloud.
// Other models do the same in their own words. The rule that holds for every model: text written beside a tool
// call is commentary on work in progress, never the answer. The answer is the text of a message that ends the
// turn's step without calling a tool. Reasoning itself is pi's thinking block and stays one.
import type { PiMessage } from "./protocol";

type Msg = Pick<PiMessage, "content"> & { stopReason?: unknown };

/** An assistant message that calls a tool (or stopped to call one): its text is progress commentary. */
export function isCommentary(m: Msg | null | undefined): boolean {
  if (!m) return false;
  if (m.stopReason === "toolUse") return true;
  return Array.isArray(m.content) && m.content.some((b: any) => b?.type === "toolCall");
}

/** The reply text of an assistant message ("" for commentary). */
export function replyTextOf(m: Msg | null | undefined): string {
  if (!m || isCommentary(m) || !Array.isArray(m.content)) return "";
  return m.content
    .filter((b: any) => b?.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text as string)
    .join("\n");
}
