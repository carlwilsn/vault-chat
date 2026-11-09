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
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use base64::Engine as _;
use sha2::{Digest, Sha512};

/// The CLI the SDK pins. Kept in step with package.json's
/// @anthropic-ai/claude-agent-sdk by a test, so the app, the box and this
/// fetch all run the same Claude Code.
pub const CLI_VERSION: &str = "0.3.321";

const REGISTRY: &str = "https://registry.npmjs.org";

/// The npm package holding the native CLI for a platform, or None for one
/// Anthropic does not publish (every such machine keeps the paste fallback).
pub fn package_for(os: &str, arch: &str) -> Option<String> {
    let suffix = match (os, arch) {
        ("windows", "x86_64") => "win32-x64",
        ("windows", "aarch64") => "win32-arm64",
        ("macos", "x86_64") => "darwin-x64",
        ("macos", "aarch64") => "darwin-arm64",
        ("linux", "x86_64") => "linux-x64",
        ("linux", "aarch64") => "linux-arm64",
        _ => return None,
    };
    Some(format!("@anthropic-ai/claude-agent-sdk-{suffix}"))
}

fn this_package() -> Option<String> {
    package_for(std::env::consts::OS, std::env::consts::ARCH)
}

pub fn exe_name() -> &'static str {
    if cfg!(windows) { "claude.exe" } else { "claude" }
}

/// Where the app keeps the CLI it fetched.
pub fn cli_path(state_dir: &Path) -> PathBuf {
    state_dir.join("claude").join("bin").join(exe_name())
}

/// `<cli> --version` → what it reported, or None if it did not run.
fn probe(cli: &Path) -> Option<String> {
    let out = Command::new(cli)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}

/// The CLI this app already has, if it has one that runs.
pub fn have(state_dir: &Path) -> Option<(PathBuf, String)> {
    let p = cli_path(state_dir);
    probe(&p).map(|v| (p, v))
}

/// Claude Code this machine already has, wherever an installer left it.
fn already_here() -> Option<(PathBuf, String)> {
    let home = std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .or_else(|| std::env::var_os("USERPROFILE").filter(|h| !h.is_empty()))
        .map(PathBuf::from);
    let mut look: Vec<PathBuf> = Vec::new();
    if let Some(home) = home.as_ref() {
        look.push(home.join(".local").join("state").join("vault-chat-server").join("claude").join("bin").join(exe_name()));
        look.push(home.join(".local").join("state").join("vault-chat-server").join("claude").join("cli").join(exe_name()));
        look.push(home.join(".local").join("bin").join(exe_name()));
    }
    // And whatever answers on PATH.
    look.push(PathBuf::from(exe_name()));
    look.into_iter().find_map(|p| probe(&p).map(|v| (p, v)))
}

/// Point everything in this process at the CLI the app fetched, if it has one.
///
/// VC_CLAUDE_BIN is the first thing both lookups honour — the sign-in driver's
/// (claude_login::candidates_in) and the server's (server/engine/claude/install.ts
/// findClaude) — and a server the app starts inherits this process's environment,
/// so one call covers the sign-in and the no-box engine both.
pub fn adopt(state_dir: &Path) -> Option<PathBuf> {
    let (path, _) = have(state_dir)?;
    std::env::set_var("VC_CLAUDE_BIN", &path);
    Some(path)
}

/// What the registry says about the pinned version: where to get it, and the
/// hash it must have.
fn registry_entry(package: &str) -> Result<(String, String), String> {
    let url = format!("{REGISTRY}/{package}/{CLI_VERSION}");
    let body: serde_json::Value = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| format!("no http client: {e}"))?
        .get(&url)
        .send()
        .map_err(|e| format!("asking npm for {package}: {e}"))?
        .error_for_status()
        .map_err(|e| format!("npm has no {package}@{CLI_VERSION}: {e}"))?
        .json()
        .map_err(|e| format!("npm answered with something else: {e}"))?;
    let tarball = body["dist"]["tarball"].as_str().unwrap_or_default().to_string();
    let integrity = body["dist"]["integrity"].as_str().unwrap_or_default().to_string();
    if tarball.is_empty() || !integrity.starts_with("sha512-") {
        return Err(format!("npm gave no verifiable download for {package}@{CLI_VERSION}"));
    }
    Ok((tarball, integrity))
}

/// base64(sha512(file)), in the form npm publishes it.
fn integrity_of(path: &Path) -> Result<String, String> {
    let mut f = File::open(path).map_err(|e| format!("reading the download: {e}"))?;
    let mut hasher = Sha512::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).map_err(|e| format!("reading the download: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("sha512-{}", base64::engine::general_purpose::STANDARD.encode(hasher.finalize())))
}

/// Fetch the pinned CLI for this machine and put it where everything looks.
///
/// `progress` is called with (bytes so far, total) as it downloads, so the app
/// can say more than "wait". Returns the path and the version it reported.
///
/// Nothing is replaced until the new binary has answered `--version` here: a
/// truncated download or a binary for another machine must not become the thing
/// every turn runs on.
pub fn fetch(state_dir: &Path, mut progress: impl FnMut(u64, u64)) -> Result<(PathBuf, String), String> {
    if let Some(found) = have(state_dir) {
        return Ok(found);
    }
    // A machine that already has Claude Code — Carl's, today — keeps using it
    // rather than spending 350 MB to end up where it already was. The places
    // are the ones the sign-in driver looks in too (claude_login::candidates_in):
    // the box's pinned copy, the installer's, then whatever is on PATH.
    if let Some(found) = already_here() {
        return Ok(found);
    }
    let package = this_package()
        .ok_or_else(|| format!("Anthropic publishes no Claude Code for {}-{}", std::env::consts::OS, std::env::consts::ARCH))?;
    let (tarball, integrity) = registry_entry(&package)?;

    let dir = state_dir.join("claude");
    fs::create_dir_all(dir.join("bin")).map_err(|e| format!("could not make {}: {e}", dir.display()))?;
    let download = dir.join("incoming.tgz");
    let _ = fs::remove_file(&download);

    let mut res = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(20 * 60))
        .build()
        .map_err(|e| format!("no http client: {e}"))?
        .get(&tarball)
        .send()
        .map_err(|e| format!("downloading Claude Code: {e}"))?
        .error_for_status()
        .map_err(|e| format!("downloading Claude Code: {e}"))?;
    let total = res.content_length().unwrap_or(0);
    {
        let mut out = File::create(&download).map_err(|e| format!("could not write {}: {e}", download.display()))?;
        let mut done: u64 = 0;
        let mut buf = vec![0u8; 1 << 20];
        loop {
            let n = res.read(&mut buf).map_err(|e| format!("downloading Claude Code: {e}"))?;
            if n == 0 {
                break;
            }
            out.write_all(&buf[..n]).map_err(|e| format!("writing the download: {e}"))?;
            done += n as u64;
            progress(done, total);
        }
    }

    let got = integrity_of(&download)?;
    if got != integrity {
        let _ = fs::remove_file(&download);
        return Err("the download did not match what npm published for this version".to_string());
    }

    // tar is on every machine this runs on: Windows has carried bsdtar since
    // Windows 10, and macOS and Linux have always had one.
    let unpack = dir.join("incoming");
    let _ = fs::remove_dir_all(&unpack);
    fs::create_dir_all(&unpack).map_err(|e| format!("could not make {}: {e}", unpack.display()))?;
    let status = Command::new("tar")
        .arg("-xzf")
        .arg(&download)
        .arg("-C")
        .arg(&unpack)
        .status()
        .map_err(|e| format!("unpacking Claude Code (is tar there?): {e}"))?;
    if !status.success() {
        return Err(format!("unpacking Claude Code failed ({status})"));
    }
    // npm tarballs put everything under package/, and the binary carries the
    // platform's own name there: `package/claude.exe` in the win32-x64 package,
    // `package/claude` in linux-x64 and darwin — both read off the real
    // packages rather than assumed.
    let unpacked = unpack.join("package").join(exe_name());
    if !unpacked.is_file() {
        return Err(format!("the download held no {}", exe_name()));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&unpacked, fs::Permissions::from_mode(0o755)).map_err(|e| format!("making it runnable: {e}"))?;
    }
    let version = probe(&unpacked).ok_or_else(|| "the downloaded Claude Code would not run here".to_string())?;

    let dest = cli_path(state_dir);
    let _ = fs::remove_file(&dest);
    fs::rename(&unpacked, &dest).map_err(|e| format!("putting Claude Code in place: {e}"))?;
    let _ = fs::remove_dir_all(&unpack);
    let _ = fs::remove_file(&download);
    Ok((dest, version))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_machine_the_app_ships_for_has_a_cli_to_fetch() {
        for (os, arch) in [("windows", "x86_64"), ("macos", "aarch64"), ("macos", "x86_64"), ("linux", "x86_64")] {
            let p = package_for(os, arch).unwrap_or_else(|| panic!("no package for {os}-{arch}"));
            assert!(p.starts_with("@anthropic-ai/claude-agent-sdk-"), "{p}");
        }
        // And this machine is one of them, whichever it is.
        assert!(this_package().is_some(), "no Claude Code for {}-{}", std::env::consts::OS, std::env::consts::ARCH);
        // Somewhere Anthropic does not publish: the app says so rather than
        // downloading something that cannot run.
        assert_eq!(package_for("linux", "riscv64"), None);
    }

    #[test]
    fn it_lands_where_the_sign_in_and_the_server_both_look() {
        let p = cli_path(Path::new("/state"));
        assert_eq!(p, Path::new("/state").join("claude").join("bin").join(exe_name()));
        assert!(exe_name().ends_with(if cfg!(windows) { ".exe" } else { "claude" }));
    }

    #[test]
    fn nothing_fetched_means_nothing_claimed() {
        let dir = std::env::temp_dir().join(format!("vc-cli-have-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(have(&dir).is_none(), "an empty state dir has no Claude Code");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The whole claim, against the real registry: a machine with no Claude Code
    /// gets one that runs. ~350 MB, so it is not part of the ordinary run —
    /// `--ignored` runs it, and the windows-latest job does.
    #[test]
    #[ignore = "downloads the real Claude Code (~350 MB)"]
    fn a_machine_with_no_claude_code_fetches_one_that_runs() {
        let dir = std::env::temp_dir().join(format!("vc-cli-fetch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let started = std::time::Instant::now();
        let mut last = 0u64;
        let (path, version) = fetch(&dir, |done, total| {
            if done - last > 50_000_000 {
                last = done;
                eprintln!("  {} MB of {} MB", done / 1_000_000, total / 1_000_000);
            }
        })
        .expect("a CLI");
        eprintln!("fetched {version} to {} in {:?}", path.display(), started.elapsed());
        assert!(path.exists());
        assert!(version.contains('.'), "a version, not {version}");
        // Asked again, the same one — no second download.
        let again = std::time::Instant::now();
        let (p2, _) = fetch(&dir, |_, _| {}).expect("the same CLI");
        assert_eq!(p2, path);
        assert!(again.elapsed() < std::time::Duration::from_secs(30), "it downloaded again");
        std::fs::remove_dir_all(&dir).ok();
    }
}
