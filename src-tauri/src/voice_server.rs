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
//! store diffs into a seq-numbered event ring the phone long-polls (`/poll`).
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
/// Deliberately NO `start_url`: iOS would launch it verbatim, dropping the
/// `?token=` from the link the user added to their home screen — the bare page
/// then 401'd. Without it, the add-time URL (token included) is what launches,
/// and the page persists the token to the web-app's own storage container.
const PHONE_MANIFEST: &str = r##"{
  "name": "vault-chat",
  "short_name": "vault-chat",
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
    // The chat page SHELL is token-free: it's static HTML/JS with zero vault
    // data, and a home-screen launch can arrive without the query token (the
    // page then uses its stored copy for every data call — which all stay
    // token-gated). Serving 401 JSON as the "page" was the home-screen bug.
    if path == "/phone" && method == Method::Get {
        let _ = req.respond(resp_text(200, "text/html; charset=utf-8", PHONE_PAGE.to_string()));
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
        (Method::Get, "/surface") => {
            // Explicit "pull this thread into recent/history" signal. Only the
            // phone's thread-open entry points (a worker opened from a mission or
            // the Activity board, or an alert's Open-thread) call this — so
            // fetching a conversation, polling it, or reopening it from the recent
            // pane no longer re-pins it to the top or re-marks it unread
            // (note ec78cbf8). Fire-and-forget; the app no-ops if it's already
            // surfaced or isn't a worker/mission.
            let id = query_param(req.url(), "id").unwrap_or_default();
            if !id.is_empty() {
                let id_for_relay = id.clone();
                std::thread::spawn(move || {
                    let _ = relay_request(
                        "phone:surface",
                        json!({ "convId": id_for_relay }),
                        Duration::from_secs(4),
                    );
                });
            }
            let _ = req.respond(resp_text(200, "application/json", "{\"ok\":true}".into()));
        }
        (Method::Get, "/conversation") => {
            let id = query_param(req.url(), "id").unwrap_or_default();
            let n = query_param(req.url(), "n")
                .and_then(|v| v.parse::<usize>().ok())
                .unwrap_or(60);
            // Fetching a conversation is side-effect-free — surfacing is now an
            // explicit /surface call from the thread-open paths (note ec78cbf8).
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
        (Method::Get, "/poll") => {
            // Long-poll: hold up to 25s for events newer than `after`. The
            // first call passes after=latest to take a cursor without replay.
            let after_raw = query_param(req.url(), "after").unwrap_or_default();
            if after_raw.is_empty() || after_raw == "latest" {
                let body = format!("{{\"next\":{},\"events\":[]}}", latest_seq());
                let _ = req.respond(resp_text(200, "application/json", body));
                return;
            }
            let after: u64 = after_raw.parse().unwrap_or_else(|_| latest_seq());
            let deadline = Instant::now() + Duration::from_secs(25);
            loop {
                let (events, next) = events_after(after);
                if !events.is_empty() || Instant::now() >= deadline {
                    let body = format!("{{\"next\":{},\"events\":[{}]}}", next, events.join(","));
                    let _ = req.respond(resp_text(200, "application/json", body));
                    return;
                }
                std::thread::sleep(Duration::from_millis(250));
            }
        }
        (Method::Get, "/notifications") => {
            let body = match current_vault() {
                Some(vault) => resp_text(200, "application/json", notifications_json(&vault)),
                None => resp_text(503, "application/json", "{\"error\":\"no vault open on the box\"}".into()),
            };
            let _ = req.respond(body);
        }
        (Method::Get, "/notes") => {
            let body = match current_vault() {
                Some(vault) => resp_text(200, "application/json", notes_json(&vault)),
                None => resp_text(503, "application/json", "{\"error\":\"no vault open on the box\"}".into()),
            };
            let _ = req.respond(body);
        }
        (Method::Post, "/notes") => {
            // Capture a new note from the phone. Relay to the app so it goes
            // through the same buildNote/addNote path the desktop uses (live
            // store update + disk append), rather than hand-rolling the JSON here.
            let mut raw = String::new();
            let _ = req.as_reader().read_to_string(&mut raw);
            let payload: Value = serde_json::from_str(&raw).unwrap_or(json!({}));
            let body = match relay_request("phone:note", payload, Duration::from_secs(10)) {
                Some(j) if !j.is_empty() => resp_text(200, "application/json", j),
                _ => resp_text(503, "application/json", "{\"error\":\"app not answering\"}".into()),
            };
            let _ = req.respond(body);
        }
        (Method::Post, "/notes/status") => {
            // Resolve / reopen a note from the phone (swipe-to-resolve). Relay to
            // the app so the change is applied against the freshest on-disk notes
            // and persisted the same way the desktop does — never hand-edit the
            // jsonl here (a stale view could blank a note's content).
            let mut raw = String::new();
            let _ = req.as_reader().read_to_string(&mut raw);
            let payload: Value = serde_json::from_str(&raw).unwrap_or(json!({}));
            let body = match relay_request("phone:note-status", payload, Duration::from_secs(10)) {
                Some(j) if !j.is_empty() => resp_text(200, "application/json", j),
                _ => resp_text(503, "application/json", "{\"error\":\"app not answering\"}".into()),
            };
            let _ = req.respond(body);
        }
        (Method::Post, "/notifications/read") => {
            let mut raw = String::new();
            let _ = req.as_reader().read_to_string(&mut raw);
            let v: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
            if let (Some(vault), Some(id)) = (current_vault(), v.get("id").and_then(|x| x.as_str())) {
                let marker = json!({ "type": "read", "id": id, "ts": now_ms() }).to_string();
                notification_append(&vault, &marker);
                let _ = req.respond(resp_text(200, "application/json", "{\"ok\":true}".into()));
            } else {
                let _ = req.respond(resp_text(400, "application/json", "{\"error\":\"missing id or vault\"}".into()));
            }
        }
        (Method::Post, "/notifications/hide") => {
            // Swipe in the Archive: remove from view for good. Append-only
            // marker — the underlying record stays in the jsonl.
            let mut raw = String::new();
            let _ = req.as_reader().read_to_string(&mut raw);
            let v: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
            if let (Some(vault), Some(id)) = (current_vault(), v.get("id").and_then(|x| x.as_str())) {
                let marker = json!({ "type": "hide", "id": id, "ts": now_ms() }).to_string();
                notification_append(&vault, &marker);
                let _ = req.respond(resp_text(200, "application/json", "{\"ok\":true}".into()));
            } else {
                let _ = req.respond(resp_text(400, "application/json", "{\"error\":\"missing id or vault\"}".into()));
            }
        }
        (Method::Get, "/schedules") => {
            let body = match relay_request("phone:schedules", json!({}), Duration::from_secs(10)) {
                Some(j) if !j.is_empty() => resp_text(200, "application/json", j),
                _ => resp_text(503, "application/json", "{\"error\":\"app not answering — is a vault open?\"}".into()),
            };
            let _ = req.respond(body);
        }
        (Method::Post, "/schedule") => {
            let mut raw = String::new();
            let _ = req.as_reader().read_to_string(&mut raw);
            let payload: Value = serde_json::from_str(&raw).unwrap_or(json!({}));
            let body = match relay_request("phone:schedule", payload, Duration::from_secs(10)) {
                Some(j) if !j.is_empty() => resp_text(200, "application/json", j),
                _ => resp_text(503, "application/json", "{\"error\":\"app not answering\"}".into()),
            };
            let _ = req.respond(body);
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
        (Method::Post, "/chats/clear") => {
            // Purge idle assistant chats (workers/missions/running untouched).
            let body = match relay_request("phone:clearchats", json!({}), Duration::from_secs(15)) {
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
            let mut raw = String::new();
            let _ = req.as_reader().read_to_string(&mut raw);
            let payload: Value = serde_json::from_str(&raw).unwrap_or(json!({}));
            let conv_id = payload.get("convId").and_then(|v| v.as_str()).map(|s| s.to_string());
            let ctx = request_fresh_context(conv_id)
                .or_else(|| ctx_slot().lock().unwrap_or_else(|e| e.into_inner()).clone());
            let body = match ctx {
                Some(ctx) => {
                    // Retry a transient ElevenLabs failure (slow / 5xx get_signed_url)
                    // before surfacing 502 — the phone only auto-retried once, so a
                    // single hiccup here killed the start. Two extra shots, short backoff.
                    let mut minted = mint_session(&ctx);
                    let mut tries = 0;
                    while minted.is_err() && tries < 2 {
                        std::thread::sleep(Duration::from_millis(600));
                        minted = mint_session(&ctx);
                        tries += 1;
                    }
                    match minted {
                        Ok(j) => resp_text(200, "application/json", j),
                        Err(e) => resp_text(
                            502,
                            "application/json",
                            json!({ "error": e }).to_string(),
                        ),
                    }
                }
                None => resp_text(
                    503,
                    "application/json",
                    json!({ "error": "voice host not ready — the vault-chat app hosting this link needs a vault open and an ElevenLabs key set (it pushes context every ~20s)" }).to_string(),
                ),
            };
            let _ = req.respond(body);
        }
        (Method::Post, "/voice-transcript") => {
            // Phone voice talks to ElevenLabs directly; relay each completed turn
            // to the app so it persists into the session's voice thread.
            let mut raw = String::new();
            let _ = req.as_reader().read_to_string(&mut raw);
            let v: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
            let role = v.get("role").and_then(|x| x.as_str()).unwrap_or("assistant");
            let text = v.get("text").and_then(|x| x.as_str()).unwrap_or("");
            if !text.trim().is_empty() {
                if let Some(app) = app_slot().lock().unwrap_or_else(|e| e.into_inner()).clone() {
                    let _ = app.emit("voice:transcript", json!({ "role": role, "text": text }));
                }
            }
            let _ = req.respond(resp_text(200, "application/json", "{\"ok\":true}".into()));
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

// ---- phone chat: event ring (long-poll), push subscriptions, generic relay ----
//
// Live updates use LONG-POLLING, not SSE: chunked event streams can sit in
// buffers anywhere along tiny_http → `tailscale serve` → iOS Safari, which on
// the phone read as "sent hello, nothing happened". A seq-numbered ring +
// 25s-max holds is proxy-proof, reconnect-safe (clients resume from their last
// seq), and naturally survives iOS killing background pages.

static EVENT_SEQ: AtomicU64 = AtomicU64::new(1);
static EVENT_RING: OnceLock<Mutex<std::collections::VecDeque<(u64, String)>>> = OnceLock::new();
static VAPID_PUB: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn event_ring() -> &'static Mutex<std::collections::VecDeque<(u64, String)>> {
    EVENT_RING.get_or_init(|| Mutex::new(std::collections::VecDeque::new()))
}

/// Append one JSON event to the ring for `/poll` clients. Bounded — a phone
/// that's been gone for a while just resyncs its view on reopen.
pub fn broadcast_event(json_line: String) {
    let seq = EVENT_SEQ.fetch_add(1, Ordering::Relaxed);
    let mut r = event_ring().lock().unwrap_or_else(|e| e.into_inner());
    r.push_back((seq, json_line));
    while r.len() > 300 {
        r.pop_front();
    }
}

/// Latest seq handed out (0 = none yet).
fn latest_seq() -> u64 {
    EVENT_SEQ.load(Ordering::Relaxed).saturating_sub(1)
}

/// Events strictly after `after`, plus the new cursor.
fn events_after(after: u64) -> (Vec<String>, u64) {
    let r = event_ring().lock().unwrap_or_else(|e| e.into_inner());
    let mut next = after;
    let mut out = Vec::new();
    for (seq, line) in r.iter() {
        if *seq > after {
            out.push(line.clone());
            next = next.max(*seq);
        }
    }
    (out, next.max(after))
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
fn request_fresh_context(conv_id: Option<String>) -> Option<Ctx> {
    let app = app_slot().lock().unwrap_or_else(|e| e.into_inner()).clone()?;
    let id = REQ.fetch_add(1, Ordering::Relaxed).to_string();
    let (tx, rx) = mpsc::channel::<String>();
    pending().lock().unwrap_or_else(|e| e.into_inner()).insert(id.clone(), tx);
    if app.emit("voice:context", json!({ "reqId": id, "convId": conv_id })).is_err() {
        pending().lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
        return None;
    }
    // 12s (not 8): building the voice context on the app side is an ElevenLabs
    // agent check plus a fan-out of vault file reads, and a busy webview or a
    // git-sync touching files can push it past a tighter budget — which showed
    // up as flaky "voice host not ready". The phone's retry loop tolerates it.
    let out = rx.recv_timeout(Duration::from_secs(12));
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
    let tombstones = crate::conversation_tombstone_stems(vault);
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("jsonl") {
                continue;
            }
            if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
                if tombstones.contains(stem) {
                    continue;
                }
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

// ---- notifications: the agent→you channel (Alerts tab) ----
//
// Append-only JSONL at <vault>/.vault-chat/notifications.jsonl — each line is
// either a notification {id, ts, kind, title, body, convId?} or a read marker
// {type:"read", id, ts}. Append-only + merge=union means multi-machine sync
// can't conflict on it, same trick as conversations.

fn notifications_path(vault: &str) -> PathBuf {
    Path::new(vault).join(crate::NOTES_DIR).join("notifications.jsonl")
}

fn notes_path(vault: &str) -> PathBuf {
    Path::new(vault).join(crate::NOTES_DIR).join("notes.jsonl")
}

/// Whether note row `a` should win over the already-kept row `b` for the same
/// id. A resolved status is authoritative — once resolved on any machine it must
/// not be displaced by a stale open twin — so resolved beats open; among rows of
/// equal resolved-ness the later last_updated wins. Mirrors preferredNote in
/// src/notes.ts so the phone's open count matches the desktop's.
fn note_prefers(a: &Value, b: &Value) -> bool {
    let ar = a.get("status").and_then(|x| x.as_str()) == Some("resolved");
    let br = b.get("status").and_then(|x| x.as_str()) == Some("resolved");
    if ar != br {
        return ar;
    }
    let as_ = a.get("last_updated").and_then(|x| x.as_str()).unwrap_or("");
    let bs = b.get("last_updated").and_then(|x| x.as_str()).unwrap_or("");
    as_ >= bs
}

/// Notes for the phone Notes page: newest first (reverse-chron like the desktop
/// NotesPanel), deduped by id across union-merge sync (resolved-wins, then newer
/// last_updated — see note_prefers), and slimmed — base64 anchor images are
/// stripped (they bloat the payload; the phone shows text) and turn bodies are
/// capped. Read-only: editing/resolving a note still happens on the desktop.
fn notes_json(vault: &str) -> String {
    let raw = std::fs::read_to_string(notes_path(vault)).unwrap_or_default();
    let mut by_id: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
    for line in raw.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        let Some(id) = v.get("id").and_then(|x| x.as_str()) else { continue };
        let id = id.to_string();
        let keep = match by_id.get(&id) {
            Some(prev) => note_prefers(&v, prev),
            None => true,
        };
        if keep {
            by_id.insert(id, v);
        }
    }
    let mut list: Vec<Value> = by_id.into_values().map(|v| slim_note(&v)).collect();
    // Reverse-chronological by last_updated; ISO-8601 strings sort lexically.
    list.sort_by(|a, b| {
        let ka = a.get("last_updated").and_then(|x| x.as_str()).unwrap_or("");
        let kb = b.get("last_updated").and_then(|x| x.as_str()).unwrap_or("");
        kb.cmp(ka)
    });
    list.truncate(200);
    let open = list
        .iter()
        .filter(|v| v.get("status").and_then(|x| x.as_str()) != Some("resolved"))
        .count();
    json!({ "open": open, "notes": list }).to_string()
}

/// Project a stored note down to the fields the phone renders, dropping the
/// heavy base64 image blobs in anchors and capping turn bodies.
fn slim_note(v: &Value) -> Value {
    let anchors: Vec<Value> = v
        .get("anchors")
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .map(|a| {
                    json!({
                        "source_path": a.get("source_path").cloned().unwrap_or(Value::Null),
                        "source_kind": a.get("source_kind").cloned().unwrap_or(Value::Null),
                        "source_anchor": a.get("source_anchor").cloned().unwrap_or(Value::Null),
                        "source_selection": a.get("source_selection").cloned().unwrap_or(Value::Null),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let turns: Vec<Value> = v
        .get("turns")
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .map(|t| {
                    let content: String = t
                        .get("content")
                        .and_then(|c| c.as_str())
                        .unwrap_or("")
                        .chars()
                        .take(4000)
                        .collect();
                    json!({ "role": t.get("role").cloned().unwrap_or(Value::Null), "content": content })
                })
                .collect()
        })
        .unwrap_or_default();
    json!({
        "id": v.get("id").cloned().unwrap_or(Value::Null),
        "timestamp": v.get("timestamp").cloned().unwrap_or(Value::Null),
        "last_updated": v.get("last_updated").cloned().unwrap_or(Value::Null),
        "status": v.get("status").and_then(|x| x.as_str()).unwrap_or("open"),
        "user_draft": v.get("user_draft").cloned().unwrap_or(Value::Null),
        "formatted": v.get("formatted").cloned().unwrap_or(Value::Null),
        "title": v.get("title").cloned().unwrap_or(Value::Null),
        "anchors": anchors,
        "turns": turns,
    })
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Append one line (notification or read marker). Called from the frontend via
/// the notification_add command and from the read route below.
pub fn notification_append(vault: &str, line: &str) {
    let p = notifications_path(vault);
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    use std::io::Write as _;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        let _ = writeln!(f, "{}", line.trim());
    }
}

/// Read the feed: fold read markers into their notifications, newest first,
/// capped at 80.
fn notifications_json(vault: &str) -> String {
    let raw = std::fs::read_to_string(notifications_path(vault)).unwrap_or_default();
    let mut items: Vec<Value> = Vec::new();
    let mut read_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    // "hide" markers: swiped out of the Archive view. The jsonl line stays
    // (append-only, sync-friendly) — the notification just never renders again.
    let mut hidden_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    for line in raw.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        match v.get("type").and_then(|x| x.as_str()) {
            Some("read") => {
                if let Some(id) = v.get("id").and_then(|x| x.as_str()) {
                    read_ids.insert(id.to_string());
                }
            }
            Some("hide") => {
                if let Some(id) = v.get("id").and_then(|x| x.as_str()) {
                    hidden_ids.insert(id.to_string());
                }
            }
            _ => {
                if v.get("id").and_then(|x| x.as_str()).is_some() {
                    items.push(v);
                }
            }
        }
    }
    items.retain(|v| {
        v.get("id")
            .and_then(|x| x.as_str())
            .map(|id| !hidden_ids.contains(id))
            .unwrap_or(false)
    });
    // Dedupe by id (union merges can duplicate lines), newest wins.
    let mut by_id: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
    for it in items {
        let id = it.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
        by_id.insert(id, it);
    }
    let mut list: Vec<Value> = by_id
        .into_iter()
        .map(|(id, mut v)| {
            if let Some(obj) = v.as_object_mut() {
                obj.insert("read".into(), json!(read_ids.contains(&id)));
            }
            v
        })
        .collect();
    list.sort_by_key(|v| std::cmp::Reverse(v.get("ts").and_then(|x| x.as_i64()).unwrap_or(0)));
    list.truncate(80);
    let unread = list.iter().filter(|v| v.get("read").and_then(|x| x.as_bool()) != Some(true)).count();
    json!({ "unread": unread, "notifications": list }).to_string()
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
            // The worker's task — its first real user message — doubles as the
            // "goal" line on the Activity surface.
            let goal = msgs
                .iter()
                .find(|m| {
                    m.get("role").and_then(|x| x.as_str()) == Some("user")
                        && m.get("hidden").and_then(|h| h.as_bool()) != Some(true)
                        && !m.get("content").and_then(|x| x.as_str()).unwrap_or("").trim().is_empty()
                })
                .map(|m| {
                    let t = m.get("content").and_then(|x| x.as_str()).unwrap_or("");
                    let collapsed = t.split_whitespace().collect::<Vec<_>>().join(" ");
                    let cut: String = collapsed.chars().take(220).collect();
                    cut
                })
                .unwrap_or_default();
            json!({
                "id": c.get("id").and_then(|x| x.as_str()).unwrap_or(""),
                "title": c.get("title").and_then(|x| x.as_str()).unwrap_or("New chat"),
                "lastActivityAt": c.get("lastActivityAt").and_then(|x| x.as_i64()).unwrap_or(0),
                "source": c.get("source").and_then(|x| x.as_str()).unwrap_or("manual"),
                "role": c.get("role").and_then(|x| x.as_str()).unwrap_or(""),
                "mission": c.get("mission").and_then(|x| x.as_str()).unwrap_or(""),
                "msgCount": msgs.len(),
                "preview": preview,
                "goal": goal,
                // Mode A presentation summaries (produced by TS at turn
                // completion). The Activity surface prefers these clean one-
                // liners over the raw goal/preview slices above.
                "taskSummary": c.get("taskSummary").and_then(|x| x.as_str()).unwrap_or(""),
                "statusSummary": c.get("statusSummary").and_then(|x| x.as_str()).unwrap_or(""),
                // (thinkingDigest deliberately dropped — the summarized "what the
                // agent was thinking" overview is gone from the thread; the
                // per-turn thought-by-thought timeline replaced it.)
                // Per-criterion "done when" progress: which bullets are verified.
                "doneWhenDone": c.get("doneWhenDone").cloned().unwrap_or(Value::Array(Vec::new())),
                // When a mission's supervisor called CompleteMission. The phone
                // uses this to drop a finished mission off the Activity board (and
                // surface it in the drawer's Completed list). WITHOUT it the phone
                // never learns a mission is done, so it lingered on Activity — the
                // "mission never cleared" bug.
                "completedAt": c.get("completedAt").and_then(|x| x.as_i64()),
                // [harness v2] Explicit lifecycle state (RUNNING / AWAITING_USER /
                // VERIFYING / DONE / KILLED) + live-billing flag, so the Archive
                // can label a KILLED mission apart from a DONE one and the board
                // can show AWAITING_USER as "needs you" instead of healthy-idle.
                "missionState": c.get("missionState").and_then(|x| x.as_str()).unwrap_or(""),
                "billing": c.get("billing").and_then(|x| x.as_bool()).unwrap_or(false),
                // The user has opened this thread, so a mission/worker (normally
                // Activity-only) earns a spot in the recent/Chats list. Set when
                // the phone fetches /conversation for it.
                "surfaced": c.get("surfaced").and_then(|x| x.as_bool()).unwrap_or(false),
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
                // Haiku-cleaned thought-by-thought timeline for this turn (steps +
                // reply), when one was computed. The phone renders it instead of
                // the run-on content + collapsed tool chip.
                "timeline": m.get("timeline").cloned().unwrap_or(Value::Null),
            })
        })
        .collect();
    Some(
        json!({
            "id": id,
            "title": c.get("title").and_then(|x| x.as_str()).unwrap_or("New chat"),
            "source": c.get("source").and_then(|x| x.as_str()).unwrap_or("manual"),
            "status": c.get("status").and_then(|x| x.as_str()).unwrap_or("idle"),
            // When the current run began — lets the phone render an elapsed clock
            // from prompt-sent even on a cold reopen, before the next runtime
            // event arrives. (On-disk status is written idle, so "is it running"
            // still comes from /status; this is only the clock's start.)
            "runStartedAt": c.get("runStartedAt").and_then(|x| x.as_i64()),
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

