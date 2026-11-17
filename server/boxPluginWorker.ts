// The thread a box plugin runs in (server/boxPlugins.ts). Each loaded copy of a box plugin gets its own Node
// worker_thread, so its code never runs on the box's own event loop: an endless loop, a memory hog or a process.exit in
// it stops only that thread (the box's watchdog terminates it; resourceLimits caps its heap), and the box keeps
// answering. The `box` API the plugin sees is the same object as before, built here: what it registers (routes, tools,
// the prompt, hidden tools, log hooks) is told to the box in messages, the box calls its handlers in messages, and the
// few calls that answer at once (box.state.get / set) wait for the box on a shared flag (Atomics.wait) and read the
// answer with receiveMessageOnPort.
//
// Plain JavaScript in a string: the server is one esbuild bundle, and a worker started from source ({eval: true}) needs
// no second file beside it. CommonJS (eval), so the plugin module is loaded with import().
//
// Messages, box -> thread: ping | record {r} | call {id, kind: route|tool, key, arg, ctx} | stop.
// Thread -> box: hello | active | loadFailed {why} | pong | reg/unreg {what, key|spec} | prompt {text} | hooks {n} |
// log {line} | warn {line} | fail {why} | done {id, ok, value|reply|error} | stopped {globals}.
export const BOX_WORKER_SOURCE = String.raw`"use strict";
const { parentPort, workerData: W, receiveMessageOnPort } = require("node:worker_threads");
const { readFileSync } = require("node:fs");
const { resolve, sep } = require("node:path");
const REPLY = Symbol.for("vc.box.reply");
const flag = new Int32Array(W.sab);
const msg = (e) => String((e && e.message) != null ? e.message : e).split("\n")[0].slice(0, 300);
const post = (m) => parentPort.postMessage(m);
let stopped = false;
let syncId = 0;
const undo = [];
const routes = new Map();
const tools = new Map();
const hooks = new Set();
const id = "box/" + W.name;

// A call the box answers at once: wait for its flag, then take the answer off the port.
function syncCall(op, args) {
  const n = ++syncId;
  Atomics.store(flag, 0, 0);
  W.port.postMessage({ n, op, args });
  Atomics.wait(flag, 0, 0, W.syncMs);
  for (;;) {
    const m = receiveMessageOnPort(W.port);
    if (!m) throw new Error("the box did not answer " + op + " within " + W.syncMs + " ms");
    if (m.message.n !== n) continue;
    if (m.message.error) throw new Error(m.message.error);
    return m.message.value;
  }
}

const guard = (what, fn) => (...a) => {
  if (stopped) return;
  const t0 = Date.now();
  try {
    const out = fn(...a);
    if (out && typeof out.catch === "function") out.catch((e) => post({ t: "fail", why: what + " threw: " + msg(e) }));
  } catch (e) {
    return post({ t: "fail", why: what + " threw: " + msg(e) });
  }
  const ms = Date.now() - t0;
  if (ms > W.slowMs) post({ t: "fail", why: what + " took " + ms + " ms (the limit is " + W.slowMs + " ms)" });
};

const vaultRoot = resolve(W.vault);
const apiLog = (line) => post({ t: "log", line: String(line).slice(0, 500) });
const reg = (off) => (undo.push(off), off);

const box = {
  name: W.name,
  version: W.version,
  tried: W.draft,
  route(method, path, handler) {
    const m = String(method).toUpperCase();
    if (m !== "GET" && m !== "POST") throw new Error("box.route: GET or POST");
    const p = "/" + String(path == null ? "" : path).replace(/^\/+/, "");
    if (typeof handler !== "function") throw new Error("box.route: a handler function");
    const key = m + " " + p;
    routes.set(key, handler);
    post({ t: "reg", what: "route", key });
    return reg(() => {
      if (routes.get(key) !== handler) return;
      routes.delete(key);
      post({ t: "unreg", what: "route", key });
    });
  },
  onRecord(fn) {
    const g = guard("onRecord", fn);
    hooks.add(g);
    post({ t: "hooks", n: hooks.size });
    return reg(() => {
      hooks.delete(g);
      post({ t: "hooks", n: hooks.size });
    });
  },
  every(ms, fn) {
    const t = setInterval(guard("every", fn), Math.max(1000, Number(ms) || 0));
    return reg(() => clearInterval(t));
  },
  readFile(rel) {
    const full = resolve(vaultRoot, String(rel == null ? "" : rel));
    if (full !== vaultRoot && !full.startsWith(vaultRoot + sep)) return null;
    try {
      return readFileSync(full, "utf8");
    } catch {
      return null;
    }
  },
  state: {
    get(key) {
      return syncCall("get", key == null ? null : String(key));
    },
    set(key, value) {
      // Try never changes the box's data: a tried draft's write is said, not done.
      if (W.draft) return void apiLog("not written while tried: " + String(key));
      return syncCall("set", JSON.stringify({ key: String(key), value: value === undefined ? null : value }));
    },
  },
  tool(def) {
    const name = String((def && def.name) != null ? def.name : "");
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,47}$/.test(name)) throw new Error("box.tool: a name of letters, digits, _ or - (at most 48)");
    if (typeof def.handler !== "function") throw new Error("box.tool: a handler function");
    const description = String(def.description == null ? "" : def.description).trim().slice(0, 1000);
    if (!description) throw new Error("box.tool: a description");
    const schema = def.inputSchema != null ? def.inputSchema : def.input_schema != null ? def.input_schema : { type: "object", properties: {} };
    if (!schema || typeof schema !== "object" || schema.type !== "object") throw new Error('box.tool: inputSchema must be a JSON Schema with type "object"');
    if (JSON.stringify(schema).length > 8000) throw new Error("box.tool: inputSchema over 8000 characters");
    const t = { spec: { type: "function", name, description: description + " (box plugin " + id + ".)", inputSchema: JSON.parse(JSON.stringify(schema)) }, handler: def.handler };
    tools.set(name, t);
    post({ t: "reg", what: "tool", spec: t.spec });
    return reg(() => {
      if (tools.get(name) !== t) return;
      tools.delete(name);
      post({ t: "unreg", what: "tool", key: name });
    });
  },
  prompt(text) {
    const s = String(text == null ? "" : text).trim();
    if (s.length > W.promptMax) throw new Error("box.prompt: at most " + W.promptMax + " characters (this is " + s.length + ")");
    post({ t: "prompt", text: s || null, set: true });
    return reg(() => post({ t: "prompt", text: s || null, set: false }));
  },
  hideTool(name) {
    const n = String(name == null ? "" : name);
    if (W.unhideable.includes(n)) throw new Error("box.hideTool: " + n + " cannot be hidden (it is how a box plugin is turned off)");
    post({ t: "reg", what: "hide", key: n });
    return reg(() => post({ t: "unreg", what: "hide", key: n }));
  },
  reply(status, body) {
    return { [REPLY]: true, status: Math.trunc(Number(status)) || 200, body };
  },
  log(...a) {
    apiLog(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  },
};

// A value as the box can take it: as it is, or (a function, a class instance) through JSON.
function send(m) {
  try {
    post(m);
  } catch {
    const j = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
    try {
      if (m.reply) m.reply.body = j(m.reply.body);
      else m.value = j(m.value);
      post(m);
    } catch (e) {
      post({ t: "done", id: m.id, ok: false, error: "its answer is not JSON: " + msg(e) });
    }
  }
}

async function call(m) {
  try {
    const fn = m.kind === "route" ? routes.get(m.key) : tools.has(m.key) ? tools.get(m.key).handler : null;
    if (!fn) throw new Error("no " + m.kind + " " + m.key);
    const out = await (m.kind === "route" ? fn(m.arg) : fn(m.arg, m.ctx));
    if (out && typeof out === "object" && out[REPLY]) send({ t: "done", id: m.id, ok: true, reply: { status: out.status, body: out.body } });
    else send({ t: "done", id: m.id, ok: true, value: out });
  } catch (e) {
    post({ t: "done", id: m.id, ok: false, error: msg(e) });
  }
}

function stop() {
  stopped = true;
  routes.clear();
  tools.clear();
  hooks.clear();
  for (const off of undo.splice(0).reverse()) {
    try {
      off();
    } catch (e) {
      post({ t: "warn", line: "unloading threw: " + msg(e) });
    }
  }
  const globals = {};
  if (W.mirror)
    for (const k of Object.keys(globalThis))
      if (k.startsWith("__box")) {
        try {
          globals[k] = structuredClone(globalThis[k]);
        } catch {}
      }
  post({ t: "stopped", globals });
}

parentPort.on("message", (m) => {
  if (m.t === "ping") post({ t: "pong" });
  else if (m.t === "record") {
    if (!stopped) for (const h of hooks) h(m.r);
  } else if (m.t === "call") void call(m);
  else if (m.t === "stop") stop();
});
process.on("uncaughtException", (e) => post({ t: "fail", why: "threw: " + msg(e) }));
process.on("unhandledRejection", (e) => post({ t: "fail", why: "threw: " + msg(e) }));

post({ t: "hello" });
(async () => {
  try {
    const mod = await import(W.url);
    const activate = typeof mod.activate === "function" ? mod.activate : typeof mod.default === "function" ? mod.default : null;
    if (!activate) throw new Error("it exports no activate(box)");
    const out = await activate(box);
    if (typeof out === "function") undo.push(out);
    post({ t: "active" });
  } catch (e) {
    post({ t: "loadFailed", why: msg(e) });
  }
})();
`;
