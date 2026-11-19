//! Safety that does not depend on the part being changed (src/changeFlow.ts, the Try redesign): the shell, not the
//! page, holds the last word on a change.
//!
//! - Undo of the last applied change: a fixed global shortcut (Ctrl+Alt+Z; Cmd+Alt+Z on a Mac) and the tray menu's
//!   "Undo last change". It asks the box (POST /api/v2/changes/undo-last): what the page tries is discarded, else the
//!   newest applied change switches back; a core change also has the core loader run the core before it. Then every
//!   window reloads. It works whatever a change did to the page.
//! - A dead-man's switch: the page tells the shell every few seconds whether it is healthy (`safety_beat`: the chat
//!   pane renders and answers a ping, src/changeSafety.ts) and until when a change is watched (tried, or applied less
//!   than ten minutes ago). While one is watched and the window is on screen, no healthy word for SILENCE undoes it
//!   the same way (by "auto": the box writes the line in the chat that says so).
//!
//! The box's address and the token come with each beat from the page (the shell keeps them in memory only).

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

/// No healthy word from the page for this long while a change is watched: undo it (src/changeFlow.ts NATIVE_SILENCE_MS).
pub const SILENCE: Duration = Duration::from_secs(30);
/// How often the watchdog looks.
const TICK: Duration = Duration::from_secs(2);

/// A change the page tries (its plugin and version).
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
pub struct Tried {
    pub plugin: String,
    pub version: String,
}

struct State {
    url: Option<String>,
    token: Option<String>,
    vault: Option<String>,
    /// Until when (ms since the epoch) a change is watched; 0: none.
    watch_until_ms: u64,
    last_healthy: Option<Instant>,
    tried: Vec<Tried>,
    /// The switch fired for this watch already (a new watch arms it again).
    fired: bool,
}

static STATE: Mutex<State> = Mutex::new(State { url: None, token: None, vault: None, watch_until_ms: 0, last_healthy: None, tried: Vec::new(), fired: false });

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Whether the dead-man's switch fires now. Pure, for tests.
pub fn should_fire(watch_until_ms: u64, now_ms: u64, since_healthy: Option<Duration>, visible: bool, fired: bool) -> bool {
    if fired || watch_until_ms == 0 || now_ms > watch_until_ms || !visible {
        return false;
    }
    matches!(since_healthy, Some(d) if d >= SILENCE)
}

/// The page's word (src/changeSafety.ts), every few seconds.
#[tauri::command]
pub fn safety_beat(url: Option<String>, token: Option<String>, vault: Option<String>, watch_until: u64, healthy: bool, tried: Vec<Tried>) {
    let mut s = STATE.lock().unwrap_or_else(|p| p.into_inner());
    if url.as_deref().map_or(false, |u| u.starts_with("http")) {
        s.url = url;
        s.token = token;
        s.vault = vault;
    }
    if watch_until == 0 {
        s.fired = false;
    } else if s.watch_until_ms == 0 {
        // A new watch: armed again, counted from now.
        s.fired = false;
        s.last_healthy = Some(Instant::now());
    }
    s.watch_until_ms = watch_until;
    s.tried = tried;
    if healthy {
        s.last_healthy = Some(Instant::now());
    }
}

fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

/// Undo the last change through the box, then have the windows run what is in effect. `by`: "carl" or "auto".
pub fn undo(app: &AppHandle, by: &'static str, reason: &'static str) {
    let (url, token, vault, tried) = {
        let mut s = STATE.lock().unwrap_or_else(|p| p.into_inner());
        s.fired = true;
        (s.url.clone(), s.token.clone(), s.vault.clone(), s.tried.clone())
    };
    let app = app.clone();
    std::thread::spawn(move || {
        let mut core = tried.iter().any(|t| t.plugin == "app/core");
        match url {
            Some(url) => {
                let q = vault.map(|v| format!("?vault={}", enc(&v))).unwrap_or_default();
                let body = serde_json::json!({ "by": by, "reason": reason, "tried": tried }).to_string();
                match crate::box_sync::post_json(&format!("{}/api/v2/changes/undo-last{}", url.trim_end_matches('/'), q), &body, token.as_deref()) {
                    Ok((status, text)) => {
                        eprintln!("[safety] undo ({by}): {status} {}", text.chars().take(300).collect::<String>());
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                            core = core || v.get("core").and_then(|c| c.as_bool()).unwrap_or(false);
                        }
                    }
                    Err(e) => eprintln!("[safety] undo ({by}): the box did not answer: {e}"),
                }
            }
            None => eprintln!("[safety] undo ({by}): no box known yet"),
        }
        if core {
            crate::core_loader::revert_core(&app);
        } else {
            for w in app.webview_windows().values() {
                let _ = w.reload();
            }
        }
    });
}

/// The fixed global shortcut (the registry's "change.undo", src/shortcuts.ts): Ctrl+Alt+Z, Cmd+Alt+Z on a Mac. Never
/// fatal: another program holding the keys leaves the tray's item.
pub fn register_shortcut(app: &AppHandle) {
    use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
    let mods = if cfg!(target_os = "macos") { Modifiers::SUPER | Modifiers::ALT } else { Modifiers::CONTROL | Modifiers::ALT };
    let key = Shortcut::new(Some(mods), Code::KeyZ);
    let mine = key.clone();
    let plugin = tauri_plugin_global_shortcut::Builder::<tauri::Wry>::new()
        .with_handler(move |app, shortcut, event| {
            if *shortcut == mine && matches!(event.state(), ShortcutState::Pressed) {
                undo(app, "carl", "Undo (Ctrl+Alt+Z)");
            }
        })
        .build();
    if let Err(e) = app.plugin(plugin) {
        eprintln!("[safety] no global shortcut plugin: {e}");
        return;
    }
    if let Err(e) = app.global_shortcut().register(key) {
        eprintln!("[safety] Ctrl+Alt+Z is not free: {e} (the tray's Undo last change still works)");
    }
}

fn main_visible(app: &AppHandle) -> bool {
    match app.get_webview_window("main") {
        Some(w) => w.is_visible().unwrap_or(true) && !w.is_minimized().unwrap_or(false),
        None => false,
    }
}

/// Start the watchdog (the app's setup, once).
pub fn start(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(TICK);
        let visible = main_visible(&app);
        let fire = {
            let mut s = STATE.lock().unwrap_or_else(|p| p.into_inner());
            if !visible {
                // A hidden window's page is throttled: its silence says nothing; counted again from when it shows.
                s.last_healthy = s.last_healthy.map(|_| Instant::now());
            }
            should_fire(s.watch_until_ms, now_ms(), s.last_healthy.map(|t| t.elapsed()), visible, s.fired)
        };
        if fire {
            eprintln!("[safety] no healthy word from the app for {} s while a change is watched: undoing it", SILENCE.as_secs());
            undo(&app, "auto", "the app stopped responding");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fires_only_while_watched_visible_and_silent() {
        let now = 1_000_000;
        let quiet = Some(SILENCE + Duration::from_secs(1));
        assert!(should_fire(now + 60_000, now, quiet, true, false));
        assert!(!should_fire(0, now, quiet, true, false), "nothing watched");
        assert!(!should_fire(now - 1, now, quiet, true, false), "the watch is over");
        assert!(!should_fire(now + 60_000, now, Some(Duration::from_secs(5)), true, false), "healthy lately");
        assert!(!should_fire(now + 60_000, now, None, true, false), "never armed");
        assert!(!should_fire(now + 60_000, now, quiet, false, false), "hidden: throttled, not dead");
        assert!(!should_fire(now + 60_000, now, quiet, true, true), "fired once already");
    }

    #[test]
    fn encodes_the_vault_name() {
        assert_eq!(enc("school2"), "school2");
        assert_eq!(enc("my vault"), "my%20vault");
    }
}
