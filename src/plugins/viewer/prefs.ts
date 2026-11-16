// The viewer's kept choices: app/viewer's state as plugin.state records on the box (src/appPluginState.ts), keys
// "off:<viewer id>" = true (a viewer turned off), "use:<type or .ext>" = <viewer id> (the one chosen for it) and
// "opt:<type>:edit" = true | false (Ctrl+E switches that type to the source editor). So they survive a restart and are
// the same in every window; the registry (src/viewerRegistry.ts) follows them from the app's start (the first paint
// already has them), also while the plugin itself is off.
import { appPluginState, setAppPluginState, subscribeAppPluginState } from "../../appPluginState";
import { VIEWER_PLUGIN_ID } from "../../appPlugins";
import { useStore } from "../../store";
import { setViewerPrefs } from "../../viewerRegistry";

export const OFF = "off:";
export const USE = "use:";
export const OPT = "opt:";

/** The kept choices, from the plugin's state. */
export function viewerPrefs(state: Record<string, unknown> = appPluginState(VIEWER_PLUGIN_ID)): {
  disabled: string[];
  chosen: Record<string, string>;
  options: Record<string, Record<string, unknown>>;
} {
  const disabled: string[] = [];
  const chosen: Record<string, string> = {};
  const options: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(state)) {
    if (k.startsWith(OFF) && v === true) disabled.push(k.slice(OFF.length));
    else if (k.startsWith(USE) && typeof v === "string" && v) chosen[k.slice(USE.length)] = v;
    else if (k.startsWith(OPT)) {
      const at = k.lastIndexOf(":");
      const type = k.slice(OPT.length, at);
      if (type && at > OPT.length) (options[type] ??= {})[k.slice(at + 1)] = v;
    }
  }
  return { disabled, chosen, options };
}

let following: (() => void) | null = null;
/** The registry follows the kept choices from now on (once; returns off). */
export function followViewerPrefs(): () => void {
  if (following) return following;
  const apply = () => {
    const p = viewerPrefs();
    setViewerPrefs(p.disabled, p.chosen, p.options);
  };
  apply();
  const offState = subscribeAppPluginState((id) => id === VIEWER_PLUGIN_ID && apply());
  let vault = useStore.getState().vaultPath;
  const offStore = useStore.subscribe((st) => {
    if (st.vaultPath === vault) return;
    vault = st.vaultPath;
    apply();
  });
  following = () => {
    offState();
    offStore();
    following = null;
  };
  return following;
}
followViewerPrefs();

/** Keep choices: records on the box (here at once). What the box said, for the agent. */
export async function keep(writes: [string, unknown][]): Promise<{ kept: boolean; why?: string }> {
  let why: string | null = null;
  for (const [k, v] of writes) why = (await setAppPluginState(VIEWER_PLUGIN_ID, k, v)) ?? why;
  return why ? { kept: false, why } : { kept: true };
}

/** Turn a viewer back on (the fallback's Turn on). */
export function enableViewer(id: string): Promise<{ kept: boolean; why?: string }> {
  return keep([[OFF + id, null]]);
}
