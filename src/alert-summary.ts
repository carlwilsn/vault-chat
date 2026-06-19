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
export type TimelineStep = { thought: string; action?: string; snag?: boolean };
export type Timeline = { steps: TimelineStep[]; reply: string };

const TIMELINE_SCHEMA = z.object({
  steps: z
    .array(
      z.object({
        thought: z
          .string()
          .describe(
            "ONE COMPLETE logical thought — the full arc of one meaningful piece of the agent's reasoning, in 2-3 natural sentences: what it saw or did, what that means, and what it therefore concluded or decided. SELF-CONTAINED: weave what it actually did into the prose itself (e.g. 'so I read all three threads and re-checked the eval.loss'), don't drop it to a separate field. Let the thought run until the logic is genuinely complete — never cut it short, never pad it, and never force a 'so… so…' template (vary how each one opens). Keep the substance that matters — numbers, the obstacle, the call — and drop the rest. Plain text.",
          ),
        snag: z
          .boolean()
          .describe(
            "true if this update is an obstacle/correction — it hit a problem, a wrong result, or something that didn't work and had to course-correct. These are the most informative updates; mark them so the reader sees the agent handling reality, not just cruising.",
          ),
      }),
    )
    .describe("The chain of complete logical thoughts, in order — only the developments that matter (quality over quantity), each a finished thought, NOT a bolt-by-bolt tool log."),
  reply: z
    .string()
    .describe(
      "The turn's final user-facing conclusion, copied VERBATIM from the END of the narration (do not rewrite or summarize it). Empty string if the turn is pure working with no concluding message.",
    ),
});

const TIMELINE_SYSTEM = `You turn ONE agent turn into a chain of COMPLETE LOGICAL THOUGHTS for a lead checking in on long-running work — someone who wants the reasoning that matters and to trust real progress is happening, NOT a bolt-by-bolt tool log. You get the agent's NARRATION (its prose), optionally its raw REASONING, and the ORDERED list of ACTIONS (tools) it took.

Produce an ordered \`steps\` list. Each step is ONE complete logical thought — the full arc of one meaningful piece of reasoning, 2-3 natural sentences: what it saw or did, what that means, and what it therefore concluded or decided. Each thought is SELF-CONTAINED: weave what it actually did into the prose, don't strip it to a label. Rules that matter:
- Quality over quantity. Only the developments that actually matter — merge routine mechanical steps into the thought they served (five reads that grounded one decision = ONE thought). A big turn might be 2-4 thoughts, not ten.
- Let each thought FINISH. Carry the logic all the way to its conclusion; never cut it short, never pad it.
- Don't force a template. Vary how thoughts open; only use "so"/"because" where the reasoning genuinely turns on it.
- Mark \`snag: true\` when a thought is an obstacle or course-correction (a wrong result, something that didn't work) — those are the most reassuring, they show it dealing with reality.
- Keep the substance (numbers, the obstacle, the call); drop rambling. Do NOT invent reasoning — only clean and merge what you're given.

\`reply\` = the turn's final user-facing conclusion, copied verbatim from the end of the narration (NOT rewritten); empty if there's no distinct conclusion. No markdown.`;

export async function summarizeTimeline(
  narration: string,
  reasoning: string,
  actions: { name: string; input?: unknown }[],
  apiKeys: Partial<Record<ProviderId, string>>,
  role: "supervisor" | "worker" = "worker",
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
  // Role register: a SUPERVISOR reasons about managing its workers and the
  // mission (what it observed in a worker, what it told it, what it spawned, and
  // — usually — what it's now waiting on); a WORKER reasons about executing its
  // own task. The thoughts should read in the right voice.
  const roleNote =
    role === "supervisor"
      ? `These are a SUPERVISOR's thoughts: it manages workers and the overall mission, it does not do the task work itself. Frame each thought as orchestration — what it saw in a worker, how it steered or spawned one, a mission-level call. A supervisor mostly WAITS on its workers, so if the narration ends by handing work off, the final thought should state what it's now waiting on.`
      : `These are a WORKER's thoughts: it executes ONE given task. Frame each thought as task work — what it read/ran/wrote, what it found, what it concluded.`;
  const prompt = [
    roleNote,
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
        thought: String(s.thought ?? "").trim().slice(0, 700),
        snag: !!s.snag,
      }))
      .filter((s) => s.thought);
    const reply = String(object.reply ?? "").trim();
    if (!steps.length && !reply) return null;
    return { steps, reply };
  } catch {
    return null;
  }
}

// Clean a scheduled/background turn for delivery. A scheduled run (the daily
// coach, a supervisor watch) accumulates ALL its text — the "let me re-read the
// files… pulling evidence…" narration between tool calls AND the final message —
// into one blob. Delivering that blob is the bug behind the coach notification
// reading as raw narration instead of the check-in. This returns:
//   - `deliver`: the turn's true closing message. Prefers the timeline's verbatim
//     `reply` (robust even when the model narrated+answered in one tool-less blob),
//     then the post-last-tool segment, then the raw blob as a last resort.
//   - `timeline`: the thought-chain to render the thread as reasoning, not prose.
// One model call, shared by both the headless and active-vault scheduled paths.
export async function cleanReplyAndTimeline(
  rawReply: string,
  finalSegment: string,
  reasoning: string,
  actions: { name: string; input?: unknown }[],
  apiKeys: Partial<Record<ProviderId, string>>,
  role: "supervisor" | "worker" = "worker",
): Promise<{ deliver: string; timeline: Timeline | null }> {
  const timeline = await summarizeTimeline(
    rawReply,
    reasoning,
    actions,
    apiKeys,
    role,
  ).catch(() => null);
  const deliver =
    (timeline?.reply || "").trim() || finalSegment.trim() || tailMessage(rawReply);
  return { deliver, timeline };
}

// Last-resort extraction when no fast model is available to clean the turn (the
// box with a degraded keyring is the real trigger). A scheduled run narrates
// before it concludes — "let me re-read the files… pulling evidence…" up top,
// the actual upshot at the END. Take the final paragraph, never the opening
// narration, so the headline/notification never leaks the chain-of-thought. The
// full blob is always one tap away in the thread, so this can be lossy.
function tailMessage(blob: string): string {
  const paras = (blob || "")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  return paras.length ? paras[paras.length - 1]! : (blob || "").trim();
}
