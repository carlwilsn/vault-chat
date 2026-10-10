// Readable history (F-history §2–§6): one timeline of *entries*, not commits.
//
// An entry is something a person recognises:
//   • session — consecutive content commits by the same actor on the same
//     machine (and, for the agent, the same conversation) with gaps under
//     `gap` (10 min by default);
//   • mission — one kept mission merge (`Mission-Id` trailer); its branch's
//     own commits are hidden inside it;
//   • restore / undo / redo — one commit each, linked to their target.
//
// App-state churn is *filtered*, never deleted: `.vault-chat/**`,
// gitlink-only pointer bumps and `.gitignore`/`.gitattributes`/`.gitmodules`
// housekeeping contribute nothing, and sync merges are flattened (the other
// machine's commits show as their own sessions). `include_noise` shows them.
//
// Every mutating action is one commit, under the repo lock, and never touches
// `.vault-chat/`: undo computes the reverted tree with `git merge-tree`
// (nothing in the index or worktree moves until the whole result is known
// clean), so a conflict leaves the repo exactly as it was — never
// mid-revert.

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};

pub const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const DEFAULT_GAP_SECS: i64 = 600;
const HDR: &str = "--format=%x1e%H%x1f%P%x1f%an%x1f%ct%x1f%s%x1f%(trailers:only,unfold,separator=%x1d)";

// ----- a small git runner (env + stdin; history needs both) -----

fn git_full(
    cwd: &str,
    args: &[&str],
    env: &[(&str, &str)],
    stdin: Option<&str>,
) -> Result<(String, String, i32), String> {
    use std::io::Write;
    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new("git");
        c.creation_flags(0x08000000);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = Command::new("git");
    cmd.current_dir(cwd)
        .arg("-c")
        .arg("core.quotePath=false")
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() });
    for (k, v) in env {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().map_err(|e| format!("git: {}", e))?;
    if let Some(input) = stdin {
        if let Some(mut s) = child.stdin.take() {
            s.write_all(input.as_bytes()).map_err(|e| e.to_string())?;
        }
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    Ok((
        String::from_utf8_lossy(&out.stdout).to_string(),
        String::from_utf8_lossy(&out.stderr).to_string(),
        out.status.code().unwrap_or(-1),
    ))
}

/// stdout of a git command that must succeed.
fn git(cwd: &str, args: &[&str]) -> Result<String, String> {
    let (o, e, c) = git_full(cwd, args, &[], None)?;
    if c != 0 {
        return Err(format!("git {} failed: {}", args.first().unwrap_or(&""), e.trim()));
    }
    Ok(o)
}

fn identity_env(name: &str, email: &str) -> Vec<(&'static str, String)> {
    vec![
        ("GIT_AUTHOR_NAME", name.to_string()),
        ("GIT_AUTHOR_EMAIL", email.to_string()),
        ("GIT_COMMITTER_NAME", name.to_string()),
        ("GIT_COMMITTER_EMAIL", email.to_string()),
    ]
}

fn git_as(cwd: &str, name: &str, email: &str, args: &[&str]) -> Result<(String, String, i32), String> {
    let env = identity_env(name, email);
    let env_ref: Vec<(&str, &str)> = env.iter().map(|(k, v)| (*k, v.as_str())).collect();
    git_full(cwd, args, &env_ref, None)
}

// ----- classification -----

/// App state and housekeeping: filtered from the timeline, never reverted.
pub fn is_noise_path(path: &str) -> bool {
    let p = path.trim_start_matches("./");
    if p == ".vault-chat" || p.starts_with(".vault-chat/") {
        return true;
    }
    let leaf = p.rsplit('/').next().unwrap_or(p);
    matches!(leaf, ".gitignore" | ".gitattributes" | ".gitmodules")
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct FileChange {
    pub path: String,
    /// A (added), M (modified), D (deleted)
    pub status: String,
    pub add: u32,
    pub del: u32,
    #[serde(skip)]
    pub gitlink: bool,
}

impl FileChange {
    fn is_content(&self) -> bool {
        !self.gitlink && !is_noise_path(&self.path)
    }
}

#[derive(Clone, Debug)]
pub struct RawCommit {
    pub hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub time: i64,
    pub subject: String,
    pub trailers: HashMap<String, String>,
    pub files: Vec<FileChange>,
}

impl RawCommit {
    fn trailer(&self, k: &str) -> Option<String> {
        self.trailers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(k))
            .map(|(_, v)| v.trim().to_string())
            .filter(|v| !v.is_empty())
    }
}

fn unquote(p: &str) -> String {
    let p = p.trim();
    if p.len() >= 2 && p.starts_with('"') && p.ends_with('"') {
        p[1..p.len() - 1].replace("\\\"", "\"").replace("\\\\", "\\")
    } else {
        p.to_string()
    }
}

/// Parse `git log HDR --raw --numstat` (either or both diff formats).
pub fn parse_log(out: &str) -> Vec<RawCommit> {
    let mut commits = Vec::new();
    for rec in out.split('\x1e') {
        if rec.trim().is_empty() {
            continue;
        }
        let mut lines = rec.lines();
        let header = match lines.next() {
            Some(h) => h,
            None => continue,
        };
        let f: Vec<&str> = header.splitn(6, '\x1f').collect();
        if f.len() < 5 {
            continue;
        }
        let mut trailers = HashMap::new();
        if let Some(t) = f.get(5) {
            for kv in t.split('\x1d') {
                if let Some((k, v)) = kv.split_once(':') {
                    trailers.insert(k.trim().to_string(), v.trim().to_string());
                }
            }
        }
        let mut files: Vec<FileChange> = Vec::new();
        let mut idx: HashMap<String, usize> = HashMap::new();
        for line in lines {
            if line.is_empty() {
                continue;
            }
            if let Some(raw) = line.strip_prefix(':') {
                // :<srcmode> <dstmode> <srcoid> <dstoid> <status>\t<path>
                let (meta, path) = match raw.split_once('\t') {
                    Some(x) => x,
                    None => continue,
                };
                let m: Vec<&str> = meta.split_whitespace().collect();
                if m.len() < 5 {
                    continue;
                }
                let path = unquote(path);
                let gitlink = m[0] == "160000" || m[1] == "160000";
                let status = m[4].chars().next().unwrap_or('M').to_string();
                let fc = FileChange { path: path.clone(), status, add: 0, del: 0, gitlink };
                if let Some(&i) = idx.get(&path) {
                    files[i].status = fc.status;
                    files[i].gitlink = gitlink;
                } else {
                    idx.insert(path, files.len());
                    files.push(fc);
                }
            } else {
                let parts: Vec<&str> = line.splitn(3, '\t').collect();
                if parts.len() != 3 {
                    continue;
                }
                let path = unquote(parts[2]);
                let add = parts[0].parse().unwrap_or(0);
                let del = parts[1].parse().unwrap_or(0);
                if let Some(&i) = idx.get(&path) {
                    files[i].add = add;
                    files[i].del = del;
                } else {
                    idx.insert(path.clone(), files.len());
                    files.push(FileChange { path, status: "M".into(), add, del, gitlink: false });
                }
            }
        }
        commits.push(RawCommit {
            hash: f[0].to_string(),
            parents: f[1].split_whitespace().map(|s| s.to_string()).collect(),
            author: f[2].to_string(),
            time: f[3].trim().parse().unwrap_or(0),
            subject: f[4].to_string(),
            trailers,
            files,
        });
    }
    commits
}

#[derive(Clone, Debug, PartialEq)]
struct Class {
    kind: &'static str, // session | restore | undo | redo
    actor: &'static str, // human | agent | mission
    machine: Option<String>,
    conversation: Option<String>,
    mission: Option<String>,
    undoes: Option<String>,
    restores: Option<String>,
}

fn classify(c: &RawCommit) -> Class {
    let actor = match c.trailer("Vault-Chat-Actor").as_deref() {
        Some("agent") => "agent",
        Some("mission") => "mission",
        Some(_) => "human", // human, sync (a sync sweep that carries content is the human's)
        None => {
            if c.subject.starts_with("[agent]") || c.author == "vault-chat-agent" {
                "agent"
            } else {
                "human"
            }
        }
    };
    let undoes = c.trailer("Undoes");
    let restores = c.trailer("Restores");
    let kind = if undoes.is_some() {
        if c.subject.starts_with("Redo:") {
            "redo"
        } else {
            "undo"
        }
    } else if restores.is_some()
        || (c.subject.starts_with("Restore ") || c.subject.starts_with("Restore:"))
    {
        "restore"
    } else {
        "session"
    };
    Class {
        kind,
        actor,
        machine: c.trailer("Vault-Chat-Machine"),
        conversation: c.trailer("Conversation"),
        mission: c.trailer("Mission-Id"),
        undoes,
        restores,
    }
}

// ----- entries -----

#[derive(Clone, Debug, Serialize)]
pub struct InnerCommit {
    pub hash: String,
    pub time: i64,
    pub subject: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct Entry {
    /// The newest commit's hash.
    pub id: String,
    /// session | mission | restore | undo | redo
    pub kind: String,
    /// human | agent | mission
    pub actor: String,
    pub machine: Option<String>,
    pub title: String,
    /// The agent's own words for its turn (its `[agent] …` subject), or the
    /// commit subject for restore/undo entries.
    pub summary: Option<String>,
    pub start: i64,
    pub end: i64,
    /// oldest..newest
    pub commits: Vec<String>,
    /// Parent of the first commit (or the empty tree).
    pub base: String,
    /// Net, content only.
    pub files: Vec<FileChange>,
    pub conversation_id: Option<String>,
    pub mission_id: Option<String>,
    pub cost_usd: Option<f64>,
    pub undone_by: Option<String>,
    pub undoes: Option<String>,
    pub restores: Option<String>,
    /// The mission branch's own commits (read-only detail).
    pub inner: Vec<InnerCommit>,
    /// Only app state (shown only with include_noise).
    pub noise: bool,
}

struct Builder {
    class: Class,
    noise: bool,
    commits: Vec<RawCommit>, // newest first
}

impl Builder {
    fn oldest_time(&self) -> i64 {
        self.commits.last().map(|c| c.time).unwrap_or(0)
    }
    fn accepts(&self, class: &Class, noise: bool, time: i64, gap: i64) -> bool {
        self.class.kind == "session"
            && class.kind == "session"
            && self.noise == noise
            && self.class.actor == class.actor
            && self.class.machine == class.machine
            && (self.class.actor != "agent" || self.class.conversation == class.conversation)
            && self.oldest_time() - time <= gap
    }
}

fn leaf(p: &str) -> &str {
    p.rsplit('/').next().unwrap_or(p)
}

/// Net per-path change over commits given oldest..newest.
fn net_files(commits_oldest_first: &[&RawCommit], include_noise: bool) -> Vec<FileChange> {
    let mut order: Vec<String> = Vec::new();
    let mut acc: HashMap<String, (String, String, u32, u32)> = HashMap::new();
    for c in commits_oldest_first {
        for f in &c.files {
            if !include_noise && !f.is_content() {
                continue;
            }
            let e = acc.entry(f.path.clone()).or_insert_with(|| {
                order.push(f.path.clone());
                (f.status.clone(), f.status.clone(), 0, 0)
            });
            e.1 = f.status.clone();
            e.2 += f.add;
            e.3 += f.del;
        }
    }
    let mut out = Vec::new();
    for p in order {
        let (first, last, add, del) = acc.remove(&p).unwrap();
        if first == "A" && last == "D" {
            continue; // created and deleted inside the entry: nothing net
        }
        let status = if first == "A" {
            "A"
        } else if last == "D" {
            "D"
        } else {
            "M"
        };
        out.push(FileChange { path: p, status: status.into(), add, del, gitlink: false });
    }
    out
}

pub fn files_title(files: &[FileChange]) -> String {
    if files.is_empty() {
        return "No note changes".into();
    }
    let verb = if files.iter().all(|f| f.status == "A") {
        "Created"
    } else if files.iter().all(|f| f.status == "D") {
        "Deleted"
    } else {
        "Edited"
    };
    let mut ranked: Vec<&FileChange> = files.iter().collect();
    ranked.sort_by(|a, b| (b.add + b.del).cmp(&(a.add + a.del)));
    let names: Vec<&str> = ranked.iter().take(2).map(|f| leaf(&f.path)).collect();
    let more = files.len().saturating_sub(2);
    if more > 0 {
        format!("{} {} +{}", verb, names.join(", "), more)
    } else {
        format!("{} {}", verb, names.join(", "))
    }
}

fn strip_agent(s: &str) -> String {
    s.trim_start_matches("[agent]").trim().to_string()
}

// ----- the walk (HEAD-keyed cache) -----

#[derive(Clone, Debug, PartialEq)]
pub struct Opts {
    pub include_noise: bool,
    pub gap_secs: i64,
    pub path: Option<String>,
}

impl Default for Opts {
    fn default() -> Self {
        Opts { include_noise: false, gap_secs: DEFAULT_GAP_SECS, path: None }
    }
}

pub struct Walk {
    repo: String,
    head: String,
    opts: Opts,
    consumed: usize,
    done: bool,
    pub entries: Vec<Entry>,
    open: Option<Builder>,
    hidden: HashSet<String>,
    /// target entry id → the live undo/redo entry that undid it
    undoers: HashMap<String, String>,
    pub commit_entry: HashMap<String, String>,
}

pub fn head_of(repo: &str) -> Option<String> {
    let (o, _, c) = git_full(repo, &["rev-parse", "--verify", "-q", "HEAD"], &[], None).ok()?;
    if c == 0 {
        Some(o.trim().to_string())
    } else {
        None
    }
}

impl Walk {
    pub fn new(repo: &str, head: &str, opts: Opts) -> Walk {
        Walk {
            repo: repo.to_string(),
            head: head.to_string(),
            opts,
            consumed: 0,
            done: false,
            entries: Vec::new(),
            open: None,
            hidden: HashSet::new(),
            undoers: HashMap::new(),
            commit_entry: HashMap::new(),
        }
    }

    fn read_batch(&mut self, n: usize) -> Result<Vec<RawCommit>, String> {
        let skip = format!("--skip={}", self.consumed);
        let max = format!("-n{}", n);
        let mut args: Vec<&str> = vec![
            "log",
            "--date-order",
            "--no-renames",
            "--raw",
            "--numstat",
            "--no-abbrev",
            HDR,
            &skip,
            &max,
            &self.head,
        ];
        let path;
        if let Some(p) = &self.opts.path {
            path = p.clone();
            args.push("--");
            args.push(&path);
        }
        let out = git(&self.repo, &args)?;
        let commits = parse_log(&out);
        self.consumed += commits.len();
        if commits.len() < n {
            self.done = true;
        }
        Ok(commits)
    }

    /// Fill until `want` entries are final (or history ends).
    pub fn fill(&mut self, want: usize) -> Result<(), String> {
        let mut batch = 300;
        while self.entries.len() < want && !self.done {
            let commits = self.read_batch(batch)?;
            for c in commits {
                self.process(c)?;
            }
            batch = 1000;
        }
        if self.done {
            self.close_open();
        }
        Ok(())
    }

    fn process(&mut self, c: RawCommit) -> Result<(), String> {
        if self.hidden.contains(&c.hash) {
            return Ok(());
        }
        if c.parents.len() > 1 {
            if let Some(mid) = c.trailer("Mission-Id") {
                self.close_open();
                let e = self.mission_entry(&c, mid)?;
                self.finalize(e);
            }
            // Sync merges are flattened: the other side's commits show as
            // their own sessions further down the stream.
            return Ok(());
        }
        let class = classify(&c);
        let has_content = c.files.iter().any(|f| f.is_content());
        let noise = !has_content;
        if noise && !self.opts.include_noise {
            return Ok(());
        }
        if let Some(b) = &mut self.open {
            if b.accepts(&class, noise, c.time, self.opts.gap_secs) {
                b.commits.push(c);
                return Ok(());
            }
        }
        self.close_open();
        self.open = Some(Builder { class, noise, commits: vec![c] });
        Ok(())
    }

    fn close_open(&mut self) {
        if let Some(b) = self.open.take() {
            let e = self.session_entry(b);
            self.finalize(e);
        }
    }

    fn finalize(&mut self, mut e: Entry) {
        e.undone_by = self.undoers.get(&e.id).cloned();
        if let (Some(t), None) = (&e.undoes, &e.undone_by) {
            self.undoers.insert(t.clone(), e.id.clone());
        }
        for h in &e.commits {
            self.commit_entry.insert(h.clone(), e.id.clone());
        }
        self.entries.push(e);
    }

    fn session_entry(&self, b: Builder) -> Entry {
        let oldest_first: Vec<&RawCommit> = b.commits.iter().rev().collect();
        let newest = &b.commits[0];
        let oldest = oldest_first[0];
        let files = net_files(&oldest_first, b.noise);
        let title = match b.class.kind {
            "session" => {
                if b.noise {
                    format!("App state · {}", newest.subject)
                } else {
                    files_title(&files)
                }
            }
            _ => newest.subject.clone(),
        };
        let summary = match (b.class.kind, b.class.actor) {
            ("session", "agent") => b
                .commits
                .iter()
                .find(|c| c.subject.starts_with("[agent]") && !c.subject.contains("autosave ("))
                .map(|c| strip_agent(&c.subject)),
            ("session", _) => None,
            _ => Some(newest.subject.clone()),
        };
        Entry {
            id: newest.hash.clone(),
            kind: b.class.kind.to_string(),
            actor: b.class.actor.to_string(),
            machine: b.class.machine.clone(),
            title,
            summary,
            start: oldest.time,
            end: newest.time,
            commits: oldest_first.iter().map(|c| c.hash.clone()).collect(),
            base: oldest.parents.first().cloned().unwrap_or_else(|| EMPTY_TREE.to_string()),
            files,
            conversation_id: b.class.conversation.clone(),
            mission_id: b.class.mission.clone(),
            cost_usd: newest.trailer("Cost-Usd").and_then(|v| v.trim_start_matches('$').parse().ok()),
            undone_by: None,
            undoes: b.class.undoes.clone(),
            restores: b.class.restores.clone(),
            inner: vec![],
            noise: b.noise,
        }
    }

    fn mission_entry(&mut self, m: &RawCommit, mission_id: String) -> Result<Entry, String> {
        let p1 = m.parents[0].clone();
        let p2 = m.parents[1].clone();
        let out = git(
            &self.repo,
            &["diff-tree", "-r", "--no-renames", "--raw", "--numstat", "--no-abbrev", "--root", &p1, &m.hash],
        )?;
        // diff-tree prints no header for a tree pair; wrap it as one record.
        let parsed = parse_log(&format!("\x1e{}\x1f\x1f\x1f0\x1f\n{}", m.hash, out));
        let files: Vec<FileChange> = parsed
            .into_iter()
            .next()
            .map(|c| c.files.into_iter().filter(|f| f.is_content()).collect())
            .unwrap_or_default();
        let range = format!("{}..{}", p1, p2);
        let inner_out = git(&self.repo, &["log", "--format=%H%x1f%ct%x1f%s", &range])?;
        let mut inner = Vec::new();
        for l in inner_out.lines() {
            let f: Vec<&str> = l.splitn(3, '\x1f').collect();
            if f.len() == 3 {
                self.hidden.insert(f[0].to_string());
                inner.push(InnerCommit { hash: f[0].into(), time: f[1].parse().unwrap_or(0), subject: f[2].into() });
            }
        }
        let start = inner.last().map(|c| c.time).unwrap_or(m.time);
        let title = m
            .subject
            .strip_prefix("Mission:")
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|| m.subject.clone());
        Ok(Entry {
            id: m.hash.clone(),
            kind: "mission".into(),
            actor: "mission".into(),
            machine: m.trailer("Vault-Chat-Machine"),
            title,
            summary: None,
            start,
            end: m.time,
            commits: vec![m.hash.clone()],
            base: p1,
            files,
            conversation_id: m.trailer("Conversation"),
            mission_id: Some(mission_id),
            cost_usd: m.trailer("Cost-Usd").and_then(|v| v.trim_start_matches('$').parse().ok()),
            undone_by: None,
            undoes: None,
            restores: None,
            inner,
            noise: false,
        })
    }
}

static CACHE: OnceLock<Mutex<HashMap<String, Walk>>> = OnceLock::new();

fn cache_key(repo: &str, o: &Opts) -> String {
    format!("{}|{}|{}|{}", repo.replace('\\', "/"), o.include_noise, o.gap_secs, o.path.clone().unwrap_or_default())
}

/// Run `f` on the cached walk for (repo, opts) at the current HEAD.
fn with_walk<T>(repo: &str, opts: &Opts, f: impl FnOnce(&mut Walk) -> Result<T, String>) -> Result<Option<T>, String> {
    let head = match head_of(repo) {
        Some(h) => h,
        None => return Ok(None),
    };
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = cache.lock().unwrap_or_else(|e| e.into_inner());
    let key = cache_key(repo, opts);
    let stale = map.get(&key).map(|w| w.head != head).unwrap_or(true);
    if stale {
        map.insert(key.clone(), Walk::new(repo, &head, opts.clone()));
    }
    let w = map.get_mut(&key).unwrap();
    f(w).map(Some)
}

#[derive(Serialize, Debug)]
pub struct TimelinePage {
    pub entries: Vec<Entry>,
    pub next_cursor: Option<String>,
    pub head: String,
}

pub fn timeline(repo: &str, cursor: Option<&str>, limit: usize, opts: &Opts) -> Result<TimelinePage, String> {
    let start: usize = cursor
        .and_then(|c| c.rsplit('@').next())
        .and_then(|n| n.parse().ok())
        .unwrap_or(0);
    let limit = limit.clamp(1, 500);
    let page = with_walk(repo, opts, |w| {
        w.fill(start + limit + 1)?;
        let end = (start + limit).min(w.entries.len());
        let entries = if start < end { w.entries[start..end].to_vec() } else { vec![] };
        let next = if w.entries.len() > start + limit {
            Some(format!("{}@{}", &w.head[..12.min(w.head.len())], start + limit))
        } else {
            None
        };
        Ok(TimelinePage { entries, next_cursor: next, head: w.head.clone() })
    })?;
    Ok(page.unwrap_or(TimelinePage { entries: vec![], next_cursor: None, head: String::new() }))
}

/// Find an entry by id at the current HEAD (walks as far as needed).
pub fn find_entry(repo: &str, id: &str) -> Result<Entry, String> {
    let opts = Opts::default();
    let found = with_walk(repo, &opts, |w| {
        let mut want = 64;
        loop {
            if let Some(e) = w.entries.iter().find(|e| e.id == id || e.id.starts_with(id)) {
                return Ok(Some(e.clone()));
            }
            if w.done {
                return Ok(None);
            }
            w.fill(want)?;
            want *= 2;
        }
    })?;
    found.flatten().ok_or_else(|| format!("No history entry {}", id))
}

// ----- per-note versions -----

#[derive(Serialize, Debug, Clone)]
pub struct Version {
    pub entry_id: String,
    /// The newest commit of the group: the note as it stood after it.
    pub hash: String,
    pub time: i64,
    pub start: i64,
    pub actor: String,
    pub machine: Option<String>,
    /// session | mission | restore | undo | redo
    pub kind: String,
    pub summary: Option<String>,
    pub add: u32,
    pub del: u32,
    pub commits: usize,
    /// The note did not exist after this version (deleted).
    pub deleted: bool,
}

#[derive(Serialize, Debug)]
pub struct VersionsPage {
    pub versions: Vec<Version>,
    pub next_cursor: Option<String>,
}

pub fn note_versions(repo: &str, path: &str, cursor: Option<&str>, limit: usize, gap_secs: i64) -> Result<VersionsPage, String> {
    if head_of(repo).is_none() {
        return Ok(VersionsPage { versions: vec![], next_cursor: None });
    }
    let mut skip: usize = cursor.and_then(|c| c.strip_prefix("skip:")).and_then(|n| n.parse().ok()).unwrap_or(0);
    let limit = limit.clamp(1, 200);
    // groups: (first index in stream, commits newest-first)
    let mut groups: Vec<(usize, Class, Vec<RawCommit>)> = Vec::new();
    let mut seen = skip;
    let mut done = false;
    while groups.len() <= limit && !done {
        let n = 200;
        let s = format!("--skip={}", skip);
        let m = format!("-n{}", n);
        let out = git(repo, &["log", "--date-order", "--no-renames", "--no-merges", "--raw", "--numstat", "--no-abbrev", HDR, &s, &m, "HEAD", "--", path])?;
        let commits = parse_log(&out);
        if commits.len() < n {
            done = true;
        }
        skip += commits.len();
        for c in commits {
            let idx = seen;
            seen += 1;
            let class = classify(&c);
            if let Some((_, gclass, gc)) = groups.last_mut() {
                let oldest = gc.last().map(|x| x.time).unwrap_or(0);
                if gclass.kind == "session"
                    && class.kind == "session"
                    && gclass.actor == class.actor
                    && gclass.machine == class.machine
                    && oldest - c.time <= gap_secs
                {
                    gc.push(c);
                    continue;
                }
            }
            groups.push((idx, class, vec![c]));
        }
    }
    let next_cursor = if groups.len() > limit { Some(format!("skip:{}", groups[limit].0)) } else { None };
    groups.truncate(limit);
    // Map commits to timeline entries when the timeline has walked that far.
    let entry_map: HashMap<String, String> = {
        let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
        let map = cache.lock().unwrap_or_else(|e| e.into_inner());
        map.get(&cache_key(repo, &Opts::default())).map(|w| w.commit_entry.clone()).unwrap_or_default()
    };
    let versions = groups
        .into_iter()
        .map(|(_, class, cs)| {
            let newest = &cs[0];
            let mut add = 0;
            let mut del = 0;
            for c in &cs {
                for f in c.files.iter().filter(|f| f.path == path) {
                    add += f.add;
                    del += f.del;
                }
            }
            let deleted = newest.files.iter().any(|f| f.path == path && f.status == "D");
            Version {
                entry_id: entry_map.get(&newest.hash).cloned().unwrap_or_else(|| newest.hash.clone()),
                hash: newest.hash.clone(),
                time: newest.time,
                start: cs.last().unwrap().time,
                actor: class.actor.to_string(),
                machine: class.machine.clone(),
                kind: class.kind.to_string(),
                summary: if class.actor == "agent" {
                    cs.iter().find(|c| c.subject.starts_with("[agent]")).map(|c| strip_agent(&c.subject))
                } else if class.kind != "session" {
                    Some(newest.subject.clone())
                } else {
                    None
                },
                add,
                del,
                commits: cs.len(),
                deleted,
            }
        })
        .collect();
    Ok(VersionsPage { versions, next_cursor })
}

// ----- reads -----

pub fn file_at(repo: &str, hash: &str, path: &str) -> Result<String, String> {
    let spec = format!("{}:{}", hash, path);
    let (o, _, c) = git_full(repo, &["show", &spec], &[], None)?;
    Ok(if c == 0 { o } else { String::new() })
}

/// `against = "disk"`: what restoring `hash` would change on disk ("+" = the
/// lines that come back). `against = "hash"`: what the version changed,
/// from `base` (default `hash^`) to `hash`.
pub fn diff(repo: &str, hash: &str, path: &str, against: &str, base: Option<&str>) -> Result<String, String> {
    if against == "disk" {
        return git(repo, &["diff", "--no-color", "-R", hash, "--", path]);
    }
    let from = match base {
        Some(b) if !b.is_empty() => b.to_string(),
        _ => {
            let parent = format!("{}^", hash);
            match git_full(repo, &["rev-parse", "--verify", "-q", &parent], &[], None)? {
                (_, _, 0) => parent,
                _ => EMPTY_TREE.to_string(),
            }
        }
    };
    git(repo, &["diff", "--no-color", &from, hash, "--", path])
}

// ----- actions -----

fn trailer_block(pairs: &[(&str, Option<&str>)]) -> String {
    pairs
        .iter()
        .filter_map(|(k, v)| v.map(|v| format!("{}: {}", k, v)))
        .collect::<Vec<_>>()
        .join("\n")
}

fn local_date(repo: &str, hash: &str) -> String {
    git(repo, &["log", "-1", "--format=%cd", "--date=format-local:%Y-%m-%d %H:%M", hash])
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| hash.chars().take(8).collect())
}

#[derive(Serialize, Debug)]
pub struct RestoreResult {
    pub commit: String,
    pub reloaded_paths: Vec<String>,
}

/// Caller holds the repo lock.
pub fn restore_note(repo: &str, path: &str, hash: &str, machine: &str, name: &str, email: &str) -> Result<RestoreResult, String> {
    if is_noise_path(path) {
        return Err("History never restores app state (.vault-chat/).".into());
    }
    let spec = format!("{}:{}", hash, path);
    let (_, _, exists) = git_full(repo, &["cat-file", "-e", &spec], &[], None)?;
    if exists == 0 {
        git(repo, &["checkout", hash, "--", path])?;
    } else {
        git(repo, &["rm", "-q", "-f", "--ignore-unmatch", "--", path])?;
    }
    let (_, _, same) = git_full(repo, &["diff", "--cached", "--quiet", "HEAD", "--", path], &[], None)?;
    if same == 0 {
        return Err("This note is already at that version.".into());
    }
    let msg = format!(
        "Restore {} to {}\n\n{}",
        path,
        local_date(repo, hash),
        trailer_block(&[
            ("Restores", Some(hash)),
            ("Vault-Chat-Actor", Some("human")),
            ("Vault-Chat-Machine", Some(machine)),
        ])
    );
    let (_, e, c) = git_as(repo, name, email, &["commit", "-q", "-m", &msg, "--", path])?;
    if c != 0 {
        return Err(format!("commit failed: {}", e.trim()));
    }
    let commit = git(repo, &["rev-parse", "HEAD"])?.trim().to_string();
    Ok(RestoreResult { commit, reloaded_paths: vec![path.to_string()] })
}

#[derive(Serialize, Debug)]
pub struct UndoResult {
    pub ok: bool,
    pub commit: Option<String>,
    pub conflicts: Vec<String>,
    pub changed_paths: Vec<String>,
}

fn git_dir_path(repo: &str, name: &str) -> Result<String, String> {
    let p = git(repo, &["rev-parse", "--git-path", name])?.trim().to_string();
    let pb = PathBuf::from(&p);
    Ok(if pb.is_absolute() { p } else { PathBuf::from(repo).join(pb).to_string_lossy().to_string() })
}

/// The tree that reverts `commits` (each `(commit, parent)`, newest first)
/// on top of HEAD, for content paths only. Err(conflicts) if it does not
/// merge cleanly. Touches nothing but the object store.
fn revert_tree(repo: &str, pairs: &[(String, String)], name: &str, email: &str) -> Result<Result<String, Vec<String>>, String> {
    let idx = git_dir_path(repo, "vc-history.index")?;
    let mut env_owned = identity_env(name, email);
    env_owned.push(("GIT_INDEX_FILE", idx.clone()));
    let env: Vec<(&str, &str)> = env_owned.iter().map(|(k, v)| (*k, v.as_str())).collect();
    let idenv: Vec<(&str, &str)> = env[..4].to_vec();
    let run = |args: &[&str], stdin: Option<&str>, e: &[(&str, &str)]| -> Result<String, String> {
        let (o, err, c) = git_full(repo, args, e, stdin)?;
        if c != 0 {
            return Err(format!("git {}: {}", args[0], err.trim()));
        }
        Ok(o.trim().to_string())
    };
    let mut ours = git(repo, &["rev-parse", "HEAD"])?.trim().to_string();
    let result = (|| -> Result<Result<String, Vec<String>>, String> {
        let mut tree = String::new();
        for (c, p) in pairs {
            // Noise paths this commit changed keep the commit's version in
            // "theirs", so the revert leaves app state alone.
            let raw = run(&["diff-tree", "-r", "--no-renames", "--raw", "--no-abbrev", p, c], None, &[])?;
            let mut info = String::new();
            for l in raw.lines() {
                let (meta, path) = match l.trim_start_matches(':').split_once('\t') {
                    Some(x) => x,
                    None => continue,
                };
                let m: Vec<&str> = meta.split_whitespace().collect();
                if m.len() < 5 {
                    continue;
                }
                let gitlink = m[0] == "160000" || m[1] == "160000";
                let path = unquote(path);
                if !(gitlink || is_noise_path(&path)) {
                    continue;
                }
                if m[1] == "000000" {
                    info.push_str(&format!("0 {}\t{}\n", "0".repeat(40), path));
                } else {
                    info.push_str(&format!("{} {}\t{}\n", m[1], m[3], path));
                }
            }
            let theirs_tree = if info.is_empty() {
                run(&["rev-parse", &format!("{}^{{tree}}", p)], None, &[])?
            } else {
                run(&["read-tree", p], None, &env)?;
                run(&["update-index", "--index-info"], Some(&info), &env)?;
                run(&["write-tree"], None, &env)?
            };
            let theirs = run(&["commit-tree", &theirs_tree, "-m", "vault-chat history: revert side"], None, &idenv)?;
            let mb = format!("--merge-base={}", c);
            let (o, err, code) = git_full(
                repo,
                &["merge-tree", "--write-tree", "--name-only", "--no-messages", &mb, &ours, &theirs],
                &[],
                None,
            )?;
            if code == 1 {
                let mut conflicts: Vec<String> = o.lines().skip(1).map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect();
                conflicts.sort();
                conflicts.dedup();
                return Ok(Err(conflicts));
            }
            if code != 0 {
                return Err(format!("merge-tree failed: {}", err.trim()));
            }
            tree = o.lines().next().unwrap_or("").trim().to_string();
            ours = run(&["commit-tree", &tree, "-p", &ours, "-m", "vault-chat history: revert step"], None, &idenv)?;
        }
        Ok(Ok(tree))
    })();
    let _ = std::fs::remove_file(&idx);
    result
}

/// The (commit, parent) pairs an entry reverts, newest first.
fn entry_pairs(e: &Entry, repo: &str) -> Result<Vec<(String, String)>, String> {
    let mut pairs = Vec::new();
    for c in e.commits.iter().rev() {
        let parent = format!("{}^1", c);
        let p = match git_full(repo, &["rev-parse", "--verify", "-q", &parent], &[], None)? {
            (o, _, 0) => o.trim().to_string(),
            _ => EMPTY_TREE.to_string(),
        };
        pairs.push((c.clone(), p));
    }
    Ok(pairs)
}

/// Undo an entry (or, for an undo entry, redo what it undid) as one commit.
/// Caller holds the repo lock and has flushed pending edits.
pub fn undo_entry(repo: &str, entry_id: &str, redo: bool, machine: &str, name: &str, email: &str) -> Result<UndoResult, String> {
    let gd = {
        let d = git(repo, &["rev-parse", "--git-dir"])?.trim().to_string();
        let pb = PathBuf::from(&d);
        if pb.is_absolute() {
            pb
        } else {
            PathBuf::from(repo).join(pb)
        }
    };
    if gd.join("MERGE_HEAD").exists() || gd.join("REVERT_HEAD").exists() || gd.join("CHERRY_PICK_HEAD").exists() {
        return Err("A merge is in progress in this vault; finish it first.".into());
    }
    let e = find_entry(repo, entry_id)?;
    if redo && !(e.kind == "undo" || e.kind == "redo") {
        return Err("Only an undo can be redone.".into());
    }
    if e.undone_by.is_some() {
        return Err("This change was already undone.".into());
    }
    let pairs = entry_pairs(&e, repo)?;
    let tree = match revert_tree(repo, &pairs, name, email)? {
        Ok(t) => t,
        Err(conflicts) => {
            return Ok(UndoResult { ok: false, commit: None, conflicts, changed_paths: vec![] });
        }
    };
    let head_tree = git(repo, &["rev-parse", "HEAD^{tree}"])?.trim().to_string();
    if tree == head_tree {
        return Err("Nothing to undo: those changes are already gone.".into());
    }
    let changed: Vec<String> = git(repo, &["diff", "--name-only", "--no-renames", "HEAD", &tree])?
        .lines()
        .map(|l| unquote(l))
        .filter(|l| !l.is_empty())
        .collect();
    let (_, err, c) = git_full(repo, &["read-tree", "-m", "-u", "HEAD", &tree], &[], None)?;
    if c != 0 {
        return Err(format!("Your unsaved changes would be overwritten: {}", err.trim()));
    }
    // Undoing an undo is a redo (and undoing a redo, an undo), titled by
    // the original change.
    let orig = e.title.trim_start_matches("Undo:").trim_start_matches("Redo:").trim();
    let title = match e.kind.as_str() {
        "undo" => format!("Redo: {}", orig),
        "redo" => format!("Undo: {}", orig),
        _ => format!("Undo: {}", e.title),
    };
    let msg = format!(
        "{}\n\n{}",
        title,
        trailer_block(&[
            ("Undoes", Some(&e.id)),
            ("Vault-Chat-Actor", Some("human")),
            ("Vault-Chat-Machine", Some(machine)),
        ])
    );
    let mut args: Vec<&str> = vec!["commit", "-q", "-m", &msg, "--"];
    for p in &changed {
        args.push(p);
    }
    let (_, err, c) = git_as(repo, name, email, &args)?;
    if c != 0 {
        // Put the index and worktree back exactly; nothing was committed.
        let _ = git_full(repo, &["read-tree", "-m", "-u", &tree, "HEAD"], &[], None);
        return Err(format!("commit failed: {}", err.trim()));
    }
    let commit = git(repo, &["rev-parse", "HEAD"])?.trim().to_string();
    Ok(UndoResult { ok: true, commit: Some(commit), conflicts: vec![], changed_paths: changed })
}

// ----- tauri commands -----

fn repo_path(vault: &str, repo: &Option<String>) -> String {
    match repo {
        Some(r) if !r.trim().is_empty() => PathBuf::from(vault).join(r).to_string_lossy().to_string(),
        _ => vault.to_string(),
    }
}

fn machine_for(vault: &str, machine: Option<String>) -> String {
    machine.unwrap_or_else(|| if crate::box_sync::box_mode_cached(vault) { "box".into() } else { "laptop".into() })
}

fn opts(include_noise: Option<bool>, gap_minutes: Option<i64>, path: Option<String>) -> Opts {
    Opts {
        include_noise: include_noise.unwrap_or(false),
        gap_secs: gap_minutes.map(|m| m.max(1) * 60).unwrap_or(DEFAULT_GAP_SECS),
        path: path.filter(|p| !p.is_empty()),
    }
}

#[tauri::command]
pub async fn history_timeline(
    vault: String,
    repo: Option<String>,
    cursor: Option<String>,
    limit: Option<usize>,
    path: Option<String>,
    include_noise: Option<bool>,
    gap_minutes: Option<i64>,
) -> Result<TimelinePage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let r = repo_path(&vault, &repo);
        timeline(&r, cursor.as_deref(), limit.unwrap_or(40), &opts(include_noise, gap_minutes, path))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn history_note_versions(
    vault: String,
    repo: Option<String>,
    path: String,
    cursor: Option<String>,
    limit: Option<usize>,
    gap_minutes: Option<i64>,
) -> Result<VersionsPage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let r = repo_path(&vault, &repo);
        note_versions(&r, &path, cursor.as_deref(), limit.unwrap_or(30), gap_minutes.map(|m| m.max(1) * 60).unwrap_or(DEFAULT_GAP_SECS))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn history_file_at(vault: String, repo: Option<String>, hash: String, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || file_at(&repo_path(&vault, &repo), &hash, &path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn history_diff(
    vault: String,
    repo: Option<String>,
    hash: String,
    path: String,
    against: Option<String>,
    base: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        diff(&repo_path(&vault, &repo), &hash, &path, against.as_deref().unwrap_or("disk"), base.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn history_restore_note(
    vault: String,
    repo: Option<String>,
    path: String,
    hash: String,
    machine: Option<String>,
) -> Result<RestoreResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let r = repo_path(&vault, &repo);
        let m = machine_for(&vault, machine);
        crate::with_repo_lock(&r, || {
            let (n, e) = crate::human_identity(&r);
            restore_note(&r, &path, &hash, &m, &n, &e)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn history_undo_entry(
    vault: String,
    repo: Option<String>,
    entry_id: String,
    machine: Option<String>,
) -> Result<UndoResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let r = repo_path(&vault, &repo);
        let m = machine_for(&vault, machine);
        crate::with_repo_lock(&r, || {
            let (n, e) = crate::human_identity(&r);
            undo_entry(&r, &entry_id, false, &m, &n, &e)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn history_redo_entry(
    vault: String,
    repo: Option<String>,
    undo_entry_id: String,
    machine: Option<String>,
) -> Result<UndoResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let r = repo_path(&vault, &repo);
        let m = machine_for(&vault, machine);
        crate::with_repo_lock(&r, || {
            let (n, e) = crate::human_identity(&r);
            undo_entry(&r, &undo_entry_id, true, &m, &n, &e)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static N: AtomicUsize = AtomicUsize::new(0);
    const T0: i64 = 1_790_000_000;

    struct Repo {
        dir: String,
    }

    impl Repo {
        fn new(tag: &str) -> Repo {
            let d = std::env::temp_dir().join(format!(
                "vc-history-{}-{}-{}",
                tag,
                std::process::id(),
                N.fetch_add(1, Ordering::SeqCst)
            ));
            let _ = fs::remove_dir_all(&d);
            fs::create_dir_all(&d).unwrap();
            let dir = d.to_string_lossy().replace('\\', "/");
            git(&dir, &["init", "-q", "-b", "master"]).unwrap();
            git(&dir, &["config", "user.name", "Test Human"]).unwrap();
            git(&dir, &["config", "user.email", "human@test"]).unwrap();
            git(&dir, &["config", "core.autocrlf", "false"]).unwrap();
            Repo { dir }
        }
        fn write(&self, rel: &str, text: &str) {
            let p = Path::new(&self.dir).join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, text).unwrap();
        }
        fn read(&self, rel: &str) -> Option<String> {
            fs::read_to_string(Path::new(&self.dir).join(rel)).ok()
        }
        /// `add -A` + commit at time `t` (like every vault-chat commit path).
        fn commit(&self, t: i64, msg: &str, author: (&str, &str)) -> String {
            git(&self.dir, &["add", "-A"]).unwrap();
            let date = format!("@{} +0000", t);
            let env = [
                ("GIT_AUTHOR_NAME", author.0),
                ("GIT_AUTHOR_EMAIL", author.1),
                ("GIT_COMMITTER_NAME", author.0),
                ("GIT_COMMITTER_EMAIL", author.1),
                ("GIT_AUTHOR_DATE", date.as_str()),
                ("GIT_COMMITTER_DATE", date.as_str()),
            ];
            let (_, e, c) = git_full(&self.dir, &["commit", "-q", "--allow-empty", "-m", msg], &env, None).unwrap();
            assert_eq!(c, 0, "{}", e);
            self.head()
        }
        fn human(&self, t: i64, msg: &str) -> String {
            self.commit(t, &format!("{}\n\nVault-Chat-Actor: human\nVault-Chat-Machine: laptop", msg), ("Test Human", "human@test"))
        }
        fn agent(&self, t: i64, msg: &str, conv: &str) -> String {
            self.commit(
                t,
                &format!("[agent] {}\n\nVault-Chat-Actor: agent\nVault-Chat-Machine: laptop\nConversation: {}", msg, conv),
                ("vault-chat-agent", "agent@vault-chat"),
            )
        }
        fn head(&self) -> String {
            git(&self.dir, &["rev-parse", "HEAD"]).unwrap().trim().to_string()
        }
        fn page(&self, o: &Opts) -> Vec<Entry> {
            timeline(&self.dir, None, 100, o).unwrap().entries
        }
        fn entries(&self) -> Vec<Entry> {
            self.page(&Opts::default())
        }
        fn undo(&self, id: &str) -> UndoResult {
            undo_entry(&self.dir, id, false, "laptop", "Test Human", "human@test").unwrap()
        }
        fn redo(&self, id: &str) -> UndoResult {
            undo_entry(&self.dir, id, true, "laptop", "Test Human", "human@test").unwrap()
        }
        /// HEAD, the index's tree, status + every worktree byte, mid-op flag.
        fn git_state(&self) -> (String, String, String, bool) {
            let head = self.head();
            let index = git(&self.dir, &["write-tree"]).unwrap().trim().to_string();
            let status = git(&self.dir, &["status", "--porcelain", "--untracked-files=all"]).unwrap();
            let gd = Path::new(&self.dir).join(".git");
            let mid = gd.join("MERGE_HEAD").exists() || gd.join("REVERT_HEAD").exists() || gd.join("CHERRY_PICK_HEAD").exists();
            (head, index, status + &self.tree_digest(), mid)
        }
        /// Every worktree file (incl. .vault-chat) with its content.
        fn tree_digest(&self) -> String {
            let mut out = Vec::new();
            walk(Path::new(&self.dir), Path::new(&self.dir), &mut out);
            out.sort();
            out.join("\n")
        }
        fn vault_chat_digest(&self) -> String {
            self.tree_digest().lines().filter(|l| l.starts_with(".vault-chat/")).collect::<Vec<_>>().join("\n")
        }
        fn content_digest(&self) -> String {
            self.tree_digest().lines().filter(|l| !l.starts_with(".vault-chat/")).collect::<Vec<_>>().join("\n")
        }
    }

    fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) {
        for e in fs::read_dir(dir).unwrap() {
            let e = e.unwrap();
            let p = e.path();
            let rel = p.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
            if rel == ".git" {
                continue;
            }
            if p.is_dir() {
                walk(root, &p, out);
            } else {
                // one line per file, newlines escaped so lines() splits files
                out.push(format!("{}={}", rel, fs::read_to_string(&p).unwrap_or_default().replace('\n', "\\n")));
            }
        }
    }

    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    fn note(title: &str, lines: usize) -> String {
        let mut s = format!("# {}\n\n", title);
        for i in 0..lines {
            s.push_str(&format!("- point {} about {}: the working picture holds.\n", i, title));
        }
        s
    }

    fn noise(r: &Repo, t: i64, i: usize) {
        r.write(".vault-chat/conversations/c1.jsonl", &format!("{{\"turn\":{}}}\n", i));
        r.commit(t, "vault-chat: auto-sync\n\nVault-Chat-Actor: sync\nVault-Chat-Machine: laptop", ("Test Human", "human@test"));
    }

    #[test]
    fn noise_paths() {
        assert!(is_noise_path(".vault-chat/conversations/x.jsonl"));
        assert!(is_noise_path(".gitignore"));
        assert!(is_noise_path("sub/.gitattributes"));
        assert!(!is_noise_path("notes/vault-chat.md"));
        assert!(!is_noise_path("notes/a.md"));
    }

    #[test]
    fn history_grouping_sessions_noise_and_sync_merges() {
        let r = Repo::new("group");
        r.write("a.md", &note("a", 5));
        r.write("b.md", &note("b", 5));
        r.human(T0, "edit 2 files");
        r.write("a.md", &note("a", 6));
        r.human(T0 + 60, "edit a.md");
        noise(&r, T0 + 90, 1);
        r.write("b.md", &note("b", 7));
        r.human(T0 + 120, "edit b.md");
        // An agent turn in a conversation.
        r.write("c.md", &note("c", 3));
        r.agent(T0 + 200, "wrote c", "conv-1");
        noise(&r, T0 + 230, 2);
        // The human again, right after: a new session (another actor between).
        r.write("a.md", &note("a", 8));
        r.human(T0 + 300, "edit a.md");
        // An old-style commit with no trailers is classified by its subject.
        r.write("c.md", &note("c", 4));
        r.commit(T0 + 320, "[agent] legacy turn", ("vault-chat-agent", "agent@x"));
        // 30 minutes later: a new human session.
        r.write("b.md", &note("b", 9));
        r.human(T0 + 2200, "edit b.md");
        // A sync merge from the box: flattened, its commit is its own session.
        git(&r.dir, &["checkout", "-q", "-b", "box"]).unwrap();
        r.write("d.md", &note("d", 2));
        r.commit(T0 + 2300, "edit d.md\n\nVault-Chat-Actor: human\nVault-Chat-Machine: box", ("carlwilsn", "c@box"));
        git(&r.dir, &["checkout", "-q", "master"]).unwrap();
        noise(&r, T0 + 2350, 3);
        r.commit(T0 + 2400, "x", ("Test Human", "human@test")); // empty: noise
        let env_date = format!("@{} +0000", T0 + 2500);
        let (_, e, c) = git_full(
            &r.dir,
            &["merge", "--no-ff", "-q", "-m", "Merge remote-tracking branch 'origin/master'\n\nVault-Chat-Actor: sync", "box"],
            &[("GIT_AUTHOR_DATE", &env_date), ("GIT_COMMITTER_DATE", &env_date)],
            None,
        )
        .unwrap();
        assert_eq!(c, 0, "{}", e);

        let es = r.entries();
        let kinds: Vec<(String, String, Option<String>, usize)> =
            es.iter().map(|e| (e.actor.clone(), e.title.clone(), e.machine.clone(), e.commits.len())).collect();
        assert_eq!(es.len(), 6, "{:#?}", kinds);
        // newest first: box d.md, human b.md, agent legacy, human a.md, agent c.md, human a+b (3 commits)
        assert_eq!(es[0].machine.as_deref(), Some("box"), "{:#?}", kinds);
        assert_eq!(es[0].title, "Created d.md");
        assert_eq!(es[1].title, "Edited b.md");
        assert_eq!(es[1].machine.as_deref(), Some("laptop"));
        assert_eq!(es[2].actor, "agent");
        assert_eq!(es[2].summary.as_deref(), Some("legacy turn"));
        assert_eq!(es[3].actor, "human");
        assert_eq!(es[3].title, "Edited a.md");
        assert_eq!(es[4].actor, "agent");
        assert_eq!(es[4].conversation_id.as_deref(), Some("conv-1"));
        assert_eq!(es[4].summary.as_deref(), Some("wrote c"));
        assert_eq!(es[5].commits.len(), 3, "{:#?}", kinds);
        assert!(es[5].title == "Created b.md, a.md" || es[5].title == "Created a.md, b.md", "{}", es[5].title);
        assert_eq!(es[5].start, T0);
        assert_eq!(es[5].end, T0 + 120);
        for e in &es {
            assert!(e.files.iter().all(|f| !f.path.starts_with(".vault-chat")));
            assert!(!e.noise);
        }
        // With noise: the app-state commits show (and the merge stays flattened).
        let noisy = r.page(&Opts { include_noise: true, ..Opts::default() });
        assert!(noisy.iter().any(|e| e.noise && e.files.iter().any(|f| f.path.starts_with(".vault-chat/"))));
        assert!(noisy.len() > es.len());
        // Paging: limit 3 walks the same entries.
        let p1 = timeline(&r.dir, None, 3, &Opts::default()).unwrap();
        assert_eq!(p1.entries.len(), 3);
        let p2 = timeline(&r.dir, p1.next_cursor.as_deref(), 3, &Opts::default()).unwrap();
        assert_eq!(p2.entries.len(), 3);
        assert_eq!(p2.entries[0].id, es[3].id);
        assert!(p2.next_cursor.is_none());
        // A 30 s gap splits the first sitting into its three commits.
        let narrow = r.page(&Opts { gap_secs: 30, ..Opts::default() });
        assert_eq!(narrow.len(), 8);
    }

    #[test]
    fn history_attribution_trailers_win_over_author() {
        let r = Repo::new("attr");
        r.write("a.md", "one\n");
        // Swept by the 12 s loop as the human identity, but tagged agent.
        r.commit(T0, "vault-chat: local autosave\n\nVault-Chat-Actor: agent\nVault-Chat-Machine: laptop\nConversation: c9", ("Test Human", "human@test"));
        let es = r.entries();
        assert_eq!(es[0].actor, "agent");
        assert_eq!(es[0].conversation_id.as_deref(), Some("c9"));
        assert_eq!(es[0].machine.as_deref(), Some("laptop"));
        let m = crate::with_actor_trailers(&r.dir, "[agent] x", true, None, Some("laptop".into()), Some("c1".into()));
        assert!(m.ends_with("\n\nVault-Chat-Actor: agent\nVault-Chat-Machine: laptop\nConversation: c1"), "{}", m);
    }

    #[test]
    fn history_session_undo_redo_never_touches_vault_chat() {
        let r = Repo::new("undo");
        r.write("a.md", &note("a", 4));
        r.write("b.md", &note("b", 4));
        r.write(".vault-chat/state.json", "{\"v\":1}\n");
        r.human(T0, "start");
        // One session: a.md then b.md, app state swept along.
        r.write("a.md", &note("a", 5));
        r.write(".vault-chat/state.json", "{\"v\":2}\n");
        r.human(T0 + 1000, "edit a.md");
        r.write("b.md", &note("b", 6));
        r.human(T0 + 1060, "edit b.md");
        // Later work by the agent on another note.
        r.write("c.md", "agent note\n");
        r.agent(T0 + 3000, "c", "conv");
        r.write(".vault-chat/state.json", "{\"v\":3}\n");
        r.human(T0 + 3100, "autosave"); // noise only
        // An uncommitted app-state write (a conversation streaming).
        r.write(".vault-chat/live.jsonl", "streaming\n");
        let vc_before = r.vault_chat_digest();

        let es = r.entries();
        let session = es.iter().find(|e| e.commits.len() == 2).expect("session");
        let res = r.undo(&session.id);
        assert!(res.ok, "{:?}", res);
        assert_eq!(r.read("a.md").unwrap(), note("a", 4));
        assert_eq!(r.read("b.md").unwrap(), note("b", 4));
        assert_eq!(r.read("c.md").unwrap(), "agent note\n");
        assert_eq!(r.vault_chat_digest(), vc_before, ".vault-chat must be byte-identical");
        let mut changed = res.changed_paths.clone();
        changed.sort();
        assert_eq!(changed, vec!["a.md".to_string(), "b.md".to_string()]);
        let (_, _, _, mid) = r.git_state();
        assert!(!mid);
        let msg = git(&r.dir, &["log", "-1", "--format=%B"]).unwrap();
        assert!(msg.starts_with("Undo: "));
        assert!(msg.contains(&format!("Undoes: {}", session.id)));
        // The timeline links them.
        let es = r.entries();
        let undo = &es[0];
        assert_eq!(undo.kind, "undo");
        assert_eq!(undo.undoes.as_deref(), Some(session.id.as_str()));
        let target = es.iter().find(|e| e.id == session.id).unwrap();
        assert_eq!(target.undone_by.as_deref(), Some(undo.id.as_str()));
        // Undoing it twice is refused.
        assert!(undo_entry(&r.dir, &session.id, false, "laptop", "Test Human", "human@test").is_err());
        // Redo = revert the undo.
        let rd = r.redo(&undo.id);
        assert!(rd.ok);
        assert_eq!(r.read("a.md").unwrap(), note("a", 5));
        assert_eq!(r.read("b.md").unwrap(), note("b", 6));
        assert_eq!(r.vault_chat_digest(), vc_before);
        let es = r.entries();
        assert_eq!(es[0].kind, "redo");
        assert!(es[0].title.starts_with("Redo: Edited"), "{}", es[0].title);
        let target = es.iter().find(|e| e.id == session.id).unwrap();
        assert!(target.undone_by.is_none(), "redo makes the original live again");
        let undo = es.iter().find(|e| e.kind == "undo").unwrap();
        assert_eq!(undo.undone_by.as_deref(), Some(es[0].id.as_str()));
        // Only an undo can be redone.
        assert!(undo_entry(&r.dir, &session.id, true, "laptop", "Test Human", "human@test").is_err());
    }

    #[test]
    fn history_restore_note_and_versions() {
        let r = Repo::new("restore");
        r.write("n.md", "v1\n");
        r.human(T0, "create n.md");
        r.write("n.md", "v2\n");
        r.human(T0 + 30, "edit n.md");
        r.write("n.md", "v3\n");
        r.human(T0 + 60, "edit n.md");
        let v3 = r.head();
        r.write("n.md", "v4\nmore\n");
        r.agent(T0 + 4000, "rewrote n", "c1");
        r.write("other.md", "x\n");
        r.human(T0 + 9000, "edit other.md");

        let vs = note_versions(&r.dir, "n.md", None, 30, DEFAULT_GAP_SECS).unwrap();
        assert_eq!(vs.versions.len(), 2, "{:?}", vs.versions);
        assert_eq!(vs.versions[0].actor, "agent");
        assert_eq!(vs.versions[0].summary.as_deref(), Some("rewrote n"));
        assert_eq!(vs.versions[0].add, 2);
        assert_eq!(vs.versions[1].hash, v3);
        assert_eq!(vs.versions[1].commits, 3);
        assert_eq!(file_at(&r.dir, &v3, "n.md").unwrap(), "v3\n");
        let d = diff(&r.dir, &v3, "n.md", "disk", None).unwrap();
        assert!(d.contains("+v3") && d.contains("-v4"), "{}", d);
        // Disk mode sees an unsaved edit (HEAD mode would not).
        r.write("n.md", "v4\nmore\npending\n");
        let d = diff(&r.dir, &v3, "n.md", "disk", None).unwrap();
        assert!(d.contains("-pending"), "{}", d);
        r.write("n.md", "v4\nmore\n");
        let d = diff(&r.dir, &vs.versions[0].hash, "n.md", "hash", Some(&v3)).unwrap();
        assert!(d.contains("+more"));

        let vc = r.vault_chat_digest();
        let res = restore_note(&r.dir, "n.md", &v3, "laptop", "Test Human", "human@test").unwrap();
        assert_eq!(res.reloaded_paths, vec!["n.md".to_string()]);
        assert_eq!(r.read("n.md").unwrap(), "v3\n");
        assert_eq!(r.read("other.md").unwrap(), "x\n");
        assert_eq!(r.vault_chat_digest(), vc);
        let msg = git(&r.dir, &["log", "-1", "--format=%B"]).unwrap();
        assert!(msg.starts_with("Restore n.md to "), "{}", msg);
        assert!(msg.contains(&format!("Restores: {}", v3)));
        let es = r.entries();
        assert_eq!(es[0].kind, "restore");
        assert_eq!(es[0].restores.as_deref(), Some(v3.as_str()));
        // Versions: the restore is its own version.
        let vs = note_versions(&r.dir, "n.md", None, 30, DEFAULT_GAP_SECS).unwrap();
        assert_eq!(vs.versions[0].kind, "restore");
        // Same version again: refused, nothing committed.
        let head = r.head();
        assert!(restore_note(&r.dir, "n.md", &v3, "laptop", "Test Human", "human@test").is_err());
        assert_eq!(r.head(), head);
        // Never app state.
        assert!(restore_note(&r.dir, ".vault-chat/x.json", &v3, "laptop", "Test Human", "human@test").is_err());
        // The restore itself can be undone like any entry.
        let u = r.undo(&es[0].id);
        assert!(u.ok);
        assert_eq!(r.read("n.md").unwrap(), "v4\nmore\n");
        // Restoring to a version where the note did not exist deletes it.
        let first = git(&r.dir, &["rev-list", "--max-parents=0", "HEAD"]).unwrap().trim().to_string();
        restore_note(&r.dir, "other.md", &first, "laptop", "Test Human", "human@test").unwrap();
        assert!(r.read("other.md").is_none());
        // Paging of versions.
        let p = note_versions(&r.dir, "n.md", None, 1, DEFAULT_GAP_SECS).unwrap();
        assert_eq!(p.versions.len(), 1);
        let p2 = note_versions(&r.dir, "n.md", p.next_cursor.as_deref(), 1, DEFAULT_GAP_SECS).unwrap();
        assert_eq!(p2.versions.len(), 1);
        assert_ne!(p2.versions[0].hash, p.versions[0].hash);
    }

    /// UC9: a kept mission is one undoable entry.
    struct Uc9 {
        r: Repo,
        before_merge: String,
    }

    fn uc9_setup(tag: &str) -> Uc9 {
        let r = Repo::new(tag);
        for n in 1..=4 {
            r.write(&format!("notes/n{}.md", n), &note(&format!("n{}", n), 12));
        }
        r.write(".vault-chat/conversations/c.jsonl", "{}\n");
        r.human(T0, "start");
        // The mission branch: 4 commits.
        git(&r.dir, &["checkout", "-q", "-b", "mission/x"]).unwrap();
        r.write("missions/x/MISSION.md", "# Mission x\n\nTighten notes 1-3.\n");
        r.commit(T0 + 100, "mission: plan\n\nVault-Chat-Actor: mission\nMission-Id: x", ("vault-chat-agent", "a@x"));
        let n1 = note("n1", 12).replace("point 3 about n1", "point 3 about n1 (tightened)");
        r.write("notes/n1.md", &n1);
        r.commit(T0 + 200, "mission: n1\n\nVault-Chat-Actor: mission\nMission-Id: x", ("vault-chat-agent", "a@x"));
        let n2 = note("n2", 12).replace("point 1 about n2", "point 1 about n2 (tightened)");
        r.write("notes/n2.md", &n2);
        r.write(".vault-chat/missions/x.json", "{\"step\":3}\n");
        r.commit(T0 + 300, "mission: n2\n\nVault-Chat-Actor: mission\nMission-Id: x", ("vault-chat-agent", "a@x"));
        let n3 = note("n3", 12).replace("point 5 about n3", "point 5 about n3 (tightened)");
        r.write("notes/n3.md", &n3);
        r.write("missions/x/progress.md", "done\n");
        r.commit(T0 + 400, "mission: n3\n\nVault-Chat-Actor: mission\nMission-Id: x", ("vault-chat-agent", "a@x"));
        git(&r.dir, &["checkout", "-q", "master"]).unwrap();
        // Meanwhile on main: two human sessions and 20 noise commits.
        r.write("notes/n4.md", &note("n4", 13));
        r.human(T0 + 1000, "edit notes/n4.md");
        for i in 0..10 {
            noise(&r, T0 + 1010 + i as i64, i);
        }
        let n2_main = note("n2", 12).replace("point 10 about n2", "point 10 about n2 (human)");
        r.write("notes/n2.md", &n2_main);
        r.human(T0 + 2000, "edit notes/n2.md");
        for i in 10..20 {
            noise(&r, T0 + 2100 + i as i64, i);
        }
        let before_merge = r.head();
        // Keep.
        let date = format!("@{} +0000", T0 + 3000);
        let (_, e, c) = git_full(
            &r.dir,
            &["merge", "--no-ff", "-q", "-m", "Mission: Tighten notes\n\nMission-Id: x\nVault-Chat-Actor: mission\nCost-Usd: 1.25", "mission/x"],
            &[("GIT_AUTHOR_DATE", &date), ("GIT_COMMITTER_DATE", &date)],
            None,
        )
        .unwrap();
        assert_eq!(c, 0, "{}", e);
        Uc9 { r, before_merge }
    }

    fn content_at(r: &Repo, rev: &str) -> Vec<(String, String)> {
        let out = git(&r.dir, &["ls-tree", "-r", "--name-only", rev]).unwrap();
        out.lines()
            .filter(|p| !is_noise_path(p))
            .map(|p| (p.to_string(), git(&r.dir, &["show", &format!("{}:{}", rev, p)]).unwrap()))
            .collect()
    }

    #[test]
    fn history_mission_undo() {
        let u = uc9_setup("uc9");
        let r = &u.r;
        // 1. The timeline.
        let es = r.entries();
        let missions: Vec<&Entry> = es.iter().filter(|e| e.kind == "mission").collect();
        assert_eq!(missions.len(), 1, "{:#?}", es.iter().map(|e| &e.title).collect::<Vec<_>>());
        let m = missions[0];
        assert_eq!(m.title, "Tighten notes");
        assert_eq!(m.mission_id.as_deref(), Some("x"));
        assert_eq!(m.cost_usd, Some(1.25));
        let mut paths: Vec<&str> = m.files.iter().map(|f| f.path.as_str()).collect();
        paths.sort();
        assert_eq!(paths, vec!["missions/x/MISSION.md", "missions/x/progress.md", "notes/n1.md", "notes/n2.md", "notes/n3.md"]);
        assert_eq!(m.inner.len(), 4);
        for e in es.iter().filter(|e| e.kind != "mission") {
            for c in &m.inner {
                assert!(!e.commits.contains(&c.hash), "inner commit leaked into {}", e.title);
            }
            assert!(!e.noise);
        }
        let humans: Vec<&Entry> = es.iter().filter(|e| e.actor == "human").collect();
        assert_eq!(humans.len(), 3, "start + two sessions");
        // A human edit after the keep.
        r.write("notes/n4.md", &note("n4", 14));
        r.human(T0 + 5000, "edit notes/n4.md");
        let after_human = r.head();
        r.write(".vault-chat/conversations/c.jsonl", "{}\n{\"live\":1}\n"); // uncommitted
        let vc_before = r.vault_chat_digest();

        // 2. Undo the mission.
        let count = |r: &Repo| -> usize { git(&r.dir, &["rev-list", "--count", "HEAD"]).unwrap().trim().parse().unwrap() };
        let commits_before = count(r);
        let res = r.undo(&m.id);
        assert!(res.ok, "{:?}", res);
        assert_eq!(count(r), commits_before + 1);
        let mut expect = content_at(r, &u.before_merge);
        for (p, t) in expect.iter_mut() {
            if p == "notes/n4.md" {
                *t = note("n4", 14);
            }
        }
        assert_eq!(content_at(r, "HEAD"), expect);
        assert!(r.read("missions/x/MISSION.md").is_none());
        assert_eq!(r.vault_chat_digest(), vc_before);
        let status = git(&r.dir, &["status", "--porcelain"]).unwrap();
        assert_eq!(status.trim(), "M .vault-chat/conversations/c.jsonl");
        let (_, _, _, mid) = r.git_state();
        assert!(!mid);
        let es = r.entries();
        let m2 = es.iter().find(|e| e.id == m.id).unwrap();
        assert_eq!(m2.undone_by.as_deref(), Some(es[0].id.as_str()));

        // 3. Redo → the state after the keep (+ the later human edit).
        let rd = r.redo(&es[0].id);
        assert!(rd.ok, "{:?}", rd);
        assert_eq!(content_at(r, "HEAD"), content_at(r, &after_human));
        assert_eq!(r.vault_chat_digest(), vc_before);
    }

    #[test]
    fn history_mission_undo_conflict_leaves_repo_untouched() {
        let u = uc9_setup("uc9c");
        let r = &u.r;
        let m = r.entries().into_iter().find(|e| e.kind == "mission").unwrap();
        // A human edits the same line the mission changed, after the keep.
        let n1 = r.read("notes/n1.md").unwrap().replace("point 3 about n1 (tightened)", "point 3 about n1 (tightened, then mine)");
        r.write("notes/n1.md", &n1);
        r.human(T0 + 5000, "edit notes/n1.md");
        r.write(".vault-chat/conversations/c.jsonl", "dirty\n");
        let before = r.git_state();
        let res = r.undo(&m.id);
        assert!(!res.ok);
        assert_eq!(res.conflicts, vec!["notes/n1.md".to_string()]);
        assert_eq!(r.git_state(), before, "HEAD, index and worktree unchanged");
    }

    /// A tiny deterministic RNG.
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> u64 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            self.0 >> 33
        }
        fn pick(&mut self, n: usize) -> usize {
            (self.next() % n as u64) as usize
        }
    }

    #[test]
    fn history_fuzz_keep_undo_redo_edit() {
        let ops: usize = std::env::var("VC_HISTORY_FUZZ_OPS").ok().and_then(|v| v.parse().ok()).unwrap_or(200);
        let r = Repo::new("fuzz");
        let names = ["n0.md", "n1.md", "n2.md", "n3.md"];
        for n in names {
            r.write(n, &note(n, 10));
        }
        r.write(".vault-chat/s.json", "0\n");
        let first = r.human(T0, "start");
        let mut rng = Lcg(42);
        let mut t = T0 + 1000;
        let mut missions = 0;
        let (mut undos, mut redos, mut conflicts) = (0, 0, 0);
        for step in 0..ops {
            t += 700; // every op its own session
            let before_content = r.content_digest();
            let before_vc = r.vault_chat_digest();
            let mut kind = "skip";
            match rng.pick(10) {
                0..=3 => {
                    kind = "edit";
                    // A human edit (sometimes with app state swept along).
                    let n = names[rng.pick(names.len())];
                    let mut lines: Vec<String> = r.read(n).unwrap_or_default().lines().map(|s| s.to_string()).collect();
                    if lines.is_empty() {
                        lines.push(format!("# {}", n));
                    }
                    let i = rng.pick(lines.len());
                    lines[i] = format!("{} [edit {}]", lines[i], step);
                    r.write(n, &(lines.join("\n") + "\n"));
                    if rng.pick(2) == 0 {
                        r.write(".vault-chat/s.json", &format!("{}\n", step));
                    }
                    r.human(t, &format!("edit {}", n));
                }
                4 => {
                    kind = "keep";
                    // Keep a mission that edits one note and adds a folder.
                    missions += 1;
                    let b = format!("mission/m{}", missions);
                    git(&r.dir, &["checkout", "-q", "-b", &b]).unwrap();
                    let n = names[rng.pick(names.len())];
                    let text = r.read(n).unwrap_or_default();
                    r.write(n, &format!("{}mission {} line\n", text, missions));
                    r.write(&format!("missions/m{}/MISSION.md", missions), "m\n");
                    r.commit(t, &format!("m\n\nMission-Id: m{}", missions), ("vault-chat-agent", "a@x"));
                    git(&r.dir, &["checkout", "-q", "master"]).unwrap();
                    let date = format!("@{} +0000", t + 1);
                    let msg = format!("Mission: m{}\n\nMission-Id: m{}\nVault-Chat-Actor: mission", missions, missions);
                    let (_, e, c) = git_full(&r.dir, &["merge", "--no-ff", "-q", "-m", &msg, &b], &[("GIT_AUTHOR_DATE", &date), ("GIT_COMMITTER_DATE", &date)], None).unwrap();
                    assert_eq!(c, 0, "{}", e);
                }
                5..=7 => {
                    let es = r.entries();
                    let cands: Vec<&Entry> = es.iter().filter(|e| e.undone_by.is_none() && e.id != first).collect();
                    if !cands.is_empty() {
                        kind = "undo";
                        let e = cands[rng.pick(cands.len())];
                        let touched: HashSet<String> = e.files.iter().map(|f| f.path.clone()).collect();
                        match undo_entry(&r.dir, &e.id, false, "laptop", "Test Human", "human@test") {
                            Ok(res) if res.ok => {
                                undos += 1;
                                // Every file the entry did not touch is unchanged.
                                let after = r.content_digest();
                                for l in before_content.lines() {
                                    let p = l.split('=').next().unwrap();
                                    if !touched.contains(p) {
                                        assert!(after.lines().any(|x| x == l), "step {}: {} changed", step, p);
                                    }
                                }
                            }
                            Ok(res) => {
                                conflicts += 1;
                                assert!(!res.conflicts.is_empty());
                                assert_eq!(r.content_digest(), before_content, "step {}: conflict changed the tree", step);
                            }
                            Err(msg) => assert!(msg.contains("already gone") || msg.contains("already undone"), "{}", msg),
                        }
                    }
                }
                _ => {
                    let es = r.entries();
                    let cands: Vec<&Entry> = es.iter().filter(|e| (e.kind == "undo" || e.kind == "redo") && e.undone_by.is_none()).collect();
                    if !cands.is_empty() {
                        kind = "redo";
                        let e = cands[rng.pick(cands.len())];
                        match undo_entry(&r.dir, &e.id, true, "laptop", "Test Human", "human@test") {
                            Ok(res) if res.ok => redos += 1,
                            Ok(_) => {
                                conflicts += 1;
                                assert_eq!(r.content_digest(), before_content);
                            }
                            Err(msg) => assert!(msg.contains("already gone") || msg.contains("already undone"), "{}", msg),
                        }
                    }
                }
            }
            // Invariants after every op.
            let (_, _, _, mid) = r.git_state();
            assert!(!mid, "step {}: left mid-merge/revert", step);
            let porcelain = git(&r.dir, &["status", "--porcelain"]).unwrap();
            assert!(porcelain.trim().is_empty(), "step {} ({}): dirty: {}", step, kind, porcelain);
            if kind != "edit" {
                assert_eq!(r.vault_chat_digest(), before_vc, "step {} ({}): app state changed", step, kind);
            }
        }
        eprintln!("fuzz: {} ops, {} missions, {} undos, {} redos, {} conflicts", ops, missions, undos, redos, conflicts);
        assert!(undos > 5 && redos > 0);
    }

    /// Grouping and speed on a large synthetic history shaped like a real
    /// vault's (86% app-state churn, sessions with gaps).
    #[test]
    fn history_perf_synthetic_large() {
        let total: usize = std::env::var("VC_HISTORY_PERF_COMMITS").ok().and_then(|v| v.parse().ok()).unwrap_or(12000);
        let r = Repo::new("perf");
        let mut s = String::new();
        let mut rng = Lcg(7);
        let mut t = T0;
        let mut mark = 0usize;
        let mut sessions = 0usize;
        let mut last_content_t = 0i64;
        let mut last_actor = "";
        let mut prev_commit = 0usize;
        for i in 0..total {
            let content = i == 0 || rng.pick(100) < 14;
            t += if rng.pick(40) == 0 { 3600 } else { 15 + rng.pick(60) as i64 };
            let (path, data, actor) = if content {
                let n = rng.pick(200);
                let actor = if rng.pick(4) == 0 { "agent" } else { "human" };
                if t - last_content_t > DEFAULT_GAP_SECS || actor != last_actor {
                    sessions += 1;
                }
                last_content_t = t;
                last_actor = actor;
                (format!("notes/n{}.md", n), format!("# n{}\n\nline {}\n", n, i), actor)
            } else {
                (format!(".vault-chat/conversations/c{}.jsonl", rng.pick(5)), format!("{{\"i\":{}}}\n", i), "sync")
            };
            let msg = format!(
                "{}\n\nVault-Chat-Actor: {}\nVault-Chat-Machine: laptop\n",
                if actor == "sync" { "vault-chat: auto-sync" } else { "edit" },
                actor
            );
            mark += 1;
            let blob = mark;
            s.push_str(&format!("blob\nmark :{}\ndata {}\n{}\n", blob, data.len(), data));
            mark += 1;
            s.push_str(&format!(
                "commit refs/heads/master\nmark :{}\nauthor T <t@t> {} +0000\ncommitter T <t@t> {} +0000\ndata {}\n{}\n",
                mark,
                t,
                t,
                msg.len(),
                msg
            ));
            if prev_commit > 0 {
                s.push_str(&format!("from :{}\n", prev_commit));
            }
            s.push_str(&format!("M 100644 :{} {}\n\n", blob, path));
            prev_commit = mark;
        }
        let (_, e, c) = git_full(&r.dir, &["fast-import", "--quiet"], &[], Some(&s)).unwrap();
        assert_eq!(c, 0, "{}", e);
        git(&r.dir, &["reset", "-q", "--hard", "master"]).unwrap();

        let t0 = std::time::Instant::now();
        let p1 = timeline(&r.dir, None, 40, &Opts::default()).unwrap();
        let first = t0.elapsed();
        let t1 = std::time::Instant::now();
        let p2 = timeline(&r.dir, p1.next_cursor.as_deref(), 40, &Opts::default()).unwrap();
        let second = t1.elapsed();
        let t2 = std::time::Instant::now();
        let again = timeline(&r.dir, None, 40, &Opts::default()).unwrap();
        let cached = t2.elapsed();
        assert_eq!(again.entries[0].id, p1.entries[0].id);
        assert_eq!(p1.entries.len(), 40);
        assert_eq!(p2.entries.len(), 40);
        // Walk to the end.
        let t3 = std::time::Instant::now();
        let mut cursor = p2.next_cursor.clone();
        let mut count = 80;
        while let Some(c) = cursor {
            let p = timeline(&r.dir, Some(&c), 200, &Opts::default()).unwrap();
            count += p.entries.len();
            cursor = p.next_cursor;
        }
        let full = t3.elapsed();
        let t4 = std::time::Instant::now();
        let vs = note_versions(&r.dir, "notes/n3.md", None, 30, DEFAULT_GAP_SECS).unwrap();
        let versions = t4.elapsed();
        eprintln!(
            "perf: {} commits, {} sessions expected, {} entries; first page {:?}, next page {:?}, cached {:?}, rest {:?}, note versions {:?} ({} versions)",
            total, sessions, count, first, second, cached, full, versions, vs.versions.len()
        );
        assert_eq!(count, sessions, "every session exactly once");
        assert!(first.as_millis() < 1500, "first page {:?}", first);
        assert!(versions.as_millis() < 1500, "versions {:?}", versions);
    }
}
