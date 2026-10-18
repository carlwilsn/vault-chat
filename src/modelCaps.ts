// Does the voice model picked in Settings → Models do what voice needs? One
// quiet line under the picker: passed, or what's missing. (The agent's models
// are the box's, checked there: BoxModelChecks.)

export type Need = "tools" | "toolChoice" | "images" | "pdf" | "context" | "parallel" | "usage";
type Caps = Partial<Record<Need, boolean>>;
export type Check =
  | { state: "checking" }
  | { state: "passed" }
  | { state: "missing"; missing: Need[] }
  | { state: "unknown"; why: string };

/** Voice must see both the PDF on screen and the images the user shows it. */
const VOICE_NEEDS: Need[] = ["images", "pdf"];

export const NEED_LABEL: Record<Need, string> = {
  tools: "use tools",
  toolChoice: "take a tool choice",
  parallel: "call tools in parallel",
  images: "see images",
  pdf: "see PDFs",
  context: "hold a long chat",
  usage: "report its usage and cost",
};

export function verdict(caps: Caps, needs: Need[]): Check {
  const missing = needs.filter((n) => caps[n] === false);
  if (missing.length) return { state: "missing", missing };
  const open = needs.filter((n) => caps[n] === undefined);
  if (open.length) return { state: "unknown", why: `couldn't confirm it can ${open.map((n) => NEED_LABEL[n]).join(" or ")}` };
  return { state: "passed" };
}

/** The voice agent runs on ElevenLabs: its check is ElevenLabs' own model list
 *  (GET /v1/convai/llm/list — supports_image_input, supports_document_input),
 *  never a guess from the name. */
export async function checkVoiceModel(llm: string, elevenKey?: string | null): Promise<Check> {
  const { voiceLlmList, llmInfo } = await import("./voiceLlms");
  const list = await voiceLlmList(elevenKey);
  if (!list) return { state: "unknown", why: elevenKey ? "ElevenLabs' model list didn't load" : "add an ElevenLabs key to check it" };
  const info = llmInfo(list, llm);
  if (!info) return { state: "unknown", why: "not in ElevenLabs' model list" };
  return verdict({ images: info.images ?? undefined, pdf: info.documents ?? undefined }, VOICE_NEEDS);
}
