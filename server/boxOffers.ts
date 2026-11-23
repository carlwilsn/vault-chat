// The box's own state as offers (Native agency: one read / change / watch for everything, with or without a device).
// The laptop's and phone's parts declare offers in the app (src/pluginOffers.ts) and answer only while that app is
// online. What lives on the box — the settings, the notes, the jobs, the device links, the logs — was reachable only
// through one-off tools or Bash, and not at all as "state". Here it is offers of the same shape, answered by the box
// itself: PluginRead {plugin: "box:settings"} reads, PluginAct {plugin: "box:notes", action: "add", args} changes,
// PluginRead {plugin, wait} watches: each offer says when it changes (its `watch`, a real event: a noun's own listener,
// a device link coming up or going down, the queue or perf file written, a log file growing), and only then is it
// read again. No offer is re-read on a timer. A device being off changes nothing.
//
// Secrets are never state: settings hold none (the key store is not reachable here), and log lines pass through
// `redact` before they leave this file.
import { readFileSync, existsSync, mkdirSync, watch as fsWatch } from "node:fs";
import { join } from "node:path";
import type { OffersDescription } from "../src/pluginOffers";
import { linkStates, onLinkChanged } from "./deviceLink";
import { signal } from "./convlog/log";
import { boxTerminals, closeBoxTerminal, watchBoxTerminals } from "./boxTerminals";
import { nouns, type Noun } from "./model";
import type { ChatsCtl } from "./model/chats";
import type { JobsCtl } from "./model/jobs";

export type JsonSchema = Record<string, unknown>;
type State = { description: string; read: () => unknown | Promise<unknown> };
type Action = { description: string; args?: JsonSchema; /** A search: nothing changes, so no state is read back. */ readOnly?: boolean; run: (args: Record<string, unknown>) => Promise<{ ok: boolean; text: string }> | { ok: boolean; text: string } };
/** Call `fn` each time the offer's state may have changed (a real event, never a timer); returns the unsubscribe. */
export type Watch = (fn: () => void) => () => void;
export type BoxOffer = { id: string; name: string; state: Record<string, State>; actions: Record<string, Action>; watch: Watch };

export type BoxOfferDeps = {
  vault: string;
  /** The feed to the devices (box:workspace asks the laptop over it), and how long it has to answer. */
  emit?: (ev: Record<string, unknown>) => void;
  ackMs?: number;
  /** The box's state dir (its logs live in <stateDir>/logs). */
  stateDir?: string;
  /** The asking conversation's workers and jobs (box:jobs, server/model/jobs.ts). */
  jobs?: JobsCtl;
  /** Carl's chats and projects (box:chats, server/model/chats.ts). */
  chats?: ChatsCtl;
  /** Every registered vault's path (box:history searches all their logs). */
  vaults?: () => string[];
  /** The asking conversation (box:history's transcript search defaults to it). */
  conv?: string;
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
    ...nouns({ vault: d.vault, emit: d.emit, ackMs: d.ackMs, vaults: d.vaults, conv: d.conv, jobs: d.jobs, chats: d.chats }).map(nounOffer),
    {
      id: "box:links",
      name: "Devices",
      state: {
        devices: { description: "each device app's link to the box: up or down since when and why, the vault it has open, unanswered requests, what the phone shows (view)", read: () => linkStates() },
        terminals: { description: "the box terminals open now (the title bar's terminal / Ctrl+J: an SSH session into the box): pid, user, tty, since", read: () => boxTerminals() },
      },
      actions: {
        closeTerminal: {
          description: "close a box terminal (its session hangs up, as closing its window), by its tty from terminals. Only when Carl asks",
          args: obj({ tty: str("e.g. pts/3") }, ["tty"]),
          run: (a) => closeBoxTerminal(String(a.tty ?? "")),
        },
        showOnPhone: {
          description: "switch the phone app to a page (alerts or notes), as its menu does; it follows the next time its feed answers (it must be open)",
          args: obj({ page: { type: "string", enum: ["alerts", "notes"] } }, ["page"]),
          run: (a) => {
            if (linkStates().phone.control !== "up") return { ok: false, text: "The phone app is not open (its feed is down); nothing was shown." };
            signal(d.vault, { type: "phone.page", page: a.page === "notes" ? "notes" : "alerts" });
            return { ok: true, text: `The phone shows ${a.page === "notes" ? "Notes" : "Alerts"}.` };
          },
        },
      },
      watch: (fn) => {
        const a = onLinkChanged(fn);
        const b = watchBoxTerminals(fn);
        return () => (a(), b());
      },
    },
  ];
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
      watch: lazyWatch(async () => (await import("./deviceQueue")).onQueueChanged),
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
      watch: lazyWatch(async () => (await import("./perfLog")).onPerfChanged),
    });
  }
  if (d.stateDir) {
    const dir = join(d.stateDir, "logs");
    out.push({
      id: "box:logs",
      name: "Logs",
      state: Object.fromEntries(LOGS.map((l) => [l, { description: `the newest ${LOG_LINES} lines of the box's ${l} log (credentials cut out)`, read: () => tail(join(dir, `${l}.jsonl`), LOG_LINES) }])),
      actions: {},
      watch: (fn) => watchLogs(dir, fn),
    });
  }
  return out;
}

const noArgs = obj({});

/** A watch whose listener lives in a module loaded on first use. */
function lazyWatch(get: () => Promise<Watch>): Watch {
  return (fn) => {
    let off = () => {};
    let done = false;
    void get().then((w) => {
      if (!done) off = w(fn);
    });
    return () => ((done = true), off());
  };
}

/** The logs dir's files growing (the OS's file events): one of the four logs changed. */
function watchLogs(dir: string, fn: () => void): () => void {
  try {
    mkdirSync(dir, { recursive: true });
    const w = fsWatch(dir, (_ev, f) => {
      if (!f || LOGS.some((l) => String(f).startsWith(`${l}.jsonl`))) fn();
    });
    w.on("error", () => {});
    return () => w.close();
  } catch {
    return () => {};
  }
}

/** A model noun as a box offer: its state, and its actions run by the agent. */
function nounOffer(n: Noun): BoxOffer {
  return { id: `${BOX_PREFIX}${n.id}`, name: n.name, state: n.state, watch: n.watch, actions: Object.fromEntries(Object.entries(n.actions).map(([k, a]) => [k, { description: a.description, args: a.args, readOnly: a.readOnly, run: (args: Record<string, unknown>) => a.run(args, "agent") }])) };
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

/** Wait (at most `ms`) for a box offer's state to differ from what it is now; then its state. Read again only when its
 *  watch fires (listened to before the first read, so no change is missed). */
export async function watchBoxOffer(d: BoxOfferDeps, word: string, ms: number, only?: string): Promise<{ ok: boolean; id?: string; state?: Record<string, unknown>; error?: string; changed?: boolean }> {
  const o = find(d, word);
  if (!o) return readBoxOffer(d, word, only);
  let hits = 0;
  let wake: (() => void) | null = null;
  const off = o.watch(() => (hits++, wake?.()));
  try {
    const first = await readBoxOffer(d, word, only);
    if (!first.ok) return first;
    const was = JSON.stringify(first.state);
    const end = Date.now() + Math.max(0, Math.min(ms, 25_000));
    while (Date.now() < end) {
      if (!hits) await new Promise<void>((r) => ((wake = r), setTimeout(r, Math.max(1, end - Date.now()))));
      wake = null;
      if (!hits) break;
      hits = 0;
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
  if (a.readOnly) return r;
  const back = await readBoxOffer(d, o.id);
  return { ...r, ...(back.state ? { state: back.state } : {}) };
}
