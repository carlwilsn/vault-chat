//! Laptop side of the box sync (per-machine branches with a merge gate).
//!
//! Switched on by a committed `<vault>/.vault-chat/sync.json` that names a box:
//! `{"hub":"laptop","box":"https://thinkbox…","vault":"school2"}`. Without that
//! file nothing here runs and the old origin sync stays exactly as it was.
//!
//! The model (the shared contract):
//! - `master` is written only by this laptop; it is the only branch pushed.
//! - `box` is written only by the box; the laptop only fetches it, into
//!   `refs/remotes/box/box`.
//! - The remote is `<box>/git/<vault>.git` over HTTPS through tailscale serve.
//!   No credentials: the tailnet identity is the auth.
//! - After a fetch, `box/box` is merged into `master` ONLY if the merge is
//!   clean. On a conflict nothing is merged and no sidecar is written: the gate
//!   records `{files, since}` and stays closed, retried every cycle, so it
//!   reopens by itself once someone has resolved it.
//! - The mission zone (supervisor state, schedules, notifications, jobs and the
//!   mission/worker/ask conversations) is authored only by the box. The laptop
//!   resets it to `box/box` before every commit, and a merge conflict that sits
//!   only inside the zone resolves to the box's side.
//! - No file over 50 MB is ever committed: an untracked one goes to
//!   `.git/info/exclude`, a tracked one that grew is left unstaged. Both are
//!   reported.
//! - No nested-repo / submodule automation.
//! - Errors carry git's full stderr.
//! - GitHub backup: when the vault has a remote named `github`, a successful
//!   cycle starts a push of `master` and the fetched box branch (as `box`)
//!   there in the background, after the box push, at most every 10 minutes and
//!   only when GitHub is behind. A failure is a warning, never a gate. A
//!   backlog over 32 MB (or one whose push is cut off) goes up a few commits
//!   at a time through a scratch branch, so no upload is big enough for the
//!   connection to drop it; the status says what went wrong in one word
//!   (`github_problem`) for the app to tell in plain words.
//!
//! Speed (every git process costs ~0.15–0.2 s on Windows): the cycle reads the
//! repo's config once, the working tree once (`status --porcelain=v2`), the
//! refs once after the fetch, and pushes only when the box is behind. The
//! vault's hooks are skipped when they are only Git LFS's and LFS holds no
//! objects (its pre-push alone ran ~18 git processes, ~5 s, on every push).

use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::{
    ensure_vault_gitattributes, ensure_vault_gitignore, run_git, run_git_as,
    run_git_mut, run_git_timeout, untrack_ignored_files, with_repo_lock, APP_GIT_EMAIL, APP_GIT_NAME,
    MISSION_ZONE_PATHS,
};

/// Never auto-commit a file larger than this.
pub const BOX_MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;
/// The fetched box branch.
pub const BOX_REF: &str = "refs/remotes/box/box";
const BOX_REMOTE: &str = "box";
const GITHUB_REMOTE: &str = "github";
const GITHUB_DEBOUNCE: Duration = Duration::from_secs(600);
/// Even when the refs say the box has master, push again this often (the
/// box's copy could have been replaced behind our back).
const PUSH_VERIFY_EVERY: Duration = Duration::from_secs(300);
/// Network ops (fetch/push) get a longer leash than local git, but bounded.
const NET_TIMEOUT_SECS: u64 = 120;
const EXCLUDE_BEGIN: &str = "# >>> vault-chat: files over 50 MB, kept out of git";
const EXCLUDE_END: &str = "# <<< vault-chat";

#[derive(Clone, Debug, PartialEq)]
pub struct BoxConfig {
    /// Base URL of the box, without a trailing slash.
    pub box_url: String,
    /// The vault's name on the box (`<box>/git/<vault>.git`).
    pub vault: String,
    /// The box's display name (its hostname), when Settings wrote one.
    pub name: Option<String>,
}

impl BoxConfig {
    pub fn remote_url(&self) -> String {
        format!("{}/git/{}.git", self.box_url, self.vault)
    }
}

/// Read `<vault>/.vault-chat/sync.json`. `None` = no box: old behaviour.
pub fn box_config(vault: &str) -> Option<BoxConfig> {
    let raw = std::fs::read_to_string(PathBuf::from(vault).join(".vault-chat").join("sync.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(raw.trim_start_matches('\u{feff}')).ok()?;
    let box_url = v.get("box")?.as_str()?.trim().trim_end_matches('/').to_string();
    if box_url.is_empty() {
        return None;
    }
    let name = v
        .get("vault")
        .and_then(|x| x.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            PathBuf::from(vault)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
        })?;
    let display = v
        .get("name")
        .and_then(|x| x.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    Some(BoxConfig { box_url, vault: name, name: display })
}

/// `box_config(vault).is_some()` behind a short cache, for hot paths
/// (every conversations autosave, every commit).
static BOX_MODE_CACHE: Mutex<Option<HashMap<String, (bool, Instant)>>> = Mutex::new(None);

pub fn box_mode_cached(vault: &str) -> bool {
    let mut guard = BOX_MODE_CACHE.lock().unwrap_or_else(|p| p.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    if let Some((v, at)) = map.get(vault) {
        if at.elapsed().as_secs() < 30 {
            return *v;
        }
    }
    let v = box_config(vault).is_some();
    map.insert(vault.to_string(), (v, Instant::now()));
    v
}

// ---------- connect / disconnect (Settings → Box) ----------

fn sync_json_path(vault: &str) -> PathBuf {
    PathBuf::from(vault).join(".vault-chat").join("sync.json")
}

fn forget_box_mode(vault: &str) {
    let mut guard = BOX_MODE_CACHE.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(map) = guard.as_mut() {
        map.remove(vault);
    }
}

fn json_object(raw: Option<&str>) -> serde_json::Map<String, serde_json::Value> {
    raw.and_then(|r| serde_json::from_str::<serde_json::Value>(r.trim_start_matches('\u{feff}')).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

fn pretty(o: serde_json::Map<String, serde_json::Value>) -> String {
    serde_json::to_string_pretty(&serde_json::Value::Object(o)).unwrap_or_default() + "\n"
}

/// The box's name for a vault: `^[A-Za-z0-9._-]{1,64}$`, not starting with a dot.
pub fn valid_box_vault_name(n: &str) -> bool {
    !n.is_empty()
        && n.len() <= 64
        && !n.starts_with('.')
        && !n.ends_with(".git")
        && n.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}

/// sync.json naming this box; any other fields are kept.
pub fn sync_json_with_box(existing: Option<&str>, box_url: &str, vault: &str, name: &str) -> Result<String, String> {
    let url = box_url.trim().trim_end_matches('/');
    if !(url.starts_with("https://") || url.starts_with("http://")) || url.len() < 10 {
        return Err(format!("not a box address: {}", box_url));
    }
    if !valid_box_vault_name(vault) {
        return Err(format!("not a valid vault name for the box: {}", vault));
    }
    let mut o = json_object(existing);
    o.insert("hub".into(), "laptop".into());
    o.insert("box".into(), url.into());
    o.insert("vault".into(), vault.into());
    match name.trim() {
        "" => o.remove("name"),
        n => o.insert("name".into(), n.into()),
    };
    Ok(pretty(o))
}

/// sync.json without its box (`box`, `hub`, `name` go; the rest stays).
pub fn sync_json_without_box(existing: &str) -> String {
    let mut o = json_object(Some(existing));
    for k in ["box", "hub", "name"] {
        o.remove(k);
    }
    pretty(o)
}

/// Point this vault at a box. The next sync cycle pushes master to it.
pub fn connect_box(vault: &str, box_url: &str, vault_name: &str, name: &str) -> Result<(), String> {
    let p = sync_json_path(vault);
    let next = sync_json_with_box(std::fs::read_to_string(&p).ok().as_deref(), box_url, vault_name, name)?;
    std::fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(&p, next).map_err(|e| e.to_string())?;
    forget_box_mode(vault);
    Ok(())
}

/// Stop using the box for this vault. The box keeps its copy.
pub fn disconnect_box(vault: &str) -> Result<(), String> {
    let p = sync_json_path(vault);
    if let Ok(cur) = std::fs::read_to_string(&p) {
        std::fs::write(&p, sync_json_without_box(&cur)).map_err(|e| e.to_string())?;
    }
    forget_box_mode(vault);
    Ok(())
}

// ---------- discovery: tailnet machines that answer as a vault-chat server ----------

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct FoundBox {
    pub name: String,
    pub url: String,
    pub version: Option<String>,
    pub online: bool,
    #[serde(rename = "hasKey")]
    pub has_key: bool,
}

/// Online peers in `tailscale status --json`: (host name, `https://<DNSName>`).
pub fn online_peers(status_json: &str) -> Vec<(String, String)> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(status_json) else {
        return vec![];
    };
    let mut out = vec![];
    for p in v.get("Peer").and_then(|p| p.as_object()).into_iter().flat_map(|m| m.values()) {
        if p.get("Online").and_then(|x| x.as_bool()) != Some(true) {
            continue;
        }
        let dns = p.get("DNSName").and_then(|x| x.as_str()).unwrap_or("").trim_end_matches('.');
        if dns.is_empty() {
            continue;
        }
        let host = p
            .get("HostName")
            .and_then(|x| x.as_str())
            .filter(|h| !h.is_empty())
            .unwrap_or_else(|| dns.split('.').next().unwrap_or(dns));
        out.push((host.to_string(), format!("https://{}", dns)));
    }
    out.sort();
    out
}

/// A `/api/v1/health` body → the box, if it is a vault-chat server.
pub fn parse_health(host: &str, url: &str, body: &str) -> Option<FoundBox> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    let is_server = v.get("app").and_then(|x| x.as_str()) == Some("vault-chat-server")
        || (v.get("ok").and_then(|x| x.as_bool()) == Some(true) && v.get("version").is_some() && v.get("keys").is_some());
    if !is_server {
        return None;
    }
    Some(FoundBox {
        name: v.get("name").and_then(|x| x.as_str()).filter(|s| !s.is_empty()).unwrap_or(host).to_string(),
        url: url.to_string(),
        version: v.get("version").and_then(|x| x.as_str()).map(String::from),
        online: true,
        has_key: v
            .get("hasKey")
            .and_then(|x| x.as_bool())
            .or_else(|| v.pointer("/keys/openrouter").and_then(|x| x.as_bool()))
            .unwrap_or(false),
    })
}

/// Where the `tailscale` CLI may live: PATH, the Windows installer's folder,
/// the macOS app bundle.
const TAILSCALE_CLIS: [&str; 3] = [
    "tailscale",
    r"C:\Program Files\Tailscale\tailscale.exe",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

fn tailscale_cmd(exe: &str) -> std::process::Command {
    let mut c = std::process::Command::new(exe);
    c.args(["status", "--json"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x08000000);
    }
    c
}

fn tailscale_status() -> Result<String, String> {
    let mut last = String::new();
    for exe in TAILSCALE_CLIS {
        match tailscale_cmd(exe).output() {
            Ok(o) if o.status.success() => return Ok(String::from_utf8_lossy(&o.stdout).to_string()),
            Ok(o) => last = String::from_utf8_lossy(&o.stderr).trim().to_string(),
            Err(e) => last = e.to_string(),
        }
    }
    Err(format!("tailscale status failed: {}", last))
}

/// Is this machine on the tailnet? Asked only after a box request failed, so
/// the chip can say "Tailscale isn't connected" instead of "Box unreachable".
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct TailscaleState {
    /// The CLI ran at all. Without Tailscale installed the chip says nothing
    /// about it.
    pub installed: bool,
    /// BackendState == "Running".
    pub connected: bool,
    /// BackendState as reported ("Running", "Stopped", "NeedsLogin", …), or
    /// "NoService" when the CLI ran but its daemon didn't answer.
    pub state: String,
    /// This OS has a Tailscale app to open (Windows, macOS).
    #[serde(rename = "canOpen")]
    pub can_open: bool,
}

/// `BackendState` from `tailscale status --json`.
pub fn tailscale_backend_state(status_json: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(status_json).ok()?;
    v.get("BackendState").and_then(|x| x.as_str()).map(String::from)
}

/// One `tailscale status --json` run → the state. `ran` = the CLI spawned.
/// The CLI exits non-zero when stopped or when its service is down, so the
/// exit code is not the answer; BackendState is.
pub fn tailscale_state_of(ran: bool, stdout: &str) -> TailscaleState {
    let can_open = cfg!(any(windows, target_os = "macos"));
    if !ran {
        return TailscaleState { installed: false, connected: false, state: "NotInstalled".into(), can_open: false };
    }
    let state = tailscale_backend_state(stdout).unwrap_or_else(|| "NoService".into());
    TailscaleState { installed: true, connected: state == "Running", state, can_open }
}

pub fn tailscale_check() -> TailscaleState {
    for exe in TAILSCALE_CLIS {
        if let Ok(o) = tailscale_cmd(exe).output() {
            return tailscale_state_of(true, &String::from_utf8_lossy(&o.stdout));
        }
    }
    tailscale_state_of(false, "")
}

/// Open the Tailscale app so Carl can connect (Windows: the tray app, which
/// also starts its service; macOS: the app). Linux has no app to open.
pub fn open_tailscale() -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new(r"C:\Program Files\Tailscale\tailscale-ipn.exe")
            .creation_flags(0x00000008 | 0x00000200) // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("couldn't open Tailscale: {}", e))
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-a", "Tailscale"])
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("couldn't open Tailscale: {}", e))
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        Err("no Tailscale app to open on this OS".into())
    }
}

/// Probe every online tailnet peer's `/api/v1/health` in parallel (3 s each).
pub fn discover_boxes() -> Result<Vec<FoundBox>, String> {
    let handles: Vec<_> = online_peers(&tailscale_status()?)
        .into_iter()
        .map(|(host, url)| {
            std::thread::spawn(move || {
                let (status, body) = get_json(&format!("{}/api/v1/health", url), None, 3_000).ok()?;
                if status != 200 {
                    return None;
                }
                parse_health(&host, &url, &body)
            })
        })
        .collect();
    Ok(handles.into_iter().filter_map(|h| h.join().ok().flatten()).collect())
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct BigFile {
    pub path: String,
    pub size: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq, serde::Deserialize)]
pub struct ConflictState {
    pub files: Vec<String>,
    /// ms since the epoch when the gate first closed.
    pub since: u64,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct BoxSyncReport {
    /// sync.json names a box.
    pub configured: bool,
    /// Fetch and push both succeeded this cycle.
    pub ok: bool,
    /// What this cycle did, for the log.
    pub message: String,
    /// A local commit was made this cycle.
    pub committed: bool,
    /// box/box was merged into master this cycle.
    pub merged: bool,
    /// The files that merge changed (vault-relative): the open panes showing
    /// them reload in place (src/liveReload.ts).
    pub merged_paths: Vec<String>,
    /// The merge gate is closed by this conflict.
    pub conflict: Option<ConflictState>,
    /// Full stderr of the step that failed (fetch/push/merge), if any.
    pub error: Option<String>,
    /// "unreachable" (network / box down) or "git" (anything else).
    pub error_kind: Option<String>,
    /// Local commits the box does not have yet.
    pub changes_waiting: u32,
    /// Files kept out of git for being over 50 MB.
    pub big_files: Vec<BigFile>,
    /// GitHub backup failed (a warning, never a gate). Full stderr.
    pub github_warning: Option<String>,
    /// ms since the epoch of the last successful GitHub backup (this session).
    pub github_pushed_at: Option<u64>,
    /// What went wrong with the GitHub backup, in one word, for the plain-words status:
    /// "too_big" (the upload was cut off), "offline", "auth", "rejected" or "other".
    pub github_problem: Option<String>,
    /// Commits GitHub did not have at the last attempt.
    pub github_pending: Option<u32>,
    /// A backup is uploading now.
    pub github_uploading: bool,
    /// ms since the epoch of the next attempt, while one is failing.
    pub github_next_try_at: Option<u64>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn git_dir(vault: &str) -> PathBuf {
    // Fast path (no process spawn): an ordinary checkout.
    let dot = PathBuf::from(vault).join(".git");
    if dot.is_dir() {
        return dot;
    }
    run_git(vault, &["rev-parse", "--absolute-git-dir"])
        .ok()
        .and_then(|(o, _, c)| if c == 0 { Some(PathBuf::from(o.trim())) } else { None })
        .unwrap_or_else(|| PathBuf::from(vault).join(".git"))
}

/// Combine stdout+stderr of a failed git call into one honest message.
fn full_err(out: &str, err: &str, code: i32, what: &str) -> String {
    let mut s = format!("{} failed (exit {})", what, code);
    let err = err.trim();
    let out = out.trim();
    if !err.is_empty() {
        s.push_str(":\n");
        s.push_str(err);
    }
    if !out.is_empty() {
        s.push_str("\n");
        s.push_str(out);
    }
    s
}

/// Network failure (box asleep, off the tailnet, DNS) vs. a real git problem.
fn classify_error(stderr: &str) -> &'static str {
    let e = stderr.to_ascii_lowercase();
    let net = [
        "could not resolve host",
        "failed to connect",
        "couldn't connect",
        "connection refused",
        "connection timed out",
        "timed out",
        "operation timed out",
        "network is unreachable",
        "no route to host",
        "could not read from remote",
        "502",
        "503",
        "504",
        "does not appear to be a git repository",
        "unable to access",
    ];
    if net.iter().any(|n| e.contains(n)) {
        "unreachable"
    } else {
        "git"
    }
}

// ---------- the sync's own git: few processes, no LFS hooks when LFS is unused ----------

/// The repo's config the cycle needs, read in one process.
#[derive(Default, Debug)]
struct RepoConfig {
    values: Vec<(String, String)>,
}

impl RepoConfig {
    /// The effective value (the last one wins, as in `git config --get`).
    fn get(&self, key: &str) -> Option<&str> {
        self.values.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }
    fn all(&self, key: &str) -> Vec<&str> {
        self.values.iter().filter(|(k, _)| k == key).map(|(_, v)| v.as_str()).collect()
    }
    /// The user's real identity (what a bare `git commit` would use).
    fn identity(&self) -> (String, String) {
        let pick = |k: &str, d: &str| {
            self.get(k).map(str::trim).filter(|v| !v.is_empty()).unwrap_or(d).to_string()
        };
        (pick("user.name", APP_GIT_NAME), pick("user.email", APP_GIT_EMAIL))
    }
}

/// `git config -z --get-regexp` output: `key\nvalue\0` per entry.
fn parse_config_z(out: &str) -> RepoConfig {
    let values = out
        .split('\0')
        .filter(|r| !r.is_empty())
        .map(|r| match r.split_once('\n') {
            Some((k, v)) => (k.to_string(), v.to_string()),
            None => (r.to_string(), String::new()),
        })
        .collect();
    RepoConfig { values }
}

fn read_repo_config(vault: &str) -> RepoConfig {
    let re = r"^(remote\.(box|github)\.(url|fetch)|fetch\.recursesubmodules|submodule\.recurse|user\.(name|email)|core\.hookspath)$";
    match run_git(vault, &["config", "-z", "--get-regexp", re]) {
        Ok((o, _, 0)) => parse_config_z(&o),
        _ => RepoConfig::default(),
    }
}

/// Per vault: does any config scope set `core.hooksPath`? Unknown = yes (the
/// hooks then always run).
static HOOKS_PATH_SET: Mutex<Option<HashMap<String, bool>>> = Mutex::new(None);

fn remember_hooks_path(vault: &str, cfg: &RepoConfig) {
    let mut g = HOOKS_PATH_SET.lock().unwrap_or_else(|p| p.into_inner());
    g.get_or_insert_with(HashMap::new).insert(vault.to_string(), cfg.get("core.hookspath").is_some());
}

/// Hook body that is Git LFS's own (`git lfs post-commit "$@"` …).
fn is_lfs_hook(body: &str) -> bool {
    body.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .all(|l| l.starts_with("command -v git-lfs") || l.starts_with("git lfs ") || l.starts_with("git-lfs "))
}

/// Git LFS holds objects in this repo (then its pre-push must run: it uploads them).
fn lfs_has_objects(git_dir: &std::path::Path) -> bool {
    std::fs::read_dir(git_dir.join("lfs").join("objects"))
        .map(|mut d| d.next().is_some())
        .unwrap_or(false)
}

/// The vault's hooks may be skipped for the sync's own git: there is no
/// `core.hooksPath` anywhere, every hook in `.git/hooks` is Git LFS's, and LFS
/// stores no objects (so its pre-push has nothing to upload and its
/// post-commit/merge/checkout lock bookkeeping has no locked files). Checked
/// afresh for every call (a few file reads): a `git add` that turns a file into
/// an LFS pointer brings the hooks back before the push that needs them.
pub(crate) fn sync_hooks_skippable(vault: &str) -> bool {
    let known = {
        let g = HOOKS_PATH_SET.lock().unwrap_or_else(|p| p.into_inner());
        g.as_ref().and_then(|m| m.get(vault).copied())
    };
    if known != Some(false) {
        return false;
    }
    let gd = git_dir(vault);
    if lfs_has_objects(&gd) {
        return false;
    }
    let Ok(rd) = std::fs::read_dir(gd.join("hooks")) else {
        return false;
    };
    let mut any = false;
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.ends_with(".sample") || !e.path().is_file() {
            continue;
        }
        let Ok(body) = std::fs::read_to_string(e.path()) else {
            return false;
        };
        if !is_lfs_hook(&body) {
            return false;
        }
        any = true;
    }
    any
}

/// `args` with the hooks switched off when `sync_hooks_skippable`.
fn sync_args(vault: &str, args: &[&str]) -> Vec<String> {
    let mut v: Vec<String> = Vec::with_capacity(args.len() + 2);
    if sync_hooks_skippable(vault) {
        let none = git_dir(vault).join("vault-chat-no-hooks");
        v.push("-c".into());
        v.push(format!("core.hooksPath={}", none.to_string_lossy().replace('\\', "/")));
    }
    v.extend(args.iter().map(|s| s.to_string()));
    v
}

fn as_strs(v: &[String]) -> Vec<&str> {
    v.iter().map(String::as_str).collect()
}

/// Local git for the sync (hooks off when skippable).
fn sg(vault: &str, args: &[&str]) -> Result<(String, String, i32), String> {
    run_git(vault, &as_strs(&sync_args(vault, args)))
}

fn sg_mut(vault: &str, args: &[&str]) -> Result<(String, String, i32), String> {
    run_git_mut(vault, &as_strs(&sync_args(vault, args)))
}

fn sg_as(vault: &str, name: &str, email: &str, args: &[&str]) -> Result<(String, String, i32), String> {
    run_git_as(vault, name, email, &as_strs(&sync_args(vault, args)))
}

/// Network git for the sync (fetch/push), bounded.
fn sg_net(vault: &str, args: &[&str]) -> Result<(String, String, i32), String> {
    run_git_timeout(vault, &as_strs(&sync_args(vault, args)), NET_TIMEOUT_SECS)
}

/// One entry of `git status --porcelain=v2 -z`.
#[derive(Debug, Clone, PartialEq)]
struct StatusEntry {
    /// Index status ('.' = unchanged; '?' for untracked).
    x: char,
    path: String,
    untracked: bool,
}

#[derive(Debug, Default)]
struct WorkStatus {
    branch: Option<String>,
    entries: Vec<StatusEntry>,
}

fn parse_status_v2(out: &str) -> WorkStatus {
    let mut st = WorkStatus::default();
    let mut it = out.split('\0');
    while let Some(rec) = it.next() {
        if rec.is_empty() {
            continue;
        }
        if let Some(b) = rec.strip_prefix("# branch.head ") {
            st.branch = Some(b.to_string()).filter(|b| b != "(detached)");
            continue;
        }
        let (kind, fields) = match rec.as_bytes()[0] {
            b'1' => ('1', 9),
            b'2' => ('2', 10),
            b'u' => ('u', 11),
            b'?' => ('?', 0),
            _ => continue,
        };
        if kind == '?' {
            st.entries.push(StatusEntry { x: '?', path: rec[2..].to_string(), untracked: true });
            continue;
        }
        let parts: Vec<&str> = rec.splitn(fields, ' ').collect();
        if parts.len() < fields {
            continue;
        }
        let x = parts[1].chars().next().unwrap_or('.');
        st.entries.push(StatusEntry { x, path: parts[fields - 1].to_string(), untracked: false });
        if kind == '2' {
            // A rename/copy: its original path follows as its own field.
            let _ = it.next();
        }
    }
    st
}

/// The working tree in one process (with the branch, every untracked file).
fn read_status(vault: &str) -> Result<WorkStatus, String> {
    let (o, e, c) = sg(
        vault,
        &["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--ignore-submodules=dirty"],
    )?;
    if c != 0 {
        return Err(full_err(&o, &e, c, "git status"));
    }
    Ok(parse_status_v2(&o))
}

/// The refs a cycle compares, read in one process after the fetch.
#[derive(Debug, Default, Clone)]
struct Refs {
    master: Option<String>,
    box_box: Option<String>,
    box_master: Option<String>,
    github_master: Option<String>,
    github_box: Option<String>,
}

fn read_refs(vault: &str) -> Refs {
    let mut r = Refs::default();
    if let Ok((o, _, 0)) = run_git(
        vault,
        &[
            "for-each-ref",
            "--format=%(objectname) %(refname)",
            "refs/heads/master",
            BOX_REF,
            "refs/remotes/box/master",
            "refs/remotes/github/master",
            "refs/remotes/github/box",
        ],
    ) {
        for l in o.lines() {
            let Some((oid, name)) = l.trim().split_once(' ') else { continue };
            let oid = Some(oid.to_string());
            match name {
                "refs/heads/master" => r.master = oid,
                "refs/remotes/box/box" => r.box_box = oid,
                "refs/remotes/box/master" => r.box_master = oid,
                "refs/remotes/github/master" => r.github_master = oid,
                "refs/remotes/github/box" => r.github_box = oid,
                _ => {}
            }
        }
    }
    r
}

/// HEAD's branch from `.git/HEAD` (no process); `None` = detached or unknown.
fn head_branch_fs(vault: &str) -> Option<String> {
    let head = std::fs::read_to_string(git_dir(vault).join("HEAD")).ok()?;
    head.trim().strip_prefix("ref: refs/heads/").map(String::from)
}

// ---------- persisted machine-local state (.git/vault-chat-box-sync.json) ----------

#[derive(Serialize, serde::Deserialize, Default)]
struct PersistedState {
    conflict: Option<ConflictState>,
}

fn state_path(vault: &str) -> PathBuf {
    git_dir(vault).join("vault-chat-box-sync.json")
}

fn load_state(vault: &str) -> PersistedState {
    std::fs::read_to_string(state_path(vault))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_state(vault: &str, st: &PersistedState) {
    if let Ok(s) = serde_json::to_string(st) {
        let _ = std::fs::write(state_path(vault), s);
    }
}

// ---------- remote setup ----------

/// Make remote `box` point at the box's git URL and fetch only the `box`
/// branch. Idempotent.
fn ensure_box_remote(vault: &str, cfg: &BoxConfig, rc: &RepoConfig) -> Result<(), String> {
    let url = cfg.remote_url();
    match rc.get("remote.box.url") {
        None => {
            let (o, e, c) = run_git(vault, &["remote", "add", BOX_REMOTE, &url])?;
            if c != 0 {
                return Err(full_err(&o, &e, c, "git remote add box"));
            }
        }
        Some(cur) if cur.trim() != url => {
            let (o, e, c) = run_git(vault, &["remote", "set-url", BOX_REMOTE, &url])?;
            if c != 0 {
                return Err(full_err(&o, &e, c, "git remote set-url box"));
            }
        }
        _ => {}
    }
    let want = format!("+refs/heads/box:{}", BOX_REF);
    if rc.all("remote.box.fetch") != vec![want.as_str()] {
        let _ = run_git(vault, &["config", "--replace-all", "remote.box.fetch", &want]);
    }
    Ok(())
}

/// Index state that decides whether the tracked-but-ignored sweep can find
/// anything new: the root ignore rules, `.git/info/exclude`, and the index
/// file itself (any add/commit/merge rewrites it).
fn untrack_key(vault: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    std::fs::read(PathBuf::from(vault).join(".gitignore")).unwrap_or_default().hash(&mut h);
    let gd = git_dir(vault);
    std::fs::read(gd.join("info").join("exclude")).unwrap_or_default().hash(&mut h);
    if let Ok(m) = std::fs::metadata(gd.join("index")) {
        m.len().hash(&mut h);
        m.modified().ok().hash(&mut h);
    }
    format!("{:x}", h.finish())
}

static UNTRACK_SEEN: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

/// `prepare_vault_repo` for the box cycle, from the config already read: the
/// managed `.gitattributes`/`.gitignore` (file reads), submodule recursion off
/// (a write only when it isn't), and the tracked-but-ignored sweep only when
/// the ignore rules or the index changed since it last ran in this process.
fn prepare_box_repo(vault: &str, rc: &RepoConfig) {
    ensure_vault_gitattributes(vault);
    ensure_vault_gitignore(vault);
    for key in ["fetch.recurseSubmodules", "submodule.recurse"] {
        if rc.get(&key.to_ascii_lowercase()).map(str::trim) != Some("false") {
            let _ = run_git_mut(vault, &["config", key, "false"]);
        }
    }
    let key = untrack_key(vault);
    let seen = {
        let g = UNTRACK_SEEN.lock().unwrap_or_else(|p| p.into_inner());
        g.as_ref().and_then(|m| m.get(vault).cloned())
    };
    if seen.as_deref() != Some(key.as_str()) {
        untrack_ignored_files(vault);
        // Keyed after the sweep (its `rm --cached` rewrites the index).
        let mut g = UNTRACK_SEEN.lock().unwrap_or_else(|p| p.into_inner());
        g.get_or_insert_with(HashMap::new).insert(vault.to_string(), untrack_key(vault));
    }
}

// ---------- mission zone ----------

fn path_in_zone_dirs(path: &str) -> bool {
    MISSION_ZONE_PATHS
        .iter()
        .any(|z| path == *z || path.starts_with(&format!("{}/", z)))
}

/// Is `rel` a mission-zone path? (The conversations are not: in box mode they
/// are the box's event log, never synced by git — see NEVER_STAGED.)
fn is_zone_path(_vault: &str, rel: &str, _authority: &str) -> bool {
    path_in_zone_dirs(rel)
}

/// Never committed from this laptop in box mode: the box's conversation log
/// (`.vault-chat/events/`, never even present here) and the conversation files
/// from before it (kept as they are, never staged, never deleted). Conversations
/// reach the laptop through the box's /poll, not through git.
pub const NEVER_STAGED: [&str; 2] = [".vault-chat/conversations", ".vault-chat/events"];

/// `.git/info/exclude` holds `line` (outside the managed block).
fn ensure_exclude_line(vault: &str, line: &str) {
    let file = git_dir(vault).join("info").join("exclude");
    let cur = std::fs::read_to_string(&file).unwrap_or_default();
    if cur.lines().any(|l| l == line) {
        return;
    }
    let mut next = cur.clone();
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str(line);
    next.push('\n');
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&file, next);
}

/// Reset every mission-zone path that differs from `authority` (box/box) back
/// to the authority's version, in index and working tree. The follower
/// sanitize, with the box as the authority. Only paths the authority has are
/// touched; a zone path the box has never had is left alone.
pub fn sanitize_zone_to(vault: &str, authority: &str) -> Vec<String> {
    // (A missing authority makes the diff fail: nothing to reset.)
    let (out, _, c) = match run_git(
        vault,
        &["diff", "--no-renames", "--name-status", "-z", authority, "--", ".vault-chat"],
    ) {
        Ok(r) => r,
        Err(_) => return vec![],
    };
    if c != 0 {
        return vec![];
    }
    let mut it = out.split('\0');
    let mut reset: Vec<String> = Vec::new();
    while let Some(status) = it.next() {
        if status.is_empty() {
            break;
        }
        let Some(path) = it.next() else { break };
        // "A" = exists here but not in the authority: nothing to restore from.
        if status.starts_with('A') {
            continue;
        }
        if is_zone_path(vault, path, authority) {
            reset.push(path.to_string());
        }
    }
    for chunk in reset.chunks(50) {
        let mut args: Vec<&str> = vec!["checkout", authority, "--"];
        args.extend(chunk.iter().map(|s| s.as_str()));
        let _ = sg_mut(vault, &args);
    }
    reset
}

// ---------- files over 50 MB ----------

fn escape_exclude(path: &str) -> String {
    let mut s = String::from("/");
    for ch in path.chars() {
        if matches!(ch, '*' | '?' | '[' | '\\' | ' ' | '!' | '#') {
            s.push('\\');
        }
        s.push(ch);
    }
    s
}

fn file_size(vault: &str, rel: &str) -> Option<u64> {
    std::fs::metadata(PathBuf::from(vault).join(rel))
        .ok()
        .filter(|m| m.is_file())
        .map(|m| m.len())
}

/// Rewrite the managed block of `.git/info/exclude` to exactly `paths`.
fn write_exclude_block(vault: &str, paths: &[String]) {
    let file = git_dir(vault).join("info").join("exclude");
    let cur = std::fs::read_to_string(&file).unwrap_or_default();
    let mut kept: Vec<&str> = Vec::new();
    let mut inside = false;
    for l in cur.lines() {
        if l == EXCLUDE_BEGIN {
            inside = true;
            continue;
        }
        if inside {
            if l == EXCLUDE_END {
                inside = false;
            }
            continue;
        }
        kept.push(l);
    }
    let mut next = kept.join("\n");
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    if !paths.is_empty() {
        next.push_str(EXCLUDE_BEGIN);
        next.push('\n');
        for p in paths {
            next.push_str(&escape_exclude(p));
            next.push('\n');
        }
        next.push_str(EXCLUDE_END);
        next.push('\n');
    }
    if next != cur {
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&file, next);
    }
}

fn read_exclude_block(vault: &str) -> Vec<String> {
    let cur = std::fs::read_to_string(git_dir(vault).join("info").join("exclude")).unwrap_or_default();
    let mut out = Vec::new();
    let mut inside = false;
    for l in cur.lines() {
        if l == EXCLUDE_BEGIN {
            inside = true;
            continue;
        }
        if inside {
            if l == EXCLUDE_END {
                break;
            }
            // Undo escape_exclude: drop the leading "/" and the backslashes.
            let mut p = String::new();
            let mut esc = false;
            for ch in l.trim_start_matches('/').chars() {
                if !esc && ch == '\\' {
                    esc = true;
                    continue;
                }
                esc = false;
                p.push(ch);
            }
            out.push(p);
        }
    }
    out
}

fn is_big(vault: &str, rel: &str) -> bool {
    file_size(vault, rel).map(|s| s > BOX_MAX_FILE_BYTES).unwrap_or(false)
}

fn never_staged(path: &str) -> bool {
    NEVER_STAGED.iter().any(|n| path == *n || path.starts_with(&format!("{}/", n)))
}

/// Stage everything a box-mode commit may carry, from one `git status`:
/// mission zone reset to the box, untracked files over 50 MB kept out via
/// `.git/info/exclude` (entries whose file is gone or shrank are dropped
/// again), a tracked file that grew past 50 MB left unstaged, the
/// conversations never staged. Caller holds the repo lock. Returns the big
/// files and whether anything was staged.
fn stage_from_status(vault: &str, st: &WorkStatus, name: &str, email: &str) -> Result<(Vec<BigFile>, bool), String> {
    let zone_reset = sanitize_zone_to(vault, BOX_REF);
    ensure_exclude_line(vault, "/.vault-chat/events/");
    // Untracked files over 50 MB → the managed exclude block.
    let mut excluded: Vec<String> = read_exclude_block(vault).into_iter().filter(|p| is_big(vault, p)).collect();
    for e in st.entries.iter().filter(|e| e.untracked) {
        if is_big(vault, &e.path) && !excluded.iter().any(|b| b == &e.path) {
            excluded.push(e.path.clone());
        }
    }
    excluded.sort();
    write_exclude_block(vault, &excluded);
    let mut big: Vec<BigFile> = excluded
        .iter()
        .map(|p| BigFile { path: p.clone(), size: file_size(vault, p).unwrap_or(0) })
        .collect();
    // Tracked files that grew past 50 MB: staged by `add -A`, unstaged again.
    let mut unstage: Vec<String> = Vec::new();
    for e in st.entries.iter().filter(|e| !e.untracked) {
        if let Some(sz) = file_size(vault, &e.path).filter(|s| *s > BOX_MAX_FILE_BYTES) {
            unstage.push(e.path.clone());
            if !big.iter().any(|b| b.path == e.path) {
                big.push(BigFile { path: e.path.clone(), size: sz });
            }
        }
    }
    let stageable = st
        .entries
        .iter()
        .any(|e| !never_staged(&e.path) && !excluded.contains(&e.path) && !unstage.contains(&e.path));
    if stageable {
        let (o, e, c) = sg_as(vault, name, email, &["add", "-A"])?;
        if c != 0 {
            return Err(full_err(&o, &e, c, "git add -A"));
        }
    }
    // The conversations never go through git in box mode: whatever `add -A`
    // (or anyone before it) staged there is unstaged again, with the big
    // files, in one reset — run only when there is something to undo.
    let mut reset: Vec<&str> = vec!["reset", "-q", "--"];
    if st
        .entries
        .iter()
        .any(|e| never_staged(&e.path) && (stageable || (!e.untracked && e.x != '.')))
    {
        reset.extend(NEVER_STAGED.iter().copied());
    }
    reset.extend(unstage.iter().map(String::as_str));
    if reset.len() > 3 {
        let _ = sg_mut(vault, &reset);
    }
    Ok((big, stageable || !zone_reset.is_empty()))
}

/// Stage everything a box-mode commit may carry: mission zone reset to the
/// box, nothing over 50 MB. Caller holds the repo lock. Returns the big files.
pub fn box_stage_all(vault: &str, name: &str, email: &str) -> Result<Vec<BigFile>, String> {
    let st = read_status(vault)?;
    stage_from_status(vault, &st, name, email).map(|(big, _)| big)
}

fn merge_in_progress(vault: &str) -> bool {
    git_dir(vault).join("MERGE_HEAD").exists()
}

fn worktree_dirty(vault: &str) -> bool {
    sg(vault, &["status", "--porcelain", "--ignore-submodules=dirty"])
        .map(|(s, _, _)| !s.trim().is_empty())
        .unwrap_or(false)
}

/// "Nothing to commit" from `git commit` (the status said dirty, the staged
/// tree came out equal to HEAD): not an error, just no commit.
fn nothing_to_commit(out: &str, err: &str) -> bool {
    let t = format!("{}
{}", out, err);
    t.contains("nothing to commit") || t.contains("nothing added to commit") || t.contains("no changes added to commit")
}

/// Commit local edits on master (no nested repos). Caller holds the lock.
/// Steady state: nothing changed and no big file to re-check → done after one
/// `git status` (every spawn costs ~0.15–0.2 s on Windows).
fn commit_local(vault: &str, rc: &RepoConfig) -> Result<(bool, Vec<BigFile>), String> {
    let st = read_status(vault)?;
    if st.entries.is_empty() && read_exclude_block(vault).is_empty() {
        return Ok((false, vec![]));
    }
    let (hn, he) = rc.identity();
    let (big, staged) = stage_from_status(vault, &st, &hn, &he)?;
    if !staged {
        return Ok((false, big));
    }
    let (o, e, c) = sg_as(vault, &hn, &he, &["commit", "-q", "--no-verify", "-m", "vault-chat: sync"])?;
    if c != 0 {
        if nothing_to_commit(&o, &e) {
            return Ok((false, big));
        }
        return Err(full_err(&o, &e, c, "git commit"));
    }
    Ok((true, big))
}

enum Gate {
    UpToDate,
    Merged,
    Conflict(Vec<String>),
}

/// Per vault: the last (box/box, master) pair known to need no merge (box/box
/// is an ancestor of master), so an idle cycle asks git nothing.
static UP_TO_DATE: Mutex<Option<HashMap<String, (String, String)>>> = Mutex::new(None);

/// The merge gate. Caller holds the lock and has committed local edits.
/// `refs` were read after those commits.
fn merge_gate(vault: &str, rc: &RepoConfig, refs: &Refs) -> Result<Gate, String> {
    let Some(boxo) = refs.box_box.clone() else {
        return Ok(Gate::UpToDate);
    };
    let head = refs.master.clone().unwrap_or_default();
    let pair = (boxo.clone(), head.clone());
    let known = {
        let g = UP_TO_DATE.lock().unwrap_or_else(|p| p.into_inner());
        g.as_ref().and_then(|m| m.get(vault).cloned())
    };
    if boxo == head || known.as_ref() == Some(&pair) {
        return Ok(Gate::UpToDate);
    }
    if matches!(sg(vault, &["merge-base", "--is-ancestor", BOX_REF, "HEAD"]), Ok((_, _, 0))) {
        let mut g = UP_TO_DATE.lock().unwrap_or_else(|p| p.into_inner());
        g.get_or_insert_with(HashMap::new).insert(vault.to_string(), pair);
        return Ok(Gate::UpToDate);
    }
    // Dry run first: `merge-tree --write-tree` merges in memory and touches
    // neither the index nor the working tree. Exit 0 = clean, 1 = conflicts.
    let (out, err, code) = sg(
        vault,
        &["merge-tree", "--write-tree", "--name-only", "--no-messages", "HEAD", BOX_REF],
    )?;
    let conflicted: Vec<String> = match code {
        0 => vec![],
        1 => {
            let mut v: Vec<String> = out
                .lines()
                .skip(1)
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .map(String::from)
                .collect();
            v.dedup();
            v
        }
        _ => return Err(full_err(&out, &err, code, "git merge-tree")),
    };
    let zone_only = !conflicted.is_empty() && conflicted.iter().all(|p| is_zone_path(vault, p, BOX_REF));
    if !conflicted.is_empty() && !zone_only {
        return Ok(Gate::Conflict(conflicted));
    }
    // Clean (or only the box's own zone): merge for real, in place. A file
    // edited since our commit would block it, so commit again first.
    if worktree_dirty(vault) {
        commit_local(vault, rc)?;
    }
    let (hn, he) = rc.identity();
    let (o, e, c) = sg_as(
        vault,
        &hn,
        &he,
        &["merge", "--no-edit", "--no-verify", "-m", "vault-chat: merge box", BOX_REF],
    )?;
    if c == 0 {
        return Ok(Gate::Merged);
    }
    if zone_only && merge_in_progress(vault) {
        // The mission zone is the box's: take its side of every conflict.
        let (u, _, _) = sg(vault, &["ls-files", "-u", "-z"])?;
        let mut unmerged: Vec<(String, bool)> = Vec::new();
        for rec in u.split('\0').filter(|r| !r.is_empty()) {
            // "<mode> <sha> <stage>\t<path>"
            if let Some((meta, path)) = rec.split_once('\t') {
                let stage3 = meta.split_whitespace().nth(2) == Some("3");
                match unmerged.iter_mut().find(|(p, _)| p == path) {
                    Some(e) => e.1 |= stage3,
                    None => unmerged.push((path.to_string(), stage3)),
                }
            }
        }
        let all_zone = unmerged.iter().all(|(p, _)| is_zone_path(vault, p, BOX_REF));
        if all_zone {
            for (p, theirs) in &unmerged {
                if *theirs {
                    let _ = sg_mut(vault, &["checkout", "--theirs", "--", p]);
                    let _ = sg_mut(vault, &["add", "--", p]);
                } else {
                    let _ = sg_mut(vault, &["rm", "-q", "--", p]);
                }
            }
            let (o2, e2, c2) = sg_as(vault, &hn, &he, &["commit", "-q", "--no-edit", "--no-verify"])?;
            if c2 == 0 {
                return Ok(Gate::Merged);
            }
            let _ = sg_mut(vault, &["merge", "--abort"]);
            return Err(full_err(&o2, &e2, c2, "git commit (merge box, mission zone)"));
        }
    }
    // Anything else: leave master exactly as it was.
    if merge_in_progress(vault) {
        let _ = sg_mut(vault, &["merge", "--abort"]);
    }
    Err(full_err(&o, &e, c, "git merge box/box"))
}

/// What the merge just made changed: `git merge` left the pre-merge HEAD in ORIG_HEAD.
fn merged_paths(vault: &str) -> Vec<String> {
    match run_git(vault, &["-c", "core.quotePath=false", "diff", "--name-only", "ORIG_HEAD", "HEAD"]) {
        Ok((o, _, 0)) => o.lines().map(str::trim).filter(|l| !l.is_empty()).map(String::from).collect(),
        _ => Vec::new(),
    }
}

fn changes_waiting(vault: &str) -> u32 {
    run_git(vault, &["rev-list", "--count", "HEAD", "--not", "--remotes=box"])
        .ok()
        .filter(|(_, _, c)| *c == 0)
        .and_then(|(o, _, _)| o.trim().parse().ok())
        .unwrap_or(0)
}

#[derive(Clone)]
struct GithubState {
    attempted: Option<Instant>,
    pushed_at: Option<u64>,
    warning: Option<String>,
    problem: Option<&'static str>,
    pending: Option<u32>,
    running: bool,
    /// Bytes (uncompressed, of the files the commits add) one upload may carry: halved
    /// when an upload is cut off, back up after a backup that went through.
    step_budget: u64,
}

impl Default for GithubState {
    fn default() -> Self {
        GithubState {
            attempted: None,
            pushed_at: None,
            warning: None,
            problem: None,
            pending: None,
            running: false,
            step_budget: GITHUB_STEP_BYTES,
        }
    }
}

static GITHUB_LAST: Mutex<Option<HashMap<String, GithubState>>> = Mutex::new(None);

/// One upload to GitHub carries at most about this much (the files its commits add,
/// uncompressed: a board's text deltas to far less, a binary does not). One push of
/// 129 commits (212 MB packed, most of it 121 .tar.gz backups) was cut off by the
/// connection every time ("RPC failed; curl 55 … Connection was aborted").
pub const GITHUB_STEP_BYTES: u64 = 32 * 1024 * 1024;
/// The branch the steps go to on GitHub (deleted once master and box are up).
const GITHUB_UPLOAD_BRANCH: &str = "vault-chat-upload";
/// An upload step may take this long (it runs off the sync's path).
const GITHUB_STEP_TIMEOUT_SECS: u64 = 600;

/// What a failed push to GitHub means, for the plain-words status.
pub fn github_problem(stderr: &str) -> &'static str {
    let e = stderr.to_ascii_lowercase();
    let has = |xs: &[&str]| xs.iter().any(|x| e.contains(x));
    if has(&["could not resolve host", "failed to connect", "couldn't connect", "network is unreachable", "no route to host", "connection refused"]) {
        "offline"
    } else if has(&["authentication failed", "could not read username", "could not read password", "permission denied", "the requested url returned error: 403", "repository not found"]) {
        "auth"
    } else if has(&["[rejected]", "non-fast-forward", "fetch first"]) {
        "rejected"
    } else if has(&[
        "rpc failed",
        "remote end hung up",
        "send failure",
        "connection was aborted",
        "connection was reset",
        "connection reset",
        "early eof",
        "pack exceeds maximum allowed size",
        "unpacker error",
        "unpack failed",
        "returned error: 413",
        "returned error: 500",
        "returned error: 502",
        "returned error: 503",
        "returned error: 504",
        "git timed out after",
        "timed out",
    ]) {
        "too_big"
    } else {
        "other"
    }
}

/// Run git with `input` on stdin (local, read-only plumbing: no network, no token).
fn git_with_input(vault: &str, args: &[&str], input: &str) -> Result<String, String> {
    use std::io::Write;
    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let mut c = std::process::Command::new("git");
        c.creation_flags(0x08000000);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = std::process::Command::new("git");
    cmd.current_dir(vault)
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let body = input.to_string();
    // Write on a thread: git answers while it reads, and a full stdout pipe would block both.
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(body.as_bytes());
    });
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let _ = writer.join();
    if !out.status.success() {
        return Err(format!("git {} failed: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The commits GitHub lacks, oldest first (each after its parents), with the bytes of
/// the files each one adds. "Lacks" = not reachable from any `refs/remotes/github/*`
/// (what the last pushes and fetches left; a push negotiates the rest).
fn github_missing(vault: &str, with_box: bool) -> Result<Vec<(String, u64)>, String> {
    let mut args = vec!["rev-list", "--reverse", "--topo-order", "refs/heads/master"];
    if with_box {
        args.push(BOX_REF);
    }
    args.extend(["--not", "--remotes=github"]);
    let commits: Vec<String> = match sg(vault, &args)? {
        (o, _, 0) => o.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect(),
        (o, e, c) => return Err(full_err(&o, &e, c, "git rev-list")),
    };
    if commits.is_empty() {
        return Ok(vec![]);
    }
    // The blobs each commit adds (a merge adds none of its own: its sides come first).
    let raw = git_with_input(vault, &["diff-tree", "--stdin", "-r", "--root", "--no-renames", "--no-abbrev"], &(commits.join("\n") + "\n"))?;
    let mut added: HashMap<String, Vec<String>> = HashMap::new();
    let mut cur = String::new();
    for l in raw.lines() {
        if let Some(rest) = l.strip_prefix(':') {
            let f: Vec<&str> = rest.split_whitespace().collect();
            if f.len() >= 4 && f[3].chars().any(|c| c != '0') {
                added.entry(cur.clone()).or_default().push(f[3].to_string());
            }
        } else if !l.trim().is_empty() {
            cur = l.trim().to_string();
        }
    }
    let mut blobs: Vec<String> = added.values().flatten().cloned().collect();
    blobs.sort();
    blobs.dedup();
    let mut size: HashMap<String, u64> = HashMap::new();
    if !blobs.is_empty() {
        let out = git_with_input(vault, &["cat-file", "--batch-check=%(objectname) %(objectsize)"], &(blobs.join("\n") + "\n"))?;
        for l in out.lines() {
            if let Some((id, n)) = l.split_once(' ') {
                size.insert(id.to_string(), n.trim().parse().unwrap_or(0));
            }
        }
    }
    let mut seen = std::collections::HashSet::new();
    Ok(commits
        .into_iter()
        .map(|c| {
            let bytes = added
                .get(&c)
                .map(|bs| bs.iter().filter(|b| seen.insert((*b).clone())).map(|b| size.get(b).copied().unwrap_or(0)).sum())
                .unwrap_or(0);
            (c, bytes)
        })
        .collect())
}

/// Cut `missing` into upload steps of at most `budget` bytes (a commit bigger than
/// that is a step of its own). Returns the last commit of each step.
pub fn github_steps(missing: &[(String, u64)], budget: u64) -> Vec<String> {
    let mut steps = Vec::new();
    let mut acc = 0u64;
    for (i, (c, n)) in missing.iter().enumerate() {
        if acc > 0 && acc + n > budget {
            steps.push(missing[i - 1].0.clone());
            acc = 0;
        }
        acc += n;
        if i + 1 == missing.len() {
            steps.push(c.clone());
        }
    }
    steps
}

/// Push to GitHub, bounded, with full stderr on failure.
fn github_push(vault: &str, args: &[&str], what: &str) -> Result<(), String> {
    match run_git_timeout(vault, &as_strs(&sync_args(vault, args)), GITHUB_STEP_TIMEOUT_SECS) {
        Ok((_, _, 0)) => Ok(()),
        Ok((o, e, c)) => Err(full_err(&o, &e, c, what)),
        Err(e) => Err(format!("{} failed: {}", what, e)),
    }
}

/// One backup. What GitHub lacks goes up in one push when it is under `budget` bytes;
/// otherwise (or when that push is cut off) in steps of at most `budget` bytes to a
/// scratch branch (a step that is cut off is retried at once with half of what it
/// carried), then master and box, then the scratch branch is deleted.
/// Ok(the budget for next time) / Err((full stderr, the budget for next time)).
fn github_upload(vault: &str, first: bool, budget: u64, pending: &mut Option<u32>) -> Result<u64, (String, u64)> {
    let refs = read_refs(vault);
    let current = !first
        && refs.master.is_some()
        && refs.github_master == refs.master
        && (refs.box_box.is_none() || refs.github_box == refs.box_box);
    if current {
        *pending = Some(0);
        return Ok(budget);
    }
    let with_box = refs.box_box.is_some();
    let mut budget = budget;
    let missing = github_missing(vault, with_box).map_err(|e| (e, budget))?;
    *pending = Some(missing.len() as u32);
    let total: u64 = missing.iter().map(|m| m.1).sum();
    let box_spec = format!("{}:refs/heads/box", BOX_REF);
    let mut args: Vec<&str> = vec!["push", "--porcelain", GITHUB_REMOTE, "refs/heads/master:refs/heads/master"];
    if with_box {
        args.push(&box_spec);
    }
    let push_refs = || github_push(vault, &args, "GitHub backup (git push github)");
    // Small enough for one upload: try that first; cut off, it goes up in steps.
    let mut stepped = total > budget;
    if !stepped {
        match push_refs() {
            Ok(()) => {}
            Err(e) if github_problem(&e) == "too_big" && missing.len() > 1 => {
                budget = (total / 2).max(1);
                stepped = true;
            }
            Err(e) => return Err((e, budget)),
        }
    }
    if stepped {
        let upload_spec = |c: &str| format!("+{}:refs/heads/{}", c, GITHUB_UPLOAD_BRANCH);
        let mut done = 0usize; // commits of `missing` already up
        let mut tries = 0;
        while done < missing.len() {
            tries += 1;
            let steps = github_steps(&missing[done..], budget);
            let target = steps[0].clone();
            let spec = upload_spec(&target);
            match github_push(vault, &["push", "--porcelain", GITHUB_REMOTE, &spec], "GitHub backup (git push github, one step)") {
                Ok(()) => {
                    done += missing[done..].iter().position(|m| m.0 == target).map(|p| p + 1).unwrap_or(missing.len() - done);
                    *pending = Some((missing.len() - done) as u32);
                }
                Err(e) => {
                    let n = missing[done..].iter().position(|m| m.0 == target).map(|p| p + 1).unwrap_or(1);
                    // Cut off: try again at once with half of what that step carried, down to one commit a step.
                    if github_problem(&e) == "too_big" && n > 1 && tries < 40 {
                        let carried: u64 = missing[done..done + n].iter().map(|m| m.1).sum();
                        budget = (carried / 2).max(1);
                        continue;
                    }
                    let one = missing[done].1;
                    let e = if n == 1 && github_problem(&e) == "too_big" {
                        format!("{}\n\n(one change alone adds {} MB)", e, one / (1024 * 1024))
                    } else {
                        e
                    };
                    return Err((e, budget.max(1)));
                }
            }
        }
        push_refs().map_err(|e| (e, budget))?;
    }
    *pending = Some(0);
    // The scratch branch, if a backup made one.
    let scratch = format!("refs/remotes/{}/{}", GITHUB_REMOTE, GITHUB_UPLOAD_BRANCH);
    if matches!(sg(vault, &["rev-parse", "--verify", "-q", &scratch]), Ok((_, _, 0))) {
        let del = format!(":refs/heads/{}", GITHUB_UPLOAD_BRANCH);
        let _ = github_push(vault, &["push", "--porcelain", GITHUB_REMOTE, &del], "GitHub backup (delete the upload branch)");
    }
    Ok((budget.saturating_mul(2)).min(GITHUB_STEP_BYTES))
}

/// Back up master + the box branch to the `github` remote, off the critical
/// path: started after the box push, run on its own thread, at most every 10
/// minutes (attempts too, so a failing backup doesn't retry every cycle), and
/// a push only when GitHub's refs are behind (the first backup in a session
/// always pushes). A backlog goes up a few commits at a time (`github_upload`),
/// so no single upload is big enough for the connection to cut it off. Every
/// cycle reports the last outcome, so a failure stays visible until a push
/// succeeds; it is retried on its own.
fn github_backup(vault: &str, rc: &RepoConfig, report: &mut BoxSyncReport) {
    if rc.get("remote.github.url").is_none() {
        return;
    }
    let (first, budget) = {
        let mut g = GITHUB_LAST.lock().unwrap_or_else(|p| p.into_inner());
        let st = g.get_or_insert_with(HashMap::new).entry(vault.to_string()).or_default();
        report.github_pushed_at = st.pushed_at;
        report.github_warning = st.warning.clone();
        report.github_problem = st.problem.map(str::to_string);
        report.github_pending = st.pending;
        report.github_uploading = st.running;
        if st.warning.is_some() {
            report.github_next_try_at = st.attempted.map(|a| {
                now_ms() + GITHUB_DEBOUNCE.saturating_sub(a.elapsed()).as_millis() as u64
            });
        }
        if st.running || st.attempted.map(|a| a.elapsed() < GITHUB_DEBOUNCE).unwrap_or(false) {
            return;
        }
        let first = st.attempted.is_none();
        st.running = true;
        st.attempted = Some(Instant::now());
        (first, st.step_budget)
    };
    report.github_uploading = true;
    let v = vault.to_string();
    std::thread::spawn(move || {
        let mut pending = None;
        let outcome = github_upload(&v, first, budget, &mut pending);
        let mut g = GITHUB_LAST.lock().unwrap_or_else(|p| p.into_inner());
        let st = g.get_or_insert_with(HashMap::new).entry(v).or_default();
        st.running = false;
        st.pending = pending.or(st.pending);
        match outcome {
            Ok(b) => {
                st.pushed_at = Some(now_ms());
                st.warning = None;
                st.problem = None;
                st.step_budget = b;
            }
            Err((w, b)) => {
                st.problem = Some(github_problem(&w));
                st.warning = Some(w);
                st.step_budget = b;
            }
        }
    });
}

/// Tests: wait until no GitHub backup is running for `vault`.
#[cfg(test)]
pub(crate) fn wait_github_backup(vault: &str) {
    let end = Instant::now() + Duration::from_secs(120);
    while Instant::now() < end {
        let running = {
            let g = GITHUB_LAST.lock().unwrap_or_else(|p| p.into_inner());
            g.as_ref().and_then(|m| m.get(vault)).map(|s| s.running).unwrap_or(false)
        };
        if !running {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// When this process last pushed master to the box (per vault).
static LAST_PUSH: Mutex<Option<HashMap<String, Instant>>> = Mutex::new(None);

/// One full sync cycle. Blocking; call from a worker thread.
pub fn box_sync_cycle(vault: &str) -> BoxSyncReport {
    cycle(vault, true)
}

/// The box just published an edit (`vault_changed` on /poll): commit, fetch,
/// merge — and stop there. The pushes (box, GitHub) wait for the next full
/// cycle, so the box's edit lands on this disk seconds sooner.
pub fn box_pull_cycle(vault: &str) -> BoxSyncReport {
    cycle(vault, false)
}

fn cycle(vault: &str, push: bool) -> BoxSyncReport {
    let mut r = BoxSyncReport::default();
    let Some(cfg) = box_config(vault) else {
        r.message = "no box configured".into();
        return r;
    };
    r.configured = true;
    let fail = |r: &mut BoxSyncReport, msg: String| {
        r.error_kind = Some(classify_error(&msg).to_string());
        r.error = Some(msg);
    };

    // 1. Local: config (one read), hygiene, commit. Under the repo lock.
    let mut rc = RepoConfig::default();
    let local: Result<bool, String> = with_repo_lock(vault, || {
        if !PathBuf::from(vault).join(".git").exists() {
            return Err("this vault is not a git repository".into());
        }
        let b = head_branch_fs(vault).unwrap_or_default();
        if b != "master" {
            return Err(format!(
                "box sync works on branch master, but this vault is on '{}'",
                if b.is_empty() { "a detached HEAD" } else { b.as_str() }
            ));
        }
        rc = read_repo_config(vault);
        remember_hooks_path(vault, &rc);
        ensure_box_remote(vault, &cfg, &rc)?;
        if merge_in_progress(vault) {
            // Someone is resolving by hand: never abort their merge, never
            // commit over it.
            return Ok(true);
        }
        prepare_box_repo(vault, &rc);
        let (committed, big) = commit_local(vault, &rc)?;
        if committed {
            // Our own `add -A` never stages an ignored file: the sweep that
            // just ran still holds for the index this commit wrote.
            let mut g = UNTRACK_SEEN.lock().unwrap_or_else(|p| p.into_inner());
            g.get_or_insert_with(HashMap::new).insert(vault.to_string(), untrack_key(vault));
        }
        r.committed = committed;
        r.big_files = big;
        Ok(false)
    });
    let hand_merge = match local {
        Ok(h) => h,
        Err(e) => {
            fail(&mut r, e);
            r.changes_waiting = changes_waiting(vault);
            return r;
        }
    };

    // 2. Fetch the box branch (no lock: it only writes remote refs + objects).
    // Only that branch, no tags, no FETCH_HEAD, no auto-maintenance (commit
    // and merge still run it).
    match sg_net(
        vault,
        &[
            "fetch",
            "--no-tags",
            "--no-write-fetch-head",
            "--no-auto-maintenance",
            "--no-recurse-submodules",
            "--prune",
            BOX_REMOTE,
        ],
    ) {
        Ok((_, _, 0)) => {}
        // The box has not created its branch yet: nothing to merge, still push.
        Ok((_, e, _)) if e.contains("couldn't find remote ref refs/heads/box") => {}
        Ok((o, e, c)) => {
            fail(&mut r, full_err(&o, &e, c, "git fetch box"));
            r.changes_waiting = changes_waiting(vault);
            r.conflict = load_state(vault).conflict;
            return r;
        }
        Err(e) => {
            fail(&mut r, e);
            r.changes_waiting = changes_waiting(vault);
            r.conflict = load_state(vault).conflict;
            return r;
        }
    }

    // 3. The merge gate (the refs read once, under the same lock).
    let mut st = load_state(vault);
    let mut refs = Refs::default();
    let mut master_moved = r.committed;
    if hand_merge {
        r.message = "a merge is in progress (being resolved by hand); waiting".into();
        refs = with_repo_lock(vault, || read_refs(vault));
    } else {
        let gate = with_repo_lock(vault, || {
            refs = read_refs(vault);
            merge_gate(vault, &rc, &refs)
        });
        match gate {
            Ok(Gate::UpToDate) => st.conflict = None,
            Ok(Gate::Merged) => {
                st.conflict = None;
                r.merged = true;
                master_moved = true;
                r.merged_paths = merged_paths(vault);
            }
            Ok(Gate::Conflict(files)) => {
                let since = st.conflict.as_ref().map(|c| c.since).unwrap_or_else(now_ms);
                st.conflict = Some(ConflictState { files, since });
            }
            Err(e) => {
                // It may have committed before failing: the push decides by itself.
                master_moved = true;
                fail(&mut r, e);
            }
        }
        save_state(vault, &st);
    }
    r.conflict = st.conflict.clone();
    // The box already has this master: our record of its master (updated on
    // every push) equals ours, and nothing moved master since the refs were read.
    let box_has_master = !master_moved && refs.master.is_some() && refs.master == refs.box_master;

    if !push {
        r.ok = r.error.is_none();
        r.changes_waiting = if box_has_master { 0 } else { changes_waiting(vault) };
        r.message = match (&r.error, &r.conflict, r.merged) {
            (Some(_), _, _) => "sync failed".into(),
            (None, Some(c), _) => format!("merge gate closed: conflict in {}", c.files.join(", ")),
            (None, None, true) => "merged box into master".into(),
            (None, None, false) if hand_merge => r.message.clone(),
            _ => "synced".into(),
        };
        return r;
    }

    // 4. Push master, and only master: when the box is behind, and every few
    // minutes anyway (the box's copy could have been replaced).
    let verify_due = {
        let g = LAST_PUSH.lock().unwrap_or_else(|p| p.into_inner());
        g.as_ref()
            .and_then(|m| m.get(vault))
            .map(|t| t.elapsed() >= PUSH_VERIFY_EVERY)
            .unwrap_or(true)
    };
    if box_has_master && !verify_due {
        if r.error.is_none() {
            r.ok = true;
        }
        r.changes_waiting = 0;
    } else {
        {
            let mut g = LAST_PUSH.lock().unwrap_or_else(|p| p.into_inner());
            g.get_or_insert_with(HashMap::new).insert(vault.to_string(), Instant::now());
        }
        match sg_net(vault, &["push", "--porcelain", BOX_REMOTE, "refs/heads/master:refs/heads/master"]) {
            Ok((_, _, 0)) => {
                let _ = run_git(vault, &["update-ref", "refs/remotes/box/master", "refs/heads/master"]);
                if r.error.is_none() {
                    r.ok = true;
                }
                // master is now box/master: nothing waits.
                r.changes_waiting = 0;
            }
            Ok((o, e, c)) => {
                fail(&mut r, full_err(&o, &e, c, "git push box master"));
                r.changes_waiting = changes_waiting(vault);
            }
            Err(e) => {
                fail(&mut r, e);
                r.changes_waiting = changes_waiting(vault);
            }
        }
    }

    // 5. GitHub backup, after a good cycle only, in the background.
    if r.ok {
        github_backup(vault, &rc, &mut r);
    }
    r.message = match (&r.error, &r.conflict, r.merged) {
        (Some(_), _, _) => "sync failed".into(),
        (None, Some(c), _) => format!("merge gate closed: conflict in {}", c.files.join(", ")),
        (None, None, true) => "merged box into master; pushed".into(),
        (None, None, false) if hand_merge => r.message.clone(),
        _ => "synced".into(),
    };
    r
}

/// POST a JSON body to `url` (the box's routes). Reqwest, so no CORS.
pub fn post_json(url: &str, body: &str, token: Option<&str>) -> Result<(u16, String), String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent("vault-chat/box-sync")
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client
        .post(url)
        .header("Content-Type", "application/json")
        .body(body.to_string());
    if let Some(t) = token.filter(|t| !t.is_empty()) {
        req = req.header("X-Vault-Token", t);
    }
    let resp = req.send().map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let text = resp.text().unwrap_or_default();
    Ok((status, text))
}

/// GET from the box with a bounded timeout (the chat's long-poll needs ~30 s).
pub fn get_json(url: &str, token: Option<&str>, timeout_ms: u64) -> Result<(u16, String), String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent("vault-chat/box-chat")
        .timeout(Duration::from_millis(timeout_ms.clamp(1_000, 120_000)))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.get(url).header("Accept", "application/json");
    if let Some(t) = token.filter(|t| !t.is_empty()) {
        req = req.header("X-Vault-Token", t);
    }
    let resp = req.send().map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let text = resp.text().unwrap_or_default();
    Ok((status, text))
}

#[cfg(test)]
mod tests;
