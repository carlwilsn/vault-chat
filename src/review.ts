// "You keep it" (server/projectChanges.ts): the proof card a git project's agent hands Carl, the same on the
// laptop and the phone. Its call (ReadyForReview) is shown like AskUser's question: the card, then two actions,
// Keep and Send back; Carl's answer is his own line after it. Pure: the box, the laptop and the phone use it.

import { hostToolName } from "./mcpNames";

export const REVIEW_TOOL = "ReadyForReview";
export const KEEP = "Keep";
export const SEND_BACK = "Send back";
/** Between Carl's answer and what the server did with it, in the tool's result (his line is only the answer). */
export const OUTCOME_SEP = "\n\n---\n";

/** Tools whose call is a question that waits for Carl (a card with its options; his answer is his line). */
export const ASK_TOOLS = new Set(["AskUser", REVIEW_TOOL]);

/** Carl's answer in a question tool's result ("Carl answered: …"), without what the server did after; null when none. */
export function answerOf(toolName: string | undefined, result: string): string | null {
  if (!toolName || !ASK_TOOLS.has(hostToolName(toolName))) return null;
  const m = /^Carl answered: ([\s\S]*)$/.exec(result);
  if (!m) return null;
  return m[1]!.split(OUTCOME_SEP)[0]!.trim();
}

const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
const ext = (p: string) => (/\.[^./\\]+$/.exec(p)?.[0] ?? "").toLowerCase();

/** Where the card's image `i` lives in the vault: the server copies it there, the view finds it from the call alone. */
export function proofImagePath(toolCallId: string, i: number, src: string): string {
  const safe = toolCallId.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 60) || "call";
  const name = base(src).replace(/[^A-Za-z0-9._-]+/g, "_").slice(-60) || `image${ext(src)}`;
  return `.vault-chat/proof/${safe}/${i + 1}-${name}`;
}

/** The card: what changed, why, the tests, the screenshots (vault paths both surfaces show), then Keep / Send back. */
export function reviewCard(callId: string, a: Record<string, unknown> | null | undefined): { content: string; options: { answer: string; title: string; body: string; primary?: boolean }[] } {
  const s = (k: string) => (typeof a?.[k] === "string" ? String(a[k]).trim() : "");
  const branch = s("branch");
  const images = Array.isArray(a?.images) ? (a!.images as unknown[]).map(String).filter(Boolean).slice(0, 8) : [];
  const parts = [`**Ready to keep: ${s("title") || "a change"}**${branch ? ` · \`${branch}\`` : ""}`];
  if (s("what")) parts.push(`**What changed.** ${s("what")}`);
  if (s("why")) parts.push(`**Why.** ${s("why")}`);
  if (s("tests")) parts.push(`**Tests.**\n\n\`\`\`\n${s("tests")}\n\`\`\``);
  // New handoffs have their own explicit artifact ID. Historical transcripts
  // still locate their proof by the old call id.
  const proofId = s("proofId") || callId;
  const shots = images.map((p, i) => proofImagePath(proofId, i, p)).filter((p) => !/\.(mp4|webm)$/i.test(p));
  if (shots.length) parts.push(shots.map((p, i) => `![proof ${i + 1}](${p})`).join("\n"));
  const videos = images.map((p, i) => proofImagePath(proofId, i, p)).filter((p) => /\.(mp4|webm)$/i.test(p));
  if (videos.length) parts.push(videos.map((p) => `[▶ ${base(p)}](${p})`).join("\n"));
  return {
    content: parts.join("\n\n"),
    options: [
      { answer: KEEP, title: KEEP, body: "Merge it into the project's main branch (and push).", primary: true },
      { answer: SEND_BACK, title: SEND_BACK, body: "Or type what to change below: it goes back to the agent, which keeps working on the same branch." },
    ],
  };
}
