// The pages noun (report 24 §4, noun 3): the plugins of a vault (its .html pages with a vc manifest)
// and the parts of the app that are plugins (the Notes panel "notes", the phone app "phone", …), each on or off
// everywhere it shows (the viewer, chats, its own link, the app's window) and its budget. Only records: a turn off or on
// (now, or from a time: an end date) is a plugin.desired record, a budget a plugin.budget record (server/supervisor.ts);
// every view follows them (src/pluginSupervisor.ts), nothing is hard-coded here. The app's Turn on and its other words
// write the same records through POST /api/v2/supervisor; the agent acts through PluginAct {plugin: "box:pages"}.
// A page's own state (vc.state) is read with PluginRead {plugin: <its path>}; drafts are gone (report 24 piece C).
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pluginIdOf } from "../../src/pluginSupervisor";
import { pluginCatalog } from "../pluginCatalog";
import { appPluginNamed } from "../../src/appPlugins";
import { withinVault } from "../phoneData";
import { onSupervisorChanged, pluginDesired, setPluginBudget, setPluginDesired, supervisorOf } from "../supervisor";
import type { ActResult, Noun } from "./index";

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
  const hits = pagesNamed(vault, w.split("/").pop()!);
  if (app) {
    // A part of the app by its name ("notes"), unless a vault page has that name too: then say which is which.
    if (!hits.length) return { id: app.id };
    return { error: `${w} names the app's ${app.name} panel (${app.id}) and ${hits.length === 1 ? "a page" : `${hits.length} pages`}: ${hits.slice(0, 8).join(", ")}. Name one: ${app.id}, or the page by its path.` };
  }
  if (hits.length === 1) return { id: hits[0]! };
  if (hits.length > 1) return { error: `${hits.length} pages are named ${w}: ${hits.slice(0, 8).join(", ")}. Name one by its path.` };
  return { error: `no page in the vault is named ${w}` };
}

/** Whether a record's plugin is still something to list: an app part, or a page whose file is in the vault. Records of
 *  files that are gone (the vault .js plugins removed on 11-24, a deleted page) stay in the log but are not listed. */
export function listedPart(vault: string, id: string): boolean {
  if (!/\.(?:html?|m?js)$/i.test(id)) return true;
  if (!/\.html?$/i.test(id)) return false;
  const full = withinVault(vault, id);
  try {
    return !!full && statSync(full).isFile();
  } catch {
    return false;
  }
}

const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

/** One plugin's on/off as a line Carl could read ("<id>: off (by agent: on holiday); changes at …; budget …"). */
export function pluginLine(vault: string, id: string): string {
  const d = pluginDesired(vault, id);
  const by = d.by ? ` (by ${d.by}${d.reason ? `: ${d.reason}` : ""})` : "";
  const next = d.next ? `; changes at ${when(d.next)} UTC` : "";
  const budget = supervisorOf(vault).budget(id);
  return `${id}: ${d.state === "running" ? "on" : "off"}${by}${next}${budget ? `; budget ${budget} calls a minute` : ""}`;
}

const PLUGIN = { type: "string", description: "its vault path or its file name (html-lab, html-lab.html), or an app part's name (notes, phone)" };
const AT = { type: "string", description: "from this time (ISO, e.g. 2026-12-01T00:00) instead of now" };

export function pagesNoun(vault: string): Noun {
  const onOff = (state: "running" | "stopped") => (a: Record<string, unknown>, by: string): ActResult => {
    const r = resolvePlugin(vault, String(a.plugin ?? ""));
    if ("error" in r) return { ok: false, text: `${r.error}; nothing changed.` };
    const w = setPluginDesired(vault, { plugin: r.id, state, from: a.at ?? null, ...(a.reason ? { reason: a.reason } : {}) }, by);
    if ("error" in w) return { ok: false, text: `${w.error}; nothing changed.` };
    return { ok: true, text: `${pluginLine(vault, r.id)}. Every view of it follows (the viewer, chats, the phone, its link).` };
  };
  return {
    id: "pages",
    name: "Pages",
    state: {
      list: {
        description: "every page in this vault (pages with a vc-capabilities or vc-mount manifest: id = vault path, name, on/off, by whom, a later change, a budget), then the app's parts that have an on/off record (and a page turned off whose manifest is gone)",
        read: () => {
          const { plugins, truncated } = pluginCatalog(vault);
          const ids = new Set(plugins.map((p) => p.id));
          const rows = plugins.map((p) => `${pluginLine(vault, p.id)} | ${p.name}${p.description ? `: ${p.description}` : ""}`);
          const others = supervisorOf(vault).plugins().filter((id) => !ids.has(id) && listedPart(vault, id)).map((id) => pluginLine(vault, id));
          return { plugins: rows, ...(truncated ? { truncated: true } : {}), parts: others };
        },
      },
    },
    actions: {
      disable: {
        description: "turn a page or an app part off everywhere it shows (the box gives it nothing), now or from `at` (an end date)",
        args: { type: "object", properties: { plugin: PLUGIN, at: AT, reason: { type: "string", description: "one line shown where it was" } }, required: ["plugin"], additionalProperties: false },
        run: onOff("stopped"),
      },
      enable: {
        description: "turn it on again (it comes back in every view), now or from `at`",
        args: { type: "object", properties: { plugin: PLUGIN, at: AT }, required: ["plugin"], additionalProperties: false },
        run: onOff("running"),
      },
      budget: {
        description: "at most callsPerMinute box calls a minute, else it is turned off (by budget); null removes the budget",
        args: { type: "object", properties: { plugin: PLUGIN, callsPerMinute: { type: ["number", "null"], description: "calls a minute, or null" } }, required: ["plugin", "callsPerMinute"], additionalProperties: false },
        run: (a, by) => {
          const r = resolvePlugin(vault, String(a.plugin ?? ""));
          if ("error" in r) return { ok: false, text: `${r.error}; nothing changed.` };
          const w = setPluginBudget(vault, { plugin: r.id, callsPerMinute: a.callsPerMinute ?? null }, by);
          return "error" in w ? { ok: false, text: `${w.error}; nothing changed.` } : { ok: true, text: pluginLine(vault, r.id) };
        },
      },
    },
    watch: (fn) => onSupervisorChanged(vault, fn),
  };
}
