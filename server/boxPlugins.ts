// Box plugins (reports/07 corrected model, point 4: change by asking, for the box's own behaviour). A box plugin is a
// server-side module in the vault, .vault-chat/box-plugins/<name>.js (id box/<name>), that the running box loads live:
// no build, no release, no restart. It goes through Change ready like any plugin (src/pluginDrafts.ts): the agent writes
// <name>.draft.js, Carl Tries it, then Keeps or Discards it (one plugin.change record; server/pluginDrafts.ts moves the
// files), and Switch back is the undo.
//
// Why plugins and not a draft server (a second box build on a spare slot): the box has one log writer (server/owner.ts),
// so a draft server could only serve a copy of the data and Carl's real work would not land in it, and starting builds
// from branches and promoting them is shipping machinery. A box plugin runs inside the one live server, beside the data.
//
// The module: `export function activate(box)` (or a default export), returning an optional cleanup. `box`:
//   box.route(method, path, handler)  GET | POST /api/v2/box/<name><path> ("/x", or "/x/*" for a prefix); handler(req)
//                                     with {method, path, query, body, tried} answers JSON (box.reply(status, body) for
//                                     another status). Reached by Carl's devices, the agent over loopback, and a live
//                                     page granted `box` (vc.fetch("/api/v2/box/<name>/…")).
//   box.onRecord(fn)                  every record the vault's log writes (read-only).
//   box.every(ms, fn)                 a timer (at least 1 s).
//   box.readFile(rel)                 a vault file's text (null when missing or outside the vault).
//   box.state.get(key?) / set(k, v)   its own state, plugin.state records of box/<name> in the one log (a tried
//                                     draft's set is logged, not written).
//   box.log(...)                      a line in the box's journal and the plugin's status.
// Everything it registers is undone in reverse order when it unloads (a Keep, Discard, Switch back, turned off).
//
// Which copy runs: the one the records say (chooseCopy), loaded once per version. A draft waiting for Carl runs only for
// the requests that try it (header x-vc-try: <version>, or ?vc-try=<version>; the laptop's windows send it while Carl
// tries it, src/liveBridge.ts), never for anyone else, and it cannot write: its state.set refuses ("Try never changes
// box data until Keep"). A tried draft that fails to load, throws, or answers slower than BOX_SLOW_MS discards itself (a
// discard record by "auto"); a kept copy that does so within KEEP_WATCH_MS switches back by itself (a switch by "auto").
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { BOX_PLUGIN_DIR, boxSlot, chooseCopy, draftPending, draftWhat, slotFileOf, versionOf, watchedKeep, type CopyKind } from "../src/pluginDrafts";
import { signalLog } from "./convlog/log";
import type { LogRecord } from "../src/convlog/protocol";
import { slotCode } from "./pluginDrafts";
import { pluginDesired, setPluginChange, supervisorOf } from "./supervisor";
import { readPluginState, setPluginState } from "./pluginState";

/** A handler (or a hook) slower than this counts as a failure of a tried draft or a watched keep. */
export const BOX_SLOW_MS = 2_000;
/** A handler still running after this is answered 504 (and counts as slow). */
export const BOX_HANDLER_MS = 10_000;
/** activate() must finish within this. */
const ACTIVATE_MS = 5_000;
/** A box plugin's code at most this big. */
const MAX_BYTES = 512 * 1024;

export type BoxRequest = { method: "GET" | "POST"; path: string; query: Record<string, string>; body: unknown; tried: boolean };
type Handler = (req: BoxRequest) => unknown;
const REPLY = Symbol.for("vc.box.reply");
type Reply = { [REPLY]: true; status: number; body: unknown };

type Instance = {
  name: string;
  version: string;
  kind: CopyKind;
  draft: boolean;
  routes: Map<string, Handler>;
  undo: (() => void)[];
  error: string | null;
  /** It failed once already: what follows is only logged (a hook that keeps throwing writes one record, not many). */
  failedOnce: boolean;
  lines: string[];
  ready: Promise<void>;
  stopped: boolean;
};

type Plugin = { live: Instance | null; draft: Instance | null };
type Runtime = { vault: string; plugins: Map<string, Plugin>; chain: Promise<void> };
const runtimes = new Map<string, Runtime>();

function runtimeOf(vault: string): Runtime {
  let r = runtimes.get(vault);
  if (!r) runtimes.set(vault, (r = { vault, plugins: new Map(), chain: Promise.resolve() }));
  return r;
}

const msg = (e: unknown) => String((e as Error)?.message ?? e).split("\n")[0]!.slice(0, 300);

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((ok, no) => {
    const t = setTimeout(() => no(new Error(`${what} took over ${ms} ms`)), ms);
    t.unref?.();
    p.then((v) => (clearTimeout(t), ok(v)), (e) => (clearTimeout(t), no(e)));
  });
}

// ---------------------------------------------------------------- failures

/** A copy failed (load, throw, slow): a tried draft is discarded, a kept copy under watch switches back. */
function failed(vault: string, inst: Instance, why: string): void {
  const id = `box/${inst.name}`;
  inst.error = why;
  if (inst.failedOnce) return;
  inst.failedOnce = true;
  console.warn(`[box-plugin] ${id} ${inst.draft ? "draft" : inst.kind} ${inst.version}: ${why}`);
  if (inst.draft) {
    unload(inst);
    setPluginChange(vault, { plugin: id, change: "discard", version: inst.version, by: "auto", reason: why.slice(0, 200) }, "auto");
    return;
  }
  const k = watchedKeep(supervisorOf(vault).changes(id), Date.now());
  if (k && k.version === inst.version) setPluginChange(vault, { plugin: id, change: "switch", version: inst.version, by: "auto", reason: why.slice(0, 200) }, "auto");
}

// ---------------------------------------------------------------- loading

let moduleDir: string | null = null;
function moduleFile(vault: string, name: string, version: string, code: string): string {
  if (!moduleDir) {
    moduleDir = join(process.env.VC_STATE_DIR || tmpdir(), "box-plugins-loaded", String(process.pid));
    mkdirSync(moduleDir, { recursive: true });
  }
  const tag = versionOf(vault);
  const f = join(moduleDir, `${tag}-${name}-${version}.mjs`);
  writeFileSync(f, code);
  return f;
}

function apiFor(vault: string, inst: Instance) {
  const id = `box/${inst.name}`;
  const guard = <A extends unknown[]>(what: string, fn: (...a: A) => unknown) => (...a: A) => {
    if (inst.stopped) return;
    const t0 = Date.now();
    try {
      const out = fn(...a);
      if (out && typeof (out as Promise<unknown>).catch === "function") (out as Promise<unknown>).catch((e) => failed(vault, inst, `${what} threw: ${msg(e)}`));
    } catch (e) {
      return failed(vault, inst, `${what} threw: ${msg(e)}`);
    }
    const ms = Date.now() - t0;
    if (ms > BOX_SLOW_MS) failed(vault, inst, `${what} took ${ms} ms (the limit is ${BOX_SLOW_MS} ms)`);
  };
  const vaultRoot = resolve(vault);
  const apiLog = (line: string) => {
    inst.lines.push(line.slice(0, 500));
    if (inst.lines.length > 20) inst.lines.shift();
    console.log(`[box-plugin] ${id}${inst.draft ? " (draft)" : ""}: ${line.slice(0, 500)}`);
  };
  return {
    name: inst.name,
    version: inst.version,
    tried: inst.draft,
    route(method: string, path: string, handler: Handler) {
      const m = String(method).toUpperCase();
      if (m !== "GET" && m !== "POST") throw new Error("box.route: GET or POST");
      const p = "/" + String(path ?? "").replace(/^\/+/, "");
      if (typeof handler !== "function") throw new Error("box.route: a handler function");
      const key = `${m} ${p}`;
      inst.routes.set(key, handler);
      const off = () => void (inst.routes.get(key) === handler && inst.routes.delete(key));
      inst.undo.push(off);
      return off;
    },
    onRecord(fn: (r: LogRecord) => void) {
      const off = signalLog(vault).onRecord(guard("onRecord", fn));
      inst.undo.push(off);
      return off;
    },
    every(ms: number, fn: () => void) {
      const t = setInterval(guard("every", fn), Math.max(1000, Number(ms) || 0));
      t.unref?.();
      const off = () => clearInterval(t);
      inst.undo.push(off);
      return off;
    },
    readFile(rel: string): string | null {
      const full = resolve(vaultRoot, String(rel ?? ""));
      if (full !== vaultRoot && !full.startsWith(vaultRoot + sep)) return null;
      try {
        return readFileSync(full, "utf8");
      } catch {
        return null;
      }
    },
    state: {
      get(key?: string) {
        const s = readPluginState(vault, id).state;
        return key == null ? s : s[String(key)];
      },
      set(key: string, value: unknown) {
        // Try never changes the box's data: a tried draft's write is said, not done.
        if (inst.draft) return void apiLog(`not written while tried: ${String(key)}`);
        const w = setPluginState(vault, id, JSON.stringify({ key: String(key), value: value === undefined ? null : value }));
        if ("error" in w) throw new Error(w.error);
        return w.seq;
      },
    },
    reply(status: number, body: unknown): Reply {
      return { [REPLY]: true, status: Math.trunc(Number(status)) || 200, body };
    },
    log(...a: unknown[]) {
      apiLog(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
    },
  };
}

function load(vault: string, name: string, kind: CopyKind, code: string, draft: boolean): Instance {
  const inst: Instance = { name, version: versionOf(code), kind, draft, routes: new Map(), undo: [], error: null, failedOnce: false, lines: [], ready: Promise.resolve(), stopped: false };
  inst.ready = (async () => {
    try {
      if (code.length > MAX_BYTES) throw new Error(`over ${MAX_BYTES} bytes`);
      const mod = await import(/* @vite-ignore */ pathToFileURL(moduleFile(vault, name, inst.version, code)).href);
      const activate = typeof mod.activate === "function" ? mod.activate : typeof mod.default === "function" ? mod.default : null;
      if (!activate) throw new Error("it exports no activate(box)");
      const out = await withTimeout(Promise.resolve(activate(apiFor(vault, inst))), ACTIVATE_MS, "activate");
      if (typeof out === "function") inst.undo.push(out as () => void);
      if (inst.stopped) unload(inst);
    } catch (e) {
      unload(inst);
      failed(vault, inst, `it did not load: ${msg(e)}`);
    }
  })();
  return inst;
}

function unload(inst: Instance | null): void {
  if (!inst) return;
  inst.stopped = true;
  inst.routes.clear();
  for (const off of inst.undo.splice(0).reverse()) {
    try {
      off();
    } catch (e) {
      console.warn(`[box-plugin] box/${inst.name}: unloading threw: ${msg(e)}`);
    }
  }
}

// ---------------------------------------------------------------- which copy runs

function names(vault: string): string[] {
  let all: string[] = [];
  try {
    all = readdirSync(join(vault, BOX_PLUGIN_DIR));
  } catch {
    return [];
  }
  const out = new Set<string>();
  for (const n of all) {
    const f = slotFileOf(n);
    if (f && f.ext === ".js" && /^[a-z][a-z0-9-]{0,40}$/.test(f.base)) out.add(f.base);
  }
  return [...out].sort();
}

function reconcileNow(vault: string): void {
  const rt = runtimeOf(vault);
  const here = new Set(names(vault));
  for (const [name, p] of rt.plugins)
    if (!here.has(name)) {
      unload(p.live);
      unload(p.draft);
      rt.plugins.delete(name);
    }
  for (const name of here) {
    const id = `box/${name}`;
    const p = rt.plugins.get(name) ?? { live: null, draft: null };
    rt.plugins.set(name, p);
    if (pluginDesired(vault, id).state === "stopped") {
      unload(p.live);
      unload(p.draft);
      p.live = p.draft = null;
      continue;
    }
    const code = slotCode(vault, boxSlot(name));
    const changes = supervisorOf(vault).changes(id);
    const c = chooseCopy(code, changes, null);
    const text = c.kind ? code[c.kind] : undefined;
    const v = text !== undefined ? versionOf(text) : null;
    if (p.live && p.live.version !== v) {
      unload(p.live);
      p.live = null;
    }
    if (!p.live && text !== undefined && c.kind) p.live = load(vault, name, c.kind, text, false);
    const pending = draftPending(code, changes);
    if (p.draft && p.draft.version !== pending) {
      unload(p.draft);
      p.draft = null;
    }
  }
}

/** Make the loaded copies match the files and records (serialised per vault). */
export function reconcileBoxPlugins(vault: string): Promise<void> {
  const rt = runtimeOf(vault);
  rt.chain = rt.chain.then(() => reconcileNow(vault)).catch((e) => console.warn(`[box-plugin] reconcile: ${msg(e)}`));
  return rt.chain;
}

/** The box keeps every vault's box plugins loaded (their hooks and timers run without a request). */
export function startBoxPlugins(vaults: () => string[], everyMs = 3_000): () => void {
  const tick = () => {
    for (const v of vaults()) void reconcileBoxPlugins(v);
  };
  tick();
  const t = setInterval(tick, everyMs);
  t.unref?.();
  return () => clearInterval(t);
}

/** Tests: unload everything. */
export function _resetBoxPlugins(): void {
  for (const rt of runtimes.values()) for (const p of rt.plugins.values()) (unload(p.live), unload(p.draft));
  runtimes.clear();
}

// ---------------------------------------------------------------- requests

export type BoxOut = { status: number; body: unknown };

function findRoute(inst: Instance, method: string, sub: string): Handler | null {
  const exact = inst.routes.get(`${method} ${sub}`);
  if (exact) return exact;
  let best: { len: number; h: Handler } | null = null;
  for (const [k, h] of inst.routes) {
    if (!k.startsWith(`${method} `) || !k.endsWith("/*")) continue;
    const pre = k.slice(method.length + 1, -1);
    if ((sub + "/").startsWith(pre) && (!best || pre.length > best.len)) best = { len: pre.length, h };
  }
  return best?.h ?? null;
}

/**
 * One request to a box plugin's route: /api/v2/box/<name><sub>. `tried`: the draft version the caller tries (the
 * x-vc-try header, ?vc-try=, or a page's host), or null.
 */
export async function boxPluginRequest(vault: string, name: string, method: string, sub: string, query: URLSearchParams, body: unknown, tried: string | null): Promise<BoxOut> {
  if (method !== "GET" && method !== "POST") return { status: 405, body: { error: "GET or POST" } };
  await reconcileBoxPlugins(vault);
  const id = `box/${name}`;
  const p = runtimeOf(vault).plugins.get(name);
  if (!p) return { status: 404, body: { error: `no box plugin ${name} (${BOX_PLUGIN_DIR}/${name}.js)` } };
  if (pluginDesired(vault, id).state === "stopped") return { status: 403, body: { error: `${id} is turned off` } };
  let inst = p.live;
  if (tried) {
    const code = slotCode(vault, boxSlot(name));
    const pending = draftPending(code, supervisorOf(vault).changes(id));
    if (pending === tried && code.draft !== undefined) {
      if (!p.draft || p.draft.version !== pending) {
        unload(p.draft);
        p.draft = load(vault, name, "draft", code.draft, true);
      }
      inst = p.draft;
    }
  }
  if (!inst) return { status: 404, body: { error: `${id} has no copy in effect` } };
  await inst.ready;
  if (inst.stopped) return { status: 503, body: { error: `${id} ${inst.draft ? "draft" : ""} is not running: ${inst.error ?? "unloaded"}`.replace("  ", " ") } };
  const handler = findRoute(inst, method, sub || "/");
  if (!handler) return { status: 404, body: { error: `${id} has no route ${method} ${sub || "/"}` } };
  const q: Record<string, string> = {};
  for (const [k, v] of query) if (k !== "vc-try" && k !== "vault") q[k] = v;
  const t0 = Date.now();
  try {
    const out = await withTimeout(Promise.resolve(handler({ method, path: sub || "/", query: q, body, tried: inst.draft })), BOX_HANDLER_MS, `${method} ${sub || "/"}`);
    const ms = Date.now() - t0;
    if (ms > BOX_SLOW_MS) failed(vault, inst, `${method} ${sub || "/"} took ${ms} ms (the limit is ${BOX_SLOW_MS} ms)`);
    if (out && typeof out === "object" && (out as Reply)[REPLY]) return { status: (out as Reply).status, body: (out as Reply).body ?? null };
    return { status: 200, body: out === undefined ? null : out };
  } catch (e) {
    const why = `${method} ${sub || "/"} threw: ${msg(e)}`;
    failed(vault, inst, why);
    return { status: /took over/.test(why) ? 504 : 500, body: { error: why } };
  }
}

/** GET /api/v2/box-plugins: each box plugin, the copy that runs (version, routes, error) and the draft waiting. */
export async function boxPluginsStatus(vault: string): Promise<BoxOut> {
  await reconcileBoxPlugins(vault);
  const sup = supervisorOf(vault);
  const out = [];
  for (const [name, p] of runtimeOf(vault).plugins) {
    const id = `box/${name}`;
    const code = slotCode(vault, boxSlot(name));
    const pending = draftPending(code, sup.changes(id));
    const one = (i: Instance | null) => (i ? { version: i.version, kind: i.kind, running: !i.stopped, error: i.error, routes: [...i.routes.keys()], log: i.lines.slice(-5) } : null);
    out.push({
      plugin: id,
      state: pluginDesired(vault, id).state,
      live: one(p.live),
      draft: pending ? { version: pending, what: draftWhat(code.draft!), added: code.live === undefined, tried: one(p.draft?.version === pending ? p.draft : null) } : null,
    });
  }
  return { status: 200, body: { dir: BOX_PLUGIN_DIR, plugins: out } };
}

/** One line about a box plugin as the box runs it now (the Plugins tool's status). */
export function boxPluginLine(vault: string, name: string): string {
  const p = runtimeOf(vault).plugins.get(name);
  const code = slotCode(vault, boxSlot(name));
  const pending = draftPending(code, supervisorOf(vault).changes(`box/${name}`));
  const live = p?.live;
  const runs = live ? `${live.kind} ${live.version}${live.stopped ? ` not running (${live.error ?? "unloaded"})` : `, routes ${[...live.routes.keys()].join(", ") || "none"}`}${!live.stopped && live.error ? `; last error: ${live.error}` : ""}` : "no copy loaded";
  return `box/${name}: ${runs}${pending ? `; draft ${pending} waits for Carl (Change ready)` : ""}`;
}

/** The box plugins in a vault's folder. */
export const boxPluginNames = names;
