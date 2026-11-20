//! Claude Code, fetched by the app itself.
//!
//! Carl's setup is: install vault-chat, sign in, pick a vault. So the laptop
//! must not need Claude Code installed first — and on his Windows machine the
//! one that was there came from a separate install he had to find out about.
//!
//! When nothing is found, the app fetches the pinned CLI for this platform: the
//! same build the box runs, from the npm package the SDK itself pins, checked
//! against the integrity hash the registry publishes for that exact version. It
//! is ~350 MB unpacked, which is why it is fetched once into the app's own
//! state dir rather than carried inside every installer.
//!
//! Where it lands is where everything already looks: `<state>/claude/bin/claude`
//! is the first place the sign-in driver tries (claude_login::candidates_in) and
//! the server is handed the same path (VC_CLAUDE_BIN), so one copy serves both.
//!
//! How it is found, fetched and checked is not the shell's: it lives in the server bundle the app carries
//! (server/engine/claude/cliFetch.ts), so it changes with the server (and its slot, local_server.rs), never an
//! installer. The shell only runs `node <server bundle> fetch-claude-cli <state dir>` and relays its lines; a slot's
//! bundle that does not answer is passed over for the installer's own. What stays here is the startup adoption of a
//! CLI already fetched (adopt), before any server runs.
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub fn exe_name() -> &'static str {
    if cfg!(windows) { "claude.exe" } else { "claude" }
}

/// Where the app keeps the CLI it fetched (server/engine/claude/cliFetch.ts cliPath).
pub fn cli_path(state_dir: &Path) -> PathBuf {
    state_dir.join("claude").join("bin").join(exe_name())
}

/// `<cli> --version` → what it reported, or None if it did not run.
fn probe(cli: &Path) -> Option<String> {
    let mut cmd = Command::new(cli);
    // A Mac's login-shell PATH (claude_signin::user_path): a CLI that runs `node` finds it. Unchanged elsewhere.
    #[cfg(unix)]
    cmd.env("PATH", crate::claude_signin::user_path());
    crate::local_server::no_window(&mut cmd);
    let out = cmd.arg("--version").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}

/// Point everything in this process at the CLI the app fetched, if it has one.
///
/// VC_CLAUDE_BIN is the first thing both lookups honour — the sign-in driver's
/// (claude_login::candidates_in) and the server's (server/engine/claude/install.ts
/// findClaude) — and a server the app starts inherits this process's environment,
/// so one call covers the sign-in and the no-box engine both.
pub fn adopt(state_dir: &Path) -> Option<PathBuf> {
    let p = cli_path(state_dir);
    probe(&p)?;
    std::env::set_var("VC_CLAUDE_BIN", &p);
    Some(p)
}

/// Fetch the pinned CLI for this machine (or find the one it has) through the server bundle's fetch-claude-cli: the
/// slot's, then the installer's own (local_server::run_tool). `progress` is called with (bytes so far, total) as it
/// downloads. Returns the path and the version it reported.
pub fn fetch(state_dir: &Path, resource_dir: Option<&Path>, progress: impl FnMut(u64, u64)) -> Result<(PathBuf, String), String> {
    let v = crate::local_server::run_tool(state_dir, resource_dir, "fetch-claude-cli", None, progress)?;
    let cli = v["cli"].as_str().ok_or("fetch-claude-cli named no CLI")?;
    let version = v["version"].as_str().unwrap_or_default().to_string();
    Ok((PathBuf::from(cli), version))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_lands_where_the_sign_in_and_the_server_both_look() {
        let p = cli_path(Path::new("/state"));
        assert_eq!(p, Path::new("/state").join("claude").join("bin").join(exe_name()));
        assert!(exe_name().ends_with(if cfg!(windows) { ".exe" } else { "claude" }));
    }

    #[test]
    fn nothing_fetched_means_nothing_adopted() {
        let dir = std::env::temp_dir().join(format!("vc-cli-have-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(adopt(&dir).is_none(), "an empty state dir has no Claude Code");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The shell only relays: progress lines become events, the last line is the answer, and a bundle that gives no
    /// answer is passed over for the next. "/bin/sh" stands in for node, each bundle a script.
    #[cfg(unix)]
    #[test]
    fn it_relays_the_servers_lines_and_passes_over_a_bundle_that_gives_no_answer() {
        use crate::local_server::run_tool_with;
        let dir = std::env::temp_dir().join(format!("vc-cli-relay-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mute = dir.join("mute.sh");
        std::fs::write(&mute, "exit 1\n").unwrap();
        let good = dir.join("good.sh");
        std::fs::write(&good, "test \"$1\" = fetch-claude-cli || exit 9\nread line\necho \"{\\\"progress\\\":[5,10]}\"\necho 'noise'\necho \"{\\\"ok\\\":{\\\"cli\\\":\\\"/x/claude\\\",\\\"got\\\":\\\"$line\\\"}}\"\n").unwrap();
        let bad = dir.join("bad.sh");
        std::fs::write(&bad, "echo '{\"error\":\"npm has none\"}'\n").unwrap();
        let mut seen = vec![];
        assert!(run_tool_with("/bin/sh", &mute, "fetch-claude-cli", &dir, None, &mut |d, t| seen.push((d, t))).is_err());
        let got = run_tool_with("/bin/sh", &good, "fetch-claude-cli", &dir, Some("secret\n"), &mut |d, t| seen.push((d, t))).unwrap().unwrap();
        assert_eq!(got["cli"], "/x/claude");
        assert_eq!(got["got"], "secret", "stdin reaches the tool");
        assert_eq!(seen, vec![(5, 10)]);
        assert_eq!(run_tool_with("/bin/sh", &bad, "fetch-claude-cli", &dir, None, &mut |_, _| {}).unwrap(), Err("npm has none".to_string()));
        std::fs::remove_dir_all(&dir).ok();
    }
}
