// The agent's reach into Carl's settings (reports/08: "the agent can't reach settings"): one generic tool over the
// setting records (src/settingsRecords.ts, server/settings.ts). Read them all, or set one; the record is the change,
// and every open app and the phone follow it from the feed. No tool per setting: a setting added to SETTINGS is
// reachable here at once. Secrets are never settings (the key store is not reachable from here).
//
// Carl's direct ask ("make it light") is set at once. The agent's own idea (draft: true) is a setting.draft record
// instead: it waits for Carl as Change ready on his laptop (src/changeReady.ts), where Try shows it on his windows only,
// Keep sets it, Discard drops it and Switch back undoes a Keep (reports/07 point 4: settings count as behavior).
import { SETTINGS, SETTING_KEYS, SETTINGS_DRAFT_ID, describeValues, isSettingKey, pendingSettingsDraft, settingTakes, triable, type SettingKey, type SettingValue } from "../src/settingsRecords";
import { draftSettings, readSettings, setSetting } from "./settings";

export const SETTINGS_TOOL = "Settings";

export const settingsToolSpecs = [
  {
    type: "function" as const,
    name: SETTINGS_TOOL,
    description:
      "Read or change Carl's app settings, the same ones his Settings, the composer's model picker and the phone's drawer change: theme, model, effort, voice, pushAutomatic, chatSidebar, corePublish. " +
      "No key: lists every setting with its value, what it takes and who set it. key + value: sets it (value null: back to its default); it shows at once in every open app and on the phone. " +
      "Use it when Carl asks for a lighter theme, another model or effort, another voice, automatic pushes on or off. Not for keys or secrets. " +
      "A change that is your own idea, not Carl asking for that setting: draft: true; nothing is set, it waits for him as Change ready on his laptop (Try shows it on his windows only, Keep sets it, Discard drops it).",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", enum: SETTING_KEYS, description: "The setting; left out: list them all." },
        value: { type: ["string", "boolean", "null"], description: "Its new value (see what it takes in the list); null: its default." },
        draft: { type: "boolean", description: "Your own idea, not Carl's ask: propose it as Change ready instead of setting it." },
        what: { type: "string", description: "draft: one line for the notice (why)." },
      },
      additionalProperties: false,
    },
  },
];

const show = (v: SettingValue) => (v === null ? "null" : JSON.stringify(v));

/** Run the Settings tool. Never throws. */
export function settingsTool(a: Record<string, unknown>): { ok: boolean; text: string } {
  const s = readSettings();
  if (a.key === undefined || a.key === null || a.key === "") {
    const lines = SETTING_KEYS.map((k) => {
      const set = s.set[k];
      return `${k} = ${show(s.values[k])}${set ? ` (set by ${set.by})` : " (default)"}\n  takes ${settingTakes(k)}. ${SETTINGS[k].description}`;
    });
    const d = pendingSettingsDraft(s);
    if (d) lines.push(`A draft waits for Carl (Change ready, ${SETTINGS_DRAFT_ID} ${d.version}): ${describeValues(d.values)}${d.what && d.what !== describeValues(d.values) ? ` (${d.what})` : ""}.`);
    return { ok: true, text: lines.join("\n") };
  }
  if (!isSettingKey(a.key)) return { ok: false, text: `No setting "${String(a.key).slice(0, 60)}"; nothing changed. The settings are: ${SETTING_KEYS.join(", ")}.` };
  const key: SettingKey = a.key;
  if (!("value" in a)) return { ok: true, text: `${key} = ${show(s.values[key])}${s.set[key] ? ` (set by ${s.set[key]!.by})` : " (default)"}; takes ${settingTakes(key)}.` };
  if (a.draft === true) {
    const d = draftSettings({ [key]: a.value }, a.what, "agent");
    if (!d.ok) return { ok: false, text: `${d.error}; nothing drafted.` };
    const carried = Object.keys(d.carried).length ? ` It carries the draft that was waiting (${describeValues(d.carried)}).` : "";
    const tryLine = triable(d.values) ? "Try shows it on his windows only" : "it is the box's, so there is no Try: Keep sets it";
    return { ok: true, text: `Drafted, nothing set: ${describeValues(d.values)} (${d.version}). It waits for Carl as Change ready on his laptop: ${tryLine}, Discard drops it.${carried} PluginRead app/changes says whether he is trying it.` };
  }
  const r = setSetting(key, a.value, "agent");
  if (!r.ok) return { ok: false, text: `${r.error}; nothing changed.` };
  return { ok: true, text: `${key} is now ${show(r.value)}${r.was === r.value ? " (it already was)" : ` (was ${show(r.was)})`}. Every open app and the phone follow it.` };
}
