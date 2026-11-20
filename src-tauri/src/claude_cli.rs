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
use std::io::{BufRead, BufReader};
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

/// One line the server's fetch-claude-cli writes.
#[derive(serde::Deserialize)]
struct Line {
    progress: Option<(u64, u64)>,
    ok: Option<Fetched>,
    error: Option<String>,
}
#[derive(serde::Deserialize)]
struct Fetched {
    cli: String,
    version: String,
}

/// Run one server bundle's fetch-claude-cli: Ok(Ok(found)) or Ok(Err(its error)); Err when it gave no answer at all
/// (it would not start, or exited without a last line): the next bundle is tried.
fn run_fetch(node: &str, bundle: &Path, state_dir: &Path, progress: &mut impl FnMut(u64, u64)) -> Result<Result<(PathBuf, String), String>, String> {
    let mut cmd = Command::new(node);
    crate::local_server::no_window(&mut cmd);
    #[cfg(unix)]
    cmd.env("PATH", crate::claude_signin::user_path());
    let mut child = cmd
        .arg(bundle)
        .arg("fetch-claude-cli")
        .arg(state_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("could not run {node}: {e}"))?;
    let out = child.stdout.take().ok_or("no output")?;
    let mut answer = None;
    for line in BufReader::new(out).lines() {
        let Ok(line) = line else { break };
        let Ok(l) = serde_json::from_str::<Line>(&line) else { continue };
        if let Some((done, total)) = l.progress {
            progress(done, total);
        }
        if let Some(f) = l.ok {
            answer = Some(Ok((PathBuf::from(f.cli), f.version)));
        } else if let Some(e) = l.error {
            answer = Some(Err(e));
        }
    }
    let _ = child.wait();
    answer.ok_or_else(|| format!("{} gave no answer", bundle.display()))
}

/// Fetch the pinned CLI for this machine (or find the one it has) through the server bundle: the slot's, then the
/// installer's own. `progress` is called with (bytes so far, total) as it downloads. Returns the path and the version
/// it reported.
pub fn fetch(state_dir: &Path, resource_dir: Option<&Path>, mut progress: impl FnMut(u64, u64)) -> Result<(PathBuf, String), String> {
    let node = crate::local_server::node_bin(resource_dir);
    let bundles = crate::local_server::server_bundles(state_dir, resource_dir);
    if bundles.is_empty() {
        return Err("this build carries no vault-chat server to fetch Claude Code with".to_string());
    }
    let mut last = String::new();
    for (_, bundle) in bundles {
        match run_fetch(&node, &bundle, state_dir, &mut progress) {
            Ok(answer) => return answer,
            Err(e) => last = e,
        }
    }
    Err(last)
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
        let dir = std::env::temp_dir().join(format!("vc-cli-relay-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mute = dir.join("mute.sh");
        std::fs::write(&mute, "exit 1\n").unwrap();
        let good = dir.join("good.sh");
        std::fs::write(&good, "test \"$1\" = fetch-claude-cli || exit 9\necho '{\"progress\":[5,10]}'\necho 'noise'\necho '{\"ok\":{\"cli\":\"/x/claude\",\"version\":\"1.2.3 (Claude Code)\"}}'\n").unwrap();
        let bad = dir.join("bad.sh");
        std::fs::write(&bad, "echo '{\"error\":\"npm has none\"}'\n").unwrap();
        let mut seen = vec![];
        assert!(run_fetch("/bin/sh", &mute, &dir, &mut |d, t| seen.push((d, t))).is_err());
        let got = run_fetch("/bin/sh", &good, &dir, &mut |d, t| seen.push((d, t))).unwrap().unwrap();
        assert_eq!(got, (PathBuf::from("/x/claude"), "1.2.3 (Claude Code)".to_string()));
        assert_eq!(seen, vec![(5, 10)]);
        assert_eq!(run_fetch("/bin/sh", &bad, &dir, &mut |_, _| {}).unwrap(), Err("npm has none".to_string()));
        std::fs::remove_dir_all(&dir).ok();
    }
}
