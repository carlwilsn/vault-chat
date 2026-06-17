import { generateText, generateObject } from "ai";
import { z } from "zod";
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

Rules: no markdown, no bullets, no preamble, no meta ("the agent…", "this briefing…"). Write it as the finished result itself, skimmable on a phone. Output ONLY the notification text — never address me, never describe your own task, never ask for input. If the input is empty or has no real result to report, output exactly the single word NONE and nothing else.`;

// The summarizer occasionally answers ABOUT its task instead of producing a
// summary — "I need the agent's actual reply…", "I'm ready to convert results
// into notifications", "Please provide the…". That meta-commentary used to leak
// straight into the Alerts feed as a notification title. Reject any output that
// reads as the model talking to us rather than reporting the result.
function looksLikeMeta(s: string): boolean {
  const t = s.trim().toLowerCase();
  if (!t || t === "none") return true;
  if (/^(i need|i'?m ready|i am ready|please provide|i don'?t have|i do not have|there (is|are) no|it seems|i cannot|i can'?t|sorry|as an ai|i'?ll convert|i will convert|once you|provide the)/.test(t))
    return true;
  if (/(actual reply|to turn into a notification|convert (agent )?results?|into (a )?phone notification|no (content|reply|result|output|text)\b.*(to|was|provided)|nothing to (summari|report))/.test(t))
    return true;
  return false;
}

export async function summarizeForAlert(
  reply: string,
  apiKeys: Partial<Record<ProviderId, string>>,
): Promise<{ title: string; body: string } | null> {
  const text = (reply ?? "").trim();
  // Nothing substantive to summarize — don't even ask the model (that's exactly
  // what produced the "I need the agent's actual reply" meta-notifications).
  if (text.length < 4) return null;
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
    if (!out || looksLikeMeta(out)) return null;
    const lines = out.split("\n");
    const title = lines[0]!.replace(/^#+\s*/, "").trim().slice(0, 90);
    const body = lines.slice(1).join("\n").trim() || title;
    if (!title || looksLikeMeta(title)) return null;
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

// Mode B of the cockpit transform: turn an agent's raw thinking + actions into a
// SHORT, clean digest of its reasoning — what it reasoned through and why it
// decided what it did — for the Activity supervisor/worker detail view. The user
// wants the cleaned thought, NOT the raw rambling chain. Uses the reasoning text
// when the model emits it, else falls back to the actions + conclusion. Returns
// null when there's nothing to digest or no fast model is configured.
const THINKING_SYSTEM = `You distill an agent's work into a short "what it was thinking" digest for a phone. You'll get some of: its raw REASONING, the ACTIONS it took (tools), and its CONCLUSION (final reply). Produce 1-3 plain-prose sentences capturing what it reasoned through and why it decided what it did. Drop false starts, rambling, and tool-by-tool narration — keep the line of thought. No markdown, no preamble, no meta ("the agent…"). If there's nothing substantive, give a single short line on what it did.`;

export async function summarizeThinking(
  reasoning: string,
  toolTrace: string,
  reply: string,
  apiKeys: Partial<Record<ProviderId, string>>,
): Promise<string | null> {
  const parts = [
    reasoning?.trim() && `REASONING:\n${reasoning.trim().slice(0, 6000)}`,
    toolTrace?.trim() && `ACTIONS: ${toolTrace.trim().slice(0, 1000)}`,
    reply?.trim() && `CONCLUSION:\n${reply.trim().slice(0, 3000)}`,
  ].filter(Boolean) as string[];
  if (parts.length === 0) return null;
  const picked = pickFastModel(apiKeys);
  if (!picked) return null;
  try {
    const model = buildModel(picked.spec, picked.apiKey);
    const res = await generateText({
      model,
      system: THINKING_SYSTEM,
      prompt: parts.join("\n\n"),
    });
    const out = res.text.trim();
    return out ? out.slice(0, 600) : null;
  } catch {
    return null;
  }
}

// The thought-by-thought timeline: turn ONE worker/mission turn into the
// supervisor's actual line of logic — a sequence of cleaned micro-thoughts, each
// paired with the concrete action it led to — instead of one run-on narration
// blob plus a collapsed "N steps" chip. The model already thinks this way
// ("observed X → decided Y → did Z"); this just untangles the concatenated prose
// and aligns each thought to the real tool call it triggered. NOT a summary —
// every step is preserved; only cleaned and ordered.
export type TimelineStep = { thought: string; action: string };
export type Timeline = { steps: TimelineStep[]; reply: string };

const TIMELINE_SCHEMA = z.object({
  steps: z
    .array(
      z.object({
        thought: z
          .string()
          .describe(
            "The agent's ACTUAL reasoning at this point, cleaned but SUBSTANTIVE — 1-2 full sentences that preserve what it observed, what it concluded, and WHY, so a technical reader can judge the quality of the thinking. NOT a terse 6-word label. Keep the real content (numbers, tradeoffs, doubts); only drop rambling and false starts. Plain text.",
          ),
        action: z
          .string()
          .describe(
            "The concrete action this thought led to, in plain words derived from the ACTIONS list (e.g. 'spawned 3 audit workers', 'asked gpu-seed-sweep-launch to start now', 'wrote the goal file', 'verified the 3 deliverables on disk'). Empty string if this thought led to no tool action.",
          ),
      }),
    )
    .describe("The agent's logic, in order — one step per distinct thought→action."),
  reply: z
    .string()
    .describe(
      "The turn's final user-facing conclusion, copied VERBATIM from the END of the narration (do not rewrite or summarize it). Empty string if the turn is pure working with no concluding message.",
    ),
});

const TIMELINE_SYSTEM = `You untangle ONE agent turn into a clean, thought-by-thought timeline for a technical lead who is REVIEWING how well the agent thinks. You get the agent's NARRATION (its prose — several thoughts run together with no breaks), optionally its raw REASONING, and the ORDERED list of ACTIONS (tools) it actually took.

Produce an ordered \`steps\` list: each step is one cleaned but SUBSTANTIVE thought (1-2 sentences — what it observed, what it concluded, and why) paired with the concrete \`action\` it led to, named from the ACTIONS list in plain human words. The reader is judging reasoning QUALITY, so keep the real substance — the numbers, the tradeoffs, the doubts, the verification — and only drop rambling, filler, and false starts. Do NOT flatten a real chain of reasoning into terse labels, and do NOT invent thoughts or actions: clean, split, and align what you're given. If several actions share one thought, put them in one step's action ("spawned 3 workers"). A thought with no tool gets an empty action.

\`reply\` = the turn's final user-facing conclusion, copied verbatim from the end of the narration (NOT rewritten); empty if there's no distinct conclusion. No markdown in thoughts/actions.`;

export async function summarizeTimeline(
  narration: string,
  reasoning: string,
  actions: { name: string; input?: unknown }[],
  apiKeys: Partial<Record<ProviderId, string>>,
): Promise<Timeline | null> {
  const text = (narration ?? "").trim();
  // Nothing to lay out: no prose AND no actions → no timeline.
  if (text.length < 4 && actions.length === 0) return null;
  const picked = pickFastModel(apiKeys);
  if (!picked) return null;
  const actionList = actions
    .map((a, i) => {
      let detail = "";
      try {
        detail = a.input != null ? JSON.stringify(a.input) : "";
      } catch {
        detail = "";
      }
      return `${i + 1}. ${a.name}${detail ? " " + detail.slice(0, 200) : ""}`;
    })
    .join("\n");
  const prompt = [
    `NARRATION:\n${text.slice(0, 7000) || "(no prose)"}`,
    reasoning?.trim() && `REASONING:\n${reasoning.trim().slice(0, 5000)}`,
    `ACTIONS (in order):\n${actionList || "(none)"}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  try {
    const model = buildModel(picked.spec, picked.apiKey);
    const { object } = await generateObject({
      model,
      schema: TIMELINE_SCHEMA,
      system: TIMELINE_SYSTEM,
      prompt,
    });
    const steps = (object.steps ?? [])
      .map((s) => ({
        thought: String(s.thought ?? "").trim().slice(0, 600),
        action: String(s.action ?? "").trim().slice(0, 160),
      }))
      .filter((s) => s.thought || s.action);
    const reply = String(object.reply ?? "").trim();
    if (!steps.length && !reply) return null;
    return { steps, reply };
  } catch {
    return null;
  }
}
