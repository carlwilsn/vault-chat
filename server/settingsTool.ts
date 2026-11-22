// The agent's reach into Carl's settings (reports/08: "the agent can't reach settings"): one generic tool over the
// setting records (src/settingsRecords.ts, server/settings.ts). Read them all, or set one; the record is the change,
// and every open app and the phone follow it from the feed. No tool per setting: a setting added to SETTINGS is
// reachable here at once. Secrets are never settings (the key store is not reachable from here).
//
// A set is the change, at once (the settings draft and its gate are gone: report 24 piece C).
import { SETTINGS, SETTING_KEYS, isSettingKey, settingTakes, type SettingKey, type SettingValue } from "../src/settingsRecords";
import { readSettings, setSetting } from "./settings";

export const SETTINGS_TOOL = "Settings";

export const settingsToolSpecs = [
  {
    type: "function" as const,
    name: SETTINGS_TOOL,
    description:
      "Read or change Carl's app settings, the same ones his Settings, the composer's model picker and the phone's drawer change: theme, model, effort, voice, pushAutomatic, chatSidebar, corePublish. " +
      "No key: lists every setting with its value, what it takes and who set it. key + value: sets it (value null: back to its default); it shows at once in every open app. " +
      "Use it when Carl asks for a lighter theme, another model or effort, another voice, automatic pushes on or off. Not for keys or secrets.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", enum: SETTING_KEYS, description: "The setting; left out: list them all." },
        value: { type: ["string", "boolean", "null"], description: "Its new value (see what it takes in the list); null: its default." },
      },
      additionalProperties: false,
    },
  },
];

const show = (v: SettingValue) => (v === null ? "null" : JSON.stringify(v));

/** Run the Settings tool. Never throws. */
export function settingsTool(a: Record<string, unknown>, _ctx?: { vault: string; conv: string | null }): { ok: boolean; text: string } {
  const s = readSettings();
  if (a.key === undefined || a.key === null || a.key === "") {
    const lines = SETTING_KEYS.map((k) => {
      const set = s.set[k];
      return `${k} = ${show(s.values[k])}${set ? ` (set by ${set.by})` : " (default)"}\n  takes ${settingTakes(k)}. ${SETTINGS[k].description}`;
    });
    return { ok: true, text: lines.join("\n") };
  }
  if (!isSettingKey(a.key)) return { ok: false, text: `No setting "${String(a.key).slice(0, 60)}"; nothing changed. The settings are: ${SETTING_KEYS.join(", ")}.` };
  const key: SettingKey = a.key;
  if (!("value" in a)) return { ok: true, text: `${key} = ${show(s.values[key])}${s.set[key] ? ` (set by ${s.set[key]!.by})` : " (default)"}; takes ${settingTakes(key)}.` };
  const r = setSetting(key, a.value, "agent");
  if (!r.ok) return { ok: false, text: `${r.error}; nothing changed.` };
  return { ok: true, text: `${key} is now ${show(r.value)}${r.was === r.value ? " (it already was)" : ` (was ${show(r.was)})`}. Every open app and the phone follow it.` };
}
