//! Embedded HTTP server for the **phone surfaces**: voice mode and the chat PWA.
//!
//! The box runs vault-chat 24/7. This tiny server lets a phone — over the user's
//! private Tailscale mesh — (a) drive a *live* ElevenLabs voice session whose
//! brain (vault context + tools) stays on the box, and (b) use the full chat
//! agent through a streaming PWA (`/phone`): send messages, watch runs stream,
//! open vault files, kill runs, and receive Web Push notifications.
//!
//! Design: **no fragile relay for connect.** The desktop app pushes the current
//! voice *context* into this server via `set_context` (and answers fresh-context
//! requests on demand). Chat traffic uses the same proven relay pattern: an HTTP
//! request emits an event to the webview, the frontend answers by `reqId` over
//! an mpsc channel. Run streaming flows the other way — the frontend broadcasts
//! store diffs into `/events` (SSE).
//!
//! Security (user-chosen, stated honestly): **Tailscale is the perimeter, the
//! shared token is defense-in-depth.** Every route except `/health`, the icon,
//! the service worker, and the manifest requires the token (`X-Vault-Token`
//! header or `?token=` — the query form exists because EventSource and
//! home-screen launch URLs can't set headers). Since the tool-parity commit the
//! relay executes with FULL desktop parity (including Bash via voice tools and
//! agent runs via `/message`) — anyone holding the token on the tailnet drives
//! the agent. That is the explicit model: the user owns the agent. The local
//! fallback dispatch (relay down) stays read-only.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};
use tiny_http::{Header, Method, Request, Response, Server};

const VOICE_PAGE: &str = include_str!("../assets/voice.html");
const PHONE_PAGE: &str = include_str!("../assets/phone.html");
const PHONE_SW: &str = include_str!("../assets/phone-sw.js");

/// Web-app manifest for the chat PWA. Served token-free (no vault data) so the
/// browser's out-of-band manifest fetch can't fail on a missing query token.
const PHONE_MANIFEST: &str = r##"{
  "name": "vault-chat",
  "short_name": "vault-chat",
  "start_url": "/phone",
  "display": "standalone",
  "background_color": "#1a1a1a",
  "theme_color": "#1a1a1a",
  "icons": [{ "src": "/icon.svg", "sizes": "any", "type": "image/svg+xml" }]
}"##;

/// Home-screen app icon: a dark rounded square with the accent-gradient voice
/// bars, matching the page.
const ICON_SVG: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180" viewBox="0 0 180 180"><rect width="180" height="180" rx="40" fill="#1a1a1a"/><g fill="#d9d9d9"><rect x="56" y="70" width="13" height="40" rx="6.5"/><rect x="79" y="52" width="13" height="76" rx="6.5"/><rect x="102" y="44" width="13" height="92" rx="6.5"/><rect x="125" y="74" width="13" height="32" rx="6.5"/></g></svg>"##;

/// The live voice context the desktop app pushes in. Everything the server needs
/// to mint a session + answer "about the vault" tool calls.
#[derive(Clone)]
struct Ctx {
    el_key: String,
    agent_id: String,
    voice_id: String,
    system_prompt: String,
    dynamic_vars: Value,
    tool_names: Vec<String>,
    vault: String,
}

struct Running {
    server: Arc<Server>,
    token: String,
    port: u16,
}

static SERVER: OnceLock<Mutex<Option<Running>>> = OnceLock::new();
static CTX: OnceLock<Mutex<Option<Ctx>>> = OnceLock::new();

fn server_slot() -> &'static Mutex<Option<Running>> {
    SERVER.get_or_init(|| Mutex::new(None))
}
fn ctx_slot() -> &'static Mutex<Option<Ctx>> {
    CTX.get_or_init(|| Mutex::new(None))
}

/// Update the live voice context. Called by the desktop app on startup and on a
/// short heartbeat so the phone always gets fresh credentials + vault context.
#[allow(clippy::too_many_arguments)]
pub fn set_context(
    el_key: String,
    agent_id: String,
    voice_id: String,
    system_prompt: String,
    dynamic_vars: Value,
    tool_names: Vec<String>,
    vault: String,
) {
    *ctx_slot().lock().unwrap_or_else(|e| e.into_inner()) = Some(Ctx {
        el_key,
        agent_id,
        voice_id,
        system_prompt,
        dynamic_vars,
        tool_names,
        vault,
    });
}

/// Start the server on `port`, guarded by `token`. Idempotent for the same
/// port+token. Binds `0.0.0.0` (the token is the gate; Tailscale is the
/// perimeter). Returns the bound port.
pub fn start(port: u16, token: String) -> Result<u16, String> {
    let mut guard = server_slot().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(r) = guard.as_ref() {
        if r.port == port && r.token == token {
            return Ok(r.port);
        }
        r.server.unblock();
    }
    let server = Server::http(("0.0.0.0", port)).map_err(|e| e.to_string())?;
    let server = Arc::new(server);
    let token_for_thread = token.clone();
    let server_for_thread = server.clone();
    std::thread::Builder::new()
        .name("voice-http".into())
        .spawn(move || {
            for req in server_for_thread.incoming_requests() {
                // One thread per request. A tool relay can block ~25s and a
                // session mint ~20s — handled inline they'd stall the single
                // accept loop and queue every later /session (and even the page
                // itself) behind them, which reads as "stuck on Connecting…".
                let tok = token_for_thread.clone();
                let _ = std::thread::Builder::new()
                    .name("voice-req".into())
                    .spawn(move || handle(req, &tok));
            }
        })
        .map_err(|e| e.to_string())?;
    *guard = Some(Running { server, token, port });
    Ok(port)
}

pub fn stop() {
    let mut guard = server_slot().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(r) = guard.take() {
        r.server.unblock();
    }
}

pub fn is_running() -> bool {
    server_slot().lock().unwrap_or_else(|e| e.into_inner()).is_some()
}

/// Expose the local voice server over **Tailscale HTTPS** and return the secure
/// `https://<machine>.ts.net` base. This is the link that works on a phone:
/// browsers only grant the mic (`navigator.mediaDevices`) over HTTPS or
/// localhost, so a plain-HTTP Tailscale-IP link can't get audio. `tailscale
/// serve` proxies that HTTPS name to our local port with a real cert.
///
/// Requires HTTPS certificates enabled on the tailnet (Tailscale admin → DNS →
/// "Enable HTTPS"). Best-effort: returns None if Tailscale, `serve`, or HTTPS
/// isn't available — the caller then falls back to the http IP (localhost-only).
pub fn https_url(port: u16) -> Option<String> {
    // Idempotently set up the proxy: https://<name>.ts.net/ -> 127.0.0.1:port.
    let _ = std::process::Command::new("tailscale")
        .args(["serve", "--bg", "--https=443", &format!("http://127.0.0.1:{}", port)])
        .output();
    let out = std::process::Command::new("tailscale")
        .args(["status", "--json"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let v: Value = serde_json::from_slice(&out.stdout).ok()?;
    let dns = v
        .get("Self")
        .and_then(|s| s.get("DNSName"))
        .and_then(|d| d.as_str())?
        .trim_end_matches('.');
    if dns.is_empty() {
        None
    } else {
        Some(format!("https://{}", dns))
    }
}

/// Best-effort `http://<tailscale-ip>:<port>` — the http fallback (works only on
/// localhost / same machine; a phone needs `https_url`).
pub fn tailscale_url(port: u16) -> Option<String> {
    let out = std::process::Command::new("tailscale")
        .args(["ip", "-4"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let ip = String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|l| l.trim())
        .find(|l| l.starts_with("100."))?
        .to_string();
    Some(format!("http://{}:{}", ip, port))
}

// ---- HTTP ----

fn resp_text(status: u16, mime: &str, body: String) -> Response<std::io::Cursor<Vec<u8>>> {
    let mut r = Response::from_string(body).with_status_code(status);
    if let Ok(h) = Header::from_bytes(&b"Content-Type"[..], mime.as_bytes()) {
        r = r.with_header(h);
    }
    r
}

fn token_ok(req: &Request, token: &str) -> bool {
    for h in req.headers() {
        if h.field.equiv("X-Vault-Token") && h.value.as_str() == token {
            return true;
        }
    }
    if let Some(q) = req.url().split('?').nth(1) {
        for kv in q.split('&') {
            if let Some(v) = kv.strip_prefix("token=") {
                if v == token {
                    return true;
                }
            }
        }
    }
    false
}

fn handle(mut req: Request, token: &str) {
    let path = req.url().split('?').next().unwrap_or("/").to_string();
    let method = req.method().clone();

    if path == "/health" {
        let _ = req.respond(resp_text(200, "application/json", "{\"ok\":true}".into()));
        return;
    }
    // The home-screen icon: token-free (it's just a logo, no vault data) so iOS
    // can fetch it when the user adds the page to their home screen.
    if path == "/icon.svg" {
        let _ = req.respond(resp_text(200, "image/svg+xml", ICON_SVG.into()));
        return;
    }
    // Service worker + manifest: token-free. They hold no vault data, and the
    // browser fetches them out-of-band (SW update checks, manifest parse) where
    // a missing token would otherwise quietly break push.
    if path == "/phone-sw.js" {
        let _ = req.respond(resp_text(200, "application/javascript; charset=utf-8", PHONE_SW.to_string()));
        return;
    }
    if path == "/manifest.webmanifest" {
        let _ = req.respond(resp_text(200, "application/manifest+json", PHONE_MANIFEST.to_string()));
        return;
    }
    if !token_ok(&req, token) {
        let _ = req.respond(resp_text(401, "application/json", "{\"error\":\"unauthorized\"}".into()));
        return;
    }

    match (method, path.as_str()) {
        (Method::Get, "/voice") => {
            let _ = req.respond(resp_text(200, "text/html; charset=utf-8", VOICE_PAGE.to_string()));
        }
        (Method::Get, "/phone") => {
            let _ = req.respond(resp_text(200, "text/html; charset=utf-8", PHONE_PAGE.to_string()));
        }
        (Method::Get, "/conversations") => {
            let body = match current_vault() {
                Some(vault) => resp_text(200, "application/json", conversations_summary_json(&vault)),
                None => resp_text(503, "application/json", "{\"error\":\"no vault open on the box\"}".into()),
            };
            let _ = req.respond(body);
        }
        (Method::Get, "/conversation") => {
            let id = query_param(req.url(), "id").unwrap_or_default();
            let n = query_param(req.url(), "n")
                .and_then(|v| v.parse::<usize>().ok())
                .unwrap_or(60);
            let body = match current_vault() {
                Some(vault) => match conversation_json(&vault, &id, n) {
                    Some(j) => resp_text(200, "application/json", j),
                    None => resp_text(404, "application/json", "{\"error\":\"conversation not found\"}".into()),
                },
                None => resp_text(503, "application/json", "{\"error\":\"no vault open on the box\"}".into()),
            };
            let _ = req.respond(body);
        }
        (Method::Get, "/file") => {
            serve_vault_file(req);
            return;
        }
        (Method::Get, "/events") => {
            let (tx, rx) = mpsc::channel::<String>();
            sse_clients().lock().unwrap_or_else(|e| e.into_inner()).push(tx);
            let stream = SseStream::new(rx);
            let headers = vec![
                Header::from_bytes(&b"Content-Type"[..], &b"text/event-stream; charset=utf-8"[..]).unwrap(),
                Header::from_bytes(&b"Cache-Control"[..], &b"no-cache"[..]).unwrap(),
            ];
            let response = Response::new(tiny_http::StatusCode(200), headers, stream, None, None);
            let _ = req.respond(response);
            return;
        }
        (Method::Get, "/status") => {
            let body = match relay_request("phone:status", json!({}), Duration::from_secs(10)) {
                Some(j) if !j.is_empty() => resp_text(200, "application/json", j),
                _ => resp_text(503, "application/json", "{\"error\":\"app not answering — is a vault open?\"}".into()),
            };
            let _ = req.respond(body);
        }
        (Method::Post, "/message") => {
            let mut raw = String::new();
            let _ = req.as_reader().read_to_string(&mut raw);
            let payload: Value = serde_json::from_str(&raw).unwrap_or(json!({}));
            let body = match relay_request("phone:msg", payload, Duration::from_secs(15)) {
                Some(j) if !j.is_empty() => resp_text(200, "application/json", j),
                _ => resp_text(503, "application/json", "{\"error\":\"app not answering — is a vault open?\"}".into()),
            };
            let _ = req.respond(body);
        }
        (Method::Post, "/kill") => {
            let mut raw = String::new();
            let _ = req.as_reader().read_to_string(&mut raw);
            let payload: Value = serde_json::from_str(&raw).unwrap_or(json!({}));
            let body = match relay_request("phone:kill", payload, Duration::from_secs(10)) {
                Some(j) if !j.is_empty() => resp_text(200, "application/json", j),
                _ => resp_text(503, "application/json", "{\"error\":\"app not answering\"}".into()),
            };
            let _ = req.respond(body);
        }
        (Method::Get, "/push/vapid") => {
            let body = match vapid_pub() {
                Some(k) => resp_text(200, "application/json", json!({ "key": k }).to_string()),
                None => resp_text(503, "application/json", "{\"error\":\"push not initialized yet\"}".into()),
            };
            let _ = req.respond(body);
        }
        (Method::Post, "/push/subscribe") => {
            let mut raw = String::new();
            let _ = req.as_reader().read_to_string(&mut raw);
            let v: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
            // Accept either a bare PushSubscription JSON or {subscription: …}.
            let sub = v.get("subscription").cloned().unwrap_or(v);
            if sub.get("endpoint").and_then(|e| e.as_str()).is_some() {
                push_subs_add(sub);
                let _ = req.respond(resp_text(200, "application/json", "{\"ok\":true}".into()));
            } else {
                let _ = req.respond(resp_text(400, "application/json", "{\"error\":\"missing endpoint\"}".into()));
            }
        }
        (Method::Post, "/push/unsubscribe") => {
            let mut raw = String::new();
            let _ = req.as_reader().read_to_string(&mut raw);
            let v: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
            if let Some(ep) = v.get("endpoint").and_then(|e| e.as_str()) {
                push_subs_remove(ep);
            }
            let _ = req.respond(resp_text(200, "application/json", "{\"ok\":true}".into()));
        }
        (Method::Post, "/push/test") => {
            let body = match relay_request("phone:pushtest", json!({}), Duration::from_secs(15)) {
                Some(j) if !j.is_empty() => resp_text(200, "application/json", j),
                _ => resp_text(503, "application/json", "{\"error\":\"app not answering\"}".into()),
            };
            let _ = req.respond(body);
        }
        (Method::Post, "/session") => {
            // Fresh-first: pull the context from the app right now (no push-
            // timing window, current document state). Cached push is the
            // fallback so a momentarily-busy frontend doesn't break connect.
            let ctx = request_fresh_context()
                .or_else(|| ctx_slot().lock().unwrap_or_else(|e| e.into_inner()).clone());
            let body = match ctx {
                Some(ctx) => match mint_session(&ctx) {
                    Ok(j) => resp_text(200, "application/json", j),
                    Err(e) => resp_text(
                        502,
                        "application/json",
                        json!({ "error": e }).to_string(),
                    ),
                },
                None => resp_text(
                    503,
                    "application/json",
                    json!({ "error": "voice host not ready — the vault-chat app hosting this link needs a vault open and an ElevenLabs key set (it pushes context every ~20s)" }).to_string(),
                ),
            };
            let _ = req.respond(body);
        }
        (Method::Post, "/tool") => {
            let mut raw = String::new();
            let _ = req.as_reader().read_to_string(&mut raw);
            let result = run_tool(&raw);
            // EL feeds the body straight back to the model as the tool result, so
            // we return plain text (the answer, or a refusal/error message).
            let _ = req.respond(resp_text(200, "text/plain; charset=utf-8", result));
        }
        _ => {
            let _ = req.respond(resp_text(404, "application/json", "{\"error\":\"not found\"}".into()));
        }
    }
}

fn mint_session(ctx: &Ctx) -> Result<String, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!(
        "https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id={}",
        ctx.agent_id
    );
    let resp = client
        .get(url)
        .header("xi-api-key", &ctx.el_key)
        .send()
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().unwrap_or_default();
    if !status.is_success() {
        return Err(format!("ElevenLabs {}: {}", status.as_u16(), text));
    }
    let j: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let signed = j
        .get("signed_url")
        .and_then(|v| v.as_str())
        .ok_or("no signed_url in ElevenLabs response")?;
    Ok(json!({
        "signedUrl": signed,
        "systemPrompt": ctx.system_prompt,
        "voiceId": ctx.voice_id,
        "dynamicVariables": ctx.dynamic_vars,
        "toolNames": ctx.tool_names,
    })
    .to_string())
}

// ---- safe, read-only tool dispatch ----

/// Resolve a vault-relative or absolute path and confirm it stays inside the
/// vault. Returns None on escape — the read tools refuse anything outside.
fn within_vault(vault: &str, path: &str) -> Option<PathBuf> {
    let root = Path::new(vault);
    let target = if Path::new(path).is_absolute() {
        PathBuf::from(path)
    } else {
        root.join(path)
    };
    let cr = root.canonicalize().ok()?;
    let ct = target.canonicalize().ok()?;
    if ct.starts_with(&cr) {
        Some(ct)
    } else {
        None
    }
}

// ---- full tool parity: relay to the desktop app's real handlers ----

static APP: OnceLock<Mutex<Option<tauri::AppHandle>>> = OnceLock::new();
static PENDING: OnceLock<Mutex<HashMap<String, mpsc::Sender<String>>>> = OnceLock::new();
static REQ: AtomicU64 = AtomicU64::new(1);

fn app_slot() -> &'static Mutex<Option<tauri::AppHandle>> {
    APP.get_or_init(|| Mutex::new(None))
}
fn pending() -> &'static Mutex<HashMap<String, mpsc::Sender<String>>> {
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Hand the server the running app's handle so it can relay tool calls to it.
pub fn set_app(app: tauri::AppHandle) {
    *app_slot().lock().unwrap_or_else(|e| e.into_inner()) = Some(app);
}

/// Resolve a phone tool call the desktop app fulfilled, by request id.
pub fn tool_respond(req_id: String, result: String) {
    if let Some(tx) = pending().lock().unwrap_or_else(|e| e.into_inner()).remove(&req_id) {
        let _ = tx.send(result);
    }
}

// ---- phone chat: SSE clients, push subscriptions, generic relay ----

static SSE_CLIENTS: OnceLock<Mutex<Vec<mpsc::Sender<String>>>> = OnceLock::new();
static VAPID_PUB: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn sse_clients() -> &'static Mutex<Vec<mpsc::Sender<String>>> {
    SSE_CLIENTS.get_or_init(|| Mutex::new(Vec::new()))
}

/// Fan a JSON event line out to every connected `/events` stream. Dead clients
/// (closed sockets → dropped receivers) are pruned on the way through.
pub fn broadcast_event(json_line: String) {
    let mut v = sse_clients().lock().unwrap_or_else(|e| e.into_inner());
    v.retain(|tx| tx.send(json_line.clone()).is_ok());
}

/// The frontend's VAPID public key (base64url, 65-byte raw P-256 point). The
/// page needs it for `pushManager.subscribe`.
pub fn set_vapid_pub(key: String) {
    *VAPID_PUB.get_or_init(|| Mutex::new(None)).lock().unwrap_or_else(|e| e.into_inner()) =
        Some(key);
}

fn vapid_pub() -> Option<String> {
    VAPID_PUB.get_or_init(|| Mutex::new(None)).lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Push subscriptions live in the app config dir (machine-local, not in any
/// vault — they're device credentials, not notes).
fn subs_path() -> Option<PathBuf> {
    let app = app_slot().lock().unwrap_or_else(|e| e.into_inner()).clone()?;
    let dir = app.path().app_config_dir().ok()?;
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("phone-push-subs.json"))
}

pub fn push_subs_list() -> String {
    let Some(p) = subs_path() else { return "[]".into() };
    std::fs::read_to_string(p).unwrap_or_else(|_| "[]".into())
}

fn push_subs_add(sub: Value) {
    let Some(p) = subs_path() else { return };
    let endpoint = sub.get("endpoint").and_then(|e| e.as_str()).unwrap_or("").to_string();
    if endpoint.is_empty() {
        return;
    }
    let mut list: Vec<Value> = std::fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    list.retain(|s| s.get("endpoint").and_then(|e| e.as_str()) != Some(endpoint.as_str()));
    list.push(sub);
    let _ = std::fs::write(&p, serde_json::to_string_pretty(&list).unwrap_or_else(|_| "[]".into()));
}

pub fn push_subs_remove(endpoint: &str) {
    let Some(p) = subs_path() else { return };
    let mut list: Vec<Value> = std::fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    list.retain(|s| s.get("endpoint").and_then(|e| e.as_str()) != Some(endpoint));
    let _ = std::fs::write(&p, serde_json::to_string_pretty(&list).unwrap_or_else(|_| "[]".into()));
}

/// Generic request→webview relay (same machinery as `run_tool` /
/// `request_fresh_context`): emit `event` with a reqId merged into `payload`,
/// wait for the frontend to answer via `voice_tool_respond`. None on no app,
/// emit failure, or timeout.
fn relay_request(event: &str, mut payload: Value, timeout: Duration) -> Option<String> {
    let app = app_slot().lock().unwrap_or_else(|e| e.into_inner()).clone()?;
    let id = REQ.fetch_add(1, Ordering::Relaxed).to_string();
    let (tx, rx) = mpsc::channel::<String>();
    pending().lock().unwrap_or_else(|e| e.into_inner()).insert(id.clone(), tx);
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("reqId".into(), json!(id));
    }
    if app.emit(event, payload).is_err() {
        pending().lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
        return None;
    }
    let out = rx.recv_timeout(timeout);
    pending().lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    out.ok()
}

/// Ask the running app for FRESH voice context (same relay pattern as tools):
/// emit `voice:context`, the frontend builds the context with the exact desktop
/// builders and answers by req id. This is what kills the 503 window at its
/// root — /session no longer depends on a heartbeat push having landed first —
/// and it means the phone connects with the *current* context (open document,
/// live dynamic vars), not an up-to-20s-stale snapshot. Caches the result so
/// the pushed-context path stays a warm fallback.
fn request_fresh_context() -> Option<Ctx> {
    let app = app_slot().lock().unwrap_or_else(|e| e.into_inner()).clone()?;
    let id = REQ.fetch_add(1, Ordering::Relaxed).to_string();
    let (tx, rx) = mpsc::channel::<String>();
    pending().lock().unwrap_or_else(|e| e.into_inner()).insert(id.clone(), tx);
    if app.emit("voice:context", json!({ "reqId": id })).is_err() {
        pending().lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
        return None;
    }
    let out = rx.recv_timeout(Duration::from_secs(8));
    pending().lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    let s = out.ok()?;
    let v: Value = serde_json::from_str(&s).ok()?;
    let get = |k: &str| v.get(k).and_then(|x| x.as_str()).map(|x| x.to_string());
    let ctx = Ctx {
        el_key: get("elKey")?,
        agent_id: get("agentId")?,
        voice_id: get("voiceId").unwrap_or_default(),
        system_prompt: get("systemPrompt").unwrap_or_default(),
        dynamic_vars: v.get("dynamicVariables").cloned().unwrap_or_else(|| json!({})),
        tool_names: v
            .get("toolNames")
            .and_then(|x| x.as_array())
            .map(|a| a.iter().filter_map(|t| t.as_str().map(String::from)).collect())
            .unwrap_or_default(),
        vault: get("vault")?,
    };
    *ctx_slot().lock().unwrap_or_else(|e| e.into_inner()) = Some(ctx.clone());
    Some(ctx)
}

/// Run a tool with FULL desktop parity: relay it to the running app, which
/// executes the exact same handler the desktop voice agent uses, against the
/// vault. Falls back to the local read-only dispatch only if the app can't be
/// reached (no handle, emit failed, or it didn't answer in time) — so a read
/// still works even if the relay is momentarily down.
fn run_tool(raw: &str) -> String {
    let app = app_slot().lock().unwrap_or_else(|e| e.into_inner()).clone();
    let Some(app) = app else {
        return dispatch_tool(raw);
    };
    let v: Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => return "error: malformed tool request".into(),
    };
    let id = REQ.fetch_add(1, Ordering::Relaxed).to_string();
    let (tx, rx) = mpsc::channel::<String>();
    pending().lock().unwrap_or_else(|e| e.into_inner()).insert(id.clone(), tx);
    let payload = json!({
        "reqId": id,
        "name": v.get("name").cloned().unwrap_or(Value::Null),
        "arguments": v.get("arguments").or_else(|| v.get("parameters")).cloned().unwrap_or(json!({})),
    });
    if app.emit("voice:tool", payload).is_err() {
        pending().lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
        return dispatch_tool(raw);
    }
    let out = rx.recv_timeout(Duration::from_secs(25));
    pending().lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    match out {
        Ok(s) => s,
        Err(_) => dispatch_tool(raw),
    }
}

fn dispatch_tool(raw: &str) -> String {
    let v: Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => return "error: malformed tool request".into(),
    };
    let name = v.get("name").and_then(|x| x.as_str()).unwrap_or("");
    // EL may nest args under "arguments" or "parameters", or pass them flat.
    let args = v
        .get("arguments")
        .or_else(|| v.get("parameters"))
        .cloned()
        .unwrap_or_else(|| v.clone());
    let ctx = match ctx_slot().lock().unwrap_or_else(|e| e.into_inner()).clone() {
        Some(c) => c,
        None => return "error: voice host not ready".into(),
    };
    let vault = &ctx.vault;
    let s = |k: &str| args.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();

    match name {
        "Read" => {
            let path = s("path");
            match within_vault(vault, &path) {
                Some(p) => match std::fs::read_to_string(&p) {
                    Ok(text) => truncate(&text, 12_000),
                    Err(e) => format!("error reading {}: {}", path, e),
                },
                None => format!("error: {} is outside the vault", path),
            }
        }
        "Glob" => {
            let pattern = s("pattern");
            let full = format!("{}/{}", vault, pattern.trim_start_matches('/'));
            match glob::glob(&full) {
                Ok(paths) => {
                    let mut out: Vec<String> = paths
                        .flatten()
                        .filter_map(|p| {
                            p.strip_prefix(vault)
                                .ok()
                                .map(|r| r.to_string_lossy().replace('\\', "/"))
                        })
                        .collect();
                    out.sort();
                    out.truncate(200);
                    if out.is_empty() {
                        "(no matches)".into()
                    } else {
                        out.join("\n")
                    }
                }
                Err(e) => format!("error: bad pattern: {}", e),
            }
        }
        "GitLog" => {
            let subdir = s("subdir");
            let rel = subdir.trim();
            let dir = if rel.is_empty() || rel == "." {
                vault.clone()
            } else {
                format!("{}/{}", vault, rel)
            };
            let n = format!(
                "-n{}",
                args.get("max_count").and_then(|x| x.as_u64()).unwrap_or(30).min(200)
            );
            let mut a: Vec<String> = vec!["log".into(), "--oneline".into(), "--no-color".into(), n];
            let since = s("since");
            if !since.trim().is_empty() {
                a.push(format!("--since={}", since.trim()));
            }
            let author = s("author");
            if !author.trim().is_empty() {
                a.push(format!("--author={}", author.trim()));
            }
            let refs: Vec<&str> = a.iter().map(|x| x.as_str()).collect();
            match crate::run_git(&dir, &refs) {
                Ok((out, _, 0)) if !out.trim().is_empty() => truncate(out.trim(), 6_000),
                Ok(_) => "(no commits match)".into(),
                Err(e) => format!("error: {}", e),
            }
        }
        "ListConversations" => list_conversations(vault),
        "ReadConversation" => read_conversation(vault, &s("conversation_id"), args.get("last_n").and_then(|x| x.as_u64()).unwrap_or(12) as usize),
        // Everything else — writes, Bash, edits, deletes, worker control — is
        // deliberately unavailable over the phone channel.
        other => format!(
            "\"{}\" isn't available over phone voice — this channel is read-only (read files, search, git history, conversations). Ask me to look things up or talk it through instead.",
            other
        ),
    }
}

fn conversations(vault: &str) -> Vec<Value> {
    let dir = Path::new(vault).join(crate::NOTES_DIR).join(crate::CONVERSATIONS_DIR);
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("jsonl") {
                continue;
            }
            if let Ok(contents) = std::fs::read_to_string(&p) {
                if let Some(s) = crate::reconstruct_conversation(&contents) {
                    if let Ok(v) = serde_json::from_str::<Value>(&s) {
                        out.push(v);
                    }
                }
            }
        }
    }
    out
}

fn list_conversations(vault: &str) -> String {
    let mut convs = conversations(vault);
    convs.sort_by_key(|c| std::cmp::Reverse(c.get("lastActivityAt").and_then(|x| x.as_i64()).unwrap_or(0)));
    let lines: Vec<String> = convs
        .iter()
        .take(25)
        .map(|c| {
            let id = c.get("id").and_then(|x| x.as_str()).unwrap_or("?");
            let title = c.get("title").and_then(|x| x.as_str()).unwrap_or("(untitled)");
            let n = c.get("messages").and_then(|x| x.as_array()).map(|a| a.len()).unwrap_or(0);
            format!("{} — {} ({} msgs)", id, title, n)
        })
        .collect();
    if lines.is_empty() {
        "(no conversations)".into()
    } else {
        lines.join("\n")
    }
}

fn read_conversation(vault: &str, id: &str, last_n: usize) -> String {
    let n = last_n.clamp(1, 50);
    let convs = conversations(vault);
    let Some(c) = convs.iter().find(|c| c.get("id").and_then(|x| x.as_str()) == Some(id)) else {
        return format!("conversation {} not found", id);
    };
    let title = c.get("title").and_then(|x| x.as_str()).unwrap_or("(untitled)");
    let msgs = c.get("messages").and_then(|x| x.as_array()).cloned().unwrap_or_default();
    let tail: Vec<String> = msgs
        .iter()
        .rev()
        .take(n)
        .rev()
        .map(|m| {
            let role = m.get("role").and_then(|x| x.as_str()).unwrap_or("?");
            let content = m.get("content").and_then(|x| x.as_str()).unwrap_or("");
            format!("[{}] {}", role, truncate(content, 600))
        })
        .collect();
    format!("{}\n\n{}", title, tail.join("\n\n"))
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        let cut: String = s.chars().take(max).collect();
        format!("{}\n…[truncated]", cut)
    }
}

// ---- phone chat: helpers ----

/// The vault the phone surfaces talk to: the cached voice context's vault when
/// present, else a lightweight vault-only relay. The chat surface must NOT
/// depend on an ElevenLabs key — the full context (and its fresh-context path)
/// does, but `phone:vault` only needs a vault to be open.
fn current_vault() -> Option<String> {
    if let Some(c) = ctx_slot().lock().unwrap_or_else(|e| e.into_inner()).clone() {
        return Some(c.vault);
    }
    let v = relay_request("phone:vault", json!({}), Duration::from_secs(3))?;
    let v = v.trim().to_string();
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                if let Ok(b) = u8::from_str_radix(hex, 16) {
                    out.push(b);
                    i += 3;
                } else {
                    out.push(bytes[i]);
                    i += 1;
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn query_param(url: &str, key: &str) -> Option<String> {
    let q = url.split('?').nth(1)?;
    for kv in q.split('&') {
        let mut it = kv.splitn(2, '=');
        if it.next() == Some(key) {
            return Some(percent_decode(it.next().unwrap_or("")));
        }
    }
    None
}

/// Conversation list for the phone page: light rows, newest first, no message
/// bodies beyond a one-line preview. Attachments and hidden preambles never
/// leave the box.
fn conversations_summary_json(vault: &str) -> String {
    let mut convs = conversations(vault);
    convs.sort_by_key(|c| std::cmp::Reverse(c.get("lastActivityAt").and_then(|x| x.as_i64()).unwrap_or(0)));
    let rows: Vec<Value> = convs
        .iter()
        .take(60)
        .map(|c| {
            let msgs = c.get("messages").and_then(|x| x.as_array()).cloned().unwrap_or_default();
            let preview = msgs
                .iter()
                .rev()
                .find(|m| {
                    m.get("hidden").and_then(|h| h.as_bool()) != Some(true)
                        && !m.get("content").and_then(|x| x.as_str()).unwrap_or("").trim().is_empty()
                })
                .map(|m| {
                    let t = m.get("content").and_then(|x| x.as_str()).unwrap_or("");
                    let collapsed = t.split_whitespace().collect::<Vec<_>>().join(" ");
                    let cut: String = collapsed.chars().take(120).collect();
                    cut
                })
                .unwrap_or_default();
            json!({
                "id": c.get("id").and_then(|x| x.as_str()).unwrap_or(""),
                "title": c.get("title").and_then(|x| x.as_str()).unwrap_or("New chat"),
                "lastActivityAt": c.get("lastActivityAt").and_then(|x| x.as_i64()).unwrap_or(0),
                "source": c.get("source").and_then(|x| x.as_str()).unwrap_or("manual"),
                "msgCount": msgs.len(),
                "preview": preview,
            })
        })
        .collect();
    json!({ "vault": Path::new(vault).file_name().and_then(|x| x.to_str()).unwrap_or(vault), "conversations": rows })
        .to_string()
}

/// One conversation for the thread view: last `n` non-hidden messages with
/// role, content (capped), and tool names. Attachment data URLs are stripped —
/// the phone fetches images via /file if the text references them.
fn conversation_json(vault: &str, id: &str, n: usize) -> Option<String> {
    let convs = conversations(vault);
    let c = convs.iter().find(|c| c.get("id").and_then(|x| x.as_str()) == Some(id))?;
    let msgs = c.get("messages").and_then(|x| x.as_array()).cloned().unwrap_or_default();
    let take = n.clamp(1, 200);
    let visible: Vec<Value> = msgs
        .iter()
        .filter(|m| m.get("hidden").and_then(|h| h.as_bool()) != Some(true))
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .take(take)
        .rev()
        .map(|m| {
            let tools: Vec<String> = m
                .get("toolCalls")
                .and_then(|x| x.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|t| t.get("name").and_then(|x| x.as_str()).map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            json!({
                "role": m.get("role").and_then(|x| x.as_str()).unwrap_or("assistant"),
                "content": truncate(m.get("content").and_then(|x| x.as_str()).unwrap_or(""), 20_000),
                "system": m.get("system").and_then(|x| x.as_bool()).unwrap_or(false),
                "tools": tools,
            })
        })
        .collect();
    Some(
        json!({
            "id": id,
            "title": c.get("title").and_then(|x| x.as_str()).unwrap_or("New chat"),
            "source": c.get("source").and_then(|x| x.as_str()).unwrap_or("manual"),
            "status": c.get("status").and_then(|x| x.as_str()).unwrap_or("idle"),
            "messages": visible,
        })
        .to_string(),
    )
}

fn mime_for(path: &Path) -> &'static str {
    match path.extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "md" | "txt" | "log" | "csv" | "tex" => "text/plain; charset=utf-8",
        "html" | "htm" => "text/html; charset=utf-8",
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "json" | "ipynb" | "jsonl" => "application/json",
        "mp4" => "video/mp4",
        "mp3" => "audio/mpeg",
        _ => "application/octet-stream",
    }
}

/// Read-only, vault-contained file serving so "details in the goal doc" is a
/// tap on the phone instead of a path it can't open.
fn serve_vault_file(req: Request) {
    const MAX_BYTES: u64 = 50 * 1024 * 1024;
    let Some(raw_path) = query_param(req.url(), "path") else {
        let _ = req.respond(resp_text(400, "application/json", "{\"error\":\"missing path\"}".into()));
        return;
    };
    let Some(vault) = current_vault() else {
        let _ = req.respond(resp_text(503, "application/json", "{\"error\":\"no vault open on the box\"}".into()));
        return;
    };
    let Some(full) = within_vault(&vault, &raw_path) else {
        let _ = req.respond(resp_text(403, "application/json", "{\"error\":\"outside the vault\"}".into()));
        return;
    };
    match std::fs::metadata(&full) {
        Ok(m) if m.len() > MAX_BYTES => {
            let _ = req.respond(resp_text(413, "application/json", "{\"error\":\"file too large (50MB cap)\"}".into()));
        }
        Ok(_) => match std::fs::read(&full) {
            Ok(bytes) => {
                let mut r = Response::from_data(bytes);
                if let Ok(h) = Header::from_bytes(&b"Content-Type"[..], mime_for(&full).as_bytes()) {
                    r = r.with_header(h);
                }
                let _ = req.respond(r);
            }
            Err(e) => {
                let _ = req.respond(resp_text(500, "application/json", json!({ "error": e.to_string() }).to_string()));
            }
        },
        Err(e) => {
            let _ = req.respond(resp_text(404, "application/json", json!({ "error": e.to_string() }).to_string()));
        }
    }
}

/// Streaming body for `/events`: blocks on the broadcast channel, emits SSE
/// frames, keeps the connection warm with comment pings, and caps a session at
/// 30 minutes (EventSource reconnects transparently).
struct SseStream {
    rx: mpsc::Receiver<String>,
    pending: Vec<u8>,
    pos: usize,
    opened: Instant,
}

impl SseStream {
    fn new(rx: mpsc::Receiver<String>) -> Self {
        SseStream {
            rx,
            // Tell EventSource to retry quickly after our 30-min cap or an app
            // restart, and confirm liveness immediately on connect.
            pending: b"retry: 3000\n\n: connected\n\n".to_vec(),
            pos: 0,
            opened: Instant::now(),
        }
    }
}

impl std::io::Read for SseStream {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        loop {
            if self.pos < self.pending.len() {
                let n = (self.pending.len() - self.pos).min(buf.len());
                buf[..n].copy_from_slice(&self.pending[self.pos..self.pos + n]);
                self.pos += n;
                return Ok(n);
            }
            if self.opened.elapsed() > Duration::from_secs(30 * 60) {
                return Ok(0);
            }
            match self.rx.recv_timeout(Duration::from_secs(15)) {
                Ok(msg) => {
                    self.pending = format!("data: {}\n\n", msg).into_bytes();
                    self.pos = 0;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    self.pending = b": ping\n\n".to_vec();
                    self.pos = 0;
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(0),
            }
        }
    }
}
