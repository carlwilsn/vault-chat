// Every scenario the harness can boot. Each builds on the same synthetic world
// (world.ts) and differs in what the fake backend and fake model answer, and
// which screen the open-steps drive the real app to.
import type { BuildCtx, Scenario, Step } from "./types";
import * as W from "./world";
import { phase3Scenarios } from "./phase3";
import type { Script } from "../runtime/llm";

const MIN = 60_000;

type WorldOpts = { awaiting?: boolean; extraConvs?: (now: number) => W.Conv[]; noHistory?: boolean };
function world(ctx: BuildCtx, o: WorldOpts = {}): void {
  const { now, vault } = ctx;
  ctx.conversations([...W.chats(vault, now), ...W.missions(now, { awaiting: o.awaiting }), ...(o.extraConvs?.(now) ?? [])]);
  ctx.write(".vault-chat/notifications.jsonl", W.notifications(now, { awaiting: o.awaiting }).join("\n") + "\n");
  ctx.write(".vault-chat/notes.jsonl", W.notes(now).join("\n") + "\n");
  ctx.write(".vault-chat/schedules.jsonl", W.schedules(now).join("\n") + "\n");
  if (!o.noHistory) ctx.history(W.history(now) as any);
}

const NOTE = "projects/bitnet-160m/writeup.md";
const deskOpen = (file = NOTE, conv?: string): Step[] => [{ file }, { chat: true }, ...(conv ? [{ conversation: conv } as Step] : [])];
const COMPOSER = "textarea[placeholder^='Ask anything']";
const sendHere = (text: string): Step[] => [{ type: text, into: COMPOSER }, { key: "Enter", target: COMPOSER }];
/** Start a new chat and send `text` in it. */
const send = (text: string): Step[] => [{ click: "[title='New chat']" }, { sleep: 200 }, ...sendHere(text)];

// ---- scripted model turns ----------------------------------------------------

const toolChain: Script = {
  id: "tool-chain",
  match: /seed-43 row|tool demo/i,
  steps: [
    { text: "I'll read the results first.", tools: [{ name: "Read", args: { path: "{vault}/projects/bitnet-160m/results.csv" } }] },
    {
      text: "Three seeds, all at 1.70B tokens. Now updating the README's status list.",
      tools: [
        {
          name: "Edit",
          args: {
            path: "{vault}/projects/bitnet-160m/README.md",
            old_string: "- [ ] Writeup — draft in [[writeup]]",
            new_string: "- [x] Seed 43 row added to results (eval loss 1.5601)\n- [ ] Writeup — draft in [[writeup]]",
          },
        },
      ],
    },
    { text: "And running the eval script to double-check the number.", tools: [{ name: "Bash", args: { command: "python eval.py results/seed43.ckpt --shard heldout-00" } }] },
    {
      text:
        "Done.\n\n- **Read** `results.csv`: seeds 42/43/44 at 1.5576 / 1.5601 / 1.5588.\n- **Edited** `README.md`: ticked the seed-43 row.\n- **Ran** the eval: it confirms **1.5601** on `heldout-00`.\n\nSpread across seeds is 0.0025 nat — inside the 0.005 tolerance.",
    },
  ],
};

const writeFile: Script = {
  id: "write-file",
  match: /write .*note|create .*note|new note/i,
  steps: [
    {
      text: "Writing it now.",
      tools: [
        {
          name: "Write",
          args: {
            path: "{vault}/notes/eigengap.md",
            content:
              "# Eigengap heuristic — when it fails\n\n- Very different cluster sizes: the small cluster's eigenvalue hides in the bulk.\n- Overlapping clusters: no clear gap at all.\n- Noisy kernels (bad $\\sigma$): the gap moves with the bandwidth.\n",
          },
        },
      ],
    },
    { text: "Created `notes/eigengap.md` with the three failure modes from office hours." },
  ],
};

const reasoningScript: Script = {
  id: "reasoning",
  match: /.*/,
  steps: [
    {
      chunkMs: 90,
      reasoning:
        "The user wants to know whether to extend to 3.2B tokens. Compute: 3.2B/1.7B ≈ 1.9×, so ~26 more A10-hours per seed. The gap is 0.13 nat; Chinchilla-style fits suggest most of it closes. But the LR schedule must be re-planned — cosine floor at the new last step. Cost ~$31 for one seed, ~$93 for three. Recommend extending one seed first as a probe.",
      text:
        "Extend **one** seed first, not all three.\n\n1. The gap (0.13 nat) is almost all token count, so a single 3.2B run tells you whether it closes.\n2. Re-plan the cosine schedule for 6100 steps — don't just train longer.\n3. If seed 42 lands within ~0.02 nat of the reference, run 43 and 44.\n\nCost: ~$31 for the probe vs ~$93 for all three.",
    },
  ],
};

const errorScripts: Script[] = [
  { id: "rate-limit", match: /rate|429/i, steps: [{ error: { status: 429, message: "Rate limit exceeded: anthropic/claude-sonnet-5.5 is temporarily rate-limited upstream. Please retry shortly." } }] },
  { id: "server-error", match: /\b500\b|\b502\b|server/i, steps: [{ error: { status: 502, message: "Provider returned error: upstream connect error or disconnect/reset before headers" } }] },
  { id: "drop", match: /drop|disconnect/i, steps: [{ text: "Starting on that — the first part of the answer is", dropAfterText: true }] },
  {
    id: "tool-fail",
    match: /fail|broken/i,
    steps: [
      { text: "Let me run them.", tools: [{ name: "Bash", args: { command: "pytest -q tests/" } }] },
      { text: "The test run failed (exit 1): `test_ternary_roundtrip` asserts on a dtype mismatch. That's the fp16 path — want me to fix it?" },
    ],
  },
];

const held: Script = {
  id: "held",
  match: /.*/,
  steps: [{ text: "Working through the three seed threads now — reading each eval.loss and checking it against the tolerance before", hold: true }, { text: "" }],
};

const pdfScript: Script = {
  id: "pdf-extract",
  match: /survey|pdf/i,
  steps: [
    { text: "I'll extract the PDF's text first.", tools: [{ name: "PdfExtract", args: { path: "{vault}/papers/attention-survey.pdf" } }] },
    {
      text: "That came back truncated at ~60k characters (about page 15 of 320). Reading on in ranges.",
      tools: [{ name: "PdfExtract", args: { path: "{vault}/papers/attention-survey.pdf", pages: "16-60" } }],
    },
    { text: "Still more to go.", tools: [{ name: "PdfExtract", args: { path: "{vault}/papers/attention-survey.pdf", pages: "61-120" } }] },
    {
      text:
        "I've read pages 1–120 of 320 (each extract is cut at ~60k characters, so I saw roughly the first 45 pages' worth of text). In short: sparse and sliding-window attention cut the quadratic cost; grouped-query attention and the KV cache dominate inference latency; state-space layers trade recall for throughput.\n\n" +
        "*(Watch the context dial: three extracts put ~50k tokens of raw PDF text into this chat.)*",
    },
  ],
};

const compactionReply: Script = {
  id: "after-compaction",
  match: /what's next|next for/i,
  steps: [{ text: "Picking up from the summary: next step is re-fitting the cosine schedule for 6100 steps (warmup 122, floor 0.1 × peak). Want me to write that into `train.py`?" }],
};

/** "Where were we?" — a recap whose reported prompt size is padded to `pad`. */
const whereWere = (pad: number): Script => ({
  id: `recap-${pad}`,
  match: /where were we/i,
  steps: [{ text: "We were on the 3.2B-token plan: re-fit the cosine schedule for 6100 steps and keep the step-0 LR guard.", promptPad: pad }],
});

const inlineEdit: Script = {
  id: "inline-edit",
  system: /inline editor/i,
  steps: [
    {
      text: "The 160M reproduction is stable across three seeds (eval loss 1.559 ± 0.001), 0.13 nat above the reference — a gap explained almost entirely by training on 1.7B rather than ~3.2B tokens.",
    },
  ],
};

const askScript: Script = {
  id: "ask",
  match: /.*/,
  steps: [{ text: "It's the per-tensor mean absolute weight. Using the mean (not the max) keeps most weights from rounding to zero, which is what lets ternary layers keep their capacity." }],
};

// ---- the box sync engine -----------------------------------------------------

const BOX = { box: "https://box.tail0a1b2.ts.net", vault: "summer-demo" };
const syncTimers = { 15000: 1500, 30000: 1500 };

export const scenarios: Scenario[] = [
  // ===== Basics =====
  {
    id: "home",
    title: "Home — a note open, a past chat",
    group: "Basics",
    notes:
      "The writeup open in the viewer, a past chat with a tool call in the pane. Everything is live: open files, edit, chat (an unscripted message gets a generic streamed reply), Ctrl+B / Ctrl+Shift+B, Alt+L for light theme. Writes stay in memory until reload.",
    build: (c) => world(c),
    activeConversation: "c-spectral",
    open: deskOpen(NOTE, "c-spectral"),
    surfaces: ["desktop", "phone"],
  },
  {
    id: "light",
    title: "Home in the light theme",
    group: "Basics",
    theme: "light",
    notes: "Same as Home, light theme (Alt+L toggles).",
    build: (c) => world(c),
    activeConversation: "c-spectral",
    open: deskOpen(NOTE, "c-spectral"),
  },
  {
    id: "fresh",
    title: "Fresh install — empty vault data, no keys",
    group: "Basics",
    notes: "A first run: no API key in the keychain, no conversations. The composer is disabled until a key is set in Settings (paste any fake value such as sk-or-PREVIEW-1).",
    host: { keys: { "api.openrouter": null } },
    build: () => {},
    open: [{ chat: true }],
  },

  // ===== Chat =====
  {
    id: "chat-tools",
    title: "Chat — streaming reply with tool calls (read, edit, shell)",
    group: "Chat",
    notes:
      "A live turn: Read → Edit (really changes README.md in memory — look at the open file) → Bash (scripted output) → final answer, streamed. Then try “write a new note about the eigengap” for a Write call, or “broken tests” for a failing shell call.",
    build: (c) => world(c),
    host: {
      bash: [
        { match: /eval\.py/, stdout: "loading results/seed43.ckpt\nshard heldout-00: 4096 sequences\neval loss 1.5601\n", code: 0, delayMs: 1200 },
        { match: /pytest/, stdout: "F..\nFAILED tests/test_ternary.py::test_ternary_roundtrip - AssertionError: dtype mismatch float16 != float32\n", code: 1 },
      ],
    },
    llm: { scripts: [toolChain, writeFile, ...errorScripts], chunkMs: 22 },
    open: [...deskOpen("projects/bitnet-160m/README.md"), ...send("Add the seed-43 row to the README and rerun the eval to confirm the number.")],
  },
  {
    id: "chat-reasoning",
    title: "Chat — reasoning (direct Anthropic key)",
    group: "Chat",
    notes:
      "Today reasoning shows only (a) on a direct Anthropic key — on the default OpenRouter path the AI SDK's chat adapter drops the reasoning deltas — and (b) live, before the first text token: once the answer starts it disappears and it is not kept in the transcript. This scenario uses an Anthropic key + Claude Sonnet 5 and streams the thinking slowly so you can see it. Switch to an OpenRouter model and ask again: no thinking at all.",
    model: "claude-sonnet-5",
    host: { keys: { "api.anthropic": "sk-ant-PREVIEW-000000000000" } },
    build: (c) => world(c),
    llm: { scripts: [reasoningScript], chunkMs: 25 },
    open: [...deskOpen(), ...send("Should I extend the BitNet runs to 3.2B tokens?")],
  },
  {
    id: "chat-errors",
    title: "Chat — errors (rate limit, 502, dropped stream, failing tool)",
    group: "Chat",
    notes: "Opens on a 429 rate-limit reply. Then try: “server” (502), “drop” (connection lost mid-stream), “broken tests” (a shell tool exits 1).",
    build: (c) => world(c),
    host: { bash: [{ match: /pytest/, stdout: "F..\nFAILED tests/test_ternary.py::test_ternary_roundtrip - AssertionError: dtype mismatch float16 != float32\n", code: 1 }] },
    llm: { scripts: errorScripts },
    open: [...deskOpen(), ...send("Summarize the writeup (rate-limit test)")],
  },
  {
    id: "chat-streaming",
    title: "Chat — a turn in flight (held open)",
    group: "Chat",
    notes: "The model stream is held open so the running state stays on screen: elapsed timer, Stop button, partial text. Press Stop, or run __preview.release() in the console to let it finish.",
    build: (c) => world(c),
    llm: { scripts: [held], chunkMs: 30 },
    open: [...deskOpen(), ...send("Check all three seeds against the tolerance.")],
  },
  {
    id: "compaction",
    title: "Chat — a long chat hits compaction",
    group: "Chat",
    notes:
      "A 36-message chat. The first message's reply reports 176k context (over 85% of the fixed 200k limit — the dial goes red). The second message then runs today's compaction: a background summary call, the “Conversation compacted to free context.” banner, then the reply. Watch the dial before and after.",
    build: (c) => world(c, { extraConvs: (now) => [W.longChat(now, 176_000)] }),
    activeConversation: "c-long",
    llm: { scripts: [whereWere(176_000), compactionReply], chunkMs: 12 },
    open: [
      ...deskOpen("notes/scaling-laws.md", "c-long"),
      { sleep: 400 },
      ...sendHere("Where were we?"),
      { waitIdle: true },
      { sleep: 800 },
      ...sendHere("OK — what's next for the 3.2B run?"),
    ],
  },
  ...([
    ["context-low", "Context dial — low (~14k)", 4_000, "c-spectral", "A short chat: the dial after a live turn (the dial only appears after a turn — a reopened chat shows nothing until you send)."],
    ["context-high", "Context dial — high (~120k)", 110_000, "c-long", "A long chat at ~120k reported context."],
    ["context-near", "Context dial — near the limit (~196k)", 186_000, "c-long", "~196k of 200k. The limit is the fixed MODEL_CONTEXT_LIMIT, not the model's real window (Sonnet 5.5 has 1M). The next message compacts first."],
  ] as const).map(([id, title, pad, conv, notes]): Scenario => ({
    id,
    title,
    group: "Context dial",
    notes,
    build: (c) => world(c, { extraConvs: (now) => [W.longChat(now, pad + 10_000)] }),
    activeConversation: conv,
    llm: { scripts: [whereWere(pad), compactionReply] },
    open: [...deskOpen(conv === "c-long" ? "notes/scaling-laws.md" : NOTE, conv), { sleep: 400 }, ...sendHere("Where were we?"), { waitIdle: true }],
  })),

  // ===== Editing =====
  {
    id: "inline-edit",
    title: "Ctrl+K inline edit",
    group: "Editing",
    notes:
      "The writeup open in edit mode. Select the Summary paragraph, press Ctrl+K, type an instruction (“tighten this”), Enter: the scripted model streams a rewrite you accept or reject. Ctrl+K uses the chat model (the picker under the composer).",
    build: (c) => world(c),
    llm: { scripts: [inlineEdit] },
    open: [{ file: NOTE, mode: "edit" }, { chat: true }],
  },
  {
    id: "ask-ctrl-l",
    title: "Ctrl+L ask",
    group: "Editing",
    notes: "The writeup in view mode with the Ctrl+L ask popover open. Ask anything about the note; the scripted model answers.",
    build: (c) => world(c),
    llm: { scripts: [askScript] },
    open: [{ file: NOTE }, { sleep: 600 }, { key: "Ctrl+l" }],
  },
  {
    id: "model-picker",
    title: "Model picker (real OpenRouter catalog)",
    group: "Models",
    notes: "The chat pane's model picker, open, listing the real OpenRouter catalog (saved from openrouter.ai/api/v1/models). Search works. Settings has the per-role pickers.",
    build: (c) => world(c),
    activeConversation: "c-spectral",
    open: [...deskOpen(NOTE, "c-spectral"), { sleep: 800 }, { click: "button", text: /Claude Sonnet 5\.5/ }],
  },

  // ===== PDF =====
  {
    id: "pdf-large",
    title: "A 320-page PDF and the PDF tool in chat",
    group: "PDF",
    notes:
      "papers/attention-survey.pdf (320 pages) open in the viewer. The chat asks for a summary: PdfExtract really runs pdf.js in the browser on all 320 pages, returns only the first ~60k characters (silently ~15 pages), and the scripted model reads on in page ranges — each extract lands in the context, and the dial climbs.",
    build: (c) => world(c),
    llm: { scripts: [pdfScript] },
    open: [...deskOpen("papers/attention-survey.pdf"), { sleep: 1500 }, ...send("Summarize the attention survey PDF.")],
  },

  // ===== Settings / history / search =====
  {
    id: "settings",
    title: "Settings (configured)",
    group: "Settings",
    notes: "The Settings pane with an OpenRouter key, a web-search key and box sync configured. Scroll through every section; edits apply in memory.",
    build: (c) => world(c),
    host: { sync: { box: BOX }, keys: { "service.tavily": "tvly-PREVIEW-0000" } },
    open: [{ click: "[title='Settings']" }],
  },
  {
    id: "settings-fresh",
    title: "Settings (fresh install, no keys)",
    group: "Settings",
    notes: "Settings on a first run: no keys anywhere.",
    host: { keys: { "api.openrouter": null } },
    build: () => {},
    open: [{ click: "[title='Settings']" }],
  },
  {
    id: "history",
    title: "History (Ctrl+H)",
    group: "History",
    notes: "Three weeks of seeded history: autosaves, [agent] commits, a mission's commits. Browse commits, per-file history, diffs; Restore really rewrites the in-memory vault.",
    build: (c) => world(c),
    open: [{ file: NOTE }, { key: "Ctrl+h" }],
  },
  {
    id: "search",
    title: "Search — what exists today",
    group: "Search",
    notes:
      "There is no global in-app search in v0.6.32. What exists: the Notes panel's search (open here, query typed), the @-mention file search in the composer, the model search in the picker, and the file search in the note composer (Ctrl+N).",
    build: (c) => world(c),
    open: [{ file: NOTE }, { click: "[title^='Notes']" }, { sleep: 300 }, { type: "eigengap", into: "input[placeholder='Search…']" }],
  },

  // ===== Missions =====
  {
    id: "missions",
    title: "Mission Control — a mission running",
    group: "Missions",
    notes: "Mission Control as it is today: one mission with workers, done and killed missions in the archive, Schedules and Alerts tabs.",
    build: (c) => world(c),
    open: [{ file: NOTE }, { click: "[title='Mission control']" }],
    surfaces: ["desktop", "phone"],
    phone: { page: "activity" },
  },
  {
    id: "missions-awaiting",
    title: "Mission Control — a mission waiting for you",
    group: "Missions",
    notes: "The BitNet mission is AWAITING_USER: it asked whether to extend to 3.2B tokens. The ask is in Alerts.",
    build: (c) => world(c, { awaiting: true }),
    open: [{ file: NOTE }, { click: "[title='Mission control']" }],
    surfaces: ["desktop", "phone"],
    phone: { page: "alerts" },
  },
  {
    id: "mission-page",
    title: "Mission Control — the mission page",
    group: "Missions",
    notes: "The BitNet mission's own page: brief, done-when checklist, audits, workers, cost.",
    build: (c) => world(c),
    open: [{ file: NOTE }, { click: "[title='Mission control']" }, { sleep: 400 }, { click: "button, [role=button], div", text: /^BitNet 160M MVP/ }],
  },

  // ===== Phone =====
  {
    id: "phone-chats",
    title: "Phone — conversations drawer",
    group: "Phone",
    notes: "The phone's conversation list (left button). Tap a chat to open it; type and send (the phone's own mock answers).",
    build: (c) => world(c),
    surfaces: ["phone"],
    phone: { clicks: ["#convBtn"] },
  },
  {
    id: "phone-thread",
    title: "Phone — a chat thread",
    group: "Phone",
    notes: "The spectral-clustering chat open on the phone, with math and a tool chip.",
    build: (c) => world(c),
    surfaces: ["phone"],
    phone: { clicks: ["#convBtn", "text:Why eigenvectors in spectral clustering?"] },
  },
  {
    id: "phone-mission",
    title: "Phone — the mission sheet",
    group: "Phone",
    notes: "Activity → the BitNet mission: brief, done-when, workers, the thinking digest.",
    build: (c) => world(c),
    surfaces: ["phone"],
    phone: { page: "activity", clicks: ["text:BitNet 160M MVP"] },
  },
  {
    id: "phone-notes",
    title: "Phone — notes",
    group: "Phone",
    notes: "The Notes page: open notes from the desktop's note composer.",
    build: (c) => world(c),
    surfaces: ["phone"],
    phone: { page: "notes" },
  },
  {
    id: "phone-settings",
    title: "Phone — box & settings",
    group: "Phone",
    notes: "Menu → Box & settings.",
    build: (c) => world(c),
    surfaces: ["phone"],
    phone: { clicks: ["#menuBtn", "#settingsRow"] },
  },

  // ===== Sync =====
  {
    id: "sync-healthy",
    title: "Sync — healthy (no chip)",
    group: "Sync",
    notes: "Box sync configured and in sync: the titlebar shows no chip (it only appears when something needs attention).",
    build: (c) => world(c),
    host: { sync: { box: BOX } },
    fastTimers: syncTimers,
    open: deskOpen(NOTE, "c-spectral"),
  },
  {
    id: "sync-conflict",
    title: "Sync — conflict",
    group: "Sync",
    notes: "The box's changes conflict with this laptop's in two files. Click the chip for the popover.",
    build: (c) => world(c),
    host: { sync: { box: BOX, reports: [{ ok: false, message: "merge gate: conflict", conflict: { files: ["daily/2026-10-10.md", "projects/bitnet-160m/writeup.md"], since: Date.parse("2026-10-10T09:05:00") } }] } },
    fastTimers: syncTimers,
    open: [...deskOpen(NOTE, "c-spectral"), { sleep: 1500 }],
  },
  {
    id: "sync-unreachable",
    title: "Sync — box unreachable (red after 10 min)",
    group: "Sync",
    notes: "The box has been unreachable for 11 minutes with 3 changes waiting. The scenario clock is pushed forward past the 60 s / 10 min gates.",
    build: (c) => world(c),
    host: {
      sync: {
        box: BOX,
        reports: [
          {
            ok: false,
            message: "box unreachable",
            error: "git fetch failed (exit 128):\nfatal: unable to access 'https://box.tail0a1b2.ts.net/git/summer-demo.git/': Could not resolve host: box.tail0a1b2.ts.net",
            error_kind: "unreachable",
            changes_waiting: 3,
          },
        ],
      },
    },
    fastTimers: syncTimers,
    open: [...deskOpen(NOTE, "c-spectral"), { sleep: 1200 }, { advance: 11 * MIN }, { sleep: 3500 }],
  },
  {
    id: "sync-error",
    title: "Sync — failing with a git error (amber)",
    group: "Sync",
    notes: "A git error for 2 minutes: amber chip with the first meaningful stderr line.",
    build: (c) => world(c),
    host: {
      sync: {
        box: BOX,
        reports: [
          {
            ok: false,
            message: "push failed",
            error: "git push failed (exit 1):\nremote: error: GH013: Repository rule violations found for refs/heads/master.\nerror: failed to push some refs",
            error_kind: "git",
            changes_waiting: 1,
          },
        ],
      },
    },
    fastTimers: syncTimers,
    open: [...deskOpen(NOTE, "c-spectral"), { sleep: 1200 }, { advance: 2 * MIN }, { sleep: 3500 }],
  },
  {
    id: "sync-bigfile",
    title: "Sync — a file too large for git",
    group: "Sync",
    notes: "A 212 MB checkpoint and a 61 MB scan kept out of git (over 50 MB).",
    build: (c) => world(c),
    host: {
      sync: {
        box: BOX,
        reports: [{ big_files: [{ path: "{vault}/projects/bitnet-160m/results/seed43.ckpt", size: 212 * 1024 * 1024 }, { path: "{vault}/papers/scan-2026-10-01.pdf", size: 61 * 1024 * 1024 }] }],
      },
    },
    fastTimers: syncTimers,
    open: [...deskOpen(NOTE, "c-spectral"), { sleep: 1500 }],
  },
  ...phase3Scenarios,
];
