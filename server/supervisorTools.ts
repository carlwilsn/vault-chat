// The agent's word on a plugin (change 1.6): Carl says "disable html-lab", the agent writes the record. Only records:
// turning a plugin off or on (now, or from a time: an end date), a budget, and reading what each plugin is. Every view
// (the viewer, a chat, the phone, its own link) follows the record (src/pluginSupervisor.ts); nothing is hard-coded here.
//
// A plugin's draft (change by asking, src/pluginDrafts.ts) too: keep / discard / back are the plugin.change records
// Carl's Change ready writes (the box moves the files), and submit hands a draft to the gate: scripts/draft-check.ts
// runs it side by side on a copy of real data as a background job and lands it by the verdict (not asked for: a clear
// pass keeps it, a clear fail drops it, borderline waits for Carl as Change ready; asked for: only a fail drops it).
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { pluginIdOf } from "../src/pluginSupervisor";
import { vaultPluginId, vaultPluginNamed } from "../src/vaultPlugins";
import { vaultCodePlugins } from "./pluginCatalog";
import { appPluginNamed } from "../src/appPlugins";
import { liveCopyAt, liveCopyId } from "../src/appPluginLive";
import { withinVault } from "./phoneData";
import { pluginDesired, setPluginBudget, setPluginChange, setPluginDesired, supervisorOf } from "./supervisor";
import { slotCode, slotOf } from "./pluginDrafts";
import { boxPluginLine, boxPluginNames } from "./boxPlugins";
import { boxPluginName, versionOf, type DraftSlot } from "../src/pluginDrafts";
import { startServiceJob, type JobEnv } from "./engine/jobs";
import { masterDir } from "./master";
import { loadConfig } from "./config";
import { killTree } from "./commands/proc";
import { SETTINGS_DRAFT_ID, pendingSettingsDraft } from "../src/settingsRecords";
import { readSettings } from "./settings";
import { isMigrationId } from "../src/migrations";
import { migrationChange, migrationDraft } from "./migrations";

export const PLUGIN_TOOL = "Plugins";

export const pluginToolSpecs = [
  {
    type: "function" as const,
    name: PLUGIN_TOOL,
    description:
      "Turn a plugin (a vault .html page, or a part of the app that is a plugin: the Notes panel, \"notes\"; or a whole surface: the phone app, \"phone\", the iPad board, \"board\") off or on everywhere it shows (the viewer, chats, the phone, its own link, the app's window), or from a later time (an end date), set its budget, or list what each plugin is. " +
      "Off: it is taken down in every view and the box gives it nothing; on: it comes back. action: status | disable | enable | budget. plugin: its vault path or its file name (\"html-lab\"), or the app part's name (\"notes\"). " +
      "A plugin's draft (<name>.draft.js next to it): submit hands it to the draft gate (a side-by-side check on a copy of real data, in the background; asked: false, the default, for a fix Carl did not ask for: a clear pass lands it, a clear fail drops it, borderline waits for him as Change ready; asked: true: only a fail drops it, otherwise he tries it). keep / discard / back write the record Carl's Change ready buttons do (back: switch to the copy the last keep replaced); plugin \"settings-values\": the settings draft (Settings with draft: true). Never move the draft's files yourself. " +
      "Migration drafts (migrate/<name>): when a change needs a plugin's state in a new shape, write .vault-chat/migrations/<name>.draft.js (an ES module: a `// @vc-change <what>` line, export const plugin = \"app/<name>\" | \"box/<name>\" | a page's vault path, export function migrate(oldState) { return newState } over the whole state object). It waits for Carl as Change ready: Try runs it on a copy of the real state and shows before/after; Keep backs up and writes the new state as new records (old ones stay; Switch back reads them again). You may discard or back it; keep is Carl's. Never rewrite plugin.state records yourself. " +
      "Box plugins (box/<name>): the box's own behaviour, server-side modules .vault-chat/box-plugins/<name>.js exporting activate(box) (box.route(method, path, handler) at /api/v2/box/<name><path>, box.onRecord, box.every, box.readFile, box.state, box.reply, box.log; box.tool({name, description, inputSchema, handler(args, {tried, conv})}) gives you a tool, joining your tools at your next step; box.prompt(text) (at most 1500 characters) is said to you with your turns under the plugin's id; box.hideTool(name) takes one of your vault-chat tools away while it runs (never Plugins); cleanups undone on unload), loaded live by the running box, no release. Write <name>.draft.js: it waits for Carl as Change ready; Try runs it only for his laptop's requests (header x-vc-try: <version> for your own checks over loopback) and a chat he starts while trying it (only there are its tools, prompt and hidden tools in force), a tried draft cannot write state, and one that throws, fails to load, answers slower than 2 s or whose tool throws or runs over 10 s discards itself; a kept one that does so within 24 h switches back by itself.",
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

/** The checkout the gate runs from: the vault-chat project in the vault-chat folder. */
function gateRepo(): string | null {
  const m = masterDir();
  const repo = m ? join(m, "projects", "vault-chat") : null;
  return repo && existsSync(join(repo, "scripts", "draft-check.ts")) ? repo : null;
}

/** Run scripts/draft-check.ts with the gate (it writes the record through this box, by "gate"). */
function runGate(repo: string, args: string[], signal: AbortSignal, log: (t: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { HOME: process.env.HOME ?? homedir(), PATH: process.env.PATH ?? "", LANG: "C.UTF-8", ...(process.env.CHROMIUM ? { CHROMIUM: process.env.CHROMIUM } : {}) };
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/draft-check.ts", ...args], { cwd: repo, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const stop = () => killTree(child.pid);
    signal.addEventListener("abort", stop, { once: true });
    for (const s of [child.stdout, child.stderr]) s.on("data", (d) => ((out = (out + d).slice(-20_000)), log(String(d).trimEnd())));
    child.on("error", (e) => (signal.removeEventListener("abort", stop), reject(e)));
    // 0 pass, 3 borderline, 1 fail: each a verdict (landed or left by the script); 2: it could not run.
    child.on("close", (code) => (signal.removeEventListener("abort", stop), code === 0 || code === 1 || code === 3 ? resolve(out.trim()) : reject(new Error(`the draft check could not run (${code}): ${out.slice(-1200)}`))));
  });
}

/** The settings draft (server/settings.ts): keep / discard / back are its records; there is no gate (Carl decides). */
function settingsDraftAction(vault: string, action: string, a: Record<string, unknown>): { ok: boolean; text: string } {
  if (action === "submit") return { ok: false, text: "a settings draft has no gate: it already waits for Carl as Change ready (Settings with draft: true)" };
  const d = pendingSettingsDraft(readSettings());
  if (action !== "back" && !d) return { ok: false, text: "no settings draft waits" };
  const w = setPluginChange(vault, { plugin: SETTINGS_DRAFT_ID, change: action === "back" ? "switch" : action, ...(action !== "back" ? { version: d!.version } : {}), ...(a.reason ? { reason: a.reason } : {}) }, "agent");
  return "error" in w ? { ok: false, text: w.error } : { ok: true, text: w.text };
}

function draftAction(vault: string, action: string, a: Record<string, unknown>, ctx?: PluginToolCtx): { ok: boolean; text: string } {
  if (/^(?:app\/)?settings-values$/i.test(pluginIdOf(String(a.plugin ?? "").trim()))) return settingsDraftAction(vault, action, a);
  const slot = draftSlotOf(vault, String(a.plugin ?? ""));
  if (!slot) return { ok: false, text: `${String(a.plugin ?? "") || "(no plugin)"} has no drafts: name an app plugin with live copies (composer …) or a vault plugin's .js` };
  const draft = slotCode(vault, slot).draft;
  if (action === "back") {
    const w = setPluginChange(vault, { plugin: slot.plugin, change: "switch", ...(a.reason ? { reason: a.reason } : {}) }, "agent");
    return "error" in w ? { ok: false, text: w.error } : { ok: true, text: w.text };
  }
  if (draft === undefined) return { ok: false, text: `${slot.plugin} has no draft (${slot.dir}/${slot.draft})` };
  if (action === "submit" && slot.plugin.startsWith("box/")) return { ok: false, text: `${slot.plugin}: a box plugin's draft has no side-by-side gate yet; it already waits for Carl as Change ready (Try runs it only for his laptop's requests)` };
  const version = versionOf(draft);
  if (action === "keep" || action === "discard") {
    const w = setPluginChange(vault, { plugin: slot.plugin, change: action, version, ...(a.reason ? { reason: a.reason } : {}) }, "agent");
    return "error" in w ? { ok: false, text: w.error } : { ok: true, text: w.text };
  }
  // submit: the gate, as a background job of this conversation.
  if (!ctx) return { ok: false, text: "submit runs as a background job of a conversation: not here" };
  const repo = ctx.repo ?? gateRepo();
  if (!repo) return { ok: false, text: "no vault-chat checkout to run the draft check from (VC_MASTER/projects/vault-chat)" };
  const asked = a.asked === true;
  const box = ctx.box ?? `http://127.0.0.1:${loadConfig().port}`;
  const args = [slot.plugin, "--vault", vault, asked ? "--asked" : "--unasked", "--box", box];
  const r = startServiceJob(ctx.jobs, { name: "draft-gate", command: `Draft check of ${slot.plugin} ${version} (${asked ? "asked for" : "not asked for"})`, conv: ctx.convId, byCarl: ctx.byCarl, timeout: "30m" }, (signal, log) => runGate(repo, args, signal, log));
  if (!r.job) return { ok: false, text: r.text };
  return { ok: true, text: `Checking ${slot.plugin} draft ${version} side by side on a copy of real data (job ${r.job.id}; JobStatus follows it). ${asked ? "A fail drops it; otherwise Carl sees it as Change ready." : "A clear pass lands it (a keep record by gate), a clear fail drops it, borderline waits for Carl as Change ready."}` };
}

/** A migration draft (server/migrations.ts, migrate/<name>): the agent may discard it or switch it back; Keep is Carl's
 *  (Change ready, or app/changes keep on his word), since it reshapes his data. */
async function migrationAction(vault: string, action: string, a: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
  const id = pluginIdOf(String(a.plugin ?? "").trim());
  if (action === "submit") return { ok: false, text: `${id}: a migration has no gate; it waits for Carl as Change ready (Try runs it on a copy of real data)` };
  if (action === "keep") return { ok: false, text: `${id}: Carl keeps a migration himself (Change ready), or PluginAct app/changes keep when he said so` };
  const d = migrationDraft(vault, id);
  if (action === "discard" && !d) return { ok: false, text: `${id} has no draft` };
  const m = await migrationChange(vault, { plugin: id, change: action === "back" ? "switch" : action, ...(action === "discard" ? { version: d!.version } : {}), ...(a.reason ? { reason: a.reason } : {}) }, "agent");
  return "error" in m ? { ok: false, text: m.error } : { ok: true, text: m.text };
}

/** The Plugins tool, with migration drafts (whose words answer later). Never throws. */
export async function pluginToolAsync(vault: string, a: Record<string, unknown>, ctx?: PluginToolCtx): Promise<{ ok: boolean; text: string }> {
  const action = String(a.action ?? "");
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
  if (action === "status") return { ok: true, text: r.id.startsWith("box/") ? `${line(vault, r.id)}\n${boxPluginLine(vault, r.id.slice(4))}` : line(vault, r.id) };
  if (action === "budget") {
    const w = setPluginBudget(vault, { plugin: r.id, callsPerMinute: a.callsPerMinute ?? null }, "agent");
    return "error" in w ? { ok: false, text: w.error } : { ok: true, text: line(vault, r.id) };
  }
  if (action !== "disable" && action !== "enable") return { ok: false, text: "action: status, disable, enable, budget, submit, keep, discard or back" };
  const w = setPluginDesired(vault, { plugin: r.id, state: action === "disable" ? "stopped" : "running", from: a.at ?? null, reason: a.reason }, "agent");
  if ("error" in w) return { ok: false, text: w.error };
  return { ok: true, text: `${line(vault, r.id)}. Every view of it follows (the viewer, chats, the phone, its link).` };
}
