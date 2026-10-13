// Phase 2's visible changes on the desktop, with the box-mode chat on: the
// vault's sync.json names a box, the box's engine (server/engine) runs every
// turn, and the fake box (runtime/backend/host.ts, sync.boxChat) serves the
// conversations in the shapes the engine writes:
//   • a turn's tools are `toolCalls: [{id, name, input, result}]` — the pi
//     `subagent` tool, plus one "Subagent" record per child (engine.ts
//     upsertTool on the `subagents` event, itemId `sub-<child>`);
//   • the conversation meta carries `subagents[]` (task, agent, model, state,
//     costUsd…), `verdict`, `state`, `nextWakeAt`, `costUsd`, `threadId`;
//   • a wake turn is `{role:"user", content:"⏰ Wake: <reason>", system:true}`;
//   • a roll-over is `{role:"assistant", system:true, content:"Rolled over to a
//     fresh session", rollover:{at, fromThread, recap}}` (server/context/rollover.ts);
//   • the Done tool's result carries formatVerdict(): "Verifier (<model>): pass — <note>".
// The before tree has no box mode: it shows the same files as today's laptop
// app does.
import type { BuildCtx, Scenario, Step } from "./types";
import type { Script } from "../runtime/llm";
import * as P3 from "./phase3";
import * as W from "./world";

const MIN = 60_000;
const HOUR = 60 * MIN;
const BOX = { box: "https://thinkbox.tail0a1b2.ts.net", vault: "summer-demo" };
const VERIFIER = "openai/gpt-6.1-sol";

const u = (content: string, extra: Record<string, unknown> = {}) => ({ role: "user", content, ...extra });
const a = (content: string, extra: Record<string, unknown> = {}) => ({ role: "assistant", content, ...extra });
const call = (id: string, name: string, input: unknown, result?: string) => ({ id, name, input, ...(result !== undefined ? { result } : {}) });
const sys = (content: string, extra: Record<string, unknown> = {}) => ({ role: "assistant", content, system: true, ...extra });

type Conv = Record<string, any> & { id: string; title: string; messages: any[] };

// ---- the conversations ---------------------------------------------------------

function subagentsConv(now: number): Conv {
  const tasks = [
    { agent: "researcher", task: "Read papers/attention-survey.pdf pages 40-80 and list every KV-cache compression method with its reported memory saving." },
    { agent: "researcher", task: "Read reading/chinchilla.md and notes/scaling-laws.md and say what token budget a 160M model should get." },
  ];
  return {
    id: "b-subagents",
    title: "Two readings in parallel",
    source: "manual",
    status: "idle",
    unread: false,
    createdAt: now - 40 * MIN,
    lastActivityAt: now - 30 * MIN,
    project: "bitnet-160m",
    state: "idle",
    costUsd: 0.42,
    threadId: "thr_subagents",
    subagents: [
      { threadId: "sa_01", task: tasks[0].task, agent: "researcher", model: "anthropic/claude-haiku-5.5", state: "completed", status: "completed", costUsd: 0.09, startedAt: now - 38 * MIN, endedAt: now - 33 * MIN, summary: "Six methods; quantized KV (4-bit) saves the most memory (~4×)." },
      { threadId: "sa_02", task: tasks[1].task, agent: "researcher", model: "anthropic/claude-haiku-5.5", state: "completed", status: "completed", costUsd: 0.05, startedAt: now - 38 * MIN, endedAt: now - 35 * MIN, summary: "~3.2B tokens (20 per parameter)." },
    ],
    messages: [
      u("Two things at once, please: the KV-cache compression methods in the survey (pages 40–80), and what token budget our 160M model should get. Use subagents."),
      a(
        "Both came back.\n\n**KV-cache compression (survey pp. 40–80).** Six methods: 4-bit quantized KV (≈4× less memory), grouped-query attention (≈8× with 8 groups), sliding-window eviction, H2O heavy-hitter eviction, low-rank KV projection, and paged allocation (no saving, less fragmentation).\n\n**Token budget.** Chinchilla's ~20 tokens per parameter gives **≈3.2B tokens** for 160M — our runs used 1.7B, which matches the 0.13-nat gap in the writeup.",
        {
          toolCalls: [
            call("call_subagent_1", "subagent", { tasks }, "Parallel: 2/2 succeeded\n\n[researcher] Six methods; quantized KV (4-bit) saves the most memory (~4×)…\n\n[researcher] ~3.2B tokens (20 per parameter)…"),
            call("sub-sa_01", "Subagent", { tool: "spawnAgent", prompt: tasks[0].task, agents: 1 }, "completed"),
            call("sub-sa_02", "Subagent", { tool: "spawnAgent", prompt: tasks[1].task, agents: 1 }, "completed"),
          ],
          costUsd: 0.28,
          turnId: "turn_sa",
        },
      ),
    ],
  };
}

function doneConv(now: number, verdict: "pass" | "fail" | "unsure"): Conv {
  const note = {
    pass: "eval.loss for seeds 42, 43 and 44 is in results.csv and the writeup's table matches it",
    fail: "the writeup's table says 1.5601 for seed 44, results.csv says 1.5588",
    unsure: "results.csv has the three rows, but seed 44's checkpoint isn't in the evidence",
  }[verdict];
  const word = verdict === "pass" ? "pass" : verdict === "fail" ? "FAIL" : "unsure";
  const line = `Verifier (${VERIFIER}): ${word} — ${note}`;
  const reply = {
    pass: "Done — the three-seed eval table is in `writeup.md` (mean 1.5588 ± 0.0010).\n\n" + line,
    fail: "I marked it done, but the verifier disagrees:\n\n" + line + "\n\nI'll fix the table — it should read 1.5588 for seed 44.",
    unsure: "Done, with a caveat from the verifier:\n\n" + line + "\n\nWant me to add the checkpoint hash to the evidence?",
  }[verdict];
  return {
    id: "b-done",
    title: "Eval table for the writeup",
    source: "manual",
    status: "idle",
    unread: false,
    createdAt: now - 2 * HOUR,
    lastActivityAt: now - 20 * MIN,
    project: "bitnet-160m",
    state: verdict === "pass" ? "done" : "idle",
    working: false,
    costUsd: 0.37,
    threadId: "thr_done",
    verdict: { verdict, notes: [note], at: now - 20 * MIN, summary: "Three-seed eval table in writeup.md" },
    messages: [
      u("Build the three-seed eval table into the writeup and tell me when it's done."),
      a(reply, {
        toolCalls: [
          call("call_read_1", "read", { path: "projects/bitnet-160m/results.csv" }, "seed,tokens,steps,peak_lr,eval_loss,…\n42,1.70e9,…,1.5576\n43,1.70e9,…,1.5601\n44,1.70e9,…,1.5588"),
          call("call_edit_1", "edit", { path: "projects/bitnet-160m/writeup.md" }, "Edited projects/bitnet-160m/writeup.md (+6 −1)"),
          call("call_done_1", "Done", { summary: "Three-seed eval table in writeup.md", evidence: ["projects/bitnet-160m/results.csv", "projects/bitnet-160m/writeup.md"] }, `Recorded as done. ${line}\nTell Carl the verdict in your reply.`),
        ],
        costUsd: 0.21,
        turnId: "turn_done",
      }),
    ],
  };
}

function rolloverConv(now: number): Conv {
  const msgs: any[] = [];
  const topics = ["the LR schedule for 3.2B tokens", "why seed 43 diverged", "the eval shard", "muP at 160M", "the cosine floor", "checkpoint cadence"];
  for (let i = 0; i < 12; i++) {
    msgs.push(u(`Next: walk me through ${topics[i % topics.length]}.`));
    msgs.push(a(`Here's the picture on ${topics[i % topics.length]}: the numbers from our runs, what changed, and what I'd do next.`, { costUsd: 0.04 }));
  }
  msgs.push(sys("Rolled over to a fresh session", { rollover: { at: now - 50 * MIN, fromThread: "thr_long_1", recap: "## Where we are\n\nThe 160M runs are stable across three seeds; the gap to the reference is the token budget. Next: re-fit the cosine schedule for 6100 steps." } }));
  msgs.push(u("Where were we?"));
  msgs.push(a("Picking up from the recap: the next step is re-fitting the cosine schedule for 6100 steps (warmup 122, floor 0.1 × peak). Want me to write that into `train.py`?", { costUsd: 0.03 }));
  return {
    id: "b-rollover",
    title: "The long BitNet thread",
    source: "manual",
    status: "idle",
    unread: false,
    createdAt: now - 3 * 24 * HOUR,
    lastActivityAt: now - 45 * MIN,
    project: "bitnet-160m",
    state: "idle",
    costUsd: 2.4,
    threadId: "thr_long_2",
    messages: msgs,
  };
}

function nowConv(now: number): Conv {
  return {
    id: "b-justnow",
    title: "Quick question about muP",
    source: "manual",
    status: "idle",
    unread: false,
    createdAt: now - 4_000,
    lastActivityAt: now - 4_000,
    messages: [u("Does muP transfer the init scale too?"), a("Yes — init variance scales with 1/width for hidden layers; the LR transfers with it.")],
  };
}

// ---- the box -------------------------------------------------------------------

const META_OF = (c: Conv) => {
  const { id: _i, title: _t, messages: _m, ...meta } = c;
  return meta;
};
const boxOf = (cs: Conv[]) => Object.fromEntries(cs.map((c) => [c.id, { title: c.title, source: c.source, status: "idle" as const, meta: META_OF(c), messages: c.messages }]));

/** The wake script for p-seed44 (phase3.ts): a wake arrives, works, reports, sleeps again. */
function wakeSteps(now: number) {
  const id = "p-seed44";
  return [
    {
      append: { [id]: [{ role: "user", content: "⏰ Wake: Checking the run", system: true }] },
      status: { [id]: "running" as const },
      meta: { [id]: { state: "running" } },
      events: [{ type: "status", convId: id, status: "running" }, { type: "message", convId: id, role: "user" }],
    },
    { events: [{ type: "runtime", convId: id, text: "Checking seed 44: step 2,140 of 6,100, loss 2.71…", tool: "JobStatus" }] },
    {
      append: {
        [id]: [
          a("Checked seed 44: step 2,140 of 6,100, loss 2.71 and falling, no spikes, 1.9 it/s — on track to finish in about 9 hours.\n\nNext check in 40 minutes.", {
            toolCalls: [call("call_js_2", "JobStatus", { name: "seed44" }, "step 2140/6100 · loss 2.71 · 1.9 it/s"), call("call_sw_2", "ScheduleWake", { in: "40m", reason: "Checking the run" }, "wake set")],
            costUsd: 0.06,
          }),
        ],
      },
      status: { [id]: "idle" as const },
      meta: { [id]: { state: "sleeping", nextWakeAt: Math.round((now + 41 * MIN) / MIN) * MIN, costUsd: 1.26 } },
      events: [{ type: "message", convId: id, role: "assistant" }, { type: "status", convId: id, status: "idle" }],
    },
  ];
}

function build(extra: (now: number) => Conv[]) {
  return (ctx: BuildCtx) => {
    P3.build(ctx);
    // The engine's conversations reach the laptop's vault through git.
    const more = extra(ctx.now);
    if (more.length) ctx.conversations([...more, ...P3.convs(ctx.now), ...W.chats(ctx.vault, ctx.now), ...W.missions(ctx.now)]);
  };
}

const NOTE = "projects/bitnet-160m/writeup.md";
const CHATS = "[title^='Chats — switch']";
const open = (conv: string, extra: Step[] = []): Step[] => [{ file: NOTE }, { chat: true }, { conversation: conv }, { sleep: 600 }, ...extra];
const boxNext: Step = { run: () => (window as any).__preview?.boxNext?.() };
/** Open the newest reply's tool calls ("3 tool calls"). */
const openTools: Step = {
  run: async (api) => {
    for (let i = 0; i < 40; i++) {
      const all = api.qa("details > summary").filter((e) => /\d+ tool calls?/.test(e.textContent ?? ""));
      const s = all[all.length - 1];
      if (s) return void s.click();
      await new Promise((r) => setTimeout(r, 150));
    }
  },
};
/** Paste a small rendered chart (a PNG made on a canvas) into the composer, as a capture would. */
const pasteChart: Step = {
  run: async (api) => {
    const ta = api.q("textarea[placeholder^='Ask anything'], textarea") as HTMLTextAreaElement | null;
    if (!ta) return;
    const c = document.createElement("canvas");
    c.width = 360;
    c.height = 200;
    const g = c.getContext("2d")!;
    g.fillStyle = "#fff";
    g.fillRect(0, 0, 360, 200);
    g.strokeStyle = "#999";
    g.strokeRect(30, 10, 320, 170);
    g.strokeStyle = "#2a6fdb";
    g.lineWidth = 2;
    g.beginPath();
    for (let x = 0; x <= 320; x += 4) {
      const y = 26 + 140 * (1 - Math.exp(-x / 70)) - (x > 150 && x < 175 ? 22 : 0);
      if (x === 0) g.moveTo(30 + x, y);
      else g.lineTo(30 + x, y);
    }
    g.stroke();
    g.fillStyle = "#333";
    g.font = "12px sans-serif";
    g.fillText("seed 44 — train loss", 210, 30);
    const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), "image/png"));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], "loss.png", { type: "image/png" }));
    ta.focus();
    ta.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  },
};

const imageReply: Script = {
  id: "image-reply",
  match: /spike|chart|curve/i,
  steps: [{ text: "That bump around step 2,000 is a short loss spike — it recovers within ~150 steps and the curve rejoins its trend, so it's the usual early-training noise, not the start of a divergence." }],
};

// ---- the scenarios -----------------------------------------------------------

/** The box for a scenario: its conversations, and the wake script where there is one. */
const boxHost = (id: string) => (now: number) => ({
  sync: { box: BOX, boxChat: { convs: boxConvsFor(id, now) as any, steps: id === "p2-wake" ? wakeSteps(now) : [] } },
});

export const phase2Scenarios: Scenario[] = [
  {
    id: "p2-subagents",
    title: "Subagents in a chat (parallel, two children)",
    group: "P2 · Box chat",
    notes:
      "A box-run chat whose turn called the pi `subagent` tool with two parallel tasks. The reply's tool calls are opened: the one `subagent` call and, for each child, a “Subagent” record the engine adds — three entries for one delegation. The children's state and cost live in the conversation meta (subagents[]), which the desktop doesn't show.",
    build: build((now) => [subagentsConv(now)]),
    host: boxHost("p2-subagents"),
    activeConversation: "b-subagents",
    open: open("b-subagents", [openTools, { sleep: 800 }]),
  },
  ...(["pass", "fail", "unsure"] as const).map(
    (v): Scenario => ({
      id: `p2-done-${v}`,
      title: `The Done verifier — ${v}`,
      group: "P2 · Box chat",
      notes: `The agent called Done; a separate verifier model checked the evidence. Its verdict (${v}) is the last line of the Done tool's result and the agent repeats it in the reply.`,
      build: build((now) => [doneConv(now, v)]),
      host: boxHost(`p2-done-${v}`),
      activeConversation: "b-done",
      open: open("b-done", [openTools, { sleep: 800 }]),
    }),
  ),
  {
    id: "p2-wake",
    title: "A wake arrives and the chat goes back to sleep",
    group: "P2 · Box chat",
    notes:
      "Keep-going mode on the box: “checking the run · next h:mm” over the composer. Then the wake fires: “⏰ Wake: Checking the run”, the turn works, reports, and schedules the next check (the line moves to the new time). Driven by the fake box's poll events, as the engine sends them.",
    build: (ctx) => P3.build(ctx),
    host: boxHost("p2-wake"),
    activeConversation: "p-seed44",
    open: open("p-seed44", [{ sleep: 1500 }]),
  },
  {
    id: "p2-rollover",
    title: "Roll-over — a long chat moves to a fresh session",
    group: "P2 · Box chat",
    notes:
      "When a box chat's context grows past the model's window the engine rolls it over to a fresh session with a recap. The transcript shows one quiet line, “Rolled over to a fresh session”; the recap rides on that message but nothing on the desktop shows it.",
    build: build((now) => [rolloverConv(now)]),
    host: boxHost("p2-rollover"),
    activeConversation: "b-rollover",
    open: open("b-rollover", [{ sleep: 600 }, { run: (api) => api.byText("Rolled over to a fresh session", "span")?.scrollIntoView({ block: "center" }) }, { sleep: 800 }]),
  },
  {
    id: "p2-image",
    title: "An image from the laptop in box mode",
    group: "P2 · Box chat",
    notes:
      "Paste a chart into the composer and ask about it. Before (today, no box mode): the laptop runs the turn and the reply reads the image. After (box mode): the message is NOT sent — “Images can't be sent to the box yet”.",
    build: (ctx) => P3.build(ctx),
    host: boxHost("p2-image"),
    llm: { scripts: [imageReply] },
    activeConversation: "p-seed44",
    open: open("c-spectral", [{ sleep: 600 }, pasteChart, { sleep: 900 }, { type: "What's that spike around step 2,000?", into: "textarea" }, { key: "Enter", target: "textarea" }, { waitIdle: true }, { sleep: 1200 }]),
  },
  {
    id: "p2-just-now",
    title: "The chat list's time for a chat under a minute old",
    group: "P2 · Box chat",
    notes: "A chat touched 4 seconds ago. Before: the list printed a clock, “0:04”. After: “now”.",
    build: build((now) => [nowConv(now)]),
    host: boxHost("p2-just-now"),
    open: [{ file: NOTE }, { chat: true }, { sleep: 500 }, { click: CHATS }, { sleep: 1500 }],
  },
];

/** The box conversations each scenario serves (the same objects its files hold). */
export function boxConvsFor(id: string, now: number): Record<string, unknown> {
  const p3 = P3.convs(now);
  const pick = (cs: Conv[]) => boxOf([...cs, ...(p3 as Conv[])]);
  if (id === "p2-subagents") return pick([subagentsConv(now)]);
  if (id.startsWith("p2-done-")) return pick([doneConv(now, id.slice(8) as "pass")]);
  if (id === "p2-rollover") return pick([rolloverConv(now)]);
  if (id === "p2-just-now") return pick([nowConv(now)]);
  return pick([]);
}
export { wakeSteps };
