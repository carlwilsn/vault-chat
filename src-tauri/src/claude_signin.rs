// "Sign in with Claude" with no paste, on a Mac: the app runs `claude
// setup-token` itself and keeps the token it prints.
//
// History, because it matters: the app drove this command once before, through
// a pty plus a code the user pasted back, and it broke four different ways on
// Carl's Windows laptop before he said to stop (git e90d652a). Windows and Linux
// keep the paste flow exactly as it is (src/ClaudeCodeSignIn.tsx). This is the
// macOS path Carl asked for a new user: one "Authorize" click in the browser,
// the token never on screen or in any chat, and the paste flow as the fallback
// whenever this cannot finish.
//
// What the CLI really does (measured on 2.1.276, src-tauri tests below and
// reports/11-mac/README.md "mac-5"):
//   - It opens the browser itself (`$BROWSER`, else the OS opener: `open` on a
//     Mac) at claude.com's authorize page with redirect_uri
//     http://localhost:<port>/callback, and listens there. After the user's one
//     Authorize click the browser lands on that callback, the CLI exchanges the
//     code and prints the token. No code to paste.
//   - On pipes it prints NOTHING and never exits (Ink), so it gets a pty, 400
//     columns wide so neither the URL nor the token is wrapped.
//   - A refused exchange prints "OAuth error: …" and waits for Enter: the run
//     ends there with the CLI's own words.
//
// The token goes straight from the pty transcript into the key store
// (lib.rs keychain_store, the same entry the paste flow writes:
// src/keychain.ts KEY.claudeCode). It is never returned to the webview, never
// logged, never in an error (every message passes `redact`), and the transcript
// is overwritten before it is dropped. CLAUDE_CONFIG_DIR is a throwaway
// directory so nothing about this login lands in the user's ~/.claude.
//
// PATH: a Finder/Dock launch has launchd's bare PATH, so `claude` from Homebrew
// or ~/.local/bin is not found. The login shell's PATH is read first (as
// server/macEnv.ts does for the server), plus the usual folders.
//
// On: macOS. Elsewhere only with VC_CLAUDE_SIGNIN=1 in the launch environment
// (Unix), which is how the self-test proves this path on Linux under Xvfb.
#![cfg_attr(not(unix), allow(dead_code))]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// Must stay `KEY.claudeCode` from src/keychain.ts.
const CLAUDE_CODE_KEY: &str = "service.claude-code";

const PTY_COLS: u16 = 400;
const PTY_ROWS: u16 = 50;

/// The whole run: the CLI starting, the user finding the browser tab and
/// clicking Authorize, the exchange. Long enough for a person; a run that
/// passes it ends with the paste flow offered.
const RUN_LIMIT: Duration = Duration::from_secs(300);

/// Set by Cancel; the run loop sees it within 100 ms.
static CANCEL: AtomicBool = AtomicBool::new(false);
/// One run at a time.
static RUNNING: AtomicBool = AtomicBool::new(false);

// ----- reading what Ink drew -----

/// Terminal output with the escape sequences taken out: OSC strings dropped
/// whole, column moves (`ESC[<n>G`, how Ink lays a line out) turned into a
/// space so words don't collide, every other CSI dropped.
pub(crate) fn clean_terminal_output(raw: &[u8]) -> String {
    let text = String::from_utf8_lossy(raw);
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        match chars.peek().copied() {
            Some(']') => {
                chars.next();
                while let Some(d) = chars.next() {
                    if d == '\x07' {
                        break;
                    }
                    if d == '\x1b' {
                        if chars.peek() == Some(&'\\') {
                            chars.next();
                        }
                        break;
                    }
                }
            }
            Some('[') => {
                chars.next();
                let mut last = '\0';
                for d in chars.by_ref() {
                    last = d;
                    if d.is_ascii_alphabetic() || d == '@' || d == '`' {
                        break;
                    }
                }
                if last == 'G' {
                    out.push(' ');
                }
            }
            Some(c2) => {
                chars.next();
                if matches!(c2, '(' | ')' | '*' | '+' | '%' | '#') {
                    chars.next();
                }
            }
            None => {}
        }
    }
    out
}

/// The OAuth authorize URL the CLI printed (for "Browser didn't open?"), or
/// None. The longest copy wins: Ink may draw a cut-off one too.
pub(crate) fn authorize_url(cleaned: &str) -> Option<String> {
    let re = regex::Regex::new(r#"https://claude\.(?:com|ai)/[^\s"'<>]*oauth/authorize\?[^\s"'<>]+"#).expect("static regex");
    re.find_iter(cleaned).map(|m| m.as_str().to_string()).max_by_key(|u| u.len())
}

/// The token the CLI printed, once it has arrived in full: something that
/// cannot be part of it must follow (output comes in chunks, and a half token
/// once got stored and refused with a 401).
pub(crate) fn captured_token(cleaned: &str) -> Option<String> {
    let re = regex::Regex::new(r"(sk-ant-oat[A-Za-z0-9_-]{80,})[^A-Za-z0-9_-]").expect("static regex");
    re.captures(cleaned).map(|c| c[1].to_string())
}

/// Any token-shaped text taken out. Every message this module returns or
/// prints passes through here.
pub(crate) fn redact(s: &str) -> String {
    let re = regex::Regex::new(r"sk-ant-[A-Za-z0-9_-]+").expect("static regex");
    re.replace_all(s, "[redacted]").to_string()
}

/// What went wrong, in the CLI's own words (redacted), or None.
pub(crate) fn failure_message(cleaned: &str) -> Option<String> {
    for line in cleaned.lines().rev() {
        let line = line.trim();
        for prefix in ["OAuth error:", "Error:"] {
            if let Some(rest) = line.find(prefix).map(|i| &line[i + prefix.len()..]) {
                let msg = rest.replace("Press Enter to retry.", "");
                let msg = msg.trim();
                if !msg.is_empty() {
                    return Some(redact(msg));
                }
            }
        }
    }
    None
}

// ----- finding `claude` the way a terminal would -----

const MARK: &str = "__VC_PATH__";

/// The PATH out of the login shell's output, between our markers (rc files may
/// print other things). Same as server/macEnv.ts parseLoginPath.
pub(crate) fn parse_login_path(out: &str) -> Vec<String> {
    let Some(i) = out.find(MARK) else { return vec![] };
    let rest = &out[i + MARK.len()..];
    let Some(j) = rest.find(MARK) else { return vec![] };
    rest[..j].split(':').map(str::trim).filter(|s| s.starts_with('/')).map(String::from).collect()
}

/// The user's login-shell PATH, or [] when the shell fails or is slower than `limit`.
fn login_shell_path(limit: Duration) -> Vec<String> {
    let shell = std::env::var("SHELL").ok().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "/bin/zsh".into());
    login_shell_path_with(&shell, limit)
}

fn login_shell_path_with(shell: &str, limit: Duration) -> Vec<String> {
    let Ok(mut child) = std::process::Command::new(shell)
        .args(["-ilc", &format!("printf '%s%s%s' '{MARK}' \"$PATH\" '{MARK}'")])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
    else {
        return vec![];
    };
    let deadline = Instant::now() + limit;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return vec![];
            }
        }
    }
    let mut out = String::new();
    if let Some(mut so) = child.stdout.take() {
        use std::io::Read;
        let _ = so.read_to_string(&mut out);
    }
    parse_login_path(&out)
}

/// Login PATH first, then the folders a Mac's tools live in that launchd's
/// PATH leaves out, then what the process had; each once.
pub(crate) fn merge_path(login: &[String], home: Option<&Path>, current: &str) -> String {
    let mut fixed: Vec<String> = vec!["/opt/homebrew/bin".into(), "/opt/homebrew/sbin".into(), "/usr/local/bin".into()];
    if let Some(h) = home {
        fixed.push(h.join(".local").join("bin").to_string_lossy().to_string());
    }
    let mut out: Vec<String> = Vec::new();
    for d in login.iter().cloned().chain(fixed).chain(current.split(':').map(String::from)) {
        if !d.is_empty() && !out.contains(&d) {
            out.push(d);
        }
    }
    out.join(":")
}

/// The PATH a terminal would have, for every `claude` this app runs (the sign-in, Settings' "which claude",
/// the look for one already installed before fetching): on a Mac (or wherever the no-paste sign-in is on)
/// the login shell's PATH merged with the usual folders, read once per launch (a Finder/Dock launch has
/// launchd's bare /usr/bin:/bin:/usr/sbin:/sbin); elsewhere this process's own PATH, unchanged.
pub(crate) fn user_path() -> String {
    static PATH: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    PATH.get_or_init(|| {
        let current = std::env::var("PATH").unwrap_or_default();
        if !enabled() {
            return current;
        }
        let home = std::env::var_os("HOME").filter(|h| !h.is_empty()).map(PathBuf::from);
        merge_path(&login_shell_path(Duration::from_secs(4)), home.as_deref(), &current)
    })
    .clone()
}

/// An executable file named `name` in the first folder of `path` that has one.
pub(crate) fn find_on_path(name: &str, path: &str) -> Option<PathBuf> {
    path.split(':').filter(|d| !d.is_empty()).map(|d| Path::new(d).join(name)).find(|p| is_executable(p))
}

fn is_executable(p: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(p).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        p.is_file()
    }
}

/// The `claude` to run: the app's own candidates (VC_CLAUDE_BIN, the pinned
/// one, ~/.local/bin) where they are paths, else the first on `path`.
fn resolve_cli(path: &str) -> Option<PathBuf> {
    for c in crate::claude_login::candidates() {
        let p = PathBuf::from(&c);
        if p.is_absolute() {
            if is_executable(&p) {
                return Some(p);
            }
        } else if let Some(found) = find_on_path(&c, path) {
            return Some(found);
        }
    }
    None
}

/// Whether this launch offers the no-paste sign-in.
pub(crate) fn enabled_with(get: impl Fn(&str) -> Option<String>) -> bool {
    if cfg!(target_os = "macos") {
        return true;
    }
    cfg!(unix) && get("VC_CLAUDE_SIGNIN").map(|v| v.trim() == "1").unwrap_or(false)
}

fn enabled() -> bool {
    enabled_with(|k| std::env::var(k).ok())
}

// ----- the pty -----

#[cfg(unix)]
mod pty {
    use std::os::unix::io::FromRawFd;
    use std::os::unix::process::CommandExt;

    fn errno() -> String {
        std::io::Error::last_os_error().to_string()
    }

    /// A pty whose window is already wide (set before the spawn: resizing later
    /// races Ink's first frame), master non-blocking so reads poll a deadline.
    pub(super) fn open(cols: u16, rows: u16) -> Result<(std::fs::File, std::fs::File), String> {
        let ws = libc::winsize { ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0 };
        // SAFETY: the POSIX pty sequence, each step checked; ptsname's static
        // buffer is used at once on this thread.
        unsafe {
            let m = libc::posix_openpt(libc::O_RDWR | libc::O_NOCTTY);
            if m < 0 {
                return Err(format!("could not open a pty: {}", errno()));
            }
            let master = std::fs::File::from_raw_fd(m);
            if libc::grantpt(m) != 0 || libc::unlockpt(m) != 0 {
                return Err(format!("could not prepare the pty: {}", errno()));
            }
            let name = libc::ptsname(m);
            if name.is_null() {
                return Err(format!("could not name the pty: {}", errno()));
            }
            let s = libc::open(name, libc::O_RDWR | libc::O_NOCTTY);
            if s < 0 {
                return Err(format!("could not open the pty's other end: {}", errno()));
            }
            let slave = std::fs::File::from_raw_fd(s);
            // Sized through the terminal end: macOS refuses TIOCSWINSZ on the
            // master ("Inappropriate ioctl for device", seen on the Mac CI
            // runner); Linux takes it either way.
            if libc::ioctl(s, libc::TIOCSWINSZ as _, &ws) != 0 {
                return Err(format!("could not size the pty: {}", errno()));
            }
            let flags = libc::fcntl(m, libc::F_GETFL);
            if flags < 0 || libc::fcntl(m, libc::F_SETFL, flags | libc::O_NONBLOCK) < 0 {
                return Err(format!("could not set the pty non-blocking: {}", errno()));
            }
            Ok((master, slave))
        }
    }

    /// `cli setup-token` with the pty as its stdio and controlling terminal.
    pub(super) fn spawn(cli: &std::path::Path, env: &[(String, String)], slave: std::fs::File) -> Result<std::process::Child, String> {
        let one = || slave.try_clone().map_err(|e| format!("could not dup the pty: {e}"));
        let mut cmd = std::process::Command::new(cli);
        cmd.arg("setup-token")
            .stdin(std::process::Stdio::from(one()?))
            .stdout(std::process::Stdio::from(one()?))
            .stderr(std::process::Stdio::from(one()?))
            .env_clear()
            .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())));
        // SAFETY: async-signal-safe calls on the about-to-exec child only.
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::ioctl(0, libc::TIOCSCTTY as _, 0) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = cmd.spawn().map_err(|e| format!("{} would not start: {e}", cli.display()))?;
        drop(slave);
        Ok(child)
    }
}

/// The CLI's environment, built rather than inherited: no credential of this
/// process can change the flow, and nothing lands in the user's ~/.claude.
fn child_env(path: &str, config_dir: &Path) -> Vec<(String, String)> {
    let mut env = vec![
        ("TERM".to_string(), "xterm-256color".to_string()),
        ("PATH".to_string(), path.to_string()),
        ("CLAUDE_CONFIG_DIR".to_string(), config_dir.to_string_lossy().to_string()),
    ];
    for pass in ["HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "SHELL", "DISPLAY", "WAYLAND_DISPLAY", "BROWSER"] {
        if let Some(v) = std::env::var_os(pass) {
            env.push((pass.to_string(), v.to_string_lossy().to_string()));
        }
    }
    env
}

/// How a run ended. `Err` text is one line, safe to show (redacted).
#[derive(Debug, PartialEq)]
pub(crate) enum Outcome {
    Token(String),
    Failed(String),
}

/// Watch a transcript source until it yields a token, a failure, the child
/// leaving, cancel or the deadline. `read` appends what is there and answers
/// false once the other end is gone. `on_url` hears the authorize URL once.
pub(crate) fn watch(
    mut read: impl FnMut(&mut Vec<u8>) -> bool,
    limit: Duration,
    cancelled: impl Fn() -> bool,
    mut on_url: impl FnMut(&str),
) -> Outcome {
    let deadline = Instant::now() + limit;
    let mut seen: Vec<u8> = Vec::new();
    let mut told_url = false;
    let outcome = loop {
        let alive = read(&mut seen);
        let cleaned = clean_terminal_output(&seen);
        if let Some(t) = captured_token(&cleaned) {
            break Outcome::Token(t);
        }
        if !told_url {
            if let Some(u) = authorize_url(&cleaned) {
                told_url = true;
                on_url(&u);
            }
        }
        if let Some(msg) = failure_message(&cleaned) {
            break Outcome::Failed(format!("Claude said: {msg}"));
        }
        if !alive {
            // What it printed on the way out still counts.
            if let Some(t) = captured_token(&format!("{cleaned}\n")) {
                break Outcome::Token(t);
            }
            break Outcome::Failed("claude setup-token ended without giving a token".into());
        }
        if cancelled() {
            break Outcome::Failed("cancelled".into());
        }
        if Instant::now() >= deadline {
            break Outcome::Failed(format!("no sign-in after {} minutes", limit.as_secs() / 60));
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    seen.iter_mut().for_each(|b| *b = 0);
    outcome
}

#[cfg(unix)]
fn run_blocking(app: &tauri::AppHandle) -> Result<(), String> {
    use std::io::Read;
    use tauri::Emitter;
    let path = user_path();
    let cli = resolve_cli(&path).ok_or("Claude Code (claude) isn't installed on this computer")?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let config_dir = std::env::temp_dir().join(format!("vault-chat-claude-signin-{}-{stamp}", std::process::id()));
    std::fs::create_dir_all(&config_dir).map_err(|e| format!("could not make a scratch folder: {e}"))?;
    let result = (|| {
        let (mut master, slave) = pty::open(PTY_COLS, PTY_ROWS)?;
        let mut child = pty::spawn(&cli, &child_env(&path, &config_dir), slave)?;
        let outcome = watch(
            |seen| {
                let mut buf = [0u8; 16 * 1024];
                loop {
                    match master.read(&mut buf) {
                        Ok(0) => return false,
                        Ok(n) => seen.extend_from_slice(&buf[..n]),
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => return !matches!(child.try_wait(), Ok(Some(_))),
                        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                        // A pty master reads EIO, not EOF, once the child is gone.
                        Err(_) => return false,
                    }
                }
            },
            RUN_LIMIT,
            || CANCEL.load(Ordering::SeqCst),
            |url| {
                let _ = app.emit("claude-signin-url", url.to_string());
            },
        );
        let _ = child.kill();
        let _ = child.wait();
        match outcome {
            Outcome::Token(mut t) => {
                let stored = crate::keychain_store(CLAUDE_CODE_KEY, &t).map_err(|e| redact(&format!("could not keep the sign-in: {e}")));
                // SAFETY: zeroing ASCII bytes keeps the String valid UTF-8.
                unsafe { t.as_bytes_mut().iter_mut().for_each(|b| *b = 0) };
                stored
            }
            Outcome::Failed(why) => Err(why),
        }
    })();
    let _ = std::fs::remove_dir_all(&config_dir);
    result.map_err(|e| redact(&e))
}

#[cfg(not(unix))]
fn run_blocking(_app: &tauri::AppHandle) -> Result<(), String> {
    Err("not on this platform".into())
}

/// Whether Settings offers the one-click sign-in (macOS; VC_CLAUDE_SIGNIN=1 elsewhere on Unix).
#[tauri::command]
pub fn claude_signin_available() -> bool {
    enabled()
}

/// Run `claude setup-token`, keep the token it prints in the key store. Ok(())
/// means it is stored (read it back with keychain_get); Err is one line to show
/// above the paste flow. Never returns, logs or emits the token.
#[tauri::command]
pub async fn claude_signin_run(app: tauri::AppHandle) -> Result<(), String> {
    if !enabled() {
        return Err("not on this platform".into());
    }
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Err("a sign-in is already running".into());
    }
    CANCEL.store(false, Ordering::SeqCst);
    let r = tauri::async_runtime::spawn_blocking(move || run_blocking(&app)).await.map_err(|e| e.to_string()).and_then(|r| r);
    RUNNING.store(false, Ordering::SeqCst);
    match &r {
        Ok(()) => println!("[claude-signin] signed in"),
        Err(e) => eprintln!("[claude-signin] {}", redact(e)),
    }
    r
}

/// Stop a running sign-in (the paste flow shows instead).
#[tauri::command]
pub fn claude_signin_cancel() {
    CANCEL.store(true, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcdefQ1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6J7k8L9z0X1c2V3b4N5m6";

    /// The success frame as the CLI draws it: the token is its own coloured line.
    fn success_frame() -> Vec<u8> {
        format!(
            "\x1b[32m\u{2713} Long-lived authentication token created successfully!\x1b[39m\r\n\
Your OAuth token (valid for 1 year):\r\n\x1b[33m{TOKEN}\x1b[39m\r\n\
Store this token securely. You won't be able to see it again.\r\n\
Use this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>"
        )
        .into_bytes()
    }

    #[test]
    fn escapes_go_and_column_moves_become_spaces() {
        let c = clean_terminal_output(b"\x1b[38;5;174mWelcome\x1b[9Gto\x1b[12GClaude\x1b]8;id=1;https://x\x07 Code\x1b]8;;\x07");
        assert!(!c.contains('\x1b'));
        assert!(c.contains("Welcome to Claude Code"), "{c:?}");
        assert!(!c.contains("id=1"));
    }

    #[test]
    fn the_token_is_captured_only_in_full_and_not_mistaken() {
        assert_eq!(captured_token(&clean_terminal_output(&success_frame())).as_deref(), Some(TOKEN));
        assert_eq!(captured_token(&format!("Your token: {}", &TOKEN[..60])), None);
        assert_eq!(captured_token(TOKEN), None, "not ended yet: may still be arriving");
        assert_eq!(captured_token("export CLAUDE_CODE_OAUTH_TOKEN=<token>"), None);
        assert_eq!(captured_token("sk-ant-api03-nope "), None);
    }

    #[test]
    fn the_authorize_url_is_read_whole() {
        let c = clean_terminal_output(b" \xc2\xb7 Opening browser to sign in\xe2\x80\xa6\r\nhttps://claude.com/cai/oauth/authorize?code=true&client_id=x&redirect_uri=http%3A%2F%2Flocalhost%3A40671%2Fcallback&state=abc\r\n");
        assert_eq!(authorize_url(&c).as_deref(), Some("https://claude.com/cai/oauth/authorize?code=true&client_id=x&redirect_uri=http%3A%2F%2Flocalhost%3A40671%2Fcallback&state=abc"));
        assert_eq!(authorize_url("see https://claude.com/cai/settings"), None);
    }

    #[test]
    fn a_refusal_is_in_the_clis_words_and_never_carries_a_token() {
        let c = clean_terminal_output(b"OAuth error: Request failed with status code 400\r\n\r\n Press Enter to retry.");
        assert_eq!(failure_message(&c).as_deref(), Some("Request failed with status code 400"));
        let leaky = format!("Error: bad {TOKEN} here");
        let m = failure_message(&leaky).unwrap();
        assert!(!m.contains("sk-ant"), "{m}");
        assert_eq!(failure_message("Welcome to Claude Code"), None);
    }

    #[test]
    fn redact_takes_out_every_token_shape() {
        assert_eq!(redact(&format!("a {TOKEN} b sk-ant-api03-xyz")), "a [redacted] b [redacted]");
        assert_eq!(redact("nothing here"), "nothing here");
    }

    #[test]
    fn the_login_path_is_read_between_the_markers() {
        assert_eq!(parse_login_path("motd\n__VC_PATH__/opt/homebrew/bin:/usr/bin:relative__VC_PATH__"), vec!["/opt/homebrew/bin", "/usr/bin"]);
        assert!(parse_login_path("no markers").is_empty());
        assert!(parse_login_path("__VC_PATH__/usr/bin").is_empty());
    }

    #[test]
    fn path_merges_login_then_fixed_then_current_once_each() {
        let p = merge_path(&["/opt/homebrew/bin".into(), "/a".into()], Some(Path::new("/Users/f")), "/usr/bin:/bin:/a");
        assert_eq!(p, "/opt/homebrew/bin:/a:/opt/homebrew/sbin:/usr/local/bin:/Users/f/.local/bin:/usr/bin:/bin");
    }

    #[cfg(unix)]
    #[test]
    fn find_on_path_takes_the_first_executable() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("vc-signin-path-{}", std::process::id()));
        let (a, b) = (dir.join("a"), dir.join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(a.join("claude"), "x").unwrap(); // not executable: skipped
        std::fs::write(b.join("claude"), "x").unwrap();
        std::fs::set_permissions(b.join("claude"), std::fs::Permissions::from_mode(0o755)).unwrap();
        let path = format!("{}:{}", a.display(), b.display());
        assert_eq!(find_on_path("claude", &path), Some(b.join("claude")));
        assert_eq!(find_on_path("nope", &path), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A login shell whose rc files print noise and put a folder only they know about on PATH: that folder
    /// is read; a shell that hangs gives nothing within the limit.
    #[cfg(unix)]
    #[test]
    fn the_login_shells_own_path_is_read_and_a_slow_shell_gives_up() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("vc-loginsh-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let sh = dir.join("fake-login-shell");
        std::fs::write(&sh, "#!/bin/sh\necho 'motd from rc'\nPATH=/only/in/my/zprofile:$PATH\nexport PATH\nexec /bin/sh -c \"$2\"\n").unwrap();
        std::fs::set_permissions(&sh, std::fs::Permissions::from_mode(0o755)).unwrap();
        let got = login_shell_path_with(sh.to_str().unwrap(), Duration::from_secs(4));
        assert_eq!(got.first().map(String::as_str), Some("/only/in/my/zprofile"));
        let slow = dir.join("slow-shell");
        std::fs::write(&slow, "#!/bin/sh\nsleep 30\n").unwrap();
        std::fs::set_permissions(&slow, std::fs::Permissions::from_mode(0o755)).unwrap();
        let t0 = Instant::now();
        assert!(login_shell_path_with(slow.to_str().unwrap(), Duration::from_millis(300)).is_empty());
        assert!(t0.elapsed() < Duration::from_secs(5));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn on_only_on_a_mac_or_when_asked() {
        let none = |_: &str| None;
        let asked = |k: &str| (k == "VC_CLAUDE_SIGNIN").then(|| "1".to_string());
        assert_eq!(enabled_with(none), cfg!(target_os = "macos"));
        assert_eq!(enabled_with(asked), cfg!(unix));
    }

    /// The real pty, end to end, with the self-test's fake `claude` (which
    /// refuses to run without a terminal): its token comes back whole.
    #[cfg(unix)]
    #[test]
    fn the_pty_runs_a_terminal_program_and_its_token_comes_back() {
        use std::io::Read;
        let fake = Path::new(env!("CARGO_MANIFEST_DIR")).join("../test/selftest/fake-claude");
        let cfg = std::env::temp_dir().join(format!("vc-signin-pty-{}", std::process::id()));
        std::fs::create_dir_all(&cfg).unwrap();
        let (mut master, slave) = pty::open(PTY_COLS, PTY_ROWS).expect("a pty");
        let mut child = pty::spawn(&fake, &child_env("/usr/bin:/bin", &cfg), slave).expect("it starts");
        let o = watch(
            |seen| {
                let mut buf = [0u8; 4096];
                loop {
                    match master.read(&mut buf) {
                        Ok(0) => return false,
                        Ok(n) => seen.extend_from_slice(&buf[..n]),
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => return true,
                        Err(_) => return false,
                    }
                }
            },
            Duration::from_secs(20),
            || false,
            |_| {},
        );
        let _ = child.kill();
        let _ = child.wait();
        std::fs::remove_dir_all(&cfg).ok();
        match o {
            Outcome::Token(t) => assert!(t.starts_with("sk-ant-oat01-SELFTEST-fake-token")),
            Outcome::Failed(why) => panic!("no token: {why}"),
        }
    }

    fn feed(chunks: Vec<Vec<u8>>, end_alive: bool) -> impl FnMut(&mut Vec<u8>) -> bool {
        let mut it = chunks.into_iter();
        move |seen| match it.next() {
            Some(c) => {
                seen.extend_from_slice(&c);
                true
            }
            None => end_alive,
        }
    }

    #[test]
    fn watch_takes_the_token_even_when_it_arrives_in_pieces() {
        let f = success_frame();
        let (a, b) = f.split_at(140);
        let mut urls = vec![];
        let o = watch(feed(vec![b"Opening browser\r\n".to_vec(), a.to_vec(), b.to_vec()], true), Duration::from_secs(5), || false, |u| urls.push(u.to_string()));
        assert_eq!(o, Outcome::Token(TOKEN.to_string()));
    }

    #[test]
    fn watch_ends_with_a_reason_that_never_holds_a_token() {
        let o = watch(feed(vec![b"OAuth error: That code wasn't accepted.\r\nPress Enter to retry.".to_vec()], true), Duration::from_secs(5), || false, |_| {});
        assert_eq!(o, Outcome::Failed("Claude said: That code wasn't accepted.".into()));
        let o = watch(feed(vec![b"bye".to_vec()], false), Duration::from_secs(5), || false, |_| {});
        assert_eq!(o, Outcome::Failed("claude setup-token ended without giving a token".into()));
        // The token printed last, then the CLI left: still taken.
        let o = watch(feed(vec![format!("token:\r\n{TOKEN}").into_bytes()], false), Duration::from_secs(5), || false, |_| {});
        assert_eq!(o, Outcome::Token(TOKEN.to_string()));
        let o = watch(feed(vec![], true), Duration::from_secs(5), || true, |_| {});
        assert_eq!(o, Outcome::Failed("cancelled".into()));
        let o = watch(feed(vec![], true), Duration::from_millis(1), || false, |_| {});
        assert!(matches!(o, Outcome::Failed(m) if m.starts_with("no sign-in after")));
    }
}
