// Every scenario the harness can boot. Each builds on the same synthetic world
// (world.ts) and differs in what the fake backend and fake model answer, and
// which screen the open-steps drive the real app to.
import type { BuildCtx, Scenario, Step } from "./types";
import * as W from "./world";
import type { Script } from "../runtime/llm";

const MIN = 60_000;

type WorldOpts = { awaiting?: boolean; extraConvs?: (now: number) => W.Conv[]; noHistory?: boolean };
function world(ctx: BuildCtx, o: WorldOpts = {}): void {
  const { now, vault } = ctx;
  // A private base (built from a real vault) brings its own conversations,
  // alerts and notes; only the long chat a context scenario needs is added.
  if (ctx.base !== "synthetic") {
    if (o.extraConvs) ctx.conversations(o.extraConvs(now));
    return;
  }
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

/** A long PDF read the way the page-range tool expects: default pages, then a range. */
const pdfRanges: Script = {
  id: "pdf-ranges",
  match: /survey|pdf/i,
  steps: [
    { text: "Starting with the opening pages.", tools: [{ name: "PdfExtract", args: { path: "{vault}/papers/attention-survey.pdf" } }] },
    { text: "Now the taxonomy section.", tools: [{ name: "PdfExtract", args: { path: "{vault}/papers/attention-survey.pdf", pages: "4-8" } }] },
    {
      text:
        "From pages 1–8 of 320: the survey sorts efficient attention into sparse/sliding-window, low-rank/kernel, and recurrent/state-space families, and argues the KV cache — not the attention FLOPs — dominates inference cost. Want a specific chapter next?\n\n" +
        "*(Watch the dial: each call returned a few pages, not the whole document.)*",
    },
  ],
};

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

/** Settings with every role set, keys configured, and the capability view in
 *  each of its three layouts (a preview switch: vault_chat_caps_view). One
 *  model of each source: learned (the box has seen it — seeded here, since
 *  nothing on the box writes it yet), catalog, and untested (not in the
 *  catalog). On today's app these open the same Settings as "settings". */
function capsScenarios(): Scenario[] {
  const views = [
    ["table", "A, a small table under the pickers"],
    ["inline", "B, one line under each role's picker"],
    ["fold", "C, folded into one Capabilities row"],
  ] as const;
  return views.map(([view, what]) => ({
    id: `settings-caps-${view}`,
    title: `Settings — capabilities, option ${what}`,
    group: "Settings",
    notes:
      "Roles: Chat Claude Sonnet 5.5 (learned: helpers yes), Background a model missing from the catalog (untested). No Images & PDFs row any more: images and PDFs go to the Chat model, and only when it can't read them to a built-in vision model (Gemini 3.5 Flash, not a setting). Keys: OpenRouter, Tavily and a lambda_api_key service key; one other provider (Anthropic) under the fold.",
    build: (c: BuildCtx) => world(c),
    host: {
      sync: { box: BOX },
      keys: {
        "service.tavily": "tvly-PREVIEW-0000",
        "api.anthropic": "sk-ant-PREVIEW-0000",
        "user.lambda_api_key": "PREVIEW-lambda-0000",
      },
    },
    localStorage: {
      vault_chat_caps_view: view,
      vault_chat_model: "anthropic/claude-sonnet-5.5",
      vault_chat_background_model: "deepseek/deepseek-v4",
      vault_chat_user_keys: JSON.stringify(["lambda_api_key"]),
      vault_chat_model_caps_learned: JSON.stringify({
        "anthropic/claude-sonnet-5.5": { helpers: true },
        "google/gemini-3.5-flash": { helpers: false },
      }),
    },
    open: [{ click: "[title='Settings']" }, { sleep: 600 }, ...(view === "fold" ? [{ run: (api) => api.byText(/^Capabilities/, "summary")?.click() } as Step] : [])],
  }));
}
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
      "A 36-message chat. The first message's reply reports 176k context. Before: over 85% of the fixed 200k, so the second message compacts (the “Conversation compacted to free context.” banner; the earlier messages leave the view). After: 176k is 18% of Sonnet 5.5's real 1M window — no compaction. See “Compaction — the divider” for compaction after the change.",
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
    ["context-low", "Context dial — low (~14k)", 4_000, "c-spectral", "A short chat: the dial after a live turn. Before: measured against a fixed 200k. After: against Sonnet 5.5's real 1M window (catalog); hover for the numbers."],
    ["context-high", "Context dial — high (~120k)", 110_000, "c-long", "A long chat at ~120k reported context. Before: amber (60% of a fixed 200k). After: grey, 12% of the real 1M window."],
    ["context-near", "Context dial — ~196k", 186_000, "c-long", "~196k. Before: red, 98% of the fixed 200k — the next message compacts. After: 20% of Sonnet 5.5's real 1M window, no compaction. For a real near-limit dial see “Context dial — near Sonnet 5.5's 1M window” and “… a 131k-window model”."],
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
  ...capsScenarios(),
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

  // ===== Chat details (P3) =====
  {
    id: "context-cached",
    title: "Context dial — a cached long chat (counted once)",
    group: "Context dial",
    notes:
      "OpenRouter reports 90% of the ~110k prompt as served from its prompt cache (as a real cached Claude chat does). Before: the dial adds the cached tokens ON TOP of the prompt (which already includes them) and reads ~2× — red, past the 200k it measures against. After: ~110k of the real 1M window, grey. Hover the dial for the numbers.",
    build: (c) => world(c, { extraConvs: (now) => [W.longChat(now, 110_000)] }),
    activeConversation: "c-long",
    llm: { scripts: [whereWere(100_000), compactionReply], cachedFraction: 0.9 },
    open: [...deskOpen("notes/scaling-laws.md", "c-long"), { sleep: 400 }, ...sendHere("Where were we?"), { waitIdle: true }],
  },
  {
    id: "context-reopen",
    title: "Context dial — a chat reopened (no new turn)",
    group: "Context dial",
    notes: "The long chat opened without sending anything. Before: no dial until you send. After: the dial shows the context its last turn reported (each assistant message keeps it).",
    build: (c) => world(c, { extraConvs: (now) => [W.longChat(now, 120_000)] }),
    activeConversation: "c-long",
    open: [...deskOpen("notes/scaling-laws.md", "c-long"), { sleep: 1500 }],
  },
  {
    id: "context-near-real",
    title: "Context dial — near Sonnet 5.5's 1M window (~880k)",
    group: "Context dial",
    notes:
      "~880k after a live turn. After: red at 88% of the real 1M window; the tooltip says the next message first summarizes the earlier conversation (send anything to see it: the divider appears). Before: the same 880k against a fixed 200k (pegged).",
    build: (c) => world(c, { extraConvs: (now) => [W.longChat(now, 880_000)] }),
    activeConversation: "c-long",
    llm: { scripts: [whereWere(870_000), compactionReply] },
    open: [...deskOpen("notes/scaling-laws.md", "c-long"), { sleep: 400 }, ...sendHere("Where were we?"), { waitIdle: true }],
  },
  {
    id: "context-small-window",
    title: "Context dial — a 131k-window model near its limit",
    group: "Context dial",
    notes:
      "Chat model Qwen3 32B (131k window); the reply reports ~120k. After: red, 92% of its real window — send any message and it compacts first (the divider appears above the last four messages) so the prompt fits. Before: amber, 60% of an assumed 200k — no compaction, and a real provider would reject the next prompt as too long.",
    model: "qwen/qwen3-32b",
    build: (c) => world(c, { extraConvs: (now) => [W.longChat(now, 120_000)] }),
    activeConversation: "c-long",
    llm: { scripts: [whereWere(112_000), compactionReply], chunkMs: 12 },
    open: [...deskOpen("notes/scaling-laws.md", "c-long"), { sleep: 400 }, ...sendHere("Where were we?"), { waitIdle: true }],
  },
  {
    id: "compaction-divider",
    title: "Compaction — the divider (expanded)",
    group: "Chat",
    notes:
      "A long chat past 85% of Sonnet 5.5's 1M window: the second message compacts on both sides. After: nothing leaves the transcript; a quiet “Earlier conversation summarized” divider sits above the four messages kept verbatim and expands to the summary (opened here). The summary rides on the divider, so it survives switching chats and reloads (before, it was one store field, cleared on every switch). Before: the “Conversation compacted to free context.” banner and the earlier messages gone from view (the never-shrink write keeps them on disk, so they come back on reload, without the summary).",
    build: (c) => world(c, { extraConvs: (now) => [W.longChat(now, 100_000)] }),
    activeConversation: "c-long",
    llm: { scripts: [whereWere(890_000), compactionReply], chunkMs: 12 },
    open: [
      ...deskOpen("notes/scaling-laws.md", "c-long"),
      { sleep: 400 },
      ...sendHere("Where were we?"),
      { waitIdle: true },
      { sleep: 800 },
      ...sendHere("OK — what's next for the 3.2B run?"),
      { waitIdle: true },
      { sleep: 600 },
      // Open the divider (after only — the before side has none).
      { run: (api) => api.byText(/Earlier conversation summarized/, "details > summary")?.click() },
    ],
  },
  ...(["A", "B", "C"] as const).map(
    (opt): Scenario => ({
      id: `inline-roles-${opt}`,
      title: `Ctrl+L / Ctrl+K models — option ${opt}`,
      group: "Editing",
      notes:
        `The Ctrl+L ask popover on the writeup; its footer names the model (after only). ${
          {
            A: "Option A: Ctrl+K and Ctrl+L both on the Chat role (Claude Sonnet 5.5).",
            B: "Option B (the default): Ctrl+K on Background (Claude Haiku 5.5), Ctrl+L on Chat (Claude Sonnet 5.5).",
            C: "Option C: Ctrl+K and Ctrl+L both on Background (Claude Haiku 5.5).",
          }[opt]
        } ` +
        "For Ctrl+K: Esc, switch the viewer to edit, select a paragraph, Ctrl+K. Roles are set in Settings → Models (a new Background row); an image ask (PDF region, image viewer) moves to the built-in vision model only when the role model can't read images — there is no Images & PDFs setting. Before: both always ran on the chat pane's current model.",
      build: (c) => world(c),
      localStorage: { vault_chat_inline_roles: opt },
      llm: { scripts: [inlineEdit, askScript] },
      open: [{ file: NOTE }, { sleep: 600 }, { key: "Ctrl+l" }],
    }),
  ),
  {
    id: "inline-auto",
    title: "Ctrl+L with the chat model on Auto",
    group: "Editing",
    notes:
      "The chat pane's model is Auto, and a Ctrl+L question is sent. Before: Ctrl+L reads the chat model, can't resolve “auto”, and fails with “No API key for auto. Add one in settings.” (Ctrl+K too). After: it runs on its role's model (Chat, here on Auto → OpenRouter's router) and answers.",
    model: "auto",
    localStorage: { vault_chat_inline_roles: "A" },
    build: (c) => world(c),
    llm: { scripts: [askScript] },
    open: [
      { file: NOTE },
      { sleep: 600 },
      { key: "Ctrl+l" },
      { sleep: 600 },
      // Before, Ctrl+L on Auto may not get as far as the popover: ask only if it opened.
      {
        run: async (api) => {
          const ta = api.q("textarea[placeholder^='Ask about']") as HTMLTextAreaElement | null;
          if (!ta) return;
          ta.focus();
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(ta, "What is the absmean scale in BitNet?");
          ta.dispatchEvent(new Event("input", { bubbles: true }));
          await new Promise((r) => setTimeout(r, 100));
          ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
        },
      },
      { sleep: 2500 },
    ],
  },
  {
    id: "pdf-ranges",
    title: "The PDF tool — page ranges with limits",
    group: "PDF",
    notes:
      "papers/attention-survey.pdf (320 pages) open; the chat asks for a summary and the scripted model calls PdfExtract with no pages, then pages 4-8. After (the box engine's PdfRead rules): no pages → pages 1-3 plus “320 pages in total … pass pages for more”, each call capped at 12k chars (maxChars up to 40k), so the dial stays low. Before: no pages → all 320 pages extracted and ~60k chars returned. “2 tool calls” under the reply is opened: read the end of each result.",
    build: (c) => world(c),
    llm: { scripts: [pdfRanges] },
    open: [...deskOpen("papers/attention-survey.pdf"), { sleep: 1500 }, ...send("Summarize the attention survey PDF."),
      { waitIdle: true, timeout: 90000 },
      // Open the reply's tool calls ("2 tool calls"; before, the whole-PDF
      // extract is slow and the group can read differently — open whatever is there).
      {
        run: async (api) => {
          for (let i = 0; i < 150; i++) {
            const s = api.byText(/\d+ tool calls?/, "details > summary");
            if (s) return void s.click();
            await new Promise((r) => setTimeout(r, 200));
          }
        },
      },
    ],
  },
  {
    id: "search-notes",
    title: "Search — the Notes panel finds what a row shows",
    group: "Search",
    notes:
      "Notes with AI titles, plus two cleared notes kept on disk. The query “failure modes” is from a note's TITLE (the bold line on its row). After: the note is found and the count reads “1 of 5” (open + resolved). Before: “No matches.” (title, highlighted text and summary weren't searched, and the words had to be adjacent) and the count includes the cleared notes (“0 of 7”).",
    build: (c) => {
      world(c);
      const iso = (t: number) => new Date(t).toISOString();
      const extra = [
        { id: "note-eig-title", h: 30, status: "open", title: "Eigengap failure modes", draft: "Find the reference office hours mentioned.", sel: "the heuristic fails when cluster sizes differ or clusters overlap" },
        { id: "note-cleared-1", h: 90, status: "cleared", title: "Old: GPU quota", draft: "Ask for A10 quota." },
        { id: "note-cleared-2", h: 95, status: "cleared", title: "Old: rename runs", draft: "Rename runs by seed." },
      ].map((n) =>
        JSON.stringify({
          id: n.id,
          timestamp: iso(c.now - n.h * 3_600_000),
          last_updated: iso(c.now - n.h * 3_600_000),
          anchors: n.sel ? [{ source_path: "notes/spectral-clustering.md", source_kind: "markdown", source_anchor: null, source_selection: n.sel, primary: true }] : [],
          turns: [],
          user_draft: n.draft,
          status: n.status,
          title: n.title,
        }),
      );
      c.write(".vault-chat/notes.jsonl", (c.read(".vault-chat/notes.jsonl") ?? "") + extra.join("\n") + "\n");
    },
    open: [{ file: NOTE }, { click: "[title^='Notes']" }, { sleep: 300 }, { type: "failure modes", into: "input[placeholder='Search…']" }],
  },
  {
    id: "search-mention",
    title: "Search — @-mention ranking",
    group: "Search",
    notes:
      "The composer with “@eigengap” typed: a long file name that STARTS with the query vs short ones that merely contain it. After: name-prefix matches first, then name-contains, then path matches. Before: the long prefix match sinks below the contains matches (its score fell with name length). The note composer's link picker (Ctrl+N → link a file) had the same ranking and the same fix.",
    build: (c) => {
      world(c);
      c.write("notes/eigengap-heuristic-when-it-fails-unbalanced-cluster-sizes-and-overlap.md", "# Eigengap heuristic — failure cases\n");
      c.write("reading/spectral-eigengap.md", "# Reading: spectral methods and the eigengap\n");
    },
    activeConversation: "c-spectral",
    open: [...deskOpen(NOTE, "c-spectral"), { sleep: 400 }, { type: "@eigengap", into: COMPOSER }],
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
    id: "box-unreachable",
    title: "Phase 2 — chat when the box is unreachable",
    group: "Sync",
    notes:
      "Box mode (Phase 2): the vault's sync.json names a box, so every chat turn runs on the box. Here the box can't be reached. After: the composer is disabled and says “Box unreachable — agent runs on the box” (notes and editing still work). Before: the laptop runs the agent itself, so the composer stays open; only the sync chip turns red.",
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
            changes_waiting: 1,
          },
        ],
      },
    },
    overrides: {
      box_get_json: { error: "error sending request for url (https://box.tail0a1b2.ts.net/poll?after=latest): dns error: Could not resolve host" },
      box_post_json: { error: "error sending request for url (https://box.tail0a1b2.ts.net/message): dns error: Could not resolve host" },
    },
    fastTimers: syncTimers,
    activeConversation: "c-spectral",
    open: [...deskOpen(NOTE, "c-spectral"), { sleep: 1500 }, { advance: 11 * MIN }, { sleep: 2500 }],
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
];
