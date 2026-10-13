// The box's HTTP surface: the phone routes ported from voice_server.rs (same
// paths, methods, JSON shapes), git smart HTTP, and /api/v1/*. Mutations are
// relayed in-process to phoneApp's `phone:*` handlers (bus.relay), exactly
// the relay_request pattern the Rust server used.
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, SERVER_VERSION, SERVER_REV } from "./config";
import { authorize, phoneToken } from "./auth";
import { relay, emitLocal } from "./bus";
import { getRing } from "./ring";
import { conversationsSummary, conversationDetail, notificationsFeed, notesFeed, withinVault, mimeFor, dispatchVoiceTool } from "./phoneData";
import { notificationAppend, pushSubsAdd, pushSubsRemove, vapidPublicKey } from "./commands/phone";
import { isGitPath, handleGitHttp } from "./gitHttp";
import { validVaultName } from "./sync";
import { validKeyName } from "./keys";
import { projectsList, setProject } from "./projectRoutes";
import { voiceTool, voiceSession, type VoiceDeps } from "./voice";
import PHONE_PAGE_INLINE from "../src-tauri/assets/phone.html";
import VOICE_PAGE_INLINE from "../src-tauri/assets/voice.html";
import PHONE_SW_INLINE from "../src-tauri/assets/phone-sw.js?raw";
import ICON_PNG_INLINE from "../src-tauri/assets/icon-apple-touch.png";
import PHONE_APP from "vc:phone-app";

export type ServerHooks = {
  health: () => Promise<Record<string, unknown>>;
  syncStatus: () => unknown;
  alert: (title: string, body: string, tag?: string) => Promise<number>;
  onGitPushed: (vault: string) => void;
  /** Settings → Box on the laptop: this box's vaults, and its own OpenRouter key. */
  vaults?: { list: () => unknown; add: (name: string) => Promise<Record<string, unknown>> };
  setKeys?: (keys: Record<string, string>) => Promise<boolean>;
  /** The engine takes these routes; a handler returning null hands the
   * request to the legacy relay (old mission threads). */
  engine?: {
    models: () => unknown;
    /** The box's own models (chat, vision fallback, subagent child) and their checks. */
    boxModels?: () => unknown;
    message: (b: any) => Promise<Record<string, unknown> | null>;
    answer: (b: any) => Promise<Record<string, unknown> | null>;
    kill: (b: any) => Promise<Record<string, unknown> | null>;
    subagent: (convId: string, sid: string, op: "steer" | "stop", b: any) => Promise<Record<string, unknown>>;
  };
  /** Voice: the ElevenLabs agent's tools run here (server/voice.ts). */
  voice?: VoiceDeps;
};

// Idempotency for engine sends: the phone tags each POST with clientMsgId and
// a flaky network can deliver it twice; a duplicate gets the first result.
const engineSends = new Map<string, Promise<Record<string, unknown> | null>>();
function dedupe(id: unknown, fn: () => Promise<Record<string, unknown> | null>): Promise<Record<string, unknown> | null> {
  if (typeof id !== "string" || !id) return fn();
  const hit = engineSends.get(id);
  if (hit) return hit;
  const p = fn();
  engineSends.set(id, p);
  p.then(
    (r) => (r && (r as any).error ? engineSends.delete(id) : setTimeout(() => engineSends.delete(id), 60_000).unref?.()),
    () => engineSends.delete(id),
  );
  return p;
}

/** Engine first; null → the legacy relay. */
async function engineRoute(
  res: ServerResponse,
  handler: ((b: any) => Promise<Record<string, unknown> | null>) | undefined,
  body: any,
  event: string,
  timeoutMs: number,
  fail: string,
  after?: (out: Record<string, unknown>) => void,
): Promise<void> {
  if (handler) {
    const out = await dedupe(body?.clientMsgId, () => handler(body)).catch((e) => ({ error: String((e as Error)?.message ?? e) }));
    if (out) {
      if (!(out as any).error) after?.(out);
      return json(res, 200, out);
    }
  }
  return relayRoute(res, event, body, timeoutMs, fail);
}

// voice_server.rs:45 PHONE_MANIFEST / 62 ICON_SVG
const PHONE_MANIFEST = `{
  "name": "vault-chat",
  "short_name": "vault-chat",
  "display": "standalone",
  "background_color": "#000000",
  "theme_color": "#000000",
  "icons": [
    { "src": "/apple-touch-icon.png", "sizes": "512x512", "type": "image/png", "purpose": "any" }
  ]
}`;
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#000000"/><g fill="none" stroke="#ffffff" stroke-linecap="round" stroke-linejoin="round"><path d="M348.5 382.2A150 150 0 1 1 348.5 127.8" stroke-width="43"/><path d="M226 195L271 333 312 195" stroke-width="38"/></g></svg>`;

/** Assets are inlined in the bundle; VC_ASSETS_DIR overrides them (dev). */
function asset(name: string, inline: string | Uint8Array): string | Buffer {
  const dir = process.env.VC_ASSETS_DIR;
  if (dir) {
    try {
      return typeof inline === "string" ? readFileSync(join(dir, name), "utf8") : readFileSync(join(dir, name));
    } catch {
      /* fall back to the inlined copy */
    }
  }
  return typeof inline === "string" ? inline : Buffer.from(inline);
}

const NO_STORE = "no-store, must-revalidate"; // voice_server.rs:242

/** The phone page: the bundled app's index.html when the bundle carries it
 * (build.mjs --phone-app), else phone.html. Either way never cached. */
function phonePage(): string | Buffer {
  const app = PHONE_APP["index.html"];
  return app ? Buffer.from(app, "base64") : asset("phone.html", PHONE_PAGE_INLINE);
}
const ASSET_MIME: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function send(res: ServerResponse, status: number, mime: string, body: string | Buffer, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": mime, "Cache-Control": NO_STORE, ...extra });
  res.end(body);
}
function json(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, "application/json", typeof body === "string" ? body : JSON.stringify(body));
}

function readBody(req: IncomingMessage, limit = 20 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function jsonBody(req: IncomingMessage): Promise<any> {
  try {
    const v = JSON.parse(await readBody(req));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/** POST → relay → the app's answer, 503 if it doesn't answer (voice_server.rs
 * relay routes). */
async function relayRoute(res: ServerResponse, event: string, payload: Record<string, unknown>, timeoutMs: number, fail: string): Promise<void> {
  const out = await relay(event, payload, timeoutMs);
  if (out) json(res, 200, out);
  else json(res, 503, { error: fail });
}

export function startHttpServer(hooks: ServerHooks): Promise<Server> {
  const cfg = loadConfig();
  const server = createServer((req, res) => {
    handle(req, res, hooks).catch((e) => {
      console.error("[http] handler error:", e);
      if (!res.headersSent) json(res, 500, { error: String((e as Error)?.message ?? e) });
      else res.end();
    });
  });
  // Long-polls hold for 25 s; don't let node's defaults cut them.
  server.requestTimeout = 0;
  server.headersTimeout = 70_000;
  // Outlive client/proxy idle pools so a reused keep-alive socket is never
  // closed under a request (ECONNRESET on the next call).
  server.keepAliveTimeout = 65_000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.port, cfg.host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, hooks: ServerHooks): Promise<void> {
  const cfg = loadConfig();
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";
  const vault = cfg.vault;

  // ---- token-free routes (voice_server.rs:783-823) ----
  if (path === "/health") return json(res, 200, { ok: true });
  if (path === "/icon.svg") return send(res, 200, "image/svg+xml", ICON_SVG);
  if (path === "/icon.png" || path === "/apple-touch-icon.png" || path === "/apple-touch-icon-precomposed.png") {
    return send(res, 200, "image/png", asset("icon-apple-touch.png", ICON_PNG_INLINE));
  }
  if (path === "/phone-sw.js") return send(res, 200, "application/javascript; charset=utf-8", asset("phone-sw.js", PHONE_SW_INLINE));
  if (path === "/manifest.webmanifest") return send(res, 200, "application/manifest+json", PHONE_MANIFEST);
  if (path === "/phone" && method === "GET") {
    // voice_server.rs:276 resp_phone_shell — provisions the token cookie.
    const t = phoneToken();
    const extra: Record<string, string> = {};
    if (t) extra["Set-Cookie"] = `vc_token=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=34560000`;
    return send(res, 200, "text/html; charset=utf-8", phonePage(), extra);
  }
  if (path.startsWith("/phone/assets/") && method === "GET") {
    // The phone app's hashed files: immutable, so cached for good.
    const f = PHONE_APP[path.slice("/phone/".length)];
    if (!f) return json(res, 404, { error: "not found" });
    const ext = path.slice(path.lastIndexOf("."));
    return send(res, 200, ASSET_MIME[ext] ?? "application/octet-stream", Buffer.from(f, "base64"), { "Cache-Control": "public, max-age=31536000, immutable" });
  }

  const auth = authorize(req, url);
  if (!auth.ok) return json(res, 401, { error: "unauthorized" });

  if (isGitPath(path)) {
    const user = String(req.headers["tailscale-user-login"] ?? auth.via ?? "local");
    return handleGitHttp(req, res, url, user, hooks.onGitPushed);
  }

  // ---- /api/v1 ----
  if (path === "/api/v1/health" && method === "GET") return json(res, 200, await hooks.health());
  if (path === "/api/v1/sync" && method === "GET") return json(res, 200, hooks.syncStatus());
  if (path === "/api/v1/alert" && method === "POST") {
    const b = await jsonBody(req);
    const title = String(b.title ?? "").trim();
    const body = String(b.body ?? "").trim();
    if (!title && !body) return json(res, 400, { error: "alert needs a title or body" });
    const sent = await hooks.alert(title || "vault-chat", body, typeof b.tag === "string" ? b.tag : undefined);
    return json(res, 200, { ok: true, sent });
  }

  // Settings → Box on the laptop. Each vault is added on its own; the box only
  // has the vaults someone added.
  if (path === "/api/v1/vaults" && method === "GET") {
    return hooks.vaults ? json(res, 200, { vaults: hooks.vaults.list() }) : json(res, 503, { error: "vaults not available" });
  }
  if (path === "/api/v1/vaults" && method === "POST") {
    if (!hooks.vaults) return json(res, 503, { error: "vaults not available" });
    const b = await jsonBody(req);
    if (!validVaultName(b.name)) return json(res, 400, { error: "invalid vault name (letters, digits, . _ -, up to 64; not starting with a dot)" });
    try {
      return json(res, 200, { ok: true, ...(await hooks.vaults.add(b.name)) });
    } catch (e) {
      return json(res, 500, { error: String((e as Error)?.message ?? e) });
    }
  }
  // The laptop's keychain, the whole set ({name: value}); a name missing here
  // is removed. Stored in the box's own key store. Never echoed.
  if (path === "/api/v1/keys" && method === "POST") {
    if (!hooks.setKeys) return json(res, 503, { error: "keys not available" });
    const b = await jsonBody(req);
    const keys = b.keys;
    if (!keys || typeof keys !== "object" || Array.isArray(keys)) return json(res, 400, { error: "keys: a {name: value} map is required" });
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(keys)) {
      if (!validKeyName(k)) return json(res, 400, { error: `invalid key name: ${k.slice(0, 80)}` });
      if (typeof v !== "string" || !v.trim() || v.length > 4096) return json(res, 400, { error: `invalid value for ${k}` });
      clean[k] = v.trim();
    }
    try {
      const changed = await hooks.setKeys(clean);
      return json(res, 200, { ok: true, changed, names: Object.keys(clean).sort() });
    } catch (e) {
      return json(res, 500, { error: String((e as Error)?.message ?? e) });
    }
  }

  // Model capabilities for Settings → Models.
  if (path === "/api/v1/models" && method === "GET") {
    return hooks.engine ? json(res, 200, { models: hooks.engine.models(), ...(hooks.engine.boxModels ? { box: hooks.engine.boxModels() } : {}) }) : json(res, 503, { error: "engine not running" });
  }
  // Steer or stop one running subagent of a conversation.
  const subM = /^\/api\/v1\/conversations\/([^/]+)\/subagents\/([^/]+)\/(steer|stop)$/.exec(path);
  if (subM && method === "POST") {
    if (!hooks.engine) return json(res, 503, { error: "engine not running" });
    const out = await hooks.engine.subagent(decodeURIComponent(subM[1]!), decodeURIComponent(subM[2]!), subM[3] as "steer" | "stop", await jsonBody(req));
    return json(res, out.ok ? 200 : 409, out);
  }


  // Voice (server/voice.ts): the laptop in box mode and the phone run the
  // voice agent's tools here; the session is minted with the box's key.
  if (path === "/api/v1/voice/tool" && method === "POST") {
    if (!hooks.voice) return json(res, 503, { error: "voice tools not available" });
    return json(res, 200, await voiceTool(hooks.voice, await jsonBody(req)));
  }
  if (path === "/api/v1/voice/session" && method === "GET") {
    const out = await voiceSession(url.searchParams.get("convId"));
    return json(res, out.status, out.body);
  }

  const q = (k: string) => url.searchParams.get(k) ?? "";

  switch (`${method} ${path}`) {
    case "GET /voice":
      return send(res, 200, "text/html; charset=utf-8", asset("voice.html", VOICE_PAGE_INLINE));
    case "GET /phone":
      return send(res, 200, "text/html; charset=utf-8", phonePage());
    case "GET /conversations":
      return json(res, 200, conversationsSummary(vault));
    case "GET /surface": {
      const id = q("id");
      if (id) void relay("phone:surface", { convId: id }, 4000);
      return json(res, 200, { ok: true });
    }
    case "GET /conversation": {
      const n = parseInt(q("n"), 10);
      const c = conversationDetail(vault, q("id"), Number.isFinite(n) ? n : 60, q("full") === "1");
      return c ? json(res, 200, c) : json(res, 404, { error: "conversation not found" });
    }
    case "GET /file":
      return serveVaultFile(res, vault, url);
    case "GET /poll":
      return poll(res, url);
    case "GET /notifications":
      return json(res, 200, notificationsFeed(vault));
    case "GET /notes":
      return json(res, 200, notesFeed(vault));
    case "POST /notes":
      return relayRoute(res, "phone:note", await jsonBody(req), 10_000, "app not answering");
    case "POST /client-event":
      await relay("phone:client-event", await jsonBody(req), 5000);
      return json(res, 200, { ok: true });
    case "POST /notes/status":
      return relayRoute(res, "phone:note-status", await jsonBody(req), 10_000, "app not answering");
    case "POST /notes/edit":
      return relayRoute(res, "phone:note-edit", await jsonBody(req), 10_000, "app not answering");
    case "POST /notes/clear-resolved":
      return relayRoute(res, "phone:notes-clear-resolved", await jsonBody(req), 10_000, "app not answering");
    case "POST /notifications/read":
    case "POST /notifications/hide": {
      const b = await jsonBody(req);
      if (typeof b.id !== "string") return json(res, 400, { error: "missing id or vault" });
      const type = path.endsWith("/read") ? "read" : "hide";
      notificationAppend(vault, JSON.stringify({ type, id: b.id, ts: Date.now() }));
      return json(res, 200, { ok: true });
    }
    case "POST /notifications/clear":
      notificationAppend(vault, JSON.stringify({ type: "clear", ts: Date.now() }));
      return json(res, 200, { ok: true });
    case "POST /decision-record": {
      // voice_server.rs:1023
      const b = await jsonBody(req);
      const answer = String(b.answer ?? "").trim();
      if (!answer) return json(res, 400, { error: "missing answer or vault" });
      const ts = Date.now();
      const id = `dec-${ts.toString(16)}`;
      const rec: Record<string, unknown> = {
        id,
        ts,
        kind: "ask",
        title: [...String(b.title ?? "Inline decision")].slice(0, 90).join(""),
        body: [...String(b.question ?? "")].slice(0, 600).join(""),
        intention: "Your call · decided in-conversation",
      };
      if (typeof b.convId === "string" && b.convId) rec.convId = b.convId;
      notificationAppend(vault, JSON.stringify(rec));
      notificationAppend(vault, JSON.stringify({ type: "answered", id, answer: [...answer].slice(0, 200).join(""), ts }));
      return json(res, 200, { ok: true });
    }
    case "GET /schedules":
      return relayRoute(res, "phone:schedules", {}, 10_000, "app not answering — is a vault open?");
    case "POST /schedule":
      return relayRoute(res, "phone:schedule", await jsonBody(req), 10_000, "app not answering");
    case "GET /status":
      return relayRoute(res, "phone:status", {}, 10_000, "app not answering — is a vault open?");
    case "POST /message": {
      const b = await jsonBody(req);
      return engineRoute(res, hooks.engine?.message, b, "phone:msg", 15_000, "app not answering — is a vault open?");
    }
    case "POST /answer": {
      const b = await jsonBody(req);
      return engineRoute(res, hooks.engine?.answer, b, "phone:answer", 15_000, "app not answering — is a vault open?", () => {
        // The alert card's decision record, as the old /answer wrote it.
        if (typeof b.notifId === "string" && b.notifId) {
          const answer = b.defer ? "Not now" : String(b.text ?? "");
          notificationAppend(vault, JSON.stringify({ type: "answered", id: b.notifId, answer: [...answer].slice(0, 160).join(""), ts: Date.now() }));
          getRing().push(JSON.stringify({ type: "notif" }));
        }
      });
    }
    case "POST /kill":
      return engineRoute(res, hooks.engine?.kill, await jsonBody(req), "phone:kill", 10_000, "app not answering");
    case "POST /chats/clear":
      return relayRoute(res, "phone:clearchats", {}, 15_000, "app not answering");
    case "GET /push/vapid": {
      const k = vapidPublicKey();
      return k ? json(res, 200, { key: k }) : json(res, 503, { error: "push not initialized yet" });
    }
    case "POST /push/subscribe": {
      const b = await jsonBody(req);
      const sub = b.subscription ?? b;
      if (typeof sub?.endpoint !== "string") return json(res, 400, { error: "missing endpoint" });
      pushSubsAdd(sub);
      return json(res, 200, { ok: true });
    }
    case "POST /push/unsubscribe": {
      const b = await jsonBody(req);
      if (typeof b.endpoint === "string") pushSubsRemove(b.endpoint);
      return json(res, 200, { ok: true });
    }
    case "POST /push/test":
      return relayRoute(res, "phone:pushtest", {}, 15_000, "app not answering");
    case "POST /session": {
      // The old phone page's session call: the same as GET /api/v1/voice/session.
      const out = await voiceSession(String((await jsonBody(req)).convId ?? "") || null);
      return json(res, out.status, out.body);
    }
    case "POST /voice-transcript": {
      const b = await jsonBody(req);
      if (String(b.text ?? "").trim()) emitLocal("voice:transcript", { role: b.role ?? "assistant", text: b.text });
      return json(res, 200, { ok: true });
    }
    case "POST /tool": {
      // The old phone page's tool call: the full box set when voice is wired, else read-only.
      const raw = await readBody(req);
      if (!hooks.voice) return send(res, 200, "text/plain; charset=utf-8", await dispatchVoiceTool(vault, raw));
      let b: any = {};
      try {
        b = JSON.parse(raw);
      } catch {
        /* empty */
      }
      return send(res, 200, "text/plain; charset=utf-8", (await voiceTool(hooks.voice, b)).result);
    }
    // Projects: the chat chip and "New chat in project" (desktop box mode, phone).
    case "GET /projects":
      return json(res, 200, projectsList(vault));
    case "POST /conversation/project": {
      const b = await jsonBody(req);
      const out = await setProject(vault, b);
      if ("ok" in out) getRing().push(JSON.stringify({ type: "project", convId: b.convId, project: out.project }));
      return json(res, "ok" in out ? 200 : 400, out);
    }
    default:
      return json(res, 404, { error: "not found" });
  }
}

/** voice_server.rs:884 — long-poll up to 25 s for events after `after`. */
async function poll(res: ServerResponse, url: URL): Promise<void> {
  const ring = getRing();
  const raw = url.searchParams.get("after") ?? "";
  if (raw === "" || raw === "latest") return json(res, 200, `{"next":${ring.latest()},"events":[]}`);
  let after = Number.parseInt(raw, 10);
  if (!Number.isFinite(after)) after = ring.latest();
  // A cursor from the future (state lost): hand back the real cursor at once
  // so the client resyncs instead of waiting forever.
  if (after > ring.latest()) return json(res, 200, `{"next":${ring.latest()},"events":[]}`);
  const deadline = Date.now() + 25_000;
  let closed = false;
  res.on("close", () => (closed = true));
  for (;;) {
    const { events, next } = ring.after(after);
    if (events.length || Date.now() >= deadline || closed) {
      return json(res, 200, `{"next":${next},"events":[${events.join(",")}]}`);
    }
    await ring.wait(Math.min(1000, deadline - Date.now()));
  }
}

/** voice_server.rs:2256 serve_vault_file. */
function serveVaultFile(res: ServerResponse, vault: string, url: URL): void {
  const p = url.searchParams.get("path");
  if (p === null) return json(res, 400, { error: "missing path" });
  const full = withinVault(vault, p);
  if (!full) return json(res, 403, { error: "outside the vault" });
  let size: number;
  try {
    size = statSync(full).size;
  } catch (e) {
    return json(res, 404, { error: (e as Error).message });
  }
  if (size > 50 * 1024 * 1024) return json(res, 413, { error: "file too large (50MB cap)" });
  try {
    const bytes = readFileSync(full);
    res.writeHead(200, { "Content-Type": mimeFor(full) });
    res.end(bytes);
  } catch (e) {
    json(res, 500, { error: (e as Error).message });
  }
}

export { SERVER_VERSION, SERVER_REV };
