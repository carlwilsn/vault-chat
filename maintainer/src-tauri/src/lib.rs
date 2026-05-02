use serde::Serialize;
use tauri::Manager;

// Must match the main app's KEYCHAIN_SERVICE constant exactly so we
// read from the same OS keychain entry the main app writes to. If you
// rename either side, rename both.
const KEYCHAIN_SERVICE: &str = "com.vault-chat.app";

// Read a secret from the OS keychain. We deliberately use the same
// service name as the main app so the GitHub PAT entered there is
// transparently visible here — single source of truth, no copying.
#[tauri::command]
fn keychain_get(key: String) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &key).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

// Show the calling window. Paired with `visible: false` in
// tauri.conf.json so the OS only sees the window after React has
// painted its first frame.
#[tauri::command]
fn app_ready(window: tauri::WebviewWindow) -> Result<(), String> {
    window.show().map_err(|e| e.to_string())?;
    let _ = window.set_focus();
    Ok(())
}

#[derive(Serialize)]
struct DownloadResult {
    path: String,
}

// Download a release installer to the OS temp dir, then run it via
// the platform's launcher. On Windows, double-clicking an .exe / .msi
// kicks off the install flow with the existing in-place install
// preserved (assuming the installer is properly built, which Tauri's
// NSIS / WiX outputs are).
#[tauri::command]
async fn download_and_install(url: String, filename: String) -> Result<DownloadResult, String> {
    // Sanity check on filename — must be a bare basename (no path
    // separators) to avoid writing outside the temp dir if the GitHub
    // payload was ever tampered with.
    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return Err("invalid filename".to_string());
    }
    let dir = std::env::temp_dir().join("vault-chat-maintainer-installs");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("create temp dir: {}", e))?;
    let target = dir.join(&filename);

    let resp = reqwest::Client::new()
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("GET: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("download HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("body: {}", e))?;
    tokio::fs::write(&target, &bytes)
        .await
        .map_err(|e| format!("write: {}", e))?;

    // Launch the installer. opener::open_path handles the platform
    // specifics (ShellExecute on Windows, `open` on macOS, xdg-open
    // on Linux).
    open::that(&target).map_err(|e| format!("launch: {}", e))?;

    Ok(DownloadResult {
        path: target.to_string_lossy().to_string(),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // Window is created hidden via tauri.conf.json. JS calls
            // `app_ready` once React has committed; we belt-and-
            // suspenders hide here in case anyone forgets to flip the
            // conf flag.
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.hide();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            keychain_get,
            app_ready,
            download_and_install
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
