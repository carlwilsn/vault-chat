// The self-describing plugin contract (base spec `offers`; reports/07 "the agent reaches every plugin"): a plugin
// declares what it offers, and the agent reaches it through one generic pair of tools, with no tool written per plugin.
//
//   const offers = api.offer({
//     state:   { notes: { description, read: () => data } },                         readable state (selectors)
//     actions: { add:   { description, args: <JSON schema>, run: async (args) => r } }, actions
//     events:  { changed: { description } },                                          events it emits
//   });
//   offers.emit("changed", payload);
//
// Whoever mounts the plugin (src/mountHost.ts: in-process pages, app plugins, vault plugins) registers its offers here
// as an effect of its run, so a stopped or unmounted plugin offers nothing. The box asks the host where plugins are
// mounted (the laptop app) over the Show signal + ack channel: server/pluginOffersTool.ts puts a {type:"plugin", id,
// to:"laptop", op: list | read | act} signal on the feed, src/boxChat.ts hands it to answerPluginSignal below, and the
// ack carries the answer (for an action: its result and the plugin's state read back afterwards). Full trust: no grant.
//
// Nothing a plugin does here can reach the app: a selector or action that throws (or rejects, or never settles) is an
// error result; the plugin keeps running. This module imports nothing from the app.
//
// Plugins reach each other the same way (reports/07 point 6, "plugins compose with each other, not only with the
// agent"): pluginReach(id) is a plugin's api.plugins: list() every live plugin's offers, read(plugin, state?) and
// act(plugin, action, args) with the agent's exact routing and error rules (not mounted: a clear error; a throw, a
// rejection or a hang: an error result; both plugins keep running), and on(plugin, event | "*", fn) to subscribe to
// another plugin's events. A subscription names the plugin by word, so it holds across the other's remounts, and is
// undone when the subscriber stops; events are delivered after the emitter's call returns (a microtask), so a
// subscriber's throw is its own failure, never the emitter's.

export type JsonSchema = Record<string, unknown>;
export type OfferState = { description?: string; read: () => unknown };
export type OfferAction = { description?: string; args?: JsonSchema; run: (args: Record<string, unknown>) => unknown };
export type OfferEvent = { description?: string };
export type Offers = {
  state?: Record<string, OfferState>;
  actions?: Record<string, OfferAction>;
  events?: Record<string, OfferEvent>;
};
export type OffersHandle = { emit(event: string, payload?: unknown): void };

/** What a plugin offers, as plain data (what the agent is shown). */
export type OffersDescription = {
  id: string;
  name: string;
  state: { name: string; description: string }[];
  actions: { name: string; description: string; args: JsonSchema }[];
  events: { name: string; description: string }[];
};
export type OfferEventRecord = { event: string; at: number; payload?: unknown };

type Entry = { id: string; name: string; offers: Offers; events: OfferEventRecord[]; alive: () => boolean };
/** What a subscriber is handed: which plugin emitted, the event, when, its payload. */
export type PluginEvent = { plugin: { id: string; name: string }; event: string; at: number; payload?: unknown };
type Sub = { word: string; event: string; fn: (e: PluginEvent) => void; alive: () => boolean };

/** One registry per app (globalThis, so a module loaded twice shares it). */
const REG_KEY = "__vcPluginOffers";
const SUB_KEY = "__vcPluginOfferSubs";
function registry(): Map<string, Entry[]> {
  const g = globalThis as Record<string, unknown>;
  return ((g[REG_KEY] as Map<string, Entry[]> | undefined) ??= new Map());
}
function subscriptions(): Set<Sub> {
  const g = globalThis as Record<string, unknown>;
  return ((g[SUB_KEY] as Set<Sub> | undefined) ??= new Set());
}

const NAME_RE = /^[A-Za-z][\w.-]{0,63}$/;
const MAX_EVENTS = 20;
/** How long an action or a selector may take before it is an error result. */
export const OFFER_TIMEOUT_MS = 10_000;
/** The ack the box accepts is under 20 000 characters of JSON (server/show.ts ackShow): a result is cut to fit. */
const MAX_RESULT_CHARS = 12_000;

const errText = (e: unknown) => String((e as Error)?.message ?? e ?? "error");

/** Check a declaration; a bad one is refused with every reason (the plugin keeps running without offers). */
export function offersProblems(o: unknown): string[] {
  const out: string[] = [];
  if (!o || typeof o !== "object") return ["offers must be an object {state?, actions?, events?}"];
  const x = o as Offers;
  for (const [kind, map] of [["state", x.state], ["actions", x.actions], ["events", x.events]] as const) {
    if (map === undefined) continue;
    if (!map || typeof map !== "object") {
      out.push(`${kind} must be an object of named entries`);
      continue;
    }
    for (const [n, v] of Object.entries(map)) {
      if (!NAME_RE.test(n)) out.push(`${kind} "${n}": a name is a letter then letters, digits, _ . - (at most 64)`);
      const e = v as Record<string, unknown>;
      if (!e || typeof e !== "object") out.push(`${kind} "${n}" must be an object`);
      else if (kind === "state" && typeof e.read !== "function") out.push(`state "${n}" needs read()`);
      else if (kind === "actions" && typeof e.run !== "function") out.push(`action "${n}" needs run(args)`);
      else if (kind === "actions" && e.args !== undefined && (!e.args || typeof e.args !== "object" || (e.args as JsonSchema).type !== "object")) out.push(`action "${n}": args must be a JSON schema of type "object"`);
    }
  }
  return out;
}

/**
 * Register a mounted plugin's offers. Returns the undo (the host records it as an effect of the run) and the plugin's
 * emit. `alive()` false: the run is over, its offers are gone and its emits do nothing.
 */
export function declareOffers(id: string, name: string, offers: Offers, alive: () => boolean = () => true): { undo: () => void; handle: OffersHandle } {
  const problems = offersProblems(offers);
  if (problems.length) throw new Error(`api.offer refused: ${problems.join("; ")}`);
  const entry: Entry = { id, name, offers, events: [], alive };
  const reg = registry();
  reg.set(id, [...(reg.get(id) ?? []), entry]);
  const undo = () => {
    const list = (reg.get(id) ?? []).filter((e) => e !== entry);
    if (list.length) reg.set(id, list);
    else reg.delete(id);
  };
  const handle: OffersHandle = {
    emit(event, payload) {
      if (!alive() || !(reg.get(id) ?? []).includes(entry)) return;
      if (!offers.events || !Object.prototype.hasOwnProperty.call(offers.events, event)) return;
      const rec: OfferEventRecord = { event: String(event), at: Date.now(), ...(payload === undefined ? {} : { payload: plain(payload) }) };
      entry.events.push(rec);
      if (entry.events.length > MAX_EVENTS) entry.events.splice(0, entry.events.length - MAX_EVENTS);
      deliver(entry, rec);
    },
  };
  return { undo, handle };
}

/** The newest live instance of each plugin. */
function live(): Entry[] {
  const out: Entry[] = [];
  for (const list of registry().values()) {
    const e = [...list].reverse().find((x) => x.alive());
    if (e) out.push(e);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

const EXT = /\.(html?|[jt]sx?|mjs)$/;
/** How well a word names a plugin (its id, its name, app/<word>, a vault file's name): 0 not at all, else a rank. */
function nameRank(e: Pick<Entry, "id" | "name">, word: string): number {
  const w = String(word ?? "").trim().toLowerCase();
  if (!w) return 0;
  if (e.id.toLowerCase() === w) return 4;
  if (e.name.toLowerCase() === w) return 3;
  if (e.id.toLowerCase() === `app/${w}`) return 2;
  if ((e.id.split("/").pop() ?? "").toLowerCase().replace(EXT, "") === w.replace(EXT, "")) return 1;
  return 0;
}

/** The plugin a word names: its id, its name, or a vault page's file name; case-insensitive. */
function find(word: string): Entry | null {
  const all = live();
  for (const rank of [4, 3, 2, 1]) {
    const e = all.find((x) => nameRank(x, word) === rank);
    if (e) return e;
  }
  return null;
}

/** Hand an emitted event to the subscribers that name its plugin, after the emitter's call returns. */
function deliver(e: Entry, rec: OfferEventRecord): void {
  const subs = subscriptions();
  if (!subs.size) return;
  for (const s of subs) {
    if (!s.alive()) {
      subs.delete(s);
      continue;
    }
    if (s.event !== "*" && s.event !== rec.event) continue;
    // The word must name this plugin as find() would: the best-named live plugin, so two plugins never both answer.
    if (!nameRank(e, s.word) || find(s.word) !== e) continue;
    const ev: PluginEvent = { plugin: { id: e.id, name: e.name }, event: rec.event, at: rec.at, ...("payload" in rec ? { payload: rec.payload } : {}) };
    queueMicrotask(() => {
      if (!s.alive() || !subs.has(s)) return;
      try {
        s.fn(ev);
      } catch {
        /* the subscriber's fn is guarded by its own host; nothing reaches the emitter */
      }
    });
  }
}

/** Subscribe to a plugin's events (one event, or "*" for all), by the word that names it; returns off. */
export function subscribeOffers(word: string, event: string, fn: (e: PluginEvent) => void, alive: () => boolean = () => true): () => void {
  if (typeof fn !== "function") throw new Error("on(plugin, event, fn): fn must be a function");
  const w = String(word ?? "").trim();
  if (!w) throw new Error("on(plugin, event, fn): name the plugin (its id or name)");
  const ev = String(event ?? "").trim() || "*";
  const sub: Sub = { word: w, event: ev, fn, alive };
  subscriptions().add(sub);
  return () => void subscriptions().delete(sub);
}

export function describeOffers(e: Pick<Entry, "id" | "name" | "offers">): OffersDescription {
  const o = e.offers;
  return {
    id: e.id,
    name: e.name,
    state: Object.entries(o.state ?? {}).map(([name, s]) => ({ name, description: String(s.description ?? "") })),
    actions: Object.entries(o.actions ?? {}).map(([name, a]) => ({ name, description: String(a.description ?? ""), args: a.args ?? { type: "object", properties: {}, additionalProperties: false } })),
    events: Object.entries(o.events ?? {}).map(([name, v]) => ({ name, description: String(v.description ?? "") })),
  };
}

/** Every live plugin's offers. */
export function listOffers(): OffersDescription[] {
  return live().map(describeOffers);
}

/** Plain JSON data (functions, cycles and the like dropped), so a result always crosses the wire. */
function plain(v: unknown): unknown {
  if (v === undefined) return null;
  try {
    const seen = new WeakSet<object>();
    return JSON.parse(JSON.stringify(v, (_k, x) => {
      if (typeof x === "bigint") return String(x);
      if (typeof x === "function") return undefined;
      if (x && typeof x === "object") {
        if (seen.has(x)) return "[cycle]";
        seen.add(x);
      }
      return x;
    }) ?? "null");
  } catch (e) {
    return `[not plain data: ${errText(e)}]`;
  }
}

/** A minimal JSON-schema check of an action's args (type, required, enum, additionalProperties: false). */
export function argsProblems(schema: JsonSchema | undefined, args: unknown): string[] {
  const a = args ?? {};
  if (typeof a !== "object" || Array.isArray(a)) return ["args must be an object"];
  if (!schema) return [];
  const out: string[] = [];
  const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
  for (const r of (schema.required as string[] | undefined) ?? []) if ((a as Record<string, unknown>)[r] === undefined) out.push(`missing required "${r}"`);
  for (const [k, v] of Object.entries(a as Record<string, unknown>)) {
    const p = props[k];
    if (!p) {
      if (schema.additionalProperties === false) out.push(`unknown arg "${k}" (known: ${Object.keys(props).join(", ") || "none"})`);
      continue;
    }
    const types = ([] as unknown[]).concat(p.type ?? []);
    const okType = !types.length || types.some((t) => {
      switch (t) {
        case "string": return typeof v === "string";
        case "number": return typeof v === "number" && Number.isFinite(v);
        case "integer": return Number.isInteger(v);
        case "boolean": return typeof v === "boolean";
        case "array": return Array.isArray(v);
        case "object": return !!v && typeof v === "object" && !Array.isArray(v);
        case "null": return v === null;
        default: return true;
      }
    });
    if (!okType) out.push(`"${k}" must be ${types.join(" or ")}`);
    else if (Array.isArray(p.enum) && !p.enum.includes(v)) out.push(`"${k}" must be one of ${p.enum.map((x) => JSON.stringify(x)).join(", ")}`);
  }
  return out;
}

/** Run plugin code with a time limit; a throw, a rejection or a timeout is the error, never an exception out. */
async function guarded(what: string, f: () => unknown, ms: number): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      Promise.resolve().then(f),
      new Promise((_r, rej) => (t = setTimeout(() => rej(new Error(`${what} did not answer within ${Math.round(ms / 1000)} s`)), ms))),
    ]);
    return { ok: true, value: plain(value) };
  } catch (e) {
    return { ok: false, error: `${what} threw: ${errText(e)}` };
  } finally {
    if (t) clearTimeout(t);
  }
}

export type OfferAnswer = {
  ok: boolean;
  error?: string;
  /** list */
  plugins?: OffersDescription[];
  /** read / act: which plugin answered */
  plugin?: { id: string; name: string };
  /** read: each selector's value (or its error); act: the state read back after the action */
  state?: Record<string, unknown>;
  /** read: the plugin's recent events */
  events?: OfferEventRecord[];
  /** act: the action's result */
  result?: unknown;
};

const notMounted = (word: string) => {
  const names = live().map((e) => `${e.id} ("${e.name}")`);
  return `no plugin "${word}" is mounted here now, so it offers nothing to read or run (a plugin turned off, or a page that is not open, is not mounted). ${names.length ? `Mounted plugins with offers: ${names.join(", ")}.` : "No mounted plugin declares offers."}`;
};

async function readAll(e: Entry, only: string | undefined, ms: number): Promise<{ state: Record<string, unknown>; errors: string[] }> {
  const state: Record<string, unknown> = {};
  const errors: string[] = [];
  for (const [n, s] of Object.entries(e.offers.state ?? {})) {
    if (only && n !== only) continue;
    const r = await guarded(`state "${n}"`, () => s.read(), ms);
    if (r.ok) state[n] = r.value;
    else {
      state[n] = { error: r.error };
      errors.push(r.error);
    }
  }
  return { state, errors };
}

/** Read one plugin's state: every selector (or the one named) and its recent events. */
export async function readOffers(word: string, selector?: string, ms = OFFER_TIMEOUT_MS): Promise<OfferAnswer> {
  const e = find(word);
  if (!e) return { ok: false, error: notMounted(word) };
  const sel = selector ? String(selector) : undefined;
  if (sel && !Object.prototype.hasOwnProperty.call(e.offers.state ?? {}, sel)) {
    return { ok: false, plugin: { id: e.id, name: e.name }, error: `${e.id} has no state "${sel}" (it offers: ${Object.keys(e.offers.state ?? {}).join(", ") || "no state"}).` };
  }
  const { state, errors } = await readAll(e, sel, ms);
  return { ok: errors.length === 0, plugin: { id: e.id, name: e.name }, state, events: [...e.events], ...(errors.length ? { error: errors.join("; ") } : {}) };
}

/** Run one plugin action with its args, then read its state back. */
export async function actOffers(word: string, action: string, args: Record<string, unknown> | undefined, ms = OFFER_TIMEOUT_MS): Promise<OfferAnswer> {
  const e = find(word);
  if (!e) return { ok: false, error: notMounted(word) };
  const plugin = { id: e.id, name: e.name };
  const name = String(action ?? "");
  const a = (e.offers.actions ?? {})[name];
  if (!a || !Object.prototype.hasOwnProperty.call(e.offers.actions ?? {}, name)) {
    return { ok: false, plugin, error: `${e.id} has no action "${name}" (it offers: ${Object.keys(e.offers.actions ?? {}).join(", ") || "no actions"}).` };
  }
  const bad = argsProblems(a.args, args);
  if (bad.length) return { ok: false, plugin, error: `${e.id} ${name}: ${bad.join("; ")}. Nothing was run.` };
  const r = await guarded(`action "${name}"`, () => a.run({ ...(args ?? {}) }), ms);
  // The read-back: what the plugin's state is now, whatever the action said.
  const back = e.alive() ? (await readAll(e, undefined, ms)).state : {};
  if (!r.ok) return { ok: false, plugin, error: `${e.id} ${r.error}. The plugin is still running.`, state: back };
  return { ok: true, plugin, result: r.value, state: back };
}

// ---------------------------------------------------------------- plugin to plugin

/** A plugin's reach into the other plugins (its api.plugins): the agent's PluginRead / PluginAct, from inside the app. */
export type PluginReach = {
  /** Every live plugin and what it offers (this one included). */
  list(): OffersDescription[];
  /** A plugin's state (every selector, or the one named) and its recent events. Never rejects: an error is the answer. */
  read(plugin: string, state?: string): Promise<OfferAnswer>;
  /** Run a plugin's action with its args (checked against its schema); the result and its state read back. Never rejects. */
  act(plugin: string, action: string, args?: Record<string, unknown>): Promise<OfferAnswer>;
  /** Subscribe to a plugin's event (or "*": every event it emits). Holds across its remounts; returns off. */
  on(plugin: string, event: string, fn: (e: PluginEvent) => void): () => void;
};

const STOPPED: OfferAnswer = { ok: false, error: "this plugin has stopped, so it can no longer reach other plugins" };

/**
 * The api.plugins of one run. `alive()` false: the run is over (calls answer that it stopped, subscriptions end);
 * `track(off)` records a subscription as an effect of the run; `guard` wraps the subscriber's fn (its throw is its
 * own failure). `ms`: how long another plugin's action or selector may take.
 */
export function pluginReach(alive: () => boolean, track: (off: () => void) => () => void = (off) => off, guard: <A extends unknown[]>(f: (...a: A) => void) => (...a: A) => void = (f) => f, ms = OFFER_TIMEOUT_MS): PluginReach {
  return {
    list: () => (alive() ? listOffers() : []),
    read: async (plugin, state) => (alive() ? readOffers(String(plugin ?? ""), typeof state === "string" && state ? state : undefined, ms) : STOPPED),
    act: async (plugin, action, args) => {
      if (!alive()) return STOPPED;
      if (args !== undefined && (args === null || typeof args !== "object" || Array.isArray(args))) return { ok: false, error: "args must be an object. Nothing was run." };
      return actOffers(String(plugin ?? ""), String(action ?? ""), args ?? {}, ms);
    },
    on(plugin, event, fn) {
      if (!alive()) return () => {};
      return track(subscribeOffers(plugin, event, guard(fn), alive));
    },
  };
}

// ---------------------------------------------------------------- the host's half of the box's signal

export type PluginSignal = { type: "plugin"; id: string; to?: string; op?: unknown; plugin?: unknown; state?: unknown; action?: unknown; args?: unknown };
export type PluginAck = { ok: boolean; landed?: string; error?: string; data?: { answer: string } };

/** Fit an answer into the ack (a long one is cut, and says so). */
export function packAnswer(a: OfferAnswer): string {
  const s = JSON.stringify(a);
  if (s.length <= MAX_RESULT_CHARS) return s;
  const cut = { ...a, state: undefined, result: undefined, events: undefined, plugins: a.plugins?.slice(0, 20), truncated: `the answer was ${s.length} characters; shown cut`, cutText: s.slice(0, MAX_RESULT_CHARS - 600) };
  return JSON.stringify(cut);
}

/** What the host does with a {type:"plugin"} signal: answer it from the live registry. Never throws. */
export async function answerPluginSignal(sig: PluginSignal): Promise<PluginAck> {
  let a: OfferAnswer;
  try {
    const op = String(sig.op ?? "");
    if (op === "list") a = { ok: true, plugins: listOffers() };
    else if (op === "read") a = await readOffers(String(sig.plugin ?? ""), typeof sig.state === "string" && sig.state ? sig.state : undefined);
    else if (op === "act") a = await actOffers(String(sig.plugin ?? ""), String(sig.action ?? ""), sig.args && typeof sig.args === "object" ? (sig.args as Record<string, unknown>) : {});
    else a = { ok: false, error: `unknown plugin op "${op}" (list, read, act)` };
  } catch (e) {
    a = { ok: false, error: `the host could not answer: ${errText(e)}` };
  }
  return { ok: a.ok, ...(a.error ? { error: a.error.slice(0, 1100) } : {}), data: { answer: packAnswer(a) } };
}

/** Tests: forget every declaration. */
export function _resetOffers(): void {
  registry().clear();
  subscriptions().clear();
}
