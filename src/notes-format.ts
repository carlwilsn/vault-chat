// A note's headline and its re-orienting summary: one-shot calls (src/complete.ts).
import { complete } from "./complete";
import { anchorImages, titleableText, type Note } from "./notes";

// A short, scannable headline for the note — DISTINCT from its body, so a list
// of notes doesn't just repeat each note's first line as its own title (the
// "title vs content is poor" complaint). Kept to a handful of plain words.
const TITLE_SYSTEM = `You write the headline for a saved note. Given the note's content, output ONE short title: at most 8 words, plain words, no trailing punctuation, no quotes, no markdown, no label like "Title:". It must read as a distinct headline that names the topic or the ask — NOT a verbatim restatement of the first sentence — so the user can tell this note apart from others at a glance.`;

/** Generate a short headline for a note. Returns "" when there's nothing
 *  meaningful to title. Best paired with a fast/cheap model. */
export async function titleForNote(note: Note): Promise<string> {
  const body = titleableText(note);
  if (!body) return "";
  const text = await complete({ instructions: TITLE_SYSTEM, text: body.slice(0, 4000), fast: true });
  // Defensive cleanup — models sometimes wrap in quotes, prepend "Title:", or
  // tack on a period despite the instruction.
  let t = (text || "")
    .split("\n")
    .map((x) => x.trim())
    .find(Boolean) ?? "";
  t = t
    .replace(/^(title|headline)\s*[:\-]\s*/i, "")
    .replace(/^["'`*#\s]+/, "")
    .replace(/["'`*\s]+$/, "")
    .replace(/[.…]+$/, "")
    .trim();
  return t.slice(0, 80);
}

// Build a one-paragraph orienter that reminds the user later what
// they were stuck on, what they were looking at, and (if the note
// was promoted from an ask) what clarity the agent provided. Kept
// under 80 words so the panel stays scannable.
const FORMAT_SYSTEM = `You are a concise scribe. The user captured a quick "slop note" while working — a question or observation they want to return to. Write 1–2 sentences that re-orient them when they re-read this note later.

Lead with WHERE they were (file name + location). Mention WHAT caught their eye (selection text or image content if you can see it). If there was a conversation with the agent, note the clarity or unresolved question it produced. Past tense, plain prose, no markdown headers or bullets. Under 80 words. Never invent details not in the input.`;

function describeAnchors(note: Note): string {
  if (note.anchors.length === 0) return "No file anchor.";
  return note.anchors
    .map((a, i) => {
      const name = a.source_path.split("/").pop() ?? a.source_path;
      const at = a.source_anchor ? ` (${a.source_anchor})` : "";
      const role = a.primary || i === 0 ? "Primary" : "Secondary";
      return `${role}: ${name}${at}${
        a.source_selection ? ` — selected: "${a.source_selection.slice(0, 300)}"` : ""
      }`;
    })
    .join("\n");
}

export async function formatNote(note: Note): Promise<string> {
  const parts: string[] = [];
  parts.push(describeAnchors(note));

  const primary = note.anchors.find((a) => a.primary) ?? note.anchors[0];
  if (primary?.source_before) parts.push(`File context before:\n${primary.source_before.slice(-800)}`);
  if (primary?.source_after) parts.push(`File context after:\n${primary.source_after.slice(0, 800)}`);
  if (note.user_draft) parts.push(`User's note: ${note.user_draft}`);
  if (note.turns.length > 0) {
    const compact = note.turns.map((t) => `${t.role}: ${t.content}`).join("\n---\n");
    parts.push(`Conversation:\n${compact}`);
  }
  // The captured regions go along, so the scribe can say what was marqueed.
  const images = note.anchors.flatMap((a) => anchorImages(a)).filter((u) => u.startsWith("data:image/"));
  const text = await complete({ instructions: FORMAT_SYSTEM, text: parts.join("\n\n"), images, fast: true });
  return text.trim();
}
