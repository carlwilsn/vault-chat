// The full test conversation (standing test): one conversation carrying every
// element a chat can show — a long streamed markdown reply (a table, code,
// inline and display LaTeX in both `$` and `\(\)`/`\[\]` forms), thinking, tool
// calls, a to-do list updated twice, two subagents (one done with its cost and
// summary while the other runs), a background wake (sleeping with its next
// time, then waking), an AskUser with options answered, a Done with the
// verifier's verdict, a roll-over with its recap, an image sent, cost, the
// context dial near its limit and one error with a retry.
//
//   A  laptop with a box  — the fake box's poll events (boxNext) and its record
//                           of what the laptop sends (live)
//   B  laptop local       — the scripted model (runtime/llm.ts); local mode has
//                           no subagents, wakes or Done verifier: those are the box's
//   C  phone              — the phone's scripted mock box (__vcPhoneNext)
//
// `drive` stages are what preview/conv-check.mjs plays one at a time, asserting
// between them; `open` plays them all for a person looking at the scenario.
// The presentation choices still open (src/uiChoices.ts) each get a scenario
// per option: conv-a-<choice>-<option>, phone conv-c-<choice>-<option>.
import type { Beat, BuildCtx, PhoneStep, Scenario, Step, StepApi } from "./types";
import type { Script } from "../runtime/llm";
import * as P3 from "./phase3";

const MIN = 60_000;
const HOUR = 60 * MIN;
const BOX = { box: "https://thinkbox.tail0a1b2.ts.net", vault: "summer-demo" };
const CONV = "x-full";
const TITLE = "KV-cache section for the writeup";
const F = "```";

// ---- the content ---------------------------------------------------------------

export const FIRST_SENTENCE = "Here is the KV-cache section, written for the writeup.";
export const LAST_SENTENCE = "That is the whole section; the table and the bound are what the writeup needs.";

const METHOD_NOTES = [
  ["Quantized KV (4-bit)", "Stores keys and values in 4 bits with a per-channel scale. Memory drops about fourfold against fp16, and the survey's numbers show perplexity within 0.05 of the full cache up to 32k tokens. It is the only method here that needs no change to the attention pattern, which is why it is the one we would actually use: the kernel change is local and the eval harness does not move."],
  ["Grouped-query attention", "Shares each key/value head across a group of query heads. With eight groups the cache shrinks eightfold, but it is an architecture change: it has to be trained in from the start or recovered with uptraining, so it does not apply to the checkpoints we already have."],
  ["Sliding-window eviction", "Keeps only the last W tokens of the cache. Memory is bounded by the window, not the sequence, at the price of everything older than W; the survey shows retrieval past the window failing outright, so it is a poor fit for long-document questions."],
  ["Heavy-hitter eviction (H2O)", "Keeps the tokens with the largest accumulated attention plus a recent window. It holds quality better than a plain window at the same budget, but the bookkeeping costs a pass over the attention scores every step, which the survey measures at about 6% of decode time."],
  ["Low-rank KV projection", "Projects keys and values into a smaller subspace before caching. Savings scale with the rank chosen (2–4× at the ranks the survey tests), and the error grows quickly below rank 64 for our head size, so it would need a per-layer rank search."],
  ["Paged allocation", "Allocates the cache in fixed pages instead of one contiguous block. It saves no memory per token, but it removes fragmentation, so more sequences fit in the same pool; it composes with every method above and is worth having regardless."],
];

export const LONG_REPLY = [
  FIRST_SENTENCE + " The survey (pages 40–80) groups the methods by what they give up: precision, heads, or history.",
  "",
  "## Memory against quality",
  "",
  "| Method | Memory vs fp16 | Quality at 32k | Needs retraining |",
  "|---|---|---|---|",
  "| Quantized KV (4-bit) | 4× less | within 0.05 ppl | no |",
  "| Grouped-query attention | 8× less | within 0.1 ppl | yes |",
  "| Sliding window | bounded | fails past the window | no |",
  "| H2O eviction | 5× less | within 0.2 ppl | no |",
  "| Low-rank projection | 2–4× less | depends on rank | no |",
  "| Paged allocation | same | same | no |",
  "",
  String.raw`For a cache of $L$ layers, $H$ heads of size $d$ and a sequence of \(n\) tokens at $b$ bits, the memory is`,
  "",
  String.raw`$$M = 2\,L\,H\,d\,n\,\frac{b}{8}\ \text{bytes},$$`,
  "",
  String.raw`so going from \(b = 16\) to $b = 4$ divides it by four. The quantization error of one entry with scale $\alpha$ is bounded by`,
  "",
  String.raw`\[ |x - \hat{x}| \le \frac{\alpha}{2^{b} - 1}, \qquad \alpha = \max_i |x_i|, \]`,
  "",
  "which is what keeps the perplexity change small: attention averages the errors over many keys.",
  "",
  "## The kernel change",
  "",
  F + "python",
  "def quantize_kv(x, bits=4):",
  "    # per-channel scale, symmetric, round to nearest",
  "    scale = x.abs().amax(dim=-1, keepdim=True) / (2 ** (bits - 1) - 1)",
  "    q = torch.clamp(torch.round(x / scale), -(2 ** (bits - 1)), 2 ** (bits - 1) - 1)",
  "    return q.to(torch.int8), scale",
  F,
  "",
  "## Per-method notes",
  "",
  ...METHOD_NOTES.flatMap(([h, t]) => [`**${h}.** ${t}`, ""]),
  "## What it means for our 160M model",
  "",
  ...[512, 2048, 8192, 32768].map((n) => {
    const fp16 = (2 * 12 * 12 * 64 * n * 2) / 2 ** 20;
    return `- At ${n.toLocaleString("en-US")} tokens the fp16 cache is ${fp16.toFixed(1)} MiB per sequence; at 4 bits it is ${(fp16 / 4).toFixed(1)} MiB, so a 24 GiB card holds about ${Math.floor((24 * 1024) / (fp16 / 4))} sequences of that length instead of ${Math.floor((24 * 1024) / fp16)}.`;
  }),
  "",
  "The model itself is small (160M parameters, about 320 MiB in fp16), so past a few thousand tokens the cache, not the weights, decides how many sequences fit. That is the argument for putting the 4-bit cache in the serving section rather than in future work.",
  "",
  "## Caveats",
  "",
  "1. The survey's quality numbers are for 7B-class models; small models have fewer heads to average the quantization error over, so the perplexity change could be larger for us. We should measure it on the eval shard before claiming the 0.05 figure.",
  "2. The bound above is per entry. The error that matters is in the attention output, which the survey bounds only empirically; the writeup should say so rather than imply a guarantee.",
  "3. Per-channel scales cost memory too: one fp16 scale per channel per token block. At a block of 64 tokens that is under 1% of the cache, which is why it does not appear in the table.",
  "4. None of this changes training. The ternary weights and the 1.7B-token runs stay exactly as they are; the cache is a serving-time choice.",
  "",
  "## How we would measure it",
  "",
  "The claim worth making is narrow: at our size, a 4-bit cache costs less than some stated amount of eval loss at each context length we care about. Three runs settle it, all on the existing checkpoints and none of them a training run.",
  "",
  "First, the baseline: the fp16 cache on the held-out shard at 512, 2,048 and 8,192 tokens, recording eval loss and peak memory per sequence. We already have the 512-token number (1.559 ± 0.001 across the three seeds); the longer contexts need the eval script's `--ctx` flag, which exists but has not been used since the switch to the ternary layers.",
  "",
  "Second, the same three lengths with the cache quantized to 8 and to 4 bits, per-channel scales, blocks of 64 tokens. If the 8-bit run differs from fp16 by more than the seed spread (0.0025 nat), something in the kernel is wrong rather than in the idea, and that is the first thing to rule out.",
  "",
  "Third, a short sanity pass on generation: the first 200 tokens greedy from ten fixed prompts, fp16 against 4-bit, compared token by token. A small model that drifts here will drift visibly, which the loss alone can hide when the errors are rare but compounding.",
  "",
  "Each run takes minutes on the A10, so the whole measurement costs less than a single training seed. The numbers go into the table as a fifth column, *measured on our model*, beside the survey's figures; where they disagree, ours win and the text says why.",
  "",
  "## Where it goes in the writeup",
  "",
  "A short subsection under *Serving cost*: the table trimmed to the methods that need no retraining, the memory formula, the bound with its caveat, and the kernel snippet in an appendix. About half a page. The related-work paragraph can cite the survey once for all six methods instead of six separate citations.",
  "",
  LAST_SENTENCE,
].join("\n");

export const THINKING =
  "The survey's section 4 lists six methods. Carl wants the writeup to say which one fits our 160M setup. Check the memory factors: 4-bit KV is 4× against fp16; GQA 8× but needs retraining, so it is out for the existing checkpoints. Put the formula for the cache size and the quantization bound in, both as display math. Two subagents can read the PDF pages and the quantization note in parallel.";

export const TODOS = [
  [
    { content: "Read the survey's KV-cache section", status: "in_progress", activeForm: "Reading the survey's KV-cache section" },
    { content: "Pull the memory numbers into a table", status: "pending" },
    { content: "Write the math for the 4-bit cache", status: "pending" },
    { content: "Draft the writeup section", status: "pending" },
  ],
  [
    { content: "Read the survey's KV-cache section", status: "completed" },
    { content: "Pull the memory numbers into a table", status: "completed" },
    { content: "Write the math for the 4-bit cache", status: "in_progress", activeForm: "Writing the math for the 4-bit cache" },
    { content: "Draft the writeup section", status: "pending" },
  ],
  [
    { content: "Read the survey's KV-cache section", status: "completed" },
    { content: "Pull the memory numbers into a table", status: "completed" },
    { content: "Write the math for the 4-bit cache", status: "completed" },
    { content: "Draft the writeup section", status: "completed" },
  ],
];

const TASKS = [
  "Read papers/attention-survey.pdf pages 40-80 and list every KV-cache compression method with its memory saving.",
  "Read reading/kv-quant.md and give the 4-bit quantization error bound with its source.",
];
const SA_RUNNING = (now: number) => [
  { threadId: "sa_k1", task: TASKS[0], agent: "researcher", model: "anthropic/claude-haiku-5.5", state: "running", status: "running", costUsd: 0, startedAt: now, toolCallId: "call_sub_1" },
  { threadId: "sa_k2", task: TASKS[1], agent: "researcher", model: "anthropic/claude-haiku-5.5", state: "running", status: "running", costUsd: 0, startedAt: now, toolCallId: "call_sub_1" },
];
const SA_ONE_DONE = (now: number) => [
  { ...SA_RUNNING(now)[0], state: "completed", status: "completed", costUsd: 0.09, endedAt: now + 2 * MIN, summary: "Six methods; 4-bit quantized KV saves the most without retraining (~4×)." },
  SA_RUNNING(now)[1],
];
const SA_DONE = (now: number) => [
  SA_ONE_DONE(now)[0],
  { ...SA_RUNNING(now)[1], state: "completed", status: "completed", costUsd: 0.05, endedAt: now + 3 * MIN, summary: "Bound: |x − x̂| ≤ α/(2^b − 1), from the note's Eq. 3." },
];

export const ASK_QUESTION = "Which version goes into the writeup?";
export const ASK_OPTIONS = [
  { answer: "The full table", title: "The full table", body: "All six methods with memory and quality, as above." },
  { answer: "Only 4-bit KV", title: "Only 4-bit KV", body: "The one method we will use, with its error bound and the kernel change.", primary: true },
];
export const ASK_ANSWER = "Only 4-bit KV";
const RECAP =
  "## Where we are\n\nThe 160M runs are stable across three seeds (eval loss 1.559 ± 0.001); the 0.13-nat gap to the reference is the token budget. Carl asked for a KV-cache section in the writeup, from the attention survey.\n\n## Next\n\nRead the survey's section 4, put the methods in a table, and add the 4-bit cache math.";
export const ERROR_TEXT = "⚠️ The turn failed: Provider returned error 502 (upstream connect error or disconnect/reset before headers)";
export const VERDICT_NOTE = "writeup.md has the table, both formulas and the kernel snippet; the build passes";
const CONTEXT = 182_000;
const WINDOW = 200_000;

// ---- A: the box --------------------------------------------------------------

const u = (content: string, extra: Record<string, unknown> = {}) => ({ role: "user", content, ...extra });
const a = (content: string, extra: Record<string, unknown> = {}) => ({ role: "assistant", content, ...extra });
const sys = (content: string, extra: Record<string, unknown> = {}) => ({ role: "assistant", content, system: true, ...extra });
const call = (id: string, name: string, input: unknown, result?: string, extra: Record<string, unknown> = {}) => ({ id, name, input, ...(result !== undefined ? { result } : {}), ...extra });

function history(now: number): any[] {
  return [
    u("Where did we leave the BitNet writeup?"),
    a("The results table and the setup section are in; what's missing is the related-work paragraph and a section on serving cost.", { costUsd: 0.02 }),
    sys("Rolled over to a fresh session", { rollover: { at: now - 30 * MIN, fromThread: "thr_full_1", recap: RECAP } }),
  ];
}

export const FIRST_ASK = "Write the KV-cache section for the writeup from the attention survey — the methods, a table, and the math for the 4-bit cache.";

function finalReply(now: number) {
  return a(LONG_REPLY, {
    thinking: THINKING,
    toolCalls: [
      call("call_todo_1", "TodoWrite", { todos: TODOS[0] }, "updated: 4 items (0 done, 1 active, 3 pending)"),
      call("call_sub_1", "subagent", { tasks: TASKS.map((task) => ({ agent: "researcher", task })) }, "Parallel: 2/2 succeeded", { subagents: ["sa_k1", "sa_k2"] }),
      call("call_todo_2", "TodoWrite", { todos: TODOS[1] }, "updated: 4 items (2 done, 1 active, 1 pending)"),
      call("call_edit_1", "edit", { path: "projects/bitnet-160m/writeup.md" }, "Edited projects/bitnet-160m/writeup.md (+48 −0)"),
      call("call_todo_3", "TodoWrite", { todos: TODOS[2] }, "updated: 4 items (4 done, 0 active, 0 pending)"),
    ],
    costUsd: 0.34,
    usage: { prompt: CONTEXT - 600, completion: 2400, total: CONTEXT + 1800, context: CONTEXT - 600, window: WINDOW },
    turnId: "turn_full_1",
    mid: "m_full_1",
  });
}

/** Seven pieces of the reply as the box streams it: offset + delta, the first a keyframe. */
function streamEvents(id: string): any[] {
  const cuts = [0, 1500, 3200, 4700, 6100, LONG_REPLY.length - 400, LONG_REPLY.length];
  const out: any[] = [];
  for (let i = 1; i < cuts.length; i++) {
    const upto = LONG_REPLY.slice(0, cuts[i]);
    out.push({ type: "runtime", convId: id, text: upto.slice(-6000), offset: cuts[i - 1], delta: LONG_REPLY.slice(cuts[i - 1], cuts[i]), len: cuts[i], tool: "", context: CONTEXT - 4000, window: WINDOW });
  }
  return out;
}

function boxConv(now: number) {
  return {
    title: TITLE,
    source: "manual",
    status: "idle" as const,
    meta: { project: "bitnet-160m", state: "idle", costUsd: 0.06, threadId: "thr_full_2", lastActivityAt: now - 2 * MIN, createdAt: now - 3 * HOUR },
    messages: history(now),
  };
}

function boxSteps(now: number) {
  const id = CONV;
  const wakeAt = Math.round((now + 32 * MIN) / MIN) * MIN;
  return [
    // 0: thinking streams, the plan's first version, a tool runs
    {
      meta: { [id]: { state: "running", todos: TODOS[0] } },
      events: [
        { type: "runtime", convId: id, text: "", offset: 0, delta: "", len: 0, tool: "read", reasoning: THINKING, context: CONTEXT - 9000, window: WINDOW },
        { type: "meta", convId: id },
      ],
    },
    // 1: two subagents start, from one `subagent` call
    { meta: { [id]: { subagents: SA_RUNNING(now) } }, events: [{ type: "runtime", convId: id, text: "", offset: 0, delta: "", len: 0, tool: "subagent", context: CONTEXT - 8000, window: WINDOW }, { type: "meta", convId: id }] },
    // 2: one done (cost, summary), one still running
    { meta: { [id]: { subagents: SA_ONE_DONE(now) } }, events: [{ type: "meta", convId: id }] },
    // 3: the plan's second version; the reply streams in seven pieces (past 6,000 characters)
    { meta: { [id]: { todos: TODOS[1] } }, events: [{ type: "meta", convId: id }, ...streamEvents(id)] },
    // 4: both done; the reply lands with its thinking, tools and cost; the plan's last version
    {
      append: { [id]: [finalReply(now)] },
      meta: { [id]: { state: "idle", subagents: SA_DONE(now), todos: TODOS[2], costUsd: 0.4 } },
      status: { [id]: "idle" as const },
      events: [{ type: "message", convId: id, role: "assistant" }, { type: "status", convId: id, status: "idle" }, { type: "meta", convId: id }],
    },
    // 5: an AskUser with options; the conversation waits for Carl
    {
      append: { [id]: [a(`**❓ ${ASK_QUESTION}**\n\n${ASK_OPTIONS.map((o, i) => `${i + 1}. ${o.answer}`).join("\n")}`, { askOptions: ASK_OPTIONS, toolCalls: [call("call_ask_1", "AskUser", { question: ASK_QUESTION, options: ASK_OPTIONS.map((o) => o.answer) })] })] },
      meta: { [id]: { state: "waiting_user", pendingAsk: { question: ASK_QUESTION, options: ASK_OPTIONS.map((o) => o.answer), at: now } } },
      events: [{ type: "message", convId: id, role: "assistant" }, { type: "meta", convId: id }],
    },
    // 6 (after the answer): the reply, a wake scheduled; sleeping with its next time
    {
      append: { [id]: [a("Going with the 4-bit section only — table trimmed to that row, the bound and the kernel snippet kept. I'll check the writeup builds once the figures job finishes.", { toolCalls: [call("call_edit_2", "edit", { path: "projects/bitnet-160m/writeup.md" }, "Edited (+6 −31)"), call("call_sw_1", "ScheduleWake", { in: "32m", reason: "Checking the writeup build" }, "Wake scheduled")], costUsd: 0.05, usage: { prompt: CONTEXT - 300, completion: 300, total: CONTEXT, context: CONTEXT - 300, window: WINDOW } })] },
      meta: { [id]: { state: "sleeping", nextWakeAt: wakeAt, pendingAsk: undefined, costUsd: 0.45 } },
      status: { [id]: "idle" as const },
      events: [{ type: "message", convId: id, role: "assistant" }, { type: "status", convId: id, status: "idle" }, { type: "meta", convId: id }],
    },
    // 7: the wake fires
    {
      append: { [id]: [u("⏰ Wake: Checking the writeup build", { system: true })] },
      meta: { [id]: { state: "running", nextWakeAt: undefined } },
      status: { [id]: "running" as const },
      events: [{ type: "message", convId: id, role: "user" }, { type: "status", convId: id, status: "running" }, { type: "runtime", convId: id, text: "", offset: 0, delta: "Checking the build…", len: 19, tool: "bash" }, { type: "meta", convId: id }],
    },
    // 8: the turn fails (an error)
    {
      append: { [id]: [a(ERROR_TEXT, { failed: true })] },
      meta: { [id]: { state: "idle" } },
      status: { [id]: "idle" as const },
      events: [{ type: "message", convId: id, role: "assistant" }, { type: "status", convId: id, status: "idle" }, { type: "meta", convId: id }],
    },
    // 9 (after "Try again"): the retry works
    {
      append: { [id]: [a("Retried: the writeup builds (`make writeup`, 0 warnings) and the section renders with both formulas.", { toolCalls: [call("call_bash_1", "bash", { command: "make writeup" }, "pdflatex … 0 warnings")], costUsd: 0.03, usage: { prompt: CONTEXT, completion: 200, total: CONTEXT + 200, context: CONTEXT, window: WINDOW } })] },
      meta: { [id]: { state: "idle", costUsd: 0.48 } },
      status: { [id]: "idle" as const },
      events: [{ type: "message", convId: id, role: "assistant" }, { type: "status", convId: id, status: "idle" }, { type: "meta", convId: id }],
    },
    // 10 (after the image): the reply about it, then Done with the verifier's verdict
    {
      append: {
        [id]: [
          a("The curve looks right: the bump near step 2,000 is the usual early-training spike and it rejoins the trend within ~150 steps.\n\nThe section is in; calling it done.", {
            toolCalls: [call("call_done_1", "Done", { summary: "KV-cache section in writeup.md", evidence: ["projects/bitnet-160m/writeup.md", "make writeup: 0 warnings"] }, `Recorded as done. Verifier (openai/gpt-6.1-sol): pass — ${VERDICT_NOTE}`)],
            costUsd: 0.04,
            usage: { prompt: CONTEXT + 1000, completion: 300, total: CONTEXT + 1300, context: CONTEXT + 1000, window: WINDOW },
          }),
        ],
      },
      meta: { [id]: { state: "done", working: false, costUsd: 0.52, verdict: { verdict: "pass", notes: [VERDICT_NOTE], at: now + 50 * MIN, summary: "KV-cache section in writeup.md" } } },
      status: { [id]: "idle" as const },
      events: [{ type: "message", convId: id, role: "assistant" }, { type: "status", convId: id, status: "idle" }, { type: "meta", convId: id }],
    },
  ];
}

const NOTE = "projects/bitnet-160m/writeup.md";
const COMPOSER = "textarea";
const next = (n = 1, ms = 900): Step[] => Array.from({ length: n }, () => [{ run: () => (window as any).__preview?.boxNext?.() } as Step, { sleep: ms } as Step]).flat();
const typeSend = (text: string): Step[] => [{ type: text, into: COMPOSER }, { key: "Enter", target: COMPOSER }, { sleep: 900 }];
const clickByText = (sel: string, text: RegExp): Step => ({
  run: async (api: StepApi) => {
    for (let i = 0; i < 60; i++) {
      const el = api.byText(text, sel);
      if (el) return void el.click();
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`no ${sel} ${text}`);
  },
});
/** Paste a small rendered chart (a PNG made on a canvas) into the composer, as a capture would. */
export const pasteChart: Step = {
  run: async (api) => {
    const ta = api.q("textarea") as HTMLTextAreaElement | null;
    if (!ta) return;
    const c = document.createElement("canvas");
    c.width = 360;
    c.height = 200;
    const g = c.getContext("2d")!;
    g.fillStyle = "#fff";
    g.fillRect(0, 0, 360, 200);
    g.strokeStyle = "#2a6fdb";
    g.lineWidth = 2;
    g.beginPath();
    for (let x = 0; x <= 320; x += 4) {
      const y = 26 + 140 * (1 - Math.exp(-x / 70)) - (x > 150 && x < 175 ? 22 : 0);
      if (x === 0) g.moveTo(30 + x, 200 - y);
      else g.lineTo(30 + x, 200 - y);
    }
    g.stroke();
    const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), "image/png"));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], "loss.png", { type: "image/png" }));
    ta.focus();
    ta.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  },
};
export const IMAGE_ASK = "Does this loss curve look right?";

/** Which option of a presentation choice a scenario is on (second = true). */
type Opts = Record<string, string>;
const second = (o: Opts, choice: string) => o[choice] !== undefined && o[choice] === CHOICE_OPTIONS[choice]?.[1];

/** A's stages, as narrated beats: each stage (a list of beats) ends where the
 *  check asserts, and `drive` is just the beats' steps. The captions describe
 *  what the stage shows on the scenario's options; `show` steps are for the
 *  narrated play only (the check never runs them). */
function beatsA(o: Opts): Beat[][] {
  const sa = second(o, "subagents"), co = second(o, "cost"), td = second(o, "todos"), vd = second(o, "verdict"), ak = second(o, "ask");
  return [
    // 0: open the conversation (the roll-over divider is at its top)
    [
      {
        title: "A chat that runs on the box",
        text: "The laptop is linked to a box: this conversation runs on the box's agent, and the laptop shows it live — the note on the left, the chat on the right.",
        steps: [{ file: NOTE }, { chat: true }, { conversation: CONV }, { sleep: 900 }],
      },
      {
        title: "The conversation rolled over",
        text: "It outgrew one session and continued in a fresh one — “Earlier conversation summarized” opens the recap the agent carried over.",
        spot: "[data-el='divider']",
        steps: [],
        show: [{ click: "[data-el='divider'] summary" }, { sleep: 600 }],
      },
    ],
    // 1: Carl asks; thinking, the plan, two subagents start; one finishes
    [
      { title: "You ask", text: "A request for a KV-cache section, typed and sent; the box picks it up and starts a turn.", spot: ".prose-user", steps: typeSend(FIRST_ASK) },
      { title: "The agent thinks first", text: "Its reasoning streams live under “Thinking…”; when the reply lands it folds into a collapsed “Thought” line.", spot: { sel: "span", text: "^Thinking…$" }, steps: next(1) },
      {
        title: "Then it plans",
        text: td ? "A to-do list pinned above the composer: 4 steps, the first in progress. It updates as the work moves." : "A to-do list in the thread: 4 steps, the first in progress. It updates as the work moves.",
        spot: td ? "[data-el='todos-pinned']" : "[data-el='todos'], [data-el='todos-done']",
        steps: [],
      },
      {
        title: "Two helper agents start in parallel",
        text: sa ? "One subagent call starts two helpers — a compact strip above the composer, one chip each with its state." : "One subagent call starts two helpers — one card under the reply, a row each with its state.",
        spot: "[data-el='subagents']",
        steps: next(1),
      },
      { title: "One helper finishes", text: co ? "Its row turns done with what it cost ($0.09) and a one-line summary; the other is still reading." : "Its row turns done with a one-line summary; the other is still reading.", spot: "[data-el='subagent'][data-state='completed']", steps: next(1) },
    ],
    // 2: the reply streams whole (past 6,000 characters)
    [{ title: "The reply streams in", text: "The answer arrives live — over 6,000 characters with a table, code and math — while the plan moves to 2 of 4.", spot: "[data-el='stream']", steps: next(1, 1200) }],
    // 3: it lands; then the AskUser
    [
      { title: "The reply lands", text: "Both helpers are done and the plan reads 4/4. The reasoning is now the collapsed “Thought” line on the reply — click it to read.", spot: "[data-el='thinking']", steps: next(1, 1200) },
      co
        ? { title: "What it cost", text: "Its five tool calls fold into one row above the text. Cost shows only as the conversation's total, top right.", spot: "[data-el='total-cost']", steps: [] }
        : { title: "The tool calls", text: "Its five tool calls fold into one row above the text. No cost anywhere in the chat — the ledger and Settings still have it.", spot: "[data-el='tool-calls']", steps: [] },
      {
        title: "The agent asks you to choose",
        text: ak ? "A question with numbered buttons under it — click one to answer. The conversation waits for you." : "A question with two option cards, the recommended one marked — tap a card to answer. The conversation waits for you.",
        spot: "[data-el='ask-options']",
        steps: next(1, 1000),
      },
    ],
    // 4: Carl picks an option; the wake is scheduled (sleeping, next h:mm)
    [
      { title: "You pick “Only 4-bit KV”", text: "The pick goes back to the agent as your answer, and the options go quiet so it can't be answered twice.", spot: "[data-el='ask-options']", steps: [clickByText("[data-el='ask-option']", /Only 4-bit KV/), { sleep: 900 }] },
      { title: "It schedules a check and sleeps", text: "It trims the section, then sets a wake for later; the working line shows it sleeping, with the next wake time.", spot: "[data-ongoing='waiting']", steps: next(1, 1000) },
    ],
    // 5: the wake fires; the turn errors
    [
      { title: "The wake fires", text: "At the set time it wakes on its own — “Wake: Checking the writeup build” — and gets back to work.", spot: { sel: "div, p, span", text: "Wake: Checking the writeup build" }, steps: next(1, 900) },
      { title: "A turn fails", text: "The provider answered 502. The error shows in the thread as it is — nothing hidden, nothing retried behind your back.", spot: { sel: "div, p, span", text: "The turn failed" }, steps: next(1, 1000) },
    ],
    // 6: Carl retries; it works; he sends an image; Done with the verdict
    [
      { title: "You retry", text: "“Try again” re-runs it, and this time the writeup builds — make writeup, 0 warnings.", spot: { sel: "div, p, span", text: "^Retried: the writeup builds" }, steps: [...typeSend("Try again"), ...next(1, 1000)] },
      { title: "You send an image", text: "A chart pasted into the composer goes to the box with the question, and shows in your message.", spot: "img[alt^='captured']", steps: [pasteChart, { sleep: 700 }, ...typeSend(IMAGE_ASK)] },
      {
        title: "Done — a second model verified it",
        text: vd ? "The agent calls Done with its evidence; a separate verifier model checks it, and the verdict shows in the working line above the composer." : "The agent calls Done with its evidence; a separate verifier model checks it, and its verdict closes the thread.",
        spot: "[data-el='verdict']",
        steps: next(1, 1500),
      },
      { title: "How full the context is", text: "The dial by the composer reads the box's context window: 183k of 200,000 tokens, past 90% — close to full. That's the whole conversation.", spot: "[title^='Context:']", steps: [] },
    ],
  ];
}

/** A's stages; each ends where the check asserts. */
const driveA: Step[][] = beatsA({}).map((stage) => stage.flatMap((b) => b.steps));

/** The box's own model checks (Settings → Models, box mode). */
const BOX_MODELS = {
  models: [],
  box: {
    chat: { id: "openai/gpt-6.1-sol", state: "passed", context: 1_050_000 },
    vision: { id: "openai/gpt-6.1-sol", state: "passed", context: 1_050_000 },
    subagent: { id: "anthropic/claude-haiku-5.5", state: "passed", context: 200_000 },
  },
};
/** settings-box-models only: a subagent model under the 64k floor, to show the line. */
const BOX_MODELS_FAILING = {
  ...BOX_MODELS,
  box: { ...BOX_MODELS.box, subagent: { id: "qwen/qwen3-32b:nitro", state: "missing", missing: ["context"], context: 40_960 } },
};

function buildA(ctx: BuildCtx): void {
  P3.build(ctx);
}

const hostA = (now: number, models: unknown = BOX_MODELS) => ({
  sync: { box: BOX, boxChat: { convs: { ...boxConvsP3(now), [CONV]: boxConv(now) } as any, steps: boxSteps(now), live: true, models } },
});

function boxConvsP3(now: number): Record<string, any> {
  const out: Record<string, any> = {};
  for (const c of P3.convs(now) as any[]) {
    const { id, title, messages, ...meta } = c;
    out[id] = { title, source: c.source, status: "idle", meta, messages };
  }
  return out;
}

// ---- B: local ------------------------------------------------------------------

export const LOCAL_ASK = "Which version should go into the writeup?";
const localScripts: Script[] = [
  // The compaction's summary (the next send after the context passes 85%).
  { id: "conv-compact", system: /You compact a long agent conversation/, steps: [{ text: RECAP }] },
  {
    id: "conv-first",
    match: /Write the KV-cache section/,
    steps: [
      { reasoning: THINKING, text: "I'll lay out the plan first.", tools: [{ name: "TodoWrite", args: { todos: TODOS[0] } }], chunkMs: 14 },
      { tools: [{ name: "Read", args: { path: "{vault}/projects/bitnet-160m/writeup.md" } }] },
      { tools: [{ name: "TodoWrite", args: { todos: TODOS[1] } }] },
      { tools: [{ name: "TodoWrite", args: { todos: TODOS[2] } }] },
      { text: LONG_REPLY, chunkMs: 6, promptPad: 150_000 },
    ],
  },
  {
    id: "conv-ask",
    match: /Which version should go into the writeup/,
    steps: [
      { tools: [{ name: "AskUser", args: { about: TITLE, question: ASK_QUESTION, options: ASK_OPTIONS.map((o) => ({ label: o.answer, detail: o.body, ...(o.primary ? { recommended: true } : {}) })) } }] },
      { text: `${ASK_QUESTION} Pick one below.`, promptPad: 150_000 },
    ],
  },
  { id: "conv-answer", match: /Only 4-bit KV/, steps: [{ text: "Going with the 4-bit section only — table trimmed to that row, the bound and the kernel snippet kept.", promptPad: 890_000 }] },
  { id: "conv-error", match: /Build the writeup and check/, steps: [{ error: { status: 502, message: "Provider returned error: upstream connect error or disconnect/reset before headers" } }] },
  { id: "conv-retry", match: /Try again/, steps: [{ text: "Retried: the writeup builds and the section renders with both formulas.", promptPad: 40_000 }] },
  { id: "conv-image", match: /loss curve/i, steps: [{ text: "The curve looks right: the bump near step 2,000 is the usual early-training spike and it rejoins the trend within ~150 steps.", promptPad: 880_000 }] },
];

/** The chat's model picker: open it, search, pick the OpenRouter entry. */
const pickModel = (id: string): Step[] => [
  { click: "button", text: /^Claude Sonnet 5$/ },
  { sleep: 300 },
  { type: "Sonnet 5.5", into: "input[placeholder='Search models…']" },
  { sleep: 300 },
  { click: `button[title='openrouter · ${id}']` },
  { sleep: 400 },
];

/** B's stages. */
const driveB: Step[][] = [
  // 0: a new chat
  [{ file: NOTE }, { chat: true }, { click: "[title='New chat']" }, { sleep: 400 }],
  // 1: the long reply, with thinking (a direct Anthropic key: OpenRouter's chat adapter drops reasoning), tools, the plan updated twice
  [...typeSend(FIRST_ASK), { waitIdle: true, timeout: 60000 }, { sleep: 600 }],
  // 2: switch to OpenRouter (costs come from OpenRouter); the AskUser with options
  [...pickModel("anthropic/claude-sonnet-5.5"), ...typeSend(LOCAL_ASK), { waitIdle: true, timeout: 30000 }, { sleep: 600 }],
  // 3: Carl picks an option (the context then sits near its limit)
  [clickByText("[data-el='ask-option']", /Only 4-bit KV/), { sleep: 600 }, { waitIdle: true, timeout: 30000 }, { sleep: 600 }],
  // 4: the next send compacts first (the summarized-earlier divider), then errors; Carl retries
  [...typeSend("Build the writeup and check it renders"), { waitIdle: true, timeout: 30000 }, { sleep: 600 }, ...typeSend("Try again"), { waitIdle: true, timeout: 30000 }, { sleep: 600 }],
  // 5: an image
  [pasteChart, { sleep: 700 }, ...typeSend(IMAGE_ASK), { waitIdle: true, timeout: 30000 }, { sleep: 800 }],
];

// ---- C: the phone ----------------------------------------------------------------

/** A box message in the phone's shape (server/phoneData.ts conversationDetail). */
function phoneMsg(m: any): any {
  const out: any = { role: m.role, content: m.content, tools: (m.toolCalls ?? []).map((t: any) => t.name), system: m.system === true, direct: m.direct === true, decision: m.decision === true, askOptions: m.askOptions ?? null };
  if (m.thinking) out.thinking = m.thinking;
  const cost = m.costUsd ?? m.usage?.costUsd;
  if (typeof cost === "number") out.costUsd = cost;
  const summary = m.compaction?.summary ?? m.rollover?.recap;
  if (m.system && typeof summary === "string") out.divider = summary;
  const spawns = (m.toolCalls ?? []).flatMap((t: any) => t.subagents ?? []);
  if (spawns.length) out.spawns = spawns;
  if (m.failed) out.failed = true;
  return out;
}

function phoneThread(now: number): any {
  const c = boxConv(now);
  return { id: CONV, title: TITLE, source: "phone", status: "idle", ...c.meta, messages: c.messages.map(phoneMsg) };
}

/** A's script, in the phone's shapes (its mock box applies one step per __vcPhoneNext()). */
function phoneScript(now: number): any[] {
  return boxSteps(now).map((st: any) => {
    // The phone renders a `message` event from what it carries (phoneApp.ts runDiff).
    const appended = Object.values(st.append ?? {}).flat().map(phoneMsg);
    let k = 0;
    const out: any = { events: st.events.map((ev: any) => (ev.type === "message" ? { ...ev, ...(appended[k++] ?? {}) } : ev)) };
    if (st.append) out.append = Object.fromEntries(Object.entries(st.append).map(([key, ms]) => [key, (ms as any[]).map(phoneMsg)]));
    if (st.meta) out.meta = st.meta;
    if (st.status) out.runs = Object.entries(st.status).filter(([, v]) => v === "running").map(([k]) => ({ convId: k, title: TITLE, source: "phone" }));
    return out;
  });
}

function phoneDbC(db: any, now: number, ls: Record<string, string> = {}): void {
  P3.phoneDb(db, now);
  db.threads[CONV] = phoneThread(now);
  db.convs = [{ id: CONV, title: TITLE, source: "phone", lastActivityAt: now - 2 * MIN, msgCount: 3, preview: "", project: "bitnet-160m", state: "idle", costUsd: 0.06 }, ...db.convs];
  db.runs = [];
  db.script = phoneScript(now);
  db.ls = { vc_phone_conv: JSON.stringify({ id: CONV, title: TITLE }), ...ls };
}

/** C's narrated beats: the same conversation played on the phone by its mock
 *  box (one __vcPhoneNext() per box step), the way preview/conv-check.mjs
 *  plays it. Plain data — the phone page gets it as JSON. */
function beatsC(o: Opts): Beat<PhoneStep>[] {
  const sa = second(o, "subagents"), co = second(o, "cost"), td = second(o, "todos"), vd = second(o, "verdict");
  return [
    { title: "The same chat, on the phone", text: "The box conversation from the laptop, on the phone: every piece the laptop shows, sized for a thumb.", steps: [] },
    { title: "The conversation rolled over", text: "It continued in a fresh session — the “Earlier conversation summarized” line opens the recap.", spot: "[data-el='divider']", steps: [], show: [{ tap: "[data-el='divider'] .xh" }, { sleep: 500 }] },
    { title: "You ask", text: "A request for a KV-cache section, sent from the phone; the box picks it up and starts a turn.", spot: ".m.user", steps: [{ send: FIRST_ASK }] },
    {
      title: "It thinks, then plans",
      text: td ? "The agent reasons first, then a to-do list appears, pinned above the composer: 4 steps, the first in progress." : "The agent reasons first, then a to-do list appears in the thread: 4 steps, the first in progress.",
      spot: "[data-el='todos'], [data-el='todos-done']",
      steps: [{ next: 1 }],
    },
    { title: "Two helper agents start in parallel", text: sa ? "Two helpers from one call — a compact strip above the composer, one chip each." : "Two helpers from one call — one card in the thread, a row each with its state.", spot: "[data-el='subagents']", steps: [{ next: 1 }] },
    { title: "One helper finishes", text: co ? "Its row turns done with its cost ($0.09) and a one-line summary; the other is still reading." : "Its row turns done with a one-line summary; the other is still reading.", spot: "[data-el='subagent'][data-state='completed']", steps: [{ next: 1 }] },
    { title: "The reply streams in", text: "Over 6,000 characters arrive live — a table, code, and math typeset as it streams.", spot: ".amsg.stream", steps: [{ next: 1 }] },
    { title: "The reply lands", text: "The plan reads 4/4. The reasoning is a collapsed “Thought” line on the reply — tap to read; the tool calls fold into “5 steps”.", spot: "[data-el='thinking']", steps: [{ next: 1 }] },
    ...(co ? [{ title: "What it cost", text: "Cost shows only as the conversation's total, in the header.", spot: "[data-el='total-cost']", steps: [] }] : []),
    { title: "The agent asks you to choose", text: "A question with two option cards, the recommended one marked — tap a card. The conversation waits for you.", spot: ".delib-opt.inline", steps: [{ next: 1 }] },
    { title: "You pick “Only 4-bit KV”", text: "The pick goes back as your answer, and the cards go quiet.", spot: ".delib-opt.inline.chosen", steps: [{ tap: ".delib-opt.inline[data-ans='Only 4-bit KV']" }, { sleep: 700 }] },
    { title: "It schedules a check and sleeps", text: "It sets a wake for later; the working line above the composer shows it sleeping, with the next wake time.", spot: "#ongoing", steps: [{ next: 1 }] },
    { title: "The wake fires", text: "At the set time it wakes on its own — “Wake: Checking the writeup build”.", spot: { sel: "#msgs div, #msgs p, #msgs span", text: "Wake: Checking the writeup build" }, steps: [{ next: 1 }] },
    { title: "A turn fails", text: "The provider answered 502; the error shows in the thread as it is.", spot: { sel: "#msgs div, #msgs p, #msgs span", text: "The turn failed" }, steps: [{ next: 1 }] },
    { title: "You retry", text: "“Try again” re-runs it, and this time the writeup builds.", spot: { sel: "#msgs div, #msgs p, #msgs span", text: "^Retried: the writeup builds" }, steps: [{ send: "Try again" }, { next: 1 }] },
    { title: "You send a photo", text: "A chart picked with the photo button shows above the composer, then goes to the box with the question.", spot: ".m.user .mimgs img", steps: [{ photo: true }, { sleep: 600 }, { send: IMAGE_ASK }] },
    {
      title: "Done — a second model verified it",
      text: vd ? "The agent calls Done; a separate verifier model checks its evidence, and the verdict shows in the working line." : "The agent calls Done; a separate verifier model checks its evidence, and its verdict closes the thread.",
      spot: "[data-el='verdict']",
      steps: [{ next: 1 }],
    },
  ];
}

// ---- the scenarios ------------------------------------------------------------------

const CHOICE_OPTIONS: Record<string, [string, string]> = {
  subagents: ["inline", "strip"],
  cost: ["none", "total"],
  todos: ["inline", "pinned"],
  verdict: ["thread", "ongoing"],
  ask: ["cards", "buttons"],
};
const CHOICE_TEXT: Record<string, Record<string, string>> = {
  subagents: { inline: "a card under the reply that spawned them", strip: "a compact strip above the composer" },
  cost: { none: "no cost in the chat at all (the default — Carl: \"I just don't need cost\")", total: "only the conversation's total, at the top right" },
  todos: { inline: "the plan card in the thread", pinned: "the plan pinned above the composer" },
  verdict: { thread: "a quiet line at the end of the thread", ongoing: "in the ongoing line above the composer" },
  ask: { cards: "option cards (the phone's language, desktop style)", buttons: "numbered buttons under the question" },
};
/** Where each choice is best seen: the stage the scenario stops after. */
const CHOICE_STAGE: Record<string, number> = { subagents: 1, cost: 6, todos: 1, verdict: 6, ask: 3 };

const lsFor = (opts: Record<string, string>) => Object.fromEntries(Object.entries(opts).map(([k, v]) => [`vc_ui_${k}`, v]));
const DEFAULTS = Object.fromEntries(Object.entries(CHOICE_OPTIONS).map(([k, [a1]]) => [k, a1]));
const ALTS = Object.fromEntries(Object.entries(CHOICE_OPTIONS).map(([k, [, b1]]) => [k, b1]));

function scenarioA(id: string, title: string, notes: string, ls: Record<string, string>, upto = driveA.length - 1, narrate?: Opts): Scenario {
  return {
    ...(narrate ? { narrate: beatsA(narrate).flat() } : {}),
    id,
    title,
    group: "Full conversation",
    notes,
    clock: "2026-10-13T10:00:00",
    build: buildA,
    host: hostA,
    activeConversation: CONV,
    localStorage: ls,
    drive: driveA,
    open: driveA.slice(0, upto + 1).flat(),
    surfaces: ["desktop"],
  };
}

const NARRATED = " Plays narrated (a caption per step; Space pauses, ←/→ step, −/+ speed); &narrate=0 plays it at full speed without captions.";
const NOTES_A =
  "Laptop with a box: one conversation with every element, played from the fake box's poll events — the roll-over divider (recap) at the top, Carl's ask, thinking, the plan (updated twice), two subagents from one call (one done with cost and summary while the other runs), the reply streamed whole past 6,000 characters (table, code, $ and \\(\\) inline math, $$ and \\[\\] display math), an AskUser answered, a wake (sleeping with its next time, then waking), an error and a retry, an image sent, Done with the verifier's verdict, cost, the context dial at 91%.";

export const convFullScenarios: Scenario[] = [
  scenarioA("conv-a", "Full conversation — laptop with a box (first options)", NOTES_A + NARRATED + " Every open choice on its first option.", lsFor(DEFAULTS), undefined, DEFAULTS),
  scenarioA("conv-a-alt", "Full conversation — laptop with a box (second options)", NOTES_A + NARRATED + " Every open choice on its second option.", lsFor(ALTS), undefined, ALTS),
  (() => {
    const sc = scenarioA(
      "conv-a-fullscreen",
      "Full conversation — fullscreen chat with the chats sidebar",
      "conv-a's world in fullscreen chat (Ctrl+Shift+F), laid out like Claude Code desktop / Codex: the conversations on the left, grouped by project exactly like the Chats overlay (project sections with +, New project, Recent / Earlier, the filter, New), the chat beside it at reading width. Ctrl+B or the sidebar's toggle hides and shows it (remembered). The composer is fullscreen's own: no Chats or New chat under it (the sidebar has both) and no camera — a + on the left opens Add photos & files (the file dialog: images attach, other files become @-references), Capture a region (the open file shows over the chat with the marquee on; Esc cancels) and Mention a vault file (the @ picker); a mic beside Send starts voice (Ctrl+D works here too — see voice-fullscreen). The scenario ends with the + menu open. Before: the composer row still had Chats, New chat and the camera, and no voice. Cost on the app's default now: none in the chat.",
      lsFor(DEFAULTS),
    );
    return { ...sc, open: [...(sc.open ?? []), { key: "ctrl+shift+F" }, { wait: "[data-el='chats-sidebar']" }, { sleep: 400 }, { click: "[data-el='composer-plus']", optional: true }, { sleep: 300 }] };
  })(),
  ...Object.entries(CHOICE_OPTIONS).flatMap(([choice, opts]) =>
    opts.map((opt) =>
      scenarioA(
        `conv-a-${choice}-${opt}`,
        `Choice: ${choice} — ${opt}`,
        `Carl's call. ${choice}: ${CHOICE_TEXT[choice]![opt]}. The other option: conv-a-${choice}-${opts.find((o) => o !== opt)}.`,
        lsFor({ ...DEFAULTS, [choice]: opt }),
        CHOICE_STAGE[choice],
      ),
    ),
  ),
  {
    id: "settings-box-models",
    title: "Settings — the box's own models checked",
    group: "Settings",
    notes:
      "Box mode: Settings → Models also checks the models the box runs (its chat agent, the vision model it falls back to for images, the subagent child model), from /api/v1/models → box. Here the subagent model's context is under the 64k floor: one quiet line under the pickers says so. Nothing shows while they all pass. The pickers' own lines now also cover tool_choice, context, parallel tool calls and usage (one remembered request per model; faked here — Qwen3 Coder answers one tool at a time).",
    clock: "2026-10-13T10:00:00",
    build: buildA,
    host: (now: number) => hostA(now, BOX_MODELS_FAILING),
    localStorage: { vault_chat_background_model: "qwen/qwen3-coder" },
    open: [{ click: "[title='Settings']" }, { sleep: 1500 }],
    surfaces: ["desktop"],
  },
  {
    id: "conv-b",
    title: "Full conversation — laptop local",
    group: "Full conversation",
    notes:
      "Laptop without a box: the scripted model. Thinking (a direct Anthropic key — OpenRouter's chat adapter drops reasoning), tools, the plan updated twice, the long reply, then OpenRouter for cost: an AskUser with options answered, the context near its limit, the next send compacting first (the summarized-earlier divider), an error and a retry, an image. Subagents, wakes and the Done verifier are the box's — not in local mode.",
    clock: "2026-10-13T10:00:00",
    model: "claude-sonnet-5",
    host: { keys: { "api.anthropic": "sk-ant-PREVIEW-000000000000" } },
    build: buildA,
    llm: { scripts: localScripts, chunkMs: 8 },
    // The per-reply cost option: this is where OpenRouter's metering is checked.
    localStorage: lsFor({ ...DEFAULTS, cost: "reply" }),
    drive: driveB,
    // Opens through the answered AskUser (the self-test's 30 s); the check plays every stage.
    open: driveB.slice(0, 4).flat(),
    surfaces: ["desktop"],
  },
  ...[
    ["conv-c", "first", DEFAULTS],
    ["conv-c-alt", "second", ALTS],
  ].map(
    ([id, which, opts]): Scenario => ({
      id: id as string,
      title: `Full conversation — phone (${which} options)`,
      group: "Full conversation",
      notes:
        "The phone, on the same conversation as conv-a, played by its mock box (__vcPhoneNext). Opened directly it plays narrated (a caption per step; Space pauses, ←/→ step, −/+ speed); &narrate=0 opens on the conversation as it stands before Carl's ask, which is where the check (preview/conv-check.mjs) plays it step by step.",
      clock: "2026-10-13T10:00:00",
      build: buildA,
      phone: { db: (db, now) => phoneDbC(db, now, lsFor(opts as Record<string, string>)), narrate: beatsC(opts as Opts) },
      surfaces: ["phone"],
    }),
  ),
  ...Object.entries(CHOICE_OPTIONS)
    .filter(([c]) => c !== "ask")
    .flatMap(([choice, opts]) =>
      opts.map(
        (opt): Scenario => ({
          id: `conv-c-${choice}-${opt}`,
          title: `Phone choice: ${choice} — ${opt}`,
          group: "Full conversation",
          notes: `Carl's call, on the phone. ${choice}: ${CHOICE_TEXT[choice]![opt]}. Play it with __vcPhoneNext() in the console, or see preview/conv-check.mjs.`,
          clock: "2026-10-13T10:00:00",
          build: buildA,
          phone: { db: (db, now) => phoneDbC(db, now, lsFor({ ...DEFAULTS, [choice]: opt })) },
          surfaces: ["phone"],
        }),
      ),
    ),
];

export const CONV_ID = CONV;
