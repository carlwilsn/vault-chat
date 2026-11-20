//! The narrow git bridge: what a sync written in the swappable bundle needs from the shell, and nothing more.
//!
//! The box sync (box_sync.rs) is moving out of Rust into the core bundle, where it changes with the bundle instead of
//! an installer. Logic stays there; the shell only runs git, the same hardened way every git command here runs
//! (run_git_timeout: no prompts, no optional index locks, its own process group, killed whole on a timeout, the
//! GitHub token in the environment for network commands), and lets a sequence hold the repo lock across several
//! calls, so a sync phase (read status, decide, add, commit) is not interleaved with the app's other git writers.
//!
//!   git_run(cwd, args, timeoutSecs?, input?, lease?)  one git process: {out, err, code}. `input` goes to its stdin.
//!                                                      `lease`: run inside that hold (no lock taken again).
//!   repo_hold(cwd, ms) -> lease                       hold cwd's repo lock (every Rust git writer waits) until
//!                                                      repo_release(lease) or `ms` (at most HOLD_MAX) pass.
//!   repo_release(lease)
//!   file_sizes(root, paths) -> [size | null]           sizes of files under root (big-file rules), one call.
//!   git_dir_write(cwd, rel, contents)                  write a file inside cwd's .git folder (info/exclude, the
//!                                                      sync's state file), which the app's file commands refuse:
//!                                                      written beside and renamed, never objects/ or refs/.
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// The longest a bundle may hold a repo lock: a hold it forgets ends by itself.
pub const HOLD_MAX: Duration = Duration::from_secs(120);

#[derive(Serialize, Debug, PartialEq)]
pub struct GitOut {
    pub out: String,
    pub err: String,
    pub code: i32,
}

struct Hold {
    key: String,
    until: Instant,
    release: Sender<()>,
}

fn holds() -> &'static Mutex<HashMap<String, Hold>> {
    static H: OnceLock<Mutex<HashMap<String, Hold>>> = OnceLock::new();
    H.get_or_init(|| Mutex::new(HashMap::new()))
}

fn new_lease() -> String {
    let mut b = [0u8; 12];
    let _ = getrandom::getrandom(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Hold `cwd`'s repo lock on a thread of its own until released or `ms` pass. Waits for the lock like any git writer.
pub fn hold(cwd: &str, ms: u64) -> Result<String, String> {
    let dur = Duration::from_millis(ms).min(HOLD_MAX);
    let lease = new_lease();
    let (tx, rx) = channel::<()>();
    let (got_tx, got_rx) = channel::<()>();
    let vault = cwd.to_string();
    let key = super::repo_key(cwd);
    let lease2 = lease.clone();
    std::thread::spawn(move || {
        super::with_repo_lock(&vault, || {
            let _ = got_tx.send(());
            match rx.recv_timeout(dur) {
                Ok(()) | Err(RecvTimeoutError::Disconnected) | Err(RecvTimeoutError::Timeout) => {}
            }
        });
        holds().lock().unwrap_or_else(|e| e.into_inner()).remove(&lease2);
    });
    // The lock is ours once the thread says so (another writer may hold it for a while first).
    got_rx.recv_timeout(super::GIT_SERIAL_WAIT).map_err(|_| "the repo stayed busy".to_string())?;
    holds().lock().unwrap_or_else(|e| e.into_inner()).insert(lease.clone(), Hold { key, until: Instant::now() + dur, release: tx });
    Ok(lease)
}

pub fn release(lease: &str) {
    if let Some(h) = holds().lock().unwrap_or_else(|e| e.into_inner()).remove(lease) {
        let _ = h.release.send(());
    }
}

/// Whether `lease` holds `cwd`'s lock now.
fn holding(lease: &str, cwd: &str) -> bool {
    let key = super::repo_key(cwd);
    holds().lock().unwrap_or_else(|e| e.into_inner()).get(lease).is_some_and(|h| h.key == key && Instant::now() < h.until)
}

/// One git process. Inside a live hold of this repo it runs at once; otherwise it is serialized like every git here.
pub fn run(cwd: &str, args: &[String], timeout_secs: Option<u64>, input: Option<&str>, lease: Option<&str>) -> Result<GitOut, String> {
    let a: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let secs = timeout_secs.unwrap_or(super::GIT_TIMEOUT_SECS).clamp(1, 3600);
    if let Some(l) = lease {
        if !holding(l, cwd) {
            return Err("that repo hold has ended".to_string());
        }
    }
    let (out, err, code) = match input {
        Some(i) => with_input(cwd, &a, i, secs)?,
        None if lease.is_some() => super::run_git_timeout_now(cwd, &a, secs)?,
        None => super::run_git_timeout(cwd, &a, secs)?,
    };
    Ok(GitOut { out, err, code })
}

/// A git process fed `input` on stdin (diff-tree --stdin, cat-file --batch-check), bounded by `secs`.
fn with_input(cwd: &str, args: &[&str], input: &str, secs: u64) -> Result<(String, String, i32), String> {
    use std::io::Write;
    let mut cmd = super::git_command(cwd, args, None, None);
    cmd.stdin(std::process::Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let pid = child.id();
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let body = input.to_string();
    // Write on a thread: git answers while it reads, and a full stdout pipe would block both.
    std::thread::spawn(move || {
        let _ = stdin.write_all(body.as_bytes());
    });
    let (tx, rx) = channel();
    std::thread::spawn(move || {
        let r = child.wait_with_output().map(|o| (String::from_utf8_lossy(&o.stdout).into_owned(), String::from_utf8_lossy(&o.stderr).into_owned(), o.status.code().unwrap_or(-1)));
        let _ = tx.send(r);
    });
    match rx.recv_timeout(Duration::from_secs(secs)) {
        Ok(r) => r.map_err(|e| e.to_string()),
        Err(_) => {
            super::kill_tree_by_pid(pid);
            Err(format!("git timed out after {secs}s: git {}", args.join(" ")))
        }
    }
}

/// Sizes of `paths` (relative to `root`), null for one that is not a file.
pub fn sizes(root: &str, paths: &[String]) -> Vec<Option<u64>> {
    paths
        .iter()
        .map(|p| {
            if p.split(['/', '\\']).any(|s| s == "..") {
                return None;
            }
            std::fs::metadata(Path::new(root).join(p)).ok().filter(|m| m.is_file()).map(|m| m.len())
        })
        .collect()
}

/// Write `contents` to `<cwd>/.git/<rel>` (beside, then renamed). Refuses `..`, absolute paths and git's own stores.
pub fn dir_write(cwd: &str, rel: &str, contents: &str) -> Result<(), String> {
    let parts: Vec<&str> = rel.split(['/', '\\']).collect();
    if rel.is_empty() || Path::new(rel).is_absolute() || parts.iter().any(|p| p.is_empty() || *p == "." || *p == "..") {
        return Err(format!("not a path inside .git: {rel}"));
    }
    if matches!(parts[0], "objects" | "refs" | "HEAD" | "index" | "config" | "packed-refs" | "hooks") {
        return Err(format!("git's own {} is not written this way", parts[0]));
    }
    let git = Path::new(cwd).join(".git");
    if !git.is_dir() {
        return Err(format!("{cwd} is not a git repository"));
    }
    let dest = git.join(rel);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = dest.with_extension("vc-tmp");
    std::fs::write(&tmp, contents).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &dest).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_dir_write(cwd: String, rel: String, contents: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || dir_write(&cwd, &rel, &contents)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_run(cwd: String, args: Vec<String>, timeout_secs: Option<u64>, input: Option<String>, lease: Option<String>) -> Result<GitOut, String> {
    tauri::async_runtime::spawn_blocking(move || run(&cwd, &args, timeout_secs, input.as_deref(), lease.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn repo_hold(cwd: String, ms: u64) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || hold(&cwd, ms)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn repo_release(lease: String) {
    release(&lease);
}

#[tauri::command]
pub async fn file_sizes(root: String, paths: Vec<String>) -> Vec<Option<u64>> {
    tauri::async_runtime::spawn_blocking(move || sizes(&root, &paths)).await.unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo(name: &str) -> String {
        let d = std::env::temp_dir().join(format!("vc-gitbridge-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let s = d.to_string_lossy().to_string();
        assert_eq!(run(&s, &["init".into(), "-q".into()], None, None, None).unwrap().code, 0);
        s
    }

    #[test]
    fn runs_git_and_feeds_its_stdin() {
        let r = repo("run");
        let v = run(&r, &["--version".into()], None, None, None).unwrap();
        assert_eq!(v.code, 0);
        assert!(v.out.starts_with("git version"), "{v:?}");
        let h = run(&r, &["hash-object".into(), "--stdin".into()], Some(30), Some("hello\n"), None).unwrap();
        assert_eq!(h.out.trim(), "ce013625030ba8dba906f756967f9e9ca394464a");
        assert_ne!(run(&r, &["no-such-subcommand".into()], None, None, None).unwrap().code, 0);
        std::fs::remove_dir_all(&r).ok();
    }

    #[test]
    fn a_hold_keeps_other_writers_out_until_released_and_ends_by_itself() {
        let r = repo("hold");
        let lease = hold(&r, 10_000).unwrap();
        // Inside the hold: runs at once.
        assert_eq!(run(&r, &["status".into(), "--porcelain".into()], None, None, Some(&lease)).unwrap().code, 0);
        // Another writer (with_repo_lock) waits for the release.
        let r2 = r.clone();
        let started = Instant::now();
        let t = std::thread::spawn(move || crate::with_repo_lock(&r2, || Instant::now()));
        std::thread::sleep(Duration::from_millis(300));
        release(&lease);
        let got = t.join().unwrap();
        assert!(got.duration_since(started) >= Duration::from_millis(250), "the writer ran inside the hold");
        // A released lease runs nothing.
        assert!(run(&r, &["status".into()], None, None, Some(&lease)).is_err());
        // A forgotten hold ends by itself.
        let l2 = hold(&r, 200).unwrap();
        std::thread::sleep(Duration::from_millis(400));
        assert!(run(&r, &["status".into()], None, None, Some(&l2)).is_err());
        crate::with_repo_lock(&r, || ());
        std::fs::remove_dir_all(&r).ok();
    }

    #[test]
    fn writes_inside_dot_git_only_where_allowed() {
        let r = repo("dirwrite");
        dir_write(&r, "info/exclude", "big.mp4\n").unwrap();
        assert_eq!(std::fs::read_to_string(Path::new(&r).join(".git/info/exclude")).unwrap(), "big.mp4\n");
        dir_write(&r, "vault-chat-box-sync.json", "{}").unwrap();
        for bad in ["../x", "info/../../x", "/etc/x", "objects/ab", "refs/heads/main", "HEAD", "config", ""] {
            assert!(dir_write(&r, bad, "x").is_err(), "{bad}");
        }
        std::fs::remove_dir_all(&r).ok();
    }

    #[test]
    fn sizes_of_files_only() {
        let r = repo("sizes");
        std::fs::write(Path::new(&r).join("a.txt"), "12345").unwrap();
        assert_eq!(sizes(&r, &["a.txt".into(), "missing".into(), ".git".into(), "../x".into()]), vec![Some(5), None, None, None]);
        std::fs::remove_dir_all(&r).ok();
    }
}
