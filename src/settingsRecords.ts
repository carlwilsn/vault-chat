// Carl's app settings as records in the one log (reports/08 "settings as records"): every setting the app's
// Settings, the composer's picker and the phone's drawer change is a `setting` signal in the box's main vault log,
// and the settings are the fold of those records, newest last. The laptop, the phone and the agent (its Settings
// tool, server/settingsTool.ts) all read and write the same records, so a change made anywhere shows everywhere.
//
//   {type: "setting", key, value, by}   one setting set (value null: back to its default)
//
// A change the agent makes on its own initiative (not Carl's direct "set X") is a draft first (reports/07 corrected
// model point 4, "settings/config count as behavior"), through the same gate as a plugin's draft (server/gate.ts):
//
//   {type: "setting.draft", values: {key: value …}, version, what, by, at}
//       settings the agent proposes; the newest one waits for the gate (a draft written while another waits carries both).
//   {type: "setting.change", change: "keep" | "discard" | "switch", version, from?, values?, was?, by, reason?, at}
//       the word on it (the gate's keep or discard, a switch back), shaped like a plugin.change record (src/pluginDrafts.ts). A keep also writes a `setting`
//       record per key (the settings themselves never live anywhere else) and names what it replaced (`was`, null:
//       the default), so Switch back writes those back; another switch writes the kept ones again.
//
// The gate draws a draft's window settings (SettingDef.applies "window": the theme, the sidebar) in the laptop app's
// hidden Drive copy before it lands; a setting the box applies (the model, the voice …) is checked by its values. Both
// kinds ride every feed with the settings.
//
// Secrets (API keys, tokens) are never settings: they stay in the key store. Machine-local things (the laptop's
// folder, the box it connects to) are not settings either. Shared by the box (server/settings.ts), the laptop
// (src/settings.ts), the phone and the preview's fake box: no imports but src/pluginDrafts.ts (none either).
import { CHANGE_KINDS, VERSION_RE, versionOf, type ChangeKind, type ChangeRecord } from "./pluginDrafts";

export const SETTING = "setting";

type Kind =
  | { kind: "enum"; options: readonly (string | null)[] }
  | { kind: "boolean" }
  | { kind: "string"; pattern: RegExp; hint: string };

export type SettingDef = Kind & {
  description: string;
  /** Who applies it: Carl's windows (a draft of it can be tried there), or the box (a draft of it can only be kept). */
  applies: "window" | "box";
  /** What it is when no record sets it. */
  default: string | boolean | null;
  /** Where it lived before it was a record: the box's localStorage file, or the laptop's localStorage. */
  legacy?: { where: "box" | "laptop"; key: string; read?: (raw: string) => unknown };
};

export const SETTINGS = {
  theme: {
    applies: "window",
    kind: "enum",
    options: ["graphite", "light"],
    default: "graphite",
    description: "The app's colour theme (laptop app and its pages): graphite (dark, the default) or light.",
    legacy: { where: "laptop", key: "vault_chat_theme" },
  },
  model: {
    applies: "box",
    kind: "string",
    pattern: /^[A-Za-z0-9._\-[\]]{1,100}$/,
    hint: "a Claude model id the composer's picker offers (opus, sonnet, haiku, claude-opus-5-5 …)",
    default: null,
    description: "The model every chat runs on (the composer's picker beside Send; one choice for every chat and device). Default: the box's (Opus).",
    legacy: { where: "box", key: "vault_chat_engine_model" },
  },
  effort: {
    applies: "box",
    kind: "enum",
    options: ["low", "medium", "high", "max", null],
    default: null,
    description: "How hard every chat thinks (the picker beside Send): low, medium, high, max, or null for the model's own default.",
    legacy: { where: "box", key: "vault_chat_engine_effort" },
  },
  voice: {
    applies: "box",
    kind: "string",
    pattern: /^[A-Za-z0-9]{8,40}$/,
    hint: "an ElevenLabs voice id",
    default: "nPczCjzI2devNBz1zQrb",
    description: "The voice ElevenLabs speaks with on every call while the ElevenLabs voice plugin (app/elevenlabs-voice) is on with a key: an ElevenLabs voice id, picked in that plugin's panel. The core local voice (Kokoro, af_heart) has no setting.",
    legacy: { where: "box", key: "vault_chat_elevenlabs_voice" },
  },
  pushAutomatic: {
    applies: "box",
    kind: "boolean",
    default: false,
    description: "Automatic phone pushes (the phone's Box & settings switch): true sends questions, failures and finishes while Carl is away; false pushes only work he asked to be pinged for.",
    legacy: { where: "box", key: "vc_push_legacy_automatic", read: (raw) => raw === "true" },
  },
  corePublish: {
    applies: "box",
    kind: "boolean",
    default: true,
    description: "Whether the box builds the laptop app's core (its frontend) from each accepted main and, once it passes the gate, makes it the laptop's current core, with no installer (server/coreBundles.ts): the laptop takes it at a quiet moment and falls back by itself if it does not start; a switch back returns. Off: nothing is built or landed; the installed app's own core runs.",
  },
  chatSidebar: {
    applies: "window",
    kind: "boolean",
    default: true,
    description: "The fullscreen chat's sidebar (the chat list beside it) open (true) or closed (false).",
    legacy: { where: "laptop", key: "vc_chat_sidebar", read: (raw) => raw !== "0" },
  },
} as const satisfies Record<string, SettingDef>;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue = string | boolean | null;
export type SettingSignal = { type: typeof SETTING; key: SettingKey; value: SettingValue; by: string };
/** The settings as every view sees them: each key's value (the default when nothing set it), and the seq of the last
 *  record that changed them (0: none yet). `set`: who set each key that a record sets, and in which record. */
export type SettingsState = {
  seq: number;
  values: Record<SettingKey, SettingValue>;
  set: Partial<Record<SettingKey, { by: string; seq: number }>>;
  /** The agent's drafts (setting.draft), oldest first, and Carl's word on them (setting.change), oldest first. */
  drafts: SettingsDraft[];
  changes: SettingsChange[];
};

export const SETTING_DRAFT = "setting.draft";
export const SETTING_CHANGE = "setting.change";
/** The settings' id where drafts are named (the gate, the Plugins tool, POST /api/v2/supervisor).
 *  Not app/settings: that is the Settings pane, a plugin with drafts of its own code. */
export const SETTINGS_DRAFT_ID = "app/settings-values";
/** What Carl calls them in the notice. */
export const SETTINGS_DRAFT_NAME = "Settings";

/** Some settings, each a value it takes (null: back to its default). */
export type SettingValues = Partial<Record<SettingKey, SettingValue>>;
export type SettingsDraft = { seq: number; version: string; values: SettingValues; what: string; by: string; at: number };
/** A change record (src/pluginDrafts.ts ChangeRecord) with what it put in effect and what that replaced. */
export type SettingsChange = ChangeRecord & { values: SettingValues; was: SettingValues };

export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];
export const isSettingKey = (k: unknown): k is SettingKey => typeof k === "string" && Object.prototype.hasOwnProperty.call(SETTINGS, k);

export function defaultSettings(): Record<SettingKey, SettingValue> {
  const out = {} as Record<SettingKey, SettingValue>;
  for (const k of SETTING_KEYS) out[k] = SETTINGS[k].default;
  return out;
}

export const emptySettings = (): SettingsState => ({ seq: 0, values: defaultSettings(), set: {}, drafts: [], changes: [] });

/** What a setting takes, in a few words (the agent's tool and every refusal say it). */
export function settingTakes(key: SettingKey): string {
  const d = SETTINGS[key] as SettingDef;
  if (d.kind === "enum") return d.options.map((o) => (o === null ? "null" : JSON.stringify(o))).join(" | ");
  if (d.kind === "boolean") return "true | false";
  return `${d.hint}, or null for the default`;
}

/** Why `value` can't be `key`, or null when it can (null always can: it is the default). */
export function settingProblem(key: unknown, value: unknown): string | null {
  if (!isSettingKey(key)) return `no setting "${String(key).slice(0, 60)}". The settings are: ${SETTING_KEYS.join(", ")}`;
  if (value === null) return null;
  const d = SETTINGS[key] as SettingDef;
  const bad = `${key} takes ${settingTakes(key)}, not ${JSON.stringify(value)?.slice(0, 80)}`;
  if (d.kind === "enum") return (d.options as readonly unknown[]).includes(value) ? null : bad;
  if (d.kind === "boolean") return typeof value === "boolean" ? null : bad;
  return typeof value === "string" && d.pattern.test(value) ? null : bad;
}

/** Fold one record of the log into the settings (only setting signals change anything): whether it did. */
export function foldSettings(s: SettingsState, rec: { seq: number; type?: unknown; signal?: unknown }): boolean {
  const g = rec.type === "signal" ? (rec.signal as Partial<SettingSignal> | undefined) : undefined;
  if (!g || g.type !== SETTING || !isSettingKey(g.key)) return false;
  const value = g.value === undefined ? null : g.value;
  // A record a later version wrote that this one can't read leaves the setting as it was.
  if (settingProblem(g.key, value) !== null) return false;
  s.values[g.key] = value === null ? SETTINGS[g.key].default : value;
  if (value === null) delete s.set[g.key];
  else s.set[g.key] = { by: typeof g.by === "string" ? g.by : "?", seq: rec.seq };
  s.seq = rec.seq;
  return true;
}

/** A legacy stored string as the setting's value, or undefined when it isn't one the setting takes. */
export function legacyValue(key: SettingKey, raw: string | null | undefined): SettingValue | undefined {
  if (raw === null || raw === undefined || raw === "") return undefined;
  const d = SETTINGS[key] as SettingDef;
  const v = d.legacy?.read ? d.legacy.read(raw) : raw;
  return settingProblem(key, v) === null && v !== null ? (v as SettingValue) : undefined;
}

// ---------------------------------------------------------------- drafts (the agent's own idea, Carl's word)

/** The settings in `v` this version takes, or null when one is not a setting or a value it doesn't take. */
export function settingValuesOf(v: unknown): SettingValues | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: SettingValues = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    const val = x === undefined ? null : x;
    if (!isSettingKey(k) || settingProblem(k, val) !== null) return null;
    out[k] = val as SettingValue;
  }
  return out;
}

/** The values in one order (a version is over this). */
export const canonicalValues = (v: SettingValues): string => JSON.stringify(SETTING_KEYS.filter((k) => k in v).map((k) => [k, v[k]]));

/** A draft's version: over its values and when it was written (the same values drafted again are a new draft). */
export const draftVersion = (v: SettingValues, at: number): string => versionOf(`${canonicalValues(v)}@${at}`);

/** `key = value` for each, as the notice and the tools say it. */
export function describeValues(v: SettingValues): string {
  const show = (k: SettingKey, x: SettingValue | undefined) => {
    if (x === null || x === undefined) return `${k} back to its default`;
    if (typeof x === "boolean") return `${k} ${x ? "on" : "off"}`;
    return `${k} ${x}`;
  };
  return SETTING_KEYS.filter((k) => k in v).map((k) => show(k, v[k])).join(", ");
}

/** Whether `v` has a setting Carl's windows apply (the gate draws those in the app's hidden copy). */
export const triable = (v: SettingValues): boolean => SETTING_KEYS.some((k) => k in v && SETTINGS[k].applies === "window");
/** The settings of `v` Carl's windows apply (what the gate's hidden copy shows). */
export function windowValues(v: SettingValues): SettingValues {
  const out: SettingValues = {};
  for (const k of SETTING_KEYS) if (k in v && SETTINGS[k].applies === "window") out[k] = v[k];
  return out;
}

/** Fold a draft or a change record (anything else: false). The settings themselves are foldSettings'. */
export function foldSettingDraft(s: SettingsState, rec: { seq: number; at?: number; type?: unknown; signal?: unknown }): boolean {
  const g = rec.type === "signal" ? (rec.signal as Record<string, unknown> | undefined) : undefined;
  if (!g || (g.type !== SETTING_DRAFT && g.type !== SETTING_CHANGE) || !Number.isFinite(rec.seq)) return false;
  if (s.drafts.some((d) => d.seq === rec.seq) || s.changes.some((c) => c.seq === rec.seq)) return false;
  const version = typeof g.version === "string" && VERSION_RE.test(g.version) ? g.version : null;
  const at = Number(g.at ?? rec.at) || 0;
  const by = typeof g.by === "string" ? g.by.slice(0, 40) : null;
  if (g.type === SETTING_DRAFT) {
    const values = settingValuesOf(g.values);
    if (!version || !values || !Object.keys(values).length) return false;
    s.drafts.push({ seq: rec.seq, version, values, what: typeof g.what === "string" ? g.what.slice(0, 200) : "", by: by ?? "?", at });
    s.drafts.sort((a, b) => a.seq - b.seq);
    return true;
  }
  if (!CHANGE_KINDS.includes(g.change as ChangeKind) || !version) return false;
  s.changes.push({
    seq: rec.seq,
    plugin: SETTINGS_DRAFT_ID,
    change: g.change as ChangeKind,
    version,
    from: typeof g.from === "string" ? g.from : null,
    at,
    by,
    reason: typeof g.reason === "string" ? g.reason : null,
    values: settingValuesOf(g.values) ?? {},
    was: settingValuesOf(g.was) ?? {},
  });
  s.changes.sort((a, b) => a.seq - b.seq);
  return true;
}

/** The draft waiting for Carl: the newest, unless he (or the agent, or an auto-discard) already decided on it. */
export function pendingSettingsDraft(s: Pick<SettingsState, "drafts" | "changes">): SettingsDraft | null {
  const d = s.drafts[s.drafts.length - 1];
  if (!d) return null;
  return s.changes.some((c) => c.version === d.version && c.change !== "switch") ? null : d;
}
