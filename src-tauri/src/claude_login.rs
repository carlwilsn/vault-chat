// "Sign in with Claude" in Settings → Models: minting Claude Code's long-lived
// token here, so a year-long credential never has to travel through a human's
// clipboard.
//
// `claude setup-token` is the only thing that mints one, and it is an Ink
// (full-screen terminal UI) program, so driving it takes some care. Measured on
// the pinned CLI, 2.1.319:
//
//   - On pipes it prints NOTHING and never exits — 25 s of waiting produced one
//     byte before the kill. So it has to be handed a pty, with the pty as its
//     controlling terminal, or there is nothing to read.
//   - Ink wraps to the terminal width, and at the default 80 columns both the
//     authorize URL and the token come back cut into pieces with cursor-move
//     escapes in between, which nothing can glue back together. A very wide
//     window is what keeps each of them on one line (at 400 columns the URL
//     arrives whole, as a single 346-character line).
//   - Ink positions text with `ESC[<col>G` rather than spaces, so stripping the
//     escapes runs neighbouring words together ("Pastecodehere"). Prose inside
//     one Text element keeps its own spaces; only the gaps between elements
//     vanish. That is why markers are matched with the whitespace taken out of
//     both sides, while a message shown to the user is read off the text with
//     its spacing intact.
//
// The token itself is captured and handed straight to the keychain inside this
// process: `claude_setup_token_finish` answers with nothing at all, so the
// value is never returned to the webview, never logged, and never in an error
// string. The webview reads it back through the same `keychain_get` every other
// key already uses, then pushes it to the box over the existing key path.
//
// The CLI also runs with CLAUDE_CONFIG_DIR pointed at a throwaway directory
// that is deleted when the session ends. That is not tidiness: it stops
// `setup-token` from persisting anything about this login into the user's own
// ~/.claude, so the only lasting copy of the token is the keychain one.
//
// Unix only. A pty on Windows means ConPTY and a new dependency tree for it;
// there the commands report unavailable and Settings keeps the paste field.

// Everything that reads a pty's output is unused in a Windows build rather than
// wrong, so it is allowed to sit there instead of being warned about.
#![cfg_attr(not(unix), allow(dead_code))]

use std::time::Duration;

/// Keychain entry for Claude Code's sign-in. Must stay `KEY.claudeCode` from
/// src/keychain.ts — the box push and the command-env exclusion both key off it.
const CLAUDE_CODE_KEY: &str = "service.claude-code";

/// Wide enough that neither the authorize URL (~350 chars) nor the token
/// (~110) is wrapped by Ink. Rows only have to be enough for its layout.
const PTY_COLS: u16 = 400;
const PTY_ROWS: u16 = 50;

/// Waiting for the authorize URL. The CLI starts, probes and renders first —
/// measured at 6–9 s on a warm box, and a 340 MB binary off a cold page cache
/// is slower still.
const URL_WAIT: Duration = Duration::from_secs(90);
/// Waiting for the token once the code has gone in. The CLI exchanges the code
/// for the token over the network, so this is a request, not a render.
const TOKEN_WAIT: Duration = Duration::from_secs(120);

// ----- reading what Ink drew -----

/// Terminal output with the escape sequences taken out: OSC strings (which is
/// where the hyperlink copies of the URL live) dropped whole, column moves
/// turned into a space so words don't collide, every other CSI dropped.
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
            // OSC: runs to BEL or ST. Everything in between is the sequence's
            // own payload (a hyperlink target, a window title), never content.
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
            // CSI: parameter bytes, then one final byte. `G` moves the cursor to
            // a column, which is how Ink lays a line out, so it becomes a space.
            Some('[') => {
                chars.next();
                let mut last = '\0';
                while let Some(d) = chars.next() {
                    last = d;
                    if d.is_ascii_alphabetic() || d == '@' || d == '`' {
                        break;
                    }
                }
                if last == 'G' {
                    out.push(' ');
                }
            }
            // Anything else is a short escape: drop it and its argument. The
            // charset selectors take one byte more than the rest, and leaving
            // that byte behind would drop a stray letter into the text.
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

/// `text` with every run of whitespace removed, for matching a marker that Ink
/// may have laid out with cursor moves instead of spaces.
pub(crate) fn flattened(text: &str) -> String {
    text.chars().filter(|c| !c.is_whitespace()).collect()
}

/// The OAuth authorize URL the CLI printed, or None (it hasn't got there yet).
pub(crate) fn authorize_url(cleaned: &str) -> Option<String> {
    let re = regex::Regex::new(r#"https://claude\.(?:com|ai)/[^\s"'<>]*oauth/authorize\?[^\s"'<>]+"#)
        .expect("static regex");
    // The same URL is drawn more than once (the link and its visible text), and
    // a copy may be the one that got truncated — keep the longest.
    re.find_iter(cleaned)
        .map(|m| m.as_str().to_string())
        .max_by_key(|u| u.len())
}

/// True once the CLI is waiting for the code from the browser.
pub(crate) fn wants_code(cleaned: &str) -> bool {
    flattened(cleaned).contains("Pastecodehere")
}

/// The long-lived token the CLI printed, or None. Matched on the token's own
/// shape rather than the prose around it: that prose is the part of the output
/// most likely to be reworded, and the token is drawn as its own line.
///
/// `sk-ant-oat` and nothing more specific, because that is the whole of what
/// the CLI itself checks for one (`isAnthropicOAuthToken` is a `startsWith`),
/// so a future `oat02-` or a changed separator still matches. The tail length
/// is what keeps the "export CLAUDE_CODE_OAUTH_TOKEN=<token>" hint and an
/// `sk-ant-api…` key from being mistaken for one.
pub(crate) fn captured_token(cleaned: &str) -> Option<String> {
    let re = regex::Regex::new(r"sk-ant-oat[A-Za-z0-9_-]{20,}").expect("static regex");
    re.find(cleaned).map(|m| m.as_str().to_string())
}

/// What went wrong, in the CLI's own words, or None. Used only when no token
/// arrived, so the user is told "that code was already used" instead of a bare
/// timeout.
pub(crate) fn failure_message(cleaned: &str) -> Option<String> {
    for line in cleaned.lines().rev() {
        let line = line.trim();
        // The CLI's own prefix for a refused code, and the generic one. Checked
        // on the raw line because an error sentence keeps its own spacing.
        for prefix in ["OAuth error:", "Error:"] {
            if let Some(rest) = line.find(prefix).map(|i| &line[i + prefix.len()..]) {
                let msg = rest.trim();
                if !msg.is_empty() {
                    // The retry hint is about the CLI's own prompt, which is
                    // gone by the time this is shown.
                    return Some(msg.replace("Press Enter to retry.", "").trim().to_string());
                }
            }
        }
    }
    None
}

// ----- finding a CLI that can mint a token -----

/// Where a `claude` this machine can run might be, best first. Mirrors the
/// box's own order (server/engine/claude/install.ts findClaude) so the desktop
/// side finds the same pinned binary a box install dropped, and only falls back
/// to whatever is on PATH. Any version mints the same account token, so an
/// older `claude` on PATH is still fine here.
/// This user's home, by whichever name the platform uses for it. Windows has no
/// HOME: taking only HOME there found nothing, which is half of why the button
/// did nothing on Carl's laptop.
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
/// Deliberately the app's own environment, unlike the real run below, which
/// builds one from scratch. Only this answers "is there a claude here at all",
/// and either way of being wrong degrades to the paste field: a probe that
/// passes where the run fails shows an error next to it, and a probe that fails
/// where the run would have worked only hides the button.
fn probe(cli: &str) -> Option<String> {
    let out = std::process::Command::new(cli)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let re = regex::Regex::new(r"\d+\.\d+\.\d+").expect("static regex");
    re.find(&text).map(|m| m.as_str().to_string())
}

#[derive(serde::Serialize)]
pub struct ClaudeCli {
    /// Shown so the user can see which `claude` the button will drive.
    pub version: String,
}

// ----- the session -----


// The pty itself, per platform: a Session that can be read, typed into and
// ended. Everything ABOVE this line and the whole sign-in sequence BELOW it are
// shared, so Windows and Unix run the same logic and only the pty differs.
#[cfg(unix)]
mod pty_session {
    use super::*;
    use std::io::{Read, Write};
    use std::os::unix::io::FromRawFd;
    use std::os::unix::process::CommandExt;


    pub(super) struct Session {
        child: std::process::Child,
        /// The master side. Non-blocking, so a read can be polled to a deadline.
        master: std::fs::File,
        /// Throwaway CLAUDE_CONFIG_DIR, removed when the session ends.
        config_dir: std::path::PathBuf,
        /// Everything read so far: Ink redraws, so a marker can only be found
        /// against the whole transcript, not the latest chunk.
        seen: Vec<u8>,
    }

    impl Session {
        /// Kill the CLI and take its config directory with it. Called on every
        /// exit path, including the ones that worked.
        pub(super) fn end(mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
            let _ = std::fs::remove_dir_all(&self.config_dir);
            // The transcript held the token the CLI printed. Overwrite rather
            // than just drop it, so a core dump or a reused page can't carry it.
            self.seen.iter_mut().for_each(|b| *b = 0);
        }

        /// Read whatever is there, appended to `seen`. Ok(false) once the CLI's
        /// end of the pty is gone.
        pub(super) fn pump(&mut self) -> std::io::Result<bool> {
            let mut buf = [0u8; 16 * 1024];
            loop {
                match self.master.read(&mut buf) {
                    Ok(0) => return Ok(false),
                    Ok(n) => self.seen.extend_from_slice(&buf[..n]),
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => return Ok(true),
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    // A pty master reads EIO, not EOF, once the child is gone.
                    Err(_) => return Ok(false),
                }
            }
        }

        /// Type a line at the CLI. The master is non-blocking, so a full pty
        /// input buffer answers WouldBlock rather than waiting — which
        /// `write_all` would turn into a failed sign-in.
        pub(super) fn type_in(&mut self, line: &str) -> std::io::Result<()> {
            let bytes = format!("{line}\r").into_bytes();
            let mut sent = 0;
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            while sent < bytes.len() {
                match self.master.write(&bytes[sent..]) {
                    Ok(0) => return Err(std::io::ErrorKind::WriteZero.into()),
                    Ok(n) => sent += n,
                    Err(e)
                        if matches!(
                            e.kind(),
                            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                        ) =>
                    {
                        if std::time::Instant::now() >= deadline {
                            return Err(e);
                        }
                        std::thread::sleep(Duration::from_millis(20));
                    }
                    Err(e) => return Err(e),
                }
            }
            self.master.flush()
        }

        /// Where the transcript has got to, so a later wait can be told to look
        /// only at what the CLI prints from here on. Without that, a wait for a
        /// refusal would match one the CLI had already printed and answered.
        pub(super) fn mark(&self) -> usize {
            self.seen.len()
        }

        /// Pump until `found` answers, or the deadline passes. Only the
        /// transcript from `mark` on is considered, and it is returned either
        /// way so the caller can say what went wrong.
        pub(super) fn wait_for<T>(
            &mut self,
            mark: usize,
            limit: Duration,
            found: impl Fn(&str) -> Option<T>,
        ) -> (Option<T>, String) {
            let deadline = std::time::Instant::now() + limit;
            loop {
                let alive = self.pump().unwrap_or(false);
                let cleaned = clean_terminal_output(&self.seen[mark.min(self.seen.len())..]);
                if let Some(hit) = found(&cleaned) {
                    return (Some(hit), cleaned);
                }
                // One last look was taken above, so a dead child can stop now.
                if !alive || std::time::Instant::now() >= deadline {
                    return (None, cleaned);
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }


    fn errno() -> String {
        std::io::Error::last_os_error().to_string()
    }

    /// A pty whose window is already PTY_COLS wide — set at creation, because
    /// resizing after the spawn would race Ink's first frame, and that frame is
    /// where the URL gets wrapped or not.
    fn open_pty() -> Result<(std::fs::File, std::fs::File), String> {
        let ws = libc::winsize {
            ws_row: PTY_ROWS,
            ws_col: PTY_COLS,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        // SAFETY: the POSIX pty dance, each step checked. `ptsname` returns a
        // per-process static buffer and nothing else in this app calls it; the
        // name is copied before anything else can run on this thread.
        unsafe {
            let master = libc::posix_openpt(libc::O_RDWR | libc::O_NOCTTY);
            if master < 0 {
                return Err(format!("could not open a pty: {}", errno()));
            }
            let master = std::fs::File::from_raw_fd(master);
            let fd = std::os::unix::io::AsRawFd::as_raw_fd(&master);
            if libc::grantpt(fd) != 0 || libc::unlockpt(fd) != 0 {
                return Err(format!("could not prepare the pty: {}", errno()));
            }
            if libc::ioctl(fd, libc::TIOCSWINSZ as _, &ws) != 0 {
                return Err(format!("could not size the pty: {}", errno()));
            }
            let name = libc::ptsname(fd);
            if name.is_null() {
                return Err(format!("could not name the pty: {}", errno()));
            }
            let slave = libc::open(name, libc::O_RDWR | libc::O_NOCTTY);
            if slave < 0 {
                return Err(format!("could not open the pty's other end: {}", errno()));
            }
            // Reads have to be pollable against a deadline; a blocking master
            // would hang the command for as long as the CLI stays quiet.
            let flags = libc::fcntl(fd, libc::F_GETFL);
            if flags < 0 || libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) < 0 {
                return Err(format!("could not set the pty non-blocking: {}", errno()));
            }
            Ok((master, std::fs::File::from_raw_fd(slave)))
        }
    }

    /// The CLI's environment, built rather than inherited. What matters:
    /// Start `claude setup-token` on a pty that is also its controlling
    /// terminal. `env` is built by the shared code, so both platforms give the
    /// CLI the same environment.
    pub(super) fn spawn(cli: &str, config_dir: &std::path::Path, env: Vec<(String, String)>) -> Result<Session, String> {
        let (master, slave) = open_pty()?;
        let one = || slave.try_clone().map_err(|e| format!("could not dup the pty: {e}"));
        let mut cmd = std::process::Command::new(cli);
        cmd.arg("setup-token")
            .stdin(std::process::Stdio::from(one()?))
            .stdout(std::process::Stdio::from(one()?))
            .stderr(std::process::Stdio::from(one()?))
            .env_clear()
            .envs(env);
        // SAFETY: both calls are async-signal-safe and touch only this
        // about-to-exec child. Without them the pty is not the child's
        // controlling terminal and Ink cannot take the terminal over.
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
        let child = cmd.spawn().map_err(|e| format!("{cli} would not start: {e}"))?;
        // The parent's copy has to go, or the master never sees the CLI leave.
        drop(slave);
        Ok(Session { child, master, config_dir: config_dir.to_path_buf(), seen: Vec::new() })
    }

}



/// The same Session on Windows, over ConPTY. `claude setup-token` is an Ink
/// program there too: it draws nothing on pipes, so the pty is not optional —
/// which is why the button did nothing at all on Carl's laptop before this.
///
/// portable-pty owns the ConPTY plumbing (it is what wezterm uses). Its reads
/// block, so a thread drains the pty into a buffer the waits poll, which gives
/// the same "read whatever is there, against the whole transcript" behaviour
/// the Unix side gets from a non-blocking master.
#[cfg(windows)]
mod pty_session {
    use super::*;
    use std::io::Write;
    use std::sync::{Arc, Mutex};

    pub(super) struct Session {
        child: Box<dyn portable_pty::Child + Send + Sync>,
        writer: Box<dyn Write + Send>,
        /// Owns the pseudoconsole. The writer and reader are bare pipes that do
        /// not keep it open; with master and slave both dropped, ConPTY closed
        /// while claude.exe was still starting and it died in DLL init
        /// (0xC0000142) — the "Application Error" on Carl's laptop.
        master: Option<Box<dyn portable_pty::MasterPty + Send>>,
        /// How many cursor-position queries have been answered (see `answer_dsr`).
        answered: usize,
        /// Filled by the reader thread; drained by the waits.
        seen: Arc<Mutex<Vec<u8>>>,
        /// Throwaway CLAUDE_CONFIG_DIR, removed when the session ends.
        config_dir: std::path::PathBuf,
    }

    impl Session {
        /// Kill the CLI and take its config directory with it.
        pub(super) fn end(mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
            // Only now that the CLI is gone does the console go with it.
            drop(self.master.take());
            let _ = std::fs::remove_dir_all(&self.config_dir);
            // The transcript held the token the CLI printed: overwrite it rather
            // than just drop it.
            if let Ok(mut seen) = self.seen.lock() {
                seen.iter_mut().for_each(|b| *b = 0);
            }
        }

        /// How much has been read so far, so a later wait can ignore everything
        /// the CLI printed for an earlier attempt.
        pub(super) fn mark(&self) -> usize {
            self.seen.lock().map(|s| s.len()).unwrap_or(0)
        }

        /// ConPTY opens (with INHERIT_CURSOR, which portable-pty sets) by asking
        /// the terminal where the cursor is — ESC[6n — and shows nothing at all
        /// until it is told. There is no terminal here, so this answers for one:
        /// top left, once per query.
        fn answer_dsr(&mut self) {
            let asked = match self.seen.lock() {
                Ok(seen) => seen.windows(4).filter(|w| *w == b"[6n").count(),
                Err(_) => return,
            };
            while self.answered < asked {
                let _ = self.writer.write_all(b"[1;1R").and_then(|_| self.writer.flush());
                self.answered += 1;
            }
        }

        /// Type a line at the CLI.
        pub(super) fn type_in(&mut self, line: &str) -> Result<(), String> {
            self.writer
                .write_all(format!("{line}\r").as_bytes())
                .and_then(|_| self.writer.flush())
                .map_err(|e| e.to_string())
        }

        /// Watch the transcript from `mark` until `f` finds what it wants or the
        /// time runs out, answering with that and the text as it last stood.
        pub(super) fn wait_for<T, F: Fn(&str) -> Option<T>>(
            &mut self,
            mark: usize,
            limit: std::time::Duration,
            f: F,
        ) -> (Option<T>, String) {
            let deadline = std::time::Instant::now() + limit;
            loop {
                self.answer_dsr();
                let raw = match self.seen.lock() {
                    Ok(seen) => seen[mark.min(seen.len())..].to_vec(),
                    Err(_) => Vec::new(),
                };
                let cleaned = clean_terminal_output(&raw);
                if let Some(found) = f(&cleaned) {
                    return (Some(found), cleaned);
                }
                // The CLI leaving is not the end of the transcript: what it
                // printed on the way out is still the answer.
                if matches!(self.child.try_wait(), Ok(Some(_))) {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                    let raw = match self.seen.lock() {
                        Ok(seen) => seen[mark.min(seen.len())..].to_vec(),
                        Err(_) => Vec::new(),
                    };
                    let last = clean_terminal_output(&raw);
                    return (f(&last), last);
                }
                if std::time::Instant::now() >= deadline {
                    return (None, cleaned);
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }
    }

    pub(super) fn spawn(cli: &str, config_dir: &std::path::Path, env: Vec<(String, String)>) -> Result<Session, String> {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        let pair = native_pty_system()
            .openpty(PtySize { rows: PTY_ROWS, cols: PTY_COLS, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("could not open a console for the sign-in: {e}"))?;
        let mut cmd = CommandBuilder::new(cli);
        cmd.arg("setup-token");
        // Not env_clear(): Windows programs need SystemRoot, windir, APPDATA and
        // the rest just to start. CommandBuilder begins from this process's own
        // environment; only what could carry a credential is taken out.
        let names: Vec<String> = std::env::vars_os().map(|(k, _)| k.to_string_lossy().to_string()).collect();
        for k in names {
            if !super::pty::windows_passes(&k) {
                cmd.env_remove(k);
            }
        }
        for (k, v) in env {
            cmd.env(k, v);
        }
        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("{cli} would not start: {e}"))?;
        // The parent's copy has to go, or the reader never sees the CLI leave.
        drop(pair.slave);
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("could not write to the sign-in console: {e}"))?;
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("could not read the sign-in console: {e}"))?;
        let seen: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        let into = Arc::clone(&seen);
        // Reads block on Windows, so they live on their own thread. It ends when
        // the pty does, and the master is dropped with the session.
        std::thread::spawn(move || {
            use std::io::Read;
            let mut buf = [0u8; 16 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => return,
                    Ok(n) => {
                        if let Ok(mut s) = into.lock() {
                            s.extend_from_slice(&buf[..n]);
                        }
                    }
                }
            }
        });
        Ok(Session { child, writer, master: Some(pair.master), answered: 0, seen, config_dir: config_dir.to_path_buf() })
    }
}

mod pty {
    use super::*;
    use std::sync::Mutex;
    use super::pty_session::{spawn, Session};

    /// One sign-in at a time. Pressing the button again replaces the one in
    /// flight, which is also what makes a stale half-finished attempt go away.
    static LIVE: Mutex<Option<Session>> = Mutex::new(None);
    /// - no ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN, so an existing
    ///   credential in this process's environment cannot change the flow;
    /// - CLAUDE_CONFIG_DIR somewhere throwaway, so nothing about this login is
    ///   left in the user's own ~/.claude;
    /// - a real TERM, because Ink draws nothing useful without one;
    /// - BROWSER=true, a no-op on PATH everywhere, so the CLI does not open the
    ///   page itself. The webview opens it through the app's own opener, which
    ///   is the path that works in a packaged build.
    /// Whether a variable of this app's own environment reaches the Windows
    /// sign-in. Names compare case-insensitively, as Windows does.
    #[cfg_attr(not(windows), allow(dead_code))]
    pub(super) fn windows_passes(name: &str) -> bool {
        let up = name.to_ascii_uppercase();
        !(up.starts_with("ANTHROPIC_")
            || up.starts_with("CLAUDE_")
            || up.starts_with("VC_")
            || up.contains("TOKEN")
            || up.contains("SECRET")
            || up.contains("API_KEY")
            || matches!(up.as_str(), "TERM" | "BROWSER"))
    }

    pub(super) fn child_env(config_dir: &std::path::Path) -> Vec<(String, String)> {
        let mut env = vec![
            ("TERM".to_string(), "xterm-256color".to_string()),
            ("BROWSER".to_string(), "true".to_string()),
            ("CLAUDE_CONFIG_DIR".to_string(), config_dir.to_string_lossy().to_string()),
        ];
        for pass in ["HOME", "PATH", "USER", "LOGNAME", "LANG", "TMPDIR", "SHELL"] {
            if let Some(v) = std::env::var_os(pass) {
                env.push((pass.to_string(), v.to_string_lossy().to_string()));
            }
        }
        env
    }

    fn scratch_config_dir() -> Result<std::path::PathBuf, String> {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "vault-chat-claude-signin-{}-{stamp}",
            std::process::id(),
        ));
        std::fs::create_dir_all(&dir).map_err(|e| format!("could not make a scratch config dir: {e}"))?;
        Ok(dir)
    }

    pub(super) fn cli() -> Option<ClaudeCli> {
        candidates()
            .iter()
            .find_map(|c| probe(c).map(|version| ClaudeCli { version }))
    }

    /// Park a started session for `finish`, ending whatever it displaces.
    fn park(session: Session) -> Result<(), String> {
        match LIVE.lock() {
            Ok(mut live) => {
                if let Some(old) = live.replace(session) {
                    old.end();
                }
                Ok(())
            }
            Err(_) => {
                session.end();
                Err("sign-in state is poisoned".to_string())
            }
        }
    }

    pub(super) fn start() -> Result<String, String> {
        // Whatever was in flight is replaced — which is also how a stale
        // half-finished attempt goes away. Done before the long wait below,
        // and without holding the lock through it, so `cancel` stays answerable
        // while the CLI is still starting up.
        cancel();
        let cli = candidates()
            .into_iter()
            .find(|c| probe(c).is_some())
            .ok_or("no Claude Code on this machine could run `setup-token`")?;
        let config_dir = scratch_config_dir()?;
        let mut session = match spawn(&cli, &config_dir, child_env(&config_dir)) {
            Ok(s) => s,
            Err(e) => {
                let _ = std::fs::remove_dir_all(&config_dir);
                return Err(e);
            }
        };
        let (url, cleaned) = session.wait_for(0, URL_WAIT, authorize_url);
        match url {
            Some(url) => {
                park(session)?;
                Ok(url)
            }
            None => {
                session.end();
                Err(failure_message(&cleaned)
                    .unwrap_or_else(|| "`claude setup-token` never printed a sign-in link".to_string()))
            }
        }
    }

    pub(super) fn finish(code: &str) -> Result<(), String> {
        // Taken, not borrowed, and the guard dropped before the waiting starts:
        // this attempt is over either way (a refused code needs a fresh link),
        // and nothing else should queue behind it for two minutes.
        let mut session = {
            let mut live = LIVE.lock().map_err(|_| "sign-in state is poisoned".to_string())?;
            live.take().ok_or("no sign-in is in progress")?
        };
        // The CLI may still have been rendering when the browser came back.
        let (ready, _) = session.wait_for(0, Duration::from_secs(15), |c| wants_code(c).then_some(()));
        if ready.is_none() {
            session.end();
            return Err("`claude setup-token` never asked for the code".to_string());
        }
        // Everything from here on is the answer to this code, so a refusal the
        // CLI printed for an earlier attempt cannot be read as this one's.
        let mark = session.mark();
        if let Err(e) = session.type_in(code.trim()) {
            session.end();
            return Err(format!("could not hand the code to `claude setup-token`: {e}"));
        }
        // Either outcome ends the wait. Watching only for the token would cost
        // the user the full TOKEN_WAIT on a code the CLI refused in a second —
        // it prints "Press Enter to retry" and stays up, so it never exits.
        enum Done {
            Token(String),
            Refused(String),
        }
        let (done, cleaned) = session.wait_for(mark, TOKEN_WAIT, |c| {
            captured_token(c)
                .map(Done::Token)
                .or_else(|| failure_message(c).map(Done::Refused))
        });
        let token = match done {
            Some(Done::Token(t)) => t,
            Some(Done::Refused(msg)) => {
                session.end();
                return Err(msg);
            }
            None => {
                session.end();
                return Err(failure_message(&cleaned)
                    .unwrap_or_else(|| "the sign-in did not finish — no token came back".to_string()));
            }
        };
        // Straight to the keychain, in this process. The value does not go back
        // to the webview and is kept out of every error string below.
        let stored = crate::keychain_store(CLAUDE_CODE_KEY, &token);
        // The CLI printed it once and says so; the session dies here either way.
        session.end();
        stored.map_err(|e| format!("signed in, but the token could not be stored: {e}"))
    }

    pub(super) fn cancel() {
        if let Ok(mut live) = LIVE.lock() {
            if let Some(s) = live.take() {
                s.end();
            }
        }
    }
}
// ----- commands -----

/// The `claude` the button would drive, or null — in which case Settings offers
/// only the paste field.
#[tauri::command]
pub async fn claude_setup_token_cli() -> Option<ClaudeCli> {
    tauri::async_runtime::spawn_blocking(pty::cli).await.ok().flatten()
}

/// Start `claude setup-token` and answer with the page the user has to sign in
/// on. The webview opens it; the code from that page comes back to `finish`.
#[tauri::command]
pub async fn claude_setup_token_start() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(pty::start)
        .await
        .map_err(|e| e.to_string())?
}

/// Hand the code from the browser to the waiting CLI and put the token it
/// prints in the keychain. Answers with nothing: the token never comes back
/// across this boundary.
#[tauri::command]
pub async fn claude_setup_token_finish(code: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || pty::finish(&code))
        .await
        .map_err(|e| e.to_string())?
}

/// The user closed the panel: stop the CLI and drop its scratch config dir.
#[tauri::command]
pub async fn claude_setup_token_cancel() {
    let _ = tauri::async_runtime::spawn_blocking(pty::cancel).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// How Ink actually draws: `ESC[<col>G` between elements instead of spaces,
    /// SGR colour around a value, an OSC 8 hyperlink carrying its own copy of
    /// the URL. Taken from a recorded transcript of the pinned CLI.
    const INK_URL_FRAME: &[u8] = b"\x1b[38;5;174mWelcome\x1b[9Gto\x1b[12GClaude\x1b[19GCode\x1b[24G\x1b[38;5;246mv2.1.319\x1b[39m\r\n\
Browser didn't open? Use the url below to sign in (c to copy)\r\n\
\x1b]8;id=24igqm;https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&state=TRUNCATED\x07\
https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code&scope=user%3Ainference&state=xMtBcoHEYQxd6sEFNiGe1poCB1sOk8xHyZEqVihqcjo\x1b]8;;\x07\r\n\
\r\nPaste\x1b[7Gcode\x1b[12Ghere\x1b[17Gif\x1b[20Gprompted\x1b[29G>";

    #[test]
    fn escapes_go_but_laid_out_words_do_not_collide() {
        let cleaned = clean_terminal_output(INK_URL_FRAME);
        assert!(!cleaned.contains('\x1b'), "escapes left behind: {cleaned:?}");
        // Column moves became spaces, so the banner is still readable.
        assert!(cleaned.contains("Welcome to Claude Code"), "{cleaned:?}");
        // The OSC hyperlink's payload is gone, visible text kept.
        assert!(!cleaned.contains("id=24igqm"), "{cleaned:?}");
        assert!(cleaned.contains("Browser didn't open?"), "{cleaned:?}");
    }

    #[test]
    fn the_authorize_url_comes_back_whole_and_the_truncated_copy_loses() {
        let cleaned = clean_terminal_output(INK_URL_FRAME);
        let url = authorize_url(&cleaned).expect("a url");
        assert!(url.ends_with("state=xMtBcoHEYQxd6sEFNiGe1poCB1sOk8xHyZEqVihqcjo"), "{url}");
        assert!(url.contains("code_challenge") || url.contains("response_type=code"), "{url}");
        // No escape or neighbouring text got swept in with it.
        assert!(!url.contains('\x1b') && !url.contains("Paste"), "{url}");
    }

    #[test]
    fn the_prompt_is_recognised_through_inks_column_moves() {
        assert!(wants_code(&clean_terminal_output(INK_URL_FRAME)));
        // ... and is not claimed before the CLI gets there.
        assert!(!wants_code("Opening browser to sign in…"));
    }

    #[test]
    fn no_url_before_the_cli_prints_one() {
        assert_eq!(authorize_url("Welcome to Claude Code v2.1.319"), None);
        // claude.com pages that are not the authorize endpoint are not it.
        assert_eq!(authorize_url("see https://claude.com/cai/settings for help"), None);
    }

    /// The success frame: the token is its own coloured Text on its own line,
    /// and the line after it names the variable with a literal placeholder.
    #[test]
    fn the_token_is_captured_and_the_placeholder_is_not_mistaken_for_one() {
        let frame = b"\x1b[32m\xe2\x9c\x93 Long-lived authentication token created successfully!\x1b[39m\r\n\
Your OAuth token (valid for 1 year):\r\n\
\x1b[33msk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcdef\x1b[39m\r\n\
Store this token securely. You won't be able to see it again.\r\n\
Use this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>";
        let cleaned = clean_terminal_output(frame);
        let token = captured_token(&cleaned).expect("a token");
        assert_eq!(token, "sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcdef");
        // Nothing before the token is waiting to be read as one.
        assert_eq!(captured_token("Your OAuth token (valid for 1 year):"), None);
        assert_eq!(captured_token("export CLAUDE_CODE_OAUTH_TOKEN=<token>"), None);
        // An API key is not a setup-token token.
        assert_eq!(captured_token("sk-ant-api03-nope"), None);
        // Nor is the prefix on its own, or anything too short to be a token.
        assert_eq!(captured_token("tokens start with sk-ant-oat"), None);
        // A future shape the CLI would still accept is still captured.
        assert_eq!(
            captured_token("sk-ant-oat99_AbCdEfGhIjKlMnOpQrStUvWxYz").as_deref(),
            Some("sk-ant-oat99_AbCdEfGhIjKlMnOpQrStUvWxYz"),
        );
    }

    /// The real refusal, as the pinned CLI printed it for a bogus code.
    #[test]
    fn a_refused_code_is_reported_in_the_clis_own_words() {
        let cleaned = clean_terminal_output(
            b"********adbeef\r\nOAuth error: That code wasn't accepted. It may be incomplete, \
expired, already used, or from an earlier sign-in attempt. Sign in again to get a new code.Press Enter to retry.",
        );
        let msg = failure_message(&cleaned).expect("a message");
        assert!(msg.starts_with("That code wasn't accepted."), "{msg}");
        // The hint about a prompt the user cannot see is dropped.
        assert!(!msg.contains("Press Enter"), "{msg}");
        assert_eq!(failure_message("Welcome to Claude Code"), None);
    }

    /// A refusal must never become a way to leak the value: `finish` builds its
    /// error from the transcript, so a transcript that happens to hold a token
    /// still must not put one in a message. (It cannot: the token branch wins.)
    #[test]
    fn a_transcript_with_a_token_takes_the_token_branch_not_the_error_branch() {
        let cleaned = clean_terminal_output(
            b"OAuth error: something earlier failed.\r\nsk-ant-oat01-ZZZZZZZZZZZZZZZZZZZZZZZZZZZZ\r\n",
        );
        assert!(captured_token(&cleaned).is_some());
        assert!(!failure_message(&cleaned).unwrap_or_default().contains("sk-ant"));
    }

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

    /// The one piece of the flow that must drive the real CLI: that a pty gets
    /// an authorize URL out of it at all. Needs the pinned binary and the
    /// network, so it is not part of the ordinary run — `--ignored` runs it.
    ///
    /// On both platforms, deliberately. It was Unix-only while the button was
    /// broken on Carl's Windows laptop for three releases, which is exactly the
    /// machine it had to run on; .github/workflows/windows-signin.yml runs it on
    /// windows-latest against the real claude.exe and fails if it finds no live
    /// test to run.
    #[test]
    fn windows_sign_in_keeps_what_windows_needs_and_drops_credentials() {
        for keep in ["SystemRoot", "windir", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "PATHEXT", "ComSpec", "Path"] {
            assert!(pty::windows_passes(keep), "{keep} must reach claude.exe");
        }
        for drop in ["ANTHROPIC_API_KEY", "anthropic_base_url", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "GITHUB_TOKEN", "OPENROUTER_API_KEY", "MY_SECRET", "TERM", "BROWSER", "VC_CLAUDE_BIN"] {
            assert!(!pty::windows_passes(drop), "{drop} must not reach claude.exe");
        }
    }

    #[test]
    #[ignore = "drives the real `claude setup-token` (needs the CLI and network)"]
    fn a_real_setup_token_hands_over_a_sign_in_url() {
        let started = std::time::Instant::now();
        let url = pty::start().expect("setup-token should print a sign-in link");
        eprintln!("url after {:?}, {} chars", started.elapsed(), url.len());
        assert!(url.starts_with("https://claude."), "{url}");
        assert!(url.contains("oauth/authorize?"), "{url}");
        assert!(url.contains("code_challenge="), "{url}");
        // The whole link, not the first line of a wrapped one — which is the
        // thing the wide pty window is there to guarantee.
        assert!(url.len() > 300, "a truncated link came back: {} chars", url.len());
        assert!(url.contains("state="), "the link lost its tail: {url}");

        // A code that cannot work must come back as the CLI's refusal — and
        // come back promptly. The CLI does not exit after refusing one, so
        // without the early-out this is where the user would wait out TOKEN_WAIT.
        let asked = std::time::Instant::now();
        let err = pty::finish("bogus#deadbeef").expect_err("a bogus code cannot sign in");
        let took = asked.elapsed();
        eprintln!("refusal after {took:?}: {err}");
        assert!(!err.contains("sk-ant"), "the error carried a token: {err}");
        assert!(err.to_lowercase().contains("code"), "{err}");
        assert!(took < TOKEN_WAIT / 2, "a refusal should not wait out the token timeout: {took:?}");
        // The session is gone with it, so the next attempt starts clean.
        assert!(pty::finish("again").is_err(), "a finished session must not still be live");
        pty::cancel();
        // Nothing of this login is left on disk.
        let leftovers = std::fs::read_dir(std::env::temp_dir())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().starts_with("vault-chat-claude-signin-"))
            .count();
        assert_eq!(leftovers, 0, "a scratch CLAUDE_CONFIG_DIR was left behind");
    }
}
