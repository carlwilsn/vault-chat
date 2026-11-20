// The gate's checks that need no running app (src/gateResult.ts): the app's preset draft judged on its own before the UI
// runner tries it in the app (scripts/gate.ts). Shared by the box, the scripts and tests: imports only shared modules.
import { APP_PLUGINS } from "./appPlugins";
import { DAILY_PRESET, parseDraft, type Preset } from "./appPreset";

/** The visible line a place writes for a mount naming a part this app does not have (src/presetApp.ts skippedWhy). */
export const PRESET_SKIPPED_RE = /is not a part this app has: skipped in /;

/**
 * A preset draft's text judged: fail (every reason) when it is not a preset or a mount names an app plugin this app has
 * none of (the place would only say "skipped"); `seen`: what Carl would see change (places it leaves empty that the daily
 * preset fills, parts the daily preset never mounts: the UI runner shows whether the app has them). Pure.
 */
export function presetGate(text: string, current: Preset = DAILY_PRESET): { preset: Preset | null; what: string; fail: string[]; seen: string[] } {
  const d = parseDraft(text);
  if ("problems" in d) return { preset: null, what: "", fail: d.problems.map((p) => `not a preset: ${p}`), seen: [] };
  const ids = new Set(APP_PLUGINS.map((p) => p.id));
  const fail: string[] = [];
  const seen: string[] = [];
  for (const m of d.preset.mounts) if (!ids.has(m.plugin)) fail.push(`${m.place}: ${m.plugin} is no app plugin this app has (the place would only say "skipped")`);
  for (const id of Object.keys(d.preset.settings ?? {})) if (!ids.has(id)) fail.push(`settings: ${id} is no app plugin this app has`);
  const known = new Set(DAILY_PRESET.mounts.map((m) => `${m.plugin}#${m.part ?? ""}`));
  for (const m of d.preset.mounts) if (ids.has(m.plugin) && !known.has(`${m.plugin}#${m.part ?? ""}`)) seen.push(`${m.place}: ${m.plugin}${m.part ? `#${m.part}` : ""} is a part the daily preset never mounts`);
  const filled = new Set(d.preset.mounts.map((m) => m.place));
  const empty = [...new Set(current.mounts.map((m) => m.place))].filter((p) => !filled.has(p));
  if (empty.length) seen.push(`left empty (their fallbacks or nothing show): ${empty.join(", ")}`);
  const key = (p: Preset) => JSON.stringify([p.mounts.map((m) => [m.place, m.plugin, m.part ?? ""]), p.settings ?? {}]);
  if (key(d.preset) !== key(current)) seen.push(`the app's places change from preset "${current.name}" to "${d.preset.name}"`);
  return { preset: d.preset, what: d.what, fail, seen };
}
