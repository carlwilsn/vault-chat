// Phase 3 (removals and replacements): the synthetic world after Phase 2 —
// conversations the box's engine runs, tagged with projects and carrying the
// ongoing-work meta (`state`, `nextWakeAt`, `costUsd`), the engine's
// notifications, and the projects folder. The old mission threads from
// world.ts stay in, as the archive.
import type { BuildCtx, Scenario, Step } from "./types";
import * as W from "./world";
import { summary as phoneSummary, thread as phoneThread } from "./phone";

const MIN = 60_000;
const HOUR = 60 * MIN;

export const PROJECTS = [
  { slug: "bitnet-160m", name: "BitNet 160M" },
  { slug: "coursework", name: "Coursework" },
];

const u = (content: string, extra: Record<string, unknown> = {}) => ({ role: "user", content, ...extra });
const a = (content: string, extra: Record<string, unknown> = {}) => ({ role: "assistant", content, ...extra });
const call = (name: string, input: unknown, result: string) => ({ id: `call_${name}_${Math.random().toString(36).slice(2, 8)}`, name, input, result });

/** A wake time on the scenario clock, rounded to the minute (reads as "next 3:40"). */
const at = (now: number, ms: number) => Math.round((now + ms) / MIN) * MIN;

export function convs(now: number): W.Conv[] {
  return [
    {
      id: "p-seed44",
      title: "Train seed 44 to 3.2B tokens",
      source: "phone",
      status: "idle",
      unread: false,
      createdAt: now - 3 * HOUR,
      lastActivityAt: now - 12 * MIN,
      project: "bitnet-160m",
      working: true,
      state: "sleeping",
      nextWakeAt: at(now, 38 * MIN),
      costUsd: 1.2,
      threadId: "thr_seed44",
      messages: [
        u("Train seed 44 out to 3.2B tokens with the re-fit cosine schedule, and keep an eye on it until it's done."),
        a("Started on the A10: `train.py --seed 44 --tokens 3.2e9 --schedule cosine-6100`. The first 400 steps look healthy — loss 3.91 → 3.12, no spikes, LR warmup as planned.\n\nI'll check the run again in 40 minutes.", {
          toolCalls: [
            call("StartJob", { command: "python train.py --seed 44 --tokens 3.2e9 --schedule cosine-6100", name: "seed44" }, "job seed44 started (pid 41822, gpu 0)"),
            call("JobStatus", { name: "seed44" }, "step 400/6100 · loss 3.12 · 1.9 it/s"),
            call("ScheduleWake", { in: "40m", reason: "Checking the run" }, "wake set"),
          ],
          costUsd: 0.31,
        }),
      ],
    },
    {
      id: "p-evaltable",
      title: "Eval table for the writeup",
      source: "manual",
      status: "idle",
      unread: false,
      createdAt: now - 26 * HOUR,
      lastActivityAt: now - 22 * HOUR,
      project: "bitnet-160m",
      state: "done",
      costUsd: 0.42,
      messages: [
        u("Build the eval table for the writeup from results/*.jsonl."),
        a("Done — `writeup.md` now has the three-seed table (1.5576 / 1.5601 / 1.5588, mean 1.5588 ± 0.0010).", { costUsd: 0.42 }),
      ],
    },
    {
      id: "p-ps3",
      title: "PS3 problem 5 — which bound to use",
      source: "phone",
      status: "idle",
      unread: true,
      createdAt: now - 50 * MIN,
      lastActivityAt: now - 6 * MIN,
      project: "coursework",
      state: "waiting_user",
      costUsd: 0.08,
      pendingAsk: { question: "Davis–Kahan or Weyl for part (b)?", options: ["Davis–Kahan", "Weyl"], at: now - 6 * MIN },
      messages: [
        u("Draft PS3 problem 5. Ask me before picking the bound for part (b)."),
        a("Part (a) is drafted in `coursework/ps3.md`. For part (b) there are two clean routes — which do you want?", {
          askOptions: [
            { answer: "Davis–Kahan", title: "Davis–Kahan", body: "Bounds the eigenvector perturbation directly; matches lecture 9's notation." },
            { answer: "Weyl", title: "Weyl", body: "Only eigenvalues — shorter, but part (c) then needs an extra step." },
          ],
          costUsd: 0.08,
        }),
      ],
    },
    {
      id: "p-sweep",
      title: "Sweep the repos for drift",
      source: "phone",
      status: "running",
      unread: false,
      createdAt: now - 4 * MIN,
      lastActivityAt: now - 1 * MIN,
      state: "running",
      costUsd: 0.05,
      messages: [u("Sweep the repos for uncommitted drift and tell me if anything matters.")],
    },
    {
      id: "c-plan",
      title: "Set up the 3.2B extension",
      source: "manual",
      status: "idle",
      unread: false,
      createdAt: now - 30 * HOUR,
      lastActivityAt: now - 29 * HOUR,
      messages: [
        u("Set up the 3.2B-token extension as a proper piece of work."),
        a(
          "Here's the plan — approve it and it runs as a mission.\n\n```plan\ntitle: Extend BitNet 160M to 3.2B tokens\n- re-fit the cosine schedule for 6100 steps\n- train seed 42 to 3.2B and compare against the reference\n- update the writeup's results table\n```",
        ),
      ],
    },
    {
      id: "p-figure",
      title: "Render the thesis figures",
      source: "manual",
      status: "idle",
      unread: false,
      createdAt: now - 5 * HOUR,
      lastActivityAt: now - 2 * HOUR,
      state: "blocked",
      costUsd: 0.91,
      messages: [
        u("Render all the thesis figures at 300 dpi."),
        a("Blocked: `make figures` needs `latexmk`, which isn't installed on the box, and installing system packages is yours to decide.", { costUsd: 0.91 }),
      ],
    },
  ];
}

export function notifications(now: number): string[] {
  const out = [
    { id: "e-ask", ts: now - 6 * MIN, kind: "ask", title: "Needs you: PS3 problem 5 — which bound to use", body: "Davis–Kahan or Weyl for part (b)?", convId: "p-ps3", deliberation: { ask: "Davis–Kahan or Weyl for part (b)?", options: [{ answer: "Davis–Kahan", title: "Davis–Kahan", body: "" }, { answer: "Weyl", title: "Weyl", body: "" }] } },
    { id: "e-blocked", ts: now - 2 * HOUR, kind: "info", title: "Blocked: Render the thesis figures", body: "`make figures` needs latexmk, which isn't installed on the box.", convId: "p-figure" },
    { id: "e-done", ts: now - 22 * HOUR, kind: "info", title: "Done: Eval table for the writeup", body: "Three-seed table in writeup.md (mean 1.5588 ± 0.0010).\nVerifier: pass", convId: "p-evaltable" },
  ];
  return out.map((o) => JSON.stringify(o));
}

/** world.ts's world plus the Phase 2 conversations, notifications and projects. */
export function build(ctx: BuildCtx): void {
  const { now, vault } = ctx;
  ctx.conversations([...convs(now), ...W.chats(vault, now), ...W.missions(now)]);
  ctx.write(".vault-chat/notifications.jsonl", [...W.notifications(now), ...notifications(now)].join("\n") + "\n");
  ctx.write(".vault-chat/notes.jsonl", W.notes(now).join("\n") + "\n");
  ctx.write(".vault-chat/schedules.jsonl", W.schedules(now).join("\n") + "\n");
  for (const p of PROJECTS) {
    ctx.write(`.vault-chat/projects/${p.slug}/project.md`, `# ${p.name}\n\n## What\n\n(synthetic fixture)\n`);
    ctx.write(`.vault-chat/projects/${p.slug}/memory.md`, `# Memory: ${p.name}\n`);
  }
  ctx.history(W.history(now) as any);
}

/** The phone's mock box for the same world (scenarios/phone.ts builds the rest). */
export function phoneDb(db: any, now: number): void {
  const extra = convs(now);
  db.convs = [...extra.map(phoneSummary), ...db.convs];
  for (const c of extra) db.threads[c.id] = phoneThread(c);
  db.projects = PROJECTS;
  db.notifs = [
    ...notifications(now).map((l) => ({ ...JSON.parse(l), read: false, summary: "" })),
    ...db.notifs.map((n: any) => ({ ...n, read: true })),
  ];
  db.runs = [{ convId: "p-sweep", title: "Sweep the repos for drift", source: "phone", lastTool: "Bash", lastProgressAt: now - 20_000 }];
}

const NOTE = "projects/bitnet-160m/writeup.md";
const open = (conv: string, extra: Step[] = []): Step[] => [{ file: NOTE }, { chat: true }, { conversation: conv }, { sleep: 500 }, ...extra];

// Playable steps that work on both sides: a target that only exists on one
// side is clicked when present and skipped when not, so the tour shows
// "before: X opens" and "after: X is gone / Y instead" from the same script.
const tryClick = (sel: string, text?: RegExp): Step => ({
  run: (api) => {
    const el = text ? api.byText(text, sel) : api.q(sel);
    if (!el) return;
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.click();
  },
});
const tryType = (sel: string, text: string): Step => ({
  run: (api) => {
    const el = api.q(sel) as HTMLInputElement | null;
    if (!el) return;
    el.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  },
});
const tryEnter = (sel: string): Step => ({
  run: (api) => {
    const el = api.q(sel);
    if (!el) return;
    const init = { key: "Enter", code: "Enter", bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent("keydown", init));
  },
});
const pause = (ms = 1200): Step => ({ sleep: ms });
const CHATS = "[title^='Chats — switch']";
const CHIP = "[title^='Project —']";

export const phase3Scenarios: Scenario[] = [
  // ----- desktop: removed -----
  {
    id: "p3-titlebar",
    title: "Mission Control is gone — the bell is in the Rocket's place",
    group: "P3 · Removals",
    notes:
      "Plays: click the titlebar button between Notes and the mic. Before: the Rocket opens Mission Control (Missions / Schedules / Notifications). After: there is no Rocket; the bell in its place opens the notification list.",
    build,
    open: [...open("c-spectral"), pause(), tryClick("[title='Mission control']"), tryClick("[title='Notifications']"), pause(2500)],
  },
  {
    id: "p3-approve-gone",
    title: "Approve & run is gone",
    group: "P3 · Removals",
    notes:
      "A chat where the agent once proposed a mission. Before: an “Approve & run” card. After: the old plan block shows as a plain code block; no card, no button — there is no missions system to start.",
    build: (c) => {
      build(c);
    },
    activeConversation: "c-plan",
    open: [...open("c-plan"), pause(2000)],
  },
  // ----- desktop: the chat list -----
  {
    id: "p3-chats",
    title: "Chats — grouped by project; old missions archived",
    group: "P3 · Chats",
    notes:
      "Plays: open Chats, then open “Archived missions”. Before: one list, mission/worker/ask threads mixed in with chats. After (option A, sections): each project is a section (hover its header: + New chat in project), chats without a project keep Running / Recent / Earlier, rows doing long work show the ongoing-work line, and the old threads fold into Archived missions at the bottom.",
    build,
    open: [...open("p-seed44"), pause(), { click: CHATS }, pause(1800), tryClick("button", /^Archived missions/), pause(2000)],
  },
  {
    id: "p3-chats-folders",
    title: "Chats — option B: projects as folders",
    group: "P3 · Chats",
    notes: "Plays: open Chats, then open the BitNet 160M folder. Option B: one row per project with its count and how many are working; it opens in place.",
    localStorage: { vc_chat_grouping: "folders" },
    build,
    open: [...open("p-seed44"), pause(), { click: CHATS }, pause(1500), tryClick("button[aria-expanded]", /BitNet 160M/), pause(2000)],
  },
  {
    id: "p3-archived",
    title: "An archived mission thread — readable, read-only",
    group: "P3 · Chats",
    notes:
      "Plays: Chats → Archived missions → the BitNet mission. Before: the mission thread with a live composer (a message would drive the supervisor). After: the history renders as before; the composer is off — “Archived mission thread — read only”.",
    build,
    open: [...open("c-spectral"), pause(), { click: CHATS }, pause(1000), tryClick("button", /^Archived missions/), pause(800), { click: "button", text: /^BitNet 160M MVP/ }, pause(2500)],
  },
  // ----- desktop: the chat -----
  {
    id: "p3-chat-chip",
    title: "Project chip — set a project on a chat",
    group: "P3 · Chat",
    notes:
      "Plays: a chat with no project; click the chip over the thread, type “BitNet”, Enter — the chat joins BitNet 160M (open Chats to see it move into the section). Before: there is no chip.",
    build,
    activeConversation: "c-spectral",
    open: [...open("c-spectral"), pause(), tryClick(CHIP), pause(900), tryType("input[placeholder^='Find or name a project']", "BitNet"), pause(1200), tryEnter("input[placeholder^='Find or name a project']"), pause(1500), { click: CHATS }, pause(2200)],
  },
  {
    id: "p3-chat-new-in-project",
    title: "Project chip — New chat in project",
    group: "P3 · Chat",
    notes: "Plays: in a BitNet 160M chat, chip → “New chat in BitNet 160M”: a fresh chat, already in the project. Before: no chip; New chat is the + only.",
    build,
    activeConversation: "p-evaltable",
    open: [...open("p-evaltable"), pause(), tryClick(CHIP), pause(1200), tryClick("button", /^New chat in BitNet 160M/), pause(2000)],
  },
  {
    id: "p3-chat-chip-footer",
    title: "Project chip — option B: beside the model picker",
    group: "P3 · Chat",
    notes: "Plays: the same chip in the composer's footer row, next to the model picker, opened.",
    localStorage: { vc_project_chip: "footer" },
    build,
    activeConversation: "p-seed44",
    open: [...open("p-seed44"), pause(), tryClick(CHIP), pause(2200)],
  },
  {
    id: "p3-ongoing",
    title: "The ongoing-work line — working, waiting, waiting for you, blocked",
    group: "P3 · Chat",
    notes:
      "Plays: a keep-going chat (“checking the run · next h:mm · $1.20”, grey dot: waiting on its own wake), then through Chats to PS3 problem 5 (“Waiting for you · $0.08”, accent dot), the repo sweep (“Working · $0.05”, pulsing) and the thesis figures (“Blocked · $0.91”, red). Before: no line anywhere.",
    build,
    activeConversation: "p-seed44",
    open: [
      ...open("p-seed44"),
      pause(2200),
      { click: CHATS }, pause(900), { click: "button", text: /^PS3 problem 5/ }, pause(2000),
      { click: CHATS }, pause(900), { click: "button", text: /^Sweep the repos/ }, pause(2000),
      { click: CHATS }, pause(900), { click: "button", text: /^Render the thesis figures/ }, pause(2200),
    ],
  },
  // ----- desktop: notifications -----
  {
    id: "p3-notifs",
    title: "Notifications — one list, each opens its conversation",
    group: "P3 · Notifications",
    notes:
      "Plays: open the list, click the question. Before: Rocket → Mission Control → its Notifications tab. After (option A, popover): the bell's list — questions (?), finished work (✓), failures (!), unread dotted; a click marks it read and opens its conversation (here PS3 problem 5, waiting for you).",
    build,
    open: [
      ...open("p-seed44"),
      pause(),
      tryClick("[title='Mission control']"), pause(800), tryClick("button", /^Notifications/),
      tryClick("[title='Notifications']"),
      pause(2200),
      tryClick("button", /^Needs you: PS3 problem 5/),
      pause(2200),
    ],
  },
  {
    id: "p3-notifs-panel",
    title: "Notifications — option B: a side panel",
    group: "P3 · Notifications",
    notes: "Plays: the bell opens the same list in the Chats panel's right-hand sheet instead of a popover.",
    localStorage: { vc_notif_style: "panel" },
    build,
    open: [...open("p-seed44"), pause(), tryClick("[title='Notifications']"), pause(2500)],
  },
  // ----- phone -----
  {
    id: "p3-phone-menu",
    title: "Phone — the menu without Activity",
    group: "P3 · Phone",
    notes: "Plays: open the menu, tap Activity. Before: Chat, Activity, Alerts, Notes, Voice, Box & settings — Activity opens the missions board. After: there is no Activity row (missions, workers and schedules are gone); the menu stays open.",
    build,
    surfaces: ["phone"],
    phone: { clicks: ["#menuBtn", '?.mrow[data-page="activity"]'], db: phoneDb },
  },
  {
    id: "p3-phone-chats",
    title: "Phone — conversations grouped by project",
    group: "P3 · Phone",
    notes: "Plays: open the conversations drawer. Project sections (+ starts a chat in the project), then Chats, the ongoing-work line on rows doing long work, and Archived missions folded at the bottom. Before: your chats only, ungrouped (missions lived on Activity).",
    build,
    surfaces: ["phone"],
    phone: { clicks: ["#convBtn"], db: phoneDb },
  },
  {
    id: "p3-phone-archived",
    title: "Phone — an archived mission thread",
    group: "P3 · Phone",
    notes: "Plays: drawer → Archived missions → the BitNet mission: the old thread, readable; the composer says “Archived mission thread — read only”. Before: there is no archive in the drawer (missions were on Activity).",
    build,
    surfaces: ["phone"],
    phone: { clicks: ["#convBtn", "?text:Archived missions · 5", "?text:BitNet 160M MVP"], db: phoneDb },
  },
  {
    id: "p3-phone-new-in-project",
    title: "Phone — New chat in a project",
    group: "P3 · Phone",
    notes: "Plays: drawer → the + on the BitNet 160M section: a new chat whose header already says BitNet 160M (its first message creates it in the project).",
    build,
    surfaces: ["phone"],
    phone: { clicks: ["#convBtn", "?.csec.proj .padd"], db: phoneDb },
  },
  {
    id: "p3-phone-approve-gone",
    title: "Phone — Approve & run is gone",
    group: "P3 · Phone",
    notes: "Plays: open a chat where the agent once proposed a mission. Before: the “Proposed mission · Approve & run” card. After: the plan block is plain text in a code block.",
    build,
    surfaces: ["phone"],
    phone: { clicks: ["#convBtn", "text:Set up the 3.2B extension"], db: phoneDb },
  },
  {
    id: "p3-phone-thread",
    title: "Phone — a chat with its project and ongoing work",
    group: "P3 · Phone",
    notes: "The project's name beside the title (tap the title: the project sheet — pick, name a new one, No project, New chat in project) and the ongoing-work line over the composer.",
    build,
    surfaces: ["phone"],
    phone: { clicks: ["#convBtn", "text:Train seed 44 to 3.2B tokens"], db: phoneDb },
  },
  {
    id: "p3-phone-project-sheet",
    title: "Phone — set a chat's project",
    group: "P3 · Phone",
    notes: "Plays: open a chat, tap its title — the project sheet (projects with ✓ on this chat's, No project, New chat in BitNet 160M, a line to name a new one) — tap Coursework: the header now says Coursework. Before: tapping the title opened the Claude/feedback drawer.",
    build,
    surfaces: ["phone"],
    phone: { clicks: ["#convBtn", "text:Train seed 44 to 3.2B tokens", "#titleBtn", "?text:Coursework"], db: phoneDb },
  },
  {
    id: "p3-phone-alerts",
    title: "Phone — notifications open their conversation",
    group: "P3 · Phone",
    notes: "Plays: Alerts, then the question card's chat icon. After: Alerts is the one list — the question card (options answer in the conversation), Blocked and Done cards — and every card opens its conversation (here PS3 problem 5). Before: the chat icon opened a separate deliberation sheet with its own ask thread.",
    build,
    surfaces: ["phone"],
    phone: { page: "alerts", clicks: [".needsyou .digin"], db: phoneDb },
  },
  {
    id: "p3-phone-settings",
    title: "Phone — Box & settings without the Claude/feedback screen",
    group: "P3 · Phone",
    notes: "Plays: menu → Box & settings. Before: the drawer is the Claude screen (Feedback | Chat, reports, the coder chat) with settings behind a gear. After: just Box & settings — notifications, a test push, the version.",
    build,
    surfaces: ["phone"],
    phone: { clicks: ["#menuBtn", "#settingsRow"], db: phoneDb },
  },
];
