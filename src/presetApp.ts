// The app's side of the preset (src/appPreset.ts): which preset is in effect in this window (the records', or the
// draft a gate run tries), the built-in modules the places can mount, and app/preset's offers (the agent reads the
// preset; it changes it by writing a draft and Plugins submit preset: the gate lands it).
import { DAILY_PRESET, PRESET_DRAFT_FILE, PRESET_PLACES, PRESET_PLUGIN_ID, parseDraft, type Preset, type PresetInEffect, type PresetMount } from "./appPreset";
import { recordPresetNow, useSupervisorVersion } from "./pluginSupervisorApp";
import { PRESET_NAME, triedVersion, useTried } from "./changeReady";
import { liveCopiesNow, useAllLiveCopies } from "./appPluginLiveHost";
import { versionOf } from "./pluginDrafts";
import { APP_PLUGIN_LIVE_DIR } from "./appPluginLive";
import { declareOffers, type Offers } from "./pluginOffers";

// ---------------------------------------------------------------- the built-in modules a place can mount

/** The built-in modules by plugin id and part ("app/chat#frame"), each as a thunk (the files that register them may be
 *  mid-import when they do: an import cycle). On a global, so a second copy of this module (a live copy) shares it. */
function modules(): Map<string, () => unknown> {
  const g = globalThis as { __vcPlaceModules?: Map<string, () => unknown> };
  return (g.__vcPlaceModules ??= new Map());
}
export const moduleKey = (plugin: string, part?: string): string => `${plugin}#${part ?? ""}`;

/** Register a plugin's built-in module (or one part's export) so any place the preset names it in can mount it. */
export function placeModule(plugin: { id: string }, module: () => unknown, part?: string): void {
  modules().set(moduleKey(plugin.id, part), module);
}

/** The built-in module of a mount, or undefined when this app has no such part (the place skips it, saying so). */
export function placeModuleOf(m: PresetMount): unknown {
  return modules().get(moduleKey(m.plugin, m.part))?.();
}

/** Why a mount is skipped, or null when this app has its part. */
export function skippedWhy(m: PresetMount, preset: Preset): string | null {
  return placeModuleOf(m) === undefined ? `${m.plugin}${m.part ? `#${m.part}` : ""} is not a part this app has: skipped in ${m.place} (preset "${preset.name}")` : null;
}

// ---------------------------------------------------------------- the preset in effect in this window

export type PresetHere = PresetInEffect & { tried: boolean };

let last: { base: PresetInEffect; draft: string | undefined; tried: string | null; out: PresetHere } | null = null;

/** The records' preset, or the draft a gate run tries on top of it. One object per input (a stable answer for React). */
function presetFrom(base: PresetInEffect, draft: string | undefined, tried: string | null): PresetHere {
  if (last && last.base === base && last.draft === draft && last.tried === tried) return last.out;
  let out: PresetHere = { ...base, tried: false };
  if (draft !== undefined && tried && tried === versionOf(draft)) {
    const d = parseDraft(draft);
    // A draft that is not a preset is not shown (the gate fails it).
    if ("preset" in d) out = { preset: d.preset, version: tried, builtIn: false, by: "draft", seq: base.seq, tried: true };
  }
  last = { base, draft, tried, out };
  return out;
}

/** The preset in effect in this window now. */
export function presetNow(): PresetHere {
  return presetFrom(recordPresetNow(), liveCopiesNow()[PRESET_DRAFT_FILE], triedVersion(PRESET_PLUGIN_ID));
}

/** The preset in effect in this window, followed (the records, the draft file, what a gate run tries). */
export function usePreset(): PresetHere {
  useSupervisorVersion();
  const tried = useTried(PRESET_PLUGIN_ID);
  const draft = useAllLiveCopies()[PRESET_DRAFT_FILE];
  return presetFrom(recordPresetNow(), draft, tried);
}

// ---------------------------------------------------------------- app/preset's offers

const DRAFT_PATH = `${APP_PLUGIN_LIVE_DIR}/${PRESET_DRAFT_FILE}`;

export function presetOffers(): Offers {
  const shown = () => {
    const p = presetNow();
    const skipped = p.preset.mounts.map((m) => skippedWhy(m, p.preset)).filter(Boolean);
    return { name: p.preset.name, version: p.version, builtIn: p.builtIn, by: p.by, tried: p.tried, mounts: p.preset.mounts, settings: p.preset.settings ?? {}, skipped };
  };
  return {
    state: {
      preset: {
        description: `The app's preset in effect in Carl's laptop window: which plugins (and parts) mount in which place, in order, plus their settings; builtIn: the built-in daily preset (src/presets/daily.json); skipped: mounts naming a part this app has none of. To change it, write a whole preset ({name, what?, mounts, settings?}) to ${DRAFT_PATH}, then Plugins submit preset: the gate checks it and, passed, it applies live (Plugins back undoes it).`,
        read: shown,
      },
      places: { description: "The places a plugin can mount in, and what each is (a place left empty shows its built-in fallback, or nothing).", read: () => PRESET_PLACES },
      daily: { description: "The built-in daily preset (today's app; what no record falls back to).", read: () => DAILY_PRESET },
      draft: {
        description: `The preset's draft (${DRAFT_PATH}) as the app reads it: version, what, and why it is not a preset if it is not; null when there is none.`,
        read: () => {
          const text = liveCopiesNow()[PRESET_DRAFT_FILE];
          if (text === undefined) return null;
          const d = parseDraft(text);
          const version = versionOf(text);
          return { version, ...("preset" in d ? { name: d.preset.name, what: d.what || null } : { problems: d.problems }) };
        },
      },
    },
  };
}

declareOffers(PRESET_PLUGIN_ID, PRESET_NAME, presetOffers());
