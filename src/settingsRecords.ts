// Carl's app settings as records in the one log (reports/08 "settings as records"): every setting the app's
// Settings, the composer's picker and the phone's drawer change is a `setting` signal in the box's main vault log,
// and the settings are the fold of those records, newest last. The laptop, the phone and the agent (the model's settings
// noun, server/model/settings.ts) all read and write the same records, so a change made anywhere shows everywhere.
//
//   {type: "setting", key, value, by}   one setting set (value null: back to its default)
//
// Old logs may still hold setting.draft / setting.change records (the agent's drafts, gone 11-22): nothing folds them.
//
// Secrets (API keys, tokens) are never settings: they stay in the key store. Machine-local things (the laptop's
// folder, the box it connects to) are not settings either. Shared by the box (server/settings.ts), the laptop
// (src/settings.ts), the phone and the preview's fake box: no imports.

export const SETTING = "setting";

/** The app's colour themes (src/App.css: `:root` is graphite, the rest `[data-theme="<id>"]`). */
export const THEMES = ["graphite", "light", "contrast"] as const;

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
    options: THEMES,
    default: "graphite",
    description: "The app's colour theme (laptop app and its pages): graphite (dark, the default), light, or contrast (high contrast: black, white text and borders, grey fills).",
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
    description: "The voice ElevenLabs speaks with on every call while the ElevenLabs voice plugin (app/elevenlabs-voice) is on with a key: an ElevenLabs voice id (set it here; the plugin draws nothing). The core local voice (Kokoro, af_heart) has no setting.",
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
    description: "Whether the box builds the laptop app's core (its frontend) from each accepted main and, once it passes the gate, makes it the laptop's current core, with no installer (server/coreBundles.ts): the laptop takes it when Carl presses OK on the Ready card and falls back by itself if it does not start; a switch back returns. Off: nothing is built or landed; the installed app's own core runs.",
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
};

/** Some settings, each a value it takes (null: back to its default). */
export type SettingValues = Partial<Record<SettingKey, SettingValue>>;

export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];
export const isSettingKey = (k: unknown): k is SettingKey => typeof k === "string" && Object.prototype.hasOwnProperty.call(SETTINGS, k);

export function defaultSettings(): Record<SettingKey, SettingValue> {
  const out = {} as Record<SettingKey, SettingValue>;
  for (const k of SETTING_KEYS) out[k] = SETTINGS[k].default;
  return out;
}

export const emptySettings = (): SettingsState => ({ seq: 0, values: defaultSettings(), set: {} });

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
