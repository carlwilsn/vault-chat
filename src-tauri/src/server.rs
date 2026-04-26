// Phone bridge — minimal HTTP + WebSocket server that lets a phone on
// the same Tailscale tailnet (or LAN) talk to the vault agent over
// voice. The agent itself still runs in the renderer; this server is
// just a transport. Auth is a stable random token in the URL path.

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    http::StatusCode,
    response::{Html, IntoResponse, Response},
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::{broadcast, Mutex};

const MOBILE_HTML: &str = include_str!("mobile.html");

#[derive(Clone)]
pub struct ServerState {
    pub app: AppHandle,
    pub token: String,
    // The currently-attached phone WebSocket gets a broadcast channel
    // that the renderer pushes chunks into via `phone_send_chunk`. One
    // active channel at a time — a reconnect overwrites the previous.
    pub outbound: Arc<Mutex<Option<broadcast::Sender<String>>>>,
}

#[derive(Deserialize)]
struct PhoneIncoming {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    id: String,
    #[serde(default)]
    text: String,
    #[serde(default)]
    model: String,
}

pub async fn serve(state: ServerState, port: u16) {
    let app = Router::new()
        .route("/", get(root_handler))
        .route("/mobile/:token", get(mobile_handler))
        .route("/ws/:token", get(ws_handler))
        .with_state(state);

    let addr = format!("0.0.0.0:{port}");
    match tokio::net::TcpListener::bind(&addr).await {
        Ok(listener) => {
            eprintln!("[phone] server listening on http://{}", addr);
            if let Err(e) = axum::serve(listener, app).await {
                eprintln!("[phone] server exited: {e}");
            }
        }
        Err(e) => {
            eprintln!("[phone] failed to bind {addr}: {e}");
        }
    }
}

async fn root_handler() -> &'static str {
    "vault-chat phone bridge — open /mobile/<token> on your phone."
}

async fn mobile_handler(
    State(s): State<ServerState>,
    Path(token): Path<String>,
) -> Response {
    if token != s.token {
        return (StatusCode::UNAUTHORIZED, "bad token").into_response();
    }
    let html = MOBILE_HTML.replace("__TOKEN__", &s.token);
    Html(html).into_response()
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(s): State<ServerState>,
    Path(token): Path<String>,
) -> Response {
    if token != s.token {
        return (StatusCode::UNAUTHORIZED, "bad token").into_response();
    }
    ws.on_upgrade(move |socket| handle_socket(socket, s))
}

async fn handle_socket(socket: WebSocket, state: ServerState) {
    let (mut sender, mut receiver) = socket.split();

    // Install a fresh broadcast channel so the renderer can push chunks
    // to this connection. Replacing any prior channel drops its only
    // receiver and ends the prior pump task.
    let (tx, mut rx) = broadcast::channel::<String>(128);
    {
        let mut guard = state.outbound.lock().await;
        *guard = Some(tx);
    }

    let pump = tokio::spawn(async move {
        while let Ok(msg) = rx.recv().await {
            if sender.send(Message::Text(msg)).await.is_err() {
                break;
            }
        }
    });

    while let Some(Ok(msg)) = receiver.next().await {
        match msg {
            Message::Text(text) => {
                if let Ok(req) = serde_json::from_str::<PhoneIncoming>(&text) {
                    match req.kind.as_str() {
                        "chat" => {
                            let payload = serde_json::json!({
                                "id": req.id,
                                "text": req.text,
                                "model": if req.model.is_empty() {
                                    "claude-haiku-4-5-20251001".to_string()
                                } else {
                                    req.model
                                },
                            });
                            let _ = state.app.emit("phone:request", payload);
                        }
                        "abort" => {
                            let _ = state
                                .app
                                .emit("phone:abort", serde_json::json!({ "id": req.id }));
                        }
                        "reset" => {
                            let _ = state.app.emit("phone:reset", serde_json::json!({}));
                        }
                        _ => {}
                    }
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    pump.abort();
    let mut guard = state.outbound.lock().await;
    *guard = None;
}

pub async fn push_chunk(state: &ServerState, chunk: String) {
    let guard = state.outbound.lock().await;
    if let Some(tx) = guard.as_ref() {
        let _ = tx.send(chunk);
    }
}
