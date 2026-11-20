// The agent's word on a plugin (change 1.6): Carl says "disable html-lab", the agent writes the record. Only records:
// turning a plugin off or on (now, or from a time: an end date), a budget, and reading what each plugin is. Every view
// (the viewer, a chat, the phone, its own link) follows the record (src/pluginSupervisor.ts); nothing is hard-coded here.
//
// A plugin's draft (change by asking, src/pluginDrafts.ts) too: keep / discard / back are the plugin.change records
// Carl's Change ready writes (the box moves the files), and submit hands a draft to the one gate (server/gate.ts,
// scripts/gate.ts: a plugin's, a box plugin's or the preset's draft as a background job on a copy of real data, the
// settings draft at once) and lands it by the verdict (not asked for: a clear pass keeps it, a clear fail drops it,
// borderline waits for Carl's "Try it?"; asked for: only a fail drops it).
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pluginIdOf } from "../src/pluginSupervisor";
import { vaultPluginId, vaultPluginNamed } from "../src/vaultPlugins";
import { vaultCodePlugins } from "./pluginCatalog";
import { appPluginNamed } from "../src/appPlugins";
import { APP_PLUGIN_LIVE_DIR, liveCopyAt, liveCopyId } from "../src/appPluginLive";
import { withinVault } from "./phoneData";
import { pluginDesired, setPluginBudget, setPluginChange, setPluginDesired, supervisorOf } from "./supervisor";
import { slotCode, slotOf } from "./pluginDrafts";
import { boxPluginLine, boxPluginNames } from "./boxPlugins";
import { boxPluginName, draftWhat, versionOf, type DraftSlot } from "../src/pluginDrafts";
import { type JobEnv } from "./engine/jobs";
import { loadConfig } from "./config";
import { SETTINGS_DRAFT_ID, pendingSettingsDraft } from "../src/settingsRecords";
import { readSettings } from "./settings";
import { isMigrationId } from "../src/migrations";
import { migrationChange, migrationDraft } from "./migrations";
import { PRESET_DRAFT_FILE, parseDraft } from "../src/appPreset";
import { PRESET_PART, gateLine } from "../src/gateResult";
import { gateResults, inBoxGate, settingsGate, submitGate } from "./gate";

export const PLUGIN_TOOL = "Plugins";

export const pluginToolSpecs = [
  {
    type: "function" as const,
    name: PLUGIN_TOOL,
    description:
      "Turn a plugin (a vault .html page, or a part of the app that is a plugin: the Notes panel, \"notes\"; or a whole surface: the phone app, \"phone\", the iPad board, \"board\") off or on everywhere it shows (the viewer, chats, the phone, its own link, the app's window), or from a later time (an end date), set its budget, or list what each plugin is. " +
      "Off: it is taken down in every view and the box gives it nothing; on: it comes back. action: status | disable | enable | budget. plugin: its vault path or its file name (\"html-lab\"), or the app part's name (\"notes\"). " +
      "A plugin's draft (<name>.draft.js next to it), a box plugin's draft or the app's preset draft (plugin \"preset\": .vault-chat/app-plugins/preset.draft.json): submit hands it to the one gate (the candidate checked beside what runs now on a copy of real data, in the background; nothing reaches Carl before it passes; asked: true when Carl asked for it: passed, it applies and this chat gets \"Done: <what>\" with Undo, failed, one plain line here says why; asked: false, the default, for a fix he did not ask for: a clear pass applies it silently, a fail drops it, a change he can see waits as \"<what> — Try it?\" in Main). Put a plain one-line `// @vc-change <what>` in the draft: it is the line Carl reads. keep / discard / back write the record his Try / Keep / Undo do (back: switch to the copy the last keep replaced); plugin \"settings-values\": the settings draft (Settings with draft: true; its gate runs before Carl sees it, submit runs it at once). Never move the draft's files yourself. " +
      "Migration drafts (migrate/<name>): when a change needs a plugin's state in a new shape, write .vault-chat/migrations/<name>.draft.js (an ES module: a `// @vc-change <what>` line, export const plugin = \"app/<name>\" | \"box/<name>\" | a page's vault path, export function migrate(oldState) { return newState } over the whole state object). Its gate is a dry run on a copy of the real state before Carl sees it (submit runs it at once): one that throws is dropped; then it waits for Carl: Try runs it on a copy of the real state and shows before/after; Keep backs up and writes the new state as new records (old ones stay; Switch back reads them again). You may discard or back it; keep is Carl's. Never rewrite plugin.state records yourself. " +
      "Box plugins (box/<name>): the box's own behaviour, server-side modules .vault-chat/box-plugins/<name>.js exporting activate(box) (box.route(method, path, handler) at /api/v2/box/<name><path>, box.onRecord, box.every, box.readFile, box.state, box.reply, box.log; box.tool({name, description, inputSchema, handler(args, {tried, conv})}) gives you a tool, joining your tools at your next step; box.prompt(text) (at most 1500 characters) is said to you with your turns under the plugin's id; box.hideTool(name) takes one of your vault-chat tools away while it runs (never Plugins); cleanups undone on unload), loaded live by the running box, no release. Write <name>.draft.js, then submit it: the gate loads it and the live copy apart from the box on a copy of the vault and compares what they register and answer (a draft that fails to load, throws or is slow is dropped); a change the agent or his pages would see gets a \"Try it?\" line in Main; Try runs it only for his laptop's requests (header x-vc-try: <version> for your own checks over loopback) and a chat he starts while trying it (only there are its tools, prompt and hidden tools in force), a tried draft cannot write state, and one that throws, fails to load, answers slower than 2 s or whose tool throws or runs over 10 s discards itself; a kept one that does so within 24 h switches back by itself.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["status", "disable", "enable", "budget", "submit", "keep", "discard", "back"] },
        plugin: { type: "string", description: "The page's vault path, or its name (html-lab, html-lab.html), or an app part's name (notes)." },
        at: { type: "string", description: "disable/enable from this time (ISO, e.g. 2026-12-01T00:00) instead of now." },
        reason: { type: "string", description: "One line shown where the plugin was (disable)." },
        callsPerMinute: { type: ["number", "null"], description: "budget: at most this many box calls a minute, else it is turned off; null removes the budget." },
        asked: { type: "boolean", description: "submit: Carl asked for this change (default false: a fix, refactor or speed-up nobody asked for)." },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
];

const SKIP = new Set([".git", "node_modules", ".trash"]);

/** The vault pages whose name is `word` (with or without .html), at most a few levels down. */
function pagesNamed(vault: string, word: string): string[] {
  const want = word.toLowerCase().replace(/\.html?$/, "");
  const out: string[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > 6 || out.length > 20) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (SKIP.has(n)) continue;
      const full = join(dir, n);
      const r = rel ? `${rel}/${n}` : n;
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full, r, depth + 1);
      else if (/\.html?$/i.test(n) && n.toLowerCase().replace(/\.html?$/, "") === want) out.push(r);
    }
  };
  walk(vault, "", 0);
  return out.sort();
}

/** The plugin id a word names: an app plugin by its id (src/appPlugins.ts), an existing vault page by path, else the
 *  one page or app plugin by that name. */
export function resolvePlugin(vault: string, word: string): { id: string } | { error: string } {
  const w = pluginIdOf(word.trim());
  if (!w) return { error: "name the plugin: its vault path or its file name" };
  // A box plugin (server/boxPlugins.ts): box/<name>.
  if (w.startsWith("box/")) {
    const name = boxPluginName(w);
    return name ? { id: `box/${name}` } : { error: `${w}: a box plugin is box/<name> (lowercase letters, digits, -)` };
  }
  const app = appPluginNamed(w);
  if (app && app.id === w.toLowerCase()) return { id: app.id };
  // An app plugin's copy in the vault (src/appPluginLive.ts), by its path: turned off, the next copy runs.
  const copy = liveCopyAt(w);
  if (copy) return { id: liveCopyId(copy.folder, copy.kind) };
  if (/\.html?$/i.test(w)) {
    const full = withinVault(vault, w);
    try {
      if (full && statSync(full).isFile()) return { id: w };
    } catch {
      /* not a path: try it as a name */
    }
    // A plugin that has records but no page any more can still be turned on or off.
    if (supervisorOf(vault).plugins().includes(w)) return { id: w };
  }
  const code = vaultCodePlugins(vault).filter((c) => vaultPluginNamed(w, c.file, c.name));
  if (code.length === 1 && !app) return { id: vaultPluginId(code[0]!.file) };
  if (code.length > 1) return { error: `${code.length} plugins are named ${w}: ${code.map((c) => vaultPluginId(c.file)).join(", ")}. Name one by its path.` };
  const hits = pagesNamed(vault, w.split("/").pop()!);
  if (code.length === 1) hits.push(vaultPluginId(code[0]!.file));
  if (app) {
    // A part of the app by its name ("notes"), unless a vault page has that name too: then say which is which.
    if (!hits.length) return { id: app.id };
    return { error: `${w} names the app's ${app.name} panel (${app.id}) and ${hits.length === 1 ? "a page" : `${hits.length} pages`}: ${hits.slice(0, 8).join(", ")}. Name one: ${app.id}, or the page by its path.` };
  }
  if (hits.length === 1) return { id: hits[0]! };
  if (hits.length > 1) return { error: `${hits.length} pages are named ${w}: ${hits.slice(0, 8).join(", ")}. Name one by its path.` };
  return { error: `no page in the vault is named ${w}` };
}

const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

function line(vault: string, id: string): string {
  const d = pluginDesired(vault, id);
  const by = d.by ? ` (by ${d.by}${d.reason ? `: ${d.reason}` : ""})` : "";
  const next = d.next ? `; changes at ${when(d.next)} UTC` : "";
  const budget = supervisorOf(vault).budget(id);
  return `${id}: ${d.state === "running" ? "on" : "off"}${by}${next}${budget ? `; budget ${budget} calls a minute` : ""}`;
}

// ---------------------------------------------------------------- drafts

/** The draft slot a word names: an app plugin (composer, app/composer) or a vault plugin (its name or path). */
export function draftSlotOf(vault: string, word: string): DraftSlot | null {
  const w = pluginIdOf(word.trim());
  if (!w) return null;
  const direct = slotOf(w) ?? slotOf(`app/${w}`) ?? slotOf(`.vault-chat/plugins/${w.replace(/\.draft(\.m?js)$/i, "$1")}`) ?? slotOf(`.vault-chat/plugins/${w}.js`);
  if (direct) return direct;
  const r = resolvePlugin(vault, w);
  return "error" in r ? null : slotOf(r.id);
}

/** What submit needs from the engine: the vault's jobs, and the conversation that is woken when the gate ends. */
export type PluginToolCtx = { jobs: JobEnv; convId: string; byCarl: boolean; repo?: string; box?: string };

/** The last gate result of a part, in a line (the Plugins tool's status), or "". */
function lastGateLine(vault: string, part: string): string {
  const r = gateResults(vault, part)[0];
  return r ? `\n  last ${gateLine(r)}` : "";
}

/** The settings draft (server/settings.ts): keep / discard / back are its records; submit runs its gate here, at once
 *  (server/gate.ts settingsGate; it also runs before the draft is offered to Carl). */
async function settingsSubmit(vault: string, a: Record<string, unknown>, ctx?: PluginToolCtx): Promise<{ ok: boolean; text: string }> {
  const r = await settingsGate(vault, { asked: a.asked === true, land: true, conv: ctx?.convId ?? null, again: true });
  if ("error" in r) return { ok: false, text: r.error };
  return { ok: r.result.verdict !== "fail", text: `${r.result.verdict === "fail" ? "The gate dropped the settings draft" : "The settings draft passed the gate and waits for Carl (\"Try it?\" in Main)"}: ${r.result.reasons.join("; ")}` };
}

function settingsDraftAction(vault: string, action: string, a: Record<string, unknown>): { ok: boolean; text: string } {
  if (action === "submit") return { ok: false, text: "the settings draft's gate answers later: use the Plugins tool (submit runs it in the box)" };
  const d = pendingSettingsDraft(readSettings());
  if (action !== "back" && !d) return { ok: false, text: "no settings draft waits" };
  const w = setPluginChange(vault, { plugin: SETTINGS_DRAFT_ID, change: action === "back" ? "switch" : action, ...(action !== "back" ? { version: d!.version } : {}), ...(a.reason ? { reason: a.reason } : {}) }, "agent");
  return "error" in w ? { ok: false, text: w.error } : { ok: true, text: w.text };
}

/** The app's preset draft (.vault-chat/app-plugins/preset.draft.json): the same words as a plugin's. */
const PRESET_SLOT: DraftSlot = { plugin: PRESET_PART, dir: APP_PLUGIN_LIVE_DIR, live: "preset.json", draft: PRESET_DRAFT_FILE, prev: "preset.prev.json" };

function draftAction(vault: string, action: string, a: Record<string, unknown>, ctx?: PluginToolCtx): { ok: boolean; text: string } {
  const word = pluginIdOf(String(a.plugin ?? "").trim());
  if (/^(?:app\/)?settings-values$/i.test(word)) return settingsDraftAction(vault, action, a);
  const slot = /^(?:app\/)?preset$/i.test(word) ? PRESET_SLOT : draftSlotOf(vault, String(a.plugin ?? ""));
  if (!slot) return { ok: false, text: `${String(a.plugin ?? "") || "(no plugin)"} has no drafts: name an app plugin with live copies (composer …) or a vault plugin's .js` };
  const draft = slotCode(vault, slot).draft;
  if (action === "back") {
    const w = setPluginChange(vault, { plugin: slot.plugin, change: "switch", ...(a.reason ? { reason: a.reason } : {}) }, "agent");
    return "error" in w ? { ok: false, text: w.error } : { ok: true, text: w.text };
  }
  if (draft === undefined) return { ok: false, text: `${slot.plugin} has no draft (${slot.dir}/${slot.draft})` };
  const version = versionOf(draft);
  if (action === "keep" || action === "discard") {
    const w = setPluginChange(vault, { plugin: slot.plugin, change: action, version, ...(a.reason ? { reason: a.reason } : {}) }, "agent");
    return "error" in w ? { ok: false, text: w.error } : { ok: true, text: w.text };
  }
  // submit: the one gate (scripts/gate.ts), as a background job of this conversation.
  if (!ctx) return { ok: false, text: "submit runs as a background job of a conversation: not here" };
  const box = ctx.box ?? `http://127.0.0.1:${loadConfig().port}`;
  const what = slot.plugin === PRESET_PART ? (() => { const d = parseDraft(draft); return "preset" in d ? d.what : ""; })() : draftWhat(draft);
  return submitGate(vault, { part: slot.plugin, version, what, asked: a.asked === true }, ctx, box);
}

/** A migration draft (server/migrations.ts, migrate/<name>): the agent may discard it or switch it back; Keep is Carl's
 *  (Change ready, or app/changes keep on his word), since it reshapes his data. */
async function migrationAction(vault: string, action: string, a: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
  const id = pluginIdOf(String(a.plugin ?? "").trim());
  if (action === "submit") {
    const r = await inBoxGate(vault, id, { land: true, again: true });
    if ("error" in r) return { ok: false, text: r.error };
    return { ok: r.result.verdict !== "fail", text: `${r.result.verdict === "fail" ? "The gate dropped the migration" : "The migration passed the gate (its dry run) and waits for Carl to keep it (\"Try it?\" in Main)"}: ${r.result.reasons.join("; ")}` };
  }
  if (action === "keep") return { ok: false, text: `${id}: Carl keeps a migration himself (its line in Main), or PluginAct app/changes keep when he said so` };
  const d = migrationDraft(vault, id);
  if (action === "discard" && !d) return { ok: false, text: `${id} has no draft` };
  const m = await migrationChange(vault, { plugin: id, change: action === "back" ? "switch" : action, ...(action === "discard" ? { version: d!.version } : {}), ...(a.reason ? { reason: a.reason } : {}) }, "agent");
  return "error" in m ? { ok: false, text: m.error } : { ok: true, text: m.text };
}

/** The Plugins tool, with migration drafts (whose words answer later). Never throws. */
export async function pluginToolAsync(vault: string, a: Record<string, unknown>, ctx?: PluginToolCtx): Promise<{ ok: boolean; text: string }> {
  const action = String(a.action ?? "");
  if (action === "submit" && /^(?:app\/)?settings-values$/i.test(pluginIdOf(String(a.plugin ?? "").trim()))) return settingsSubmit(vault, a, ctx);
  if ((action === "submit" || action === "keep" || action === "discard" || action === "back") && isMigrationId(pluginIdOf(String(a.plugin ?? "").trim()))) {
    try {
      return await migrationAction(vault, action, a);
    } catch (e) {
      return { ok: false, text: (e as Error).message };
    }
  }
  return pluginTool(vault, a, ctx);
}

/** Run the Plugins tool on `vault`. Never throws. */
export function pluginTool(vault: string, a: Record<string, unknown>, ctx?: PluginToolCtx): { ok: boolean; text: string } {
  const action = String(a.action ?? "");
  if (action === "submit" || action === "keep" || action === "discard" || action === "back") return draftAction(vault, action, a, ctx);
  if (action === "status" && !a.plugin) {
    const all = supervisorOf(vault).plugins();
    const box = boxPluginNames(vault).map((n) => boxPluginLine(vault, n));
    return { ok: true, text: [all.length ? all.map((id) => line(vault, id)).join("\n") : "Every plugin is on (no plugin has a record).", ...box].join("\n") };
  }
  const r = resolvePlugin(vault, String(a.plugin ?? ""));
  if ("error" in r) return { ok: false, text: r.error };
  if (action === "status") return { ok: true, text: (r.id.startsWith("box/") ? `${line(vault, r.id)}\n${boxPluginLine(vault, r.id.slice(4))}` : line(vault, r.id)) + lastGateLine(vault, r.id) };
  if (action === "budget") {
    const w = setPluginBudget(vault, { plugin: r.id, callsPerMinute: a.callsPerMinute ?? null }, "agent");
    return "error" in w ? { ok: false, text: w.error } : { ok: true, text: line(vault, r.id) };
  }
  if (action !== "disable" && action !== "enable") return { ok: false, text: "action: status, disable, enable, budget, submit, keep, discard or back" };
  const w = setPluginDesired(vault, { plugin: r.id, state: action === "disable" ? "stopped" : "running", from: a.at ?? null, reason: a.reason }, "agent");
  if ("error" in w) return { ok: false, text: w.error };
  return { ok: true, text: `${line(vault, r.id)}. Every view of it follows (the viewer, chats, the phone, its link).` };
}
