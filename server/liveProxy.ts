// Live pages (src/liveBridge.ts), the box's side. A page declares capabilities in a manifest
// (<meta name="vc-capabilities" content="ask, mic">); the host app shows Carl a one-time grant and asks for a short-lived
// token scoped to (page path, content hash, capabilities); every call the page makes arrives at /api/v2/live/fetch
// with that token and is allowed only if the token's capabilities cover it. No path prefix list: the token is the scope.
//
//   POST /api/v2/live/manifest {path}                 → {caps, hash}   (the file as it is now; 404: not a live page)
//   POST /api/v2/live/token {path, hash, caps}        → {token, exp}   (refused if the file changed since `hash`)
//   POST /api/v2/live/revoke {path}                   → {ok}           (that page's tokens stop working at once)
//   POST /api/v2/live/fetch {token, path, method, headers?, bodyBase64?} → {ok, status, headers, bodyBase64}
//
// Which routes a capability opens is declared once, in the service registry (src/liveServices.ts): the gateway hands a
// call to a granted service whose declared routes match it, through that service's handler here (HANDLERS), else 403.
// What `voice-lab` (tool:voice-lab.*) covers: /api/v2/lab/{engines,tts,stt,voices} (server/labProxy.ts), nothing else.
// What `ask` covers: POST /api/v1/side (always an ephemeral read-only side session tagged with the page: no
// conversation, no chat-list entry, no writes; `persist` is refused), and reading/stopping the sessions that token
// started. Nothing else is reachable with it.
// What `state` and `log` cover (change 1.2, server/pluginState.ts): GET/POST /api/v2/plugin/state and POST
// /api/v2/plugin/log, always for the token's own page (the plugin id), never another; records in the one log.
// What `converse` covers (change 1.3, src/pluginConverse.ts): POST /api/v2/intent of type start or send only (made into
// the box's own send intent, marked as the page's), GET /api/v2/conversations and GET /api/v2/conversations/<id>/events.
// What `catalog` covers (change 1.4, server/pluginCatalog.ts): GET /api/v2/plugin/catalog, the services and plugins.
import { createHmac, createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { LIVE_LIMITS, LIVE_REQUEST_HEADERS, allowRate, parseLiveNeeds } from "../src/liveBridge";
import { LIVE_SERVICES, serviceOfCap, type LiveService } from "../src/liveServices";
import { loadConfig } from "./config";
import { phoneToken } from "./auth";
import { withinVault } from "./phoneData";
import { labCall } from "./labProxy";
import { PLUGIN_LIMITS, stateQuery } from "../src/pluginRecords";
import { appendPluginLog, awaitPluginState, setPluginState } from "./pluginState";
import { converseAfter, converseIntent } from "../src/pluginConverse";
import { pluginCatalog } from "./pluginCatalog";

export type LiveOut = { status: number; body: unknown };
type Claims = { p: string; h: string; c: string[]; e: number; j: string };

const SECRET = randomBytes(32);
const revokedAt = new Map<string, number>();
const sessions = new Map<string, Set<string>>();

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const sign = (payload: string) => createHmac("sha256", SECRET).update(payload).digest("base64url");

/** A vault page's manifest and content hash as it is now; `refused`: service names it declares that no registry entry knows. */
export function liveManifest(vault: string, rel: unknown): { caps: string[]; hash: string; refused?: string[] } | null {
  if (typeof rel !== "string" || !/\.html?$/i.test(rel)) return null;
  const full = withinVault(vault, rel);
  if (!full) return null;
  try {
    if (statSync(full).size > 8 * 1024 * 1024) return null;
    const html = readFileSync(full, "utf8");
    const { caps, refused } = parseLiveNeeds(html);
    if (!caps.length && !refused.length) return null;
    const hash = createHash("sha256").update(html).digest("hex");
    return refused.length ? { caps, hash, refused } : { caps, hash };
  } catch {
    return null;
  }
}

export function liveToken(vault: string, b: { path?: unknown; hash?: unknown; caps?: unknown }): LiveOut {
  const m = liveManifest(vault, b.path);
  const caps = Array.isArray(b.caps) ? b.caps.map(String).sort() : [];
  const unknown = caps.find((c) => !serviceOfCap(c));
  if (unknown) return { status: 403, body: { error: `no such service: ${unknown}` } };
  if (!m || !m.caps.length) return { status: 404, body: { error: "not a live page" } };
  if (b.hash !== m.hash || caps.join(",") !== m.caps.join(",")) return { status: 409, body: { error: "the page changed since it was allowed" } };
  const exp = Date.now() + LIVE_LIMITS.tokenSeconds * 1000;
  const claims: Claims = { p: String(b.path), h: m.hash, c: caps, e: exp, j: randomUUID() };
  const payload = b64(JSON.stringify(claims));
  return { status: 200, body: { token: `${payload}.${sign(payload)}`, exp } };
}

export function liveRevoke(b: { path?: unknown }): LiveOut {
  if (typeof b.path !== "string" || !b.path) return { status: 400, body: { error: "missing path" } };
  revokedAt.set(b.path, Date.now());
  return { status: 200, body: { ok: true } };
}

/** The token's claims when it is genuine, unexpired, not revoked and the page is still the page that was allowed. */
function claimsOf(vault: string, token: unknown): Claims | null {
  if (typeof token !== "string") return null;
  const [payload, mac] = token.split(".");
  if (!payload || !mac) return null;
  const want = Buffer.from(sign(payload));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  let c: Claims;
  try {
    c = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!c || typeof c.p !== "string" || !Array.isArray(c.c) || typeof c.e !== "number" || c.e < Date.now()) return null;
  if ((revokedAt.get(c.p) ?? 0) >= c.e - LIVE_LIMITS.tokenSeconds * 1000) return null;
  if (liveManifest(vault, c.p)?.hash !== c.h) return null;
  return c;
}

type Upstream = { status: number; headers: Record<string, string>; body: Buffer };

function loopback(method: string, path: string, headers: Record<string, string>, payload: Buffer | null, vault: string | null): Promise<Upstream> {
  const cfg = loadConfig();
  const token = phoneToken();
  const h = { ...headers, ...(token ? { "x-vault-token": token } : {}), ...(payload ? { "content-length": String(payload.length) } : {}) };
  const target = vault && !path.includes("vault=") ? `${path}${path.includes("?") ? "&" : "?"}vault=${encodeURIComponent(vault)}` : path;
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port: cfg.port, path: target, method, headers: h, timeout: 120_000 }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > LIVE_LIMITS.responseBytes) {
          req.destroy();
          reject(new Error("response too large"));
          return;
        }
        chunks.push(c);
      });
      res.on("end", () => {
        const out: Record<string, string> = {};
        for (const k of ["content-type", "content-disposition"]) if (typeof res.headers[k] === "string") out[k] = res.headers[k] as string;
        resolve({ status: res.statusCode ?? 502, headers: out, body: Buffer.concat(chunks) });
      });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("the box did not answer in time")));
    req.on("error", reject);
    req.end(payload ?? undefined);
  });
}

const reply = (u: Upstream): LiveOut => ({ status: 200, body: { ok: true, status: u.status, headers: u.headers, bodyBase64: u.body.toString("base64") } });
const json = (status: number, v: unknown): Upstream => ({ status, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(v)) });

/** One call a granted service's route matched: what its handler gets. */
type Call = { vault: string; c: Claims; own: Set<string>; method: "GET" | "POST"; path: string; headers: Record<string, string>; body: Buffer | null; vaultParam: string | null };
/** A service's box side: its answer, or null when it does not take this call after all (the gateway goes on, then 403). */
type Handler = (call: Call) => Promise<LiveOut | null>;

/** `ask`: a new ephemeral read-only ask, or reading/stopping a session this same token started. */
const askHandler: Handler = async ({ c, own, method, path, body, vaultParam }) => {
  const side = /^\/api\/v1\/side(?:\/([A-Za-z0-9_-]{1,120})(\/stop)?)?(?:\?(.*))?$/.exec(path);
  if (!side) return null;
  const [, sid, stop, query] = side;
  if (!sid && method === "POST") {
    let req: Record<string, unknown> = {};
    try {
      req = JSON.parse(body?.toString("utf8") || "{}");
    } catch {
      return { status: 400, body: { error: "bad JSON" } };
    }
    // An ask is always ephemeral (`persist` opens nothing, src/liveServices.ts): a page starts real chats with `converse`.
    if (req.persist) return { status: 403, body: { error: "this box does not start conversations for pages yet; an ask is ephemeral" } };
    const text = typeof req.text === "string" ? req.text : "";
    const system = typeof req.system === "string" ? req.system : "";
    if (!text.trim()) return { status: 400, body: { error: "missing text" } };
    if (text.length > LIVE_LIMITS.promptChars || system.length > LIVE_LIMITS.systemChars) return { status: 413, body: { error: "ask too large" } };
    // Only these fields, whatever else the page sent: always an ephemeral ask tagged with the page.
    const up = await loopback("POST", "/api/v1/side", { "content-type": "application/json" }, Buffer.from(JSON.stringify({ kind: "ask", text, system, page: c.p })), vaultParam);
    try {
      const id = JSON.parse(up.body.toString("utf8"))?.id;
      if (typeof id === "string") own.add(id);
    } catch {
      /* an error body */
    }
    return reply(up);
  }
  if (sid && !own.has(sid)) return { status: 403, body: { error: "not a session this page started" } };
  if (sid && stop && method === "POST") return reply(await loopback("POST", `/api/v1/side/${sid}/stop`, { "content-type": "application/json" }, Buffer.from("{}"), vaultParam));
  if (sid && !stop && method === "GET") {
    const q = new URLSearchParams(query ?? "");
    const num = (k: string, d: number) => (Number.isFinite(Number(q.get(k))) ? Math.trunc(Number(q.get(k))) : d);
    const up = await loopback("GET", `/api/v1/side/${sid}?after=${num("after", -1)}&wait=${Math.max(0, Math.min(num("wait", 20_000), 25_000))}`, {}, null, vaultParam);
    try {
      const j = JSON.parse(up.body.toString("utf8"));
      if (typeof j?.text === "string" && j.text.length > LIVE_LIMITS.replyChars) {
        j.text = j.text.slice(0, LIVE_LIMITS.replyChars);
        j.done = true;
        return reply(json(up.status, j));
      }
    } catch {
      /* pass the body through */
    }
    return reply(up);
  }
  return null;
};

/** `voice-lab`: /api/v2/lab/<op> to the one local lab service (server/labProxy.ts: fixed operations, methods, parameters). */
const voiceLabHandler: Handler = async ({ c, method, path, headers, body }) => {
  const out = await labCall(c.c, method, path, headers, body);
  return out ? reply(out) : null;
};

/** Writes per page path in the last minute (state sets and log appends together). */
const writeTimes = new Map<string, number[]>();
const tooMany = (page: string): LiveOut | null => {
  let times = writeTimes.get(page);
  if (!times) writeTimes.set(page, (times = []));
  return allowRate(times, PLUGIN_LIMITS.writesPerMinute) ? null : { status: 429, body: { error: `at most ${PLUGIN_LIMITS.writesPerMinute} writes a minute` } };
};
const written = (w: ReturnType<typeof setPluginState>): LiveOut => ("error" in w ? { status: w.status, body: { error: w.error } } : reply(json(200, { ok: true, seq: w.seq })));

/** The plugin a token's page is: its vault path, spelled one way whichever view (viewer, chat, phone) asked. */
const pluginId = (page: string) => page.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");

/** `state`: the token's page reads its state (GET, `?after=<seq>&wait=<ms>`: when it changes) or sets one key (POST). */
const stateHandler: Handler = async ({ vault, c, method, path, body }) => {
  const m = /^\/api\/v2\/plugin\/state(?:\?(.*))?$/.exec(path);
  if (!m) return null;
  if (method === "GET") {
    const { after, wait } = stateQuery(m[1] ?? "");
    return reply(json(200, await awaitPluginState(vault, pluginId(c.p), after, wait)));
  }
  return tooMany(pluginId(c.p)) ?? written(setPluginState(vault, pluginId(c.p), body?.toString("utf8") ?? ""));
};

/** `log`: the token's page appends one record (the body) to the log. */
const logHandler: Handler = async ({ vault, c, method, path, body }) => {
  if (method !== "POST" || path !== "/api/v2/plugin/log") return null;
  return tooMany(pluginId(c.p)) ?? written(appendPluginLog(vault, pluginId(c.p), body?.toString("utf8") ?? ""));
};

/** `converse`: start a chat or send to one (the box's own send intent, marked as the page's), list the chats, read one. */
const converseHandler: Handler = async ({ c, method, path, body, vaultParam }) => {
  if (method === "GET" && path === "/api/v2/conversations") return reply(await loopback("GET", path, {}, null, vaultParam));
  const ev = /^\/api\/v2\/conversations\/([A-Za-z0-9_-]{1,120})\/events(?:\?(.*))?$/.exec(path);
  if (ev && method === "GET") return reply(await loopback("GET", `/api/v2/conversations/${ev[1]}/events?after=${converseAfter(ev[2] ?? "")}`, {}, null, vaultParam));
  if (method !== "POST" || path !== "/api/v2/intent") return null;
  const page = pluginId(c.p);
  const made = converseIntent(page, body?.toString("utf8") ?? "", randomUUID);
  if ("error" in made) return { status: made.status, body: { error: made.error } };
  const busy = tooMany(page);
  if (busy) return busy;
  if (made.kind === "send") {
    // Into a chat that exists (an unknown id would make a new one: that is start).
    const there = await loopback("GET", `/api/v2/conversations/${made.intent.convId}/events?after=${Number.MAX_SAFE_INTEGER}`, {}, null, vaultParam);
    if (there.status === 404) return { status: 404, body: { error: "no such conversation" } };
  }
  return reply(await loopback("POST", "/api/v2/intent", { "content-type": "application/json" }, Buffer.from(JSON.stringify(made.intent)), vaultParam));
};

/** `catalog`: the registered services and the vault's plugins (read-only). */
const catalogHandler: Handler = async ({ vault, method, path }) => (method === "GET" && path === "/api/v2/plugin/catalog" ? reply(json(200, pluginCatalog(vault))) : null);

/** The box side of every registered box service that opens routes (src/liveServices.ts). */
export const HANDLERS: Readonly<Record<string, Handler>> = { ask: askHandler, "voice-lab": voiceLabHandler, state: stateHandler, log: logHandler, converse: converseHandler, catalog: catalogHandler };

/** The services a call may go to: granted by the token, opened by the box, with a declared route matching the call. */
function servicesTaking(c: Claims, method: "GET" | "POST", path: string): LiveService[] {
  return LIVE_SERVICES.filter(
    (s) => s.supplier === "box" && s.grantable && c.c.some((cap) => s.owns(cap)) && s.routes.some((r) => r.methods.includes(method) && r.path.test(path)),
  );
}

/** A page's call, checked against its token's capabilities, then answered by this same server over loopback. */
export async function liveGateway(vault: string, vaultParam: string | null, b: Record<string, unknown>): Promise<LiveOut> {
  const c = claimsOf(vault, b.token);
  if (!c) return { status: 401, body: { error: "the page's token is not valid (expired, revoked, or the page changed)" } };
  const unknown = c.c.find((cap) => !serviceOfCap(String(cap)));
  if (unknown) return { status: 403, body: { error: `no such service: ${unknown}` } };
  const method = b.method === "GET" || b.method === "POST" ? b.method : null;
  if (!method) return { status: 405, body: { error: "GET or POST only" } };
  const path = typeof b.path === "string" && b.path.length < 2000 && !/[\\\u0000-\u001f]/.test(b.path) ? b.path : null;
  if (!path) return { status: 400, body: { error: "bad path" } };
  const headers: Record<string, string> = {};
  if (b.headers && typeof b.headers === "object") {
    for (const [k, v] of Object.entries(b.headers as Record<string, unknown>)) {
      if (LIVE_REQUEST_HEADERS.includes(k.toLowerCase()) && typeof v === "string" && v.length < 300 && !/[\r\n]/.test(v)) headers[k.toLowerCase()] = v;
    }
  }
  let body: Buffer | null = null;
  if (typeof b.bodyBase64 === "string" && b.bodyBase64) {
    if (b.bodyBase64.length > LIVE_LIMITS.requestBytes * 1.4) return { status: 413, body: { error: "request body too large" } };
    body = Buffer.from(b.bodyBase64, "base64");
    if (body.length > LIVE_LIMITS.requestBytes) return { status: 413, body: { error: "request body too large" } };
  }
  const own = sessions.get(c.j) ?? new Set<string>();
  sessions.set(c.j, own);
  try {
    // In registry order (ask, then voice-lab): the first service that takes the call answers it.
    for (const s of servicesTaking(c, method, path)) {
      const out = await HANDLERS[s.name]?.({ vault, c, own, method, path, headers, body, vaultParam });
      if (out) return out;
    }
  } catch (e) {
    return { status: 502, body: { error: String((e as Error)?.message ?? e) } };
  }
  return { status: 403, body: { error: "this page was not allowed to do that" } };
}
