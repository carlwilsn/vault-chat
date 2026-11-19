//! The first-run tutorial, seeded into a brand-new vault on the app's first run only.
//!
//! What is seeded (bundled in the app from assets/first-run/): the tutorial itself, a vault plugin like any other
//! (`.vault-chat/plugins/tutorial.js`, mount(el, api); src/vaultPlugins.ts), `Welcome.md`, and the sample paper
//! `Welcome/sample-paper.pdf` (scripts/make-sample-paper.mjs). Deleting the tutorial is deleting its file (the agent does
//! it when asked); Welcome/ stays.
//!
//! When: the window calls `first_run_seed` each time it opens a vault (src/openVault.ts), before anything else writes
//! there. The first call on this account writes the marker `<app dir>/first-run.json` and seeds only if that vault has
//! no visible entry (hidden ones like .git or .vault-chat do not count). Every later call does nothing. So an account
//! that already had a vault (any existing install, which opens its vault at start) never gets the tutorial, and a
//! vault with anything in it never does. A self-test launch seeds only when its steps file says `"firstRun": true`.
use std::path::Path;

const TUTORIAL_JS: &str = include_str!("../../assets/first-run/tutorial.js");
const WELCOME_MD: &str = include_str!("../../assets/first-run/Welcome.md");
const SAMPLE_PDF: &[u8] = include_bytes!("../../assets/first-run/sample-paper.pdf");

pub const MARKER: &str = "first-run.json";

#[derive(serde::Serialize, Debug, PartialEq)]
pub struct Seeded {
    pub seeded: bool,
    pub why: String,
}

fn no(why: &str) -> Seeded {
    Seeded { seeded: false, why: why.into() }
}

/// Whether the folder has anything visible in it (a missing folder has not).
fn has_visible_entries(vault: &Path) -> bool {
    match std::fs::read_dir(vault) {
        Ok(rd) => rd.flatten().any(|e| !e.file_name().to_string_lossy().starts_with('.')),
        Err(_) => false,
    }
}

/// The files the tutorial brings: (vault-relative path, bytes).
pub fn files() -> [(&'static str, &'static [u8]); 3] {
    [
        (".vault-chat/plugins/tutorial.js", TUTORIAL_JS.as_bytes()),
        ("Welcome.md", WELCOME_MD.as_bytes()),
        ("Welcome/sample-paper.pdf", SAMPLE_PDF),
    ]
}

/// The decision and the writing, apart from the app (tests call it with their own folders).
pub fn seed(app_dir: &Path, vault: &Path, now_ms: u128) -> Result<Seeded, String> {
    let marker = app_dir.join(MARKER);
    if marker.exists() {
        return Ok(no("not the first run"));
    }
    // A folder on this disk with nothing visible in it (a box path or anything else is never fresh).
    let fresh = vault.is_dir() && !has_visible_entries(vault);
    std::fs::create_dir_all(app_dir).map_err(|e| format!("could not make {}: {e}", app_dir.display()))?;
    let body = serde_json::json!({ "at": now_ms as u64, "vault": vault.to_string_lossy(), "tutorial": fresh });
    std::fs::write(&marker, serde_json::to_vec_pretty(&body).unwrap_or_default()).map_err(|e| format!("could not write {}: {e}", marker.display()))?;
    if !fresh {
        return Ok(no(if vault.is_dir() { "the vault already has files" } else { "not a folder on this disk" }));
    }
    for (rel, bytes) in files() {
        let p = vault.join(rel);
        if p.exists() {
            continue;
        }
        if let Some(dir) = p.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("could not make {}: {e}", dir.display()))?;
        }
        std::fs::write(&p, bytes).map_err(|e| format!("could not write {}: {e}", p.display()))?;
    }
    println!("[first-run] seeded the tutorial into {}", vault.display());
    Ok(Seeded { seeded: true, why: "a new vault on the first run".into() })
}

#[tauri::command]
pub fn first_run_seed(window: tauri::WebviewWindow, vault: String) -> Result<Seeded, String> {
    if window.label() != "main" {
        return Ok(no("only the main window"));
    }
    if crate::self_test::plan().is_some() && !crate::self_test::wants_first_run() {
        return Ok(no("a self-test launch"));
    }
    let vault = vault.trim();
    if vault.is_empty() {
        return Ok(no("no vault"));
    }
    let Some(dir) = crate::fallback_secret_dir() else { return Ok(no("no app folder on this machine")) };
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    seed(&dir, Path::new(vault), now)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("vc-tutorial-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_new_vault_on_the_first_run_gets_the_tutorial_once() {
        let root = scratch("new");
        let app = root.join("app");
        let vault = root.join("vault-chat");
        std::fs::create_dir_all(vault.join(".git")).unwrap();
        let r = seed(&app, &vault, 1).unwrap();
        assert!(r.seeded, "{r:?}");
        for (rel, bytes) in files() {
            assert_eq!(std::fs::read(vault.join(rel)).unwrap(), bytes, "{rel}");
        }
        // The next vault, even an empty one, does not.
        let other = root.join("other");
        std::fs::create_dir_all(&other).unwrap();
        assert_eq!(seed(&app, &other, 2).unwrap(), no("not the first run"));
        assert!(!other.join("Welcome.md").exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn an_existing_vault_never_gets_it_and_ends_the_first_run() {
        let root = scratch("existing");
        let app = root.join("app");
        let vault = root.join("school");
        std::fs::create_dir_all(&vault).unwrap();
        std::fs::write(vault.join("notes.md"), "mine").unwrap();
        assert_eq!(seed(&app, &vault, 1).unwrap(), no("the vault already has files"));
        assert!(!vault.join(".vault-chat/plugins/tutorial.js").exists() && !vault.join("Welcome.md").exists());
        let empty = root.join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        assert_eq!(seed(&app, &empty, 2).unwrap(), no("not the first run"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_path_that_is_not_a_folder_here_is_never_seeded() {
        let root = scratch("nofolder");
        let app = root.join("app");
        let missing = root.join("box-vault");
        assert_eq!(seed(&app, &missing, 1).unwrap(), no("not a folder on this disk"));
        assert!(!missing.exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn the_bundled_files_are_what_the_tutorial_needs() {
        assert!(TUTORIAL_JS.contains("export function mount(el, api)") && TUTORIAL_JS.contains("export const meta"));
        assert!(SAMPLE_PDF.starts_with(b"%PDF-") && SAMPLE_PDF.len() > 5_000);
        assert!(WELCOME_MD.contains("Welcome/sample-paper.pdf"));
    }
}
