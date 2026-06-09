use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::Command;
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

use std::sync::OnceLock;

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

// Windows: probe once for Git Bash and reuse the result for every
// bash_exec call. Picking bash.exe over `cmd /C` makes the Bash tool
// usable for agents — cmd's quote handling mangles any command with
// embedded quotes (e.g. `gh repo create --description "foo bar"`
// becomes two args), and POSIX commands the agent reaches for by
// default (head/ls/sed/awk) just don't exist. If Git for Windows
// isn't installed, fall back to cmd so we degrade rather than break.
#[cfg(windows)]
static GIT_BASH_PATH: OnceLock<Option<PathBuf>> = OnceLock::new();

#[cfg(windows)]
fn find_git_bash() -> Option<PathBuf> {
    GIT_BASH_PATH
        .get_or_init(|| {
            // Check the canonical install locations first — fastest
            // path, no subprocess. Order: 64-bit machine install,
            // 32-bit machine install, per-user install.
            let candidates = [
                std::env::var("ProgramFiles")
                    .ok()
                    .map(|p| PathBuf::from(p).join("Git").join("bin").join("bash.exe")),
                std::env::var("ProgramFiles(x86)")
                    .ok()
                    .map(|p| PathBuf::from(p).join("Git").join("bin").join("bash.exe")),
                std::env::var("LocalAppData").ok().map(|p| {
                    PathBuf::from(p)
                        .join("Programs")
                        .join("Git")
                        .join("bin")
                        .join("bash.exe")
                }),
            ];
            for c in candidates.into_iter().flatten() {
                if c.is_file() {
                    return Some(c);
                }
            }
            // Last resort: ask PATH. `where bash` returns 0 + a list
            // of matching paths if found. Skipped silently if `where`
            // itself isn't available (vanishingly rare on Windows).
            use std::os::windows::process::CommandExt;
            let out = Command::new("where")
                .arg("bash")
                .creation_flags(0x08000000)
                .output()
                .ok()?;
            if !out.status.success() {
                return None;
            }
            let first = String::from_utf8_lossy(&out.stdout)
                .lines()
                .map(str::trim)
                .find(|l| !l.is_empty())?
                .to_string();
            let p = PathBuf::from(first);
            if p.is_file() {
                Some(p)
            } else {
                None
            }
        })
        .clone()
}

#[derive(Serialize)]
struct ShellKind {
    kind: String,        // "git-bash" | "cmd" | "bash"
    path: Option<String>,
}

#[tauri::command]
fn bash_shell_kind() -> ShellKind {
    #[cfg(windows)]
    {
        if let Some(p) = find_git_bash() {
            return ShellKind {
                kind: "git-bash".into(),
                path: Some(p.to_string_lossy().to_string()),
            };
        }
        ShellKind { kind: "cmd".into(), path: None }
    }
    #[cfg(not(windows))]
    {
        ShellKind { kind: "bash".into(), path: None }
    }
}

// Fire a `file-changed` event with the absolute path. Subscribed to by
// viewers that need to react to disk mutations they didn't initiate —
// currently just TexView, which uses it to debounce-recompile when the
// agent edits the .tex file backing the open preview, but the channel
// is intentionally generic so future viewers can opt in.
fn emit_file_changed(app: &AppHandle, path: &str) {
    let _ = app.emit("file-changed", path.to_string());
}

const IGNORE_FILE: &str = ".vaultchatignore";
// Sibling list to .vaultchatignore. Same line format (one relative
// path per line, # for comments). Where IGNORE only hides entries
// from the file tree, DENY also blocks every agent file-touching
// tool — Read, Write, Edit, Delete, Glob, Grep, ListDir, etc. — so
// the user can mark "agent stays out of this" without affecting
// their own browsing.
const DENY_FILE: &str = ".vaultchatdeny";
const NOTES_DIR: &str = ".vault-chat";
const NOTES_FILE: &str = "notes.jsonl";
const HUMANIZED_FILE: &str = "humanized.json";
const CONVERSATIONS_FILE: &str = "conversations.jsonl";
/// Folder holding one `<id>.json` per conversation (replaces the single
/// `conversations.jsonl` monolith). Per-conversation files mean a new message
/// rewrites only its own small file, not the whole multi-MB blob — collapsing
/// git churn — and two machines editing *different* conversations no longer
/// collide on the same file at all.
const CONVERSATIONS_DIR: &str = "conversations";
const SCHEDULES_FILE: &str = "schedules.jsonl";

#[derive(Serialize)]
struct FileEntry {
    path: String,
    name: String,
    is_dir: bool,
    depth: usize,
    hidden: bool,
    denied: bool,
    humanized: bool,
    /// Some("main") if this directory contains a `.git` subdirectory —
    /// i.e. it IS a git repo root. None for ordinary directories and files.
    /// Skip when None so the field is absent (not JSON `null`) on the wire —
    /// the frontend treats "has a branch" as "is a repo", and a serialized
    /// `null` would otherwise read as present and badge every file.
    #[serde(skip_serializing_if = "Option::is_none")]
    git_branch: Option<String>,
    /// Number of uncommitted changes in the repo (lines of `git status --porcelain`).
    /// Some(0) = clean repo, Some(n) = n dirty files. None for non-repo dirs.
    #[serde(skip_serializing_if = "Option::is_none")]
    git_dirty_count: Option<u32>,
    /// Set only when a nested repo is genuinely stuck — a detached HEAD parked at
    /// no remote branch tip, which the sync loop can't auto-attach, so its edits
    /// won't propagate. The string is a human-readable reason for the UI tooltip.
    /// None for healthy repos (on a branch, or detached-but-at-a-tip which
    /// auto-attaches next sync), so the file tree shows no branch/`detached` noise.
    #[serde(skip_serializing_if = "Option::is_none")]
    git_warn: Option<String>,
}

// Extensions we hide from the file tree even though they exist on disk —
// compiler/runtime droppings and opaque binaries that a user is never
// going to open intentionally. Everything else is listed; unknown types
// show up and the UI offers "open in file explorer" as a fallback.
fn is_hidden_ext(ext: &str) -> bool {
    matches!(
        ext,
        "pyc"
            | "pyo"
            | "class"
            | "o"
            | "obj"
            | "a"
            | "lib"
            | "rlib"
            | "rmeta"
            | "dll"
            | "so"
            | "dylib"
            | "exe"
            | "bin"
            | "out"
    )
}

// Load a list-file (.vaultchatignore or .vaultchatdeny) into a set of
// normalised relative paths. Empty lines and `#` comments are skipped;
// leading/trailing slashes are stripped; back-slashes folded to `/`.
fn load_list_set(vault: &std::path::Path, file: &str) -> HashSet<String> {
    let path = vault.join(file);
    let mut set = HashSet::new();
    if let Ok(contents) = std::fs::read_to_string(&path) {
        for line in contents.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            let normalized = trimmed
                .trim_start_matches('/')
                .trim_end_matches('/')
                .replace('\\', "/");
            if !normalized.is_empty() {
                set.insert(normalized);
            }
        }
    }
    set
}

fn load_ignore_set(vault: &std::path::Path) -> HashSet<String> {
    load_list_set(vault, IGNORE_FILE)
}

fn load_deny_set(vault: &std::path::Path) -> HashSet<String> {
    load_list_set(vault, DENY_FILE)
}

// Per-file capability mask. MVP only has one preset ("humanized" =
// AI-read on, all writes off), stored as a JSON array of vault-relative
// paths under <vault>/.vault-chat/humanized.json. Future presets (e.g.
// "secret" = read also off) will land as object entries instead of bare
// strings, which is why we accept both shapes when reading.
fn humanized_path(vault: &std::path::Path) -> PathBuf {
    vault.join(NOTES_DIR).join(HUMANIZED_FILE)
}

fn load_humanized_set(vault: &std::path::Path) -> HashSet<String> {
    let path = humanized_path(vault);
    let Ok(contents) = std::fs::read_to_string(&path) else {
        return HashSet::new();
    };
    let mut set = HashSet::new();
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&contents) else {
        return set;
    };
    let Some(arr) = value.as_array() else {
        return set;
    };
    for item in arr {
        let rel_opt = if let Some(s) = item.as_str() {
            Some(s.to_string())
        } else if let Some(obj) = item.as_object() {
            obj.get("path").and_then(|v| v.as_str()).map(|s| s.to_string())
        } else {
            None
        };
        if let Some(rel) = rel_opt {
            let norm = rel
                .trim_start_matches('/')
                .trim_end_matches('/')
                .replace('\\', "/");
            if !norm.is_empty() {
                set.insert(norm);
            }
        }
    }
    set
}

fn read_humanized_list(vault: &str) -> Vec<String> {
    let root = std::path::Path::new(vault);
    let mut list: Vec<String> = load_humanized_set(root).into_iter().collect();
    list.sort();
    list
}

fn write_humanized_set(vault: &str, set: &HashSet<String>) -> Result<(), String> {
    let root = std::path::Path::new(vault);
    let dir = root.join(NOTES_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {}", dir.display(), e))?;
    let mut list: Vec<&String> = set.iter().collect();
    list.sort();
    let json = serde_json::to_string_pretty(&list).map_err(|e| e.to_string())?;
    std::fs::write(humanized_path(root), json + "\n").map_err(|e| e.to_string())
}

// True when `rel_path` itself is in the set, OR any ancestor
// directory of `rel_path` is in the set. Lets a single entry cover
// a whole subtree without listing every descendant.
fn is_listed_path(rel_path: &str, set: &HashSet<String>) -> bool {
    if set.contains(rel_path) {
        return true;
    }
    for (i, _) in rel_path.match_indices('/') {
        if set.contains(&rel_path[..i]) {
            return true;
        }
    }
    false
}

fn is_hidden_path(rel_path: &str, ignored: &HashSet<String>) -> bool {
    is_listed_path(rel_path, ignored)
}

#[tauri::command]
async fn list_markdown_files(vault: String) -> Result<Vec<FileEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || list_markdown_files_sync(vault))
        .await
        .map_err(|e| e.to_string())?
}

fn list_markdown_files_sync(vault: String) -> Result<Vec<FileEntry>, String> {
    let root = PathBuf::from(&vault);
    if !root.is_dir() {
        return Err(format!("Not a directory: {}", vault));
    }
    let ignored = load_ignore_set(&root);
    let denied = load_deny_set(&root);
    let humanized = load_humanized_set(&root);
    let mut entries: Vec<FileEntry> = Vec::new();
    for entry in WalkDir::new(&root)
        .sort_by(|a, b| {
            let a_dir = a.file_type().is_dir();
            let b_dir = b.file_type().is_dir();
            b_dir
                .cmp(&a_dir)
                .then_with(|| {
                    a.file_name()
                        .to_string_lossy()
                        .to_lowercase()
                        .cmp(&b.file_name().to_string_lossy().to_lowercase())
                })
        })
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !name.starts_with('.') && name != "node_modules" && name != "target"
        })
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        let is_dir = path.is_dir();
        if !is_dir {
            let ext = path
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| s.to_lowercase());
            if ext.as_deref().map(is_hidden_ext).unwrap_or(false) {
                continue;
            }
        }
        let rel = path.strip_prefix(&root).unwrap_or(path);
        if rel.as_os_str().is_empty() {
            continue;
        }
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        let hidden = is_hidden_path(&rel_str, &ignored);
        let is_denied = is_listed_path(&rel_str, &denied);
        let is_humanized = humanized.contains(&rel_str);
        // Detect git repos: check if this directory contains a `.git` entry.
        // Only populated for directories — fast, no network, no git process.
        let (git_branch, git_dirty_count, git_warn) = if is_dir && path.join(".git").exists() {
            let path_str = path.to_string_lossy().to_string();
            let branch_ref = run_git(&path_str, &["symbolic-ref", "--short", "HEAD"]).ok();
            let on_branch = matches!(&branch_ref, Some((b, _, 0)) if !b.trim().is_empty());
            let branch = match &branch_ref {
                Some((b, _, 0)) if !b.trim().is_empty() => b.trim().to_string(),
                _ => "detached".to_string(),
            };
            let dirty = run_git(&path_str, &["status", "--porcelain"])
                .ok()
                .map(|(out, _, code)| {
                    if code == 0 {
                        out.lines().filter(|l| !l.trim().is_empty()).count() as u32
                    } else {
                        0u32
                    }
                })
                .unwrap_or(0u32);
            // Sync-health warning. The only genuinely-stuck state in the current
            // model is a detached HEAD sitting at NO remote branch tip — a
            // deliberate old-commit checkout the sync loop can't auto-attach, so
            // its edits won't propagate. On a branch, or detached-but-at-a-tip
            // (auto-attaches next sync), there's nothing worth flagging.
            let warn = if on_branch {
                None
            } else {
                let at_tip = run_git(&path_str, &["branch", "-r", "--points-at", "HEAD"])
                    .ok()
                    .map(|(out, _, code)| code == 0 && !out.trim().is_empty())
                    .unwrap_or(false);
                if at_tip {
                    None
                } else {
                    Some("Detached at an old commit — edits here won't sync".to_string())
                }
            };
            (Some(branch), Some(dirty), warn)
        } else {
            (None, None, None)
        };
        entries.push(FileEntry {
            path: path.to_string_lossy().replace('\\', "/"),
            name: path.file_name().unwrap_or_default().to_string_lossy().to_string(),
            is_dir,
            depth: rel.components().count().saturating_sub(1),
            hidden,
            denied: is_denied,
            humanized: is_humanized,
            git_branch,
            git_dirty_count,
            git_warn,
        });
    }
    Ok(entries)
}

// Inner sync helpers below are file-name agnostic — called by both
// the .vaultchatignore and .vaultchatdeny tauri commands so the
// list-management logic only lives in one place.

fn read_list_lines_sync(vault: &str, file: &str) -> Result<Vec<String>, String> {
    let path = std::path::Path::new(vault).join(file);
    let contents = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return Ok(Vec::new()),
    };
    let mut out: Vec<String> = Vec::new();
    for line in contents.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let normalized = trimmed
            .trim_start_matches('/')
            .trim_end_matches('/')
            .replace('\\', "/");
        if !normalized.is_empty() {
            out.push(normalized);
        }
    }
    Ok(out)
}

fn add_to_list_sync(
    vault: &str,
    file: &str,
    relative_path: &str,
    empty_err: &str,
) -> Result<(), String> {
    let normalized = relative_path
        .trim_start_matches('/')
        .trim_end_matches('/')
        .replace('\\', "/");
    if normalized.is_empty() {
        return Err(empty_err.to_string());
    }
    let path = std::path::Path::new(vault).join(file);
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    for line in existing.lines() {
        if line.trim() == normalized {
            return Ok(());
        }
    }
    let mut new_contents = existing;
    if !new_contents.is_empty() && !new_contents.ends_with('\n') {
        new_contents.push('\n');
    }
    new_contents.push_str(&normalized);
    new_contents.push('\n');
    std::fs::write(&path, new_contents).map_err(|e| e.to_string())
}

fn rename_in_list_sync(
    vault: &str,
    file: &str,
    old_relative: &str,
    new_relative: &str,
) -> Result<(), String> {
    let normalize = |p: &str| -> String {
        p.trim_start_matches('/')
            .trim_end_matches('/')
            .replace('\\', "/")
    };
    let old_n = normalize(old_relative);
    let new_n = normalize(new_relative);
    if old_n.is_empty() || new_n.is_empty() || old_n == new_n {
        return Ok(());
    }
    let path = std::path::Path::new(vault).join(file);
    let existing = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return Ok(()),
    };
    let mut changed = false;
    let prefix = format!("{}/", old_n);
    let mut out_lines: Vec<String> = Vec::with_capacity(existing.lines().count());
    for line in existing.lines() {
        let trimmed = line.trim();
        if trimmed == old_n {
            changed = true;
            out_lines.push(new_n.clone());
        } else if trimmed.starts_with(&prefix) {
            changed = true;
            let suffix = &trimmed[prefix.len()..];
            out_lines.push(format!("{}/{}", new_n, suffix));
        } else {
            out_lines.push(line.to_string());
        }
    }
    if !changed {
        return Ok(());
    }
    let mut new_contents = out_lines.join("\n");
    if !new_contents.is_empty() && !new_contents.ends_with('\n') {
        new_contents.push('\n');
    }
    std::fs::write(&path, new_contents).map_err(|e| e.to_string())
}

fn remove_prefix_from_list_sync(
    vault: &str,
    file: &str,
    relative_prefixes: &[String],
) -> Result<(), String> {
    let prefixes: Vec<String> = relative_prefixes
        .iter()
        .map(|p| {
            p.trim_start_matches('/')
                .trim_end_matches('/')
                .replace('\\', "/")
        })
        .filter(|p| !p.is_empty())
        .collect();
    if prefixes.is_empty() {
        return Ok(());
    }
    let path = std::path::Path::new(vault).join(file);
    let existing = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return Ok(()),
    };
    let mut changed = false;
    let kept: Vec<&str> = existing
        .lines()
        .filter(|l| {
            let t = l.trim();
            let drop = prefixes
                .iter()
                .any(|p| t == p || t.starts_with(&format!("{}/", p)));
            if drop {
                changed = true;
            }
            !drop
        })
        .collect();
    if !changed {
        return Ok(());
    }
    let new_contents = if kept.iter().all(|l| l.trim().is_empty()) {
        String::new()
    } else {
        let mut s = kept.join("\n");
        s.push('\n');
        s
    };
    std::fs::write(&path, new_contents).map_err(|e| e.to_string())
}

fn remove_from_list_sync(
    vault: &str,
    file: &str,
    relative_paths: &[String],
) -> Result<(), String> {
    let targets: HashSet<String> = relative_paths
        .iter()
        .map(|p| {
            p.trim_start_matches('/')
                .trim_end_matches('/')
                .replace('\\', "/")
        })
        .filter(|p| !p.is_empty())
        .collect();
    if targets.is_empty() {
        return Ok(());
    }
    let path = std::path::Path::new(vault).join(file);
    let existing = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return Ok(()),
    };
    let kept: Vec<&str> = existing
        .lines()
        .filter(|l| !targets.contains(l.trim()))
        .collect();
    let new_contents = if kept.iter().all(|l| l.trim().is_empty()) {
        String::new()
    } else {
        let mut s = kept.join("\n");
        s.push('\n');
        s
    };
    std::fs::write(&path, new_contents).map_err(|e| e.to_string())
}

#[tauri::command]
async fn read_ignore_lines(vault: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || read_list_lines_sync(&vault, IGNORE_FILE))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn add_to_ignore(vault: String, relative_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        add_to_list_sync(&vault, IGNORE_FILE, &relative_path, "cannot hide vault root")
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn rename_in_ignore(
    vault: String,
    old_relative: String,
    new_relative: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        rename_in_list_sync(&vault, IGNORE_FILE, &old_relative, &new_relative)
    })
    .await
    .map_err(|e| e.to_string())?
}

// Prune every ignore entry that matches one of `prefixes` exactly OR
// sits beneath one of them. Used after a delete or move so the ignore
// list never points at paths that have stopped existing under that
// name. Idempotent: a no-op if no line matches.
#[tauri::command]
async fn remove_prefix_from_ignore(
    vault: String,
    relative_prefixes: Vec<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        remove_prefix_from_list_sync(&vault, IGNORE_FILE, &relative_prefixes)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn remove_from_ignore(vault: String, relative_paths: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        remove_from_list_sync(&vault, IGNORE_FILE, &relative_paths)
    })
    .await
    .map_err(|e| e.to_string())?
}

// .vaultchatdeny — orthogonal to .vaultchatignore. Where ignore hides
// entries from the file tree, deny blocks every agent file-touching
// tool. The user explicitly opts paths in via a right-click toggle;
// the agent gets a clear error rather than a silent skip so it can
// say "I can't read this — you've restricted it".

#[tauri::command]
async fn read_deny_lines(vault: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || read_list_lines_sync(&vault, DENY_FILE))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn add_to_deny(vault: String, relative_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        add_to_list_sync(
            &vault,
            DENY_FILE,
            &relative_path,
            "cannot restrict vault root",
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn rename_in_deny(
    vault: String,
    old_relative: String,
    new_relative: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        rename_in_list_sync(&vault, DENY_FILE, &old_relative, &new_relative)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn remove_prefix_from_deny(
    vault: String,
    relative_prefixes: Vec<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        remove_prefix_from_list_sync(&vault, DENY_FILE, &relative_prefixes)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn remove_from_deny(vault: String, relative_paths: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        remove_from_list_sync(&vault, DENY_FILE, &relative_paths)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- humanized.json (per-file write lock) ----------
//
// Each entry is a vault-relative path. A humanized file is AI-readable
// but agent writes (Write, Edit, NotebookEdit, Delete) are refused.
// Membership is exact-match — humanizing a folder does NOT cascade to
// children. The user opts files in one at a time via a right-click
// "Humanize…" entry. Meant to be near-permanent; unlock is hand-edit
// only.

#[tauri::command]
async fn read_humanized(vault: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(read_humanized_list(&vault)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn add_to_humanized(vault: String, relative_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let normalized = relative_path
            .trim_start_matches('/')
            .trim_end_matches('/')
            .replace('\\', "/");
        if normalized.is_empty() {
            return Err("cannot humanize vault root".to_string());
        }
        let mut set = load_humanized_set(std::path::Path::new(&vault));
        set.insert(normalized);
        write_humanized_set(&vault, &set)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn rename_in_humanized(
    vault: String,
    old_relative: String,
    new_relative: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let normalize = |p: &str| -> String {
            p.trim_start_matches('/')
                .trim_end_matches('/')
                .replace('\\', "/")
        };
        let old_n = normalize(&old_relative);
        let new_n = normalize(&new_relative);
        if old_n.is_empty() || new_n.is_empty() || old_n == new_n {
            return Ok(());
        }
        let mut set = load_humanized_set(std::path::Path::new(&vault));
        let prefix = format!("{}/", old_n);
        let mut changed = false;
        let mut next: HashSet<String> = HashSet::new();
        for entry in set.drain() {
            if entry == old_n {
                next.insert(new_n.clone());
                changed = true;
            } else if entry.starts_with(&prefix) {
                let suffix = &entry[prefix.len()..];
                next.insert(format!("{}/{}", new_n, suffix));
                changed = true;
            } else {
                next.insert(entry);
            }
        }
        if !changed {
            return Ok(());
        }
        write_humanized_set(&vault, &next)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn remove_prefix_from_humanized(
    vault: String,
    relative_prefixes: Vec<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let prefixes: Vec<String> = relative_prefixes
            .iter()
            .map(|p| {
                p.trim_start_matches('/')
                    .trim_end_matches('/')
                    .replace('\\', "/")
            })
            .filter(|p| !p.is_empty())
            .collect();
        if prefixes.is_empty() {
            return Ok(());
        }
        let set = load_humanized_set(std::path::Path::new(&vault));
        let mut changed = false;
        let kept: HashSet<String> = set
            .into_iter()
            .filter(|entry| {
                let drop = prefixes
                    .iter()
                    .any(|p| entry == p || entry.starts_with(&format!("{}/", p)));
                if drop {
                    changed = true;
                }
                !drop
            })
            .collect();
        if !changed {
            return Ok(());
        }
        write_humanized_set(&vault, &kept)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- notes.jsonl (scratchpad) ----------
//
// Append-only capture of ephemeral thoughts the user leaves while
// reading / editing. Each line is one JSON-encoded note object.
// The front-end owns the schema; Rust just persists lines.

#[tauri::command]
async fn notes_read(vault: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = std::path::Path::new(&vault).join(NOTES_DIR).join(NOTES_FILE);
        if !path.exists() {
            return Ok(Vec::new());
        }
        let contents = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        Ok(contents
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(String::from)
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn notes_append(vault: String, line: String) -> Result<(), String> {
    use std::io::Write;
    tauri::async_runtime::spawn_blocking(move || {
        let dir = std::path::Path::new(&vault).join(NOTES_DIR);
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("mkdir {}: {}", dir.display(), e))?;
        let path = dir.join(NOTES_FILE);
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| format!("open {}: {}", path.display(), e))?;
        let mut bytes = line.into_bytes();
        if !bytes.ends_with(b"\n") {
            bytes.push(b'\n');
        }
        f.write_all(&bytes).map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn notes_write_all(vault: String, lines: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = std::path::Path::new(&vault).join(NOTES_DIR);
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("mkdir {}: {}", dir.display(), e))?;
        let path = dir.join(NOTES_FILE);
        let mut body = lines.join("\n");
        if !body.is_empty() && !body.ends_with('\n') {
            body.push('\n');
        }
        std::fs::write(&path, body).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Sanitize a conversation id into a safe single-segment filename stem. Ids are
/// normally short hex-with-dashes (e.g. `8e9f6621-1e4`); this is just defense so
/// a malformed id can never escape the conversations folder or clobber a path.
fn conversation_file_stem(id: &str) -> String {
    let safe: String = id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let trimmed = safe.trim_matches('_');
    if trimmed.is_empty() {
        "conversation".to_string()
    } else {
        trimmed.to_string()
    }
}

#[tauri::command]
async fn conversations_read(vault: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = std::path::Path::new(&vault).join(NOTES_DIR);
        let dir = base.join(CONVERSATIONS_DIR);
        // Preferred layout: one <id>.json per conversation. Read them all.
        if dir.is_dir() {
            let mut out: Vec<String> = Vec::new();
            if let Ok(entries) = std::fs::read_dir(&dir) {
                for e in entries.flatten() {
                    let p = e.path();
                    if p.extension().and_then(|x| x.to_str()) != Some("json") {
                        continue; // skip .tmp and anything else
                    }
                    if let Ok(contents) = std::fs::read_to_string(&p) {
                        let t = contents.trim();
                        if !t.is_empty() {
                            out.push(t.to_string());
                        }
                    }
                }
            }
            // If the folder exists but is empty AND a legacy monolith is still
            // present (e.g. folder created but first write hasn't migrated yet),
            // fall through to the legacy read below.
            if !out.is_empty() {
                return Ok(out);
            }
        }
        // Legacy fallback: the single conversations.jsonl monolith. The next
        // write migrates it into the folder and removes it.
        let legacy = base.join(CONVERSATIONS_FILE);
        if !legacy.exists() {
            return Ok(Vec::new());
        }
        let contents = std::fs::read_to_string(&legacy).map_err(|e| e.to_string())?;
        Ok(contents
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(String::from)
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn conversations_write_all(vault: String, lines: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = std::path::Path::new(&vault).join(NOTES_DIR);
        let dir = base.join(CONVERSATIONS_DIR);
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("mkdir {}: {}", dir.display(), e))?;

        // Write each conversation to its own <id>.json, but ONLY when its
        // content actually changed — an unchanged file is left exactly as is, so
        // git sees no diff for it. This is what collapses the churn: a single
        // new message rewrites one small file instead of the whole blob.
        let mut keep: std::collections::HashSet<String> = std::collections::HashSet::new();
        for line in &lines {
            let t = line.trim();
            if t.is_empty() {
                continue;
            }
            // The conversation id names the file. Parse it out; skip a line we
            // can't identify rather than risk an ambiguous filename.
            let id = match serde_json::from_str::<serde_json::Value>(t)
                .ok()
                .as_ref()
                .and_then(|v| v.get("id"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
            {
                Some(id) if !id.is_empty() => id,
                _ => continue,
            };
            let stem = conversation_file_stem(&id);
            keep.insert(stem.clone());
            let path = dir.join(format!("{}.json", stem));
            let body = format!("{}\n", t);
            // Skip the write if on-disk content is already identical.
            if let Ok(existing) = std::fs::read_to_string(&path) {
                if existing == body {
                    continue;
                }
            }
            // Write-temp-then-rename so a crash mid-write leaves the previous
            // good file in place rather than a half-written one. The temp lives
            // at the `.vault-chat/` top level (not inside conversations/) so the
            // managed `.gitignore`'s `.vault-chat/*.tmp` rule keeps a stray temp
            // out of git; the rename into the subfolder is same-volume/atomic.
            let tmp = base.join(format!("{}.json.tmp", stem));
            std::fs::write(&tmp, &body)
                .map_err(|e| format!("write {}: {}", tmp.display(), e))?;
            std::fs::rename(&tmp, &path)
                .map_err(|e| format!("rename {} -> {}: {}", tmp.display(), path.display(), e))?;
        }

        // Delete files for conversations no longer present (a deletion).
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for e in entries.flatten() {
                let p = e.path();
                if p.extension().and_then(|x| x.to_str()) != Some("json") {
                    continue;
                }
                if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
                    if !keep.contains(stem) {
                        let _ = std::fs::remove_file(&p);
                    }
                }
            }
        }

        // Migration complete: now that the folder is the source of truth, drop
        // the legacy monolith so it stops being re-stored on every sync.
        let legacy = base.join(CONVERSATIONS_FILE);
        if legacy.exists() {
            let _ = std::fs::remove_file(&legacy);
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn schedules_read(vault: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = std::path::Path::new(&vault)
            .join(NOTES_DIR)
            .join(SCHEDULES_FILE);
        if !path.exists() {
            return Ok(Vec::new());
        }
        let contents = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        Ok(contents
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(String::from)
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn schedules_write_all(vault: String, lines: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = std::path::Path::new(&vault).join(NOTES_DIR);
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("mkdir {}: {}", dir.display(), e))?;
        let path = dir.join(SCHEDULES_FILE);
        let tmp = dir.join(format!("{}.tmp", SCHEDULES_FILE));
        let mut body = lines.join("\n");
        if !body.is_empty() && !body.ends_with('\n') {
            body.push('\n');
        }
        std::fs::write(&tmp, body)
            .map_err(|e| format!("write {}: {}", tmp.display(), e))?;
        std::fs::rename(&tmp, &path)
            .map_err(|e| format!("rename {} -> {}: {}", tmp.display(), path.display(), e))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn read_binary_file(path: String) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::read(&path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn open_terminal(cwd: Option<String>) -> Result<(), String> {
    let dir = cwd.unwrap_or_else(|| ".".to_string());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Use `cmd /C start "" cmd` to fully detach: the outer cmd runs `start`,
        // which launches a new cmd window with its own stdio (not piped back to
        // the parent GUI process), then the outer cmd exits. CREATE_NO_WINDOW
        // hides the brief outer cmd flash.
        let win_dir = dir.replace('/', "\\");
        Command::new("cmd")
            .args(["/C", "start", "", "cmd"])
            .current_dir(&win_dir)
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .args(["-a", "Terminal", &dir])
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // Pass each terminal its explicit working-directory FLAG. Relying on
        // current_dir alone fails for terminals that hand off to a running
        // server process (ptyxis — Ubuntu 26.04's default, gnome-terminal,
        // konsole with a daemon): the new window opens in $HOME, not the vault.
        // kitty is tried first (Carl's terminal). NOTE: do NOT pass
        // --single-instance — spawned from this GUI app the single-instance
        // handshake makes the child exit without showing a window (silent
        // failure + zombies). Plain `kitty -d DIR` opens a window reliably.
        // current_dir is kept as a belt-and-suspenders fallback for terminals
        // that honour it.
        let attempts: [(&str, Vec<String>); 5] = [
            ("kitty", vec!["-d".into(), dir.clone()]),
            (
                "ptyxis",
                vec!["--new-window".into(), format!("--working-directory={}", dir)],
            ),
            ("konsole", vec!["--workdir".into(), dir.clone()]),
            ("gnome-terminal", vec![format!("--working-directory={}", dir)]),
            ("xterm", vec![]),
        ];
        // Strip the Python env the AppImage runtime injects (PYTHONHOME /
        // PYTHONPATH point at the bundled /tmp/.mount_*/usr). A terminal that
        // embeds its own Python — notably kitty — inherits these and its
        // interpreter then can't find its stdlib ("Failed to import encodings
        // module"), so it dies instantly and nothing appears. GTK terminals
        // (ptyxis etc.) don't embed Python, which is why they were unaffected.
        for (term, args) in &attempts {
            if Command::new(term)
                .args(args)
                .current_dir(&dir)
                .env_remove("PYTHONHOME")
                .env_remove("PYTHONPATH")
                .spawn()
                .is_ok()
            {
                return Ok(());
            }
        }
        // Last resort: the Debian default-terminal alias (no portable workdir
        // flag, so this relies on current_dir).
        if Command::new("x-terminal-emulator")
            .current_dir(&dir)
            .env_remove("PYTHONHOME")
            .env_remove("PYTHONPATH")
            .spawn()
            .is_ok()
        {
            return Ok(());
        }
        Err("no terminal emulator found".to_string())
    }
}

#[tauri::command]
async fn read_text_file(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        decode_text(&bytes)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn decode_text(bytes: &[u8]) -> Result<String, String> {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8(bytes[3..].to_vec())
            .map_err(|e| format!("invalid UTF-8: {e}"));
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16(&units).map_err(|e| format!("invalid UTF-16LE: {e}"));
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_be_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16(&units).map_err(|e| format!("invalid UTF-16BE: {e}"));
    }
    String::from_utf8(bytes.to_vec()).map_err(|e| format!("invalid UTF-8: {e}"))
}

#[tauri::command]
async fn write_text_file(
    app: AppHandle,
    path: String,
    contents: String,
) -> Result<(), String> {
    git_guard(&path)?;
    let emit_path = path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(parent) = std::path::Path::new(&path).parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, contents).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    emit_file_changed(&app, &emit_path);
    Ok(())
}

/// Append a line (or block) to `<vault>/.vault-chat/app-log.txt`.
/// Used by the renderer's crash/freeze diagnostic logger. Deliberately
/// does NOT emit a file-changed event (unlike `write_text_file`) so the
/// log file can't trigger reloads or feed back into the very render
/// loops we're trying to capture. Best-effort: errors are surfaced but
/// the caller treats logging as fire-and-forget.
#[tauri::command]
async fn append_debug_log(vault_path: String, text: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = std::path::Path::new(&vault_path).join(".vault-chat");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join("app-log.txt");
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| e.to_string())?;
        f.write_all(text.as_bytes()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Prune the `<vault>/.vault-chat/captures/` folder of files whose
/// mtime is older than `older_than_hours`. Called on vault open so
/// chat captures don't accumulate forever — the user's mental model is
/// "captures are for this session"; once the session is over, the disk
/// copies are disposable. The data URLs in saved chat history still
/// render the bubbles, so deleting these files only invalidates the
/// `capturedFilePath` reference (used to embed the image in a freshly
/// authored markdown file). Returns the count of deleted files.
#[tauri::command]
async fn cleanup_old_captures(
    vault: String,
    older_than_hours: u64,
) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = std::path::Path::new(&vault)
            .join(".vault-chat")
            .join("captures");
        if !dir.exists() {
            return Ok(0u64);
        }
        let now = std::time::SystemTime::now();
        let cutoff = std::time::Duration::from_secs(older_than_hours * 3600);
        let mut deleted: u64 = 0;
        let entries = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            let Ok(modified) = meta.modified() else { continue };
            let Ok(age) = now.duration_since(modified) else { continue };
            if age > cutoff {
                if std::fs::remove_file(&path).is_ok() {
                    deleted += 1;
                }
            }
        }
        Ok(deleted)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Write raw bytes to a path (creating parent dirs). Used by external
/// drag-drop: the dropped File is read into an ArrayBuffer on the JS side
/// and handed to us as Vec<u8>. If a file with the same name already
/// exists we append " (1)", " (2)", ... to the stem and return the actual
/// path we wrote to.
#[tauri::command]
async fn write_binary_file_unique(
    dir: String,
    name: String,
    bytes: Vec<u8>,
) -> Result<String, String> {
    git_guard(&dir)?;
    tauri::async_runtime::spawn_blocking(move || {
        let dir_path = std::path::Path::new(&dir);
        std::fs::create_dir_all(dir_path).map_err(|e| e.to_string())?;

        let name_path = std::path::Path::new(&name);
        let stem = name_path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| name.clone());
        let ext = name_path
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();

        let mut target = dir_path.join(&name);
        let mut n = 1;
        while target.exists() {
            target = dir_path.join(format!("{} ({}){}", stem, n, ext));
            n += 1;
        }
        std::fs::write(&target, &bytes).map_err(|e| e.to_string())?;
        Ok(target.to_string_lossy().replace('\\', "/"))
    })
    .await
    .map_err(|e| e.to_string())?
}

// Copy an arbitrary OS path (file or directory) into a vault folder.
// Used by the Upload buttons in the file tree, which hand us absolute
// paths from the dialog plugin. Collision-renames the top-level entry
// with " (1)", " (2)", … suffixes so two uploads of the same name don't
// clobber. Returns the absolute path of the copied entry.
#[tauri::command]
async fn copy_into_vault(dst_dir: String, src: String) -> Result<String, String> {
    git_guard(&dst_dir)?;
    tauri::async_runtime::spawn_blocking(move || {
        let dst_dir_path = std::path::Path::new(&dst_dir);
        let src_path = std::path::Path::new(&src);
        std::fs::create_dir_all(dst_dir_path).map_err(|e| e.to_string())?;

        let meta = std::fs::symlink_metadata(src_path).map_err(|e| e.to_string())?;
        let raw_name = src_path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .ok_or_else(|| format!("source has no file name: {}", src))?;

        // Pick a non-colliding destination name. Files preserve
        // extension on the suffix ("notes (1).md"); dirs just append.
        let target = if meta.is_dir() {
            let mut candidate = dst_dir_path.join(&raw_name);
            let mut n = 1;
            while candidate.exists() {
                candidate = dst_dir_path.join(format!("{} ({})", raw_name, n));
                n += 1;
            }
            candidate
        } else {
            let name_path = std::path::Path::new(&raw_name);
            let stem = name_path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| raw_name.clone());
            let ext = name_path
                .extension()
                .map(|e| format!(".{}", e.to_string_lossy()))
                .unwrap_or_default();
            let mut candidate = dst_dir_path.join(&raw_name);
            let mut n = 1;
            while candidate.exists() {
                candidate = dst_dir_path.join(format!("{} ({}){}", stem, n, ext));
                n += 1;
            }
            candidate
        };

        if meta.is_dir() {
            copy_dir_recursive(src_path, &target)?;
        } else {
            std::fs::copy(src_path, &target).map_err(|e| e.to_string())?;
        }
        Ok(target.to_string_lossy().replace('\\', "/"))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    let entries = std::fs::read_dir(src).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else if file_type.is_file() {
            std::fs::copy(&from, &to).map_err(|e| e.to_string())?;
        }
        // Symlinks: skipped intentionally — copying them as links would
        // dangle outside the vault, and resolving them risks copying
        // huge trees the user didn't mean to upload.
    }
    Ok(())
}

#[tauri::command]
async fn rename_path(from: String, to: String) -> Result<(), String> {
    git_guard(&from)?;
    git_guard(&to)?;
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(parent) = std::path::Path::new(&to).parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::rename(&from, &to).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn create_dir(path: String) -> Result<(), String> {
    git_guard(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn delete_file(path: String) -> Result<(), String> {
    git_guard(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let p = std::path::Path::new(&path);
        if p.is_dir() {
            std::fs::remove_dir_all(p).map_err(|e| e.to_string())
        } else {
            std::fs::remove_file(p).map_err(|e| e.to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn edit_text_file(
    app: AppHandle,
    path: String,
    old_string: String,
    new_string: String,
    replace_all: Option<bool>,
) -> Result<String, String> {
    git_guard(&path)?;
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    // Normalize line endings for matching so agent-provided `old_string`
    // (usually LF) matches CRLF files on Windows. The file's original
    // ending style is detected and restored on write so we don't
    // silently churn EOLs on every edit.
    let had_crlf = raw.contains("\r\n");
    let contents = if had_crlf { raw.replace("\r\n", "\n") } else { raw };
    let needle = old_string.replace("\r\n", "\n");
    let replacement = new_string.replace("\r\n", "\n");
    let all = replace_all.unwrap_or(false);
    let new_contents_lf = if all {
        let count = contents.matches(&needle).count();
        if count == 0 {
            return Err(format!("old_string not found in {}", path));
        }
        (contents.replace(&needle, &replacement), count)
    } else {
        let count = contents.matches(&needle).count();
        if count == 0 {
            return Err(format!("old_string not found in {}", path));
        }
        if count > 1 {
            return Err(format!(
                "old_string matches {} times in {} — provide more context to make it unique, or set replace_all=true",
                count, path
            ));
        }
        (contents.replacen(&needle, &replacement, 1), 1)
    };
    let (body, count) = new_contents_lf;
    let out = if had_crlf { body.replace('\n', "\r\n") } else { body };
    std::fs::write(&path, out).map_err(|e| e.to_string())?;
    emit_file_changed(&app, &path);
    if all {
        Ok(format!("replaced {} occurrence(s) in {}", count, path))
    } else {
        Ok(format!("edited {}", path))
    }
}

#[tauri::command]
async fn glob_files(pattern: String, cwd: Option<String>) -> Result<Vec<String>, String> {
    let base = cwd
        .as_deref()
        .map(PathBuf::from)
        .filter(|p| p.is_dir());
    let full_pattern = match &base {
        Some(b) => {
            let joined = b.join(&pattern);
            joined.to_string_lossy().replace('\\', "/")
        }
        None => pattern.clone(),
    };
    let paths = glob::glob(&full_pattern).map_err(|e| e.to_string())?;
    let mut out: Vec<(String, std::time::SystemTime)> = Vec::new();
    for entry in paths.filter_map(|r| r.ok()) {
        if entry.is_file() {
            let mtime = entry
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            out.push((entry.to_string_lossy().replace('\\', "/"), mtime));
        }
    }
    out.sort_by(|a, b| b.1.cmp(&a.1));
    Ok(out.into_iter().map(|(p, _)| p).collect())
}

#[derive(Serialize)]
struct GrepMatch {
    path: String,
    line: usize,
    text: String,
}

#[tauri::command]
async fn grep_files(
    pattern: String,
    path: String,
    glob_filter: Option<String>,
    case_insensitive: Option<bool>,
    max_results: Option<usize>,
) -> Result<Vec<GrepMatch>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        grep_files_sync(pattern, path, glob_filter, case_insensitive, max_results)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn grep_files_sync(
    pattern: String,
    path: String,
    glob_filter: Option<String>,
    case_insensitive: Option<bool>,
    max_results: Option<usize>,
) -> Result<Vec<GrepMatch>, String> {
    let mut builder = regex::RegexBuilder::new(&pattern);
    builder.case_insensitive(case_insensitive.unwrap_or(false));
    let re = builder.build().map_err(|e| e.to_string())?;
    let root = PathBuf::from(&path);
    if !root.exists() {
        return Err(format!("path does not exist: {}", path));
    }

    let glob_pat = glob_filter
        .as_deref()
        .and_then(|g| glob::Pattern::new(g).ok());

    let limit = max_results.unwrap_or(500);
    let mut results: Vec<GrepMatch> = Vec::new();

    let walker = if root.is_dir() {
        WalkDir::new(&root)
    } else {
        WalkDir::new(&root)
    };

    for entry in walker
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !name.starts_with('.') && name != "node_modules" && name != "target"
        })
        .filter_map(|e| e.ok())
    {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        if let Some(ref gp) = glob_pat {
            let name = p.file_name().unwrap_or_default().to_string_lossy();
            if !gp.matches(&name) {
                continue;
            }
        }
        let content = match std::fs::read_to_string(p) {
            Ok(c) => c,
            Err(_) => continue,
        };
        for (i, line) in content.lines().enumerate() {
            if re.is_match(line) {
                results.push(GrepMatch {
                    path: p.to_string_lossy().replace('\\', "/"),
                    line: i + 1,
                    text: line.to_string(),
                });
                if results.len() >= limit {
                    return Ok(results);
                }
            }
        }
    }
    Ok(results)
}

#[derive(Serialize)]
struct BashResult {
    stdout: String,
    stderr: String,
    code: i32,
    timed_out: bool,
}

#[tauri::command]
async fn bash_exec(
    command: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<BashResult, String> {
    tauri::async_runtime::spawn_blocking(move || bash_exec_sync(command, cwd, timeout_ms))
        .await
        .map_err(|e| e.to_string())?
}

fn bash_exec_sync(
    command: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<BashResult, String> {
    use std::io::Read;
    use std::time::{Duration, Instant};

    let timeout = Duration::from_millis(timeout_ms.unwrap_or(120_000));
    let working_dir = cwd.clone().filter(|c| PathBuf::from(c).is_dir());

    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        if let Some(bash) = find_git_bash() {
            // Git Bash. Use `-c` (not `-lc`) — login mode loads
            // /etc/profile which can be slow and prints MOTD-style
            // junk into the agent's view. The command string itself
            // already passes through Rust's CreateProcess arg
            // escaping cleanly because bash.exe's arg parsing matches
            // C runtime conventions.
            // MSYS_NO_PATHCONV + MSYS2_ARG_CONV_EXCL disable Git Bash's
            // auto path-rewriting heuristic, which otherwise mangles
            // any arg starting with `/` into a Windows path under the
            // Git install dir. Without this, `gh api /repos/foo`
            // silently becomes `gh api C:\Program Files\Git\repos\foo`
            // and the request 404s. Standard hygiene when using Git
            // Bash as a script host.
            let mut c = Command::new(&bash);
            c.arg("-c").arg(&command);
            c.env("MSYS_NO_PATHCONV", "1");
            c.env("MSYS2_ARG_CONV_EXCL", "*");
            c.creation_flags(0x08000000);
            c
        } else {
            let mut c = Command::new("cmd");
            c.arg("/C").arg(&command);
            c.creation_flags(0x08000000);
            c
        }
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new("bash");
        c.arg("-lc").arg(&command);
        c
    };

    if let Some(d) = &working_dir {
        cmd.current_dir(d);
    }
    strip_polluting_env(&mut cmd);
    // Any `git commit` the agent runs via Bash — in the vault root or a
    // nested repo — is authored as the agent, so it's distinguishable from
    // the user's own commits in that repo's history.
    stamp_agent_git_identity(&mut cmd);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let start = Instant::now();
    let mut timed_out = false;
    let code;
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => {
                code = status.code().unwrap_or(-1);
                break;
            }
            None => {
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    timed_out = true;
                    code = -1;
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }

    let mut stdout = String::new();
    let mut stderr = String::new();
    if let Some(mut o) = child.stdout.take() {
        let _ = o.read_to_string(&mut stdout);
    }
    if let Some(mut e) = child.stderr.take() {
        let _ = e.read_to_string(&mut stderr);
    }

    const MAX_OUT: usize = 50_000;
    if stdout.len() > MAX_OUT {
        stdout = format!(
            "{}\n…[truncated {} bytes]",
            &stdout[..MAX_OUT],
            stdout.len() - MAX_OUT
        );
    }
    if stderr.len() > MAX_OUT {
        stderr = format!(
            "{}\n…[truncated {} bytes]",
            &stderr[..MAX_OUT],
            stderr.len() - MAX_OUT
        );
    }

    Ok(BashResult {
        stdout,
        stderr,
        code,
        timed_out,
    })
}

fn html_to_text(html: &str) -> String {
    let script_re = regex::Regex::new(r"(?is)<script\b[^>]*>.*?</script>").unwrap();
    let style_re = regex::Regex::new(r"(?is)<style\b[^>]*>.*?</style>").unwrap();
    let noscript_re = regex::Regex::new(r"(?is)<noscript\b[^>]*>.*?</noscript>").unwrap();
    let s1 = script_re.replace_all(html, " ");
    let s2 = style_re.replace_all(&s1, " ");
    let s3 = noscript_re.replace_all(&s2, " ");
    let tag_re = regex::Regex::new(r"(?s)<[^>]+>").unwrap();
    let no_tags = tag_re.replace_all(&s3, " ");
    let decoded = no_tags
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'");
    let ws_re = regex::Regex::new(r"[ \t]+").unwrap();
    let single_spaces = ws_re.replace_all(&decoded, " ");
    let nl_re = regex::Regex::new(r"\n{3,}").unwrap();
    nl_re.replace_all(&single_spaces, "\n\n").trim().to_string()
}

#[tauri::command]
async fn http_fetch(url: String, max_chars: Option<usize>) -> Result<String, String> {
    let limit = max_chars.unwrap_or(120_000);
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let client = reqwest::blocking::Client::builder()
            .user_agent("vault-chat/0.1")
            .timeout(std::time::Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()
            .map_err(|e| e.to_string())?;
        let resp = client.get(&url).send().map_err(|e| e.to_string())?;
        let status = resp.status();
        let ct = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let body = resp.text().map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("HTTP {}: {}", status, body.chars().take(200).collect::<String>()));
        }
        let text = if ct.contains("html") || body.trim_start().starts_with("<!") || body.trim_start().starts_with("<html") {
            html_to_text(&body)
        } else {
            body
        };
        Ok(text)
    })
    .await
    .map_err(|e| e.to_string())??;

    if result.chars().count() > limit {
        let truncated: String = result.chars().take(limit).collect();
        Ok(format!("{}\n…[truncated; full length {} chars]", truncated, result.chars().count()))
    } else {
        Ok(result)
    }
}

#[tauri::command]
async fn tavily_search(
    query: String,
    api_key: String,
    max_results: Option<usize>,
    include_answer: Option<bool>,
) -> Result<String, String> {
    let max = max_results.unwrap_or(5).min(10);
    let answer = include_answer.unwrap_or(true);
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let client = reqwest::blocking::Client::builder()
            .user_agent("vault-chat/0.1")
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?;
        let body = serde_json::json!({
            "api_key": api_key,
            "query": query,
            "max_results": max,
            "include_answer": answer,
            "search_depth": "basic",
        });
        let body_str = serde_json::to_string(&body).map_err(|e| e.to_string())?;
        let resp = client
            .post("https://api.tavily.com/search")
            .header("content-type", "application/json")
            .body(body_str)
            .send()
            .map_err(|e: reqwest::Error| e.to_string())?;
        let status = resp.status();
        let text = resp.text().map_err(|e: reqwest::Error| e.to_string())?;
        if !status.is_success() {
            return Err(format!("Tavily HTTP {}: {}", status, text.chars().take(400).collect::<String>()));
        }
        let parsed: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        let mut out = String::new();
        if let Some(ans) = parsed.get("answer").and_then(|a| a.as_str()) {
            if !ans.is_empty() {
                out.push_str("Answer: ");
                out.push_str(ans);
                out.push_str("\n\n");
            }
        }
        if let Some(results) = parsed.get("results").and_then(|r| r.as_array()) {
            for (i, r) in results.iter().enumerate() {
                let title = r.get("title").and_then(|v| v.as_str()).unwrap_or("");
                let url = r.get("url").and_then(|v| v.as_str()).unwrap_or("");
                let content = r.get("content").and_then(|v| v.as_str()).unwrap_or("");
                out.push_str(&format!("[{}] {}\n{}\n{}\n\n", i + 1, title, url, content));
            }
        }
        if out.is_empty() {
            Ok(format!("(no results)\n{}", text.chars().take(500).collect::<String>()))
        } else {
            Ok(out.trim_end().to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_dir(path: String) -> Result<Vec<FileEntry>, String> {
    let p = PathBuf::from(&path);
    if !p.is_dir() {
        return Err(format!("not a directory: {}", path));
    }
    let mut entries: Vec<FileEntry> = Vec::new();
    for entry in std::fs::read_dir(&p).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        entries.push(FileEntry {
            path: path.to_string_lossy().replace('\\', "/"),
            name,
            is_dir: path.is_dir(),
            depth: 0,
            hidden: false,
            denied: false,
            humanized: false,
            git_branch: None,
            git_dirty_count: None,
            git_warn: None,
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

#[derive(Serialize)]
struct GitCommit {
    hash: String,
    short_hash: String,
    subject: String,
    body: String,
    author: String,
    date: String,
    is_anchor: bool,
}

// ===================== git hardening =====================
//
// Git is the single durability + cross-machine-sync substrate: every vault
// is a repo, and nothing that reaches disk is safe until it reaches git.
// That makes concurrency discipline load-bearing. Every *mutating* git
// sequence funnels through one per-repo lock, so the app's many commit
// sources — end-of-turn, edit-debounce, voice, the 60s autosave net, the
// vault-sync loop, restore/revert/init — can never collide on
// `.git/index.lock`. Reads (status/log/rev-parse) don't take the index lock
// and run unlocked.
//
// Three further guards make a vault self-healing rather than wedge-prone:
//   - a stale `index.lock` left by a killed git is removed on lock entry;
//   - a leftover in-progress rebase/merge from a crashed auto-sync is
//     aborted before we commit, instead of every later commit silently
//     failing forever (the "wedged vault" failure);
//   - `run_git` has a hard timeout and never prompts for credentials, so a
//     hung fetch/push on the headless server fails fast, not forever.

const GIT_TIMEOUT_SECS: u64 = 90;
const STALE_LOCK_SECS: u64 = 10;

// Git identity model. Authorship follows *who actually did the work*:
//   - the AGENT (an autonomous turn, or any `git commit` the agent runs via
//     the Bash tool) is authored as `vault-chat-agent`;
//   - everything the USER did — their edits, autosaves of their work, app
//     housekeeping on their behalf — is authored as the user's *real* git
//     identity (resolved from the repo's effective config, which they already
//     have set, e.g. "Carl Wilson <wada2918@gmail.com>").
// We never stamp a neutral `vault-chat` bot as the author of the user's work —
// that erases their ownership, and in a shared repo it pollutes a history real
// collaborators read. The `[agent]` subject tag plus, in shared repos, a
// `Co-authored-by:` trailer keep the agent-vs-human split honest without faking
// authorship. APP_GIT_* survives only as a last-resort fallback for a repo with
// no git identity configured anywhere, so a commit never fails for lack of one.
const AGENT_GIT_NAME: &str = "vault-chat-agent";
const AGENT_GIT_EMAIL: &str = "agent@vault-chat.local";
const APP_GIT_NAME: &str = "vault-chat";
const APP_GIT_EMAIL: &str = "vault-chat@local";

/// Stamp the agent's git identity into a spawned command's environment, so
/// any `git commit` it runs is authored as `vault-chat-agent` regardless of
/// which repo (nested work repos included) it lands in.
fn stamp_agent_git_identity(cmd: &mut Command) {
    cmd.env("GIT_AUTHOR_NAME", AGENT_GIT_NAME);
    cmd.env("GIT_AUTHOR_EMAIL", AGENT_GIT_EMAIL);
    cmd.env("GIT_COMMITTER_NAME", AGENT_GIT_NAME);
    cmd.env("GIT_COMMITTER_EMAIL", AGENT_GIT_EMAIL);
}

/// The user's *real* git identity for `repo`, read from its effective git
/// config (local → global → system, exactly what a bare `git commit` would
/// use). This is what the user has already configured (e.g. their name + email),
/// so commits of their own work carry their ownership instead of a bot's.
/// Falls back to the neutral app identity only if nothing is configured.
fn human_identity(repo: &str) -> (String, String) {
    let get = |key: &str| -> Option<String> {
        run_git(repo, &["config", "--get", key]).ok().and_then(|(v, _, c)| {
            let v = v.trim().to_string();
            if c == 0 && !v.is_empty() {
                Some(v)
            } else {
                None
            }
        })
    };
    (
        get("user.name").unwrap_or_else(|| APP_GIT_NAME.to_string()),
        get("user.email").unwrap_or_else(|| APP_GIT_EMAIL.to_string()),
    )
}

/// The identity a commit should be authored as in `repo`, given whether the
/// AGENT did the work. Agent → `vault-chat-agent`; user → their real identity.
fn commit_identity(repo: &str, agent: bool) -> (String, String) {
    if agent {
        (AGENT_GIT_NAME.to_string(), AGENT_GIT_EMAIL.to_string())
    } else {
        human_identity(repo)
    }
}

/// Run a mutating git command in `dir`, authored as `(name, email)` via
/// per-invocation `-c user.*` overrides — so we set authorship without ever
/// mutating the repo's stored config. `rest` is the git subcommand and its args
/// (e.g. `["commit", "-q", "-m", msg]`). Replaces the old pattern of hardcoding
/// `-c user.name=vault-chat -c user.email=vault-chat@local` at every call site.
fn run_git_as(
    dir: &str,
    name: &str,
    email: &str,
    rest: &[&str],
) -> Result<(String, String, i32), String> {
    let name_cfg = format!("user.name={}", name);
    let email_cfg = format!("user.email={}", email);
    let mut args: Vec<&str> = vec!["-c", &name_cfg, "-c", &email_cfg];
    args.extend_from_slice(rest);
    run_git_mut(dir, &args)
}

// One lock per repo, keyed by canonical path so "C:\v" and "C:/v/" collapse
// to a single lock. Created lazily on first use.
static REPO_LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();

fn repo_lock_for(vault: &str) -> Arc<Mutex<()>> {
    let key = std::path::Path::new(vault)
        .canonicalize()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| vault.to_string());
    let map = REPO_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = map.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .entry(key)
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

/// Remove `.git/index.lock` only if it's older than STALE_LOCK_SECS — old
/// enough that no live git could still hold it (a normal commit holds it for
/// milliseconds). Called while we already own the per-repo lock, so any lock
/// seen here is necessarily external or orphaned by a crash.
fn clear_stale_index_lock(vault: &str) {
    let lock = PathBuf::from(vault).join(".git").join("index.lock");
    if let Ok(meta) = std::fs::metadata(&lock) {
        let stale = meta
            .modified()
            .ok()
            .and_then(|m| std::time::SystemTime::now().duration_since(m).ok())
            .map(|age| age.as_secs() >= STALE_LOCK_SECS)
            // Can't read the mtime → assume stale; better to clear than wedge.
            .unwrap_or(true);
        if stale {
            let _ = std::fs::remove_file(&lock);
        }
    }
}

/// If a prior auto-sync crashed mid-rebase/merge, the repo is stuck in that
/// state and every later commit silently no-ops — the "wedged vault." This
/// app owns its vaults' git (no human runs rebases by hand here), so a
/// leftover is always our own failed attempt: abort it so the next op starts
/// from a clean HEAD.
fn abort_stuck_merge_or_rebase(vault: &str) {
    let git = PathBuf::from(vault).join(".git");
    if git.join("rebase-merge").is_dir() || git.join("rebase-apply").is_dir() {
        let _ = run_git(vault, &["rebase", "--abort"]);
    }
    if git.join("MERGE_HEAD").exists() {
        let _ = run_git(vault, &["merge", "--abort"]);
    }
}

/// Run a mutating git sequence under the repo lock, after clearing any stale
/// lock. Serializes against every other in-process git writer for this repo.
fn with_repo_lock<T>(vault: &str, f: impl FnOnce() -> T) -> T {
    let lock = repo_lock_for(vault);
    let _g = lock.lock().unwrap_or_else(|e| e.into_inner());
    clear_stale_index_lock(vault);
    f()
}

fn is_index_lock_error(stderr: &str) -> bool {
    stderr.contains("index.lock")
}

/// Materialize registered submodules after a successful pull. Nested work
/// repos (e.g. a fork that lives inside the vault) keep their own remotes; the
/// vault only tracks their commit *pointers*, so on a fresh machine those
/// folders are empty until `submodule update --init` clones them from their
/// own remotes. No-op when the vault has no `.gitmodules`, so ordinary vaults
/// pay nothing. Best-effort: a submodule whose pinned commit hasn't been
/// pushed to its own remote yet must not fail the vault's own sync — log and
/// move on. Long timeout because the first clone of a big sub-repo can take
/// minutes.
///
/// Deliberately NOT `--recursive`: a sub-repo can itself vendor heavy
/// submodules (microsoft/BitNet pulls in a fork of llama.cpp, hundreds of MB),
/// and recursively cloning that inside the background sync loop — while holding
/// the vault lock — is the wrong default. This brings the vault's own nested
/// repos; if you need a sub-repo's full sub-tree (e.g. to build it), run
/// `git submodule update --init --recursive` inside that repo by hand.
fn maybe_update_submodules(vault: &str) {
    if !PathBuf::from(vault).join(".gitmodules").is_file() {
        return;
    }
    // Pick up any URL changes first (e.g. a sub-repo that got adopted/repointed
    // to the user's fork on another machine), so we clone from the right remote.
    let _ = run_git(vault, &["submodule", "sync"]);
    // Blobless partial clone: fetch the full commit graph but defer file contents
    // until they're actually checked out, so a big sub-repo materializes without
    // dragging its entire blob history onto every machine — git fetches blobs
    // lazily on demand. Falls back to a plain clone if the remote doesn't
    // advertise partial-clone support.
    let filtered = run_git_timeout(
        vault,
        &["submodule", "update", "--init", "--filter=blob:none"],
        1800,
    );
    let ok = matches!(&filtered, Ok((_, _, 0)));
    if ok {
        return;
    }
    if let Ok((_, stderr, code)) = &filtered {
        eprintln!(
            "[sync] partial submodule update (code {}): {} — retrying full",
            code,
            first_line(stderr).trim()
        );
    }
    match run_git_timeout(vault, &["submodule", "update", "--init"], 1800) {
        Ok((_, stderr, code)) if code != 0 => {
            eprintln!("[sync] submodule update (code {}): {}", code, stderr.trim());
        }
        Err(e) => eprintln!("[sync] submodule update failed: {}", e),
        _ => {}
    }
}

/// Extract the owner/org from a git remote URL — the segment before the repo
/// name. Handles `https://host/owner/repo(.git)` and `git@host:owner/repo(.git)`.
/// Lower-cased for case-insensitive comparison. None if it can't be parsed.
fn repo_owner(url: &str) -> Option<String> {
    let u = url.trim().trim_end_matches('/').trim_end_matches(".git");
    let parts: Vec<&str> = u.rsplitn(3, |c| c == '/' || c == ':').collect();
    // parts = [repo, owner, rest…]
    parts.get(1).map(|s| s.to_lowercase()).filter(|s| !s.is_empty())
}

/// Re-attach a detached-HEAD sub-repo to the branch whose tip is exactly the
/// current commit, so an owned submodule behaves like a normal working tree
/// instead of a frozen reference. Returns the local branch name on success.
///
/// Safe by construction: we only attach when HEAD already equals a remote branch
/// tip (`git branch -r --points-at HEAD`), so no commits are orphaned and the
/// working tree is unchanged. If HEAD is at no remote branch tip — a deliberate
/// old-commit checkout — returns None and the caller leaves it detached.
///
/// When several remote branches point at the commit, prefer the remote's default
/// branch (origin/HEAD), then any main/master, then the first listed.
fn attach_detached_to_branch(sub: &str) -> Option<String> {
    let (out, _, code) = run_git(
        sub,
        &["branch", "-r", "--points-at", "HEAD", "--format=%(refname:short)"],
    )
    .ok()?;
    if code != 0 {
        return None;
    }
    // Keep only "origin/<branch>" entries; drop the bare "origin" symref (which
    // `%(refname:short)` emits for refs/remotes/origin/HEAD) and any "->" arrow.
    let candidates: Vec<String> = out
        .lines()
        .map(|l| l.trim())
        .filter(|l| l.contains('/') && !l.contains("->"))
        .map(|s| s.to_string())
        .collect();
    if candidates.is_empty() {
        return None;
    }
    let default = run_git(
        sub,
        &["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    )
    .ok()
    .and_then(|(d, _, c)| if c == 0 { Some(d.trim().to_string()) } else { None });
    let pick = default
        .filter(|d| candidates.iter().any(|c| c == d))
        .or_else(|| {
            candidates
                .iter()
                .find(|c| c.ends_with("/main") || c.ends_with("/master"))
                .cloned()
        })
        .or_else(|| candidates.first().cloned())?;
    // "origin/main" -> "main"; preserves slashes in "origin/feature/x" -> "feature/x".
    let branch = pick.splitn(2, '/').nth(1).unwrap_or(&pick).to_string();
    // HEAD already equals this tip, so the checkout changes no files. Create the
    // local tracking branch, or switch to it if it already exists.
    let ok = matches!(
        run_git_mut(sub, &["switch", "-c", &branch, "--track", &pick]),
        Ok((_, _, 0))
    ) || matches!(run_git_mut(sub, &["switch", &branch]), Ok((_, _, 0)));
    if !ok {
        return None;
    }
    // Ensure upstream is set (the `switch` fallback for a pre-existing branch may
    // not have configured tracking).
    let _ = run_git_mut(sub, &["branch", "--set-upstream-to", &pick, &branch]);
    Some(branch)
}

/// Recover a submodule that's detached at a commit which is NOT any branch tip
/// (so `attach_detached_to_branch` gave up) ONTO its `.gitmodules`-configured
/// branch. This is the fix for the multi-machine submodule-pointer war: a stale
/// gitlink (e.g. an old upstream commit left by a `submodule update`) detaches
/// the working tree there, and the parent's auto-commit then captures that
/// stale commit as the gitlink and pushes it — reverting another machine's
/// correct pointer, every sync. A submodule that declares `branch = X` is meant
/// to TRACK X, not stay frozen on a pin, so we move it onto X (fetching the
/// remote tip first, fast-forwarding the local branch up to it) — recovering the
/// real work and making the captured gitlink follow the branch instead of
/// reverting it. Loss-free: `switch` keeps the clean tree, and we only ever
/// fast-forward the local branch (never reset). Returns the branch on success.
/// None (caller keeps it detached) when there's no configured branch or the
/// switch fails — preserving a deliberate, un-tracked old-commit pin.
fn recover_to_configured_branch(sub: &str, branch: Option<&str>) -> Option<String> {
    let branch = branch?.trim();
    if branch.is_empty() {
        return None;
    }
    let remote = format!("origin/{}", branch);
    // Make sure we have the branch's latest remote tip (the work may have been
    // pushed from another machine). Best-effort — offline still recovers onto
    // whatever the local branch already has, which still beats a stale pin.
    let _ = run_git_timeout(sub, &["fetch", "origin", branch], 120);
    let switched = matches!(run_git_mut(sub, &["switch", branch]), Ok((_, _, 0)))
        || matches!(
            run_git_mut(sub, &["switch", "-c", branch, "--track", &remote]),
            Ok((_, _, 0))
        );
    if !switched {
        return None;
    }
    // Fast-forward the local branch up to the remote tip so it carries the work,
    // not the stale commit we were detached at. FF-only never discards local
    // commits; if it can't FF (genuinely diverged), the branch still stands.
    let _ = run_git_mut(sub, &["merge", "--ff-only", &remote]);
    Some(branch.to_string())
}

/// Run the `gh` CLI in `cwd`, returning (stdout, stderr, exit code). GitHub auth
/// is entirely delegated to `gh` (the app holds no token), mirroring the platform
/// handling in `vault_sync_gh_create_repo`. Err only if `gh` can't be spawned.
fn run_gh(cwd: &str, args: &[&str]) -> Result<(String, String, i32), String> {
    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new("gh");
        c.creation_flags(0x08000000);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = Command::new("gh");
    cmd.current_dir(cwd);
    cmd.args(args);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    let out = cmd.output().map_err(|e| e.to_string())?;
    Ok((
        String::from_utf8_lossy(&out.stdout).to_string(),
        String::from_utf8_lossy(&out.stderr).to_string(),
        out.status.code().unwrap_or(-1),
    ))
}

/// Map a submodule's working-tree path back to its `.gitmodules` section name
/// (the `submodule.<name>.path = <rel>` key), needed to rewrite its URL.
fn submodule_name_for_path(vault: &str, rel: &str) -> Option<String> {
    let (out, _, c) = run_git(
        vault,
        &["config", "-f", ".gitmodules", "--get-regexp", "\\.path$"],
    )
    .ok()?;
    if c != 0 {
        return None;
    }
    for line in out.lines() {
        // "submodule.<name>.path <relpath>"
        if let Some((key, path)) = line.split_once(char::is_whitespace) {
            if path.trim() == rel {
                if let Some(name) = key
                    .strip_prefix("submodule.")
                    .and_then(|k| k.strip_suffix(".path"))
                {
                    return Some(name.to_string());
                }
            }
        }
    }
    None
}

/// Take ownership of a sub-repo whose remote belongs to someone else (e.g.
/// `microsoft/BitNet`) by forking it to the user's GitHub account and repointing
/// the submodule at the fork. The vault's invariant: every sub-repo has a remote
/// the user can push to, so it syncs like a normal folder. The original remote is
/// preserved as `upstream` for occasional `git fetch upstream` / PRs — a separate
/// flow from vault sync. Returns the fork URL on success.
///
/// Idempotent, best-effort: needs `gh` installed + authenticated as the vault
/// owner (so the fork lands in the right account); `gh repo fork` treats an
/// existing fork as success, so re-runs are no-ops. Returns None on any failure,
/// leaving the sub-repo untouched (caller then skips it exactly as before).
fn adopt_unowned_subrepo(vault: &str, rel: &str, sub: &str, vault_owner: &str) -> Option<String> {
    // Fork into the *vault owner's* account only. If gh is authed as someone
    // else, a fork there still wouldn't be "owned" by the vault — bail.
    let me = run_gh(sub, &["api", "user", "-q", ".login"])
        .ok()
        .and_then(|(o, _, c)| if c == 0 { Some(o.trim().to_lowercase()) } else { None })?;
    if me != vault_owner {
        return None;
    }
    let upstream_url = run_git(sub, &["remote", "get-url", "origin"])
        .ok()
        .and_then(|(u, _, c)| if c == 0 { Some(u.trim().to_string()) } else { None })?;
    // "https://github.com/microsoft/BitNet.git" -> "BitNet"
    let repo_name = upstream_url
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())?
        .to_string();
    // Server-side fork; no local clone (we already have the working tree).
    let (_, ferr, fc) = run_gh(sub, &["repo", "fork", &upstream_url, "--clone=false"]).ok()?;
    if fc != 0 {
        eprintln!("[sync] fork of '{}' failed: {}", rel, first_line(&ferr).trim());
        return None;
    }
    let fork_url = format!("https://github.com/{}/{}.git", me, repo_name);
    // Repoint: origin -> fork (pushable), keep the original as upstream.
    let _ = run_git_mut(sub, &["remote", "add", "upstream", &upstream_url]); // no-op if exists
    let _ = run_git_mut(sub, &["remote", "set-url", "upstream", &upstream_url]);
    let _ = run_git_mut(sub, &["remote", "set-url", "origin", &fork_url]);
    // Propagate the new URL into .gitmodules so other machines clone the fork too.
    if let Some(name) = submodule_name_for_path(vault, rel) {
        let key = format!("submodule.{}.url", name);
        let _ = run_git_mut(vault, &["config", "-f", ".gitmodules", &key, &fork_url]);
        let _ = run_git_mut(vault, &["submodule", "sync", "--", rel]);
    }
    // Fetch the fork so the subsequent attach/upstream wiring sees its refs.
    let _ = run_git_timeout(sub, &["fetch", "origin"], 300);
    Some(fork_url)
}

/// Repack a git repo when it has accumulated too many loose objects. The vault's
/// append-only logs (conversations/notes/schedules `.jsonl`) get re-committed on
/// every autosave cycle, piling up loose objects fast — 362 MiB loose for a
/// 34 MiB packed history was observed. `git gc` delta-compresses those near-
/// identical versions down to almost nothing. We don't lean on git's own
/// `gc --auto`: it triggers on object *count* (default 6700 loose), which a few
/// large blobs never reach even while eating hundreds of MB. Threshold on loose
/// count with a low bar instead. Best-effort and non-destructive — gc only
/// repacks; it never rewrites history.
fn maybe_compact_git(dir: &str) {
    let loose = run_git(dir, &["count-objects", "-v"])
        .ok()
        .filter(|(_, _, c)| *c == 0)
        .and_then(|(out, _, _)| {
            out.lines().find_map(|l| {
                l.strip_prefix("count:")
                    .and_then(|n| n.trim().parse::<u64>().ok())
            })
        })
        .unwrap_or(0);
    if loose < 300 {
        return;
    }
    match run_git_timeout(dir, &["gc", "--quiet"], 600) {
        Ok((_, err, c)) if c != 0 => {
            eprintln!("[sync] gc {} (code {}): {}", dir, c, first_line(&err).trim())
        }
        Err(e) => eprintln!("[sync] gc {} failed: {}", dir, e),
        _ => {}
    }
}

/// Patterns for large binary/model artifacts that should live in git-LFS rather
/// than as fat blobs in every machine's history.
const LFS_PATTERNS: &[&str] = &[
    "*.gguf", "*.safetensors", "*.bin", "*.pt", "*.pth", "*.ckpt", "*.onnx", "*.h5", "*.npz",
    "*.model", "*.weights", "*.tflite", "*.pb",
];

/// Enable git-LFS for heavy model artifacts in `dir`, if git-LFS is installed.
/// Strictly conditional: with no `git lfs` binary this is a no-op (adding LFS
/// filter attributes without the binary would break `git add` of matching files).
/// Only sets up tracking for *future* files — existing blobs already in history
/// are left alone (a `git lfs migrate` rewrite is a separate, deliberate step).
fn ensure_lfs_tracking(dir: &str) {
    // Probe: is git-LFS available at all?
    if run_git(dir, &["lfs", "version"]).map(|(_, _, c)| c != 0).unwrap_or(true) {
        return; // git-lfs not installed — stay dormant
    }
    let _ = run_git_mut(dir, &["lfs", "install", "--local"]);
    for pat in LFS_PATTERNS {
        // `git lfs track` is idempotent: it won't duplicate an existing rule.
        let _ = run_git_mut(dir, &["lfs", "track", pat]);
    }
}

/// How vault-chat may sync a nested git repo, decided by the user's *real*
/// relationship to its `origin` remote — never by overwriting ownership.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum RepoClass {
    /// `origin` is the user's own repo → commit + push to its tracking branch.
    Mine,
    /// `origin` is someone else's, but the user has push access (a real
    /// collaborator) → commit onto a dedicated `vault-chat/<user>` branch and
    /// push ONLY that branch. The team's default branch is never touched by
    /// automation; landing work there is a deliberate, separate merge the user
    /// does by hand. Keeps shared history clean and the user connected.
    Shared,
    /// `origin` is someone else's with NO push access → fork it to the user's
    /// account, repoint `origin` at the fork, then sync the fork like `Mine`.
    /// The only case where forking is wanted: nothing to collaborate on, and a
    /// fork is the sole way to own a syncable copy.
    Foreign,
    /// No `origin` remote → commit locally for version history; nothing to push.
    Internal,
    /// Can't classify safely (no `gh` login, unparseable remote) → leave it
    /// untouched. Never risk committing into a repo we can't verify.
    Skip,
}

/// The GitHub login vault-chat is authenticated as (lowercased), resolved once
/// per process — telling the user's own repos from other people's needs it, and
/// it never changes within a run. None if `gh` is missing/unauthenticated.
fn gh_login(cwd: &str) -> Option<String> {
    static CACHE: OnceLock<Option<String>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            run_gh(cwd, &["api", "user", "-q", ".login"])
                .ok()
                .and_then(|(o, _, c)| if c == 0 { Some(o.trim().to_lowercase()) } else { None })
                .filter(|s| !s.is_empty())
        })
        .clone()
}

/// "https://github.com/owner/Repo.git" → "Repo" (repo name, case preserved).
fn repo_name(url: &str) -> Option<String> {
    url.trim()
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .rsplit(|c| c == '/' || c == ':')
        .next()
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
}

/// Does the authenticated user have push access to `owner/repo`? Asks GitHub
/// directly (`gh api repos/{owner}/{repo} .permissions.push`): a collaborator
/// gets `true`, a stranger `false`/404. This is the probe that splits "shared"
/// (commit to my own branch on the real repo) from "foreign" (fork it). Cached
/// per `owner/repo` for the process — permissions don't flip mid-session, and
/// it keeps a fast sync loop from hitting the API every cycle.
fn can_push_to(cwd: &str, owner: &str, repo: &str) -> bool {
    static CACHE: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();
    let key = format!("{}/{}", owner.to_lowercase(), repo.to_lowercase());
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(v) = cache.lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
        return *v;
    }
    let allowed = run_gh(
        cwd,
        &[
            "api",
            &format!("repos/{}/{}", owner, repo),
            "--jq",
            ".permissions.push",
        ],
    )
    .ok()
    .map(|(o, _, c)| c == 0 && o.trim() == "true")
    .unwrap_or(false);
    cache
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(key, allowed);
    allowed
}

/// Classify a nested repo by its `origin` and the user's access to it.
fn classify_repo(sub: &str, me: Option<&str>) -> RepoClass {
    let origin = run_git(sub, &["remote", "get-url", "origin"]).ok().and_then(|(u, _, c)| {
        let u = u.trim().to_string();
        if c == 0 && !u.is_empty() {
            Some(u)
        } else {
            None
        }
    });
    let Some(origin) = origin else {
        return RepoClass::Internal; // no remote — local history only
    };
    let Some(owner) = repo_owner(&origin) else {
        return RepoClass::Skip; // unparseable remote — don't guess
    };
    // Without a gh login we can't verify whose repo this is, so we don't touch
    // it — better a stale dot than committing into someone else's checkout.
    let Some(me) = me else {
        return RepoClass::Skip;
    };
    if owner == me {
        return RepoClass::Mine;
    }
    let Some(repo) = repo_name(&origin) else {
        return RepoClass::Skip;
    };
    if can_push_to(sub, &owner, &repo) {
        RepoClass::Shared
    } else {
        RepoClass::Foreign
    }
}

/// Put `sub` on `branch`, carrying any uncommitted work onto it. No-op if
/// already there. Tracks an existing remote branch of the same name (so both
/// machines ride it), else creates a fresh local branch from the current HEAD.
/// Returns false if neither switch worked (e.g. a conflicting checkout).
fn ensure_on_branch(sub: &str, branch: &str) -> bool {
    let cur = run_git(sub, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .ok()
        .and_then(|(b, _, c)| if c == 0 { Some(b.trim().to_string()) } else { None });
    if cur.as_deref() == Some(branch) {
        return true;
    }
    let remote = format!("origin/{}", branch);
    let remote_exists = matches!(
        run_git(sub, &["rev-parse", "--verify", "--quiet", &remote]),
        Ok((_, _, 0))
    );
    if remote_exists {
        if matches!(run_git_mut(sub, &["switch", branch]), Ok((_, _, 0))) {
            return true;
        }
        if matches!(
            run_git_mut(sub, &["switch", "-c", branch, "--track", &remote]),
            Ok((_, _, 0))
        ) {
            return true;
        }
    }
    matches!(run_git_mut(sub, &["switch", "-c", branch]), Ok((_, _, 0)))
        || matches!(run_git_mut(sub, &["switch", branch]), Ok((_, _, 0)))
}

/// Sync ONE nested repo per its class. Best-effort throughout — any step that
/// fails is logged and skipped, never fatal to the vault's own sync.
/// `cfg_branch` is the `.gitmodules`-declared tracking branch when this repo is
/// a registered submodule (used for stale-pin recovery), else None.
fn sync_one_repo(
    vault: &str,
    sub: &str,
    rel: &str,
    agent: bool,
    me: Option<&str>,
    cfg_branch: Option<&str>,
) {
    let mut class = classify_repo(sub, me);

    // Foreign → fork to the user's account and repoint origin at the fork, then
    // sync the fork exactly like one of the user's own repos.
    if class == RepoClass::Foreign {
        match me.and_then(|m| adopt_unowned_subrepo(vault, rel, sub, m)) {
            Some(fork) => {
                eprintln!("[sync] foreign repo '{}' forked → {}", rel, fork);
                class = RepoClass::Mine;
            }
            None => return, // can't fork (no gh write) — leave it read-only
        }
    }
    if class == RepoClass::Skip {
        return;
    }

    // Resolve the working branch.
    //  - Shared: a dedicated, isolated `vault-chat/<me>` branch so automation
    //    never touches the team's default; created from wherever the work sits
    //    (carrying uncommitted edits) and tracked so both machines ride it.
    //  - Mine / Internal: the repo's own branch. A freshly-materialized
    //    submodule lands detached, so attach it to its branch tip (or recover
    //    onto its .gitmodules-declared branch), exactly as before.
    let shared_branch = if class == RepoClass::Shared {
        let Some(m) = me else { return };
        let b = format!("vault-chat/{}", m);
        if !ensure_on_branch(sub, &b) {
            eprintln!("[sync] shared repo '{}' — couldn't switch to '{}'; skipping", rel, b);
            return;
        }
        Some(b)
    } else {
        let on_branch = matches!(
            run_git(sub, &["symbolic-ref", "--quiet", "--short", "HEAD"]),
            Ok((ref b, _, 0)) if !b.trim().is_empty()
        );
        if !on_branch {
            match attach_detached_to_branch(sub) {
                Some(b) => eprintln!("[sync] repo '{}' attached to branch '{}'", rel, b),
                None => match recover_to_configured_branch(sub, cfg_branch) {
                    Some(b) => eprintln!(
                        "[sync] repo '{}' recovered onto tracking branch '{}' (was detached at a stale pin)",
                        rel, b
                    ),
                    None => return, // deliberate detached pin — respect it
                },
            }
        }
        None
    };

    // Commit any uncommitted edits, authored by who did the work. In a shared
    // repo an agent commit is co-signed by the user, so a teammate reading the
    // history sees a real human standing behind it.
    let (cn, ce) = commit_identity(sub, agent);
    if let Ok((st, _, _)) = run_git(sub, &["status", "--porcelain"]) {
        if !st.trim().is_empty() {
            let _ = run_git_as(sub, &cn, &ce, &["add", "-A"]);
            let mut msg = String::new();
            if agent {
                msg.push_str("[agent] ");
            }
            msg.push_str("vault-chat: auto-sync (sub-repo)");
            if agent && class == RepoClass::Shared {
                let (hn, he) = human_identity(sub);
                msg.push_str(&format!("\n\nCo-authored-by: {} <{}>", hn, he));
            }
            let _ = run_git_as(sub, &cn, &ce, &["commit", "-q", "-m", &msg]);
        }
    }

    // Push.
    match (&shared_branch, class) {
        // Shared → push only the dedicated branch, with -u so it exists on the
        // remote and tracks. Never the team's default branch.
        (Some(branch), _) => match run_git_timeout(sub, &["push", "-u", "origin", branch], 300) {
            Ok((_, perr, pc)) if pc != 0 => {
                eprintln!("[sync] shared repo '{}' push skipped: {}", rel, first_line(&perr).trim())
            }
            Err(e) => eprintln!("[sync] shared repo '{}' push error: {}", rel, e),
            _ => {}
        },
        // Mine → push the tracking branch when it's ahead. Needs an upstream.
        (None, RepoClass::Mine) => {
            let has_upstream = matches!(
                run_git(sub, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]),
                Ok((_, _, 0))
            );
            let ahead = if has_upstream {
                match run_git(sub, &["rev-list", "--count", "@{upstream}..HEAD"]) {
                    Ok((c, _, 0)) => c.trim().parse::<u64>().unwrap_or(0),
                    _ => 0,
                }
            } else {
                0
            };
            if ahead > 0 {
                match run_git_timeout(sub, &["push"], 300) {
                    Ok((_, perr, pc)) if pc != 0 => {
                        eprintln!("[sync] repo '{}' push skipped: {}", rel, first_line(&perr).trim())
                    }
                    Err(e) => eprintln!("[sync] repo '{}' push error: {}", rel, e),
                    _ => {}
                }
            }
        }
        // Internal → no remote; the local commit above is the version history.
        _ => {}
    }

    maybe_compact_git(sub);
}

/// Walk the vault for every nested git repo (a dir containing `.git`) at any
/// reasonable depth, skipping the vault's own `.git`, dotdirs, and heavy build
/// dirs. Descends INTO nested repos so a repo-inside-a-repo (e.g. a class repo
/// holding a team project) is found too. Returns vault-relative, slash-joined
/// paths.
fn find_all_nested_repos(root: &std::path::Path) -> Vec<String> {
    fn walk(dir: &std::path::Path, root: &std::path::Path, depth: usize, found: &mut Vec<String>) {
        if depth > 4 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for e in entries.flatten() {
            let p = e.path();
            if !p.is_dir() {
                continue;
            }
            let name = match p.file_name().and_then(|n| n.to_str()) {
                Some(n) => n,
                None => continue,
            };
            if name.starts_with('.')
                || matches!(
                    name,
                    "node_modules" | "target" | "__pycache__" | "venv" | ".venv" | "dist" | "build"
                )
            {
                continue;
            }
            if p.join(".git").exists() {
                if let Ok(rel) = p.strip_prefix(root) {
                    found.push(rel.to_string_lossy().replace('\\', "/"));
                }
            }
            walk(&p, root, depth + 1, found); // descend (repos inside repos)
        }
    }
    let mut found = Vec::new();
    walk(root, root, 0, &mut found);
    found.sort();
    found
}

/// Commit + sync every nested git repo in the vault, each on its own merits —
/// classified by *its own* remote and the user's relationship to it (see
/// `RepoClass`). Replaces the old submodule-only, vault-remote-gated path: a
/// nested repo now syncs even when the vault root has no remote, and an embedded
/// repo never registered as a submodule is handled too. This is what clears the
/// per-repo "uncommitted changes" dots. Best-effort; never fatal to vault sync.
fn sync_nested_repos(vault: &str, agent: bool) {
    // Build the work list: registered submodules (carry a .gitmodules tracking
    // branch we use for stale-pin recovery) ∪ embedded repos found on disk.
    let mut repos: Vec<(String, Option<String>)> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    if PathBuf::from(vault).join(".gitmodules").is_file() {
        if let Ok((out, _, 0)) =
            run_git(vault, &["config", "-f", ".gitmodules", "--get-regexp", "\\.path$"])
        {
            for line in out.lines() {
                let (key, rel) = match line.split_once(char::is_whitespace) {
                    Some((k, p)) => (k, p.trim()),
                    None => continue,
                };
                if rel.is_empty() {
                    continue;
                }
                let cfg_branch = key
                    .strip_suffix(".path")
                    .map(|p| format!("{}.branch", p))
                    .and_then(|bk| {
                        run_git(vault, &["config", "-f", ".gitmodules", &bk])
                            .ok()
                            .and_then(|(v, _, c)| {
                                if c == 0 && !v.trim().is_empty() {
                                    Some(v.trim().to_string())
                                } else {
                                    None
                                }
                            })
                    });
                if seen.insert(rel.to_string()) {
                    repos.push((rel.to_string(), cfg_branch));
                }
            }
        }
    }
    for rel in find_all_nested_repos(std::path::Path::new(vault)) {
        if seen.insert(rel.clone()) {
            repos.push((rel, None));
        }
    }
    if repos.is_empty() {
        return;
    }

    // Resolve "who am I on GitHub" once (cached); drives mine/shared/foreign.
    let me = gh_login(vault);

    for (rel, cfg_branch) in repos {
        let sub = format!("{}/{}", vault, rel);
        if !PathBuf::from(&sub).join(".git").exists() {
            continue; // not materialized on this machine
        }
        sync_one_repo(vault, &sub, &rel, agent, me.as_deref(), cfg_branch.as_deref());
    }
}

/// Mutating git with retry: if it fails on a foreign `index.lock`, clear a
/// stale lock and retry with backoff. In-process writers are already
/// serialized by `with_repo_lock`, so this only covers a foreign git (the
/// user's CLI, a second app instance) briefly holding the lock.
fn run_git_mut(cwd: &str, args: &[&str]) -> Result<(String, String, i32), String> {
    let mut attempt = 0u32;
    loop {
        let (out, err, code) = run_git(cwd, args)?;
        if code != 0 && is_index_lock_error(&err) && attempt < 4 {
            attempt += 1;
            clear_stale_index_lock(cwd);
            std::thread::sleep(Duration::from_millis(150 * attempt as u64));
            continue;
        }
        return Ok((out, err, code));
    }
}

fn run_git(
    cwd: &str,
    args: &[&str],
) -> Result<(String, String, i32), String> {
    run_git_timeout(cwd, args, GIT_TIMEOUT_SECS)
}

/// Like `run_git` but with a caller-chosen timeout. Used for operations that
/// can legitimately run far longer than a normal git command — notably the
/// first `submodule update --init`, which clones whole sub-repos.
fn run_git_timeout(
    cwd: &str,
    args: &[&str],
    timeout_secs: u64,
) -> Result<(String, String, i32), String> {
    use std::io::Read;
    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new("git");
        c.creation_flags(0x08000000);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = Command::new("git");
    cmd.current_dir(cwd);
    cmd.args(args);
    // Never block on an interactive credential/passphrase prompt — on the
    // headless server that would hang the whole sync loop forever. Fail fast
    // and let the caller surface the auth error instead.
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    // Drain both pipes on their own threads so a large stdout can't deadlock
    // against a full stderr pipe (or vice-versa) while we wait.
    let so = child.stdout.take();
    let se = child.stderr.take();
    let h_out = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(mut o) = so {
            let _ = o.read_to_string(&mut s);
        }
        s
    });
    let h_err = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(mut e) = se {
            let _ = e.read_to_string(&mut s);
        }
        s
    });
    // Bounded wait: kill a hung git rather than block a worker thread forever.
    let start = Instant::now();
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code().unwrap_or(-1),
            Ok(None) => {
                if start.elapsed() >= Duration::from_secs(timeout_secs) {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "git timed out after {}s: git {}",
                        timeout_secs,
                        args.join(" ")
                    ));
                }
                std::thread::sleep(Duration::from_millis(15));
            }
            Err(e) => return Err(e.to_string()),
        }
    };
    let stdout = h_out.join().unwrap_or_default();
    let stderr = h_err.join().unwrap_or_default();
    Ok((stdout, stderr, code))
}

// `.gitattributes` seeded into every vault. Without it, Windows (autocrlf)
// stores CRLF in the working tree while the Linux server uses LF, so every
// text file shows as modified on the other box → spurious autosave commits
// and guaranteed cross-machine rebase conflicts. `eol=lf` pins a single
// canonical line ending everywhere. `merge=union` makes the app's churny
// append-only JSONL logs (conversations/schedules/notes) combine both
// sides' lines on conflict instead of wedging the sync rebase.
const VAULT_GITATTRIBUTES: &str = "\
# Managed by vault-chat. Keeps cross-machine git sync conflict-free.
* text=auto eol=lf
*.jsonl merge=union
*.pdf binary
*.png binary
*.jpg binary
*.jpeg binary
*.gif binary
*.webp binary
*.ico binary
*.zip binary
*.gz binary
*.bundle binary
";

/// Ensure `<vault>/.gitattributes` exists and carries our managed block.
/// Returns true if it wrote the file (i.e. it was missing or stale). Does
/// NOT renormalize existing history — that one-time migration is left to a
/// deliberate step so opening a vault never triggers a surprise churn.
fn ensure_vault_gitattributes(vault: &str) -> bool {
    let path = PathBuf::from(vault).join(".gitattributes");
    let current = std::fs::read_to_string(&path).unwrap_or_default();
    if current.contains("Managed by vault-chat") {
        return false;
    }
    // Preserve any pre-existing user rules by prepending our block.
    let contents = if current.trim().is_empty() {
        VAULT_GITATTRIBUTES.to_string()
    } else {
        format!("{}\n{}", VAULT_GITATTRIBUTES, current)
    };
    std::fs::write(&path, contents).is_ok()
}

// `.gitignore` seeded into every vault. Keeps ephemeral, machine-local
// runtime state out of git so it doesn't churn history or collide across
// machines. The heartbeat (run-heartbeat.json) is rewritten every ~10s
// during agent runs; the log/backup/temp files and Python caches are
// likewise local scratch. Deliberately does NOT ignore the synced state —
// conversations.jsonl, keys.enc, and everything under .vault-chat/agent/**
// must stay tracked.
const VAULT_GITIGNORE: &str = "\
# Managed by vault-chat. Ephemeral machine-local state — never synced.
.vault-chat/run-heartbeat.json
.vault-chat/app-log.txt
.vault-chat/*.bak
.vault-chat/*.tmp
__pycache__/
*.pyc
";

/// Ensure `<vault>/.gitignore` exists and carries our managed block.
/// Returns true if it wrote the file (i.e. it was missing or stale).
/// Mirrors `ensure_vault_gitattributes`: prepends our block to preserve
/// any pre-existing user rules, and is idempotent (the marker comment
/// guards against duplicating the block on re-run).
fn ensure_vault_gitignore(vault: &str) -> bool {
    let path = PathBuf::from(vault).join(".gitignore");
    let current = std::fs::read_to_string(&path).unwrap_or_default();
    if current.contains("Managed by vault-chat") {
        return false;
    }
    // Preserve any pre-existing user rules by prepending our block.
    let contents = if current.trim().is_empty() {
        VAULT_GITIGNORE.to_string()
    } else {
        format!("{}\n{}", VAULT_GITIGNORE, current)
    };
    std::fs::write(&path, contents).is_ok()
}

/// Read recent commits from a git repo at a vault-relative subdirectory
/// (e.g. a nested work repo like `DeepDL/bitnet-repro`). Unlike
/// `git_recent_commits` — which is hardwired to the vault root and the
/// `vault-chat-start` anchor — this is a plain read-only `git log` meant
/// for monitoring/coach use: it reaches *nested* repos and never depends
/// on the Bash tool being enabled. Returns oneline-style output.
#[tauri::command]
async fn git_log_subdir(
    vault: String,
    subdir: String,
    since: Option<String>,
    author: Option<String>,
    max_count: Option<u32>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root_raw = std::path::Path::new(&vault);
        let rel = subdir.trim();
        let target_raw = if rel.is_empty() || rel == "." {
            root_raw.to_path_buf()
        } else {
            root_raw.join(rel)
        };
        // Security: canonicalize both sides and confirm the resolved
        // target stays inside the vault, so a crafted `../` subdir can't
        // read an arbitrary repo on disk.
        let canon_root = root_raw
            .canonicalize()
            .map_err(|e| format!("vault path: {}", e))?;
        let canon_target = target_raw
            .canonicalize()
            .map_err(|e| format!("subdir {}: {}", subdir, e))?;
        if !canon_target.starts_with(&canon_root) {
            return Err("subdir escapes the vault".to_string());
        }
        // Pass the non-canonical path to git: on Windows `canonicalize`
        // yields a `\\?\` extended-length prefix that some git builds
        // choke on as a working directory.
        let cwd = target_raw.to_string_lossy().to_string();
        let n = format!("-n{}", max_count.unwrap_or(40).min(500));
        let mut args: Vec<String> =
            vec!["log".into(), "--oneline".into(), "--no-color".into(), n];
        if let Some(s) = since.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            args.push(format!("--since={}", s));
        }
        if let Some(a) = author.as_ref().map(|a| a.trim()).filter(|a| !a.is_empty()) {
            args.push(format!("--author={}", a));
        }
        let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        let (out, err, code) = run_git(&cwd, &arg_refs)?;
        if code != 0 {
            return Err(format!("git log {}: {}", subdir, err.trim()));
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Ensure the vault has a git repo AND a `vault-chat-start` tag
/// anchoring "when vault-chat first saw this vault." Two cases:
///
/// 1. Vault had no git history → init, commit current state, tag.
/// 2. Vault was already a git repo → leave history alone; only create
///    the tag at the current HEAD (if the tag doesn't exist yet).
///
/// Returns true if anything was newly created (repo, tag, or both).
/// Idempotent — subsequent calls are cheap no-ops.
#[tauri::command]
async fn git_init_if_needed(vault: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_repo_lock(&vault, || {
        let git_dir = PathBuf::from(&vault).join(".git");
        let mut did_work = false;
        // App housekeeping on the user's own vault is authored as the user, not
        // a bot — it's their repo and their files being brought under version
        // control. Resolved once; cheap (reads git config).
        let (hn, he) = human_identity(&vault);

        if !git_dir.is_dir() {
            run_git_mut(&vault, &["init", "-q"])?;
            // Seed .gitattributes BEFORE the first `add` so line-ending
            // normalization applies from the very first commit — the repo is
            // born conflict-safe across Windows/Linux.
            ensure_vault_gitattributes(&vault);
            // Seed .gitignore likewise BEFORE the first `add` so ephemeral
            // runtime state (heartbeat, logs, caches) never enters history.
            ensure_vault_gitignore(&vault);
            run_git_as(&vault, &hn, &he, &["add", "-A"])?;
            run_git_as(
                &vault,
                &hn,
                &he,
                &[
                    "commit",
                    "--allow-empty",
                    "-q",
                    "-m",
                    "vault-chat: pre-existing vault state",
                ],
            )?;
            did_work = true;
        } else {
            // Existing repo (predates managed .gitattributes): add the file
            // and commit just it. No tree-wide renormalize, so opening an old
            // vault never triggers a surprise churn — only new writes pick up
            // the eol/merge rules.
            if ensure_vault_gitattributes(&vault) {
                abort_stuck_merge_or_rebase(&vault);
                run_git_as(&vault, &hn, &he, &["add", "--", ".gitattributes"])?;
                let (_, _, code) = run_git_as(
                    &vault,
                    &hn,
                    &he,
                    &["commit", "-q", "-m", "vault-chat: add managed .gitattributes"],
                )?;
                if code == 0 {
                    did_work = true;
                }
            }
            // Existing repo (predates managed .gitignore): seed the file and
            // commit just it. If an ephemeral file like the heartbeat was
            // already tracked before the ignore existed, `git rm --cached`
            // stops tracking it (leaving the working copy in place) so it
            // stops churning history going forward.
            if ensure_vault_gitignore(&vault) {
                abort_stuck_merge_or_rebase(&vault);
                // Untrack any already-committed ephemeral files. `--ignore-unmatch`
                // keeps this a no-op when they were never tracked.
                let _ = run_git_as(
                    &vault,
                    &hn,
                    &he,
                    &[
                        "rm",
                        "-r",
                        "--cached",
                        "--quiet",
                        "--ignore-unmatch",
                        "--",
                        ".vault-chat/run-heartbeat.json",
                        ".vault-chat/app-log.txt",
                    ],
                );
                run_git_as(&vault, &hn, &he, &["add", "--", ".gitignore"])?;
                let (_, _, code) = run_git_as(
                    &vault,
                    &hn,
                    &he,
                    &["commit", "-q", "-m", "vault-chat: add managed .gitignore"],
                )?;
                if code == 0 {
                    did_work = true;
                }
            }
        }

        // Route heavy model artifacts to git-LFS for future writes. No-op unless
        // git-LFS is installed, so vaults without it are unaffected.
        ensure_lfs_tracking(&vault);

        // Create the vault-chat-start tag if it doesn't already exist.
        // The tag marks "vault as it was when vault-chat first opened
        // it." Never moves once placed.
        let (_, _, tag_check) =
            run_git(&vault, &["rev-parse", "--verify", "vault-chat-start"])?;
        if tag_check != 0 {
            // Tag absent — create it at current HEAD.
            run_git_mut(&vault, &["tag", "vault-chat-start"])?;
            did_work = true;
        }

        Ok(did_work)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Stage all changes and commit with the given message. Returns the
/// short hash of the new commit, or None if nothing was staged.
#[tauri::command]
async fn git_commit_all(
    vault: String,
    message: String,
    agent: Option<bool>,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_repo_lock(&vault, || {
        // A crashed prior auto-sync can leave the repo mid-rebase, where
        // every commit silently no-ops. Clear that first so this commit
        // actually lands instead of vanishing.
        abort_stuck_merge_or_rebase(&vault);
        let (status_out, _, _) = run_git(&vault, &["status", "--porcelain"])?;
        if status_out.trim().is_empty() {
            return Ok(None);
        }
        // Author by origin: agent-written turns are stamped `vault-chat-agent`;
        // the user's own edits carry the user's *real* identity (not a bot), so
        // the vault's history shows true ownership, reinforced by the `[agent]`
        // subject tag for agent turns.
        let (name, email) = commit_identity(&vault, agent.unwrap_or(false));
        run_git_as(&vault, &name, &email, &["add", "-A"])?;
        run_git_as(&vault, &name, &email, &["commit", "-q", "-m", &message])?;
        let (hash, _, _) = run_git(&vault, &["rev-parse", "--short", "HEAD"])?;
        Ok(Some(hash.trim().to_string()))
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Return the most recent N commits as structured records.
/// By default stops at the `vault-chat-start` tag (inclusive) — commits
/// above that are the user's own pre-vault-chat history and we don't
/// offer them for revert. Pass `include_before_start: true` to see them
/// anyway.
#[tauri::command]
async fn git_recent_commits(
    vault: String,
    n: Option<usize>,
    include_before_start: Option<bool>,
) -> Result<Vec<GitCommit>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let n = n.unwrap_or(30).min(500);
        let include_all = include_before_start.unwrap_or(false);
        let fmt = "%H%x1f%h%x1f%s%x1f%an%x1f%ad%x1f%b%x1e";

        let (tag_hash, _, tag_code) =
            run_git(&vault, &["rev-parse", "--verify", "vault-chat-start"])?;
        let tag_hash = if tag_code == 0 {
            Some(tag_hash.trim().to_string())
        } else {
            None
        };

        let (out, _, _) = run_git(
            &vault,
            &[
                "log",
                &format!("-{}", n),
                &format!("--pretty=format:{}", fmt),
                "--date=format:%Y-%m-%d %H:%M",
            ],
        )?;

        let mut commits = Vec::new();
        for record in out.split('\x1e') {
            let r = record.trim();
            if r.is_empty() {
                continue;
            }
            let parts: Vec<&str> = r.splitn(6, '\x1f').collect();
            if parts.len() < 5 {
                continue;
            }
            let hash = parts[0].to_string();
            let is_anchor = tag_hash.as_deref() == Some(hash.as_str());
            commits.push(GitCommit {
                hash,
                short_hash: parts[1].to_string(),
                subject: parts[2].to_string(),
                author: parts[3].to_string(),
                date: parts[4].to_string(),
                body: parts.get(5).map(|s| s.trim().to_string()).unwrap_or_default(),
                is_anchor,
            });
            if is_anchor && !include_all {
                break;
            }
        }
        Ok(commits)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Find the git repository root that contains `path`. Walks up from the
/// file's directory looking for a `.git` entry, stopping at (and never
/// above) `vault`. Returns the repo root as an absolute path if found, or
/// `None` if the file is not inside any git repo within the vault.
///
/// Used by the history modal to show the right repo's history when a file
/// inside a nested sub-repo (e.g. `DeepDL/bitnet-repro/notes.md`) is open.
#[tauri::command]
async fn git_repo_root_for_file(vault: String, path: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let vault_path = PathBuf::from(&vault);
        // Start from the file's parent directory (or the path itself if it is
        // already a directory).
        let start = {
            let p = PathBuf::from(&path);
            if p.is_dir() { p } else { p.parent().map(|p| p.to_path_buf()).unwrap_or(p) }
        };

        let mut current = start;
        loop {
            // Never escape the vault boundary.
            if !current.starts_with(&vault_path) {
                break;
            }
            if current.join(".git").exists() {
                return Some(current.to_string_lossy().replace('\\', "/"));
            }
            // Stop once we hit the vault root itself (we already checked it).
            if current == vault_path {
                break;
            }
            match current.parent() {
                Some(p) => current = p.to_path_buf(),
                None => break,
            }
        }
        None
    })
    .await
    .ok()
    .flatten()
}

/// Revert the most recent commit (leaves a new commit that undoes it
/// — safer than reset, keeps history). Errors if HEAD is the initial
/// commit.
#[tauri::command]
async fn git_revert_head(vault: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_repo_lock(&vault, || {
        let (count_out, _, _) = run_git(&vault, &["rev-list", "--count", "HEAD"])?;
        let count: usize = count_out.trim().parse().unwrap_or(0);
        if count < 2 {
            return Err("nothing to undo yet".to_string());
        }
        let (hn, he) = human_identity(&vault);
        let (_, stderr, code) =
            run_git_as(&vault, &hn, &he, &["revert", "--no-edit", "HEAD"])?;
        if code != 0 {
            return Err(format!("revert failed: {}", stderr.trim()));
        }
        let (hash, _, _) = run_git(&vault, &["rev-parse", "--short", "HEAD"])?;
        Ok(hash.trim().to_string())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Show a commit's diff stats (fast — file list + change counts only).
/// Pass `patch: true` to include the full patch text, capped at 80k.
/// Root commits (no parent) have no meaningful diff — for those we
/// return a short "initial state" message instead of dumping the
/// entire tree.
#[tauri::command]
async fn git_show_commit(
    vault: String,
    hash: String,
    patch: Option<bool>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Does this commit have a parent? If not, short-circuit — a
        // "diff" against nothing is just every file, which isn't useful.
        let (_, _, parent_code) = run_git(&vault, &["rev-parse", "--verify", &format!("{}^", hash)])?;
        if parent_code != 0 {
            let (files_out, _, _) = run_git(
                &vault,
                &["ls-tree", "-r", "--name-only", &hash],
            )?;
            let file_count = files_out.lines().filter(|l| !l.trim().is_empty()).count();
            let (subject, _, _) = run_git(
                &vault,
                &["log", "-1", "--pretty=format:%s", &hash],
            )?;
            return Ok(format!(
                "{}\n\nInitial vault state — {} file{} tracked.\n(No diff; this is the root commit.)",
                subject.trim(),
                file_count,
                if file_count == 1 { "" } else { "s" },
            ));
        }

        let want_patch = patch.unwrap_or(false);
        let args: Vec<&str> = if want_patch {
            vec!["show", "--stat", "--patch", "--format=%h %s%n%n%b", &hash]
        } else {
            vec!["show", "--stat", "--format=%h %s%n%n%b", &hash]
        };
        let (out, stderr, code) = run_git(&vault, &args)?;
        if code != 0 {
            return Err(stderr.trim().to_string());
        }
        const MAX: usize = 80_000;
        if out.len() > MAX {
            let truncated: String = out.chars().take(MAX).collect();
            Ok(format!(
                "{}\n\n…[truncated — commit is {} chars; showing first {}]",
                truncated,
                out.len(),
                MAX
            ))
        } else {
            Ok(out)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Restore the working tree to the state at the given commit, then
/// commit the diff. Preserves history (no reset), so this revert is
/// itself undoable. Refuses if the commit is already HEAD.
#[tauri::command]
async fn git_restore_to_commit(vault: String, hash: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_repo_lock(&vault, || {
        abort_stuck_merge_or_rebase(&vault);
        let (head_hash, _, _) = run_git(&vault, &["rev-parse", "HEAD"])?;
        let (target_full, _, _) = run_git(&vault, &["rev-parse", &hash])?;
        if head_hash.trim() == target_full.trim() {
            return Err("already at this commit".to_string());
        }

        // Safety rail: refuse to restore above the vault-chat-start
        // anchor. Those commits are the user's own pre-vault-chat
        // history — this app doesn't own them. If the user really wants
        // to rewind that far, they can use the git CLI directly.
        let (tag_hash, _, tag_code) =
            run_git(&vault, &["rev-parse", "--verify", "vault-chat-start"])?;
        if tag_code == 0 {
            let tag_hash = tag_hash.trim();
            if tag_hash != target_full.trim() {
                let (_, _, is_before) = run_git(
                    &vault,
                    &["merge-base", "--is-ancestor", &target_full.trim(), tag_hash],
                )?;
                if is_before == 0 {
                    return Err(
                        "refusing to restore above the vault-chat-start anchor — that's your pre-vault-chat history. Use the git CLI if you really mean to rewind further."
                            .to_string(),
                    );
                }
            }
        }

        // Grab the target's subject so the restore commit has a
        // meaningful name ("Restore: fix typo in hw2" instead of
        // "restore to a1b2c3d4").
        let (subject, _, _) = run_git(
            &vault,
            &["log", "-1", "--pretty=format:%s", &hash],
        )?;
        let subject = subject.trim();

        // read-tree --reset -u atomically replaces the index + working
        // tree with the target commit's state, keeping HEAD where it
        // is. Handles additions, deletions, and modifications in one
        // shot — much cleaner than a `checkout <hash> -- .` followed
        // by a manual diff-filter removal pass.
        let (_, stderr, code) =
            run_git_mut(&vault, &["read-tree", "--reset", "-u", &hash])?;
        if code != 0 {
            return Err(format!("read-tree failed: {}", stderr.trim()));
        }

        let short = hash.chars().take(8).collect::<String>();
        let msg = if subject.is_empty() {
            format!("Restore to {}", short)
        } else {
            format!("Restore: {} ({})", subject, short)
        };
        let (hn, he) = human_identity(&vault);
        let (_, stderr2, code2) =
            run_git_as(&vault, &hn, &he, &["commit", "--allow-empty", "-q", "-m", &msg])?;
        if code2 != 0 {
            return Err(format!("commit failed: {}", stderr2.trim()));
        }
        let (new_hash, _, _) = run_git(&vault, &["rev-parse", "--short", "HEAD"])?;
        Ok(new_hash.trim().to_string())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// One file affected by a single commit. Drives the per-commit
/// summary list — status (A/M/D) plus line-count delta. No raw patch
/// text; the per-file diff lives in `git_diff_vs_current` once the
/// user picks a file to inspect.
#[derive(serde::Serialize)]
struct CommitFile {
    path: String,
    status: String,
    additions: u32,
    deletions: u32,
}

#[tauri::command]
async fn git_commit_files(vault: String, hash: String) -> Result<Vec<CommitFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Root commits have no parent — diff-tree against the empty
        // tree so initial-commit users still see their files.
        let (_, _, parent_code) =
            run_git(&vault, &["rev-parse", "--verify", &format!("{}^", hash)])?;
        let has_parent = parent_code == 0;
        let stat_args: Vec<String> = if has_parent {
            vec![
                "diff-tree".into(),
                "-r".into(),
                "--no-renames".into(),
                "--numstat".into(),
                hash.clone(),
            ]
        } else {
            vec![
                "diff-tree".into(),
                "-r".into(),
                "--no-renames".into(),
                "--numstat".into(),
                "--root".into(),
                hash.clone(),
            ]
        };
        let stat_args_ref: Vec<&str> = stat_args.iter().map(|s| s.as_str()).collect();
        let (numstat_out, _, _) = run_git(&vault, &stat_args_ref)?;

        let status_args: Vec<String> = if has_parent {
            vec![
                "diff-tree".into(),
                "-r".into(),
                "--no-renames".into(),
                "--name-status".into(),
                hash.clone(),
            ]
        } else {
            vec![
                "diff-tree".into(),
                "-r".into(),
                "--no-renames".into(),
                "--name-status".into(),
                "--root".into(),
                hash.clone(),
            ]
        };
        let status_args_ref: Vec<&str> = status_args.iter().map(|s| s.as_str()).collect();
        let (status_out, _, _) = run_git(&vault, &status_args_ref)?;

        let mut status_by_path: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        for line in status_out.lines() {
            let mut parts = line.splitn(2, '\t');
            let s = parts.next().unwrap_or("").trim();
            let p = parts.next().unwrap_or("").trim();
            if !p.is_empty() {
                status_by_path.insert(p.to_string(), s.chars().next().unwrap_or('M').to_string());
            }
        }

        let mut out = Vec::new();
        for line in numstat_out.lines() {
            // numstat: <adds>\t<dels>\t<path>. Binary files emit "-\t-".
            let mut parts = line.splitn(3, '\t');
            let adds_raw = parts.next().unwrap_or("");
            let dels_raw = parts.next().unwrap_or("");
            let path = parts.next().unwrap_or("").trim().to_string();
            if path.is_empty() {
                continue;
            }
            let additions: u32 = adds_raw.parse().unwrap_or(0);
            let deletions: u32 = dels_raw.parse().unwrap_or(0);
            let status = status_by_path
                .get(&path)
                .cloned()
                .unwrap_or_else(|| "M".to_string());
            out.push(CommitFile {
                path,
                status,
                additions,
                deletions,
            });
        }
        // Stable order: status (A, M, D) then path.
        let order = |s: &str| match s {
            "A" => 0,
            "M" => 1,
            "D" => 2,
            _ => 3,
        };
        out.sort_by(|a, b| {
            order(&a.status)
                .cmp(&order(&b.status))
                .then_with(|| a.path.cmp(&b.path))
        });
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Row in the per-vault "touched files" index. One per unique path
/// that has ever been added / modified / deleted in the vault's git
/// history (within the configured range — see `include_before_start`).
#[derive(serde::Serialize)]
struct TouchedFile {
    path: String,
    last_hash: String,
    last_short_hash: String,
    last_subject: String,
    last_date: String,
    edits: u32,
    /// "exists" if currently tracked in HEAD, "deleted" otherwise.
    status: String,
}

/// Every path that has been added/edited/deleted in the visible
/// history. Sorted by most-recent activity. Renames are recorded as
/// add+delete so both names appear (avoids the user losing track of a
/// renamed file). Deleted files keep their entry with status="deleted".
#[tauri::command]
async fn git_all_touched_files(
    vault: String,
    include_before_start: Option<bool>,
) -> Result<Vec<TouchedFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let include_all = include_before_start.unwrap_or(false);
        let (tag_hash, _, tag_code) =
            run_git(&vault, &["rev-parse", "--verify", "vault-chat-start"])?;
        let tag_hash = if tag_code == 0 {
            Some(tag_hash.trim().to_string())
        } else {
            None
        };
        let range = match (&tag_hash, include_all) {
            (Some(t), false) => format!("{}..HEAD", t),
            _ => "HEAD".to_string(),
        };
        let (out, _, _) = run_git(
            &vault,
            &[
                "log",
                &range,
                "--name-status",
                "--no-renames",
                "--pretty=format:COMMIT\x1f%H\x1f%h\x1f%s\x1f%ad",
                "--date=format:%Y-%m-%d %H:%M",
            ],
        )?;

        let mut by_path: std::collections::HashMap<String, TouchedFile> =
            std::collections::HashMap::new();
        let (mut cur_hash, mut cur_short, mut cur_subject, mut cur_date) =
            (String::new(), String::new(), String::new(), String::new());
        for line in out.lines() {
            if let Some(rest) = line.strip_prefix("COMMIT\x1f") {
                let parts: Vec<&str> = rest.splitn(4, '\x1f').collect();
                if parts.len() == 4 {
                    cur_hash = parts[0].to_string();
                    cur_short = parts[1].to_string();
                    cur_subject = parts[2].to_string();
                    cur_date = parts[3].to_string();
                }
                continue;
            }
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            // Format: <status>\t<path>. Skip anything we don't understand.
            let mut parts = line.splitn(2, '\t');
            let _status = parts.next().unwrap_or("");
            let path = parts.next().unwrap_or("").trim().to_string();
            if path.is_empty() {
                continue;
            }
            let entry = by_path
                .entry(path.clone())
                .or_insert_with(|| TouchedFile {
                    path: path.clone(),
                    last_hash: cur_hash.clone(),
                    last_short_hash: cur_short.clone(),
                    last_subject: cur_subject.clone(),
                    last_date: cur_date.clone(),
                    edits: 0,
                    status: "exists".to_string(),
                });
            entry.edits += 1;
        }

        // status: in HEAD? exists. otherwise: deleted.
        let (ls_out, _, _) = run_git(&vault, &["ls-files"])?;
        let existing: std::collections::HashSet<String> =
            ls_out.lines().map(|l| l.trim().to_string()).collect();
        for tf in by_path.values_mut() {
            if !existing.contains(&tf.path) {
                tf.status = "deleted".to_string();
            }
        }

        let mut result: Vec<TouchedFile> = by_path.into_values().collect();
        result.sort_by(|a, b| b.last_date.cmp(&a.last_date));
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Commits that touched a single path (relative to vault root). Same
/// shape as git_recent_commits so the UI can reuse the same row
/// component. `--follow` so file renames don't truncate history.
#[tauri::command]
async fn git_file_history(
    vault: String,
    relative_path: String,
    n: Option<usize>,
    include_before_start: Option<bool>,
) -> Result<Vec<GitCommit>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let n = n.unwrap_or(50).min(500);
        let include_all = include_before_start.unwrap_or(false);
        let fmt = "%H%x1f%h%x1f%s%x1f%an%x1f%ad%x1f%b%x1e";

        let (tag_hash, _, tag_code) =
            run_git(&vault, &["rev-parse", "--verify", "vault-chat-start"])?;
        let tag_hash = if tag_code == 0 {
            Some(tag_hash.trim().to_string())
        } else {
            None
        };

        let (out, _, _) = run_git(
            &vault,
            &[
                "log",
                &format!("-{}", n),
                "--follow",
                &format!("--pretty=format:{}", fmt),
                "--date=format:%Y-%m-%d %H:%M",
                "--",
                &relative_path,
            ],
        )?;

        let mut commits = Vec::new();
        for record in out.split('\x1e') {
            let r = record.trim();
            if r.is_empty() {
                continue;
            }
            let parts: Vec<&str> = r.splitn(6, '\x1f').collect();
            if parts.len() < 5 {
                continue;
            }
            let hash = parts[0].to_string();
            let is_anchor = tag_hash.as_deref() == Some(hash.as_str());
            commits.push(GitCommit {
                hash,
                short_hash: parts[1].to_string(),
                subject: parts[2].to_string(),
                author: parts[3].to_string(),
                date: parts[4].to_string(),
                body: parts.get(5).map(|s| s.trim().to_string()).unwrap_or_default(),
                is_anchor,
            });
            if is_anchor && !include_all {
                break;
            }
        }
        Ok(commits)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Read a path's contents at a given commit. Empty string if the path
/// didn't exist there. Caller decides how to render (markdown / code /
/// image / etc.) based on the path extension.
#[tauri::command]
async fn git_file_at(
    vault: String,
    hash: String,
    relative_path: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let spec = format!("{}:{}", hash, relative_path);
        let (out, _stderr, code) = run_git(&vault, &["show", &spec])?;
        if code != 0 {
            // Path didn't exist in this commit. Surface as empty rather
            // than an error so the UI can show "(file did not exist
            // here)" without a try/catch.
            return Ok(String::new());
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Diff for a single path framed as "what would change if I rolled
/// back?". Green = lines that come back, red = lines that disappear.
/// Implemented as `git diff HEAD..hash -- path` so the *target* version
/// is the "+" side. Empty string if no difference.
#[tauri::command]
async fn git_diff_vs_current(
    vault: String,
    hash: String,
    relative_path: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let range = format!("HEAD..{}", hash);
        let (out, stderr, code) = run_git(
            &vault,
            &["diff", &range, "--", &relative_path],
        )?;
        if code != 0 {
            return Err(stderr.trim().to_string());
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ----- vault auto-sync helpers -----
//
// Generic helpers used by the SettingsPane vault-sync section. Returns
// structured results so the front-end can show "synced 18s ago" / error
// strings without re-shelling git.

#[derive(Serialize)]
struct SyncStatus {
    has_repo: bool,
    remote: Option<String>,
    has_changes: bool,
    /// Local commits not yet on the upstream. Non-zero means there's
    /// work committed but unpushed — the status must not read "synced".
    ahead: u32,
    /// Newline-separated list of nested repos inside the vault root
    /// (excluding the vault's own .git). One entry per nested .git
    /// — the sync loop skips these.
    nested_repos: Vec<String>,
}

#[tauri::command]
async fn vault_sync_status(vault: String) -> Result<SyncStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(&vault);
        let has_repo = root.join(".git").is_dir();
        if !has_repo {
            return Ok(SyncStatus {
                has_repo: false,
                remote: None,
                has_changes: false,
                ahead: 0,
                nested_repos: Vec::new(),
            });
        }
        let (remote_out, _, remote_code) =
            run_git(&vault, &["remote", "get-url", "origin"])?;
        let remote = if remote_code == 0 {
            let s = remote_out.trim();
            if s.is_empty() { None } else { Some(s.to_string()) }
        } else {
            None
        };
        let (status_out, _, _) = run_git(&vault, &["status", "--porcelain"])?;
        let has_changes = !status_out.trim().is_empty();
        // Count local commits not yet on the upstream. Errors (no upstream,
        // detached HEAD) are treated as "nothing ahead".
        let ahead = {
            let (out, _, code) =
                run_git(&vault, &["rev-list", "--count", "@{upstream}..HEAD"])?;
            if code == 0 {
                out.trim().parse::<u32>().unwrap_or(0)
            } else {
                0
            }
        };
        let nested_repos = find_nested_repos(&root);
        Ok(SyncStatus {
            has_repo,
            remote,
            has_changes,
            ahead,
            nested_repos,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// Walk one level deep and identify directories that have their own
// .git subdir. Used by the auto-sync loop to skip nested repos so they
// don't get accidentally committed into the outer vault.
fn find_nested_repos(root: &std::path::Path) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    let Ok(entries) = std::fs::read_dir(root) else {
        return found;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_dir() {
            continue;
        }
        let name = match p.file_name().and_then(|n| n.to_str()) {
            Some(n) => n,
            None => continue,
        };
        if name.starts_with('.') {
            continue;
        }
        if p.join(".git").is_dir() {
            found.push(name.to_string());
        }
    }
    found.sort();
    found
}

#[tauri::command]
async fn vault_sync_set_remote(vault: String, url: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let url_t = url.trim();
        if url_t.is_empty() {
            // Clearing the remote — `remote remove origin` errors if
            // origin doesn't exist, which is fine.
            let _ = run_git(&vault, &["remote", "remove", "origin"]);
            return Ok(());
        }
        let (_, _, code) = run_git(&vault, &["remote", "get-url", "origin"])?;
        if code == 0 {
            let (_, stderr, c) = run_git(&vault, &["remote", "set-url", "origin", url_t])?;
            if c != 0 {
                return Err(format!("set-url failed: {}", stderr.trim()));
            }
        } else {
            let (_, stderr, c) = run_git(&vault, &["remote", "add", "origin", url_t])?;
            if c != 0 {
                return Err(format!("add origin failed: {}", stderr.trim()));
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
struct SyncOpResult {
    ok: bool,
    /// Short summary suitable for the status row. e.g.
    /// "pulled 3 commits", "nothing to push", "merge conflict in foo.md".
    message: String,
    /// True when there's a non-blocking error that should be surfaced
    /// to the user (e.g. authentication, conflict). The sync loop keeps
    /// running and retries on the next tick.
    error: bool,
}

/// Commit every nested repo's dirty working tree LOCALLY — no push, no fork, no
/// classification, no network. This is the "version history for the internal
/// vault" path: it runs for any open vault (even one with no remote / sync
/// turned off), so nested-repo work is captured in local history and the file-
/// tree dirty dots clear. The outward behavior (push / vault-chat branch / fork
/// by class) is the separate `sync_nested_repos`, gated on opt-in remote sync.
/// Returns how many nested repos it committed. Best-effort throughout.
fn commit_nested_repos_local(vault: &str, agent: bool) -> u32 {
    let mut repos: std::collections::HashSet<String> = std::collections::HashSet::new();
    if PathBuf::from(vault).join(".gitmodules").is_file() {
        if let Ok((out, _, 0)) =
            run_git(vault, &["config", "-f", ".gitmodules", "--get-regexp", "\\.path$"])
        {
            for line in out.lines() {
                if let Some((_, rel)) = line.split_once(char::is_whitespace) {
                    let rel = rel.trim();
                    if !rel.is_empty() {
                        repos.insert(rel.to_string());
                    }
                }
            }
        }
    }
    for rel in find_all_nested_repos(std::path::Path::new(vault)) {
        repos.insert(rel);
    }

    let mut committed = 0u32;
    for rel in repos {
        let sub = format!("{}/{}", vault, rel);
        if !PathBuf::from(&sub).join(".git").exists() {
            continue;
        }
        // Only commit when on a branch — never create a dangling commit on a
        // detached HEAD (re-attaching a detached submodule is the sync path's
        // job, and needs a remote it doesn't have here).
        let on_branch = matches!(
            run_git(&sub, &["symbolic-ref", "--quiet", "--short", "HEAD"]),
            Ok((ref b, _, 0)) if !b.trim().is_empty()
        );
        if !on_branch {
            continue;
        }
        let dirty = run_git(&sub, &["status", "--porcelain"])
            .map(|(s, _, _)| !s.trim().is_empty())
            .unwrap_or(false);
        if !dirty {
            continue;
        }
        let (cn, ce) = commit_identity(&sub, agent);
        let _ = run_git_as(&sub, &cn, &ce, &["add", "-A"]);
        let mut msg = String::new();
        if agent {
            msg.push_str("[agent] ");
        }
        msg.push_str("vault-chat: local autosave (sub-repo)");
        if let Ok((_, _, 0)) = run_git_as(&sub, &cn, &ce, &["commit", "-q", "-m", &msg]) {
            committed += 1;
            maybe_compact_git(&sub);
        }
    }
    committed
}

/// Commit the vault locally — root + every nested repo — WITHOUT any remote
/// operation. The always-on counterpart to `vault_sync_commit_local`: it runs
/// for vaults with sync turned off so they still accrue version history and
/// their nested-repo dots clear. No pull, push, fork, or branch.
#[tauri::command]
async fn vault_commit_local(vault: String) -> Result<SyncOpResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_repo_lock(&vault, || {
            abort_stuck_merge_or_rebase(&vault);
            let nested = commit_nested_repos_local(&vault, false);
            let (status_out, _, _) = run_git(&vault, &["status", "--porcelain"])?;
            let mut root_committed = false;
            if !status_out.trim().is_empty() {
                let (hn, he) = human_identity(&vault);
                let (_, stderr, code) = run_git_as(&vault, &hn, &he, &["add", "-A"])?;
                if code != 0 {
                    return Ok(SyncOpResult {
                        ok: false,
                        message: format!("add failed: {}", stderr.trim()),
                        error: true,
                    });
                }
                let (_, stderr, code) =
                    run_git_as(&vault, &hn, &he, &["commit", "-q", "-m", "vault-chat: local autosave"])?;
                if code != 0 {
                    return Ok(SyncOpResult {
                        ok: false,
                        message: format!("commit failed: {}", stderr.trim()),
                        error: true,
                    });
                }
                maybe_compact_git(&vault);
                root_committed = true;
            }
            let message = if nested > 0 || root_committed {
                format!(
                    "committed locally ({} sub-repo{})",
                    nested,
                    if nested == 1 { "" } else { "s" }
                )
            } else {
                "no local changes".into()
            };
            Ok(SyncOpResult { ok: true, message, error: false })
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn vault_sync_commit_local(vault: String) -> Result<SyncOpResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_repo_lock(&vault, || {
        // Self-heal a wedged repo: a crashed prior pull can leave an
        // in-progress rebase under which every commit silently no-ops.
        abort_stuck_merge_or_rebase(&vault);
        // Sync every nested repo first — each by its own remote and the user's
        // relationship to it (own / shared / foreign / internal). This commits
        // their working trees (clearing the per-repo dots) and advances owned
        // HEADs so the parent's gitlink bumps get staged and committed below.
        sync_nested_repos(&vault, false);
        let (status_out, _, _) = run_git(&vault, &["status", "--porcelain"])?;
        if status_out.trim().is_empty() {
            return Ok(SyncOpResult {
                ok: true,
                message: "no local changes".into(),
                error: false,
            });
        }
        // Stage everything outside nested repos. Git already refuses to
        // recurse into nested .git directories on `add -A` (a nested
        // repo is treated as a submodule pointer), so this is a no-op
        // for those — but we add the explicit nested_repos check below
        // when summarising the commit body. Authored as the user: the root
        // autosave bundles the user's own accumulated edits, so it carries
        // their identity, not a bot's.
        let (hn, he) = human_identity(&vault);
        let (_, stderr, code) = run_git_as(&vault, &hn, &he, &["add", "-A"])?;
        if code != 0 {
            return Ok(SyncOpResult {
                ok: false,
                message: format!("add failed: {}", stderr.trim()),
                error: true,
            });
        }
        let (_, stderr, code) =
            run_git_as(&vault, &hn, &he, &["commit", "-q", "-m", "vault-chat: auto-sync"])?;
        if code != 0 {
            return Ok(SyncOpResult {
                ok: false,
                message: format!("commit failed: {}", stderr.trim()),
                error: true,
            });
        }
        // Repack if the append-only-log churn has piled up loose objects, so the
        // vault's .git doesn't balloon (362 MiB loose → ~tens packed observed).
        maybe_compact_git(&vault);
        Ok(SyncOpResult {
            ok: true,
            message: "committed local changes".into(),
            error: false,
        })
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn vault_sync_pull(vault: String) -> Result<SyncOpResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_repo_lock(&vault, || {
        // Clear any leftover rebase/merge from a crashed prior pull before we
        // start a new one — otherwise `rebase` errors with "rebase in
        // progress" and the vault stays wedged.
        abort_stuck_merge_or_rebase(&vault);
        // Detect the local branch — most repos default to main, but a
        // pre-existing vault may be on master or something else.
        let (branch_out, _, branch_code) =
            run_git(&vault, &["rev-parse", "--abbrev-ref", "HEAD"])?;
        if branch_code != 0 {
            return Ok(SyncOpResult {
                ok: false,
                message: "no current branch".into(),
                error: true,
            });
        }
        let branch = branch_out.trim();
        if branch.is_empty() || branch == "HEAD" {
            return Ok(SyncOpResult {
                ok: false,
                message: "detached HEAD".into(),
                error: true,
            });
        }
        let (_, _, code) = run_git(&vault, &["remote", "get-url", "origin"])?;
        if code != 0 {
            return Ok(SyncOpResult {
                ok: false,
                message: "no remote configured".into(),
                error: false,
            });
        }
        let (_, stderr, fetch_code) = run_git(&vault, &["fetch", "origin", branch])?;
        if fetch_code != 0 {
            return Ok(SyncOpResult {
                ok: false,
                message: format!("fetch failed: {}", stderr.trim()),
                error: true,
            });
        }
        // Try a fast-forward first — clean and never creates a merge
        // commit. If FF isn't possible, fall back to a rebase. If that
        // fails, abort cleanly and surface a non-blocking error.
        let upstream = format!("origin/{}", branch);
        let (_, _, ff_code) =
            run_git_mut(&vault, &["merge", "--ff-only", &upstream])?;
        let pulled_msg = if ff_code == 0 {
            "pulled"
        } else {
            // Rebase replays the user's local commits onto the remote tip; the
            // committer for any new commit is the user's real identity, never a
            // bot. (Original authors on replayed commits are preserved by git.)
            let (rn, re) = human_identity(&vault);
            let (_, stderr, rebase_code) =
                run_git_as(&vault, &rn, &re, &["rebase", &upstream])?;
            if rebase_code != 0 {
                // Leave the working tree untouched — abort the half-applied
                // rebase so the next attempt can start clean.
                let _ = run_git_mut(&vault, &["rebase", "--abort"]);
                return Ok(SyncOpResult {
                    ok: false,
                    message: format!("merge conflict: {}", first_line(&stderr).trim()),
                    error: true,
                });
            }
            "rebased onto origin"
        };
        // Pull succeeded — bring any registered submodules to the commits the
        // vault now points at (clones them on a fresh machine). Best-effort.
        maybe_update_submodules(&vault);
        Ok(SyncOpResult {
            ok: true,
            message: pulled_msg.into(),
            error: false,
        })
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn vault_sync_push(vault: String) -> Result<SyncOpResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_repo_lock(&vault, || {
        let (branch_out, _, branch_code) =
            run_git(&vault, &["rev-parse", "--abbrev-ref", "HEAD"])?;
        if branch_code != 0 || branch_out.trim() == "HEAD" {
            return Ok(SyncOpResult {
                ok: false,
                message: "no current branch".into(),
                error: true,
            });
        }
        let branch = branch_out.trim().to_string();
        let (_, _, code) = run_git(&vault, &["remote", "get-url", "origin"])?;
        if code != 0 {
            return Ok(SyncOpResult {
                ok: false,
                message: "no remote configured".into(),
                error: false,
            });
        }
        let (_, stderr, push_code) =
            run_git(&vault, &["push", "-u", "origin", &branch])?;
        if push_code != 0 {
            return Ok(SyncOpResult {
                ok: false,
                message: format!("push failed: {}", first_line(&stderr).trim()),
                error: true,
            });
        }
        Ok(SyncOpResult {
            ok: true,
            message: "pushed".into(),
            error: false,
        })
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn vault_sync_gh_create_repo(
    vault: String,
    name: String,
    private_repo: bool,
) -> Result<SyncOpResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let n = name.trim();
        if n.is_empty() {
            return Ok(SyncOpResult {
                ok: false,
                message: "repo name required".into(),
                error: true,
            });
        }
        let visibility = if private_repo { "--private" } else { "--public" };
        // `gh repo create <name> --source . --remote origin --push --private`
        // creates the repo on GitHub, points origin at it, and pushes
        // the current branch in one shot. Fails (non-fatally) if `gh`
        // isn't installed or the user isn't logged in.
        #[cfg(windows)]
        let mut cmd = {
            use std::os::windows::process::CommandExt;
            let mut c = Command::new("gh");
            c.creation_flags(0x08000000);
            c
        };
        #[cfg(not(windows))]
        let mut cmd = Command::new("gh");
        cmd.current_dir(&vault);
        cmd.args(["repo", "create", n, visibility, "--source", ".", "--remote", "origin", "--push"]);
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        let out = match cmd.output() {
            Ok(o) => o,
            Err(e) => {
                return Ok(SyncOpResult {
                    ok: false,
                    message: format!("gh CLI not available: {}", e),
                    error: true,
                });
            }
        };
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            return Ok(SyncOpResult {
                ok: false,
                message: format!("gh create failed: {}", first_line(&stderr).trim()),
                error: true,
            });
        }
        Ok(SyncOpResult {
            ok: true,
            message: "repo created".into(),
            error: false,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn first_line(s: &str) -> &str {
    s.lines().next().unwrap_or("")
}

/// Restore a single path to its content at `hash`, then commit so the
/// rollback is itself an undoable step. Adds creates, applies edits,
/// and removes paths that didn't exist at `hash`.
#[tauri::command]
async fn git_restore_file_to(
    vault: String,
    hash: String,
    relative_path: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_repo_lock(&vault, || {
        abort_stuck_merge_or_rebase(&vault);
        // Did this path exist in the target commit?
        let spec = format!("{}:{}", hash, relative_path);
        let (_, _, ls_code) = run_git(&vault, &["cat-file", "-e", &spec])?;
        if ls_code == 0 {
            // Yes — checkout that version into both index and worktree.
            let (_, stderr, code) = run_git_mut(
                &vault,
                &["checkout", &hash, "--", &relative_path],
            )?;
            if code != 0 {
                return Err(format!("checkout failed: {}", stderr.trim()));
            }
        } else {
            // No — the path didn't exist there, so restoring means
            // removing the current file. `git rm` will fail loudly if
            // the path is also untracked; ignore that case.
            let (_, _, _) = run_git_mut(&vault, &["rm", "-f", "--", &relative_path])?;
        }
        let short = hash.chars().take(8).collect::<String>();
        let leaf = relative_path
            .rsplit('/')
            .next()
            .unwrap_or(&relative_path);
        let msg = format!("Restore {} to {}", leaf, short);
        let (hn, he) = human_identity(&vault);
        let (_, stderr, code) =
            run_git_as(&vault, &hn, &he, &["commit", "--allow-empty", "-q", "-m", &msg])?;
        if code != 0 {
            return Err(format!("commit failed: {}", stderr.trim()));
        }
        let (new_hash, _, _) = run_git(&vault, &["rev-parse", "--short", "HEAD"])?;
        Ok(new_hash.trim().to_string())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ----- keychain (API key secure storage) -----
//
// API keys and service credentials live in the OS keychain instead of
// localStorage. On Windows this hits Credential Manager, on Mac the
// Keychain, on Linux libsecret (via dbus). The agent's file-op tools
// can't reach these — they live outside any vault.

const KEYCHAIN_SERVICE: &str = "com.vault-chat.app";

#[tauri::command]
async fn keychain_get(key: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &key)
            .map_err(|e| e.to_string())?;
        match entry.get_password() {
            Ok(p) => Ok(Some(p)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn keychain_set(key: String, value: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &key)
            .map_err(|e| e.to_string())?;
        entry.set_password(&value).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn keychain_delete(key: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &key)
            .map_err(|e| e.to_string())?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()), // idempotent
            Err(e) => Err(e.to_string()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

// ----- cross-machine key sync (encrypted keystore) -----
//
// The OS keychain stays the runtime source of truth for every key. This
// layer only moves keys *between machines*: the JS side serialises the
// keychain to JSON, encrypts it here with the user's passphrase, and
// writes the blob to `<vault>/.vault-chat/keys.enc` (synced by git). On
// another machine it decrypts the blob and writes the keys back into the
// local keychain. The passphrase lives only in each machine's own
// keychain and never touches git, so the committed blob is useless
// without it. Rust does only the crypto primitive; key enumeration and
// keychain I/O stay in the JS layer.

fn keystore_encrypt_bytes(passphrase: &str, plaintext: &[u8]) -> Result<String, String> {
    use std::io::Write;
    let encryptor =
        age::Encryptor::with_user_passphrase(age::secrecy::Secret::new(passphrase.to_owned()));
    let mut encrypted = Vec::new();
    let mut writer = encryptor
        .wrap_output(&mut encrypted)
        .map_err(|e| format!("encrypt init: {}", e))?;
    writer
        .write_all(plaintext)
        .map_err(|e| format!("encrypt write: {}", e))?;
    writer
        .finish()
        .map_err(|e| format!("encrypt finish: {}", e))?;
    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.encode(encrypted))
}

fn keystore_decrypt_bytes(passphrase: &str, blob: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    use std::io::Read;
    let encrypted = base64::engine::general_purpose::STANDARD
        .decode(blob.trim())
        .map_err(|e| format!("base64 decode: {}", e))?;
    let decryptor = match age::Decryptor::new(&encrypted[..])
        .map_err(|e| format!("decrypt init: {}", e))?
    {
        age::Decryptor::Passphrase(d) => d,
        _ => return Err("keys.enc is not passphrase-encrypted".into()),
    };
    let mut decrypted = Vec::new();
    let mut reader = decryptor
        .decrypt(&age::secrecy::Secret::new(passphrase.to_owned()), None)
        .map_err(|_| "decrypt failed (wrong passphrase?)".to_string())?;
    reader
        .read_to_end(&mut decrypted)
        .map_err(|e| format!("decrypt read: {}", e))?;
    Ok(decrypted)
}

#[tauri::command]
async fn keystore_encrypt(passphrase: String, plaintext: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        keystore_encrypt_bytes(&passphrase, plaintext.as_bytes())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn keystore_decrypt(passphrase: String, blob: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = keystore_decrypt_bytes(&passphrase, &blob)?;
        String::from_utf8(bytes).map_err(|e| format!("utf8: {}", e))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod keystore_tests {
    use super::{keystore_decrypt_bytes, keystore_encrypt_bytes};

    #[test]
    fn roundtrip_preserves_payload() {
        let pass = "correct horse battery staple";
        let secret = r#"{"api.openrouter":"sk-abc123","user.lambda_api_key":"lam-xyz"}"#;
        let blob = keystore_encrypt_bytes(pass, secret.as_bytes()).expect("encrypt");
        let out = keystore_decrypt_bytes(pass, &blob).expect("decrypt");
        assert_eq!(out, secret.as_bytes());
    }

    #[test]
    fn wrong_passphrase_is_rejected() {
        let blob = keystore_encrypt_bytes("right-pass", b"secret").expect("encrypt");
        assert!(keystore_decrypt_bytes("wrong-pass", &blob).is_err());
    }
}

#[cfg(test)]
mod repo_class_tests {
    use super::{repo_name, repo_owner};

    // Owner + repo parsing underpins the whole mine/shared/foreign decision —
    // a misparse would misclassify someone else's repo as the user's. Cover
    // the real URL shapes the user's vaults actually carry (https + .git, ssh,
    // trailing slash, no .git).
    #[test]
    fn owner_parsing_covers_real_remote_shapes() {
        assert_eq!(
            repo_owner("https://github.com/Buckarney/IEMS-305-Soccer-Forecasting.git").as_deref(),
            Some("buckarney") // lowercased for case-insensitive comparison to gh login
        );
        assert_eq!(
            repo_owner("https://github.com/karpathy/nanochat.git").as_deref(),
            Some("karpathy")
        );
        assert_eq!(
            repo_owner("git@github.com:carlwilsn/torchtitan.git").as_deref(),
            Some("carlwilsn")
        );
        assert_eq!(
            repo_owner("https://github.com/carlwilsn/summer").as_deref(),
            Some("carlwilsn")
        );
        assert_eq!(repo_owner("not-a-url").as_deref(), None);
    }

    #[test]
    fn repo_name_preserves_case_and_strips_suffix() {
        assert_eq!(
            repo_name("https://github.com/carlwilsn/BitNet.git").as_deref(),
            Some("BitNet")
        );
        assert_eq!(
            repo_name("git@github.com:karpathy/nanochat.git").as_deref(),
            Some("nanochat")
        );
        assert_eq!(
            repo_name("https://github.com/Buckarney/IEMS-305-Soccer-Forecasting").as_deref(),
            Some("IEMS-305-Soccer-Forecasting")
        );
    }
}

#[cfg(test)]
mod conversation_storage_tests {
    use super::conversation_file_stem;

    #[test]
    fn real_ids_map_to_themselves() {
        // Conversation ids are hex-with-dashes — already safe, must pass through.
        assert_eq!(conversation_file_stem("8e9f6621-1e4"), "8e9f6621-1e4");
        assert_eq!(conversation_file_stem("fb9398cb"), "fb9398cb");
        assert_eq!(conversation_file_stem("049dcbff-c83"), "049dcbff-c83");
    }

    #[test]
    fn hostile_ids_cannot_escape_the_folder() {
        // A malformed id must never produce a path separator, traversal, or
        // empty stem that could write outside the conversations folder.
        assert!(!conversation_file_stem("../../etc/passwd").contains('/'));
        assert!(!conversation_file_stem("../../etc/passwd").contains("..") );
        assert!(!conversation_file_stem("a/b\\c").contains('/'));
        assert!(!conversation_file_stem("a/b\\c").contains('\\'));
        assert_eq!(conversation_file_stem(""), "conversation");
        assert_eq!(conversation_file_stem("///"), "conversation");
    }
}

// ----- .git/ guard -----
//
// The git auto-commit / history / restore system is our only undo
// mechanism. If the agent deletes a repo's .git folder we're cooked.
// Guard the file-op tools to refuse any path touching .git/.
// Not guarding Bash — too fragile to regex, and Bash legitimately
// runs `git` commands that poke at .git/ internally.

fn path_touches_dot_git(path: &str) -> bool {
    let p = path.replace('\\', "/");
    p.contains("/.git/") || p.ends_with("/.git") || p == ".git"
}

fn git_guard(path: &str) -> Result<(), String> {
    if path_touches_dot_git(path) {
        Err(format!(
            "refusing to touch {} — the .git folder is the undo system and must not be modified directly",
            path
        ))
    } else {
        Ok(())
    }
}

// ----- meta vault -----
//
// The meta vault is an app-level folder (OS app-data) that holds the
// agent's own config as files: system prompt, skills, tools. The user
// can open it as a regular vault and edit anything. Agent can too.
// On first launch we seed it with sensible defaults.

const DEFAULT_SYSTEM_MD: &str = include_str!("../defaults/system.md");
const DEFAULT_VOICE_MD: &str = include_str!("../defaults/voice.md");
const DEFAULT_TELEGRAM_MD: &str = include_str!("../defaults/telegram.md");
const DEFAULT_SUPERVISOR_MD: &str = include_str!("../defaults/supervisor.md");

/// The bundled default agent system prompt. New vaults seed
/// `<vault>/.vault-chat/agent/system.md` from this; it can then be
/// customized per-vault and syncs across machines via the vault's git.
#[tauri::command]
fn default_system_prompt() -> String {
    DEFAULT_SYSTEM_MD.to_string()
}

/// The bundled default voice-mode prompt. New vaults seed
/// `<vault>/.vault-chat/agent/voice.md` from this.
#[tauri::command]
fn default_voice_prompt() -> String {
    DEFAULT_VOICE_MD.to_string()
}

/// The bundled default Telegram-mode prompt. New vaults seed
/// `<vault>/.vault-chat/agent/telegram.md` from this. It steers how the
/// agent replies to messages that arrive via the vault's Telegram bot
/// (short, plain-text, phone-friendly), and is editable per vault.
#[tauri::command]
fn default_telegram_prompt() -> String {
    DEFAULT_TELEGRAM_MD.to_string()
}

/// The bundled default supervisor role prompt. New vaults seed
/// `<vault>/.vault-chat/agent/supervisor.md` from this. It layers an always-on
/// orchestrator role (persistent mind, goal loop, worker steering) onto the
/// Telegram agent, and is editable per vault.
#[tauri::command]
fn default_supervisor_prompt() -> String {
    DEFAULT_SUPERVISOR_MD.to_string()
}

// ----- run_script -----
//
// Executes a vault-tool script (Python / Node / bash / etc.). The
// script receives its input on stdin as JSON and is expected to write
// its output to stdout (JSON or plain text — caller decides).

#[derive(Serialize)]
struct ScriptResult {
    stdout: String,
    stderr: String,
    code: i32,
    timed_out: bool,
}

fn interpreter_for(path: &str) -> Option<(&'static str, Vec<String>)> {
    let lower = path.to_lowercase();
    if lower.ends_with(".py") {
        // Windows' Python installer provides `python`; Linux/macOS ship
        // `python3` with no bare `python` by default — so pick per-platform,
        // or every .py tool/script dies with "python: command not found".
        #[cfg(windows)]
        {
            Some(("python", vec![path.to_string()]))
        }
        #[cfg(not(windows))]
        {
            Some(("python3", vec![path.to_string()]))
        }
    } else if lower.ends_with(".mjs") || lower.ends_with(".js") {
        Some(("node", vec![path.to_string()]))
    } else if lower.ends_with(".ts") {
        Some(("npx", vec!["tsx".to_string(), path.to_string()]))
    } else if lower.ends_with(".sh") || lower.ends_with(".bash") {
        #[cfg(windows)]
        {
            Some(("bash", vec![path.to_string()]))
        }
        #[cfg(not(windows))]
        {
            Some(("bash", vec![path.to_string()]))
        }
    } else {
        None
    }
}

// User scripts and Bash commands should run in a clean system environment,
// not the GUI app's. An AppImage (and some packaging) leaks PYTHONHOME /
// PYTHONPATH into the app's own process; inherited by a spawned python3,
// they break its stdlib bootstrap ("Failed to import encodings"). Strip
// them before spawn so every Python tool/script/command runs against the
// system interpreter's own paths. No-op when the vars aren't set.
fn strip_polluting_env(cmd: &mut Command) {
    cmd.env_remove("PYTHONHOME");
    cmd.env_remove("PYTHONPATH");
}

#[tauri::command]
async fn run_script(
    script_path: String,
    stdin_json: Option<String>,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
    env: Option<std::collections::HashMap<String, String>>,
) -> Result<ScriptResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_script_sync(script_path, stdin_json, cwd, timeout_ms, env)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn run_script_sync(
    script_path: String,
    stdin_json: Option<String>,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
    env: Option<std::collections::HashMap<String, String>>,
) -> Result<ScriptResult, String> {
    use std::io::{Read, Write};
    use std::time::{Duration, Instant};

    let (program, args) =
        interpreter_for(&script_path).ok_or_else(|| {
            format!(
                "no known interpreter for {} (supported: .py .js .mjs .ts .sh .bash)",
                script_path
            )
        })?;

    let timeout = Duration::from_millis(timeout_ms.unwrap_or(60_000));

    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new(program);
        c.creation_flags(0x08000000); // CREATE_NO_WINDOW
        c
    };
    #[cfg(not(windows))]
    let mut cmd = Command::new(program);

    cmd.args(&args);
    strip_polluting_env(&mut cmd);
    if let Some(d) = &cwd {
        if PathBuf::from(d).is_dir() {
            cmd.current_dir(d);
        }
    }
    if let Some(vars) = env {
        for (k, v) in vars {
            cmd.env(k, v);
        }
    }
    cmd.stdin(std::process::Stdio::piped());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;

    if let (Some(stdin), Some(payload)) = (child.stdin.take(), stdin_json.as_ref()) {
        let mut stdin = stdin;
        let _ = stdin.write_all(payload.as_bytes());
        drop(stdin);
    }

    let start = Instant::now();
    let mut timed_out = false;
    let code;
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => {
                code = status.code().unwrap_or(-1);
                break;
            }
            None => {
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    timed_out = true;
                    code = -1;
                    break;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }

    let mut stdout = String::new();
    let mut stderr = String::new();
    if let Some(mut o) = child.stdout.take() {
        let _ = o.read_to_string(&mut stdout);
    }
    if let Some(mut e) = child.stderr.take() {
        let _ = e.read_to_string(&mut stderr);
    }

    const MAX_OUT: usize = 50_000;
    if stdout.len() > MAX_OUT {
        stdout = format!(
            "{}\n…[truncated {} bytes]",
            &stdout[..MAX_OUT],
            stdout.len() - MAX_OUT
        );
    }
    if stderr.len() > MAX_OUT {
        stderr = format!(
            "{}\n…[truncated {} bytes]",
            &stderr[..MAX_OUT],
            stderr.len() - MAX_OUT
        );
    }

    Ok(ScriptResult {
        stdout,
        stderr,
        code,
        timed_out,
    })
}

// ----- Telegram bot -----
//
// Inbound: a background task long-polls Bot API's getUpdates, filters
// messages to the configured user_id, and emits a `telegram:message`
// event each time a new message arrives. The frontend listens for that
// event and routes the message into the conversations store.
//
// Outbound: `telegram_send_message` posts a text reply via the Bot
// API. The frontend invokes this when the user sends an assistant
// reply in a telegram-sourced conversation.

// Multi-poller: one entry per (bot_token, vault) pair so several
// vaults' bots can long-poll concurrently. Keyed by bot_token since
// that's what Telegram's API contract is at (one consumer per token).
// Each handle carries the vault_id so emitted events can be routed
// back to the correct vault's conversations on the JS side.
struct TelegramPoller {
    stop: std::sync::Arc<AtomicBool>,
    vault_id: String,
}

static TELEGRAM_POLLERS: Mutex<Option<std::collections::HashMap<String, TelegramPoller>>> =
    Mutex::new(None);

fn pollers_lock() -> std::sync::MutexGuard<'static, Option<std::collections::HashMap<String, TelegramPoller>>> {
    let mut g = TELEGRAM_POLLERS.lock().unwrap();
    if g.is_none() {
        *g = Some(std::collections::HashMap::new());
    }
    g
}

#[derive(Serialize, Clone)]
struct TelegramInbound {
    chat_id: i64,
    from_user_id: i64,
    from_username: Option<String>,
    text: String,
    message_id: i64,
    timestamp: i64,
    vault_id: String,
    // file_id of the highest-resolution PhotoSize, if the message
    // carried a photo. JS handler calls telegram_download_file to
    // pull bytes into the vault and pass as a ChatAttachment.
    photo_file_ids: Vec<String>,
}

#[derive(Serialize, Clone)]
struct TelegramStatus {
    running: bool,
    bot_username: Option<String>,
    error: Option<String>,
    vault_id: String,
}

fn emit_telegram_status(app: &AppHandle, status: TelegramStatus) {
    let _ = app.emit("telegram:status", status);
}

#[tauri::command]
fn telegram_running(bot_token: Option<String>) -> bool {
    let g = pollers_lock();
    let map = g.as_ref().unwrap();
    match bot_token {
        Some(t) => map.contains_key(&t),
        None => !map.is_empty(),
    }
}

#[tauri::command]
async fn telegram_start(
    app: AppHandle,
    bot_token: String,
    user_id: String,
    vault_id: String,
) -> Result<(), String> {
    {
        let g = pollers_lock();
        if g.as_ref().unwrap().contains_key(&bot_token) {
            // Already polling this bot. Idempotent.
            return Ok(());
        }
    }
    let allowed_id: i64 = user_id
        .trim()
        .parse()
        .map_err(|_| "telegram user_id must be a number".to_string())?;

    // First, validate the token by calling getMe — surfaces auth errors
    // immediately instead of after a long-poll timeout.
    let me_status = telegram_get_me(&bot_token).await;
    match me_status {
        Ok(name) => {
            emit_telegram_status(
                &app,
                TelegramStatus {
                    running: true,
                    bot_username: Some(name),
                    error: None,
                    vault_id: vault_id.clone(),
                },
            );
        }
        Err(e) => {
            emit_telegram_status(
                &app,
                TelegramStatus {
                    running: false,
                    bot_username: None,
                    error: Some(e.clone()),
                    vault_id: vault_id.clone(),
                },
            );
            return Err(e);
        }
    }

    let stop = std::sync::Arc::new(AtomicBool::new(false));
    {
        let mut g = pollers_lock();
        g.as_mut().unwrap().insert(
            bot_token.clone(),
            TelegramPoller {
                stop: stop.clone(),
                vault_id: vault_id.clone(),
            },
        );
    }

    let app_clone = app.clone();
    let token_clone = bot_token.clone();
    let vault_clone = vault_id.clone();
    tauri::async_runtime::spawn(async move {
        telegram_poll_loop(app_clone, token_clone, allowed_id, vault_clone, stop).await;
    });
    Ok(())
}

#[tauri::command]
fn telegram_stop(app: AppHandle, bot_token: Option<String>) -> Result<(), String> {
    let mut g = pollers_lock();
    let map = g.as_mut().unwrap();
    let to_remove: Vec<String> = match &bot_token {
        Some(t) => {
            if map.contains_key(t) {
                vec![t.clone()]
            } else {
                vec![]
            }
        }
        None => map.keys().cloned().collect(),
    };
    for t in to_remove {
        if let Some(p) = map.remove(&t) {
            p.stop.store(true, Ordering::SeqCst);
            emit_telegram_status(
                &app,
                TelegramStatus {
                    running: false,
                    bot_username: None,
                    error: None,
                    vault_id: p.vault_id,
                },
            );
        }
    }
    Ok(())
}

#[tauri::command]
async fn telegram_test(bot_token: String) -> Result<String, String> {
    telegram_get_me(&bot_token).await
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

// Download a Telegram file by file_id and save it to a vault-relative
// path. Two HTTP roundtrips: getFile (returns file_path), then
// /file/bot<token>/<file_path> for the bytes. Stores under
// <vault>/.vault-chat/telegram-images/<timestamp>_<basename>.
#[tauri::command]
async fn telegram_download_file(
    bot_token: String,
    file_id: String,
    vault: String,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent("vault-chat/0.1")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let get_file_url = format!("https://api.telegram.org/bot{}/getFile?file_id={}", bot_token, file_id);
    let resp = client.get(&get_file_url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("getFile {}: {}", resp.status(), resp.text().await.unwrap_or_default().chars().take(200).collect::<String>()));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let file_path = json
        .get("result")
        .and_then(|r| r.get("file_path"))
        .and_then(|p| p.as_str())
        .ok_or_else(|| "no file_path in getFile response".to_string())?
        .to_string();
    let download_url = format!("https://api.telegram.org/file/bot{}/{}", bot_token, file_path);
    let resp = client.get(&download_url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("file download {}: ", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;

    let dir = std::path::Path::new(&vault).join(".vault-chat").join("telegram-images");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {}", e))?;
    let basename = std::path::Path::new(&file_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("image.jpg");
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let out_path = dir.join(format!("{}_{}", ts, basename));
    std::fs::write(&out_path, &bytes).map_err(|e| format!("write: {}", e))?;
    Ok(out_path.to_string_lossy().to_string())
}

#[tauri::command]
async fn telegram_send_photo(
    bot_token: String,
    chat_id: i64,
    file_path: String,
    caption: Option<String>,
) -> Result<(), String> {
    let bytes = std::fs::read(&file_path)
        .map_err(|e| format!("read {}: {}", file_path, e))?;
    let filename = std::path::Path::new(&file_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("image")
        .to_string();
    let client = reqwest::Client::builder()
        .user_agent("vault-chat/0.1")
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("https://api.telegram.org/bot{}/sendPhoto", bot_token);
    let part = reqwest::multipart::Part::bytes(bytes).file_name(filename);
    let mut form = reqwest::multipart::Form::new()
        .text("chat_id", chat_id.to_string())
        .part("photo", part);
    if let Some(c) = caption {
        if !c.is_empty() {
            // Telegram caption cap is 1024 chars.
            let trimmed: String = c.chars().take(1024).collect();
            form = form.text("caption", trimmed);
        }
    }
    let resp = client.post(&url).multipart(form).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "telegram sendPhoto {}: {}",
            status,
            body.chars().take(200).collect::<String>()
        ));
    }
    Ok(())
}

#[tauri::command]
async fn telegram_send_message(
    bot_token: String,
    chat_id: i64,
    text: String,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .user_agent("vault-chat/0.1")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("https://api.telegram.org/bot{}/sendMessage", bot_token);
    // Telegram limits text to 4096 chars per message. Chunk so long
    // assistant replies still go through.
    const MAX_LEN: usize = 4000;
    let body = text.chars().collect::<Vec<_>>();
    let mut i = 0;
    while i < body.len() {
        let end = std::cmp::min(i + MAX_LEN, body.len());
        let chunk: String = body[i..end].iter().collect();
        // Telegram per-chat rate limit is ~1 msg/sec. For replies that
        // span multiple chunks (long agent outputs), pace them so the
        // tail chunks don't get 429'd and silently dropped — which was
        // making long responses arrive truncated to the first chunk
        // while short replies got through cleanly.
        if i > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
        }
        let payload = serde_json::json!({
            "chat_id": chat_id,
            "text": chunk,
        });
        // Retry once on 429 (rate-limited) using the retry_after hint
        // from Telegram. Other failures are treated as fatal.
        let mut attempt = 0u8;
        loop {
            let resp = client
                .post(&url)
                .json(&payload)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if resp.status().is_success() {
                break;
            }
            if resp.status().as_u16() == 429 && attempt < 1 {
                let body_text = resp.text().await.unwrap_or_default();
                // Parameters.retry_after is in seconds.
                let wait_s: u64 = serde_json::from_str::<serde_json::Value>(&body_text)
                    .ok()
                    .and_then(|j| {
                        j.get("parameters")
                            .and_then(|p| p.get("retry_after"))
                            .and_then(|r| r.as_u64())
                    })
                    .unwrap_or(2);
                tokio::time::sleep(std::time::Duration::from_secs(wait_s.min(30))).await;
                attempt += 1;
                continue;
            }
            let status = resp.status();
            let body_text = resp.text().await.unwrap_or_default();
            return Err(format!(
                "telegram send {}: {}",
                status,
                body_text.chars().take(200).collect::<String>()
            ));
        }
        i = end;
    }
    Ok(())
}

async fn telegram_get_me(bot_token: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent("vault-chat/0.1")
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("https://api.telegram.org/bot{}/getMe", bot_token);
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "telegram getMe {}: {}",
            status,
            body.chars().take(200).collect::<String>()
        ));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let username = json
        .get("result")
        .and_then(|r| r.get("username"))
        .and_then(|u| u.as_str())
        .ok_or_else(|| "no username in getMe response".to_string())?
        .to_string();
    Ok(format!("@{}", username))
}

async fn telegram_poll_loop(
    app: AppHandle,
    bot_token: String,
    allowed_id: i64,
    vault_id: String,
    stop: std::sync::Arc<AtomicBool>,
) {
    // Long-poll timeout is server-side (~25s). Allow our HTTP timeout to
    // extend past that with a small buffer for network jitter. Built via
    // a closure so we can rebuild the client mid-loop to drop a stale
    // keep-alive pool after sustained failures (see below).
    let build_client = || {
        reqwest::Client::builder()
            .user_agent("vault-chat/0.1")
            .timeout(std::time::Duration::from_secs(40))
            .build()
    };
    let mut client = match build_client() {
        Ok(c) => c,
        Err(e) => {
            emit_telegram_status(
                &app,
                TelegramStatus {
                    running: false,
                    bot_username: None,
                    error: Some(format!("http client init: {}", e)),
                    vault_id: vault_id.clone(),
                },
            );
            pollers_lock().as_mut().unwrap().remove(&bot_token);
            return;
        }
    };

    let mut offset: i64 = 0;
    let url = format!("https://api.telegram.org/bot{}/getUpdates", bot_token);
    let mut consecutive_errors = 0u32;
    // Whether we've shown a network error in the UI for the current run of
    // failures, so we can clear it once the connection recovers instead of
    // leaving a stale error sitting on screen.
    let mut error_surfaced = false;

    while !stop.load(Ordering::SeqCst) {
        let params = [
            ("timeout", "25".to_string()),
            ("offset", offset.to_string()),
            ("allowed_updates", "[\"message\"]".to_string()),
        ];
        let resp = match client.get(&url).query(&params).send().await {
            Ok(r) => r,
            Err(e) => {
                consecutive_errors += 1;
                if consecutive_errors >= 5 && !error_surfaced {
                    emit_telegram_status(
                        &app,
                        TelegramStatus {
                            running: true,
                            bot_username: None,
                            error: Some(format!("network: {}", e)),
                            vault_id: vault_id.clone(),
                        },
                    );
                    error_surfaced = true;
                }
                // A sustained failure run usually means the keep-alive pool
                // is holding dead sockets — common after laptop sleep/wake
                // or a network change, where reqwest would otherwise wait
                // out the full 40s timeout on each stale connection. Rebuild
                // the client every 5 failures to force fresh connections.
                if consecutive_errors % 5 == 0 {
                    if let Ok(c) = build_client() {
                        client = c;
                    }
                }
                // Recover fast on a blip (1s) but back off when truly
                // offline, capped at 10s so we stop hammering Telegram.
                let backoff = 1000u64.saturating_mul(consecutive_errors.min(10) as u64);
                tokio_sleep(backoff).await;
                continue;
            }
        };
        if consecutive_errors > 0 {
            consecutive_errors = 0;
            // Connection is back — clear the stale network error in the UI.
            // bot_username: None preserves the cached name on the JS side.
            if error_surfaced {
                error_surfaced = false;
                emit_telegram_status(
                    &app,
                    TelegramStatus {
                        running: true,
                        bot_username: None,
                        error: None,
                        vault_id: vault_id.clone(),
                    },
                );
            }
        }
        if !resp.status().is_success() {
            let status = resp.status();
            let code = status.as_u16();
            let body = resp.text().await.unwrap_or_default();
            // Only a bad token is truly fatal (401 Unauthorized / 404 Not
            // Found). Everything else is transient and the poller must
            // self-heal by retrying — most importantly 409 Conflict, which
            // fires when another getUpdates consumer is still active. That
            // happens on a quick app reopen while the previous session's
            // long-poll is still draining on Telegram's side; it clears on
            // its own within ~25s. Also retry 429 (rate limit) and 5xx.
            let fatal = code == 401 || code == 404;
            emit_telegram_status(
                &app,
                TelegramStatus {
                    running: !fatal,
                    bot_username: None,
                    error: Some(format!(
                        "getUpdates {}: {}",
                        status,
                        body.chars().take(200).collect::<String>()
                    )),
                    vault_id: vault_id.clone(),
                },
            );
            if fatal {
                pollers_lock().as_mut().unwrap().remove(&bot_token);
                return;
            }
            // Transient — back off a few seconds and keep polling.
            tokio_sleep(3000).await;
            continue;
        }
        let json: serde_json::Value = match resp.json().await {
            Ok(j) => j,
            Err(e) => {
                emit_telegram_status(
                    &app,
                    TelegramStatus {
                        running: true,
                        bot_username: None,
                        error: Some(format!("json parse: {}", e)),
                        vault_id: vault_id.clone(),
                    },
                );
                tokio_sleep(1000).await;
                continue;
            }
        };
        let Some(updates) = json.get("result").and_then(|r| r.as_array()) else {
            tokio_sleep(500).await;
            continue;
        };
        for upd in updates {
            let update_id = upd
                .get("update_id")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            if update_id >= offset {
                offset = update_id + 1;
            }
            let Some(msg) = upd.get("message") else { continue };
            let from_id = msg
                .get("from")
                .and_then(|f| f.get("id"))
                .and_then(|i| i.as_i64())
                .unwrap_or(0);
            if from_id != allowed_id {
                continue;
            }
            let chat_id = msg
                .get("chat")
                .and_then(|c| c.get("id"))
                .and_then(|i| i.as_i64())
                .unwrap_or(0);
            // Telegram messages can carry text, a photo, or both
            // (photo + caption). Collect both — caption becomes the
            // text content, photo file_ids ride along for download.
            let text = if let Some(t) = msg.get("text").and_then(|t| t.as_str()) {
                t.to_string()
            } else if let Some(c) = msg.get("caption").and_then(|t| t.as_str()) {
                c.to_string()
            } else {
                String::new()
            };
            let photo_file_ids: Vec<String> = msg
                .get("photo")
                .and_then(|p| p.as_array())
                .map(|arr| {
                    arr.last()
                        .and_then(|p| p.get("file_id"))
                        .and_then(|s| s.as_str())
                        .map(|s| vec![s.to_string()])
                        .unwrap_or_default()
                })
                .unwrap_or_default();
            if text.is_empty() && photo_file_ids.is_empty() {
                continue;
            }
            let from_username = msg
                .get("from")
                .and_then(|f| f.get("username"))
                .and_then(|u| u.as_str())
                .map(|s| s.to_string());
            let message_id = msg.get("message_id").and_then(|i| i.as_i64()).unwrap_or(0);
            let timestamp = msg.get("date").and_then(|d| d.as_i64()).unwrap_or(0);
            let payload = TelegramInbound {
                chat_id,
                from_user_id: from_id,
                from_username,
                text,
                message_id,
                timestamp,
                vault_id: vault_id.clone(),
                photo_file_ids,
            };
            let _ = app.emit("telegram:message", payload);
        }
    }
    pollers_lock().as_mut().unwrap().remove(&bot_token);
}

async fn tokio_sleep(ms: u64) {
    tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
}

// Show the calling window. Paired with the `visible: false` startup
// state set on the main window in `setup()` and on the popout in
// sync.ts: the frontend invokes this once React has mounted and the
// boot splash has begun fading, so the OS only ever sees the window
// in its painted state — no pre-paint flash.
#[tauri::command]
fn app_ready(window: tauri::WebviewWindow) -> Result<(), String> {
    window.show().map_err(|e| e.to_string())?;
    let _ = window.set_focus();
    Ok(())
}

#[derive(Serialize)]
struct TexCompileResult {
    pdf_path: String,
    log: String,
}

// Compile a LaTeX source string to PDF via the bundled Tectonic engine.
// Writes the source + any sibling assets the user opened from go into a
// per-document scratch directory under the OS temp folder, keyed by the
// source file path's hash so repeat compiles reuse Tectonic's downloaded
// bundle / aux file cache instead of re-fetching every time.
//
// Errors include the engine's stderr tail so the frontend can show a
// readable diagnostic when the document fails to typeset (the LaTeX
// error model is line-noisy — a 4 KB tail is usually enough to find the
// `! Undefined control sequence.` line).
#[tauri::command]
async fn compile_tex(
    app: tauri::AppHandle,
    source_path: String,
    contents: String,
) -> Result<TexCompileResult, String> {
    use tauri::Manager;
    use tauri::path::BaseDirectory;

    // The bundled binary keeps its platform-native name: tectonic.exe on
    // Windows (see tauri.conf.json), plain `tectonic` on Linux (see
    // tauri.linux.conf.json). Resolving the wrong one makes compile_tex fail
    // with a "tectonic binary missing" error on the other platform.
    let tectonic_resource = if cfg!(windows) {
        "binaries/tectonic.exe"
    } else {
        "binaries/tectonic"
    };
    let tectonic_path = app
        .path()
        .resolve(tectonic_resource, BaseDirectory::Resource)
        .map_err(|e| format!("locate tectonic binary: {e}"))?;
    if !tectonic_path.exists() {
        return Err(format!(
            "tectonic binary missing at {} — try rebuilding (the download-tectonic script populates this)",
            tectonic_path.display()
        ));
    }

    tauri::async_runtime::spawn_blocking(move || compile_tex_sync(tectonic_path, source_path, contents))
        .await
        .map_err(|e| e.to_string())?
}

// Escape a raw string for safe display in LaTeX text / typewriter mode.
// Used to print a missing image's path inside the placeholder box without
// the special chars (underscores, %, &, …) breaking the compile.
fn tex_escape_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\textbackslash{}"),
            '~' => out.push_str("\\textasciitilde{}"),
            '^' => out.push_str("\\textasciicircum{}"),
            '&' | '%' | '$' | '#' | '_' | '{' | '}' => {
                out.push('\\');
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out
}

// Does the graphic referenced by `raw` (a \includegraphics argument)
// resolve to a real file on disk, relative to `base`? graphicx lets you
// omit the extension, so when none is given we probe the common ones.
fn graphic_exists(base: &std::path::Path, raw: &str) -> bool {
    let raw = raw.trim();
    if raw.is_empty() {
        return true; // leave odd/empty args alone
    }
    let candidate = if std::path::Path::new(raw).is_absolute() {
        std::path::PathBuf::from(raw)
    } else {
        base.join(raw)
    };
    if std::path::Path::new(raw).extension().is_some() {
        return candidate.exists();
    }
    if candidate.exists() {
        return true;
    }
    const EXTS: &[&str] = &[
        "png", "pdf", "jpg", "jpeg", "PNG", "PDF", "JPG", "JPEG", "eps", "gif", "bmp",
    ];
    EXTS.iter().any(|e| {
        let mut p = candidate.clone();
        p.set_extension(e);
        p.exists()
    })
}

// Replace \includegraphics references to MISSING files with a visible
// placeholder box, so one bad path renders a "[missing image]" frame
// instead of halting the whole preview compile. Valid graphics and the
// rest of the document are left untouched. Bails out entirely if the
// document uses \graphicspath, since our relative-only resolution can't
// see those search dirs and would produce false placeholders.
fn neutralize_missing_graphics(contents: &str, base: &std::path::Path) -> String {
    const NEEDLE: &str = "\\includegraphics";
    if contents.contains("\\graphicspath") || !contents.contains(NEEDLE) {
        return contents.to_string();
    }
    let bytes = contents.as_bytes();
    let skip_ws = |mut k: usize| {
        while k < bytes.len() && bytes[k].is_ascii_whitespace() {
            k += 1;
        }
        k
    };
    let mut out = String::with_capacity(contents.len());
    let mut i = 0usize;
    while let Some(rel) = contents[i..].find(NEEDLE) {
        let start = i + rel;
        out.push_str(&contents[i..start]);
        let mut k = start + NEEDLE.len();
        if bytes.get(k) == Some(&b'*') {
            k += 1;
        }
        k = skip_ws(k);
        // optional [options]
        if bytes.get(k) == Some(&b'[') {
            match contents[k..].find(']') {
                Some(c) => k = k + c + 1,
                None => {
                    out.push_str(NEEDLE);
                    i = start + NEEDLE.len();
                    continue;
                }
            }
        }
        k = skip_ws(k);
        // required {path}
        if bytes.get(k) == Some(&b'{') {
            if let Some(c) = contents[k..].find('}') {
                let path = &contents[k + 1..k + c];
                let end = k + c + 1;
                if graphic_exists(base, path) {
                    out.push_str(&contents[start..end]);
                } else {
                    out.push_str(&format!(
                        "\\fbox{{\\begin{{minipage}}[c]{{0.6\\linewidth}}\\centering\\vspace{{1.5em}}{{\\bfseries [missing image]}}\\\\[0.4em]{{\\ttfamily\\small {}}}\\\\[0.3em]{{\\footnotesize\\itshape file not found --- check the path}}\\vspace{{1.5em}}\\end{{minipage}}}}",
                        tex_escape_text(path)
                    ));
                }
                i = end;
                continue;
            }
        }
        // Unparseable — emit the command name verbatim and continue.
        out.push_str(NEEDLE);
        i = start + NEEDLE.len();
    }
    out.push_str(&contents[i..]);
    out
}

fn compile_tex_sync(
    tectonic_path: PathBuf,
    source_path: String,
    contents: String,
) -> Result<TexCompileResult, String> {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    use std::io::Read;

    // Per-document scratch directory keyed by a hash of the source path.
    // Reusing the same directory across compiles lets Tectonic skip
    // re-fetching downloaded packages and reuse .aux state, so an edit
    // loop stays fast after the first compile.
    let mut hasher = DefaultHasher::new();
    source_path.hash(&mut hasher);
    let key = format!("{:x}", hasher.finish());
    let work_dir = std::env::temp_dir().join("vault-chat-tex").join(&key);
    std::fs::create_dir_all(&work_dir)
        .map_err(|e| format!("create scratch dir {}: {}", work_dir.display(), e))?;

    // Tectonic resolves \input and \includegraphics relative to the
    // PRIMARY INPUT FILE's directory — NOT the process cwd and NOT
    // $TEXINPUTS (both verified to be ignored for graphics lookup). So a
    // document that pulls in assets by relative path
    // (e.g. \includegraphics{output/fig.png}) only compiles if the input
    // .tex we hand Tectonic lives in the SAME folder as the real file.
    //
    // We therefore drop a short-lived dotfile next to the real .tex and
    // point Tectonic at it, while still sending ALL output (pdf, log,
    // intermediates) to the scratch dir via --outdir. The source folder
    // only ever holds one preview dotfile, deleted as soon as the compile
    // returns. If the source dir isn't writable, fall back to compiling in
    // scratch (assets won't resolve, but plain documents still work).
    let src_dir = std::path::Path::new(&source_path)
        .parent()
        .filter(|p| p.is_dir());
    let preview_name = format!(".vault-chat-preview-{key}.tex");

    // Make missing-image references non-fatal: swap each \includegraphics
    // whose target doesn't exist for a visible placeholder box. Resolve
    // against the REAL source dir (where the assets live), regardless of
    // where the preview dotfile ends up being written.
    let contents = match src_dir {
        Some(dir) => neutralize_missing_graphics(&contents, dir),
        None => contents,
    };

    let (input, cleanup_input) = match src_dir {
        Some(dir) => {
            let p = dir.join(&preview_name);
            match std::fs::write(&p, &contents) {
                Ok(_) => (p, true),
                Err(_) => {
                    let fallback = work_dir.join("input.tex");
                    std::fs::write(&fallback, &contents)
                        .map_err(|e| format!("write {}: {}", fallback.display(), e))?;
                    (fallback, false)
                }
            }
        }
        None => {
            let p = work_dir.join("input.tex");
            std::fs::write(&p, &contents)
                .map_err(|e| format!("write {}: {}", p.display(), e))?;
            (p, false)
        }
    };
    // Tectonic names its outputs after the input file's stem, so the pdf
    // and log land at <scratch>/<stem>.{pdf,log}.
    let stem: String = input
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("input")
        .to_string();

    // Tectonic CLI: `compile <file> --outdir <dir> --keep-logs --chatter minimal`.
    // Tectonic V2 CLI: `tectonic -X compile <file> --outdir <dir> --keep-logs`.
    // --keep-logs leaves input.log on disk so we can show its tail on
    // failure. (`--chatter` lives on the legacy V1 entry point, not on
    // the V2 `compile` subcommand — passing it errors out.)
    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new(&tectonic_path);
        c.creation_flags(0x08000000); // CREATE_NO_WINDOW
        c
    };
    #[cfg(not(windows))]
    let mut cmd = Command::new(&tectonic_path);

    cmd.arg("-X")
        .arg("compile")
        .arg(&input)
        .arg("--outdir")
        .arg(&work_dir)
        .arg("--keep-logs")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("spawn tectonic: {e}"))?;
    let mut stderr_buf = String::new();
    if let Some(mut s) = child.stderr.take() {
        let _ = s.read_to_string(&mut stderr_buf);
    }
    let status = child.wait().map_err(|e| e.to_string())?;

    // Remove the preview dotfile from the source dir now that Tectonic has
    // read it — before any early return — so it can't linger in the vault
    // or get swept into an auto-commit.
    if cleanup_input {
        let _ = std::fs::remove_file(&input);
    }

    let log_path = work_dir.join(format!("{stem}.log"));
    let log_tail = std::fs::read_to_string(&log_path)
        .ok()
        .map(|s| {
            // Last ~6 KB of the log usually carries the error site.
            let bytes = s.as_bytes();
            if bytes.len() > 6_000 {
                String::from_utf8_lossy(&bytes[bytes.len() - 6_000..]).to_string()
            } else {
                s
            }
        })
        .unwrap_or_default();

    if !status.success() {
        return Err(format!(
            "tectonic exit {}\n\n--- stderr ---\n{}\n\n--- log tail ---\n{}",
            status.code().unwrap_or(-1),
            stderr_buf.trim(),
            log_tail.trim()
        ));
    }

    let pdf = work_dir.join(format!("{stem}.pdf"));
    if !pdf.exists() {
        return Err(format!(
            "tectonic reported success but no PDF at {}\n\n--- stderr ---\n{}\n\n--- log tail ---\n{}",
            pdf.display(),
            stderr_buf.trim(),
            log_tail.trim()
        ));
    }

    Ok(TexCompileResult {
        pdf_path: pdf.to_string_lossy().replace('\\', "/"),
        log: log_tail,
    })
}

#[cfg(windows)]
fn apply_titlebar_color(window: &tauri::WebviewWindow) {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR,
    };
    let hwnd = match window.hwnd() {
        Ok(h) => h.0 as HWND,
        Err(_) => return,
    };
    // bg-card: HSL(240, 6%, 13%) ≈ rgb(31, 31, 35) — COLORREF is 0x00BBGGRR
    let caption: u32 = 0x00_23_1F_1F;
    let text: u32 = 0x00_E8_EB_EE;
    let border: u32 = 0x00_2A_26_26;
    unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_CAPTION_COLOR as u32,
            &caption as *const _ as *const _,
            std::mem::size_of::<u32>() as u32,
        );
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_TEXT_COLOR as u32,
            &text as *const _ as *const _,
            std::mem::size_of::<u32>() as u32,
        );
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_BORDER_COLOR as u32,
            &border as *const _ as *const _,
            std::mem::size_of::<u32>() as u32,
        );
    }
}

// ── Native agent-audio playback (Linux) ────────────────────────────────────
// WebKitGTK 2.52 on Ubuntu 26.04 renders no audio output, so the ElevenLabs
// agent voice is silent if played through the webview. The SDK's `onAudio`
// callback hands us the agent's speech as base64 PCM (16 kHz mono, s16le); we
// decode it and play it natively with rodio, which uses the working system
// audio path. The rodio OutputStream is not Send, so it lives on a dedicated
// thread and we talk to it over a channel.
#[cfg(target_os = "linux")]
mod agent_audio {
    use std::sync::mpsc::{channel, Sender};
    use std::sync::{Mutex, OnceLock};

    enum Cmd {
        Play(Vec<i16>),
        Stop,
    }

    static TX: OnceLock<Mutex<Sender<Cmd>>> = OnceLock::new();

    fn sender() -> &'static Mutex<Sender<Cmd>> {
        TX.get_or_init(|| {
            let (tx, rx) = channel::<Cmd>();
            std::thread::spawn(move || {
                let (_stream, handle) = match rodio::OutputStream::try_default() {
                    Ok(v) => v,
                    Err(e) => {
                        eprintln!("agent_audio: no output device: {e}");
                        return;
                    }
                };
                let sink = match rodio::Sink::try_new(&handle) {
                    Ok(s) => s,
                    Err(e) => {
                        eprintln!("agent_audio: sink init failed: {e}");
                        return;
                    }
                };
                for cmd in rx {
                    match cmd {
                        Cmd::Play(samples) => {
                            sink.append(rodio::buffer::SamplesBuffer::new(1, 16_000, samples));
                        }
                        Cmd::Stop => {
                            // Drop queued audio (barge-in / session end), then
                            // resume so the next turn plays. clear() pauses.
                            sink.clear();
                            sink.play();
                        }
                    }
                }
            });
            Mutex::new(tx)
        })
    }

    pub fn play(b64: &str) {
        use base64::Engine;
        let bytes = match base64::engine::general_purpose::STANDARD.decode(b64) {
            Ok(b) => b,
            Err(_) => return,
        };
        let mut samples = Vec::with_capacity(bytes.len() / 2);
        for ch in bytes.chunks_exact(2) {
            samples.push(i16::from_le_bytes([ch[0], ch[1]]));
        }
        if samples.is_empty() {
            return;
        }
        let _ = sender().lock().unwrap().send(Cmd::Play(samples));
    }

    pub fn stop() {
        if let Some(tx) = TX.get() {
            let _ = tx.lock().unwrap().send(Cmd::Stop);
        }
    }
}

// Play a base64 PCM (16 kHz mono s16le) agent-audio chunk natively. No-op off
// Linux, where the webview plays audio correctly on its own.
#[tauri::command]
fn agent_audio_play(b64: String) {
    #[cfg(target_os = "linux")]
    agent_audio::play(&b64);
    #[cfg(not(target_os = "linux"))]
    let _ = b64;
}

// Stop/flush native agent-audio playback (barge-in or session end).
#[tauri::command]
fn agent_audio_stop() {
    #[cfg(target_os = "linux")]
    agent_audio::stop();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // WebKitGTK's sandboxed WebProcess can't resolve GStreamer plugins on this
    // stack unless the system plugin dir is on GST_PLUGIN_SYSTEM_PATH. Without
    // it, mic capture sees "0 devices" (the WebProcess even caches an empty
    // registry) and voice mode fails with "Invalid constraint". The AppImage
    // points this at its own bundled dir; append the system dir so plugins
    // (appsink, device providers) are found. CI bundles GStreamer 1.28 — same
    // as the system — so loading system plugins is ABI-safe.
    #[cfg(target_os = "linux")]
    {
        const SYS_GST: &str = "/usr/lib/x86_64-linux-gnu/gstreamer-1.0";
        if std::path::Path::new(SYS_GST).is_dir() {
            let cur = std::env::var("GST_PLUGIN_SYSTEM_PATH_1_0").unwrap_or_default();
            if !cur.split(':').any(|p| p == SYS_GST) {
                let next = if cur.is_empty() {
                    SYS_GST.to_string()
                } else {
                    format!("{cur}:{SYS_GST}")
                };
                std::env::set_var("GST_PLUGIN_SYSTEM_PATH_1_0", next);
            }
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            use tauri::Manager;

            // Window visibility on cold start. The window is created hidden
            // (tauri.conf.json `visible:false`) so Windows/macOS never flash
            // an unpainted WebView frame. The frontend calls `app_ready` to
            // show it the instant React's first paint lands — a single, clean
            // appear with no show→hide→show flicker.
            //
            // Earlier this hid the window here in setup *after* a `visible:true`
            // config — which on Windows produced exactly that flicker (the OS
            // showed the frame, then we hid it, then app_ready re-showed it).
            if let Some(w) = app.get_webview_window("main") {
                #[cfg(windows)]
                apply_titlebar_color(&w);

                // Linux exception: some WebKitGTK compositors never deliver a
                // first paint frame and historically left the window hidden
                // forever. There the static HTML splash covers the load, so
                // show immediately rather than waiting on a paint signal.
                #[cfg(target_os = "linux")]
                {
                    let _ = w.show();

                    // wry installs no permission-request handler on WebKitGTK,
                    // so getUserMedia (microphone) is denied by default and
                    // voice mode fails with NotAllowedError. Reach into the
                    // underlying WebKitWebView to enable the media features and
                    // approve UserMedia (microphone) permission requests.
                    use webkit2gtk::{
                        glib::object::Cast, PermissionRequestExt, SettingsExt,
                        UserMediaPermissionRequest, WebViewExt,
                    };
                    let _ = w.with_webview(|webview| {
                        let wv = webview.inner();
                        if let Some(settings) = WebViewExt::settings(&wv) {
                            settings.set_enable_media_stream(true);
                            settings.set_enable_mediasource(true);
                            settings.set_enable_webrtc(true);
                            settings.set_enable_webaudio(true);
                            // Voice mode resumes its playback AudioContext
                            // asynchronously after the click that starts it;
                            // without this WebKitGTK keeps it suspended.
                            settings.set_media_playback_requires_user_gesture(false);
                            settings.set_media_playback_allows_inline(true);
                        }
                        wv.connect_permission_request(|_wv, req| {
                            if req.downcast_ref::<UserMediaPermissionRequest>().is_some() {
                                req.allow();
                                true
                            } else {
                                false
                            }
                        });
                    });
                }

                // Cross-platform safety net: if the frontend never calls
                // `app_ready` at all (a wedged WebView that doesn't even run
                // JS), show the window anyway after a few seconds so it can
                // never stay invisible.
                let wf = w.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    if matches!(wf.is_visible(), Ok(false)) {
                        let _ = wf.show();
                        let _ = wf.set_focus();
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_markdown_files,
            read_text_file,
            read_binary_file,
            write_text_file,
            append_debug_log,
            write_binary_file_unique,
            cleanup_old_captures,
            copy_into_vault,
            delete_file,
            create_dir,
            rename_path,
            edit_text_file,
            glob_files,
            grep_files,
            bash_exec,
            bash_shell_kind,
            list_dir,
            http_fetch,
            tavily_search,
            read_ignore_lines,
            add_to_ignore,
            rename_in_ignore,
            remove_prefix_from_ignore,
            remove_from_ignore,
            read_deny_lines,
            add_to_deny,
            rename_in_deny,
            remove_prefix_from_deny,
            remove_from_deny,
            read_humanized,
            add_to_humanized,
            rename_in_humanized,
            remove_prefix_from_humanized,
            notes_read,
            notes_append,
            notes_write_all,
            conversations_read,
            conversations_write_all,
            schedules_read,
            schedules_write_all,
            open_terminal,
            git_init_if_needed,
            git_commit_all,
            git_recent_commits,
            git_repo_root_for_file,
            git_log_subdir,
            git_revert_head,
            git_show_commit,
            git_restore_to_commit,
            git_all_touched_files,
            git_commit_files,
            git_file_history,
            git_file_at,
            git_diff_vs_current,
            git_restore_file_to,
            vault_sync_status,
            vault_sync_set_remote,
            vault_sync_commit_local,
            vault_commit_local,
            vault_sync_pull,
            vault_sync_push,
            vault_sync_gh_create_repo,
            telegram_running,
            telegram_start,
            telegram_stop,
            telegram_test,
            telegram_send_message,
            telegram_send_photo,
            telegram_download_file,
            path_exists,
            default_system_prompt,
            default_voice_prompt,
            default_telegram_prompt,
            default_supervisor_prompt,
            run_script,
            keychain_get,
            keychain_set,
            keychain_delete,
            keystore_encrypt,
            keystore_decrypt,
            compile_tex,
            agent_audio_play,
            agent_audio_stop,
            app_ready
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
