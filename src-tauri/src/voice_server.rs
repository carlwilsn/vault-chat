//! Embedded HTTP server for **phone voice mode**.
//!
//! The box runs vault-chat 24/7. This tiny server lets a phone — over the user's
//! private Tailscale mesh — drive a *live* ElevenLabs voice session whose brain
//! (vault context + tools) stays on the box. The phone is just ears and mouth.
//!
//! Design: **no fragile relay.** The desktop app periodically pushes the current
//! voice *context* (ElevenLabs key + agent id + system prompt + dynamic vars +
//! the agent's tool names + the active vault) into this server via
//! `set_context`. On a phone connect the server mints a fresh ElevenLabs signed
//! URL itself (one HTTPS call) and returns it with that context; tool calls are
//! dispatched here directly against the vault. So the server answers
//! synchronously and keeps working as long as the box is up.
//!
//! Security (user-chosen): **Tailscale + a shared token.** Every route except
//! `/health` requires the token (`X-Vault-Token` header or `?token=`). Tools are
//! **read-only**: read/glob the vault, read git history, read conversations.
//! Bash, writes, and anything else are refused — a network endpoint can't become
//! "run anything on my box."

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tiny_http::{Header, Method, Request, Response, Server};

const VOICE_PAGE: &str = include_str!("../assets/voice.html");

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
                handle(req, &token_for_thread);
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
    if !token_ok(&req, token) {
        let _ = req.respond(resp_text(401, "application/json", "{\"error\":\"unauthorized\"}".into()));
        return;
    }

    match (method, path.as_str()) {
        (Method::Get, "/voice") => {
            let _ = req.respond(resp_text(200, "text/html; charset=utf-8", VOICE_PAGE.to_string()));
        }
        (Method::Post, "/session") => {
            let body = match ctx_slot().lock().unwrap_or_else(|e| e.into_inner()).clone() {
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
                    json!({ "error": "voice host not ready — open vault-chat on the box" }).to_string(),
                ),
            };
            let _ = req.respond(body);
        }
        (Method::Post, "/tool") => {
            let mut raw = String::new();
            let _ = req.as_reader().read_to_string(&mut raw);
            let result = dispatch_tool(&raw);
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
