// The agent's word on a plugin (change 1.6): Carl says "disable html-lab", the agent writes the record. Only records:
// turning a plugin off or on (now, or from a time: an end date), a budget, and reading what each plugin is. Every view
// (the viewer, a chat, the phone, its own link) follows the record (src/pluginSupervisor.ts); nothing is hard-coded here.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pluginIdOf } from "../src/pluginSupervisor";
import { vaultPluginId, vaultPluginNamed } from "../src/vaultPlugins";
import { vaultCodePlugins } from "./pluginCatalog";
import { appPluginNamed } from "../src/appPlugins";
import { withinVault } from "./phoneData";
import { pluginDesired, setPluginBudget, setPluginDesired, supervisorOf } from "./supervisor";

export const PLUGIN_TOOL = "Plugins";

export const pluginToolSpecs = [
  {
    type: "function" as const,
    name: PLUGIN_TOOL,
    description:
      "Turn a plugin (a vault .html page, or a part of the app that is a plugin: the Notes panel, \"notes\") off or on everywhere it shows (the viewer, chats, the phone, its own link, the app's window), or from a later time (an end date), set its budget, or list what each plugin is. " +
      "Off: it is taken down in every view and the box gives it nothing; on: it comes back. action: status | disable | enable | budget. plugin: its vault path or its file name (\"html-lab\"), or the app part's name (\"notes\").",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["status", "disable", "enable", "budget"] },
        plugin: { type: "string", description: "The page's vault path, or its name (html-lab, html-lab.html), or an app part's name (notes)." },
        at: { type: "string", description: "disable/enable from this time (ISO, e.g. 2026-12-01T00:00) instead of now." },
        reason: { type: "string", description: "One line shown where the plugin was (disable)." },
        callsPerMinute: { type: ["number", "null"], description: "budget: at most this many box calls a minute, else it is turned off; null removes the budget." },
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
  const app = appPluginNamed(w);
  if (app && app.id === w.toLowerCase()) return { id: app.id };
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

/** Run the Plugins tool on `vault`. Never throws. */
export function pluginTool(vault: string, a: Record<string, unknown>): { ok: boolean; text: string } {
  const action = String(a.action ?? "");
  if (action === "status" && !a.plugin) {
    const all = supervisorOf(vault).plugins();
    return { ok: true, text: all.length ? all.map((id) => line(vault, id)).join("\n") : "Every plugin is on (no plugin has a record)." };
  }
  const r = resolvePlugin(vault, String(a.plugin ?? ""));
  if ("error" in r) return { ok: false, text: r.error };
  if (action === "status") return { ok: true, text: line(vault, r.id) };
  if (action === "budget") {
    const w = setPluginBudget(vault, { plugin: r.id, callsPerMinute: a.callsPerMinute ?? null }, "agent");
    return "error" in w ? { ok: false, text: w.error } : { ok: true, text: line(vault, r.id) };
  }
  if (action !== "disable" && action !== "enable") return { ok: false, text: "action: status, disable, enable or budget" };
  const w = setPluginDesired(vault, { plugin: r.id, state: action === "disable" ? "stopped" : "running", from: a.at ?? null, reason: a.reason }, "agent");
  if ("error" in w) return { ok: false, text: w.error };
  return { ok: true, text: `${line(vault, r.id)}. Every view of it follows (the viewer, chats, the phone, its link).` };
}
