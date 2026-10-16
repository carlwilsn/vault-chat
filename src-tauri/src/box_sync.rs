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
//!   cycle pushes `master` and the fetched box branch (as `box`) there, at most
//!   every 2 minutes. A failure is a warning, never a gate.

use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::{
    human_identity, prepare_vault_repo, run_git, run_git_as, run_git_mut,
    run_git_timeout, with_repo_lock, MISSION_ZONE_PATHS,
};

/// Never auto-commit a file larger than this.
pub const BOX_MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;
/// The fetched box branch.
pub const BOX_REF: &str = "refs/remotes/box/box";
const BOX_REMOTE: &str = "box";
const GITHUB_REMOTE: &str = "github";
const GITHUB_DEBOUNCE: Duration = Duration::from_secs(120);
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
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn git_ok(vault: &str, args: &[&str]) -> bool {
    matches!(run_git(vault, args), Ok((_, _, 0)))
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

fn ref_exists(vault: &str, r: &str) -> bool {
    git_ok(vault, &["rev-parse", "--verify", "--quiet", r])
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
fn ensure_box_remote(vault: &str, cfg: &BoxConfig) -> Result<(), String> {
    let url = cfg.remote_url();
    let cur = run_git(vault, &["remote", "get-url", BOX_REMOTE])?;
    if cur.2 != 0 {
        let (o, e, c) = run_git(vault, &["remote", "add", BOX_REMOTE, &url])?;
        if c != 0 {
            return Err(full_err(&o, &e, c, "git remote add box"));
        }
    } else if cur.0.trim() != url {
        let (o, e, c) = run_git(vault, &["remote", "set-url", BOX_REMOTE, &url])?;
        if c != 0 {
            return Err(full_err(&o, &e, c, "git remote set-url box"));
        }
    }
    let want = format!("+refs/heads/box:{}", BOX_REF);
    let (fetch_cfg, _, _) = run_git(vault, &["config", "--get-all", "remote.box.fetch"])?;
    if fetch_cfg.trim() != want {
        let _ = run_git(vault, &["config", "--replace-all", "remote.box.fetch", &want]);
    }
    // (No submodule recursion: prepare_vault_repo sets fetch.recurseSubmodules
    // and submodule.recurse to false every cycle.)
    Ok(())
}

// ---------- mission zone ----------

fn path_in_zone_dirs(path: &str) -> bool {
    MISSION_ZONE_PATHS
        .iter()
        .any(|z| path == *z || path.starts_with(&format!("{}/", z)))
}

/// Is `rel` a mission-zone path? [phase 2] In box mode every agent turn runs
/// on the box, so EVERY conversation file is the box's (not just
/// mission/worker/ask threads): the laptop resets them all to the box before a
/// commit, and a conflict on one resolves to the box's side.
fn is_zone_path(_vault: &str, rel: &str, _authority: &str) -> bool {
    if path_in_zone_dirs(rel) {
        return true;
    }
    is_conversation_file(rel)
}

fn is_conversation_file(rel: &str) -> bool {
    rel.starts_with(".vault-chat/conversations/") && (rel.ends_with(".jsonl") || rel.ends_with(".json"))
}

/// Reset every mission-zone path that differs from `authority` (box/box) back
/// to the authority's version, in index and working tree. The follower
/// sanitize, with the box as the authority. Only paths the authority has are
/// touched; a zone path the box has never had is left alone.
pub fn sanitize_zone_to(vault: &str, authority: &str) -> Vec<String> {
    if !ref_exists(vault, authority) {
        return vec![];
    }
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
        let _ = run_git_mut(vault, &args);
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

/// Keep untracked files over 50 MB out of git via `.git/info/exclude`. Entries
/// whose file is gone or has shrunk are dropped again. Returns the current
/// set of excluded big files.
fn exclude_large_untracked(vault: &str) -> Vec<BigFile> {
    let mut big: Vec<String> = read_exclude_block(vault)
        .into_iter()
        .filter(|p| file_size(vault, p).map(|s| s > BOX_MAX_FILE_BYTES).unwrap_or(false))
        .collect();
    if let Ok((out, _, 0)) = run_git(vault, &["ls-files", "--others", "--exclude-standard", "-z"]) {
        for p in out.split('\0').filter(|p| !p.is_empty()) {
            if file_size(vault, p).map(|s| s > BOX_MAX_FILE_BYTES).unwrap_or(false)
                && !big.iter().any(|b| b == p)
            {
                big.push(p.to_string());
            }
        }
    }
    big.sort();
    write_exclude_block(vault, &big);
    big.iter()
        .map(|p| BigFile { path: p.clone(), size: file_size(vault, p).unwrap_or(0) })
        .collect()
}

/// After `add -A`: unstage anything over 50 MB that still got staged (a tracked
/// file that grew). Returns those files.
fn unstage_large(vault: &str) -> Vec<BigFile> {
    let mut out_v = Vec::new();
    if let Ok((out, _, 0)) = run_git(
        vault,
        &["diff", "--cached", "--no-renames", "--name-only", "-z", "--diff-filter=AM"],
    ) {
        for p in out.split('\0').filter(|p| !p.is_empty()) {
            if let Some(sz) = file_size(vault, p) {
                if sz > BOX_MAX_FILE_BYTES {
                    let _ = run_git_mut(vault, &["reset", "-q", "--", p]);
                    out_v.push(BigFile { path: p.to_string(), size: sz });
                }
            }
        }
    }
    out_v
}

/// Stage everything a box-mode commit may carry: mission zone reset to the
/// box, nothing over 50 MB. Caller holds the repo lock. Returns the big files.
pub fn box_stage_all(vault: &str, name: &str, email: &str) -> Result<Vec<BigFile>, String> {
    sanitize_zone_to(vault, BOX_REF);
    let mut big = exclude_large_untracked(vault);
    let (o, e, c) = run_git_as(vault, name, email, &["add", "-A"])?;
    if c != 0 {
        return Err(full_err(&o, &e, c, "git add -A"));
    }
    for b in unstage_large(vault) {
        if !big.iter().any(|x| x.path == b.path) {
            big.push(b);
        }
    }
    Ok(big)
}

fn merge_in_progress(vault: &str) -> bool {
    git_dir(vault).join("MERGE_HEAD").exists()
}

fn worktree_dirty(vault: &str) -> bool {
    run_git(vault, &["status", "--porcelain", "--ignore-submodules=dirty"])
        .map(|(s, _, _)| !s.trim().is_empty())
        .unwrap_or(false)
}

/// Commit local edits on master (no nested repos). Caller holds the lock.
fn commit_local(vault: &str) -> Result<(bool, Vec<BigFile>), String> {
    // Steady state: nothing changed and no big file to re-check → done after
    // one `git status` (every spawn costs ~0.1–0.2 s on Windows).
    if !worktree_dirty(vault) && read_exclude_block(vault).is_empty() {
        return Ok((false, vec![]));
    }
    let (hn, he) = human_identity(vault);
    let big = box_stage_all(vault, &hn, &he)?;
    if git_ok(vault, &["diff", "--cached", "--quiet"]) {
        return Ok((false, big));
    }
    let (o, e, c) = run_git_as(vault, &hn, &he, &["commit", "-q", "--no-verify", "-m", "vault-chat: sync"])?;
    if c != 0 {
        return Err(full_err(&o, &e, c, "git commit"));
    }
    Ok((true, big))
}

enum Gate {
    UpToDate,
    Merged,
    Conflict(Vec<String>),
}

/// The merge gate. Caller holds the lock and has committed local edits.
fn merge_gate(vault: &str) -> Result<Gate, String> {
    if !ref_exists(vault, BOX_REF) {
        return Ok(Gate::UpToDate);
    }
    if git_ok(vault, &["merge-base", "--is-ancestor", BOX_REF, "HEAD"]) {
        return Ok(Gate::UpToDate);
    }
    // Dry run first: `merge-tree --write-tree` merges in memory and touches
    // neither the index nor the working tree. Exit 0 = clean, 1 = conflicts.
    let (out, err, code) = run_git(
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
        commit_local(vault)?;
    }
    let (hn, he) = human_identity(vault);
    let (o, e, c) = run_git_as(
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
        let (u, _, _) = run_git(vault, &["ls-files", "-u", "-z"])?;
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
                    let _ = run_git_mut(vault, &["checkout", "--theirs", "--", p]);
                    let _ = run_git_mut(vault, &["add", "--", p]);
                } else {
                    let _ = run_git_mut(vault, &["rm", "-q", "--", p]);
                }
            }
            let (o2, e2, c2) = run_git_as(vault, &hn, &he, &["commit", "-q", "--no-edit", "--no-verify"])?;
            if c2 == 0 {
                return Ok(Gate::Merged);
            }
            let _ = run_git_mut(vault, &["merge", "--abort"]);
            return Err(full_err(&o2, &e2, c2, "git commit (merge box, mission zone)"));
        }
    }
    // Anything else: leave master exactly as it was.
    if merge_in_progress(vault) {
        let _ = run_git_mut(vault, &["merge", "--abort"]);
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
    attempted: Instant,
    pushed_at: Option<u64>,
    warning: Option<String>,
}

static GITHUB_LAST: Mutex<Option<HashMap<String, GithubState>>> = Mutex::new(None);

/// Back up master + the box branch to the `github` remote, at most every
/// 2 minutes (attempts too, so a failing backup doesn't retry every cycle).
/// Between attempts the last outcome is reported again, so a failure stays
/// visible until a push succeeds.
fn github_backup(vault: &str, report: &mut BoxSyncReport) {
    if !git_ok(vault, &["remote", "get-url", GITHUB_REMOTE]) {
        return;
    }
    let prev = {
        let g = GITHUB_LAST.lock().unwrap_or_else(|p| p.into_inner());
        g.as_ref().and_then(|m| m.get(vault)).cloned()
    };
    if let Some(p) = &prev {
        if p.attempted.elapsed() < GITHUB_DEBOUNCE {
            report.github_pushed_at = p.pushed_at;
            report.github_warning = p.warning.clone();
            return;
        }
    }
    let box_spec = format!("{}:refs/heads/box", BOX_REF);
    let mut args: Vec<&str> = vec!["push", "--porcelain", GITHUB_REMOTE, "refs/heads/master:refs/heads/master"];
    if ref_exists(vault, BOX_REF) {
        args.push(&box_spec);
    }
    let mut next = GithubState {
        attempted: Instant::now(),
        pushed_at: prev.and_then(|p| p.pushed_at),
        warning: None,
    };
    match run_git_timeout(vault, &args, NET_TIMEOUT_SECS) {
        Ok((_, _, 0)) => next.pushed_at = Some(now_ms()),
        Ok((o, e, c)) => next.warning = Some(full_err(&o, &e, c, "GitHub backup (git push github)")),
        Err(e) => next.warning = Some(format!("GitHub backup failed: {}", e)),
    }
    report.github_pushed_at = next.pushed_at;
    report.github_warning = next.warning.clone();
    let mut g = GITHUB_LAST.lock().unwrap_or_else(|p| p.into_inner());
    g.get_or_insert_with(HashMap::new).insert(vault.to_string(), next);
}

/// One full sync cycle. Blocking; call from a worker thread.
pub fn box_sync_cycle(vault: &str) -> BoxSyncReport {
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

    // 1. Local: remote config, hygiene, commit. Under the repo lock.
    let local: Result<bool, String> = with_repo_lock(vault, || {
        if !PathBuf::from(vault).join(".git").exists() {
            return Err("this vault is not a git repository".into());
        }
        let (b, _, _) = run_git(vault, &["symbolic-ref", "--quiet", "--short", "HEAD"])?;
        if b.trim() != "master" {
            return Err(format!(
                "box sync works on branch master, but this vault is on '{}'",
                if b.trim().is_empty() { "a detached HEAD" } else { b.trim() }
            ));
        }
        ensure_box_remote(vault, &cfg)?;
        if merge_in_progress(vault) {
            // Someone is resolving by hand: never abort their merge, never
            // commit over it.
            return Ok(true);
        }
        prepare_vault_repo(vault);
        let (committed, big) = commit_local(vault)?;
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
    match run_git_timeout(vault, &["fetch", "--no-recurse-submodules", "--prune", BOX_REMOTE], NET_TIMEOUT_SECS) {
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

    // 3. The merge gate.
    let mut st = load_state(vault);
    if hand_merge {
        r.message = "a merge is in progress (being resolved by hand); waiting".into();
    } else {
        let gate = with_repo_lock(vault, || merge_gate(vault));
        match gate {
            Ok(Gate::UpToDate) => st.conflict = None,
            Ok(Gate::Merged) => {
                st.conflict = None;
                r.merged = true;
                r.merged_paths = merged_paths(vault);
            }
            Ok(Gate::Conflict(files)) => {
                let since = st.conflict.as_ref().map(|c| c.since).unwrap_or_else(now_ms);
                st.conflict = Some(ConflictState { files, since });
            }
            Err(e) => fail(&mut r, e),
        }
        save_state(vault, &st);
    }
    r.conflict = st.conflict.clone();

    // 4. Push master, and only master.
    match run_git_timeout(
        vault,
        &["push", "--porcelain", BOX_REMOTE, "refs/heads/master:refs/heads/master"],
        NET_TIMEOUT_SECS,
    ) {
        Ok((_, _, 0)) => {
            let _ = run_git(vault, &["update-ref", "refs/remotes/box/master", "refs/heads/master"]);
            if r.error.is_none() {
                r.ok = true;
            }
        }
        Ok((o, e, c)) => fail(&mut r, full_err(&o, &e, c, "git push box master")),
        Err(e) => fail(&mut r, e),
    }
    r.changes_waiting = changes_waiting(vault);

    // 5. GitHub backup, after a good cycle only.
    if r.ok {
        github_backup(vault, &mut r);
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
