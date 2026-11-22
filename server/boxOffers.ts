// The box's own state as offers (Native agency: one read / change / watch for everything, with or without a device).
// The laptop's and phone's parts declare offers in the app (src/pluginOffers.ts) and answer only while that app is
// online. What lives on the box — the settings, the notes, the jobs, the device links, the logs — was reachable only
// through one-off tools or Bash, and not at all as "state". Here it is offers of the same shape, answered by the box
// itself: PluginRead {plugin: "box:settings"} reads, PluginAct {plugin: "box:notes", action: "add", args} changes,
// PluginRead {plugin, wait} watches (the box re-reads the state until it changes). A device being off changes nothing.
//
// Secrets are never state: settings hold none (the key store is not reachable here), and log lines pass through
// `redact` before they leave this file.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { OffersDescription } from "../src/pluginOffers";
import { linkStates } from "./deviceLink";
import { noun, nouns, type Noun } from "./model";

export type JsonSchema = Record<string, unknown>;
type State = { description: string; read: () => unknown | Promise<unknown> };
type Action = { description: string; args?: JsonSchema; run: (args: Record<string, unknown>) => Promise<{ ok: boolean; text: string }> | { ok: boolean; text: string } };
export type BoxOffer = { id: string; name: string; state: Record<string, State>; actions: Record<string, Action> };

export type BoxOfferDeps = {
  vault: string;
  /** The feed to the devices (box:workspace asks the laptop over it), and how long it has to answer. */
  emit?: (ev: Record<string, unknown>) => void;
  ackMs?: number;
  /** The box's state dir (its logs live in <stateDir>/logs). */
  stateDir?: string;
  /** The jobs and workers of the asking conversation, as JobList says them. */
  jobs?: () => string;
  /** Every registered vault's path (box:history searches all their logs). */
  vaults?: () => string[];
};

export const BOX_PREFIX = "box:";
export const isBoxWord = (w: string) => w.trim().toLowerCase().startsWith(BOX_PREFIX);

/** Anything that looks like a credential, cut out of text that leaves the box's own files. */
export function redact(s: string): string {
  return s
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|sk_[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9]{10,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{12,})/g, "[secret]")
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[secret]")
    .replace(/((?:token|secret|password|api[_-]?key|authorization)["']?\s*[:=]\s*["']?)[^"'\s,}]{6,}/gi, "$1[secret]");
}

const LOGS = ["turns", "app", "voice", "board"] as const;
const LOG_LINES = 15;

function tail(file: string, n: number): string[] {
  if (!existsSync(file)) return [];
  try {
    const text = readFileSync(file, "utf8");
    return text.split("\n").filter(Boolean).slice(-n).map((l) => redact(l.length > 400 ? `${l.slice(0, 400)}…` : l));
  } catch {
    return [];
  }
}

const obj = (props: Record<string, unknown>, required: string[] = []): JsonSchema => ({ type: "object", properties: props, required, additionalProperties: false });
const str = (description: string) => ({ type: "string", description });

/** The box's offers, now. */
export function boxOffers(d: BoxOfferDeps): BoxOffer[] {
  const out: BoxOffer[] = [
    // The nouns moved into the model (server/model/): each is a box offer of the same name.
    ...nouns({ vault: d.vault, emit: d.emit, ackMs: d.ackMs }).map(nounOffer),
    {
      id: "box:links",
      name: "Devices",
      state: {
        devices: { description: "each device app's link to the box: up or down since when and why, the vault it has open, unanswered requests", read: () => linkStates() },
      },
      actions: {},
    },
  ];
  const logs = () => (d.vaults?.() ?? [d.vault]).concat(d.vault);
  out.push({
    id: "box:history",
    name: "History",
    state: {
      recent: {
        description: "the newest 30 things Carl did in the app's parts (offer events: opened a file, switched chat, …), kept in the event log; (before: …) is what that part's state was before it, to put it back by hand",
        read: async () => (await import("./offerLog")).searchOfferEvents(logs(), { limit: 30 }).map(line),
      },
    },
    actions: {
      search: {
        description: "search that history, as far back as it goes: every word of query in the part, event or its details; plugin narrows to one part; days limits how far back",
        args: obj({ query: str("words that must all appear"), plugin: str("a part, e.g. app/viewer"), days: { type: "number" }, limit: { type: "number" } }),
        run: async (a) => {
          const hits = (await import("./offerLog")).searchOfferEvents(logs(), { query: a.query as string, plugin: a.plugin as string, days: Number(a.days) || undefined, limit: Number(a.limit) || undefined });
          return { ok: true, text: hits.length ? hits.map(line).join("\n") : "nothing matches" };
        },
      },
    },
  });
  if (d.stateDir) {
    const sd = d.stateDir;
    out.push({
      id: "box:queue",
      name: "Queue",
      state: {
        pending: { description: "device actions kept while the device is away (PluginAct whenBack), run when its app is back", read: async () => (await import("./deviceQueue")).queueState(sd).pending },
        done: { description: "the last ones run, expired or cancelled, with what happened", read: async () => (await import("./deviceQueue")).queueState(sd).done.slice(-10) },
      },
      actions: {
        cancel: { description: "drop a kept action before it runs", args: obj({ id: str("its id (q-…)") }, ["id"]), run: async (a) => (await import("./deviceQueue")).cancelQueued(sd, String(a.id)) },
      },
    });
  }
  if (d.stateDir) {
    const sd = d.stateDir;
    out.push({
      id: "box:perf",
      name: "Perf",
      state: {
        builds: { description: "the laptop app's speed per build from Carl's own use (the app's perf probe), newest first: median/p95 ms per metric/method (composer-key, ctrl-k-key, fullscreen-transition, chat-panel-open, launch-interactive, file-open, long tasks; docs/perf-baseline.md)", read: async () => (await import("./perfLog")).perfBuilds(sd) },
        launch: { description: "the last launch-to-interactive the laptop app reported", read: async () => (await import("./perfLog")).perfLaunch(sd) },
      },
      actions: {
        compare: {
          description: "compare two builds' speeds (default: the newest against the one before it), or the newest against a perf-baseline.mjs record file; flags a median/p95 worse than the margin",
          args: obj({ from: str("the older build's revision prefix"), to: str("the newer build's revision prefix"), baseline: str("path on the box to a perf-baseline.mjs record JSON (instead of from)"), marginPct: { type: "number" }, marginMs: { type: "number" } }),
          run: async (a) => (await import("./perfLog")).perfCompare(sd, a as never),
        },
      },
    });
  }
  if (d.jobs) out.push({ id: "box:jobs", name: "Jobs", state: { list: { description: "this conversation's background workers and shell jobs (JobStop / JobSteer act on them)", read: () => d.jobs!() } }, actions: {} });
  if (d.stateDir) {
    const dir = join(d.stateDir, "logs");
    out.push({
      id: "box:logs",
      name: "Logs",
      state: Object.fromEntries(LOGS.map((l) => [l, { description: `the newest ${LOG_LINES} lines of the box's ${l} log (credentials cut out)`, read: () => tail(join(dir, `${l}.jsonl`), LOG_LINES) }])),
      actions: {},
    });
  }
  return out;
}

const noArgs = obj({});

/** A model noun as a box offer: its state, and its actions run by the agent. */
function nounOffer(n: Noun): BoxOffer {
  return { id: `${BOX_PREFIX}${n.id}`, name: n.name, state: n.state, actions: Object.fromEntries(Object.entries(n.actions).map(([k, a]) => [k, { description: a.description, args: a.args, run: (args: Record<string, unknown>) => a.run(args, "agent") }])) };
}

/** One history record as a line Carl could read. */
function line(r: { at: number; device: string; plugin: string; event: string; payload?: string; before?: string }): string {
  return `${new Date(r.at).toISOString().slice(0, 16).replace("T", " ")} ${r.device} ${r.plugin} ${r.event}${r.payload ? ` ${r.payload}` : ""}${r.before ? ` (before: ${r.before})` : ""}`;
}

export function describeBoxOffer(o: BoxOffer): OffersDescription {
  return {
    id: o.id,
    name: o.name,
    state: Object.entries(o.state).map(([name, s]) => ({ name, description: s.description })),
    actions: Object.entries(o.actions).map(([name, a]) => ({ name, description: a.description, args: (a.args ?? noArgs) as never })),
    events: [],
  };
}

function find(d: BoxOfferDeps, word: string): BoxOffer | null {
  const w = word.trim().toLowerCase();
  return boxOffers(d).find((o) => o.id === w || `${BOX_PREFIX}${o.name.toLowerCase()}` === w) ?? null;
}

const known = (d: BoxOfferDeps) => boxOffers(d).map((o) => o.id).join(", ");

/** Read a box offer's state (all of it, or one selector). */
export async function readBoxOffer(d: BoxOfferDeps, word: string, only?: string): Promise<{ ok: boolean; id?: string; state?: Record<string, unknown>; error?: string }> {
  const o = find(d, word);
  if (!o) return { ok: false, error: `no box state "${word}" (the box offers: ${known(d)})` };
  if (only && !(only in o.state)) return { ok: false, id: o.id, error: `${o.id} has no state "${only}" (it offers: ${Object.keys(o.state).join(", ")})` };
  const state: Record<string, unknown> = {};
  for (const [k, s] of Object.entries(o.state)) {
    if (only && k !== only) continue;
    try {
      state[k] = await s.read();
    } catch (e) {
      state[k] = { error: (e as Error)?.message ?? String(e) };
    }
  }
  return { ok: true, id: o.id, state };
}

/** Wait (at most `ms`) for a box offer's state to differ from what it is now; then its state. */
export async function watchBoxOffer(d: BoxOfferDeps, word: string, ms: number, only?: string, everyMs = 500): Promise<{ ok: boolean; id?: string; state?: Record<string, unknown>; error?: string; changed?: boolean }> {
  // A model noun says when it changes (listened to before the first read, so no change is missed): no re-reading.
  const o = find(d, word);
  const n = o ? noun(o.id.slice(BOX_PREFIX.length), { vault: d.vault }) : null;
  let hits = 0;
  let wake: (() => void) | null = null;
  const off = n ? n.watch(() => (hits++, wake?.())) : () => {};
  try {
    const first = await readBoxOffer(d, word, only);
    if (!first.ok) return first;
    const was = JSON.stringify(first.state);
    const end = Date.now() + Math.max(0, Math.min(ms, 25_000));
    while (Date.now() < end) {
      if (n) {
        if (!hits) await new Promise<void>((r) => ((wake = r), setTimeout(r, Math.max(1, end - Date.now()))));
        wake = null;
        if (!hits) break;
        hits = 0;
      } else await new Promise((r) => setTimeout(r, Math.min(everyMs, Math.max(1, end - Date.now()))));
      const now = await readBoxOffer(d, word, only);
      if (now.ok && JSON.stringify(now.state) !== was) return { ...now, changed: true };
    }
    return { ...first, changed: false };
  } finally {
    off();
  }
}

/** Run a box offer's action. */
export async function actBoxOffer(d: BoxOfferDeps, word: string, action: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string; state?: Record<string, unknown> }> {
  const o = find(d, word);
  if (!o) return { ok: false, text: `no box state "${word}" (the box offers: ${known(d)})` };
  const a = o.actions[action];
  if (!a) return { ok: false, text: `${o.id} has no action "${action}" (it offers: ${Object.keys(o.actions).join(", ") || "no actions: it is read-only"})` };
  const schema = (a.args ?? noArgs) as { properties?: Record<string, unknown>; required?: string[] };
  const missing = (schema.required ?? []).filter((k) => !(k in args));
  const extra = Object.keys(args).filter((k) => !(k in (schema.properties ?? {})));
  if (missing.length || extra.length) return { ok: false, text: `${o.id} ${action}: ${missing.length ? `needs ${missing.join(", ")}` : ""}${missing.length && extra.length ? "; " : ""}${extra.length ? `does not take ${extra.join(", ")}` : ""}. Nothing was run.` };
  let r: { ok: boolean; text: string };
  try {
    r = await a.run(args);
  } catch (e) {
    r = { ok: false, text: (e as Error)?.message ?? String(e) };
  }
  const back = await readBoxOffer(d, o.id);
  return { ...r, ...(back.state ? { state: back.state } : {}) };
}
