// Change ready beyond the laptop (reports/07 corrected model, point 4): the drafts waiting for Carl, as the box sees
// them, for the surfaces that do not hold the vault's files (the phone app, the iPad board). The laptop folds the same
// thing itself from its synced copies (src/changeReady.ts pendingChanges); here it is read from the files on the box
// and the records in its log, so every surface shows the same list:
//   - an app plugin's draft (.vault-chat/app-plugins/<name>.draft.js) and the app's preset draft (preset.draft.json),
//   - a vault plugin's draft (.vault-chat/plugins/<name>.draft.js; `added` when no live file is there yet),
//   - a box plugin's draft (.vault-chat/box-plugins/<name>.draft.js, server/boxPlugins.ts; the laptop also reads these),
//   - a migration draft (.vault-chat/migrations/<name>.draft.js, server/migrations.ts: a plugin's state reshaped),
//   - the agent's draft of Carl's settings (setting.draft in the main log).
// Carl's word goes through the same POST /api/v2/supervisor as the laptop's (a plugin.change / setting.change record),
// so a decision on any surface clears the card on every one.
//
// GET /api/v2/changes?surface=phone|board: {changes, off?}. A surface turned off (server/surfaces.ts) gets its line and
// no changes. `tryOn` names where Try can run a draft: the laptop for every plugin draft (and a settings draft with a
// window setting), the phone for a vault plugin whose draft names the phone (meta devices); then the phone's answer
// carries the draft's code, which its plugin host mounts in place of the live copy on that phone only.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { APP_PLUGINS } from "../src/appPlugins";
import { APP_PLUGIN_LIVE_DIR, LIVE_APP_PLUGINS, appPluginFolder } from "../src/appPluginLive";
import { PRESET_DRAFT_FILE, PRESET_PLUGIN_ID, parseDraft } from "../src/appPreset";
import { BOX_PLUGIN_DIR, appSlot, boxPluginName, boxSlot, draftPending, draftWhat, slotFileOf, vaultSlot } from "../src/pluginDrafts";
import { SETTINGS_DRAFT_ID, SETTINGS_DRAFT_NAME, describeValues, pendingSettingsDraft, triable as settingsTriable, type SettingsState } from "../src/settingsRecords";
import { VAULT_PLUGIN_DIR, VAULT_PLUGIN_MAX_BYTES, parseVaultPluginMeta, vaultPluginDevices } from "../src/vaultPlugins";
import { slotCode } from "./pluginDrafts";
import { pendingMigrations } from "./migrations";
import { supervisorOf } from "./supervisor";
import { surfaceOff, type Surface } from "./surfaces";
import { readSettings } from "./settings";
import type { BoxPendingChange, ChangeSurface } from "../src/changeCards";

/** The same name the laptop's notice gives the preset. */
const PRESET_NAME = "App preset";

const appName = (id: string) => APP_PLUGINS.find((p) => p.id === id)?.name ?? id.replace(/^app\//, "");

function settingsNow(): SettingsState | null {
  try {
    return readSettings();
  } catch {
    return null; // no main log configured (a bare test box): no settings drafts
  }
}

/** Every draft nobody decided on yet, in the laptop's order (app plugins, the preset, vault plugins, the settings). */
export function pendingOnBox(vault: string, surface: ChangeSurface = "laptop", settings: SettingsState | null = settingsNow()): BoxPendingChange[] {
  const sup = supervisorOf(vault);
  const out: BoxPendingChange[] = [];
  for (const id of LIVE_APP_PLUGINS) {
    const code = slotCode(vault, appSlot(appPluginFolder(id)!));
    const v = draftPending(code, sup.changes(id));
    if (v) out.push({ plugin: id, name: appName(id), what: draftWhat(code.draft!), version: v, added: false, tryOn: ["laptop"] });
  }
  const preset = slotCode(vault, { plugin: PRESET_PLUGIN_ID, dir: APP_PLUGIN_LIVE_DIR, live: "preset.json", draft: PRESET_DRAFT_FILE, prev: "preset.prev.json" }).draft;
  if (preset !== undefined) {
    const v = draftPending({ draft: preset }, sup.changes(PRESET_PLUGIN_ID));
    if (v) {
      const d = parseDraft(preset);
      out.push({ plugin: PRESET_PLUGIN_ID, name: PRESET_NAME, what: "preset" in d ? d.what || `the app's preset "${d.preset.name}"` : "", version: v, added: false, tryOn: ["laptop"] });
    }
  }
  let names: string[] = [];
  try {
    names = readdirSync(join(vault, VAULT_PLUGIN_DIR)).sort();
  } catch {
    /* no vault plugins */
  }
  for (const n of names) {
    const f = slotFileOf(n);
    if (!f || f.kind !== "draft") continue;
    const slot = vaultSlot(f.base, f.ext);
    const code = slotCode(vault, slot);
    if (code.draft === undefined || code.draft.length > VAULT_PLUGIN_MAX_BYTES) continue;
    const v = draftPending(code, sup.changes(slot.plugin));
    if (!v) continue;
    const phone = vaultPluginDevices(code.draft).includes("phone");
    const tryOn: ChangeSurface[] = ["laptop", ...(phone ? (["phone"] as const) : [])];
    out.push({
      plugin: slot.plugin,
      name: parseVaultPluginMeta(code.live ?? code.draft, slot.live).name,
      what: draftWhat(code.draft),
      version: v,
      added: code.live === undefined,
      tryOn,
      ...(surface === "phone" && phone ? { code: code.draft } : {}),
    });
  }
  // The box's own plugins (server/boxPlugins.ts): Try routes the trying laptop's requests to the draft.
  let boxNames: string[] = [];
  try {
    boxNames = readdirSync(join(vault, BOX_PLUGIN_DIR)).sort();
  } catch {
    /* no box plugins */
  }
  for (const n of boxNames) {
    const f = slotFileOf(n);
    const name = f && f.kind === "draft" && f.ext === ".js" ? boxPluginName(f.base) : null;
    if (!name) continue;
    const slot = boxSlot(name);
    const code = slotCode(vault, slot);
    const v = code.draft !== undefined ? draftPending(code, sup.changes(slot.plugin)) : null;
    if (v) out.push({ plugin: slot.plugin, name: `Box: ${name}`, what: draftWhat(code.draft!), version: v, added: code.live === undefined, tryOn: ["laptop"] });
  }
  // Migration drafts (src/migrations.ts): a plugin's state reshaped; Try runs it on a copy of real data (the laptop).
  out.push(...pendingMigrations(vault));
  const sd = settings ? pendingSettingsDraft(settings) : null;
  if (sd) out.push({ plugin: SETTINGS_DRAFT_ID, name: SETTINGS_DRAFT_NAME, what: sd.what || describeValues(sd.values), version: sd.version, added: false, tryOn: settingsTriable(sd.values) ? ["laptop"] : [] });
  return out;
}

/** GET /api/v2/changes (Carl's devices: the box's own auth has passed). */
export function changesRoute(vault: string, query: URLSearchParams): { status: number; body: unknown } {
  const s = query.get("surface") || "laptop";
  if (s !== "laptop" && s !== "phone" && s !== "board") return { status: 400, body: { error: "surface: laptop, phone or board" } };
  if (s !== "laptop") {
    const off = surfaceOff(vault, s as Surface);
    if (off) return { status: 200, body: { surface: s, off, changes: [] } };
  }
  return { status: 200, body: { surface: s, changes: pendingOnBox(vault, s) } };
}
