// The agent's reach into every plugin (reports/07 "the agent reaches every plugin", spec field `offers`): one generic
// pair of tools over what each mounted plugin declares with api.offer (src/pluginOffers.ts): its readable state, its
// actions (name, description, JSON-schema args) and its events. No tool is written per plugin: a plugin that declares
// offers is reachable the moment it mounts, and gone when it stops.
//
//   PluginRead  {}                      every live plugin and what it offers
//               {plugin, state?}        its state (every selector, or one) and its recent events
//   PluginAct   {plugin, action, args}  run an action; the answer is its result and the plugin's state read back
//
// Plugins are mounted in the laptop app (the phone app hosts none: it has only alerts and notes), so the call rides
// Show's channel (server/show.ts): a {type:"plugin", id, to: "laptop", op, ...} signal on the vault's feed, answered by
// src/pluginOffers.ts answerPluginSignal (src/boxChat.ts), acked over POST /api/v1/show/<id>/ack. The result is only
// ever that ack, or an honest "offline" / "didn't answer". Full trust: no grant.
//
// Vault pages (a vault .html with `<meta name="vc-capabilities" content="state, log">`) keep their vc.state and vc.log
// as records in the box's one log (server/pluginState.ts), so PluginRead reads them from the box whether or not the
// page is open anywhere: {plugin: <its vault path, file name or title>} answers its saved state, its last change and its
// recent log (and, while it is mounted and declares offers with vc.offer, its live offers too); the list names every
// page with records, whether it is mounted now and when it last changed. `after` + `wait` waits for its next record:
// the agent follows what Carl does in the page. `vault` (or an absolute path) names a page in another registered vault.
import { randomBytes } from "node:crypto";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { waitAck } from "./show";
import { controlDown, controlLive, noteAnswer } from "./deviceLink";
import { actBoxOffer, boxOffers, describeBoxOffer, isBoxWord, readBoxOffer, watchBoxOffer, type BoxOfferDeps } from "./boxOffers";
import { awaitPluginRecords, pagesWithRecords, readPluginRecords, type PluginActivity } from "./pluginState";
import { vaultFor, type NamedVault } from "./vaultRefs";
import { parseLiveNeeds } from "../src/liveBridge";
import type { PluginState } from "../src/pluginRecords";
import type { OfferAnswer, OffersDescription } from "../src/pluginOffers";

export const PLUGIN_READ = "PluginRead";
export const PLUGIN_ACT = "PluginAct";
export const PLUGIN_OFFER_TOOLS = [PLUGIN_READ, PLUGIN_ACT] as const;

export const pluginOfferToolSpecs = [
  {
    type: "function" as const,
    name: PLUGIN_READ,
    readOnly: true,
    description:
      "Reach any plugin running in Carl's app (the Notes panel, his vault plugins, in-process pages): each declares what it offers: state you can read, actions you can run (with their args), events it emits. " +
      "No plugin: lists every live plugin with its offers (use it first to learn a plugin's actions and args), the vault pages whose state the box keeps, and the box's own state (box:settings, box:notes, box:pages: the plugins in this vault and the app's parts, each on or off (what plugins Carl has), box:workspace: what is on his laptop screen (panes and their files, the file tree, the chat panel), box:jobs, box:links: each device's link and open vault, box:perf: the laptop's speed per build, box:logs, box:history: what Carl did (in the app, on every surface) and every thread's full transcript, searchable), which the box answers with no device online. plugin (its id, e.g. app/notes, or its name): reads its state (all of it, or the one `state` named) and its recent events, from the screen now. " +
      "A vault .html page that uses vc.state / vc.log (plugin: its vault path, file name or title; vault: another registered vault's name, or an absolute path) is read from the box even when it is closed: its saved state, last change and recent log records; after (the seq it showed) + wait (seconds, at most 25) waits for its next change, to follow what Carl does in it. " +
      "Any other plugin too: wait (seconds, at most 25) holds the answer until it emits its next event (after: the seq a watch showed; left out: from now), then gives its state and the new events, so you follow what Carl does instead of reading again and again. " +
      "app/context holds what Carl has selected, hovers and is focused in now. Use it to see a plugin's state or before PluginAct. Plugins run in the laptop app (the phone app hosts none). Only plugins mounted there now are reachable; a plugin that is off or not open says so.",
    inputSchema: {
      type: "object",
      properties: {
        plugin: { type: "string", description: "The plugin's id or name; left out: list every live plugin and what it offers." },
        state: { type: "string", description: "One state name to read (default: all of it)." },
        device: { type: "string", enum: ["laptop"], description: "The host: the laptop app (the only one; the phone app hosts no plugins)." },
        vault: { type: "string", description: "A vault page in another registered vault: that vault's name (default: this conversation's vault)." },
        after: { type: "number", description: "The seq the last read or watch showed (a vault page's record seq, or a plugin's event seq); with wait, answer once it has something newer." },
        wait: { type: "number", description: "Wait up to this many seconds (at most 25) for its next change: a vault page's next state change or log record, any other plugin's next event." },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function" as const,
    name: PLUGIN_ACT,
    description:
      "Run an action a live plugin offers (see PluginRead for its actions and their args), e.g. {plugin: \"app/notes\", action: \"view\", args: {filter: \"resolved\"}}. Carl's settings (theme, model, effort, voice, pushAutomatic, chatSidebar, corePublish): {plugin: \"box:settings\", action: \"set\", args: {key, value}} (value null: its default). A page or an app part off / on everywhere, by its name, no read first: {plugin: \"box:pages\", action: \"disable\" | \"enable\", args: {plugin: \"notes\" (the Notes panel) | \"phone\" | \"html-lab\"}}. " +
      "Arrange his laptop screen, no read first: {plugin: \"box:workspace\", action: \"closeLeftPanel\" (the file tree) | \"openLeftPanel\" | \"closeRightPanel\" (the chat panel) | \"openRightPanel\" | \"openInPane\" {path, pane: left|right} | \"closePane\" {pane} | \"split\" {on} | \"focus\" {target} | \"fullscreenChat\" {on} | \"chatSidebar\" {open} | \"openChat\" {id} | \"arrange\" {ops: [{action, ...}]}}; it answers with the layout read back from the screen (never claim a change without it). " +
      "Search what happened, read-only: {plugin: \"box:history\", action: \"activity\" {query?, hours?} (what Carl did on his surfaces past what your turn shows) | \"transcript\" {query, thread?: \"main\" or a project} (a thread's full raw history, before any compaction or Clear)}. " +
      "Returns the action's result and the plugin's state read back afterwards: tell Carl only what that says. A failing action is an error result; the plugin keeps running.",
    inputSchema: {
      type: "object",
      properties: {
        plugin: { type: "string", description: "The plugin's id or name." },
        action: { type: "string", description: "One of the actions it offers." },
        args: { type: "object", description: "The action's args, as its schema says." },
        device: { type: "string", enum: ["laptop"], description: "The host: the laptop app (the only one; the phone app hosts no plugins)." },
        whenBack: { type: "boolean", description: "The laptop is away: keep the action and run it when its app is back (within a day); the chat gets a line then. box:queue lists and cancels these." },
      },
      required: ["plugin", "action"],
      additionalProperties: false,
    },
  },
];

export function isPluginOfferTool(name: string): boolean {
  return (PLUGIN_OFFER_TOOLS as readonly string[]).includes(name);
}

export type PluginOfferDeps = {
  vault: string;
  emit: (ev: Record<string, unknown>) => void;
  /** How long the laptop has to answer (default 20 s: an action may write a file first). */
  ackMs?: number;
  /** The registered vaults (name, path): a page in another vault. */
  vaults?: () => NamedVault[];
  /** The box's own state as offers (server/boxOffers.ts): its state dir, and the asking chat's jobs. */
  stateDir?: string;
  jobs?: () => string;
  /** The asking conversation (a queued action's line goes there). */
  conv?: string;
};

const argLine = (schema: Record<string, unknown>): string => {
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const req = new Set((schema.required as string[] | undefined) ?? []);
  const parts = Object.entries(props).map(([k, p]) => {
    const t = Array.isArray(p.enum) ? p.enum.map((x) => JSON.stringify(x)).join("|") : ([] as unknown[]).concat(p.type ?? "any").join("|");
    return `${k}${req.has(k) ? "" : "?"}: ${t}`;
  });
  return `{${parts.join(", ")}}`;
};

/** A plugin's offers as the agent reads them. */
export function offersText(p: OffersDescription): string {
  const lines = [`- ${p.id} "${p.name}"`];
  if (p.state.length) lines.push(`  state: ${p.state.map((s) => `${s.name}${s.description ? ` (${s.description})` : ""}`).join("; ")}`);
  for (const a of p.actions) lines.push(`  action ${a.name} ${argLine(a.args)}${a.description ? `: ${a.description}` : ""}`);
  if (p.events.length) lines.push(`  events: ${p.events.map((e) => `${e.name}${e.description ? ` (${e.description})` : ""}`).join("; ")}`);
  if (!p.state.length && !p.actions.length && !p.events.length) lines.push("  (offers nothing)");
  return lines.join("\n");
}

const HOSTS = ["laptop"] as const;
type Host = (typeof HOSTS)[number];
const HOST_NAME: Record<Host, string> = { laptop: "laptop" };

type Asked = { ok: false; text: string } | { ok: true; answer: OfferAnswer; error?: string };

/** The host a call goes to: the laptop (the phone app hosts no plugins). */
function hostsFor(_d: PluginOfferDeps, device: unknown, _all: boolean): { hosts: Host[] } | { error: string } {
  if (device !== undefined && device !== null && device !== "" && String(device).trim().toLowerCase() !== "laptop") {
    return { error: `Plugins run only in the laptop app (the phone app has only alerts and notes, and hosts no plugins), not "${String(device)}". Nothing was asked.` };
  }
  return { hosts: ["laptop"] };
}

async function ask(d: PluginOfferDeps, host: Host, body: Record<string, unknown>, extraMs = 0): Promise<Asked> {
  const down = controlDown(host);
  if (down) return { ok: false, text: `${down} Its plugins are mounted there, so none can be read or run now. Say so; don't guess.` };
  const where = HOST_NAME[host];
  const id = `plugin-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  const ms = (d.ackMs ?? 20_000) + extraMs;
  const got = waitAck(id, ms);
  d.emit({ type: "plugin", id, to: host, ...body });
  const ack = await got;
  noteAnswer(host, "plugin", !!ack);
  if (!ack) return { ok: false, text: `Asked the ${where}, but it did not answer within ${Math.round(ms / 1000)} s (an older app without plugin offers, or it is busy). Nothing is confirmed.` };
  const raw = (ack.data as { answer?: unknown } | undefined)?.answer;
  if (typeof raw !== "string") return { ok: false, text: `The ${where} answered without a plugin answer${ack.error ? `: ${ack.error}` : ""} (an older app?). Nothing is confirmed.` };
  try {
    return { ok: true, answer: JSON.parse(raw) as OfferAnswer, error: ack.error };
  } catch {
    return { ok: false, text: `The ${where}'s answer could not be read. Nothing is confirmed.` };
  }
}

const json = (v: unknown) => JSON.stringify(v, null, 1);

// ---------------------------------------------------------------- vault pages, from the box's log

const isAppWord = (w: string) => /^(?:app\/|widget:)/i.test(w);
const PAGE_EXT = /\.html?$/i;
const PAGE_MAX_BYTES = 2 * 1024 * 1024;

/** The page file's text (the head of it is enough for its title and manifest), or null. */
function pageText(vault: string, id: string): string | null {
  if (!PAGE_EXT.test(id) || id.split("/").includes("..")) return null;
  try {
    const full = join(vault, id);
    const size = Math.min(statSync(full).size, PAGE_MAX_BYTES);
    const fd = openSync(full, "r");
    try {
      const buf = Buffer.alloc(size);
      return buf.subarray(0, readSync(fd, buf, 0, size, 0)).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

const titleOf = (html: string | null): string => (html ? (/<title[^>]*>([^<]{1,200})<\/title>/i.exec(html)?.[1] ?? "").trim() : "");
const baseOf = (id: string) => (id.split("/").pop() ?? id).toLowerCase();

/** The page a word names in a vault: its vault path, an absolute path inside it, its file name (with or without .html) or its title. */
export function pageNamed(vault: string, word: string): string | null {
  let w = String(word ?? "").trim().replace(/\\/g, "/");
  if (!w || isAppWord(w)) return null;
  const root = vault.replace(/\\/g, "/").replace(/\/+$/, "");
  if (w.toLowerCase().startsWith(root.toLowerCase() + "/")) w = w.slice(root.length + 1);
  w = w.replace(/^(?:\.\/)+/, "").replace(/^\/+/, "");
  const ids = pagesWithRecords(vault).map((p) => p.id);
  const lw = w.toLowerCase();
  const exact = ids.find((id) => id.toLowerCase() === lw);
  if (exact) return exact;
  if (PAGE_EXT.test(w) && pageText(vault, w) !== null) return w;
  const byFile = ids.find((id) => baseOf(id) === lw || baseOf(id).replace(PAGE_EXT, "") === lw.replace(PAGE_EXT, ""));
  if (byFile) return byFile;
  return ids.find((id) => titleOf(pageText(vault, id)).toLowerCase() === lw) ?? null;
}

const when = (at: number) => (at ? new Date(at).toISOString().replace(/\.\d+Z$/, "Z") : "unknown");

/** What the box keeps of a page, as the agent reads it. */
function pageRecordsText(vault: string, vaultName: string | null, id: string, r: PluginState & PluginActivity, mounted: string): string {
  const html = pageText(vault, id);
  const title = titleOf(html);
  const head = `${id}${title ? ` "${title}"` : ""}${vaultName ? ` (vault ${vaultName})` : ""}: kept on the box (readable whether or not the page is open); ${mounted}.`;
  if (!r.seq) {
    const caps = html ? parseLiveNeeds(html).caps : [];
    const why = !html
      ? "and no such page is in the vault"
      : caps.includes("state")
        ? "it declares the state service but has not saved anything yet (nothing set since Carl opened it)"
        : 'it does not declare the state service, so what Carl does in it stays in the page: to make it readable, the page needs <meta name="vc-capabilities" content="state, log"> and vc.state.set(key, value) as he answers';
    return `${head}\nNo saved state or log records yet: ${why}.`;
  }
  const logs = r.logs.length ? [`recent log (${r.logs.length} of ${r.logCount}, oldest first): ${json(r.logs.map((l) => ({ seq: l.seq, at: when(l.at), record: l.record })))}`] : ["log: no records"];
  return [head, `state: ${json(r.state)}`, `last change: ${when(r.at)} (seq ${r.seq}; PluginRead {plugin, after: ${r.seq}, wait: 25} waits for the next)`, ...logs].join("\n");
}

export async function pluginOfferTool(d: PluginOfferDeps, name: string, a: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
  const plugin = typeof a.plugin === "string" ? a.plugin.trim() : "";
  const boxDeps: BoxOfferDeps = { vault: d.vault, emit: d.emit, ackMs: d.ackMs, stateDir: d.stateDir, jobs: d.jobs, vaults: () => (d.vaults?.() ?? []).map((v) => v.path), conv: d.conv };
  // The box's own state (box:settings, box:notes, box:pages, box:workspace, box:history, box:jobs, box:links, box:logs): answered here, with or without a device.
  if (plugin && isBoxWord(plugin)) {
    const only = typeof a.state === "string" && a.state.trim() ? a.state.trim() : undefined;
    if (name === PLUGIN_READ) {
      const wait = Number(a.wait);
      const w = Number.isFinite(wait) && wait > 0 ? Math.min(wait, 25) : 0;
      const r = w ? await watchBoxOffer(boxDeps, plugin, w * 1000, only) : await readBoxOffer(boxDeps, plugin, only);
      if (!r.ok) return { ok: false, text: `Error: ${r.error}.` };
      const how = w ? ((r as { changed?: boolean }).changed ? `watched on the box: it changed within ${w} s` : `watched on the box: nothing changed within ${w} s`) : "read on the box now";
      return { ok: true, text: [`${r.id}, ${how}:`, `state: ${json(r.state)}`].join("\n") };
    }
    if (name === PLUGIN_ACT) {
      const action = typeof a.action === "string" ? a.action.trim() : "";
      if (!action) return { ok: false, text: "PluginAct needs plugin and action (PluginRead lists what each plugin offers)." };
      const args = a.args && typeof a.args === "object" && !Array.isArray(a.args) ? (a.args as Record<string, unknown>) : {};
      const r = await actBoxOffer(boxDeps, plugin, action, args);
      return { ok: r.ok, text: [`${plugin} ${action}: ${r.ok ? "done" : "Error"}: ${r.text}`, ...(r.state ? [`state read back: ${json(r.state)}`] : [])].join("\n") };
    }
  }
  if (name === PLUGIN_READ) {
    const to = hostsFor(d, a.device, !plugin);
    if ("error" in to) return { ok: false, text: to.error };
    if (!plugin && a.device !== undefined && a.device !== null && a.device !== "") return listAll(d, to.hosts, a.vault);
    if (!plugin) {
      const box = boxOffers(boxDeps).map(describeBoxOffer);
      const boxBlock = [`${box.length} part(s) of the box's own state, answered by the box with or without a device (PluginRead {plugin: "box:…", wait?} reads or watches; PluginAct runs an action):`, ...box.map(offersText)].join("\n");
      const devices = await listAll(d, to.hosts, a.vault);
      return { ok: true, text: `${devices.text}\n\n${boxBlock}` };
    }
    // A vault page (its state kept on the box): in this vault, another named one, or the one an absolute path is inside.
    const tv = isAppWord(plugin) ? null : vaultFor(d.vault, d.vaults?.(), a.vault, plugin);
    if (tv && "error" in tv) return { ok: false, text: `Error: ${tv.error}. Nothing was read.` };
    const pageId = tv ? pageNamed(tv.vault, tv.path) : null;
    const host = to.hosts[0]!;
    const online = controlLive(host);
    const wait = Number(a.wait);
    if (pageId && tv && Number.isFinite(wait) && wait > 0) {
      const after = Number.isFinite(Number(a.after)) ? Math.trunc(Number(a.after)) : readPluginRecords(tv.vault, pageId).seq;
      const r = await awaitPluginRecords(tv.vault, pageId, after, Math.min(wait, 25) * 1000);
      const news = r.seq > after ? `something new since seq ${after}` : `nothing new since seq ${after} within ${Math.min(wait, 25)} s`;
      return { ok: true, text: pageRecordsText(tv.vault, tv.name, pageId, r, news) };
    }
    if (pageId && tv && !online) {
      return { ok: true, text: pageRecordsText(tv.vault, tv.name, pageId, readPluginRecords(tv.vault, pageId), `the ${HOST_NAME[host]} is not online, so whether it is open there is unknown and its live offers can't be read`) };
    }
    // Watch an app plugin: the device holds its answer until the plugin's next event (src/pluginOffers.ts watchOffers).
    if (!pageId && Number.isFinite(wait) && wait > 0) {
      const secs = Math.min(wait, 25);
      const after = Number.isFinite(Number(a.after)) && a.after !== undefined && a.after !== null ? Math.trunc(Number(a.after)) : null;
      const w = await ask(d, host, { op: "watch", plugin, after, wait: secs * 1000, ...(typeof a.state === "string" && a.state.trim() ? { state: a.state.trim() } : {}) }, secs * 1000);
      if (!w.ok) return w;
      const x = w.answer as OfferAnswer & { timedOut?: boolean; seq?: number };
      if (!x.plugin) return { ok: false, text: `Error (${HOST_NAME[host]}): ${x.error ?? "no answer"}${/unknown plugin op "watch"/.test(x.error ?? "") ? " (this app is older and cannot watch: read it again instead)" : ""}` };
      const news = x.timedOut ? `nothing new${after !== null ? ` since seq ${after}` : ""} within ${secs} s` : `new events${after !== null ? ` since seq ${after}` : ""}`;
      return {
        ok: x.ok,
        text: [`${x.plugin.id} "${x.plugin.name}", watched on the ${HOST_NAME[host]}: ${news}.`, ...(x.events?.length ? [`events: ${json(x.events)}`] : []), ...(x.state ? [`state now: ${json(x.state)}`] : []), `seq ${x.seq ?? after ?? 0} (PluginRead {plugin: "${x.plugin.id}", after: ${x.seq ?? after ?? 0}, wait: 25} waits for the next)`, ...(x.error ? [`Error: ${x.error}`] : [])].join("\n"),
      };
    }
    const r = await ask(d, host, { op: "read", plugin: pageId ?? plugin, ...(typeof a.state === "string" && a.state.trim() ? { state: a.state.trim() } : {}) });
    const liveOk = r.ok && !!r.answer.plugin;
    if (pageId && tv) {
      const saved = pageRecordsText(tv.vault, tv.name, pageId, readPluginRecords(tv.vault, pageId), liveOk ? `mounted on the ${HOST_NAME[host]} now (its live offers above)` : `not mounted on the ${HOST_NAME[host]} now (not open there, or it declares no offers)`);
      if (!liveOk) return { ok: true, text: saved };
      const x = r.answer;
      const head = x.ok ? `${x.plugin!.id} "${x.plugin!.name}", its offers read from the ${HOST_NAME[host]} now:` : `${x.plugin!.id} (${HOST_NAME[host]}): Error: ${x.error}`;
      return { ok: true, text: [head, ...(x.state ? [`state: ${json(x.state)}`] : []), ...(x.events?.length ? [`recent events: ${json(x.events)}`] : []), "", saved].join("\n") };
    }
    if (!r.ok) return r;
    const x = r.answer;
    if (!x.plugin) return { ok: false, text: `Error (${HOST_NAME[host]}): ${x.error ?? "no answer"}` };
    const head = x.ok ? `${x.plugin.id} "${x.plugin.name}", read from the ${HOST_NAME[host]} now:` : `${x.plugin.id} (${HOST_NAME[host]}): Error: ${x.error}`;
    return { ok: x.ok, text: [head, ...(x.state ? [`state: ${json(x.state)}`] : []), ...(x.events?.length ? [`recent events: ${json(x.events)}`] : [])].join("\n") };
  }
  if (name === PLUGIN_ACT) {
    const action = typeof a.action === "string" ? a.action.trim() : "";
    if (!plugin || !action) return { ok: false, text: "PluginAct needs plugin and action (PluginRead lists what each plugin offers)." };
    if (a.args !== undefined && (a.args === null || typeof a.args !== "object" || Array.isArray(a.args))) return { ok: false, text: "PluginAct: args must be an object. Nothing was run." };
    const to = hostsFor(d, a.device, false);
    if ("error" in to) return { ok: false, text: to.error };
    const host = to.hosts[0]!;
    // Away, and asked to wait for it: kept as desired state, run when the device is back (server/deviceQueue.ts).
    if (a.whenBack === true && controlDown(host) && d.stateDir) {
      const { queueAct } = await import("./deviceQueue");
      const q = queueAct(d.stateDir, { device: host, vault: d.vault, conv: d.conv ?? null, plugin, action, args: (a.args as Record<string, unknown>) ?? {} });
      return { ok: true, text: `The ${HOST_NAME[host]} is away, so ${plugin} ${action} is kept (${q.id}) and runs when its app is back (within a day); this chat gets a line then. Nothing has happened on screen yet: say so. box:queue lists it; PluginAct {plugin: "box:queue", action: "cancel", args: {id: "${q.id}"}} drops it.` };
    }
    // A vault page by its path, file name or title: asked for by its id (its vault path), as the host registered it.
    const pageId = isAppWord(plugin) ? null : pageNamed(d.vault, plugin);
    const r = await ask(d, host, { op: "act", plugin: pageId ?? plugin, action, args: a.args ?? {} });
    if (!r.ok) return r;
    const x = r.answer;
    if (!x.ok && !x.plugin && pageId) return { ok: false, text: `${pageId}: Error: it is not mounted on the ${HOST_NAME[host]} now, so its actions can't run (a page's actions run only while it is open and declares them with vc.offer). Open it with Show {path: "${pageId}", where: "laptop"} and try again; PluginRead {plugin: "${pageId}"} reads its saved state meanwhile.` };
    const who = `${x.plugin ? x.plugin.id : plugin}${host === "laptop" ? "" : ` (${HOST_NAME[host]})`}`;
    const back = x.state && Object.keys(x.state).length ? [`state read back: ${json(x.state)}`] : [];
    if (!x.ok) return { ok: false, text: [`${who} ${action}: Error: ${x.error}`, ...back].join("\n") };
    return { ok: true, text: [`${who} ${action}: done.`, `result: ${json(x.result)}`, ...back].join("\n") };
  }
  return { ok: false, text: `unknown plugin tool ${name}` };
}

/** PluginRead {}: every host's live plugins, then the vault pages the box keeps records of. */
async function listAll(d: PluginOfferDeps, hosts: Host[], vaultArg: unknown): Promise<{ ok: boolean; text: string }> {
  const answers = await Promise.all(hosts.map((h) => ask(d, h, { op: "list" })));
  const blocks: string[] = [];
  const mounted = new Map<string, Host[]>();
  hosts.forEach((h, i) => {
    const r = answers[i]!;
    if (!r.ok) return void blocks.push(hosts.length > 1 ? `On the ${HOST_NAME[h]}: ${r.text}` : r.text);
    const ps = r.answer.plugins ?? [];
    for (const id of [...ps.map((p) => p.id), ...(r.answer.pages ?? [])]) mounted.set(id, [...(mounted.get(id) ?? []), h]);
    blocks.push(ps.length ? [`${ps.length} live plugin(s) on the ${HOST_NAME[h]} and what each offers (PluginRead {plugin} reads state; PluginAct {plugin, action, args} runs an action):`, ...ps.map(offersText)].join("\n") : `No plugin mounted on the ${HOST_NAME[h]} declares offers right now.`);
  });
  const tv = vaultFor(d.vault, d.vaults?.(), vaultArg, "");
  if ("error" in tv) return { ok: false, text: `Error: ${tv.error}.` };
  const pages = pagesWithRecords(tv.vault).filter((p) => !p.id.startsWith(".vault-chat/plugins/"));
  if (pages.length) {
    const online = answers.some((r) => r.ok);
    const lines = pages.slice(0, 40).map((p) => {
      const title = titleOf(pageText(tv.vault, p.id));
      const on = mounted.get(p.id);
      const where = on?.length ? `mounted now on the ${on.map((h) => HOST_NAME[h]).join(" and ")}` : online ? "not mounted now" : "mounted: unknown (no device online)";
      return `- ${p.id}${title ? ` "${title}"` : ""}: ${where}; last change ${when(p.at)} (seq ${p.seq}); state keys: ${p.keys.length ? p.keys.slice(0, 12).join(", ") + (p.keys.length > 12 ? ", …" : "") : "none"}; log records: ${p.logCount}`;
    });
    blocks.push([`${pages.length} vault page(s)${tv.name ? ` in the vault ${tv.name}` : ""} with state kept on the box (PluginRead {plugin: <path>} reads its state and recent log, open or not):`, ...lines, ...(pages.length > 40 ? [`(and ${pages.length - 40} more)`] : [])].join("\n"));
    return { ok: true, text: blocks.join("\n\n") };
  }
  if (answers.every((r) => !r.ok)) return answers[0] as { ok: false; text: string };
  return { ok: true, text: blocks.join("\n\n") };
}
