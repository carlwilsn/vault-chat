// Long work in the background, as Claude Code's background tasks (Carl, 2026-10-26: "I both could not speak to
// the agent and didn't see it running"). Box mode, Main. Carl asks for a guided physics animation; the agent says
// one line, hands it to Delegate and its turn ENDS. A chip above the composer shows the task moving — its latest
// step from the worker's own pi events, steps done, the time, a pulse. Carl asks for something else meanwhile and
// is answered at once. He opens the chip: the task's row with Stop and Steer. The task ends: its row in the thread
// ("Background task finished · …") and the agent tells him the result in its own words; the chip folds under the
// reply that started it ("1 background task done").
import type { BoxStep } from "../runtime/backend/host";
import type { Scenario, Step } from "./types";
import * as P3 from "./phase3";

const BOX = { box: "https://thinkbox.tail0a1b2.ts.net", vault: "summer-demo" };
const COMPOSER = "textarea[placeholder]";
const ASK = "Make me a 6–8 minute guided physics animation as an HTML page — projectile motion, with narration cues.";
const MID = "oh um I just deleted the 469 project, could you bring it back?";
const TITLE = "guided physics animation";

type Box = Parameters<NonNullable<BoxStep["log"]>>[0];
const task = (patch: Record<string, unknown>, id = "w-physics") => (b: Box) => {
  const all = (b.picture("main")?.meta.subagents ?? []) as Record<string, unknown>[];
  b.emit("main", { type: "meta", patch: { subagents: all.map((x) => (x.threadId === id ? { ...x, ...patch, activityAt: Date.now() } : x)) } });
};
/** A dev server the agent started earlier (StartJob): it rightly runs for hours, shown in the same one line. */
const devServer = { threadId: "dev-1", kind: "job", title: "dev server", task: "npm run dev", state: "running", status: "running", background: true, activity: "ready on http://localhost:5173" };

const steps: BoxStep[] = [
  // 1. The agent: one line, Delegate, the turn ends; the worker runs.
  {
    log: (b) => {
      b.say("main", "On it — I'm building it in the background. Keep talking to me; I'll tell you when it's ready.");
      b.tool("main", "d1", "Delegate", { title: TITLE, task: "Build physics.html: a 6–8 minute guided projectile-motion animation with narration cues…", expect: "long" }, `Started in the background ("${TITLE}").`);
      b.emit("main", { type: "meta", patch: { subagents: [{ ...devServer, startedAt: Date.now() - 2 * 3600_000 }, { threadId: "w-physics", title: TITLE, task: "Build physics.html…", agent: "worker", model: "openai/gpt-6.1-sol", state: "running", status: "running", background: true, startedAt: Date.now(), toolCallId: "d1", activity: "starting", steps: 0 }] } });
      b.endTurn("main");
    },
  },
  // 2–3. Its own pi events move its row.
  { log: task({ activity: "reading notes/physics/projectile-motion.md", steps: 1 }) },
  { log: task({ activity: "writing physics.html", steps: 2 }) },
  // 4. Carl's other ask, answered at once (a turn of its own while the worker runs).
  {
    log: (b) => {
      b.say("main", "Brought it back: **469** is restored with its notes and its thread, as it was before you deleted it.");
      b.endTurn("main");
    },
  },
  { log: task({ activity: "editing physics.html", steps: 4 }) },
  { log: task({ activity: "running node check-physics.js", steps: 5 }) },
  // 7. Done: the worker's row ends, its report comes back as a new turn, and the agent tells him.
  {
    log: (b) => {
      task({ state: "completed", status: "completed", endedAt: Date.now(), activity: "running node check-physics.js", steps: 6 })(b);
      b.startTurn("main", "wake");
      b.userLine("main", "w-physics-report", `Delegated work finished: "${TITLE}"\n\n## Completed\nBuilt physics.html (7 min at 1×)…`, "delegate");
      b.say("main", "Your physics animation is ready: **physics.html** — a 7-minute guided walk through projectile motion, six scenes with narration cues, and I checked that every scene renders.");
      b.endTurn("main");
    },
  },
  // 8. The dev server is stopped: nothing runs, and the chip is gone.
  { log: task({ state: "stopped", status: "stopped", endedAt: Date.now(), activity: "stopped" }, "dev-1") },
];

const next: Step = { run: () => (window as any).__preview?.boxNext?.() };

export const backgroundScenarios: Scenario[] = [
  {
    id: "bg-tasks",
    title: "Long work runs in the background — talk to it meanwhile, watch it move",
    group: "Chat · while it works",
    clock: "2026-10-26T00:25:00",
    notes:
      "Box mode, Main. A dev server the agent started earlier runs. The agent hands a long job to Delegate and its turn ends at once. One compact line above the composer shows the running tasks (the newest one's latest step, its time, a pulse); a click opens the list (Stop, Steer), a second click, Esc or a click elsewhere folds it. Carl asks something else and is answered at once. When the job ends it leaves the screen: the agent's own message carries the result (a failed task would be one quiet line). The dev server stays in the one line; once it stops, the line is gone.",
    build: P3.build,
    host: () => ({
      sync: {
        box: BOX,
        boxChat: {
          convs: {
            main: { title: "Main", source: "main", meta: { kind: "main" }, messages: [{ role: "user", content: "morning" }, { role: "assistant", content: "Morning! What are we working on?" }] },
          },
          steps,
          live: true,
        },
      },
    }),
    surfaces: ["desktop"],
    open: [
      { chat: true },
      { conversation: "main" },
      { sleep: 600 },
      { type: ASK, into: COMPOSER },
      { key: "Enter", target: COMPOSER },
      { sleep: 1200 },
      next,
      { wait: "[data-el='tasks-chip']", timeout: 5000 },
      { sleep: 2200 },
      next,
      { sleep: 2200 },
      next,
      { sleep: 1200 },
      { type: MID, into: COMPOSER },
      { key: "Enter", target: COMPOSER },
      { sleep: 1200 },
      next,
      { sleep: 1800 },
      { click: "[data-el='tasks-chip']" },
      { sleep: 1500 },
      next,
      { sleep: 2200 },
      next,
      { sleep: 2500 },
      next,
      { sleep: 3000 },
      next,
      { sleep: 2000 },
    ],
  },
];
