// The settings noun (report 24 §4, noun 1): Carl's settings as setting records in the main log (src/settingsRecords.ts,
// server/settings.ts). State: every setting's value and who set it. Action: set one (null: its default). The app's
// Settings pane, the composer's model picker and the phone set them through POST /api/v2/settings, the agent through
// PluginAct {plugin: "box:settings", action: "set"}; both are setSetting. Secrets are never settings.
import { SETTINGS, SETTING_KEYS, isSettingKey, settingTakes, type SettingValue } from "../../src/settingsRecords";
import { onSettingChanged, readSettings, setSetting } from "../settings";
import type { Noun } from "./index";

const show = (v: SettingValue) => (v === null ? "null" : JSON.stringify(v));

export const settingsNoun: Noun = {
  id: "settings",
  name: "Settings",
  state: {
    values: {
      description: `every setting's value, who set it and what it takes (${SETTING_KEYS.join(", ")})`,
      read: () => {
        const s = readSettings();
        return Object.fromEntries(SETTING_KEYS.map((k) => [k, { value: s.values[k], set: s.set[k]?.by ?? "default", takes: settingTakes(k), about: SETTINGS[k].description }]));
      },
    },
  },
  actions: {
    set: {
      description: "set one setting (value null: back to its default); every open app and the phone follow it at once. Not for keys or secrets",
      args: {
        type: "object",
        properties: { key: { type: "string", enum: SETTING_KEYS, description: "the setting" }, value: { type: ["string", "boolean", "null"], description: "its new value; null: its default" } },
        required: ["key", "value"],
        additionalProperties: false,
      },
      run: (a, by) => {
        if (!isSettingKey(a.key)) return { ok: false, text: `No setting "${String(a.key).slice(0, 60)}"; nothing changed. The settings are: ${SETTING_KEYS.join(", ")}.` };
        const r = setSetting(a.key, a.value, by);
        if (!r.ok) return { ok: false, text: `${r.error}; nothing changed.` };
        return { ok: true, text: `${r.key} is now ${show(r.value)}${r.was === r.value ? " (it already was)" : ` (was ${show(r.was)})`}. Every open app and the phone follow it.` };
      },
    },
  },
  watch: (fn) => onSettingChanged(() => fn()),
};
