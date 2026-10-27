// Every scenario the harness can boot. Each builds on the same synthetic world
// (world.ts) and differs in what the fake backend and fake model answer, and
// which screen the open-steps drive the real app to.
import type { BuildCtx, Scenario, Step } from "./types";
import * as W from "./world";
import { phase3Scenarios } from "./phase3";
import { phase2Scenarios } from "./phase2";
import { convFullScenarios } from "./convFull";
import { voiceScenarios } from "./voice";
import { voiceOneAgentScenarios } from "./voiceOneAgent";
import { steerScenarios } from "./steer";
import { retryScenarios } from "./retry";
import { markdownScenarios } from "./markdown";
import { visualScenarios } from "./visual";
import { liveEditScenarios } from "./liveEdit";
import { backgroundScenarios } from "./background";
import { projectFolderScenarios, projectReviewScenarios } from "./projectFolders";
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

const BOX = { box: "https://thinkbox.tail0a1b2.ts.net", vault: "summer-demo" };

/** Settings → Box: connect a box from the app (discovery on the tailnet, the
 *  box's own OpenRouter key, the vault's own repo on the box) and disconnect.
 *  The fake is stateful for the page session, so the flow works by clicking. */
const THINKBOX = "https://thinkbox.tail0a1b2.ts.net";
const TOWER = "https://tower.tail0a1b2.ts.net";
const showBox: Step = { run: () => [...document.querySelectorAll("h3")].find((h) => h.textContent === "Box")?.scrollIntoView({ block: "start" }) };
function boxConnectScenarios(): Scenario[] {
  const thinkbox = { name: "thinkbox", version: "0.6.33" };
  const tower = { name: "tower", version: "0.6.30", online: false };
  return [
    {
      id: "box-connect",
      title: "Settings → Box — connect a box",
      group: "Settings",
      notes:
        "This vault has no box: Box says “Runs on this laptop”, and Phone says the phone app runs on a box. Click Connect a box: the tailnet has thinkbox (a vault-chat server, online, no keys yet) and tower (seen before, offline now). Pick thinkbox → Sync this vault with thinkbox. Connecting also sends this laptop's keys (OpenRouter, ElevenLabs, Tavily, lambda_api_key) to thinkbox — nothing about keys shows; the harness toast lists the names the fake box received. It becomes connected: the status rows, “Runs on thinkbox”, and Phone shows thinkbox's fixed link (no token). Change or remove a key under Keys: it is pushed again (toast). Picking tower says it didn't answer; “Or enter an address” checks any URL.",
      build: (c: BuildCtx) => world(c),
      host: {
        sync: {
          box: null,
          discover: [{ name: "thinkbox", url: THINKBOX, version: "0.6.33", online: true, hasKey: false }],
          boxes: { [THINKBOX]: { ...thinkbox }, [TOWER]: { ...tower } },
        },
        keys: { "service.tavily": "tvly-PREVIEW-0000", "user.lambda_api_key": "PREVIEW-lambda-0000" },
      },
      // tower answered once before; the app remembers the boxes it has seen.
      localStorage: {
        "vault-chat:known-boxes": JSON.stringify([{ name: "tower", url: TOWER, version: "0.6.30", online: false, hasKey: true }]),
        vault_chat_user_keys: JSON.stringify(["lambda_api_key"]),
      },
      open: [{ click: "[title='Settings']" }, { sleep: 600 }, showBox],
    },
    {
      id: "box-connect-second",
      title: "Settings → Box — connect a second vault to the same box",
      group: "Settings",
      notes:
        "thinkbox already runs another vault (school2) and has its keys. Click Connect a box → thinkbox → Sync this vault with thinkbox: the box adds summer-demo beside school2 (the harness toast lists the box's vaults: school2, summer-demo) and gives it an agent of its own; Box says “Runs on thinkbox”. From here every request the laptop sends names summer-demo, so its chat never runs in school2.",
      build: (c: BuildCtx) => world(c),
      host: {
        sync: {
          box: null,
          discover: [{ name: "thinkbox", url: THINKBOX, version: "0.6.33", online: true, hasKey: true }],
          boxes: { [THINKBOX]: { ...thinkbox, keys: { "api.openrouter": "sk-or-PREVIEW-0000000000000000000000000000000000000000" }, vaults: ["school2"] }, [TOWER]: { ...tower } },
        },
      },
      open: [{ click: "[title='Settings']" }, { sleep: 600 }, showBox],
    },
    {
      id: "box-connected",
      title: "Settings → Box — connected, disconnect",
      group: "Settings",
      notes:
        "This vault syncs with thinkbox and its chat runs there: Box says “Runs on thinkbox” over the status rows; Phone shows thinkbox's fixed https link, no token. Click disconnect → confirm: sync.json loses its box (thinkbox keeps its copy) and Box flips back to “Runs on this laptop” with Connect a box; Phone says the phone app runs on a box.",
      build: (c: BuildCtx) => world(c),
      host: {
        sync: {
          box: { box: THINKBOX, vault: "summer-demo", name: "thinkbox" },
          boxes: { [THINKBOX]: { ...thinkbox, keys: { "api.openrouter": "sk-or-PREVIEW-0000000000000000000000000000000000000000" }, vaults: ["summer-demo"] }, [TOWER]: { ...tower } },
        },
      },
      open: [{ click: "[title='Settings']" }, { sleep: 600 }, showBox],
    },
  ];
}

/** Settings with every role set: Chat Claude Sonnet 5.5 (in the catalog:
 *  passes), Background a model missing from the catalog (so the short real
 *  test runs; the preview answers it like OpenRouter: no images, tools yes —
 *  Background needs only tools), Voice Gemini (sees images and PDFs). */
function checkScenario(): Scenario {
  return {
    id: "settings-check",
    title: "Settings — each picked model is checked for its role",
    group: "Settings",
    notes:
      "Each role's picker is the chat's search-and-scroll menu. Under it: Passed, or what the model can't do for that role. Try Voice → a Claude model: it can't see PDFs (only Gemini gets the open PDF). Voice: the account's ElevenLabs voices and a Test button.",
    build: (c: BuildCtx) => world(c),
    host: { sync: { box: BOX }, keys: { "service.tavily": "tvly-PREVIEW-0000", "user.lambda_api_key": "PREVIEW-lambda-0000" } },
    localStorage: {
      vault_chat_model: "anthropic/claude-sonnet-5.5",
      vault_chat_background_model: "deepseek/deepseek-v4",
      vault_chat_user_keys: JSON.stringify(["lambda_api_key"]),
    },
    open: [{ click: "[title='Settings']" }, { sleep: 600 }],
  };
}
/** Settings → Voice: the dropdown shows only the selected Brian (the
 *  one-time snapshot hides the rest, the other Brian too), then Browse the
 *  voice library…: Recommended on top, a silent preview played, Marcus picked
 *  (added to the fake account, then selected) — and he shows in the dropdown. */
function voiceLibraryScenario(): Scenario {
  const MARCUS = "lIbMarcusxxxxxxxxxxx";
  const until = async (what: string, ok: () => boolean, ms = 6000) => {
    const t0 = Date.now();
    while (!ok()) {
      if (Date.now() - t0 > ms) throw new Error(`voice-library: ${what}`);
      await new Promise((r) => setTimeout(r, 60));
    }
  };
  const voiceSection = () => [...document.querySelectorAll("h3")].find((h) => h.textContent === "Voice")?.closest("section") as HTMLElement | null;
  const trigger = () => voiceSection()?.querySelector("button") as HTMLButtonElement | null;
  // The open menu's rows, by voice id; and no hide control anywhere.
  const rows = (want: string[]) => {
    const got = [...document.querySelectorAll<HTMLElement>("[data-option]")].map((r) => r.dataset.option ?? "").sort();
    if (JSON.stringify(got) !== JSON.stringify([...want].sort())) throw new Error(`voice-library: menu rows ${got.join(", ")} (want ${want.join(", ")})`);
    if ([...voiceSection()!.querySelectorAll("button")].some((b) => /hide|keep only/i.test(b.textContent ?? ""))) throw new Error("voice-library: a hide control is shown");
  };
  const openPicker: Step = {
    run: async () => {
      voiceSection()?.scrollIntoView({ block: "start" });
      await until("the voice picker", () => !!trigger() && trigger()!.textContent !== "Loading voices…");
      trigger()!.click();
    },
  };
  return {
    id: "voice-library",
    title: "Settings — pick a voice from the ElevenLabs library",
    group: "Settings",
    notes:
      "Settings → Voice: the menu shows only the selected voice (Brian, American): the first load hid the account's other voices once (the British Brian too; by id). Browse the voice library… at its bottom: Recommended (ElevenLabs' featured English conversational voices) on top, then the most used lately; search by name or description, All uses widens past conversational. ▶ plays a voice's preview (silent here); a click adds it to the account and selects it: Marcus becomes the voice, and the menu now holds Brian and Marcus.",
    build: (c: BuildCtx) => world(c),
    host: { sync: { box: BOX } },
    localStorage: { vault_chat_elevenlabs_voice: "nPczCjzI2devNBz1zQrb" },
    open: [
      { click: "[title='Settings']" },
      { sleep: 600 },
      openPicker,
      { run: () => rows(["nPczCjzI2devNBz1zQrb"]) },
      { click: "button", text: /^Browse the voice library/ },
      { wait: "[data-voice-library] [data-voice]" },
      {
        run: async (api) => {
          await until("Recommended", () => !!api.byText("Recommended", "div"));
        },
      },
      { click: "[data-voice-library] button[title='Play a sample']" },
      { sleep: 300 },
      { click: `[data-voice-library] [data-voice='${MARCUS}'] button:nth-of-type(2)` },
      {
        run: async () => {
          await until("Marcus selected", () => trigger()?.textContent === "Marcus" && localStorage.getItem("vault_chat_elevenlabs_voice") === MARCUS);
          if (document.querySelector("[data-voice-library]")) throw new Error("voice-library: the library stayed open");
        },
      },
      openPicker,
      { run: () => rows(["nPczCjzI2devNBz1zQrb", MARCUS]) },
      { key: "Escape", target: "input[type=search]" },
    ],
  };
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
    notes: "A first run: no box, no keys, no conversations. The chat pane says “Connect your box to chat” with one button to Settings → Box; files, the editor, notes and history work without it.",
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

  // ===== Settings / search =====
  {
    id: "settings",
    title: "Settings (configured)",
    group: "Settings",
    notes: "The Settings pane with an OpenRouter key, a web-search key and box sync configured. Scroll through every section; edits apply in memory.",
    build: (c) => world(c),
    host: { sync: { box: BOX }, keys: { "service.tavily": "tvly-PREVIEW-0000" } },
    open: [{ click: "[title='Settings']" }],
  },
  checkScenario(),
  voiceLibraryScenario(),
  {
    id: "settings-fresh",
    title: "Settings (fresh install, no keys)",
    group: "Settings",
    notes: "Settings on a first run: no keys anywhere.",
    host: { keys: { "api.openrouter": null } },
    build: () => {},
    open: [{ click: "[title='Settings']" }],
  },
  ...boxConnectScenarios(),
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
    open: [{ file: NOTE }, { optional: true, click: "[title='Mission control']" }],
    surfaces: ["desktop", "phone"],
    phone: { page: "activity" },
  },
  {
    id: "missions-awaiting",
    title: "Mission Control — a mission waiting for you",
    group: "Missions",
    notes: "The BitNet mission is AWAITING_USER: it asked whether to extend to 3.2B tokens. The ask is in Alerts.",
    build: (c) => world(c, { awaiting: true }),
    open: [{ file: NOTE }, { optional: true, click: "[title='Mission control']" }],
    surfaces: ["desktop", "phone"],
    phone: { page: "alerts" },
  },
  {
    id: "mission-page",
    title: "Mission Control — the mission page",
    group: "Missions",
    notes: "The BitNet mission's own page: brief, done-when checklist, audits, workers, cost.",
    build: (c) => world(c),
    open: [{ file: NOTE }, { optional: true, click: "[title='Mission control']" }, { sleep: 400 }, { optional: true, click: "button, [role=button], div", text: /^BitNet 160M MVP/ }],
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
    phone: { page: "activity", clicks: ["?text:BitNet 160M MVP"] },
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
  {
    id: "phone-vaults",
    title: "Phone — a box with two vaults",
    group: "Phone",
    notes:
      "This box has two vaults, summer-demo (its main one) and physics, each with its own agent. The menu lists both at the top, the open one marked. Tap physics: the page reopens on physics' own conversations (Conversations shows “Optics — problem set 4”); the menu marks physics. A box with one vault shows no vault rows (phone-settings).",
    build: (c) => world(c),
    surfaces: ["phone"],
    phone: {
      clicks: ["#menuBtn"],
      db: (db, now) => {
        const msgs = [
          { role: "user", content: "Set up problem 3: the thin-lens equation with the object inside f." },
          { role: "assistant", content: "With the object inside f the image is virtual and upright: 1/d_i = 1/f - 1/d_o is negative." },
        ];
        db.vaults = {
          physics: {
            convs: [{ id: "p1", title: "Optics — problem set 4", source: "phone", role: "", lastActivityAt: now - 600_000, msgCount: 2, preview: "With the object inside f the image is virtual and upright", goal: "" }],
            threads: { p1: { id: "p1", title: "Optics — problem set 4", source: "phone", status: "idle", messages: msgs } },
            runs: [],
            notifs: [],
            notes: [],
            schedules: [],
            projects: [],
          },
        };
      },
    },
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
            error: "git fetch failed (exit 128):\nfatal: unable to access 'https://thinkbox.tail0a1b2.ts.net/git/summer-demo.git/': Could not resolve host: box.tail0a1b2.ts.net",
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
    id: "box-tailscale-down",
    title: "Sync — Tailscale isn't connected",
    group: "Sync",
    notes:
      "Box mode, and Tailscale on this laptop is stopped, so the box can't be reached. After the failed cycle the app asks Tailscale once (tailscale status --json → BackendState “Stopped”) and the chip says so at once: “Tailscale isn't connected”, with Open Tailscale beside it (Windows: the tray app; macOS: the app; Linux: the text only). Edits keep being committed here (2 waiting). Click Open Tailscale: the preview connects it and the next cycle syncs, so the chip goes away by itself. Before: the chip waits a minute and says “Box unreachable · 2 changes waiting”.",
    build: (c) => world(c),
    host: {
      sync: {
        box: BOX,
        tailscale: { installed: true, connected: false, state: "Stopped", canOpen: true },
        reports: [
          {
            ok: false,
            message: "sync failed",
            error: "git fetch box failed (exit 128):\nfatal: unable to access 'https://thinkbox.tail0a1b2.ts.net/git/summer-demo.git/': Could not resolve host: thinkbox.tail0a1b2.ts.net",
            error_kind: "unreachable",
            changes_waiting: 2,
          },
        ],
      },
    },
    fastTimers: syncTimers,
    open: [...deskOpen(NOTE, "c-spectral"), { sleep: 1200 }, { advance: 2 * MIN }, { sleep: 2500 }],
  },
  {
    id: "box-unreachable",
    title: "Phase 2 — chat when the box is unreachable",
    group: "Sync",
    notes:
      "Box mode (Phase 2): the vault's sync.json names a box, so every chat turn runs on the box. Here the box can't be reached: the composer is disabled and says “Box unreachable — <why>. Retrying…”, the footer says the same, and the feed retries in the background. Opening, editing and saving a note still work (the sync catches up later).",
    build: (c) => world(c),
    host: {
      sync: {
        box: BOX,
        reports: [
          {
            ok: false,
            message: "box unreachable",
            error: "git fetch failed (exit 128):\nfatal: unable to access 'https://thinkbox.tail0a1b2.ts.net/git/summer-demo.git/': Could not resolve host: box.tail0a1b2.ts.net",
            error_kind: "unreachable",
            changes_waiting: 1,
          },
        ],
      },
    },
    overrides: {
      box_get_json: { error: "error sending request for url (https://thinkbox.tail0a1b2.ts.net/poll?after=latest): dns error: Could not resolve host" },
      box_post_json: { error: "error sending request for url (https://thinkbox.tail0a1b2.ts.net/message): dns error: Could not resolve host" },
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
  // [roleplay] The real desktop frontend against a REAL vault-chat server (VC_REALBOX=<url> on the dev server; the
  // vault there is ?vault=<name>): its chat, voice and waiting line are the box's, nothing is scripted. No chats of its
  // own (the box serves them); the laptop's vault is the synthetic one (files only, never synced anywhere).
  {
    id: "realbox",
    title: "Real box (VC_REALBOX): the desktop against a running server",
    group: "Roleplay",
    notes: "Start the dev server with VC_REALBOX=http://127.0.0.1:<port> and open ?scenario=realbox&vault=<name>.",
    // The real clock: the box's times (a job's startedAt) are real.
    clock: new Date().toISOString(),
    build: () => {},
    host: () => ({ sync: { box: { box: "http://realbox.localhost", vault: new URLSearchParams(location.search).get("vault") || "main" }, reports: [{ configured: true, ok: true, message: "ok" }] } }),
    surfaces: ["desktop"],
  },
  ...phase3Scenarios,
  ...phase2Scenarios,
  ...convFullScenarios,
  ...voiceScenarios,
  ...voiceOneAgentScenarios,
  ...steerScenarios,
  ...retryScenarios,
  ...markdownScenarios,
  ...visualScenarios,
  ...liveEditScenarios,
  ...backgroundScenarios,
  ...projectFolderScenarios,
  ...projectReviewScenarios,
];
