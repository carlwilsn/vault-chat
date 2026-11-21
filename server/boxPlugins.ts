// Box plugins (reports/07 corrected model, point 4: change by asking, for the box's own behaviour). A box plugin is a
// server-side module in the vault, .vault-chat/box-plugins/<name>.js (id box/<name>), that the running box loads live:
// no build, no release, no restart. It goes through the one gate like any plugin (src/pluginDrafts.ts): the agent writes
// <name>.draft.js and submits it; the gate keeps or discards it (one plugin.change record; server/pluginDrafts.ts moves
// the files), and Switch back is the undo.
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
//   box.tool({name, description, inputSchema, handler})
//                                     an agent tool: it joins the agent's live tool catalog (mcp__vault_chat__<name>) at
//                                     the session's next step, as a vault tool does; handler(args, {tried, conv}) answers
//                                     a string or JSON. A throw or a call over BOX_TOOL_MS is an error result for the
//                                     agent and a failure of the copy (as a route's).
//   box.prompt(text)                  a short fragment (at most BOX_PROMPT_MAX chars) the agent is given with its turns,
//                                     under the plugin's id; called again, it replaces it.
//   box.hideTool(name)                takes one of vault-chat's own agent tools out of the agent's catalog (and refuses
//                                     its calls) while the plugin runs; never Plugins, the way back.
// Everything it registers is undone in reverse order when it unloads (a Keep, Discard, Switch back, turned off).
//
// Which copy runs: the one the records say (chooseCopy), loaded once per version. A draft waiting for the gate runs only
// for the requests that try it (header x-vc-try: <version>, or ?vc-try=<version>: the agent's own checks over loopback),
// never for anyone else, and it cannot write: its state.set refuses ("Try never changes box data until Keep"). A tried
// draft that fails to load, throws, or answers slower than BOX_SLOW_MS discards itself (a
// discard record by "auto"); a kept copy that does so within KEEP_WATCH_MS switches back by itself (a switch by "auto").
//
// Apart from the box: each loaded copy runs in its own worker_thread (server/boxPluginWorker.ts), never on the box's
// event loop, so it cannot hang or crash the box. A watchdog pings the thread; one that does not answer for BOX_STUCK_MS
// (an endless loop at load, in a handler, a hook or a timer) is terminated. Its heap is capped (BOX_MEM_MB,
// resourceLimits; VC_BOX_PLUGIN_MEM_MB), and process.exit ends only its thread. Each is a failure like a throw: a tried
// draft discards itself, a watched keep switches back, an older live copy stops with its error in its status (the next
// change or a restart loads it again). The box goes on answering meanwhile.
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { MessageChannel, Worker } from "node:worker_threads";
import { BOX_WORKER_SOURCE } from "./boxPluginWorker";
import { BOX_PLUGIN_DIR, boxSlot, chooseCopy, draftPending, draftWhat, slotFileOf, versionOf, watchedKeep, type CopyKind } from "../src/pluginDrafts";
import { signalLog } from "./convlog/log";
import { slotCode } from "./pluginDrafts";
import { pluginDesired, setPluginChange, supervisorOf } from "./supervisor";
import { readPluginState, setPluginState } from "./pluginState";

/** A handler (or a hook) slower than this counts as a failure of a tried draft or a watched keep. */
export const BOX_SLOW_MS = 2_000;
/** A handler still running after this is answered 504 (and counts as slow). */
export const BOX_HANDLER_MS = 10_000;
/** A box plugin's agent tool still running after this is an error result (and a failure of its copy). */
export let BOX_TOOL_MS = 10_000;
/** Tests: a shorter tool limit. */
export function _setBoxToolMs(ms: number): void {
  BOX_TOOL_MS = ms;
}
/** A box plugin's prompt fragment at most this long. */
export const BOX_PROMPT_MAX = 1_500;
/** vault-chat's tools a box plugin may never hide: the way to turn it off again. */
const UNHIDEABLE = new Set(["Plugins"]);
/** activate() must finish within this (from when its thread runs). */
const ACTIVATE_MS = 5_000;
/** A copy's thread must start within this. */
const START_MS = 30_000;
/** A copy's cleanup (Keep, Discard, Switch back, turned off) must finish within this, else its thread is terminated. */
const STOP_MS = 1_000;
/** box.state.get / set wait at most this for the box. */
const SYNC_MS = 5_000;
/** The watchdog: a copy whose thread does not answer for this long runs code that never yields and is terminated. */
export let BOX_STUCK_MS = 5_000;
/** A copy's thread may use this much heap (resourceLimits); over it, it is terminated. */
export let BOX_MEM_MB = Math.max(16, Number(process.env.VC_BOX_PLUGIN_MEM_MB) || 128);
/** Tests: a shorter watchdog, a smaller heap. */
export function _setBoxLimits(o: { stuckMs?: number; memMb?: number }): void {
  if (o.stuckMs) BOX_STUCK_MS = o.stuckMs;
  if (o.memMb) BOX_MEM_MB = o.memMb;
}
/** A box plugin's code at most this big. */
const MAX_BYTES = 512 * 1024;

export type BoxRequest = { method: "GET" | "POST"; path: string; query: Record<string, string>; body: unknown; tried: boolean };
export type BoxToolSpec = { type: "function"; name: string; description: string; inputSchema: Record<string, unknown> };
/** A tool as the box knows it: its spec (the handler stays in the copy's thread). */
type BoxTool = { spec: BoxToolSpec };

type Instance = {
  name: string;
  version: string;
  kind: CopyKind;
  draft: boolean;
  /** Its routes ("GET /x"), its tools, prompt and hidden tools: as its thread registered them. */
  routes: Set<string>;
  tools: Map<string, BoxTool>;
  prompt: string | null;
  hidden: Set<string>;
  undo: (() => void)[];
  error: string | null;
  /** It failed once already: what follows is only logged (a hook that keeps throwing writes one record, not many). */
  failedOnce: boolean;
  lines: string[];
  ready: Promise<void>;
  stopped: boolean;
  /** The thread its code runs in (null once it ended). */
  worker: Worker | null;
  /** Its handlers' calls in flight. */
  calls: Map<number, { ok: (v: CallOut) => void; no: (e: Error) => void }>;
  /** Settles when its thread has ended. */
  unloaded: Promise<void>;
  /** Ask its thread to run its cleanup and end; terminate it (a failure). Set once its thread exists. */
  stop?: () => void;
  kill?: (why: string | null) => void;
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

let seq = 0;

/** The box's side of a copy's thread: what it registered (as messages), its calls in flight, the watchdog. */
function load(vault: string, name: string, kind: CopyKind, code: string, draft: boolean): Instance {
  const inst: Instance = { name, version: versionOf(code), kind, draft, routes: new Set(), tools: new Map(), prompt: null, hidden: new Set(), undo: [], error: null, failedOnce: false, lines: [], ready: Promise.resolve(), stopped: false, worker: null, calls: new Map(), unloaded: Promise.resolve() };
  const id = `box/${name}`;
  let settle: (() => void) | null = null;
  inst.ready = new Promise<void>((ok) => (settle = ok));
  const loaded = () => {
    const s = settle;
    settle = null;
    s?.();
  };
  /** A load that went wrong: the copy is unloaded and it is a failure (a tried draft discards itself). */
  const loadFailed = (why: string) => {
    if (!settle) return;
    unload(inst);
    failed(vault, inst, `it did not load: ${why}`);
    loaded();
  };
  if (code.length > MAX_BYTES) {
    loadFailed(`over ${MAX_BYTES} bytes`);
    return inst;
  }
  let file: string;
  try {
    file = moduleFile(vault, name, inst.version, code);
  } catch (e) {
    loadFailed(msg(e));
    return inst;
  }

  const sab = new SharedArrayBuffer(4);
  const flag = new Int32Array(sab);
  const { port1, port2 } = new MessageChannel();
  let worker: Worker;
  try {
    worker = new Worker(BOX_WORKER_SOURCE, {
      eval: true,
      name: id,
      workerData: { url: pathToFileURL(file).href, vault, name, version: inst.version, draft, sab, port: port2, syncMs: SYNC_MS, slowMs: BOX_SLOW_MS, promptMax: BOX_PROMPT_MAX, unhideable: [...UNHIDEABLE], mirror: !!process.env.VITEST },
      transferList: [port2],
      resourceLimits: { maxOldGenerationSizeMb: BOX_MEM_MB, maxYoungGenerationSizeMb: Math.max(4, Math.min(32, Math.round(BOX_MEM_MB / 4))) },
    });
  } catch (e) {
    port1.close();
    loadFailed(msg(e));
    return inst;
  }
  worker.unref();
  inst.worker = worker;

  // box.state.get / set: answered at once, the thread waits on the flag.
  port1.on("message", (m: { n: number; op: string; args: unknown }) => {
    let out: { n: number; value?: unknown; error?: string };
    try {
      if (m.op === "get") {
        const s = readPluginState(vault, id).state;
        out = { n: m.n, value: m.args == null ? s : s[String(m.args)] };
      } else if (m.op === "set") {
        const w = setPluginState(vault, id, String(m.args));
        out = "error" in w ? { n: m.n, error: w.error } : { n: m.n, value: w.seq };
      } else out = { n: m.n, error: `no ${m.op}` };
    } catch (e) {
      out = { n: m.n, error: msg(e) };
    }
    try {
      port1.postMessage(out);
    } catch (e) {
      port1.postMessage({ n: m.n, error: msg(e) });
    }
    Atomics.store(flag, 0, 1);
    Atomics.notify(flag, 0);
  });
  port1.unref();

  // The log hook: only while it has one.
  let offRecords: (() => void) | null = null;
  const hooks = (n: number) => {
    if (n > 0 && !offRecords && !inst.stopped)
      offRecords = signalLog(vault).onRecord((r) => {
        if (!inst.stopped) inst.worker?.postMessage({ t: "record", r });
      });
    else if (n === 0 && offRecords) (offRecords(), (offRecords = null));
  };

  // The watchdog: a thread that has not answered a ping for BOX_STUCK_MS runs code that never yields (an endless
  // loop) and is terminated. A stall of the box's own loop gives no verdict.
  let pingSent: number | null = null;
  let lastTick = Date.now();
  const every = Math.max(50, Math.min(500, Math.floor(BOX_STUCK_MS / 4)));
  let dog: ReturnType<typeof setInterval> | null = null;
  const startDog = () => {
    dog = setInterval(() => {
      const now = Date.now();
      if (now - lastTick > every * 3) pingSent = null;
      lastTick = now;
      if (pingSent !== null && now - pingSent > BOX_STUCK_MS) return kill(`its code ran over ${BOX_STUCK_MS} ms without yielding (an endless loop?), so it was stopped`);
      if (pingSent === null) {
        pingSent = now;
        worker.postMessage({ t: "ping" });
      }
    }, every);
    dog.unref?.();
  };
  // No hello at all (a box too loaded to start a thread), or activate() too long once it started.
  let loadTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => kill(`it did not start within ${START_MS} ms`), START_MS);
  loadTimer.unref?.();

  let gone = false;
  let stopping: (() => void) | null = null;
  inst.unloaded = new Promise<void>((ok) => (stopping = ok));
  /** The thread is gone: everything it had in flight fails; unexpected, it is a failure of the copy. */
  const ended = (why: string | null) => {
    if (gone) return;
    gone = true;
    if (dog) clearInterval(dog);
    if (loadTimer) clearTimeout(loadTimer);
    hooks(0);
    port1.close();
    inst.worker = null;
    for (const c of inst.calls.values()) c.no(new Error(why ?? "it was unloaded"));
    inst.calls.clear();
    if (why !== null) {
      if (settle) loadFailed(why);
      else if (!inst.stopped) {
        unload(inst);
        failed(vault, inst, why);
      }
    }
    loaded();
    stopping?.();
  };
  const kill = (why: string | null) => {
    if (gone) return;
    void worker.terminate();
    ended(why);
  };
  inst.kill = kill;
  inst.stop = () => {
    if (gone) return;
    // Its cleanup runs in its thread; a thread that does not finish it soon is terminated.
    const t = setTimeout(() => (void worker.terminate(), ended(null)), STOP_MS);
    t.unref?.();
    try {
      worker.postMessage({ t: "stop" });
    } catch {
      void worker.terminate();
      ended(null);
    }
  };

  let oom = false;
  worker.on("error", (e: Error & { code?: string }) => {
    if (e?.code === "ERR_WORKER_OUT_OF_MEMORY") oom = true;
    else console.warn(`[box-plugin] ${id}: its thread failed: ${msg(e)}`);
  });
  worker.on("exit", (code) => ended(inst.stopped && !oom ? null : oom ? `it used over ${BOX_MEM_MB} MB of memory, so it was stopped` : `its thread ended (exit code ${code})`));

  const mine = (m: { t: string }) => m.t === "done" || m.t === "stopped" || m.t === "pong" || !inst.stopped;
  worker.on("message", (m: any) => {
    if (!mine(m)) return;
    switch (m.t) {
      case "hello":
        if (loadTimer) clearTimeout(loadTimer);
        loadTimer = setTimeout(() => kill(`activate took over ${ACTIVATE_MS} ms`), ACTIVATE_MS);
        loadTimer.unref?.();
        startDog();
        return;
      case "pong":
        pingSent = null;
        return;
      case "active":
        if (loadTimer) clearTimeout(loadTimer);
        loadTimer = null;
        loaded();
        return;
      case "loadFailed":
        if (loadTimer) clearTimeout(loadTimer);
        loadTimer = null;
        loadFailed(m.why);
        if (!gone) void worker.terminate();
        return;
      case "reg":
        if (m.what === "route") inst.routes.add(m.key);
        else if (m.what === "tool") inst.tools.set(m.spec.name, { spec: m.spec });
        else if (m.what === "hide") inst.hidden.add(m.key);
        return;
      case "unreg":
        if (m.what === "route") inst.routes.delete(m.key);
        else if (m.what === "tool") inst.tools.delete(m.key);
        else if (m.what === "hide") inst.hidden.delete(m.key);
        return;
      case "prompt":
        if (m.set) inst.prompt = m.text;
        else if (inst.prompt === m.text) inst.prompt = null;
        return;
      case "hooks":
        hooks(m.n);
        return;
      case "log":
        inst.lines.push(m.line);
        if (inst.lines.length > 20) inst.lines.shift();
        console.log(`[box-plugin] ${id}${draft ? " (draft)" : ""}: ${m.line}`);
        return;
      case "warn":
        console.warn(`[box-plugin] ${id}: ${m.line}`);
        return;
      case "fail":
        failed(vault, inst, m.why);
        return;
      case "done": {
        const c = inst.calls.get(m.id);
        if (!c) return;
        inst.calls.delete(m.id);
        if (m.ok) c.ok(m.reply ? { reply: m.reply } : { value: m.value });
        else c.no(new Error(m.error));
        return;
      }
      case "stopped":
        mirrorGlobals(m.globals);
        void worker.terminate();
        ended(null);
        return;
    }
  });
  return inst;
}

/** Tests (VITEST): a thread's __box* globals, as its cleanup left them, reach the box's own globalThis. */
function mirrorGlobals(g: Record<string, unknown> | undefined): void {
  const G = globalThis as Record<string, unknown>;
  for (const [k, v] of Object.entries(g ?? {})) {
    if (Array.isArray(v) && Array.isArray(G[k])) for (const x of v) (G[k] as unknown[]).includes(x) || (G[k] as unknown[]).push(x);
    else G[k] = v;
  }
}

type CallOut = { reply: { status: number; body: unknown } } | { value: unknown };

/** Call a handler in the copy's thread: a route's (arg: the request) or a tool's (arg: its args, ctx). */
function callIn(inst: Instance, kind: "route" | "tool", key: string, arg: unknown, ctx: unknown, ms: number, what: string): Promise<CallOut> {
  const w = inst.worker;
  if (!w || inst.stopped) return Promise.reject(new Error(`it is not running: ${inst.error ?? "unloaded"}`));
  const id = ++seq;
  return new Promise<CallOut>((ok, no) => {
    const t = setTimeout(() => {
      inst.calls.delete(id);
      no(new Error(`${what} took over ${ms} ms`));
    }, ms);
    t.unref?.();
    inst.calls.set(id, { ok: (v) => (clearTimeout(t), ok(v)), no: (e) => (clearTimeout(t), no(e)) });
    try {
      w.postMessage({ t: "call", id, kind, key, arg, ctx });
    } catch (e) {
      inst.calls.delete(id);
      clearTimeout(t);
      no(e);
    }
  });
}

/** Unload a copy: what it registered leaves at once; its cleanup runs in its thread, then the thread ends. */
function unload(inst: Instance | null): Promise<void> {
  if (!inst) return Promise.resolve();
  const first = !inst.stopped;
  inst.stopped = true;
  inst.routes.clear();
  inst.tools.clear();
  inst.prompt = null;
  inst.hidden.clear();
  if (first) inst.stop?.();
  return inst.unloaded;
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

async function reconcileNow(vault: string): Promise<void> {
  const ending: Promise<void>[] = [];
  const drop = (i: Instance | null) => void ending.push(unload(i));
  const rt = runtimeOf(vault);
  const here = new Set(names(vault));
  for (const [name, p] of rt.plugins)
    if (!here.has(name)) {
      drop(p.live);
      drop(p.draft);
      rt.plugins.delete(name);
    }
  for (const name of here) {
    const id = `box/${name}`;
    const p = rt.plugins.get(name) ?? { live: null, draft: null };
    rt.plugins.set(name, p);
    if (pluginDesired(vault, id).state === "stopped") {
      drop(p.live);
      drop(p.draft);
      p.live = p.draft = null;
      continue;
    }
    const code = slotCode(vault, boxSlot(name));
    const changes = supervisorOf(vault).changes(id);
    const c = chooseCopy(code, changes, null);
    const text = c.kind ? code[c.kind] : undefined;
    const v = text !== undefined ? versionOf(text) : null;
    if (p.live && p.live.version !== v) {
      drop(p.live);
      p.live = null;
    }
    if (!p.live && text !== undefined && c.kind) p.live = load(vault, name, c.kind, text, false);
    const pending = draftPending(code, changes);
    if (p.draft && p.draft.version !== pending) {
      drop(p.draft);
      p.draft = null;
    }
  }
  // A copy that leaves has finished its cleanup before what follows (bounded by STOP_MS).
  await Promise.all(ending);
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
  for (const rt of runtimes.values()) for (const p of rt.plugins.values()) for (const i of [p.live, p.draft]) if (i) (unload(i), i.kill?.(null));
  runtimes.clear();
}

// ---------------------------------------------------------------- the gate's probe (server/gateBox.ts)

/** A copy loaded on its own for the gate: what it registered, and its routes to call. Only ever on a copy of a vault. */
export type BoxProbe = {
  version: string;
  /** It loaded and activated without failing. */
  ran: boolean;
  error: string | null;
  routes: string[];
  tools: BoxToolSpec[];
  prompt: string | null;
  hidden: string[];
  log: string[];
  /** One GET or POST of a route of this copy; a throw, a slow answer or a stuck thread is an error (and the copy's). */
  call(method: "GET" | "POST", sub: string, body?: unknown): Promise<{ status: number; body: unknown; ms: number; error?: string }>;
  close(): Promise<void>;
};

/**
 * Load `code` as box/<name> in its own thread, apart from every running copy (the gate's runner: server/gateBox.ts), on
 * `vault`, which must be a scratch copy: a failure writes its usual record into that copy's log. `draft`: as a tried
 * draft (its writes are said, not done).
 */
export async function probeBoxCopy(vault: string, name: string, code: string, draft: boolean): Promise<BoxProbe> {
  const inst = load(vault, name, draft ? "draft" : "live", code, draft);
  await inst.ready;
  const errOf = () => (inst.stopped || inst.error ? (inst.error ?? "unloaded") : null);
  return {
    version: inst.version,
    ran: !inst.stopped && !inst.error,
    get error() {
      return errOf();
    },
    routes: [...inst.routes].sort(),
    tools: [...inst.tools.values()].map((t) => structuredClone(t.spec)).sort((a, b) => a.name.localeCompare(b.name)),
    prompt: inst.prompt,
    hidden: [...inst.hidden].sort(),
    get log() {
      return inst.lines.slice();
    },
    async call(method, sub, body) {
      const route = findRoute(inst, method, sub || "/");
      if (inst.stopped) return { status: 503, body: null, ms: 0, error: `not running: ${errOf()}` };
      if (!route) return { status: 404, body: null, ms: 0 };
      const t0 = Date.now();
      try {
        const out = await callIn(inst, "route", route, { method, path: sub || "/", query: {}, body: body ?? null, tried: draft } satisfies BoxRequest, null, BOX_HANDLER_MS, `${method} ${sub || "/"}`);
        const ms = Date.now() - t0;
        if (ms > BOX_SLOW_MS) return { status: 200, body: null, ms, error: `${method} ${sub || "/"} took ${ms} ms (the limit is ${BOX_SLOW_MS} ms)` };
        if ("reply" in out) return { status: out.reply.status, body: out.reply.body ?? null, ms };
        return { status: 200, body: out.value === undefined ? null : out.value, ms };
      } catch (e) {
        return { status: 500, body: null, ms: Date.now() - t0, error: `${method} ${sub || "/"} threw: ${msg(e)}` };
      }
    },
    async close() {
      await unload(inst);
      inst.kill?.(null);
    },
  };
}

// ---------------------------------------------------------------- requests

export type BoxOut = { status: number; body: unknown };

/** The copy a caller gets: the draft when it tries the draft waiting now (loaded on first use), else the live one. */
function copyFor(vault: string, name: string, p: Plugin, tried: string | null | undefined): Instance | null {
  if (tried) {
    const code = slotCode(vault, boxSlot(name));
    const pending = draftPending(code, supervisorOf(vault).changes(`box/${name}`));
    if (pending === tried && code.draft !== undefined) {
      if (!p.draft || p.draft.version !== pending) {
        unload(p.draft);
        p.draft = load(vault, name, "draft", code.draft, true);
      }
      return p.draft;
    }
  }
  return p.live;
}

function findRoute(inst: Instance, method: string, sub: string): string | null {
  if (inst.routes.has(`${method} ${sub}`)) return `${method} ${sub}`;
  let best: { len: number; k: string } | null = null;
  for (const k of inst.routes) {
    if (!k.startsWith(`${method} `) || !k.endsWith("/*")) continue;
    const pre = k.slice(method.length + 1, -1);
    if ((sub + "/").startsWith(pre) && (!best || pre.length > best.len)) best = { len: pre.length, k };
  }
  return best?.k ?? null;
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
  const inst = copyFor(vault, name, p, tried);
  if (!inst) return { status: 404, body: { error: `${id} has no copy in effect` } };
  await inst.ready;
  if (inst.stopped) return { status: 503, body: { error: `${id} ${inst.draft ? "draft" : ""} is not running: ${inst.error ?? "unloaded"}`.replace("  ", " ") } };
  const route = findRoute(inst, method, sub || "/");
  if (!route) return { status: 404, body: { error: `${id} has no route ${method} ${sub || "/"}` } };
  const q: Record<string, string> = {};
  for (const [k, v] of query) if (k !== "vc-try" && k !== "vault") q[k] = v;
  const t0 = Date.now();
  try {
    const out = await callIn(inst, "route", route, { method, path: sub || "/", query: q, body, tried: inst.draft } satisfies BoxRequest, null, BOX_HANDLER_MS, `${method} ${sub || "/"}`);
    const ms = Date.now() - t0;
    if (ms > BOX_SLOW_MS) failed(vault, inst, `${method} ${sub || "/"} took ${ms} ms (the limit is ${BOX_SLOW_MS} ms)`);
    if ("reply" in out) return { status: out.reply.status, body: out.reply.body ?? null };
    return { status: 200, body: out.value === undefined ? null : out.value };
  } catch (e) {
    const why = `${method} ${sub || "/"} threw: ${msg(e)}`;
    failed(vault, inst, why);
    return { status: /took over|without yielding/.test(why) ? 504 : 500, body: { error: why } };
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
    const one = (i: Instance | null) => (i ? { version: i.version, kind: i.kind, running: !i.stopped, error: i.error, routes: [...i.routes.keys()], tools: [...i.tools.keys()], prompt: i.prompt, hidden: [...i.hidden], log: i.lines.slice(-5) } : null);
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
  const runs = live ? `${live.kind} ${live.version}${live.stopped ? ` not running (${live.error ?? "unloaded"})` : `, routes ${[...live.routes.keys()].join(", ") || "none"}${live.tools.size ? `, tools ${[...live.tools.keys()].join(", ")}` : ""}${live.prompt ? ", a prompt" : ""}${live.hidden.size ? `, hides ${[...live.hidden].join(", ")}` : ""}`}${!live.stopped && live.error ? `; last error: ${live.error}` : ""}` : "no copy loaded";
  return `box/${name}: ${runs}${pending ? `; draft ${pending} waits for the gate (Plugins submit)` : ""}`;
}

/** The box plugins in a vault's folder. */
export const boxPluginNames = names;

// ---------------------------------------------------------------- the agent: tools, prompt, hidden tools

/** Which box drafts a conversation tries: its `tries` (box/<name> -> version), set when Carl started it while trying. */
export type BoxTries = Record<string, string> | null | undefined;

/** A conversation's `tries` as given by a client: only box plugins, versions as versionOf writes them. */
export function cleanTries(v: unknown): Record<string, string> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 8))
    if (/^box\/[a-z][a-z0-9-]{0,40}$/.test(k) && typeof x === "string" && /^[0-9a-z]{4,32}$/.test(x)) out[k] = x;
  return Object.keys(out).length ? out : null;
}

/** The copies in effect for the agent of a conversation: the live ones, a tried draft in its place. Running only. */
async function agentCopies(vault: string, tries: BoxTries): Promise<Instance[]> {
  await reconcileBoxPlugins(vault);
  const out: Instance[] = [];
  for (const [name, p] of runtimeOf(vault).plugins) {
    if (pluginDesired(vault, `box/${name}`).state === "stopped") continue;
    const inst = copyFor(vault, name, p, tries?.[`box/${name}`]);
    if (!inst) continue;
    await inst.ready;
    if (!inst.stopped) out.push(inst);
  }
  return out;
}

/** The box plugins' agent tools for a conversation (first plugin wins a name; `taken` names are left out). */
export async function boxAgentTools(vault: string, tries: BoxTries, taken: Iterable<string> = []): Promise<BoxToolSpec[]> {
  const skip = new Set(taken);
  const out: BoxToolSpec[] = [];
  for (const inst of await agentCopies(vault, tries))
    for (const t of inst.tools.values()) {
      if (skip.has(t.spec.name)) continue;
      skip.add(t.spec.name);
      out.push(structuredClone(t.spec));
    }
  return out;
}

/** vault-chat's own tools the box plugins hide for a conversation. */
export async function boxHiddenTools(vault: string, tries: BoxTries): Promise<Set<string>> {
  const out = new Set<string>();
  for (const inst of await agentCopies(vault, tries)) for (const n of inst.hidden) out.add(n);
  return out;
}

/** The box plugins' prompt fragments for a conversation, each under its plugin's id; "" when none. */
export async function boxAgentPrompt(vault: string, tries: BoxTries): Promise<string> {
  const parts: string[] = [];
  for (const inst of await agentCopies(vault, tries)) if (inst.prompt) parts.push(`## box/${inst.name}${inst.draft ? " (draft Carl is trying)" : ""}\n${inst.prompt}`);
  return parts.length ? `<box-plugins>\nFrom Carl's box plugins (.vault-chat/box-plugins/), in force while each runs:\n\n${parts.join("\n\n")}\n</box-plugins>` : "";
}

/**
 * Run a box plugin's agent tool. Null when no box plugin in effect for this conversation has it. A throw, or a call
 * over BOX_TOOL_MS, is an error result and a failure of the copy (a tried draft discards itself, a fresh keep switches
 * back), as a route's is.
 */
export async function boxAgentCall(vault: string, name: string, args: Record<string, unknown>, o: { tries?: BoxTries; conv?: string | null; signal?: AbortSignal } = {}): Promise<{ ok: boolean; text: string } | null> {
  const inst = (await agentCopies(vault, o.tries)).find((i) => i.tools.has(name));
  const t = inst?.tools.get(name);
  if (!inst || !t) return null;
  try {
    const run = callIn(inst, "tool", name, args ?? {}, { tried: inst.draft, conv: o.conv ?? null }, BOX_TOOL_MS, `tool ${name}`).then((r) => ("reply" in r ? r.reply : r.value));
    const stop = o.signal ? new Promise<never>((_, no) => (o.signal!.aborted ? no(new Error("stopped")) : o.signal!.addEventListener("abort", () => no(new Error("stopped")), { once: true }))) : null;
    const out = await (stop ? Promise.race([run, stop]) : run);
    const text = typeof out === "string" ? out : out === undefined ? "(done)" : JSON.stringify(out, null, 2) ?? String(out);
    return { ok: true, text: text.length > 100_000 ? `${text.slice(0, 100_000)}\n(cut at 100000 characters)` : text };
  } catch (e) {
    if (o.signal?.aborted) return { ok: false, text: `${name} was stopped.` };
    const why = `tool ${name} ${/took over/.test(msg(e)) ? `took over ${BOX_TOOL_MS} ms` : `threw: ${msg(e)}`}`;
    failed(vault, inst, why);
    return { ok: false, text: `Error: box/${inst.name}'s ${why}${inst.draft ? " (the draft discarded itself)" : ""}` };
  }
}
