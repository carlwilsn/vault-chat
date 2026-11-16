// The agent's Act tool: do things in Carl's REAL laptop app window (click, type, press, scroll, wait for) when no plugin
// offer (PluginAct) or Layout covers it: the fallback of "the agent reaches every plugin; what is not yet a plugin, it
// reaches by driving the real screen". It rides Show's channel like Screen and Drive: a {type:"act", id, to:"laptop",
// steps, force, idleMs, timeoutMs} signal; the laptop's main window (src/actOnLaptop.ts) refuses while Carl is using
// the app, runs the steps as synthetic DOM events in its own window (nothing outside the app window can be touched),
// stops the moment he starts, and acks with each step's outcome and a picture of the window after. Every run and every
// step is a record in <state>/logs/act.jsonl (what the agent did to his app, when, from which chat).
import { join } from "node:path";
import { RotatingLog } from "./boxLogs";
import { feedLive } from "./show";
import { askLaptop } from "./driveTool";
import { checkSteps, MAX_SHOTS, MAX_STEPS, stepAction, type Step } from "../src/driveSteps";
import { checkScreenImage, type ScreenImage } from "./screenTool";

export const ACT_DESCRIPTION =
  "Do things in Carl's REAL laptop app window (the Windows desktop app he is looking at): click, type, press keys, scroll, wait for something, and get back each step's outcome, the app's errors, its visible text and a picture of the window after. " +
  "Prefer the app's own offers when they exist: PluginAct for a plugin's actions (PluginRead lists them), Layout to arrange panes and panels, Show to open a file, Settings for settings; use Act only for what none of those covers. For checking a change without touching his window, use Drive (a hidden copy). " +
  "steps, in order, one action each; a target is a CSS selector \"css\", {\"text\": \"Save\"} (visible text, aria-label or title) or {\"role\": \"button\", \"name\"?: \"Save\"} (ARIA role and accessible name): {\"click\": target}, {\"hover\": target}, {\"type\": \"hello\", \"into\"?: target} (into the focused field otherwise), {\"press\": \"Control+K\"} (Enter, Escape, Tab, Backspace, Arrow keys, F1-F12, letters, with Control/Shift/Alt), {\"wait\": ms}, {\"waitFor\": target, \"timeout\"?: ms} (fails if it never appears), {\"scroll\": px, \"in\"?: target}, {\"shot\": \"name\"} (at most 4). The first failing step stops the run. " +
  "The steps are events inside the app's own window only: they can't reach other programs, the desktop or the OS. Real effects: a click on Send sends. " +
  "It refuses while Carl is using the app (a key, click, scroll or mouse movement in it within idleSeconds, default 30) and stops at once if he starts; pass force only when he asked for it now (it still stops when he types, clicks or scrolls). " +
  "Offline (app not open), no answer (an app from before Act: check LaptopBuild) and refusals are said as such; claim only what the outcomes, text and picture show.";

export const ACT_SCHEMA = {
  type: "object",
  properties: {
    steps: { type: "array", items: { type: "object" }, description: `What to do in his app, in order (at most ${MAX_STEPS}, ${MAX_SHOTS} shots; see the description).` },
    force: { type: "boolean", description: "Run even though Carl used the app in the last idleSeconds (only when he asked for it now)." },
    idleSeconds: { type: "number", description: "How long he must have been idle in the app (default 30)." },
    timeoutSec: { type: "number", description: "Time limit for the steps (default 60, at most 180)." },
  },
  required: ["steps"],
  additionalProperties: false,
} as const;

export type ActDeps = { vault: string; emit: (ev: Record<string, unknown>) => void; stateDir?: string; conv?: string; ackMs?: number; now?: () => number };
export type ActToolResult = { ok: boolean; text: string; images: ScreenImage[] };

type StepRow = { i: number; action: string; ok: boolean; ms: number; note?: string; error?: string };
type AckData = {
  refused?: boolean;
  aborted?: string;
  idleSec?: number | null;
  steps?: { ok: boolean; aborted?: string; steps: StepRow[]; errors: string[]; text: string; shots: { name: string; width: number; height: number }[]; ms: number };
  final?: { width: number; height: number } | { error: string };
};

/** The act log (one record per run and per step). */
export const actLog = (stateDir: string) => new RotatingLog(join(stateDir, "logs", "act.jsonl"), { maxBytes: 256 * 1024, keep: 2 });

const targetOf = (s: Step): unknown => {
  const o = s as Record<string, unknown>;
  const a = stepAction(s);
  return a === "type" ? { text: String(o.type).slice(0, 200), ...(o.into !== undefined ? { into: o.into } : {}) } : a === "scroll" ? { px: o.scroll, ...(o.in !== undefined ? { in: o.in } : {}) } : o[a];
};

export async function actTool(d: ActDeps, args: Record<string, unknown>): Promise<ActToolResult> {
  const now = d.now ?? Date.now;
  const run = `act-${now().toString(36)}`;
  const log = d.stateDir ? actLog(d.stateDir) : null;
  const record = (r: Record<string, unknown>) => {
    log?.append({ at: new Date(now()).toISOString(), run, ...(d.conv ? { conv: d.conv } : {}), ...r });
  };
  const steps = checkSteps(args.steps);
  if (typeof steps === "string") return { ok: false, text: `Bad steps: ${steps}. Nothing was done.`, images: [] };
  if (!feedLive(d.vault, "laptop")) {
    record({ kind: "run", outcome: "offline", steps: steps.length });
    return { ok: false, text: "The laptop isn't online (the vault-chat app isn't open and connected on it), so nothing was done there. Say so; don't guess.", images: [] };
  }
  const idleSec = typeof args.idleSeconds === "number" && args.idleSeconds >= 0 ? Math.min(args.idleSeconds, 3600) : 30;
  const timeoutSec = typeof args.timeoutSec === "number" && args.timeoutSec > 0 ? Math.min(args.timeoutSec, 180) : 60;
  const force = args.force === true;
  const ms = d.ackMs ?? timeoutSec * 1000 + 30_000;
  const { ack } = await askLaptop(d, "act", { steps, force, idleMs: Math.round(idleSec * 1000), timeoutMs: Math.round(timeoutSec * 1000) }, ms);
  if (!ack) {
    record({ kind: "run", outcome: "no-answer", steps: steps.length, force });
    return { ok: false, text: `Sent the steps to the laptop, but it did not answer within ${Math.round(ms / 1000)} s (an app from before Act: check LaptopBuild; or it is busy). Nothing is known to have been done.`, images: [] };
  }
  const data = (ack.data ?? {}) as AckData;
  if (data.refused) {
    record({ kind: "run", outcome: "refused", steps: steps.length, force, idleSec: data.idleSec ?? null });
    return { ok: false, text: `Refused by the laptop: ${ack.error ?? "Carl is using it"}`, images: [] };
  }
  const r = data.steps;
  for (const s of r?.steps ?? []) record({ kind: "step", i: s.i, action: s.action, target: steps[s.i - 1] ? targetOf(steps[s.i - 1]!) : null, ok: s.ok, ms: s.ms, ...(s.note ? { note: s.note } : {}), ...(s.error ? { error: s.error } : {}) });
  record({ kind: "run", outcome: data.aborted ? "stopped" : ack.ok ? "done" : "failed", steps: steps.length, ran: r?.steps.length ?? 0, force, ...(data.aborted ? { aborted: data.aborted } : {}), ...(!ack.ok && ack.error ? { error: ack.error } : {}) });

  const images: ScreenImage[] = [];
  const bad: string[] = [];
  for (const im of ack.images ?? []) {
    const c = checkScreenImage(im);
    if (typeof c === "string") bad.push(`${im.name ?? "shot"}: ${c}`);
    else images.push({ data: c.data, mimeType: c.mimeType });
  }
  const lines: string[] = [];
  lines.push(ack.ok ? "Done in Carl's app window:" : `Not everything worked in Carl's app window${ack.error ? `: ${ack.error}` : "."}`);
  if (data.aborted) lines.push(`Stopped: ${data.aborted}.`);
  if (r) {
    for (const s of r.steps) lines.push(`- step ${s.i} ${s.action}: ${s.ok ? `ok (${s.ms} ms)${s.note ? ` ${s.note}` : ""}` : `FAILED: ${s.error}`}`);
    const skipped = steps.length - r.steps.length;
    if (skipped > 0) lines.push(`- ${skipped} step${skipped === 1 ? "" : "s"} not run.`);
    lines.push(r.errors.length ? `App errors while it ran (${r.errors.length}):\n${r.errors.map((e) => `  ${e}`).join("\n")}` : "App errors while it ran: none.");
    if (r.shots.length) lines.push(`Shots: ${r.shots.map((s) => `${s.name} (${s.width}x${s.height})`).join(", ")}.`);
  }
  if (data.final && "width" in data.final) lines.push(`The last picture is the window after the run (${data.final.width}x${data.final.height}).`);
  else if (data.final) lines.push(`No picture of the window after the run: ${data.final.error}.`);
  if (bad.length) lines.push(`Pictures refused: ${bad.join("; ")}.`);
  if (r) lines.push(`Visible text at the end:\n${r.text || "(none)"}`);
  return { ok: ack.ok, text: lines.join("\n"), images };
}
