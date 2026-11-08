// Finding the `claude` this machine would run, for Settings → Models.
//
// Signing in is Carl's own `claude setup-token` in a real terminal, and the
// token he pastes goes into this machine's keychain (src/ClaudeCodeSignIn.tsx)
// and then to the box like every other key. The app drove that command itself
// once, through a pty, and it broke four different ways on his Windows laptop
// before he said to stop; that driver is gone and this is what is left of it —
// which `claude` is here, and what version it is.
//
// The token's keychain entry is src/keychain.ts KEY.claudeCode; nothing in Rust
// names it any more, now that nothing here captures a token.

fn home_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .or_else(|| std::env::var_os("USERPROFILE").filter(|h| !h.is_empty()))
        .map(std::path::PathBuf::from)
}

fn candidates() -> Vec<String> {
    let home = home_dir();
    let state = std::env::var("VC_STATE_DIR")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(std::path::PathBuf::from)
        .or_else(|| {
            home.as_ref().map(|h| h.join(".local").join("state").join("vault-chat-server"))
        });
    candidates_in(std::env::var("VC_CLAUDE_BIN").ok().as_deref(), state.as_deref(), home.as_deref())
}

/// The order itself, given the two things it depends on, so a test can lay out
/// a state dir and check what wins without touching the process environment.
fn candidates_in(want: Option<&str>, state: Option<&std::path::Path>, home: Option<&std::path::Path>) -> Vec<String> {
    let exe = if cfg!(windows) { "claude.exe" } else { "claude" };
    let mut out = Vec::new();
    if let Some(want) = want.map(str::trim).filter(|s| !s.is_empty()) {
        out.push(want.to_string());
    }
    if let Some(state) = state {
        // The loader wrapper first: where one exists the raw binary is the one
        // that could not run on its own (NixOS).
        for rel in [["claude", "bin"], ["claude", "cli"]] {
            let p = state.join(rel[0]).join(rel[1]).join(exe);
            if p.exists() {
                out.push(p.to_string_lossy().to_string());
            }
        }
    }
    if let Some(home) = home {
        // Where Claude Code's own installer puts it. On Carl's Windows laptop
        // this is the one that exists, and nothing was looking for it.
        let p = home.join(".local").join("bin").join(exe);
        if p.exists() {
            out.push(p.to_string_lossy().to_string());
        }
    }
    out.push(exe.to_string());
    out
}

/// `<cli> --version` → the version it reported, or None (it did not run).
///
/// The app's own environment, deliberately: this answers "is there a claude on
/// this machine at all", which is all Settings shows. Being wrong either way
/// costs nothing — Carl runs the command himself in his own terminal.
fn probe(cli: &str) -> Option<String> {
    let mut cmd = std::process::Command::new(cli);
    cmd.arg("--version").stdin(std::process::Stdio::null());
    // A GUI app starting a console program gets a terminal window flashed up
    // for it — the "terminal popup" Carl saw when he pressed the button.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let re = regex::Regex::new(r"\d+\.\d+\.\d+").expect("static regex");
    re.find(&text).map(|m| m.as_str().to_string())
}

#[derive(serde::Serialize)]
pub struct ClaudeCli {
    /// Shown so the user can see which `claude` Settings found.
    pub version: String,
}

/// Which `claude` this machine would run, and its version — or None if there is
/// none it can run. Settings shows it beside the sign-in command, so Carl can
/// tell whether the command he is being asked to run exists.
#[tauri::command]
pub async fn claude_setup_token_cli() -> Option<ClaudeCli> {
    tauri::async_runtime::spawn_blocking(|| {
        candidates().iter().find_map(|cli| probe(cli).map(|version| ClaudeCli { version }))
    })
    .await
    .ok()
    .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_override_wins_then_the_pinned_binary_then_whatever_is_on_path() {
        let dir = std::env::temp_dir().join(format!("vc-cand-{}", std::process::id()));
        // The name the platform's own installer uses, which is what discovery
        // looks for: claude.exe on Windows.
        let exe = if cfg!(windows) { "claude.exe" } else { "claude" };
        let cli = dir.join("claude").join("cli").join(exe);
        let wrapper = dir.join("claude").join("bin").join(exe);
        std::fs::create_dir_all(cli.parent().unwrap()).unwrap();
        std::fs::write(&cli, b"").unwrap();

        // Nothing laid out but the raw binary: it comes before bare `claude`.
        assert_eq!(
            candidates_in(None, Some(&dir), None),
            vec![cli.to_string_lossy().to_string(), exe.to_string()],
        );

        // A loader wrapper exists, so the raw binary is the one that could not
        // run alone — the wrapper has to be tried first.
        std::fs::create_dir_all(wrapper.parent().unwrap()).unwrap();
        std::fs::write(&wrapper, b"").unwrap();
        assert_eq!(
            candidates_in(None, Some(&dir), None),
            vec![
                wrapper.to_string_lossy().to_string(),
                cli.to_string_lossy().to_string(),
                exe.to_string(),
            ],
        );

        // VC_CLAUDE_BIN beats everything, and is trimmed; a blank one is not a
        // candidate at all.
        assert_eq!(candidates_in(Some("  /opt/claude  "), Some(&dir), None)[0], "/opt/claude");
        assert_eq!(candidates_in(Some("   "), None, None), vec![exe.to_string()]);
        // No state dir to look in still leaves the last resort.
        assert_eq!(candidates_in(None, None, None), vec![exe.to_string()]);

        // Where Claude Code's own installer puts it, which on Carl's Windows
        // laptop is the only copy there is.
        let home = dir.join("home");
        let installed = home.join(".local").join("bin").join(exe);
        std::fs::create_dir_all(installed.parent().unwrap()).unwrap();
        std::fs::write(&installed, b"").unwrap();
        let with_home = candidates_in(None, None, Some(&home));
        assert_eq!(with_home, vec![installed.to_string_lossy().to_string(), exe.to_string()]);

        std::fs::remove_dir_all(&dir).ok();
    }
}
