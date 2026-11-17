// The agent's Drive tool: scripted steps inside Carl's real laptop app, like RecordUI on a page, returning each step's
// outcome, the page's errors, its visible text and screenshots. It rides Show's channel like Layout and Screen: a
// {type:"drive", id, to:"laptop", steps, force, idleMs, timeoutMs} signal; the laptop's main window (src/driveOnLaptop.ts)
// refuses while Carl is using the app, runs the steps in a hidden, read-only second copy of the app (src/driveHost.ts,
// src/driveRunner.ts, src/driveGuard.ts) so his window, focus and layout are never touched, aborts the moment he starts
// typing or moving the mouse, and acks over POST /api/v1/show/<id>/ack. The result is only that ack, or an honest
// "offline" / "didn't answer" / "refused".
import { randomBytes } from "node:crypto";
import { waitAck, type Ack } from "./show";
import { controlDown, noteAnswer, unansweredNote } from "./deviceLink";
import { checkSteps, MAX_SHOTS, MAX_STEPS } from "../src/driveSteps";
import { checkScreenImage, type ScreenImage } from "./screenTool";

export const DRIVE_DESCRIPTION =
  "Run scripted steps inside Carl's real laptop app (the Windows desktop app) and get back each step's outcome, the app's errors, its visible text and screenshots, like RecordUI but on the real app: use it to verify a release or a UI change on the laptop itself (to act in his own window, use Act). " +
  "The steps run in a hidden, read-only second copy of the app (never his window: his layout and focus are untouched; it can't write files, send messages or change settings, so a step that would send just fails there). " +
  "steps, in order, one action each: {\"click\": \"css\"} or {\"click\": {\"text\": \"Save\"}} or {\"click\": {\"role\": \"button\", \"name\": \"Save\"}}, {\"hover\": ...the same}, {\"type\": \"hello\", \"into\"?: target} (into the focused field otherwise), {\"press\": \"Control+K\"} (Enter, Escape, Tab, Backspace, Arrow keys, F1-F12, letters, with Control/Shift/Alt), {\"wait\": ms}, {\"waitFor\": target, \"timeout\"?: ms} (fails if it never appears), {\"scroll\": px, \"in\"?: target}, {\"shot\": \"name\"} (at most 4). The first failing step stops the run. " +
  "It refuses while Carl is using the laptop app (a key, click or mouse movement in it within idleMinutes, default 5) and stops at once if he starts; pass force only when he asked for it now (it still stops when he starts typing). " +
  "Offline (app not open), no answer (an app from before this tool: check LaptopBuild) and refusals are said as such; claim only what the steps, text and screenshots show.";

export const DRIVE_SCHEMA = {
  type: "object",
  properties: {
    steps: { type: "array", items: { type: "object" }, description: `What to do in the app, in order (at most ${MAX_STEPS}, ${MAX_SHOTS} shots; see the description).` },
    force: { type: "boolean", description: "Run even though Carl used the laptop recently (only when he asked for it now)." },
    idleMinutes: { type: "number", description: "How long he must have been idle (default 5)." },
    timeoutSec: { type: "number", description: "Time limit for the steps (default 60, at most 180)." },
  },
  required: ["steps"],
  additionalProperties: false,
} as const;

export type DriveDeps = { vault: string; emit: (ev: Record<string, unknown>) => void; ackMs?: number };
export type DriveToolResult = { ok: boolean; text: string; images: ScreenImage[] };

type StepRow = { i: number; action: string; ok: boolean; ms: number; note?: string; error?: string };
type AckData = { where?: string; note?: string; refused?: boolean; aborted?: string; idleSec?: number | null; steps?: { ok: boolean; aborted?: string; steps: StepRow[]; errors: string[]; text: string; shots: { name: string; width: number; height: number }[]; ms: number } };

/** Common to Drive and Timing: the knobs the laptop needs. */
export function laptopRunArgs(args: Record<string, unknown>, defTimeout = 60, maxTimeout = 180): { force: boolean; idleMs: number; timeoutMs: number } {
  const idleMin = typeof args.idleMinutes === "number" && args.idleMinutes >= 0 ? Math.min(args.idleMinutes, 60) : 5;
  const sec = typeof args.timeoutSec === "number" && args.timeoutSec > 0 ? Math.min(args.timeoutSec, maxTimeout) : defTimeout;
  return { force: args.force === true, idleMs: Math.round(idleMin * 60_000), timeoutMs: Math.round(sec * 1000) };
}

/** Ask the laptop over Show's channel; null when it didn't answer in time. */
export async function askLaptop(d: { emit: DriveDeps["emit"] }, type: string, fields: Record<string, unknown>, ms: number): Promise<{ id: string; ack: Ack | null }> {
  const id = `${type}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  const got = waitAck(id, ms);
  d.emit({ type, id, to: "laptop", ...fields });
  const ack = await got;
  noteAnswer("laptop", type, !!ack);
  return { id, ack };
}

export async function driveTool(d: DriveDeps, args: Record<string, unknown>): Promise<DriveToolResult> {
  const steps = checkSteps(args.steps);
  if (typeof steps === "string") return { ok: false, text: `Bad steps: ${steps}. Nothing was run.`, images: [] };
  const down = controlDown("laptop");
  if (down) return { ok: false, text: `${down} So nothing was run there. Say so; don't guess.`, images: [] };
  const run = laptopRunArgs(args);
  // Opening the Drive copy of the app takes a while the first time (it loads the whole app).
  const ms = d.ackMs ?? run.timeoutMs + 75_000;
  const { ack } = await askLaptop(d, "drive", { steps, ...run }, ms);
  if (!ack) return { ok: false, text: `Sent the steps to the laptop, but it did not answer within ${Math.round(ms / 1000)} s (an app from before Drive: check LaptopBuild; or it is busy). Nothing is known to have run.${unansweredNote("laptop")}`, images: [] };
  const data = (ack.data ?? {}) as AckData;
  if (data.refused) return { ok: false, text: `Refused by the laptop: ${ack.error ?? "Carl is using it"}`, images: [] };
  const images: ScreenImage[] = [];
  const bad: string[] = [];
  for (const im of ack.images ?? []) {
    const c = checkScreenImage(im);
    if (typeof c === "string") bad.push(`${im.name ?? "shot"}: ${c}`);
    else images.push({ data: c.data, mimeType: c.mimeType });
  }
  const lines: string[] = [];
  const r = data.steps;
  lines.push(ack.ok ? "Done on the laptop:" : `Not everything worked on the laptop${ack.error ? `: ${ack.error}` : "."}`);
  if (data.where) lines.push(`Ran in ${data.where}${data.note ? ` (${data.note})` : ""}; Carl's own window was not touched.`);
  if (data.aborted) lines.push(`Stopped: ${data.aborted}.`);
  if (r) {
    for (const s of r.steps) lines.push(`- step ${s.i} ${s.action}: ${s.ok ? `ok (${s.ms} ms)${s.note ? ` ${s.note}` : ""}` : `FAILED: ${s.error}`}`);
    const skipped = steps.length - r.steps.length;
    if (skipped > 0) lines.push(`- ${skipped} step${skipped === 1 ? "" : "s"} not run.`);
    lines.push(r.errors.length ? `App errors while it ran (${r.errors.length}):\n${r.errors.map((e) => `  ${e}`).join("\n")}` : "App errors while it ran: none.");
    if (r.shots.length) lines.push(`Screenshots: ${r.shots.map((s) => `${s.name} (${s.width}x${s.height})`).join(", ")}${bad.length ? `; refused: ${bad.join("; ")}` : ""}.`);
    lines.push(`Visible text at the end:\n${r.text || "(none)"}`);
  }
  return { ok: ack.ok, text: lines.join("\n"), images };
}
