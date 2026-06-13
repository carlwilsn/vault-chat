import { generateText } from "ai";
import { buildModel, type ProviderId } from "./providers";
import { pickFastModel } from "./eta-estimator";

// A general, job-agnostic summarizer for the Alerts feed. Any finished agent
// output — a coach briefing, a scheduled report — goes through this so the
// notification reads as a clean "here's what happened", regardless of how the
// job wrote its reply. The full text always stays one tap away in the thread,
// so this can be lossy: it's the headline, not the record. No job has to shape
// its output to look good here.
const SYSTEM = `You turn an agent's finished work into a phone notification. You'll get the agent's full reply (a briefing, a result, a report). Produce exactly:

- Line 1: a short headline, max ~8 words — the upshot, what happened.
- A blank line.
- Then 1-3 plain-text sentences: the essential summary of what was done or found and why it matters.

Rules: no markdown, no bullets, no preamble, no meta ("the agent…", "this briefing…"). Write it as the finished result itself, skimmable on a phone. If the reply is just process narration with no real result, say so plainly in one line.`;

export async function summarizeForAlert(
  reply: string,
  apiKeys: Partial<Record<ProviderId, string>>,
): Promise<{ title: string; body: string } | null> {
  const text = (reply ?? "").trim();
  if (!text) return null;
  const picked = pickFastModel(apiKeys);
  if (!picked) return null;
  try {
    const model = buildModel(picked.spec, picked.apiKey);
    const res = await generateText({
      model,
      system: SYSTEM,
      prompt: text.slice(0, 8000),
    });
    const out = res.text.trim();
    if (!out) return null;
    const lines = out.split("\n");
    const title = lines[0]!.replace(/^#+\s*/, "").trim().slice(0, 90);
    const body = lines.slice(1).join("\n").trim() || title;
    if (!title) return null;
    return { title, body };
  } catch {
    return null;
  }
}
