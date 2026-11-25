//! New window (src/newWindow.ts): a second vault-chat window on the same vault, box and chats, with its own tiles. It
//! is the whole app (`index.html?window=<n>`, label `win-<n>`), drawn without a native frame like the main window, and
//! hidden until its page says it is painted (`app_ready`). The frontend decides when one opens and closes (box:
//! workspace newWindow / closeWindow, one path for the title bar, the window's own close and the agent); this only
//! makes and removes the native window. The main window going takes every New window with it (lib.rs window events):
//! their tiles stay kept on the box, so the next start opens them again. The pages laid over a window
//! (web_embed.rs) are dropped with it.
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// The label of New window `n` (2 and up; capabilities/default.json grants `win-*` what the main window has).
pub fn label(n: u32) -> String {
    format!("win-{n}")
}

pub fn is_new_window(label: &str) -> bool {
    label.strip_prefix("win-").is_some_and(|n| n.parse::<u32>().is_ok_and(|n| n >= 2))
}

fn check(n: u32) -> Result<(), String> {
    if (2..=9).contains(&n) {
        Ok(())
    } else {
        Err("a New window's number is 2 to 9 (1 is the main window)".into())
    }
}

/// Opens New window `n`, or (open already) shows it, brought to the front when `focus`. True when it was made now.
#[tauri::command]
pub async fn app_window_open(app: AppHandle, n: u32, focus: bool) -> Result<bool, String> {
    check(n)?;
    let label = label(n);
    if let Some(w) = app.get_webview_window(&label) {
        if focus {
            let _ = w.show();
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
        return Ok(false);
    }
    // About the main window's size, a little smaller, so it reads as a second window wherever the OS puts it.
    let (width, height) = app
        .get_webview_window("main")
        .and_then(|m| Some((m.inner_size().ok()?, m.scale_factor().ok()?)))
        .map(|(s, f)| ((s.width as f64 / f * 0.85).max(640.0), (s.height as f64 / f * 0.9).max(480.0)))
        .unwrap_or((1200.0, 800.0));
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(format!("index.html?window={n}").into()))
        .title(format!("vault-chat (window {n})"))
        .inner_size(width, height)
        .min_inner_size(480.0, 400.0)
        .decorations(false)
        .theme(Some(tauri::Theme::Dark))
        .background_color(tauri::window::Color(0x1f, 0x1f, 0x23, 0xff))
        .disable_drag_drop_handler()
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(true)
}

/// Closes New window `n` (its pages first). False when it was not open.
#[tauri::command]
pub async fn app_window_close(app: AppHandle, n: u32) -> Result<bool, String> {
    check(n)?;
    let label = label(n);
    let app2 = app.clone();
    crate::web_embed::on_main(&app, move || {
        let Some(w) = app2.get_webview_window(&label) else { return Ok(false) };
        crate::web_embed::drop_window(&app2, &label);
        w.destroy().map_err(|e| e.to_string())?;
        Ok(true)
    })
    .await
}

/// The main window went (the app is closing): every New window goes with it, its tiles still kept on the box.
pub fn close_all(app: &AppHandle) {
    for (label, w) in app.webview_windows() {
        if is_new_window(&label) {
            crate::web_embed::drop_window(app, &label);
            let _ = w.destroy();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels() {
        assert_eq!(label(2), "win-2");
        assert!(is_new_window("win-2"));
        assert!(!is_new_window("main"));
        assert!(!is_new_window("win-1"));
        assert!(!is_new_window("win-x"));
        assert!(!is_new_window("chat-popout"));
        assert!(check(2).is_ok() && check(1).is_err() && check(10).is_err());
    }
}
