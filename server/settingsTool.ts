// The agent's reach into Carl's settings (reports/08: "the agent can't reach settings"): one generic tool over the
// setting records (src/settingsRecords.ts, server/settings.ts). Read them all, or set one; the record is the change,
// and every open app and the phone follow it from the feed. No tool per setting: a setting added to SETTINGS is
// reachable here at once. Secrets are never settings (the key store is not reachable from here).
//
// Carl's direct ask ("make it light") is set at once. The agent's own idea (draft: true) is a setting.draft record
// first: the one gate judges it (server/gate.ts settingsGate) and, passed, sets it (a keep by "gate"), with a "Done:"
// line in the chat; the Plugins tool's back on settings-values undoes it (reports/07 point 4: settings count as behavior).
import { SETTINGS, SETTING_KEYS, SETTINGS_DRAFT_ID, describeValues, isSettingKey, pendingSettingsDraft, settingTakes, type SettingKey, type SettingValue } from "../src/settingsRecords";
import { draftSettings, readSettings, setSetting } from "./settings";

export const SETTINGS_TOOL = "Settings";

export const settingsToolSpecs = [
  {
    type: "function" as const,
    name: SETTINGS_TOOL,
    description:
      "Read or change Carl's app settings, the same ones his Settings, the composer's model picker and the phone's drawer change: theme, model, effort, voice, pushAutomatic, chatSidebar, corePublish. " +
      "No key: lists every setting with its value, what it takes and who set it. key + value: sets it (value null: back to its default); it shows at once in every open app. " +
      "Use it when Carl asks for a lighter theme, another model or effort, another voice, automatic pushes on or off. Not for keys or secrets. " +
      "A change that is your own idea, not Carl asking for that setting: draft: true; it goes through the gate first (the box takes every value; a window setting is drawn in the app's hidden copy) and, passed, is set, with a \"Done:\" line in this chat (Undo, or Plugins back on settings-values, undoes it).",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", enum: SETTING_KEYS, description: "The setting; left out: list them all." },
        value: { type: ["string", "boolean", "null"], description: "Its new value (see what it takes in the list); null: its default." },
        draft: { type: "boolean", description: "Your own idea, not Carl's ask: it is gated first, then set." },
        what: { type: "string", description: "draft: one line for the Done line (why)." },
      },
      additionalProperties: false,
    },
  },
];

const show = (v: SettingValue) => (v === null ? "null" : JSON.stringify(v));

/** Run the Settings tool. Never throws. `ctx`: where a draft's gate runs and which chat its Done line goes to. */
export function settingsTool(a: Record<string, unknown>, ctx?: { vault: string; conv: string | null }): { ok: boolean; text: string } {
  const s = readSettings();
  if (a.key === undefined || a.key === null || a.key === "") {
    const lines = SETTING_KEYS.map((k) => {
      const set = s.set[k];
      return `${k} = ${show(s.values[k])}${set ? ` (set by ${set.by})` : " (default)"}\n  takes ${settingTakes(k)}. ${SETTINGS[k].description}`;
    });
    const d = pendingSettingsDraft(s);
    if (d) lines.push(`A draft waits for the gate (${SETTINGS_DRAFT_ID} ${d.version}): ${describeValues(d.values)}${d.what && d.what !== describeValues(d.values) ? ` (${d.what})` : ""}.`);
    return { ok: true, text: lines.join("\n") };
  }
  if (!isSettingKey(a.key)) return { ok: false, text: `No setting "${String(a.key).slice(0, 60)}"; nothing changed. The settings are: ${SETTING_KEYS.join(", ")}.` };
  const key: SettingKey = a.key;
  if (!("value" in a)) return { ok: true, text: `${key} = ${show(s.values[key])}${s.set[key] ? ` (set by ${s.set[key]!.by})` : " (default)"}; takes ${settingTakes(key)}.` };
  if (a.draft === true) {
    const d = draftSettings({ [key]: a.value }, a.what, "agent");
    if (!d.ok) return { ok: false, text: `${d.error}; nothing drafted.` };
    const carried = Object.keys(d.carried).length ? ` It carries the draft that was waiting (${describeValues(d.carried)}).` : "";
    // The gate runs in the background (a window setting is drawn in the laptop app's hidden copy, up to two minutes);
    // passed, it is set and this chat gets its "Done:" line; failed, it is dropped.
    if (ctx) void import("./gate").then((g) => g.settingsGate(ctx.vault, { land: true, conv: ctx.conv, version: d.version })).catch((e) => console.warn(`[settings] the draft's gate failed: ${(e as Error)?.message ?? e}`));
    return { ok: true, text: `Drafted ${describeValues(d.values)} (${d.version}): the gate checks it now and, passed, sets it (a \"Done:\" line in this chat says so; Plugins back on settings-values undoes it); failed, it is dropped.${carried}` };
  }
  const r = setSetting(key, a.value, "agent");
  if (!r.ok) return { ok: false, text: `${r.error}; nothing changed.` };
  return { ok: true, text: `${key} is now ${show(r.value)}${r.was === r.value ? " (it already was)" : ` (was ${show(r.was)})`}. Every open app and the phone follow it.` };
}
