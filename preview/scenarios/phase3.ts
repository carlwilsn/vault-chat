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
      codexThreadId: "thr_seed44",
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

export const phase3Scenarios: Scenario[] = [
  // ----- desktop: removed -----
  {
    id: "p3-titlebar",
    title: "Titlebar — the rocket is gone, the bell is in its place",
    group: "P3 · Removals",
    notes:
      "Before: the Rocket opens Mission Control. After: no Mission Control anywhere; the same slot is the bell (a dot when something is unread). The old Missions scenarios show the removal too: their Mission control click finds nothing.",
    build,
    open: open("p-seed44"),
  },
  // ----- desktop: the chat list -----
  {
    id: "p3-chats",
    title: "Chats — grouped by project, ongoing work, archived missions",
    group: "P3 · Chats",
    notes:
      "Option A (sections): each project is a section (hover its header for + New chat in project); chats without a project keep Running / Recent / Earlier; the old mission, worker and ask threads fold into “Archived missions” at the bottom (click to open, read-only). Rows doing long work show the ongoing-work line instead of the preview.",
    build,
    open: open("p-seed44", [{ click: "[title^='Chats — switch']" }, { sleep: 300 }]),
  },
  {
    id: "p3-chats-folders",
    title: "Chats — option B: projects as folders",
    group: "P3 · Chats",
    notes: "Option B (folders): one row per project with its count and how many are working; click to open it in place. Same archive and lines as option A.",
    localStorage: { vc_chat_grouping: "folders" },
    build,
    open: open("p-seed44", [{ click: "[title^='Chats — switch']" }, { sleep: 300 }, { click: "button[aria-expanded]", text: /BitNet 160M/ }]),
  },
  {
    id: "p3-archived",
    title: "An archived mission thread — readable, read-only",
    group: "P3 · Chats",
    notes: "The old BitNet mission thread, opened from Archived missions: the history renders as before; the composer is off with “Archived mission thread — read only”.",
    build,
    activeConversation: "m-bitnet",
    open: open("m-bitnet"),
  },
  // ----- desktop: the chat -----
  {
    id: "p3-chat",
    title: "Chat — project chip (option A: top) and the ongoing-work line",
    group: "P3 · Chat",
    notes:
      "A keep-going conversation on the box: the project chip over the thread (click: pick, create by typing a name, No project, New chat in BitNet 160M) and, above the composer, “checking the run · next h:mm · $1.20” (grey dot = waiting on its own wake).",
    build,
    activeConversation: "p-seed44",
    open: open("p-seed44"),
  },
  {
    id: "p3-chat-chip-open",
    title: "Chat — the project chip's menu",
    group: "P3 · Chat",
    notes: "The chip's menu open: the vault's projects (✓ on this chat's), a search line that creates a project from a new name, No project, and New chat in BitNet 160M.",
    build,
    activeConversation: "p-seed44",
    open: open("p-seed44", [{ click: "[title^='Project —']" }, { sleep: 200 }]),
  },
  {
    id: "p3-chat-chip-footer",
    title: "Chat — option B: the chip beside the model picker",
    group: "P3 · Chat",
    notes: "The same chip in the composer's footer row, next to the model picker, instead of over the thread.",
    localStorage: { vc_project_chip: "footer" },
    build,
    activeConversation: "p-seed44",
    open: open("p-seed44"),
  },
  {
    id: "p3-chat-waiting",
    title: "Chat — waiting for you, and blocked",
    group: "P3 · Chat",
    notes: "PS3 problem 5 asked a question (accent dot, “Waiting for you · $0.08”). Switch to “Render the thesis figures” in Chats for the red “Blocked · $0.91”.",
    build,
    activeConversation: "p-ps3",
    open: open("p-ps3"),
  },
  // ----- desktop: notifications -----
  {
    id: "p3-notifs",
    title: "Notifications — the list behind the bell (option A: popover)",
    group: "P3 · Notifications",
    notes:
      "Replaces Mission Control's Notifications tab: questions (?), finished work (✓), failures (!) — newest first, unread dotted, older under Earlier. Click a row: it's marked read and its conversation opens.",
    build,
    open: open("p-seed44", [{ click: "[title='Notifications']" }, { sleep: 300 }]),
  },
  {
    id: "p3-notifs-panel",
    title: "Notifications — option B: a side panel",
    group: "P3 · Notifications",
    notes: "The same list in the Chats panel's right-hand sheet instead of a popover.",
    localStorage: { vc_notif_style: "panel" },
    build,
    open: open("p-seed44", [{ click: "[title='Notifications']" }, { sleep: 300 }]),
  },
  // ----- phone -----
  {
    id: "p3-phone-menu",
    title: "Phone — the menu without Activity",
    group: "P3 · Phone",
    notes: "Before: Chat, Activity, Alerts, Notes, Voice, Box & settings. After: Activity is gone (missions, workers, schedules).",
    build,
    surfaces: ["phone"],
    phone: { clicks: ["#menuBtn"], db: phoneDb },
  },
  {
    id: "p3-phone-chats",
    title: "Phone — conversations grouped by project",
    group: "P3 · Phone",
    notes: "Project sections (+ starts a chat in the project), then Chats, the ongoing-work line on rows doing long work, and Archived missions folded at the bottom.",
    build,
    surfaces: ["phone"],
    phone: { clicks: ["#convBtn"], db: phoneDb },
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
    title: "Phone — the project sheet",
    group: "P3 · Phone",
    notes: "Tap the chat's title: the projects (✓ on this chat's), No project, New chat in BitNet 160M, and a line to name a new project.",
    build,
    surfaces: ["phone"],
    phone: { clicks: ["#convBtn", "text:Train seed 44 to 3.2B tokens", "#titleBtn"], db: phoneDb },
  },
  {
    id: "p3-phone-alerts",
    title: "Phone — notifications open their conversation",
    group: "P3 · Phone",
    notes: "Alerts is the one list: the question card (options answer in the conversation; the card or its chat icon opens it), Blocked and Done cards open their conversations. No deliberation sheets, no follow-up threads.",
    build,
    surfaces: ["phone"],
    phone: { page: "alerts", db: phoneDb },
  },
  {
    id: "p3-phone-settings",
    title: "Phone — Box & settings without the Claude/feedback screen",
    group: "P3 · Phone",
    notes: "Before: the drawer is the Claude screen (Feedback | Chat, reports, the coder chat) with settings behind a gear. After: just Box & settings — notifications, a test push, the version.",
    build,
    surfaces: ["phone"],
    phone: { clicks: ["#menuBtn", "#settingsRow"], db: phoneDb },
  },
];
