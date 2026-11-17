// The agent's Timing tool: the five speeds the perf harness guards (docs/perf-baseline.md: composer and Ctrl+K
// keystroke-to-paint, Ctrl+Shift+F, chat-panel opening, launch-to-interactive), measured on Carl's real laptop app.
//   live      a {type:"timing"} signal: the laptop's main window (src/driveOnLaptop.ts, the same rules as Drive: not
//             while Carl uses the app, stops when he starts) runs src/driveTiming.ts in the hidden Drive copy of the app
//             and acks with raw samples (synthetic in-page key events, two animation frames: the harness's quantity);
//   launch    the last launch's launch-to-interactive, from the app's build report (server/hostBuild.ts);
//   recorded  Carl's own keystrokes and transitions on the laptop's current build, from the probe's records
//             (server/laptopPerf.ts), summarized the way scripts/perf-baseline.mjs does;
//   baseline  optional: a perf-baseline.mjs JSON to compare with, by the same metric/method keys and margin rule.
import { readFileSync } from "node:fs";
// @ts-expect-error plain .mjs script, no declarations
import { summarize, table, compare, compareTable, flatten, dedupe, REQUIRED } from "../scripts/perf-baseline.mjs";
import { controlDown } from "./deviceLink";
import { readLaptopPerf } from "./laptopPerf";
import { lastHostBuild } from "./hostBuild";
import { askLaptop, laptopRunArgs } from "./driveTool";

type Sample = { key: string; at: string; session: string; rev: string; ms: number };
type Stats = Record<string, { count: number; medianMs: number; p95Ms: number; minMs: number; maxMs: number }>;
type TimingAck = { where?: string; note?: string; refused?: boolean; aborted?: string; timing?: { source: string; visibility: string; frameMs: number | null; throttled: boolean; windowReadyMs?: number; metrics: { metric: string; method: string; samples: number[]; error?: string }[] } };

export const TIMING_DESCRIPTION =
  "Measure the laptop app's speed on Carl's real laptop, in the app itself, as numbers comparable to the perf harness baseline (docs/perf-baseline.md: metric/method, median and p95 ms): composer and Ctrl+K keystroke-to-paint, Ctrl+Shift+F (fullscreen chat), chat-panel opening, and the last launch-to-interactive. " +
  "Live numbers come from a hidden, read-only second copy of the app (never his window) with synthetic key events and two animation frames (the harness's double-raf-estimate; render cost, not OS input delay); it is refused while he is using the laptop (idleMinutes, default 5) and stops if he starts; force only if he asked now. " +
  "Also shows his own recorded keystrokes on the laptop's current build (the app's perf probe) and the launch time the app reported at its last start. baseline: a perf-baseline.mjs record JSON on the box, with marginPct or marginMs, flags anything worse. live: false skips the live run.";

export const TIMING_SCHEMA = {
  type: "object",
  properties: {
    keys: { type: "number", description: "Keys typed per field (default 30)." },
    toggles: { type: "number", description: "Ctrl+Shift+F and chat-panel repeats (default 3)." },
    metrics: { type: "array", items: { type: "string", enum: ["composer-key", "ctrl-k-key", "fullscreen-transition", "chat-panel-open"] }, description: "Only these (default all)." },
    live: { type: "boolean", description: "Run the live measurement on the laptop (default true)." },
    baseline: { type: "string", description: "Path on the box to a perf-baseline.mjs record JSON to compare with." },
    marginPct: { type: "number", description: "With baseline: flag a median/p95 more than this % above it." },
    marginMs: { type: "number", description: "With baseline: flag a median/p95 more than this many ms above it." },
    force: { type: "boolean", description: "Run even though Carl used the laptop recently (only when he asked now)." },
    idleMinutes: { type: "number", description: "How long he must have been idle (default 5)." },
  },
  additionalProperties: false,
} as const;

export type TimingDeps = { vault: string; stateDir: string; emit: (ev: Record<string, unknown>) => void; ackMs?: number };

const short = (rev: string) => (/^[0-9a-f]{40}$/.test(rev) ? rev.slice(0, 12) : rev);

export async function timingTool(d: TimingDeps, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
  const lines: string[] = [];
  const now: Sample[] = [];
  const at = new Date().toISOString();
  let liveOk = false;
  const build = lastHostBuild(d.stateDir, "laptop");

  // Live, in the app.
  if (args.live === false) lines.push("Live: skipped (live: false).");
  else if (controlDown("laptop")) lines.push(`Live: ${controlDown("laptop")} So nothing was measured there now.`);
  else {
    const run = laptopRunArgs(args, 120, 240);
    const ms = d.ackMs ?? run.timeoutMs + 75_000;
    const fields = { ...run, ...(typeof args.keys === "number" ? { keys: args.keys } : {}), ...(typeof args.toggles === "number" ? { toggles: args.toggles } : {}), ...(Array.isArray(args.metrics) ? { metrics: args.metrics } : {}) };
    const { ack } = await askLaptop(d, "timing", fields, ms);
    const data = (ack?.data ?? {}) as TimingAck;
    if (!ack) lines.push(`Live: asked the laptop, but it did not answer within ${Math.round(ms / 1000)} s (an app from before Timing: check LaptopBuild; or busy). Nothing was measured.`);
    else if (data.refused) lines.push(`Live: refused by the laptop: ${ack.error ?? "Carl is using it"}`);
    else if (!data.timing) lines.push(`Live: no numbers${ack.error ? `: ${ack.error}` : ""}.`);
    else {
      const t = data.timing;
      liveOk = ack.ok;
      for (const m of t.metrics) for (const v of m.samples) now.push({ key: `${m.metric}/${m.method}`, at, session: "drive", rev: build ? short(build.revision) : "", ms: v });
      lines.push(`Live (${data.where ?? "the Drive copy"}; ${t.source}, frames every ${t.frameMs ?? "?"} ms, ${t.visibility}${t.throttled ? ": THROTTLED, the OS is not painting this window at full rate, so these numbers overstate; prefer the recorded ones below" : ""}${data.aborted ? `; stopped: ${data.aborted}` : ""}):`);
      lines.push(table(summarize(now) as Stats));
      for (const m of t.metrics) if (m.error) lines.push(`- ${m.metric}: not measured: ${m.error}`);
      if (t.windowReadyMs !== undefined) lines.push(`(The Drive copy took ${t.windowReadyMs} ms from navigation to ready: a renderer in the running app, not an app launch.)`);
    }
  }

  // The last launch, as the app reported it.
  if (build?.launchMs !== undefined) {
    now.push({ key: `launch-interactive/${build.launchMethod ?? "unknown"}`, at: build.at, session: build.session ?? "", rev: short(build.revision), ms: build.launchMs });
    lines.push(`Launch to interactive, last launch (${build.at}, v${build.version}): ${build.launchMs} ms (${build.launchMethod ?? "method unknown"}).`);
  } else lines.push("Launch to interactive: no launch report from the laptop yet (an app from before build reports, or not restarted since).");

  // Carl's own recorded samples on the current build.
  let recorded: Sample[] = [];
  try {
    recorded = dedupe(flatten(readLaptopPerf(d.stateDir), { surface: "tauri-production", revision: build && /^[0-9a-f]{40}$/.test(build.revision) ? build.revision : "" })) as Sample[];
  } catch {
    recorded = [];
  }
  if (recorded.length) lines.push(`Recorded from Carl's own use${build ? ` on build ${short(build.revision)}` : ""} (the app's perf probe, the box keeps minutes of it; ${recorded.length} samples):`, table(summarize(recorded) as Stats));
  else lines.push(`Recorded from Carl's own use: none on ${build ? `build ${short(build.revision)}` : "the laptop"} in the box's records (they keep only minutes).`);

  // Against a baseline.
  if (typeof args.baseline === "string" && args.baseline.trim()) {
    const marginPct = typeof args.marginPct === "number" ? args.marginPct : null;
    const marginMs = typeof args.marginMs === "number" ? args.marginMs : null;
    try {
      if (marginPct === null && marginMs === null) throw new Error("give marginPct or marginMs (there is no default margin)");
      const base = JSON.parse(readFileSync(args.baseline.trim(), "utf8")) as { schema?: number; samples?: Sample[] };
      if (base.schema !== 1 || !Array.isArray(base.samples)) throw new Error("not a perf-baseline.mjs record (schema 1)");
      const rows = compare(summarize(base.samples), summarize(now), { marginPct, marginMs }) as { key: string; flags: string[] }[];
      const worse = rows.filter((r) => r.flags.length);
      lines.push(`Against ${args.baseline} (live + last launch vs baseline; margin ${[marginPct !== null && `${marginPct}%`, marginMs !== null && `${marginMs} ms`].filter(Boolean).join(" or ")}):`, compareTable(rows), worse.length ? `WORSE than the margin: ${worse.map((r) => r.key).join(", ")}` : "Nothing worse than the margin.");
    } catch (e) {
      lines.push(`Baseline: couldn't compare: ${(e as Error).message}`);
    }
  }
  const missing = (REQUIRED as string[]).filter((m) => !now.some((s) => s.key.startsWith(`${m}/`)) && !recorded.some((s) => s.key.startsWith(`${m}/`)));
  if (missing.length) lines.push(`No number at all for: ${missing.join(", ")}.`);
  return { ok: liveOk || now.length > 0 || recorded.length > 0, text: lines.join("\n") };
}
