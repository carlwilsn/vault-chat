// The daily app is one preset (reports/07 "The goal", corrected model point 2): which plugins mount where, plus their
// settings, is data, not core code. The core only knows its places (where a plugin can mount: the title bar, the left
// panel, the chat's composer …); the preset says which plugin (and which part of it) fills each place, in order.
//
// The built-in preset is src/presets/daily.json: today's app. It is overridden the way plugins are, by a record in the
// one log (a vault-level signal, folded by the supervisor with plugin.desired: src/pluginSupervisor.ts):
//   {type: "app.preset", preset: Preset | null, version, at, by?}
//       The newest valid record wins; preset null is the built-in one again. A record that is not a valid preset is
//       passed over (the one before it, or the built-in, stays).
//
// A change to the preset goes through Change ready (src/pluginDrafts.ts, src/changeReady.ts), as a plugin's draft does:
// the agent writes .vault-chat/app-plugins/preset.draft.json (a preset, plus an optional one-line `what`); Carl sees
// "Change ready", Try runs it on his windows only, Keep has the box write the app.preset record (and a plugin.change
// record for app/preset), Discard removes the draft, Switch back writes the preset the last Keep replaced. A draft that
// is not a valid preset discards itself when tried.
//
// Each place of the app (src/PluginMount.tsx PlaceMount) mounts what the preset puts there; a place the preset leaves
// empty shows its built-in fallback where it has one, or nothing. A plugin this app has no part for is skipped there
// with a visible line saying so. The agent reads the preset through app/preset's offers (src/presetApp.ts).
//
// Shared by the app, the box and the preview harness: no imports but the built-in preset.
import daily from "./presets/daily.json";

export const APP_PRESET = "app.preset";
/** The preset's id where plugins are named (Change ready, the offers, plugin.change records). */
export const PRESET_PLUGIN_ID = "app/preset";
/** The draft's file in the app plugins' folder (src/appPluginLive.ts APP_PLUGIN_LIVE_DIR). */
export const PRESET_DRAFT_FILE = "preset.draft.json";
/** The version of the built-in preset (src/pluginDrafts.ts BUILT_IN). */
const BUILT_IN = "built-in";

/** One plugin (one part of it) in one place. */
export type PresetMount = { place: string; plugin: string; part?: string };
export type Preset = {
  name: string;
  /** In order: a place with several plugins mounts them in this order. */
  mounts: PresetMount[];
  /** Each plugin's settings (its id → a JSON object), handed to it as api.settings. */
  settings?: Record<string, Record<string, unknown>>;
};
export type PresetSignal = { type: typeof APP_PRESET; preset: Preset | null; version: string; at: number; by?: string };

/** The places of the app a plugin can mount in, and what each is. */
export const PRESET_PLACES: Readonly<Record<string, string>> = {
  titlebar: "the title bar across the top of the window (fallback: a minimal bar with the window controls)",
  "titlebar.vaults": "the title bar's vault picker (fallback: a plain picker)",
  "left.tree": "the left panel (fallback: a plain file tree)",
  overlay: "over either layout, drawing nothing of its own place (panels that float, offers-only plugins)",
  "chats.overlay": "the chat list overlay (fallback: a plain list)",
  "chats.sidebar": "fullscreen chat's sidebar (fallback: a plain list)",
  "chat.header": "the docked chat pane's header (fallback: a plain header with Memory)",
  "chat.bar": "fullscreen chat's top bar title (fallback: a plain title)",
  "chat.frame": "fullscreen chat's and the popout's frame (fallback: a plain frame)",
  "chat.rows": "beside the transcript, drawing nothing (the rows' offers)",
  "chat.transcript": "the chat's transcript (fallback: a plain transcript)",
  "chat.composer": "the chat's composer (fallback: a plain composer)",
  settings: "the Settings pane (fallback: a plain pane)",
  voice: "the voice text box and controls (fallback: a plain mic and Mute)",
  viewer: "beside the viewer, drawing nothing (the viewer's offers)",
  "viewer.pane": "each viewer pane (fallback: the plain pane), handed {paneId}",
  "ask.prompt": "each Ctrl+K / Ctrl+L box (fallback: a plain box), handed the box's request",
};

const NAME_RE = /^[a-z0-9][a-z0-9 _.-]{0,39}$/i;
const PLUGIN_RE = /^app\/[a-z][a-z0-9-]{0,40}$/;
const PART_RE = /^[A-Za-z_$][\w$]{0,40}$/;
const WHO_RE = /^[a-z][a-z0-9_.-]{0,39}$/;
const MAX_MOUNTS = 100;
const MAX_SETTINGS_CHARS = 20_000;

const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

/** Why `p` is not a preset (every reason), or [] when it is one. A well-formed plugin id this app has no part for is
 *  not a problem here: the place skips it, saying so. */
export function presetProblems(p: unknown): string[] {
  if (!isObject(p)) return ["a preset is {name, mounts: [{place, plugin, part?}], settings?}"];
  const out: string[] = [];
  if (typeof p.name !== "string" || !NAME_RE.test(p.name)) out.push("name: letters, digits, space _ . - (at most 40)");
  if (!Array.isArray(p.mounts)) out.push("mounts: a list of {place, plugin, part?}");
  else {
    if (p.mounts.length > MAX_MOUNTS) out.push(`mounts: at most ${MAX_MOUNTS}`);
    const seen = new Set<string>();
    p.mounts.forEach((m, i) => {
      if (!isObject(m)) return void out.push(`mounts[${i}]: {place, plugin, part?}`);
      if (typeof m.place !== "string" || !Object.prototype.hasOwnProperty.call(PRESET_PLACES, m.place)) out.push(`mounts[${i}].place: one of ${Object.keys(PRESET_PLACES).join(", ")}`);
      if (typeof m.plugin !== "string" || !PLUGIN_RE.test(m.plugin)) out.push(`mounts[${i}].plugin: an app plugin's id (app/<name>)`);
      if (m.part !== undefined && (typeof m.part !== "string" || !PART_RE.test(m.part))) out.push(`mounts[${i}].part: the name of the plugin's export`);
      const k = `${m.place}\u0000${m.plugin}\u0000${m.part ?? ""}`;
      if (seen.has(k)) out.push(`mounts[${i}]: ${m.plugin}${m.part ? `#${m.part}` : ""} is in ${m.place} twice`);
      seen.add(k);
    });
  }
  if (p.settings !== undefined) {
    if (!isObject(p.settings)) out.push("settings: {<plugin id>: {…}}");
    else {
      for (const [id, s] of Object.entries(p.settings)) if (!PLUGIN_RE.test(id) || !isObject(s)) out.push(`settings.${id}: an app plugin's id → an object`);
      let size = 0;
      try {
        size = JSON.stringify(p.settings).length;
      } catch {
        out.push("settings: plain JSON");
      }
      if (size > MAX_SETTINGS_CHARS) out.push(`settings: at most ${MAX_SETTINGS_CHARS} characters of JSON`);
    }
  }
  return out;
}

/** The preset as kept: only its known fields (a valid preset in, checked by presetProblems). */
function clean(p: Preset): Preset {
  const mounts = p.mounts.map((m) => ({ place: m.place, plugin: m.plugin, ...(m.part ? { part: m.part } : {}) }));
  return { name: p.name, mounts, ...(p.settings && Object.keys(p.settings).length ? { settings: JSON.parse(JSON.stringify(p.settings)) } : {}) };
}

/** The built-in preset: the daily app (also what no record, or a reset, falls back to). */
export const DAILY_PRESET: Preset = Object.freeze(clean(daily as Preset));

/** The preset in effect, its version (the draft's it was kept from; "built-in"), who set it and when (seq 0: nobody). */
export type PresetInEffect = { preset: Preset; version: string; builtIn: boolean; by: string | null; seq: number };

export const DAILY_IN_EFFECT: PresetInEffect = Object.freeze({ preset: DAILY_PRESET, version: BUILT_IN, builtIn: true, by: null, seq: 0 });

/** A preset record (the box writes it on Keep / Switch back). */
export function presetSignal(preset: Preset | null, version: string, by: string, now: number): PresetSignal {
  return { type: APP_PRESET, preset: preset ? clean(preset) : null, version: preset ? version : BUILT_IN, at: now, ...(WHO_RE.test(by) ? { by } : {}) };
}

/** A log record's preset in effect, or undefined when it is not a valid app.preset record (passed over). */
export function presetOf(rec: { seq: number; type?: unknown; signal?: unknown }): PresetInEffect | undefined {
  const s = rec.type === "signal" ? (rec.signal as Record<string, unknown> | undefined) : undefined;
  if (!s || s.type !== APP_PRESET || !Number.isFinite(rec.seq)) return undefined;
  const by = typeof s.by === "string" ? s.by : null;
  if (s.preset === null) return { ...DAILY_IN_EFFECT, by, seq: rec.seq };
  if (presetProblems(s.preset).length) return undefined;
  return { preset: clean(s.preset as Preset), version: typeof s.version === "string" ? s.version : BUILT_IN, builtIn: false, by, seq: rec.seq };
}

/** A draft file's text: the preset it holds and what it says it changes, or every reason it is not one. */
export function parseDraft(text: string): { preset: Preset; what: string } | { problems: string[] } {
  let o: unknown;
  try {
    o = JSON.parse(String(text ?? ""));
  } catch (e) {
    return { problems: [`not JSON: ${(e as Error).message}`] };
  }
  const problems = presetProblems(o);
  if (problems.length) return { problems };
  const what = isObject(o) && typeof o.what === "string" ? o.what.trim().slice(0, 160) : "";
  return { preset: clean(o as Preset), what };
}

/** What a place mounts under a preset, in order. One list object per place and preset (a stable answer). */
const placeCache = new WeakMap<Preset, Map<string, readonly PresetMount[]>>();
const NONE: readonly PresetMount[] = Object.freeze([]);
export function presetPlace(p: Preset, place: string): readonly PresetMount[] {
  let byPlace = placeCache.get(p);
  if (!byPlace) {
    byPlace = new Map();
    for (const m of p.mounts) byPlace.set(m.place, [...(byPlace.get(m.place) ?? []), m]);
    placeCache.set(p, byPlace);
  }
  return byPlace.get(place) ?? NONE;
}
