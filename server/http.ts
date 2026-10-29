// The box's HTTP surface: the phone routes ported from voice_server.rs (same
// paths, methods, JSON shapes), git smart HTTP, and /api/v1/*. Mutations are
// relayed in-process to phoneApp's `phone:*` handlers (bus.relay), exactly
// the relay_request pattern the Rust server used.
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { browseFolders, inProjectFolder, projectDirListing } from "./projectFolders";
import { loadConfig, SERVER_VERSION, SERVER_REV } from "./config";
import { trackWrites } from "./drain";
import { inputSurface, noteInput } from "./presence";
import { authorize, isDirectLoopback, phoneToken } from "./auth";
import { createExternalMcpHandler, type ExternalContext } from "./mcp/external";
import { externalMcpHosts } from "./mcp/hosts";
import type { BoundTools } from "./mcp/tools";
import { brainEnabled, brainRoute, type BrainDeps } from "./voiceBrain";
import { relay, emitLocal } from "./bus";
import { convLog, signal } from "./convlog/log";
import { conversationsSummary, conversationDetail, notificationsFeed, notesFeed, withinVault, mimeFor, dispatchVoiceTool } from "./phoneData";
import { notificationAppend, pushSubsAdd, pushSubsRemove, vapidPublicKey } from "./commands/phone";
import { isGitPath, handleGitHttp } from "./gitHttp";
import { validVaultName } from "./sync";
import { validKeyName } from "./keys";
import { createProjectWithThread, projectsList, setProject } from "./projectRoutes";
import { voiceTool, voiceSession, voiceTranscript, voiceUpdates, voicePath, type VoiceDeps } from "./voice";
import { activityImageRoute, activityPost } from "./activity";
import PHONE_PAGE_INLINE from "../src-tauri/assets/phone.html";
import VOICE_PAGE_INLINE from "../src-tauri/assets/voice.html";
import PHONE_SW_INLINE from "../src-tauri/assets/phone-sw.js?raw";
import ICON_PNG_INLINE from "../src-tauri/assets/icon-apple-touch.png";
import PHONE_APP from "vc:phone-app";
import BOARD_APP from "vc:board-app";
import { addAsset, assetFile, copyAssets, createBoard, deleteBoard, getBoard, getHistory, listBoards, overviewPng, renameBoard, saveBoard, saveBoardPictures } from "./boards";
import { addToBoard, getEntry, listEntries, markAdded, markRead, partFile, sendEntry, type InboxCtx } from "./inbox";
import { boxLogs } from "./boxLogs";
import { ackShow, feedOpened } from "./show";
import { noteAttention, pushGate } from "./pushGate";
import { boardLogPost, boxDiag } from "./diag";
import { noteUserLine } from "./signal";
import { deliveryChallenge, deliveryRepos, laptopTransportIdentity, reportLaptopHealth, requestDeliveryRollback, shipmentCards, shipmentRepo } from "./changeDelivery";
import { ATTACH_BODY_LIMIT, ATTACH_MAX_BYTES, mb, saveAttachment } from "./attachments";

/** A vault on this box, as the routes see it (engine/index.ts VaultRef). */
export type VaultScope = { name: string; path: string; bare: string; main: boolean };

export type ServerHooks = {
  health: () => Promise<Record<string, unknown>>;
  syncStatus: () => unknown;
  alert: (title: string, body: string, tag?: string, needsYou?: boolean) => Promise<number>;
  onGitPushed: (vault: string) => void;
  /** Settings → Box on the laptop: this box's vaults, and its own OpenRouter key. */
  vaults?: { list: () => unknown; add: (name: string) => Promise<Record<string, unknown>> };
  setKeys?: (keys: Record<string, string>) => Promise<boolean>;
  /** The vault-chat folder (server/master.ts): its layout, vaults and projects; Settings sets it. */
  master?: { masterInfo: () => unknown };
  /** The vault a request names (`?vault=` or `X-VC-Vault`), null when this box
   * has no such vault. No name = the main vault (older laptops, the phone). */
  vault?: (name: string | null) => VaultScope | null;
  /** /status for a vault other than the main one (the main one's comes from the app). */
  vaultStatus?: (v: VaultScope) => Promise<Record<string, unknown>>;
  /** Standard MCP with an explicit vault/device/conversation, never defaults. */
  mcp?: (vault: VaultScope, context: ExternalContext) => Promise<BoundTools | null>;
  /** The engine takes these routes; a handler returning null hands the
   * request to the legacy relay (old mission threads). */
  engine?: {
    models: () => unknown;
    /** The box's own models (chat, vision fallback, subagent child) and their checks. */
    boxModels?: () => unknown;
    /** POST /api/v1/models/agent {model}: the agent's model, from the laptop (one setting: Settings and the composer). */
    setModel?: (model: string) => Record<string, unknown>;
    message: (v: VaultScope, b: any) => Promise<Record<string, unknown> | null>;
    answer: (v: VaultScope, b: any) => Promise<Record<string, unknown> | null>;
    kill: (v: VaultScope, b: any) => Promise<Record<string, unknown> | null>;
    subagent: (v: VaultScope, convId: string, sid: string, op: "steer" | "stop", b: any) => Promise<Record<string, unknown>>;
    /** POST /api/v2/intent: every client intent (src/convlog/protocol.ts Intent). */
    intent: (v: VaultScope, b: any) => Promise<Record<string, unknown>>;
    /** Side threads (server/engine/pi/side.ts): Ctrl+K / Ctrl+L, and the one-shots. */
    side?: {
      start: (v: VaultScope, b: any) => Promise<Record<string, unknown>>;
      poll: (v: VaultScope, id: string, after: number, waitMs: number) => Promise<Record<string, unknown> | null>;
      stop: (v: VaultScope, id: string) => Promise<boolean>;
    };
  };
  /** Voice (server/voice.ts) for the request's vault: its working copy, its
   * engine and sandbox — or why not. */
  voice?: (v: VaultScope) => Promise<VoiceDeps | { error: string }>;
  /** Voice with one brain (server/voiceBrain.ts, VC_VOICE_BRAIN=pi): the box's voice pipeline and pi. */
  brain?: (v: VaultScope) => BrainDeps;
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

/** Engine first; null → the legacy relay (the main vault's app; another vault has none). */
async function engineRoute(
  res: ServerResponse,
  v: VaultScope,
  handler: ((v: VaultScope, b: any) => Promise<Record<string, unknown> | null>) | undefined,
  body: any,
  event: string,
  timeoutMs: number,
  fail: string,
  after?: (out: Record<string, unknown>) => void,
): Promise<void> {
  if (handler) {
    const out = await dedupe(body?.clientMsgId, () => handler(v, body)).catch((e) => ({ error: String((e as Error)?.message ?? e) }));
    if (out) {
      if (!(out as any).error) after?.(out);
      return json(res, 200, out);
    }
  }
  if (!v.main) return json(res, handler ? 404 : 503, { error: handler ? "not found in this vault" : "engine not running" });
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
/** The whiteboard (board/): its own manifest, so a Home Screen launch opens /board fullscreen. */
const BOARD_MANIFEST = `{
  "name": "Whiteboard",
  "short_name": "Board",
  "start_url": "/board",
  "scope": "/board",
  "display": "fullscreen",
  "orientation": "any",
  "background_color": "#ececef",
  "theme_color": "#ececef",
  "icons": [
    { "src": "/apple-touch-icon.png", "sizes": "512x512", "type": "image/png", "purpose": "any" }
  ]
}`;
const BOARD_NOT_BUILT = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Whiteboard</title><p style="font:15px system-ui;padding:24px">The whiteboard isn't in this build (build:server builds it with <code>--board-app</code>).</p>`;
function boardPage(): string | Buffer {
  const app = BOARD_APP["index.html"];
  return app ? Buffer.from(app, "base64") : BOARD_NOT_BUILT;
}
/** The cookie the phone shell provisions (voice_server.rs resp_phone_shell): the board shares it. */
function tokenCookie(): Record<string, string> {
  const t = phoneToken();
  return t ? { "Set-Cookie": `vc_token=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=34560000` } : {};
}

const ASSET_MIME: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", // the board's pdf.js worker
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

async function jsonBody(req: IncomingMessage, limit?: number): Promise<any> {
  try {
    const v = JSON.parse(await readBody(req, limit));
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
  const mcpHosts = externalMcpHosts();
  const mcp = createExternalMcpHandler({ version: SERVER_VERSION, allowedHosts: mcpHosts, bind: async (name, context) => {
    const vault = hooks.vault?.(name);
    return vault?.name === name && hooks.mcp ? hooks.mcp(vault, context) : null;
  } });
  const server = createServer((req, res) => {
    const handled = new URL(req.url ?? "/", "http://localhost/").pathname === "/mcp" ? mcp(req, res) : handle(req, res, hooks);
    handled.catch((e) => {
      console.error("[http] handler error:", e);
      if (!res.headersSent) json(res, 500, { error: String((e as Error)?.message ?? e) });
      else res.end();
    });
  });
  server.on("close", () => { void mcp.close(); });
  // Long-polls hold for 25 s; don't let node's defaults cut them.
  server.requestTimeout = 0;
  server.headersTimeout = 70_000;
  // Outlive client/proxy idle pools so a reused keep-alive socket is never
  // closed under a request (ECONNRESET on the next call).
  server.keepAliveTimeout = 65_000;
  // Writes in flight finish on shutdown (server/drain.ts).
  trackWrites(server);
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
    return send(res, 200, "text/html; charset=utf-8", phonePage(), tokenCookie());
  }
  // The whiteboard's shell: the same model as the phone's (token-free page, the cookie provisioned).
  if ((path === "/board" || path === "/board/") && method === "GET") return send(res, 200, "text/html; charset=utf-8", boardPage(), tokenCookie());
  if (path === "/board/manifest.webmanifest") return send(res, 200, "application/manifest+json", BOARD_MANIFEST);
  for (const [prefix, files] of [["/phone/", PHONE_APP], ["/board/", BOARD_APP]] as const) {
    if (path.startsWith(`${prefix}assets/`) && method === "GET") {
      // An app's hashed files: immutable, so cached for good.
      const f = files[path.slice(prefix.length)];
      if (!f) return json(res, 404, { error: "not found" });
      const ext = path.slice(path.lastIndexOf("."));
      return send(res, 200, ASSET_MIME[ext] ?? "application/octet-stream", Buffer.from(f, "base64"), { "Cache-Control": "public, max-age=31536000, immutable" });
    }
  }

  const auth = authorize(req, url);
  if (!auth.ok) return json(res, 401, { error: "unauthorized" });
  // Carl's input keeps the box from self-updating under him (server/presence.ts, the health's busy).
  const surface = inputSurface(method, path, /iPhone|Android/.test(String(req.headers["user-agent"] ?? "")) ? "phone" : null);
  if (surface) noteInput(surface);

  if (isGitPath(path)) {
    const user = String(req.headers["tailscale-user-login"] ?? auth.via ?? "local");
    return handleGitHttp(req, res, url, user, hooks.onGitPushed);
  }

  // ---- /api/v1 ----
  if (path === "/api/v1/health" && method === "GET") {
    // `vaultPath`: the working copy of the vault the request names (the laptop's
    // terminal button opens an SSH shell there); null when this box has no such vault.
    const want = url.searchParams.get("vault") || String(req.headers["x-vc-vault"] ?? "") || null;
    const sc = hooks.vault ? hooks.vault(want) : !want || want === cfg.vaultName ? { path: cfg.vault } : null;
    return json(res, 200, { ...(await hooks.health()), vaultPath: sc?.path ?? null });
  }
  if (path === "/api/v1/sync" && method === "GET") return json(res, 200, hooks.syncStatus());
  if (path === "/api/v1/alert" && method === "POST") {
    const b = await jsonBody(req);
    const title = String(b.title ?? "").trim();
    const body = String(b.body ?? "").trim();
    // `resolved`: what the tag's alert was about is over (the laptop's sync recovered): a held push never goes out.
    if (b.resolved === true && typeof b.tag === "string") return json(res, 200, { ok: true, resolved: pushGate()?.resolve(b.tag) ?? 0 });
    if (!title && !body) return json(res, 400, { error: "alert needs a title or body" });
    const sent = await hooks.alert(title || "vault-chat", body, typeof b.tag === "string" ? b.tag : undefined, b.needsYou !== false);
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
  // The vault-chat folder (VC_MASTER, set at install): the laptop clones the repos it lacks.
  if (path === "/api/v1/master" && method === "GET") {
    return hooks.master ? json(res, 200, hooks.master.masterInfo()) : json(res, 503, { error: "not available" });
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

  // Everything below is one vault's: the one the request names, else the main one.
  const want = url.searchParams.get("vault") || String(req.headers["x-vc-vault"] ?? "") || null;
  const scope: VaultScope | null = hooks.vault ? hooks.vault(want) : !want || want === cfg.vaultName ? { name: cfg.vaultName, path: cfg.vault, bare: cfg.bareRepo, main: true } : null;
  if (!scope) return json(res, 404, { error: `no vault ${String(want).slice(0, 64)} on this box` });
  const vault = scope.path;
  if (path === "/api/v1/shipments" && method === "GET") {
    try { return json(res, 200, { shipments: await shipmentCards(vault, scope.name, url.searchParams.get("project") || undefined) }); }
    catch (e) { console.error("[delivery] cards", e); return json(res, 503, { error: "Shipment facts unavailable; needs attention" }); }
  }
  const rollbackShipment = /^\/api\/v1\/shipments\/([^/]+)\/rollback$/.exec(path);
  if (rollbackShipment && method === "POST") {
    try {
      const id = decodeURIComponent(rollbackShipment[1]!), repo = await shipmentRepo(vault, id);
      if (!repo) return json(res, 404, { error: "Accepted change not found in this vault" });
      const rollback = await requestDeliveryRollback(repo, id, "Carl requested rollback");
      return json(res, 200, { ok: true, rollback });
    } catch (e) { console.error("[delivery] rollback", e); return json(res, 503, { error: "Source recovery unavailable; needs attention" }); }
  }
  if ((path === "/api/v1/release-health/challenge" && method === "GET") || (path === "/api/v1/release-health/laptop" && method === "POST")) {
    const identity = laptopTransportIdentity(req);
    if (!identity) return json(res, 403, { error: "Paired native laptop transport required" });
    try {
      const repos = deliveryRepos(vault);
      if (method === "GET") {
        for (const repo of repos) { const challenge = await deliveryChallenge(repo, identity); if (challenge) return json(res, 200, { challenge }); }
        return json(res, 200, { challenge: null });
      }
      const b = await jsonBody(req, 16 * 1024);
      if (typeof b?.releaseId !== "string") return json(res, 400, { error: "Release identity required" });
      // Select only a registered vault project whose private journal issued this challenge.
      for (const repo of repos) {
        try { await reportLaptopHealth(repo, identity, b); return json(res, 200, { ok: true }); } catch { /* next registered project */ }
      }
      return json(res, 409, { error: "Expired, consumed or mismatched native release challenge" });
    } catch (e) { console.error("[delivery] native health", e); return json(res, 503, { error: "Release health unavailable" }); }
  }
  // A vault-level signal in this vault's log (/poll).
  const tagged = (ev: Record<string, unknown>) => signal(scope.path, ev);
  // The old app (the relay) knows only the main vault.
  const mainOnly = () => json(res, 409, { error: `only on the box's main vault (${cfg.vaultName})` });

  // Voice with one brain (behind VC_VOICE_BRAIN=pi): the call's pipeline and pi (server/voiceBrain.ts).
  if (hooks.brain && brainEnabled() && (path === "/v1/chat/completions" || path.startsWith("/api/v1/brain/"))) {
    if (await brainRoute(hooks.brain(scope), req, res, path, method, isDirectLoopback(req), () => jsonBody(req))) return;
  }

  // Model capabilities for Settings → Models.
  if (path === "/api/v1/models" && method === "GET") {
    return hooks.engine ? json(res, 200, { models: hooks.engine.models(), ...(hooks.engine.boxModels ? { box: hooks.engine.boxModels() } : {}) }) : json(res, 503, { error: "engine not running" });
  }
  if (path === "/api/v1/models/agent" && method === "POST") {
    if (!hooks.engine?.setModel) return json(res, 503, { error: "engine not running" });
    const out = hooks.engine.setModel(String((await jsonBody(req))?.model ?? ""));
    return json(res, out.ok ? 200 : 400, out);
  }
  // Steer or stop one running subagent of a conversation.
  const subM = /^\/api\/v1\/conversations\/([^/]+)\/subagents\/([^/]+)\/(steer|stop)$/.exec(path);
  if (subM && method === "POST") {
    if (!hooks.engine) return json(res, 503, { error: "engine not running" });
    const out = await hooks.engine.subagent(scope, decodeURIComponent(subM[1]!), decodeURIComponent(subM[2]!), subM[3] as "steer" | "stop", await jsonBody(req));
    return json(res, out.ok ? 200 : 409, out);
  }


  // Voice (server/voice.ts): the front of house of one conversation, on the laptop, the phone and the board —
  // the session (minted with the box's key, its prompt from the conversation's pi session), its one tool that
  // acts (Ask: a request to the conversation's agent), its lines (into that session) and the updates a live call gets.
  if (path === "/api/v1/voice/tool" && method === "POST") {
    const b = await jsonBody(req);
    const d = (await hooks.voice?.(scope)) ?? { error: "voice tools not available" };
    if ("error" in d) return json(res, 503, d);
    return json(res, 200, await voiceTool(d, b));
  }
  if (path === "/api/v1/voice/session" && method === "GET") {
    const d = (await hooks.voice?.(scope)) ?? { error: "voice not available" };
    if ("error" in d) return json(res, 503, d);
    const out = await voiceSession(url.searchParams.get("convId"), d, { llm: url.searchParams.get("llm"), voice: url.searchParams.get("voice"), device: url.searchParams.get("device") });
    return json(res, out.status, out.body);
  }
  if (path === "/api/v1/voice/updates" && method === "GET") {
    const d = (await hooks.voice?.(scope)) ?? { error: "voice not available" };
    if ("error" in d) return json(res, 503, d);
    const signal = { closed: false };
    res.on("close", () => (signal.closed = true));
    return json(res, 200, await voiceUpdates(d, { convId: url.searchParams.get("convId"), cursor: url.searchParams.get("cursor"), waitMs: Number(url.searchParams.get("wait")) || 0, signal, session: url.searchParams.get("session") }));
  }
  if (path === "/api/v1/voice/transcript" && method === "POST") {
    const b = await jsonBody(req);
    const d = (await hooks.voice?.(scope)) ?? { error: "voice not available" };
    if ("error" in d) return json(res, 503, d);
    const out = await voiceTranscript(d, b);
    // Carl's spoken line: a frustration signal in the turn log when it looks like one (server/signal.ts).
    if (out.status === 200 && b?.role === "user" && b?.system !== true && !out.body.skipped && !out.body.duplicate)
      noteUserLine({ stateDir: cfg.stateDir, vault: scope.name, conv: typeof out.body.convId === "string" ? out.body.convId : null, via: "voice", text: String(b.text ?? "") });
    return json(res, out.status, out.body);
  }

  // Live edits (server/liveEdits.ts): a file the agent just wrote, as it is on
  // the box now — the laptop shows it in the open pane before the sync lands.
  if (path === "/api/v1/vault/file" && method === "GET") return vaultFileRoute(res, vault, url.searchParams.get("path"));
  // A project's folder on the box (server/projectFolders.ts): the app's file tree lists it, opens its files
  // through the route above and writes Carl's edits back here. Only inside a folder he chose for a project.
  if (path === "/api/v1/vault/file" && method === "POST") return projectFileWrite(res, vault, await jsonBody(req, PROJECT_FILE_CAP + 1024 * 1024));
  if (path === "/api/v1/box/dir" && method === "GET") {
    const out = projectDirListing(vault, url.searchParams.get("path") ?? "");
    return json(res, "error" in out ? 403 : 200, out);
  }
  // "+ New project"'s folder chooser: the folders on the box, each marked whether it may be a project's.
  if (path === "/api/v1/box/folders" && method === "GET") {
    const out = browseFolders(vault, url.searchParams.get("path"));
    return json(res, "error" in out ? 403 : 200, out);
  }

  const q = (k: string) => url.searchParams.get(k) ?? "";

  // Side threads (server/engine/pi/side.ts): Ctrl+K / Ctrl+L as a fork of the conversation's pi session with
  // pi's read-only tools, and the tool-less one-shots. POST starts one (or a popover's next request); GET
  // answers the text so far once it moved past `after` (a long poll); stop aborts it.
  if (path === "/api/v1/side" && method === "POST") {
    const side = hooks.engine?.side;
    if (!side) return json(res, 503, { error: "engine not running" });
    const out: Record<string, unknown> = await side.start(scope, await jsonBody(req)).catch((e) => ({ error: String((e as Error)?.message ?? e) }));
    return json(res, out.error ? (out.error === "missing text" ? 400 : 502) : 200, out);
  }
  const sideM = /^\/api\/v1\/side\/([^/]+)(\/stop)?$/.exec(path);
  if (sideM) {
    const side = hooks.engine?.side;
    if (!side) return json(res, 503, { error: "engine not running" });
    const id = decodeURIComponent(sideM[1]!);
    if (sideM[2] && method === "POST") return json(res, 200, { ok: await side.stop(scope, id) });
    if (!sideM[2] && method === "GET") {
      const st = await side.poll(scope, id, Number(url.searchParams.get("after") ?? -1), Number(url.searchParams.get("wait") ?? 20_000));
      return st ? json(res, 200, st) : json(res, 404, { error: "no such side thread" });
    }
  }

  // Is Carl looking (server/pushGate.ts): a surface says so while it is on screen (and, on the
  // laptop, used), and says when it no longer is. The phone buzzes only when no surface is.
  if (path === "/api/v1/attention" && method === "POST") {
    const b = await jsonBody(req);
    if (!noteAttention(vault, b.device, b.looking === true, b.convId)) return json(res, 400, { error: "device: laptop, phone or board" });
    return json(res, 200, { ok: true });
  }

  // The shared context stream (server/activity.ts): this vault's log only.
  if (path === "/api/v1/activity" && method === "POST") {
    const out = activityPost(vault, await jsonBody(req));
    return json(res, out.status, out.body);
  }
  if (path === "/api/v1/activity/image" && method === "POST") {
    return json(res, 200, activityImageRoute(vault, await jsonBody(req)));
  }

  // The board inbox (server/inbox.ts, board/INBOX.md): what the agent sends the iPad.
  //   GET  /api/v1/inbox                     → {entries:[summary], unread}
  //   POST /api/v1/inbox {title,note,parts}  → {ok,id,parts} | 422 {ok:false, refusals:[…]} (the validated send)
  //   GET  /api/v1/inbox/<id>                → the entry
  //   POST /api/v1/inbox/<id>/read           → mark read
  //   POST /api/v1/inbox/<id>/added {part, board, items}
  //   GET  /api/v1/inbox/<id>/part/<n>[/html|bundle|snapshot]
  // Every change: {type:"inbox", id, status, title, landed?, failed?} on /poll.
  if (path === "/api/v1/inbox" || path.startsWith("/api/v1/inbox/")) {
    const ictx: InboxCtx = { stateDir: cfg.stateDir, emit: (ev) => tagged(ev) };
    const [id = "", sub, n, what, ...rest] = path.slice("/api/v1/inbox/".length).split("/");
    let out: { status: number; body: unknown; file?: Buffer; mime?: string; headers?: Record<string, string> };
    if (path === "/api/v1/inbox" && method === "GET") out = { status: 200, body: listEntries(vault, ictx) };
    else if (path === "/api/v1/inbox" && method === "POST") {
      const r = await sendEntry(vault, await jsonBody(req), ictx);
      out = { status: r.ok ? 200 : 422, body: r };
    } else if (rest.length) out = { status: 404, body: { error: "not found" } };
    else if (sub === undefined && method === "GET") out = getEntry(vault, id, ictx);
    else if (sub === "read" && n === undefined && method === "POST") out = markRead(vault, id, ictx);
    else if (sub === "added" && n === undefined && method === "POST") out = markAdded(vault, id, await jsonBody(req), ictx);
    else if (sub === "part" && n !== undefined && /^\d+$/.test(n) && method === "GET") out = await partFile(vault, id, Number(n), what);
    else out = { status: 404, body: { error: "not found" } };
    if (out.file) return send(res, 200, out.mime ?? "application/octet-stream", out.file, out.headers ?? { "X-Content-Type-Options": "nosniff" });
    return json(res, out.status, out.body);
  }

  // pi's Show (server/show.ts): the laptop / phone / board app says what it did with a show signal.
  const showAck = /^\/api\/v1\/show\/([^/]+)\/ack$/.exec(path);
  if (showAck && method === "POST") return json(res, 200, { ok: true, waiting: ackShow(decodeURIComponent(showAck[1]!), await jsonBody(req)) });

  // The whiteboard's own log (board/src/log.ts): batched events → <state>/logs/board.jsonl.
  if (path === "/api/v1/board/log" && method === "POST") {
    const out = boardLogPost({ stateDir: cfg.stateDir, vaultName: scope.name, ua: String(req.headers["user-agent"] ?? "") }, await jsonBody(req));
    return json(res, out.status, out.body);
  }
  // The box's half of a diag bundle (server/diag.ts): the last N minutes of its logs, redacted.
  if (path === "/api/v1/diag" && method === "GET") {
    return json(res, 200, boxDiag({ stateDir: cfg.stateDir, vault, vaultName: scope.name, version: SERVER_VERSION, rev: SERVER_REV ?? null, minutes: Number(q("minutes") || 15) }));
  }

  // The whiteboard (server/boards.ts): boards/<slug>/ in this vault.
  if (path === "/api/v1/boards" || path.startsWith("/api/v1/boards/")) {
    const [slugRaw, file, more, ...rest] = path.slice("/api/v1/boards/".length).split("/");
    let slug = "";
    try {
      slug = decodeURIComponent(slugRaw ?? "");
    } catch {
      /* invalid escape: an invalid slug */
    }
    let out: { status: number; body: unknown; file?: Buffer; mime?: string; headers?: Record<string, string> };
    if (path === "/api/v1/boards" && method === "GET") out = { status: 200, body: { boards: listBoards(vault) } };
    else if (path === "/api/v1/boards" && method === "POST") out = createBoard(vault, (await jsonBody(req)).name);
    else if (file === "assets" && more === "copy" && rest.length === 0 && method === "POST") out = copyAssets(vault, slug, await jsonBody(req));
    else if (file === "assets" && more && rest.length === 0 && method === "GET") out = assetFile(vault, slug, more);
    else if (file === "assets" && more === undefined && method === "POST") out = addAsset(vault, slug, await jsonBody(req));
    else if (file === "rename" && more === undefined && method === "POST") out = renameBoard(vault, slug, await jsonBody(req));
    else if (file === "delete" && more === undefined && method === "POST") out = deleteBoard(vault, slug);
    else if (file === "from-inbox" && more === undefined && method === "POST") out = await addToBoard(vault, slug, await jsonBody(req));
    else if (more !== undefined) out = { status: 404, body: { error: "not found" } };
    else if (file === undefined && method === "GET") out = getBoard(vault, slug);
    else if (file === undefined && method === "POST") out = await saveBoard(vault, slug, await jsonBody(req));
    else if (file === "overview.png" && method === "GET") out = overviewPng(vault, slug);
    else if (file === "history" && method === "GET") out = getHistory(vault, slug);
    else if (file === "pictures" && method === "POST") out = await saveBoardPictures(vault, slug, await jsonBody(req));
    else out = { status: 404, body: { error: "not found" } };
    if (out.file) return send(res, 200, out.mime ?? "application/octet-stream", out.file, out.headers ?? { "X-Content-Type-Options": "nosniff" });
    return json(res, out.status, out.body);
  }

  // ---- the conversation log (src/convlog/protocol.ts) ----
  //   GET  /api/v2/conversations                → {rows, seq, epoch}: every list row, folded up to `seq`
  //   GET  /api/v2/conversations/<id>/events?after=N → {events, next, epoch}: that conversation's records after N
  //   GET  /api/v2/conversations/<id>/checkpoint     → {seq, picture, events, next}: a materialised picture plus the tail
  //   POST /api/v2/intent {type, …}            → {ok, convId, …}: the box does it; its effect arrives in the log
  if (path === "/api/v2/conversations" && method === "GET") {
    const log = convLog(vault);
    const seq = log.latest();
    return json(res, 200, { rows: log.rows().filter((r) => !(r as any).deleted), seq, epoch: log.epoch });
  }
  const v2 = /^\/api\/v2\/conversations\/([^/]+)\/(events|checkpoint)$/.exec(path);
  if (v2 && method === "GET") {
    const log = convLog(vault);
    const id = decodeURIComponent(v2[1]!);
    // Read the head first: every record of this conversation up to it is in the answer.
    const next = log.latest();
    const pic = log.picture(id);
    if (!pic) return json(res, 404, { error: "conversation not found" });
    if (v2[2] === "checkpoint") {
      const snap = JSON.parse(JSON.stringify(pic));
      return json(res, 200, { seq: snap.seq, picture: snap, events: [], next: Math.max(next, snap.seq), epoch: log.epoch });
    }
    const after = Math.max(0, Number.parseInt(q("after") || "0", 10) || 0);
    return json(res, 200, { events: log.eventsOf(id, after).filter((r) => r.seq <= Math.max(next, pic.seq)), next: Math.max(next, pic.seq), epoch: log.epoch });
  }
  // A file Carl attached from outside the vault: its bytes, saved in the vault's hidden attachments area
  // (server/attachments.ts); the message then names it by the path this returns.
  if (path === "/api/v2/attachment" && method === "POST") {
    const b = await jsonBody(req, ATTACH_BODY_LIMIT);
    if (!b.dataBase64) return json(res, 413, { error: `the file did not arrive (too big? an attachment can be at most ${mb(ATTACH_MAX_BYTES)})` });
    const out = saveAttachment(vault, b);
    return out.ok ? json(res, 200, out) : json(res, out.status, { error: out.error });
  }
  if (path === "/api/v2/intent" && method === "POST") {
    if (!hooks.engine) return json(res, 503, { error: "engine not running" });
    const b = await jsonBody(req);
    const t0 = Date.now();
    const out = await hooks.engine.intent(scope, b).catch((e) => ({ error: String((e as Error)?.message ?? e) }));
    logIntent(cfg.stateDir, scope.name, req, b, out, Date.now() - t0);
    return json(res, (out as any).error ? 409 : 200, out);
  }

  switch (`${method} ${path}`) {
    case "GET /voice":
      return send(res, 200, "text/html; charset=utf-8", asset("voice.html", VOICE_PAGE_INLINE));
    case "GET /phone":
      return send(res, 200, "text/html; charset=utf-8", phonePage());
    case "GET /conversations":
      return json(res, 200, conversationsSummary(vault));
    case "GET /surface": {
      const id = q("id");
      if (id && scope.main) void relay("phone:surface", { convId: id }, 4000);
      return json(res, 200, { ok: true });
    }
    case "GET /conversation": {
      const n = parseInt(q("n"), 10);
      const c = conversationDetail(vault, q("id"), Number.isFinite(n) ? n : 60, q("full") === "1");
      return c ? json(res, 200, c) : json(res, 404, { error: "conversation not found" });
    }
    case "GET /file":
      return serveVaultFile(req, res, vault, url);
    case "GET /poll":
      return poll(res, url, scope.path);
    case "GET /notifications":
      return json(res, 200, notificationsFeed(vault));
    case "GET /notes":
      return json(res, 200, notesFeed(vault));
    case "POST /notes":
      if (!scope.main) return mainOnly();
      return relayRoute(res, "phone:note", await jsonBody(req), 10_000, "app not answering");
    case "POST /client-event":
      if (scope.main) await relay("phone:client-event", await jsonBody(req), 5000);
      return json(res, 200, { ok: true });
    case "POST /notes/status":
      if (!scope.main) return mainOnly();
      return relayRoute(res, "phone:note-status", await jsonBody(req), 10_000, "app not answering");
    case "POST /notes/edit":
      if (!scope.main) return mainOnly();
      return relayRoute(res, "phone:note-edit", await jsonBody(req), 10_000, "app not answering");
    case "POST /notes/clear-resolved":
      if (!scope.main) return mainOnly();
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
      if (!scope.main) return json(res, 200, { schedules: [] });
      return relayRoute(res, "phone:schedules", {}, 10_000, "app not answering — is a vault open?");
    case "POST /schedule":
      if (!scope.main) return mainOnly();
      return relayRoute(res, "phone:schedule", await jsonBody(req), 10_000, "app not answering");
    case "GET /status":
      // Every vault's runs are its engine's.
      if (hooks.vaultStatus) return json(res, 200, await hooks.vaultStatus(scope));
      if (!scope.main) return json(res, 503, { error: "engine not running" });
      return relayRoute(res, "phone:status", {}, 10_000, "app not answering — is a vault open?");
    case "POST /message": {
      const b = await jsonBody(req);
      const t0 = Date.now();
      return engineRoute(res, scope, hooks.engine?.message, b, "phone:msg", 15_000, "app not answering — is a vault open?", (out) =>
        logIntent(cfg.stateDir, scope.name, req, { ...b, type: b.queue ? "queue" : "message", clientId: b.clientMsgId }, out, Date.now() - t0),
      );
    }
    case "POST /answer": {
      const b = await jsonBody(req);
      return engineRoute(res, scope, hooks.engine?.answer, b, "phone:answer", 15_000, "app not answering — is a vault open?", () => {
        // The alert card's decision record, as the old /answer wrote it.
        if (typeof b.notifId === "string" && b.notifId) {
          const answer = b.defer ? "Not now" : String(b.text ?? "");
          notificationAppend(vault, JSON.stringify({ type: "answered", id: b.notifId, answer: [...answer].slice(0, 160).join(""), ts: Date.now() }));
          tagged({ type: "notif" });
        }
      });
    }
    case "POST /kill":
      return engineRoute(res, scope, hooks.engine?.kill, await jsonBody(req), "phone:kill", 10_000, "app not answering");
    case "POST /chats/clear":
      if (!scope.main) return mainOnly();
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
      const vd = await hooks.voice?.(scope);
      if (!vd || "error" in vd) return json(res, 503, vd ?? { error: "voice not available" });
      const out = await voiceSession(String((await jsonBody(req)).convId ?? "") || null, vd);
      return json(res, out.status, out.body);
    }
    case "POST /voice-transcript": {
      const b = await jsonBody(req);
      if (String(b.text ?? "").trim()) emitLocal("voice:transcript", { role: b.role ?? "assistant", text: b.text });
      // The old voice page's lines are saved too: one voice conversation per
      // session (a new one after 30 quiet minutes), unless it names one.
      const vd = await hooks.voice?.(scope);
      if (vd && !("error" in vd) && String(b.text ?? "").trim()) {
        const last = legacyVoice.get(scope.name) ?? { id: null, at: 0 };
        const fresh = Date.now() - last.at > 30 * 60_000;
        const out = await voiceTranscript(vd, { ...b, convId: b.convId ?? (fresh ? null : last.id) });
        if (typeof out.body.convId === "string") legacyVoice.set(scope.name, { id: out.body.convId, at: Date.now() });
        return json(res, out.status, out.body);
      }
      return json(res, 200, { ok: true });
    }
    case "POST /tool": {
      // The old phone page's tool call: the full box set when voice is wired, else read-only.
      const raw = await readBody(req);
      const vd = await hooks.voice?.(scope);
      if (!vd || "error" in vd) return send(res, 200, "text/plain; charset=utf-8", await dispatchVoiceTool(vault, raw));
      let b: any = {};
      try {
        b = JSON.parse(raw);
      } catch {
        /* empty */
      }
      return send(res, 200, "text/plain; charset=utf-8", (await voiceTool(vd, b)).result);
    }
    // Projects: the chat chip and "New chat in project" (desktop box mode, phone).
    case "GET /projects":
      return json(res, 200, projectsList(vault));
    case "POST /projects": {
      const b = await jsonBody(req);
      const out = await createProjectWithThread(vault, b);
      if ("ok" in out) tagged({ type: "project", convId: out.convId, project: out.slug });
      return json(res, "ok" in out ? 200 : 400, out);
    }
    case "POST /conversation/project": {
      const b = await jsonBody(req);
      const out = await setProject(vault, b);
      if ("ok" in out) tagged({ type: "project", convId: b.convId, project: out.project });
      return json(res, "ok" in out ? 200 : 400, out);
    }
    default:
      return json(res, 404, { error: "not found" });
  }
}

/** One intent in the box's turn log (server/boxLogs.ts): which client asked what of which conversation, under which message id, and how it went. */
function logIntent(stateDir: string, vault: string, req: IncomingMessage, b: any, out: any, ms: number): void {
  const ua = String(req.headers["user-agent"] ?? "");
  const client = typeof b?.client === "string" && b.client ? b.client.slice(0, 20) : /iPad|iPhone|Android/.test(ua) ? "phone" : null;
  const result = out && typeof out === "object" ? ["steered", "queued", "answered", "duplicate", "unqueued"].filter((k) => out[k]) : [];
  boxLogs(stateDir).turns.append({
    at: new Date().toISOString(),
    ev: "intent",
    vault,
    type: String(b?.type ?? "?").slice(0, 20),
    conv: (typeof b?.convId === "string" && b.convId) || (typeof out?.convId === "string" ? out.convId : null),
    cmid: typeof b?.clientId === "string" ? b.clientId : typeof b?.id === "string" ? b.id : null,
    client,
    ok: !out?.error && out?.ok !== false,
    ms,
    ...(result.length ? { outcome: result.join(",") } : {}),
    ...(out?.error ? { error: String(out.error).slice(0, 300) } : {}),
  });
  // Carl's typed line: a frustration signal when it looks like one (server/signal.ts).
  if (["send", "steer", "queue", "message", "answer"].includes(String(b?.type)) && typeof b?.text === "string" && b.text.trim() && !out?.error && !out?.duplicate)
    noteUserLine({ stateDir, vault, conv: (typeof b?.convId === "string" && b.convId) || (typeof out?.convId === "string" ? out.convId : null), via: client ?? "typed", text: b.text });
}

/** The old voice page's current voice conversation, per vault. */
const legacyVoice = new Map<string, { id: string | null; at: number }>();

/** GET /poll?after=N[&epoch=E] — exactly the vault log's records after N, long-polled up to 25 s.
 * `after=latest` (or none) → the head, no records. A cursor from another log (its epoch) or from
 * beyond the head → `reset`: start over from 0. */
async function poll(res: ServerResponse, url: URL, vault: string): Promise<void> {
  // Who follows the feed (`client=laptop|phone|board`): Show sends only to a live app (server/show.ts).
  const leave = feedOpened(vault, url.searchParams.get("client"));
  try {
    await pollLog(res, url, vault);
  } finally {
    leave();
  }
}

async function pollLog(res: ServerResponse, url: URL, vault: string): Promise<void> {
  const log = convLog(vault);
  const raw = url.searchParams.get("after") ?? "";
  const epoch = url.searchParams.get("epoch");
  const head = (extra: Record<string, unknown> = {}) => json(res, 200, { next: log.latest(), events: [], epoch: log.epoch, ...extra });
  if (raw === "" || raw === "latest") return head();
  const after = Number.parseInt(raw, 10);
  if (!Number.isFinite(after) || after < 0) return head({ reset: true });
  if (epoch && epoch !== log.epoch) return head({ reset: true });
  const deadline = Date.now() + 25_000;
  let closed = false;
  res.on("close", () => (closed = true));
  for (;;) {
    const got = log.after(after);
    if (got.reset || got.events.length || Date.now() >= deadline || closed) return json(res, 200, { ...got, epoch: log.epoch });
    await log.wait(Math.min(1000, deadline - Date.now()));
  }
}

/** GET /api/v1/vault/file?path= → {path, size, mtimeMs, base64}: one file's
 * bytes, inside the vault only (realpath; never .git). */
const VAULT_FILE_CAP = 25 * 1024 * 1024;
function vaultFileRoute(res: ServerResponse, vault: string, p: string | null): void {
  if (!p || !p.trim()) return json(res, 400, { error: "missing path" });
  let abs: string;
  let rel: string;
  try {
    ({ abs, rel } = voicePath(vault, p, "read"));
  } catch (e) {
    // A file in a project's folder on the box (an absolute path): its path is its name.
    const hit = inProjectFolder(vault, p);
    if (!hit) return json(res, 403, { error: String(e) });
    abs = hit.abs;
    rel = hit.abs.split(sep).join("/");
  }
  try {
    const st = statSync(abs);
    if (!st.isFile()) return json(res, 404, { error: "not a file" });
    if (st.size > VAULT_FILE_CAP) return json(res, 413, { error: "file too large" });
    return json(res, 200, { path: rel, size: st.size, mtimeMs: st.mtimeMs, base64: readFileSync(abs).toString("base64") });
  } catch (e) {
    return json(res, 404, { error: (e as Error).message });
  }
}

const PROJECT_FILE_CAP = 10 * 1024 * 1024;

/** POST /api/v1/vault/file {path, text} → {ok, path, size, mtimeMs}: Carl's edit to a file in a project's folder on
 * the box (never a vault file: those are written on the laptop and synced). */
function projectFileWrite(res: ServerResponse, vault: string, b: any): void {
  const p = typeof b?.path === "string" ? b.path : "";
  if (typeof b?.text !== "string") return json(res, 400, { error: "missing text" });
  if (Buffer.byteLength(b.text) > PROJECT_FILE_CAP) return json(res, 413, { error: "file too large" });
  const hit = inProjectFolder(vault, p);
  if (!hit) return json(res, 403, { error: `${p || "(no path)"} is not in a project's folder` });
  try {
    if (existsSync(hit.abs) && !statSync(hit.abs).isFile()) return json(res, 400, { error: "not a file" });
    if (!existsSync(dirname(hit.abs))) return json(res, 404, { error: "its folder does not exist" });
    // In place: the file keeps its mode (a script stays executable) and a symlink stays one.
    writeFileSync(hit.abs, b.text);
    const st = statSync(hit.abs);
    return json(res, 200, { ok: true, path: hit.abs.split(sep).join("/"), size: st.size, mtimeMs: st.mtimeMs });
  } catch (e) {
    return json(res, 500, { error: (e as Error).message });
  }
}

/** voice_server.rs:2256 serve_vault_file. */
function serveVaultFile(req: IncomingMessage, res: ServerResponse, vault: string, url: URL): void {
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
    // Byte ranges: Safari plays a video only from a server that answers them (RecordUI's videos in the chat).
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? "").trim());
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      let end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start >= size || start > end) {
        res.writeHead(416, { "Content-Range": `bytes */${size}` });
        return void res.end();
      }
      res.writeHead(206, { "Content-Type": mimeFor(full), "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) });
      return void res.end(bytes.subarray(start, end + 1));
    }
    res.writeHead(200, { "Content-Type": mimeFor(full), "Accept-Ranges": "bytes", "Content-Length": String(size) });
    res.end(bytes);
  } catch (e) {
    json(res, 500, { error: (e as Error).message });
  }
}

export { SERVER_VERSION, SERVER_REV };
