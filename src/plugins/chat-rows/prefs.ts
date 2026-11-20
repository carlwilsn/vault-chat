// app/chat-rows' kept choices, read from its state (plugin.state records, src/appPluginState.ts): which renderers and
// translators are off, the one chosen per kind or type, and the renderer options. Pure (no app imports), so every host
// that draws the chat follows the same records: the laptop (./index.ts followRowPrefs).

export const OFF = "off:";
export const USE = "use:";
export const OPT = "opt:";
export const TOFF = "toff:";
export const TUSE = "tuse:";

/** The kept translator choices (src/convlog/translators.ts): ids turned off, the one chosen per event type. */
export function translatorPrefs(state: Record<string, unknown>): { disabled: string[]; chosen: Record<string, string> } {
  const disabled: string[] = [];
  const chosen: Record<string, string> = {};
  for (const [k, v] of Object.entries(state)) {
    if (k.startsWith(TOFF) && v === true) disabled.push(k.slice(TOFF.length));
    else if (k.startsWith(TUSE) && typeof v === "string" && v) chosen[k.slice(TUSE.length)] = v;
  }
  return { disabled, chosen };
}

/** The kept option values, from the plugin's state: {kind: {option: value}}. */
export function rowOptionValues(state: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(state)) {
    if (!k.startsWith(OPT)) continue;
    const at = k.lastIndexOf(":");
    const kind = k.slice(OPT.length, at);
    const key = k.slice(at + 1);
    if (kind && key && at > OPT.length) (out[kind] ??= {})[key] = v;
  }
  return out;
}

/** The kept choices, from the plugin's state. */
export function rowPrefs(state: Record<string, unknown>): { disabled: string[]; chosen: Record<string, string> } {
  const disabled: string[] = [];
  const chosen: Record<string, string> = {};
  for (const [k, v] of Object.entries(state)) {
    if (k.startsWith(OFF) && v === true) disabled.push(k.slice(OFF.length));
    else if (k.startsWith(USE) && typeof v === "string" && v) chosen[k.slice(USE.length)] = v;
  }
  return { disabled, chosen };
}
