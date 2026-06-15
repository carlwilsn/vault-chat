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

// Mode A of the cockpit transform: turn a background worker/mission thread into
// two clean one-liners for the Activity surface — what it was asked to do, and
// what it's doing / has done now. Job-agnostic and lossy by design (the full
// thread is one tap away). Called at turn completion, so `recentActivity` is the
// turn's final reply (+ a trailing note of which tools it ran). Returns null
// when no fast model is configured — the surface then falls back to raw text.
const STATE_SYSTEM = `You write the status line for a background worker shown on a phone. You'll get the TASK it was handed and its RECENT ACTIVITY (its latest output, and which tools it ran). Produce exactly two lines:

TASK: a plain restatement of what it was asked to do, max ~10 words.
STATUS: what it's doing or just finished, max ~12 words — the upshot, not narration.

Rules: no markdown, no preamble, no meta ("the worker…"). Keep each line a tight phrase, skimmable at a glance. If activity shows it finished or hit an error, say so in STATUS.`;

export async function summarizeWorkerState(
  task: string,
  recentActivity: string,
  apiKeys: Partial<Record<ProviderId, string>>,
): Promise<{ task: string; status: string } | null> {
  const t = (task ?? "").trim();
  if (!t) return null;
  const picked = pickFastModel(apiKeys);
  if (!picked) return null;
  try {
    const model = buildModel(picked.spec, picked.apiKey);
    const res = await generateText({
      model,
      system: STATE_SYSTEM,
      prompt: `TASK:\n${t.slice(0, 4000)}\n\nRECENT ACTIVITY:\n${(recentActivity ?? "").trim().slice(0, 4000) || "(no output yet)"}`,
    });
    const out = res.text.trim();
    if (!out) return null;
    const strip = (s: string, label: string) =>
      s.replace(new RegExp(`^${label}:?\\s*`, "i"), "").trim();
    const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
    const taskLine = lines.find((l) => /^task:/i.test(l)) ?? lines[0] ?? "";
    const statusLine = lines.find((l) => /^status:/i.test(l)) ?? lines[1] ?? "";
    const summTask = strip(taskLine, "task").slice(0, 120);
    const summStatus = strip(statusLine, "status").slice(0, 140);
    if (!summTask && !summStatus) return null;
    return { task: summTask, status: summStatus };
  } catch {
    return null;
  }
}
