// The agent's reach into every plugin (reports/07 "the agent reaches every plugin", spec field `offers`): one generic
// pair of tools over what each mounted plugin declares with api.offer (src/pluginOffers.ts): its readable state, its
// actions (name, description, JSON-schema args) and its events. No tool is written per plugin: a plugin that declares
// offers is reachable the moment it mounts, and gone when it stops.
//
//   PluginRead  {}                      every live plugin and what it offers
//               {plugin, state?}        its state (every selector, or one) and its recent events
//   PluginAct   {plugin, action, args}  run an action; the answer is its result and the plugin's state read back
//
// Plugins are mounted in the hosts: the laptop app and the phone app (phone/src/plugins.ts), so the call rides Show's
// channel (server/show.ts): a {type:"plugin", id, to: "laptop" | "phone", op, ...} signal on the vault's feed, answered
// by src/pluginOffers.ts answerPluginSignal (src/boxChat.ts on the laptop, phone/src/boot.ts on the phone), acked over
// POST /api/v1/show/<id>/ack. `device` names the host; left out, a list asks every host that is online and a read or
// an action goes to the laptop (the phone when only it is online). The result is only ever that ack, or an honest
// "offline" / "didn't answer". Full trust: no grant.
import { randomBytes } from "node:crypto";
import { feedLive, waitAck, type Device } from "./show";
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
      "No plugin: lists every live plugin with its offers (use it first to learn a plugin's actions and args). plugin (its id, e.g. app/notes, or its name): reads its state (all of it, or the one `state` named) and its recent events, from the screen now. " +
      "app/context holds what Carl has selected, hovers and is focused in now. Use it to see a plugin's state or before PluginAct. Plugins run on the laptop app and on the phone app (device: \"laptop\" or \"phone\"; left out: a list covers every device online, a read goes to the laptop, else the phone). Only plugins mounted there now are reachable; a plugin that is off or not open says so. What no plugin offers, Act does in his real laptop window.",
    inputSchema: {
      type: "object",
      properties: {
        plugin: { type: "string", description: "The plugin's id or name; left out: list every live plugin and what it offers." },
        state: { type: "string", description: "One state name to read (default: all of it)." },
        device: { type: "string", enum: ["laptop", "phone"], description: "Which host: the laptop app or the phone app (default: every device online for a list; the laptop, else the phone, for a read)." },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function" as const,
    name: PLUGIN_ACT,
    description:
      "Run an action a live plugin offers (see PluginRead for its actions and their args), e.g. {plugin: \"app/notes\", action: \"view\", args: {filter: \"resolved\"}}. " +
      "Returns the action's result and the plugin's state read back afterwards: tell Carl only what that says. A failing action is an error result; the plugin keeps running.",
    inputSchema: {
      type: "object",
      properties: {
        plugin: { type: "string", description: "The plugin's id or name." },
        action: { type: "string", description: "One of the actions it offers." },
        args: { type: "object", description: "The action's args, as its schema says." },
        device: { type: "string", enum: ["laptop", "phone"], description: "Which host runs it: the laptop app (default) or the phone app (PluginRead lists each device's plugins)." },
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

const HOSTS = ["laptop", "phone"] as const;
type Host = (typeof HOSTS)[number];
const HOST_NAME: Record<Host, string> = { laptop: "laptop", phone: "phone" };

type Asked = { ok: false; text: string } | { ok: true; answer: OfferAnswer; error?: string };

/** The hosts a call goes to: the one named, else (list) every one online, else (read / act) the laptop, then the phone. */
function hostsFor(d: PluginOfferDeps, device: unknown, all: boolean): { hosts: Host[] } | { error: string } {
  if (device !== undefined && device !== null && device !== "") {
    const w = String(device).trim().toLowerCase();
    if (!(HOSTS as readonly string[]).includes(w)) return { error: `device is "laptop" or "phone", not "${String(device)}". Nothing was asked.` };
    return { hosts: [w as Host] };
  }
  const live = HOSTS.filter((h) => feedLive(d.vault, h as Device));
  if (!live.length) return { hosts: ["laptop"] };
  return { hosts: all ? live : [live[0]!] };
}

async function ask(d: PluginOfferDeps, host: Host, body: Record<string, unknown>): Promise<Asked> {
  if (!feedLive(d.vault, host as Device)) {
    return host === "laptop"
      ? { ok: false, text: "The laptop isn't online (the vault-chat app isn't open and connected on it), and that is where plugins are mounted, so none can be read or run now. Say so; don't guess." }
      : { ok: false, text: "The phone isn't online (the vault-chat phone app isn't open on it), so its plugins can't be read or run now. Say so; don't guess." };
  }
  const where = HOST_NAME[host];
  const id = `plugin-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  const ms = d.ackMs ?? 20_000;
  const got = waitAck(id, ms);
  d.emit({ type: "plugin", id, to: host, ...body });
  const ack = await got;
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

export async function pluginOfferTool(d: PluginOfferDeps, name: string, a: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
  const plugin = typeof a.plugin === "string" ? a.plugin.trim() : "";
  if (name === PLUGIN_READ) {
    const to = hostsFor(d, a.device, !plugin);
    if ("error" in to) return { ok: false, text: to.error };
    if (!plugin) {
      const answers = await Promise.all(to.hosts.map((h) => ask(d, h, { op: "list" })));
      if (answers.every((r) => !r.ok)) return answers[0] as { ok: false; text: string };
      const blocks: string[] = [];
      to.hosts.forEach((h, i) => {
        const r = answers[i]!;
        if (!r.ok) return void blocks.push(`On the ${HOST_NAME[h]}: ${r.text}`);
        const ps = r.answer.plugins ?? [];
        blocks.push(ps.length ? [`${ps.length} live plugin(s) on the ${HOST_NAME[h]} and what each offers (PluginRead {plugin, device} reads state; PluginAct {plugin, action, args, device} runs an action):`, ...ps.map(offersText)].join("\n") : `No plugin mounted on the ${HOST_NAME[h]} declares offers right now.`);
      });
      return { ok: true, text: blocks.join("\n\n") };
    }
    const host = to.hosts[0]!;
    const r = await ask(d, host, { op: "read", plugin, ...(typeof a.state === "string" && a.state.trim() ? { state: a.state.trim() } : {}) });
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
    const r = await ask(d, host, { op: "act", plugin, action, args: a.args ?? {} });
    if (!r.ok) return r;
    const x = r.answer;
    const who = `${x.plugin ? x.plugin.id : plugin}${host === "laptop" ? "" : ` (${HOST_NAME[host]})`}`;
    const back = x.state && Object.keys(x.state).length ? [`state read back: ${json(x.state)}`] : [];
    if (!x.ok) return { ok: false, text: [`${who} ${action}: Error: ${x.error}`, ...back].join("\n") };
    return { ok: true, text: [`${who} ${action}: done.`, `result: ${json(x.result)}`, ...back].join("\n") };
  }
  return { ok: false, text: `unknown plugin tool ${name}` };
}
