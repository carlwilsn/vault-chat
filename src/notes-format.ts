import { generateText, type ModelMessage } from "ai";
import { buildModel, supportsVision, type ModelSpec } from "./providers";
import { anchorImages, type Note } from "./notes";

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

export async function formatNote(
  note: Note,
  spec: ModelSpec,
  apiKey: string,
): Promise<string> {
  const model = buildModel(spec, apiKey);

  const parts: string[] = [];
  parts.push(describeAnchors(note));

  const primary = note.anchors.find((a) => a.primary) ?? note.anchors[0];
  if (primary?.source_before) {
    parts.push(
      `File context before:\n${primary.source_before.slice(-800)}`,
    );
  }
  if (primary?.source_after) {
    parts.push(`File context after:\n${primary.source_after.slice(0, 800)}`);
  }
  if (note.user_draft) parts.push(`User's note: ${note.user_draft}`);
  if (note.turns.length > 0) {
    const compact = note.turns
      .map((t) => `${t.role}: ${t.content}`)
      .join("\n---\n");
    parts.push(`Conversation:\n${compact}`);
  }

  const textBody = parts.join("\n\n");

  // If the note has an image and the active model supports vision,
  // attach the image so the scribe can describe what the marquee
  // actually captured. Otherwise fall back to text-only.
  const imageUrls = note.anchors.flatMap((a) => anchorImages(a));
  const canSeeImages = imageUrls.length > 0 && supportsVision(spec);

  let messages: ModelMessage[];
  if (canSeeImages) {
    messages = [
      {
        role: "user",
        content: [
          { type: "text", text: textBody },
          ...imageUrls.map((u) => ({ type: "image" as const, image: new URL(u) })),
        ],
      },
    ];
  } else {
    const hint = imageUrls.length > 0
      ? `\n\n(Note: the user captured ${imageUrls.length} image region(s) but the active model can't see them — describe the text context only.)`
      : "";
    messages = [{ role: "user", content: textBody + hint }];
  }

  const { text } = await generateText({
    model,
    system: FORMAT_SYSTEM,
    messages,
  });
  return text.trim();
}
