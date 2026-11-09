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
// What `ask` covers: POST /api/v1/side (always an ephemeral read-only side session tagged with the page: no
// conversation, no chat-list entry, no writes; `persist` is refused), and reading/stopping the sessions that token
// started. Nothing else is reachable with it.
import { createHmac, createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { LIVE_LIMITS, LIVE_REQUEST_HEADERS, parseLiveManifest, toolAllowed } from "../src/liveBridge";
import { loadConfig } from "./config";
import { phoneToken } from "./auth";
import { withinVault } from "./phoneData";

export type LiveOut = { status: number; body: unknown };
type Claims = { p: string; h: string; c: string[]; e: number; j: string };

const SECRET = randomBytes(32);
const revokedAt = new Map<string, number>();
const sessions = new Map<string, Set<string>>();

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const sign = (payload: string) => createHmac("sha256", SECRET).update(payload).digest("base64url");

/** A vault page's manifest and content hash as it is now. */
export function liveManifest(vault: string, rel: unknown): { caps: string[]; hash: string } | null {
  if (typeof rel !== "string" || !/\.html?$/i.test(rel)) return null;
  const full = withinVault(vault, rel);
  if (!full) return null;
  try {
    if (statSync(full).size > 8 * 1024 * 1024) return null;
    const html = readFileSync(full, "utf8");
    const caps = parseLiveManifest(html);
    return caps.length ? { caps, hash: createHash("sha256").update(html).digest("hex") } : null;
  } catch {
    return null;
  }
}

export function liveToken(vault: string, b: { path?: unknown; hash?: unknown; caps?: unknown }): LiveOut {
  const m = liveManifest(vault, b.path);
  if (!m) return { status: 404, body: { error: "not a live page" } };
  const caps = Array.isArray(b.caps) ? b.caps.map(String).sort() : [];
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

/** A page's call, checked against its token's capabilities, then answered by this same server over loopback. */
export async function liveGateway(vault: string, vaultParam: string | null, b: Record<string, unknown>): Promise<LiveOut> {
  const c = claimsOf(vault, b.token);
  if (!c) return { status: 401, body: { error: "the page's token is not valid (expired, revoked, or the page changed)" } };
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
    if (c.c.includes("ask")) {
      const side = /^\/api\/v1\/side(?:\/([A-Za-z0-9_-]{1,120})(\/stop)?)?(?:\?(.*))?$/.exec(path);
      if (side) {
        const [, sid, stop, query] = side;
        if (!sid && method === "POST") {
          let req: Record<string, unknown> = {};
          try {
            req = JSON.parse(body?.toString("utf8") || "{}");
          } catch {
            return { status: 400, body: { error: "bad JSON" } };
          }
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
      }
    }
    // Step 2: registered tools (`tool:<name>`). Until a tool route exists no capability opens anything else.
    if (c.c.some((x) => x.startsWith("tool:")) && path === "/api/v2/live/tool" && method === "POST") {
      let req: Record<string, unknown> = {};
      try {
        req = JSON.parse(body?.toString("utf8") || "{}");
      } catch {
        return { status: 400, body: { error: "bad JSON" } };
      }
      const name = typeof req.name === "string" ? req.name : "";
      if (!toolAllowed(c.c, name)) return { status: 403, body: { error: `this page was not allowed to use the tool ${name || "(none)"}` } };
      return { status: 501, body: { error: "tool calls are not available yet" } };
    }
  } catch (e) {
    return { status: 502, body: { error: String((e as Error)?.message ?? e) } };
  }
  return { status: 403, body: { error: "this page was not allowed to do that" } };
}
