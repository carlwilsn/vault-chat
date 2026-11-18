//! What a new user's own Claude (an agent in a terminal that installed the app)
//! needs from the app: a status it can read, and a way to pre-pick the vault.
//!
//! Status: the main window reports (src/appStatus.ts) whether Claude is signed
//! in, which vault is open, whether the server answers and where git stands;
//! this writes it with the app's version to `<app dir>/status.json`
//! (macOS: ~/Library/Application Support/vault-chat/status.json). The agent reads
//! that file, or runs `vault-chat --status` (the app binary; on a Mac
//! /Applications/vault-chat.app/Contents/MacOS/vault-chat --status), which prints
//! it with `running` added and exits without starting the app. Only the fields
//! named below are kept and every string is redacted: no token, no key, no box
//! token ever goes in.
//!
//! Setup handoff: before the first launch the agent writes
//! `<app dir>/setup.json` = {"vault": "~/vault-chat"} (or launches with
//! VC_SETUP_VAULT=<path>). The first main window with no vault open opens that
//! folder (made if missing); the file is renamed setup.used.json, so it is read
//! once. No vault named → ~/vault-chat. A folder macOS guards with a permission
//! prompt (~/Documents, ~/Desktop, ~/Downloads) is never used: ~/vault-chat is.
use std::path::{Path, PathBuf};

pub const SETUP_VAR: &str = "VC_SETUP_VAULT";

/// The app's own folder for machine-local files (the same one the secret
/// fallback uses; none of them is in a vault).
fn app_dir() -> Option<PathBuf> {
    crate::fallback_secret_dir()
}

pub fn status_path() -> Option<PathBuf> {
    app_dir().map(|d| d.join("status.json"))
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).filter(|h| !h.is_empty()).map(PathBuf::from)
}

// ----- status -----

/// What the window may report. Anything else it sends is dropped.
#[derive(serde::Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Reported {
    pub signed_in: bool,
    pub vault: Option<String>,
    pub server_healthy: bool,
    pub server_url: Option<String>,
    pub git: Option<String>,
    pub git_help: Option<String>,
    pub sign_in_error: Option<String>,
}

fn clean(s: &Option<String>) -> Option<String> {
    s.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(|s| {
        let mut r = crate::claude_signin::redact(s);
        r.truncate(400);
        r
    })
}

/// A URL without anything that could carry a credential (userinfo, query, fragment).
fn bare_url(s: &Option<String>) -> Option<String> {
    let s = clean(s)?;
    let s = s.split(['?', '#']).next().unwrap_or_default().to_string();
    match s.split_once("://") {
        Some((scheme, rest)) => Some(format!("{scheme}://{}", rest.rsplit_once('@').map(|(_, h)| h).unwrap_or(rest))),
        None => Some(s),
    }
}

/// The status file's body.
pub fn status_json(r: &Reported, version: &str, pid: u32, now_ms: u128) -> serde_json::Value {
    let vault = clean(&r.vault);
    let git = clean(&r.git);
    serde_json::json!({
        "schema": 1,
        "app": "vault-chat",
        "version": version,
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "pid": pid,
        "updatedAt": now_ms as u64,
        "signedIn": r.signed_in,
        "vaultOpen": vault.is_some(),
        "vault": vault,
        "server": { "healthy": r.server_healthy, "url": bare_url(&r.server_url) },
        "git": git,
        "needsCommandLineTools": git.as_deref() == Some("needs-command-line-tools"),
        "gitHelp": clean(&r.git_help),
        "signInError": clean(&r.sign_in_error),
    })
}

fn now_ms() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

#[tauri::command]
pub fn app_status_write(app: tauri::AppHandle, window: tauri::WebviewWindow, status: Reported) -> Result<(), String> {
    if window.label() != "main" {
        return Err("only the main window reports the status".into());
    }
    let path = status_path().ok_or("no app folder on this machine")?;
    let body = status_json(&status, &app.package_info().version.to_string(), std::process::id(), now_ms());
    crate::self_test::write_result(&path, &body)
}

/// The status file as written, for the self-test's checks.
#[tauri::command]
pub fn app_status_read() -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(status_path()?).ok()?;
    serde_json::from_str(&text).ok()
}

fn pid_alive(pid: u64) -> bool {
    #[cfg(unix)]
    {
        // SAFETY: signal 0 only checks that the process exists.
        pid > 0 && pid <= i32::MAX as u64 && unsafe { libc::kill(pid as i32, 0) } == 0
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

/// `vault-chat --status`: print the status (with `running`) and return the exit code.
pub fn print_status() -> i32 {
    let path = status_path();
    let read = path.as_ref().and_then(|p| std::fs::read_to_string(p).ok()).and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok());
    let (code, body) = match read {
        Some(mut v) => {
            let running = v.get("pid").and_then(|p| p.as_u64()).map(pid_alive).unwrap_or(false);
            v["running"] = serde_json::json!(running);
            v["statusFile"] = serde_json::json!(path.as_ref().map(|p| p.to_string_lossy().to_string()));
            (0, v)
        }
        None => (
            1,
            serde_json::json!({
                "schema": 1, "running": false,
                "statusFile": path.as_ref().map(|p| p.to_string_lossy().to_string()),
                "error": "no status yet: vault-chat has not been opened on this account",
            }),
        ),
    };
    println!("{}", serde_json::to_string_pretty(&body).unwrap_or_default());
    code
}

// ----- setup handoff -----

/// The folder a setup asked for, settled: `~` expanded, relative paths under
/// home, empty → ~/vault-chat, and never a folder macOS guards with a prompt.
pub fn settle_vault(asked: Option<&str>, home: &Path) -> PathBuf {
    let default = home.join("vault-chat");
    let asked = asked.map(str::trim).filter(|s| !s.is_empty());
    let Some(asked) = asked else { return default };
    let p = if asked == "~" {
        home.to_path_buf()
    } else if let Some(rest) = asked.strip_prefix("~/") {
        home.join(rest)
    } else if Path::new(asked).is_absolute() {
        PathBuf::from(asked)
    } else {
        home.join(asked)
    };
    if p == home {
        return default;
    }
    for guarded in ["Documents", "Desktop", "Downloads", "Library"] {
        let g = home.join(guarded);
        let lower = |q: &Path| q.to_string_lossy().to_lowercase();
        // Case-insensitive: APFS usually is.
        if lower(&p) == lower(&g) || lower(&p).starts_with(&format!("{}/", lower(&g))) {
            return default;
        }
    }
    p
}

/// What setup.json (or the variable) asks, read once: Some(asked vault, maybe
/// None for the default) when there is a setup at all.
fn take_setup(dir: Option<&Path>, env: Option<String>) -> Option<Option<String>> {
    if let Some(v) = env.filter(|v| !v.trim().is_empty()) {
        return Some(Some(v));
    }
    let file = dir?.join("setup.json");
    let text = std::fs::read_to_string(&file).ok()?;
    let _ = std::fs::rename(&file, file.with_file_name("setup.used.json"));
    let v: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
    Some(v.get("vault").and_then(|x| x.as_str()).map(String::from))
}

/// At the main window's start: the vault an installer picked, made and ready to
/// open, or None (no setup, a vault already open, or a self-test launch).
#[tauri::command]
pub fn setup_take(window: tauri::WebviewWindow, vault_open: bool) -> Result<Option<String>, String> {
    if window.label() != "main" || crate::self_test::plan().is_some() {
        return Ok(None);
    }
    let Some(asked) = take_setup(app_dir().as_deref(), std::env::var(SETUP_VAR).ok()) else { return Ok(None) };
    if vault_open {
        return Ok(None);
    }
    let home = home().ok_or("no home folder")?;
    let vault = settle_vault(asked.as_deref(), &home);
    std::fs::create_dir_all(&vault).map_err(|e| format!("could not make {}: {e}", vault.display()))?;
    println!("[setup] opening the vault {}", vault.display());
    Ok(Some(vault.to_string_lossy().replace('\\', "/")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_status_keeps_only_its_fields_and_no_secret() {
        let r = Reported {
            signed_in: true,
            vault: Some("/Users/f/vault-chat".into()),
            server_healthy: true,
            server_url: Some("http://user:pw@127.0.0.1:8848/api?token=abc#x".into()),
            git: Some("needs-command-line-tools".into()),
            git_help: Some("run xcode-select --install".into()),
            sign_in_error: Some("bad sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".into()),
        };
        let v = status_json(&r, "0.9.30", 42, 1000);
        assert_eq!(v["signedIn"], true);
        assert_eq!(v["vaultOpen"], true);
        assert_eq!(v["vault"], "/Users/f/vault-chat");
        assert_eq!(v["server"]["url"], "http://127.0.0.1:8848/api");
        assert_eq!(v["needsCommandLineTools"], true);
        assert_eq!(v["version"], "0.9.30");
        let text = v.to_string();
        assert!(!text.contains("sk-ant") && !text.contains("token=") && !text.contains("pw@"), "{text}");
        let empty = status_json(&Reported::default(), "1", 1, 1);
        assert_eq!(empty["vaultOpen"], false);
        assert_eq!(empty["vault"], serde_json::Value::Null);
    }

    #[test]
    fn unknown_fields_from_the_window_are_dropped() {
        let r: Reported = serde_json::from_value(serde_json::json!({ "signedIn": true, "token": "sk-ant-oat01-x" })).unwrap();
        assert!(!status_json(&r, "1", 1, 1).to_string().contains("sk-ant"));
    }

    #[test]
    fn the_vault_is_settled_and_never_a_guarded_folder() {
        let h = Path::new("/Users/f");
        assert_eq!(settle_vault(None, h), h.join("vault-chat"));
        assert_eq!(settle_vault(Some("  "), h), h.join("vault-chat"));
        assert_eq!(settle_vault(Some("~/notes"), h), h.join("notes"));
        assert_eq!(settle_vault(Some("notes"), h), h.join("notes"));
        assert_eq!(settle_vault(Some("/Volumes/x/v"), h), PathBuf::from("/Volumes/x/v"));
        assert_eq!(settle_vault(Some("~"), h), h.join("vault-chat"));
        assert_eq!(settle_vault(Some("~/Documents/vault"), h), h.join("vault-chat"));
        assert_eq!(settle_vault(Some("/Users/f/documents"), h), h.join("vault-chat"));
        assert_eq!(settle_vault(Some("~/Desktop"), h), h.join("vault-chat"));
        assert_eq!(settle_vault(Some("~/Documentsx"), h), h.join("Documentsx"));
    }

    #[test]
    fn setup_is_read_once() {
        let dir = std::env::temp_dir().join(format!("vc-setup-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(take_setup(Some(&dir), None), None);
        std::fs::write(dir.join("setup.json"), r#"{"vault":"~/v"}"#).unwrap();
        assert_eq!(take_setup(Some(&dir), None), Some(Some("~/v".into())));
        assert!(!dir.join("setup.json").exists() && dir.join("setup.used.json").exists());
        assert_eq!(take_setup(Some(&dir), None), None);
        std::fs::write(dir.join("setup.json"), "{}").unwrap();
        assert_eq!(take_setup(Some(&dir), None), Some(None));
        // The variable wins and touches no file.
        assert_eq!(take_setup(Some(&dir), Some("/x".into())), Some(Some("/x".into())));
        std::fs::remove_dir_all(&dir).ok();
    }
}
