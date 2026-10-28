mod voice_server;
mod boot_watch;
mod agent_projects;
mod box_sync;
mod master;
mod vault_page;

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
use std::time::Duration;

// Every command that touches the disk, spawns a process or waits on the network
// is `async` and does that work on the blocking pool. A plain `fn` command runs
// on the main thread, and while it runs the window pumps no messages: a second
// of git or `tailscale` there is a frozen window, five is Windows' "Not
// responding". Keep plain `fn` commands for in-memory work only.

// Fire a `file-changed` event with the absolute path. Subscribed to by
// viewers that need to react to disk mutations they didn't initiate —
// currently just TexView, which uses it to debounce-recompile when the
// agent edits the .tex file backing the open preview, but the channel
// is intentionally generic so future viewers can opt in.
fn emit_file_changed(app: &AppHandle, path: &str) {
    let _ = app.emit("file-changed", path.to_string());
}

const IGNORE_FILE: &str = ".vaultchatignore";
pub(crate) const NOTES_DIR: &str = ".vault-chat";
const NOTES_FILE: &str = "notes.jsonl";
/// Folder holding one `<id>.json` per conversation (replaces the single
/// `conversations.jsonl` monolith). Per-conversation files mean a new message
/// rewrites only its own small file, not the whole multi-MB blob — collapsing
/// git churn — and two machines editing *different* conversations no longer
/// collide on the same file at all.
pub(crate) const CONVERSATIONS_DIR: &str = "conversations";
const SCHEDULES_FILE: &str = "schedules.jsonl";
/// Deleted-schedule tombstones — the schedule analogue of
/// `conversations-deleted.jsonl`. schedules.jsonl is `merge=union`, so a plain
/// delete-by-omission gets RESURRECTED the moment another machine that still has
/// the row syncs back (this is exactly how a "cancel my watchdog" came back to
/// life and kept firing every 30 min after a laptop wake). An append-only
/// `{id, ts}` tombstone unions cleanly across machines, and every reader filters
/// against it, so a deletion is permanent.
const SCHEDULES_DELETED_FILE: &str = "schedules-deleted.jsonl";

#[derive(Serialize)]
struct FileEntry {
    path: String,
    name: String,
    is_dir: bool,
    depth: usize,
    hidden: bool,
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

// Load a list-file (.vaultchatignore) into a set of
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
            let dirty = run_git(&path_str, &["status", "--porcelain", "--ignore-submodules=dirty"])
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
            git_branch,
            git_dirty_count,
            git_warn,
        });
    }
    Ok(entries)
}

// Inner sync helpers below back the .vaultchatignore tauri commands.

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

/// Projects as a vault folder (agent_projects.rs): move `.vault-chat/projects/*`
/// to `agent-projects/` and hide that folder once. Run on vault open and after
/// a project is created here. Idempotent.
#[tauri::command]
async fn prepare_agent_projects(vault: String) -> Result<agent_projects::Prepared, String> {
    tauri::async_runtime::spawn_blocking(move || {
        agent_projects::prepare(std::path::Path::new(&vault), IGNORE_FILE)
    })
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

/// [experience-log] Append one UI-event line to `.vault-chat/client-events.jsonl`
/// — what the user SAW and TAPPED on the phone (card renders, option taps, send
/// outcomes, errors). Append-only, synced like the rest of the vault, so a bug
/// report becomes a replay of the real session instead of a description. Mirrors
/// `notes_append`; best-effort on the caller side (a failure just drops a log).
#[tauri::command]
async fn client_event_append(vault: String, line: String) -> Result<(), String> {
    use std::io::Write;
    tauri::async_runtime::spawn_blocking(move || {
        let dir = std::path::Path::new(&vault).join(NOTES_DIR);
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("mkdir {}: {}", dir.display(), e))?;
        let path = dir.join("client-events.jsonl");
        rotate_log_file(&path, "client-events.1.jsonl", CLIENT_EVENTS_CAP_BYTES);
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

/// Deleted-conversation tombstones. Deletion must be EXPLICIT: an append-only
/// `{id, ts}` line in `.vault-chat/conversations-deleted.jsonl` (sibling of the
/// conversations folder so directory-scanning readers never parse it as a
/// conversation; `*.jsonl merge=union` makes it sync conflict-free).
///
/// Why this exists: conversations_write_all used to delete every file whose id
/// wasn't in the WRITER'S in-memory list. With two machines syncing one vault
/// that's delete-by-omission — machine A creates a chat, syncs it over, machine
/// B's next persist (whose memory predates the chat) deletes the file, sync
/// propagates the deletion back, and the chat flaps in and out of existence.
/// Tombstones make every reader/writer agree on what's deleted, and nothing
/// else is ever removed.
pub(crate) fn conversation_tombstones_path(vault: &str) -> std::path::PathBuf {
    std::path::Path::new(vault)
        .join(NOTES_DIR)
        .join("conversations-deleted.jsonl")
}

/// The set of tombstoned ids, as sanitized file STEMS (what both readers key
/// their directory scans on).
pub(crate) fn conversation_tombstone_stems(vault: &str) -> std::collections::HashSet<String> {
    let mut out = std::collections::HashSet::new();
    if let Ok(raw) = std::fs::read_to_string(conversation_tombstones_path(vault)) {
        for line in raw.lines() {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                if let Some(id) = v.get("id").and_then(|x| x.as_str()) {
                    out.insert(conversation_file_stem(id));
                }
            }
        }
    }
    out
}

/// Explicitly delete one conversation: tombstone first (so every machine learns
/// of the deletion through sync), then remove the local file.
#[tauri::command]
async fn conversation_delete(vault: String, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let p = conversation_tombstones_path(&vault);
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        use std::io::Write as _;
        let line = serde_json::json!({ "id": id, "ts": ts }).to_string();
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&p)
            .map_err(|e| format!("open {}: {}", p.display(), e))?;
        writeln!(f, "{}", line).map_err(|e| e.to_string())?;
        // [phase 2] Box mode: the tombstone (append-only, merge=union) is the
        // whole request. The box's own writer removes the file when it sees it,
        // so the laptop never deletes a conversation file the box may be
        // appending to (a modify/delete conflict would close the merge gate).
        if box_sync::box_mode_cached(&vault) {
            return Ok(());
        }
        let dir = std::path::Path::new(&vault).join(NOTES_DIR).join(CONVERSATIONS_DIR);
        let stem = conversation_file_stem(&id);
        let _ = std::fs::remove_file(dir.join(format!("{}.jsonl", stem)));
        let _ = std::fs::remove_file(dir.join(format!("{}.json", stem)));
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Reassemble one conversation JSON string from a per-conversation `.jsonl`
/// body: a `meta` line (the conversation object minus `messages`) plus one line
/// per message. This append-only line layout is what lets `merge=union` resolve
/// two machines editing the same conversation losslessly — each machine's new
/// message is its own line, so the union keeps both instead of conflicting.
///
/// On read we keep EVERY message line in order — we never de-dup by content,
/// because real conversations legitimately contain byte-identical messages
/// (repeated short replies, identical tool results); content-dedup would delete
/// those. A union can at worst leave a rare duplicate line, which is a cosmetic
/// double, not data loss — always the safer side to err on. If several `meta`
/// lines survived a union we keep the freshest by `lastActivityAt`.
pub(crate) fn reconstruct_conversation(contents: &str) -> Option<String> {
    let mut meta: Option<serde_json::Value> = None;
    let mut meta_activity: i64 = i64::MIN;
    let mut messages: Vec<serde_json::Value> = Vec::new();
    for line in contents.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(t) {
            Ok(v) => v,
            Err(_) => continue,
        };
        // Classify by `id` FIRST: a conversation's meta line always carries the
        // conversation id, and a ChatMessage line never has a top-level `id`.
        // The old role-first order misclassified SUPERVISOR conversations —
        // their meta line carries `role:"supervisor"` (the conversation-level
        // role field) — as messages, so the whole file reconstructed to None:
        // every phone cockpit chat was invisible to the drawer and /conversation,
        // and (pre-tombstones) a restart would drop it from memory and the old
        // delete-by-omission sweep then erased the file itself.
        if v.get("id").is_some() {
            // A meta line. If a union left more than one, pick a winner. Terminal
            // state (a completed / killed mission) is MONOTONIC: once a mission is
            // DONE/KILLED it must never be resurrected by a staler RUNNING line —
            // even one with a NEWER lastActivityAt, because a stray post-completion
            // wake (a double-fire, a not-yet-cancelled heartbeat) re-stamps RUNNING
            // with a fresh timestamp and would otherwise win the freshness race and
            // put a finished mission back on the Activity board. So a terminal meta
            // always beats a non-terminal one; between two of the same kind the
            // freshest lastActivityAt wins. This is the tombstone rule (see
            // conversation/schedule tombstones) applied to mission completion.
            let act = v.get("lastActivityAt").and_then(|x| x.as_i64()).unwrap_or(0);
            let cand_terminal = is_terminal_meta(&v);
            let take = match &meta {
                None => true,
                Some(cur) => {
                    let cur_terminal = is_terminal_meta(cur);
                    if cand_terminal != cur_terminal {
                        cand_terminal // the terminal line wins regardless of freshness
                    } else {
                        act >= meta_activity
                    }
                }
            };
            if take {
                meta_activity = act;
                meta = Some(v);
            }
        } else if v.get("role").is_some() {
            // Collapse a message line byte-identical to the immediately-preceding
            // SAME-ROLE line: that is the union-merge / double-append artifact
            // (the 223 duplicate lines on disk), never a legitimate repeat — real
            // repeats ("?", "...", "Thank you.") are always assistant-separated,
            // so adjacent same-role twins are only ever an accident.
            let is_twin = messages.last().map_or(false, |prev| {
                prev.get("role") == v.get("role")
                    && serde_json::to_string(prev).ok() == serde_json::to_string(&v).ok()
            });
            if !is_twin {
                messages.push(v);
            }
        }
    }
    let mut meta = meta?;
    if let Some(obj) = meta.as_object_mut() {
        obj.insert("messages".to_string(), serde_json::Value::Array(messages));
    }
    serde_json::to_string(&meta).ok()
}

/// A conversation meta line is "terminal" once its mission has finished:
/// `completedAt` stamped, or `missionState` DONE/KILLED. Terminal state is
/// monotonic across a union merge — see the pick logic in
/// `reconstruct_conversation` — so a completed mission never reappears.
fn is_terminal_meta(v: &serde_json::Value) -> bool {
    v.get("completedAt").map_or(false, |x| !x.is_null())
        || matches!(
            v.get("missionState").and_then(|x| x.as_str()),
            Some("DONE") | Some("KILLED")
        )
}

/// The set of tombstoned schedule ids (deleted on some machine). Every reader
/// drops these so a union-merge resurrection of the row is inert.
pub(crate) fn schedule_tombstone_ids(vault: &str) -> std::collections::HashSet<String> {
    let mut out = std::collections::HashSet::new();
    let p = std::path::Path::new(vault)
        .join(NOTES_DIR)
        .join(SCHEDULES_DELETED_FILE);
    if let Ok(raw) = std::fs::read_to_string(p) {
        for line in raw.lines() {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                if let Some(id) = v.get("id").and_then(|x| x.as_str()) {
                    out.insert(id.to_string());
                }
            }
        }
    }
    out
}

/// Explicitly delete one schedule: append a tombstone so the deletion survives
/// the cross-machine `merge=union` sync. The row itself is also dropped from
/// schedules.jsonl by the caller's write, but THIS is what makes it stick.
#[tauri::command]
async fn schedule_tombstone_add(vault: String, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let p = std::path::Path::new(&vault)
            .join(NOTES_DIR)
            .join(SCHEDULES_DELETED_FILE);
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        use std::io::Write as _;
        let line = serde_json::json!({ "id": id, "ts": ts }).to_string();
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&p)
            .map_err(|e| format!("open {}: {}", p.display(), e))?;
        writeln!(f, "{}", line).map_err(|e| e.to_string())?;
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
        let tombstones = schedule_tombstone_ids(&vault);
        Ok(contents
            .lines()
            .filter(|l| !l.trim().is_empty())
            // Drop any row whose id has been tombstoned — a resurrected (or
            // duplicated-by-union) deleted schedule must never fire again.
            .filter(|l| match serde_json::from_str::<serde_json::Value>(l) {
                Ok(v) => v
                    .get("id")
                    .and_then(|x| x.as_str())
                    .map(|id| !tombstones.contains(id))
                    .unwrap_or(true),
                Err(_) => true,
            })
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
async fn open_terminal(cwd: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || open_terminal_sync(cwd))
        .await
        .map_err(|e| e.to_string())?
}

fn open_terminal_sync(cwd: Option<String>) -> Result<(), String> {
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

/// The command line for a shell on the box, in a vault's working copy:
/// `ssh -t user@host "cd '<path>' && exec $SHELL -l"`. Inputs are checked
/// (host/user charset, path absolute, no control characters) and the path is
/// single-quoted for the box's shell, so nothing in it is interpreted there.
fn box_ssh_argv(host: &str, user: &str, path: &str) -> Result<Vec<String>, String> {
    let ok_host = !host.is_empty()
        && host.len() <= 253
        && !host.starts_with('-')
        && host.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':'));
    if !ok_host {
        return Err(format!("bad box host: {:?}", host));
    }
    let ok_user = !user.is_empty()
        && user.len() <= 64
        && !user.starts_with('-')
        && user.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'));
    if !ok_user {
        return Err(format!("bad box user: {:?}", user));
    }
    if !path.starts_with('/') || path.len() > 4096 || path.chars().any(|c| c.is_control()) {
        return Err(format!("bad box path: {:?}", path));
    }
    let quoted = format!("'{}'", path.replace('\'', r"'\''"));
    Ok(vec![
        "ssh".to_string(),
        "-t".to_string(),
        format!("{}@{}", user, host),
        format!("cd {} && exec $SHELL -l", quoted),
    ])
}

/// POSIX-shell quoting of one word (for the macOS Terminal script line).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn sh_quote(word: &str) -> String {
    if !word.is_empty() && word.chars().all(|c| c.is_ascii_alphanumeric() || "@%+=:,./-_".contains(c)) {
        word.to_string()
    } else {
        format!("'{}'", word.replace('\'', r"'\''"))
    }
}

/// Run `argv` in a new terminal window (the same terminals `open_terminal` uses).
fn launch_in_new_terminal(argv: &[String]) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Windows Terminal when there is one (`;` is its command separator: escaped),
        // else the command in a console window of its own (CREATE_NEW_CONSOLE: the
        // same as `cmd /c start`, without cmd's quoting rules).
        let wt_args: Vec<String> = argv.iter().map(|a| a.replace(';', "\\;")).collect();
        if Command::new("wt")
            .arg("-w")
            .arg("new")
            .arg("new-tab")
            .args(&wt_args)
            .creation_flags(0x08000000)
            .spawn()
            .is_ok()
        {
            return Ok(());
        }
        Command::new(&argv[0])
            .args(&argv[1..])
            .creation_flags(0x00000010)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    #[cfg(target_os = "macos")]
    {
        let line = argv.iter().map(|a| sh_quote(a)).collect::<Vec<_>>().join(" ");
        let script_str = line.replace('\\', "\\\\").replace('"', "\\\"");
        Command::new("osascript")
            .args([
                "-e",
                &format!("tell application \"Terminal\" to do script \"{}\"", script_str),
                "-e",
                "tell application \"Terminal\" to activate",
            ])
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let with = |pre: &[&str]| -> Vec<String> {
            pre.iter().map(|s| s.to_string()).chain(argv.iter().cloned()).collect()
        };
        let attempts: [(&str, Vec<String>); 6] = [
            ("kitty", with(&[])),
            ("ptyxis", with(&["--new-window", "--"])),
            ("konsole", with(&["-e"])),
            ("gnome-terminal", with(&["--"])),
            ("x-terminal-emulator", with(&["-e"])),
            ("xterm", with(&["-e"])),
        ];
        for (term, args) in &attempts {
            if Command::new(term)
                .args(args)
                .env_remove("PYTHONHOME")
                .env_remove("PYTHONPATH")
                .spawn()
                .is_ok()
            {
                return Ok(());
            }
        }
        Err("no terminal emulator found".to_string())
    }
}

/// A terminal on the box, in a vault's working copy, over SSH (the tailnet).
#[tauri::command]
async fn open_box_terminal(host: String, user: String, path: String) -> Result<(), String> {
    let argv = box_ssh_argv(&host, &user, &path)?;
    tauri::async_runtime::spawn_blocking(move || launch_in_new_terminal(&argv))
        .await
        .map_err(|e| e.to_string())?
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

/// The laptop's diagnostic logs are capped: past the cap the file becomes its
/// `.1` sibling (the previous `.1` dropped), so a long-running laptop keeps the
/// recent days and never grows without bound. Best-effort; never fails a write.
const APP_LOG_CAP_BYTES: u64 = 4 * 1024 * 1024;
const CLIENT_EVENTS_CAP_BYTES: u64 = 4 * 1024 * 1024;

fn rotate_log_file(path: &std::path::Path, rotated_name: &str, cap: u64) {
    if let Ok(meta) = std::fs::metadata(path) {
        if meta.len() > cap {
            if let Some(dir) = path.parent() {
                let to = dir.join(rotated_name);
                let _ = std::fs::remove_file(&to);
                let _ = std::fs::rename(path, &to);
            }
        }
    }
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
        rotate_log_file(&path, "app-log.1.txt", APP_LOG_CAP_BYTES);
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

/// The machine's hostname, for stamping cross-machine diagnostic logs so a
/// sync failure can be attributed to a specific box ("the server" vs "the
/// laptop") when hunting for patterns. Cached for the process. Resolution
/// order: COMPUTERNAME (Windows) → HOSTNAME (Linux login shells) →
/// `/etc/hostname` (the headless box, where neither env var is exported) →
/// "unknown".
fn machine_host_name() -> String {
    static HOST: OnceLock<String> = OnceLock::new();
    HOST.get_or_init(|| {
        for var in ["COMPUTERNAME", "HOSTNAME"] {
            if let Ok(h) = std::env::var(var) {
                let h = h.trim();
                if !h.is_empty() {
                    return h.to_string();
                }
            }
        }
        if let Ok(h) = std::fs::read_to_string("/etc/hostname") {
            let h = h.trim();
            if !h.is_empty() {
                return h.to_string();
            }
        }
        "unknown".to_string()
    })
    .clone()
}

#[tauri::command]
fn machine_host() -> String {
    machine_host_name()
}

/// Append one JSONL event line to `<vault>/.vault-chat/sync-log.jsonl` — the
/// durable, machine-local record of vault-sync failures, recoveries, and
/// divergence-merges used to spot patterns over time. The red sync-status
/// banner is transient (overwritten each tick); this is the history behind it.
///
/// Like `append_debug_log`, it emits NO file-changed event — the log must never
/// feed back into the very sync loop that writes it — and is best-effort. The
/// file is gitignored (machine-local, never synced), so writing to it can't
/// perturb the sync it's measuring. Size-capped: once it grows past CAP_BYTES it
/// is trimmed to the last KEEP_LINES before appending, so a long-running box
/// can't let it balloon. Trimming is purely local and never touches history.
#[tauri::command]
async fn append_sync_log(vault_path: String, line: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        const CAP_BYTES: u64 = 512 * 1024;
        const KEEP_LINES: usize = 1500;
        let dir = std::path::Path::new(&vault_path).join(".vault-chat");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join("sync-log.jsonl");
        // Trim when oversized so the local log can't grow without bound.
        if let Ok(meta) = std::fs::metadata(&path) {
            if meta.len() > CAP_BYTES {
                if let Ok(existing) = std::fs::read_to_string(&path) {
                    let mut kept: Vec<&str> =
                        existing.lines().rev().take(KEEP_LINES).collect();
                    kept.reverse();
                    let _ = std::fs::write(&path, kept.join("\n") + "\n");
                }
            }
        }
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| e.to_string())?;
        let mut s = line;
        if !s.ends_with('\n') {
            s.push('\n');
        }
        f.write_all(s.as_bytes()).map_err(|e| e.to_string())
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

fn repo_key(vault: &str) -> String {
    std::path::Path::new(vault)
        .canonicalize()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| vault.to_string())
}

fn repo_lock_for(vault: &str) -> Arc<Mutex<()>> {
    let key = repo_key(vault);
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
    let _held = HeldRepoLock::mark(repo_key(vault));
    clear_stale_index_lock(vault);
    f()
}

thread_local! {
    /// The repo locks this thread holds (by `repo_key`): git run inside
    /// `with_repo_lock` does not take its own repo's lock again.
    static HELD_REPO_LOCKS: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) };
}

struct HeldRepoLock(String);
impl HeldRepoLock {
    fn mark(key: String) -> Self {
        HELD_REPO_LOCKS.with(|h| h.borrow_mut().push(key.clone()));
        HeldRepoLock(key)
    }
}
impl Drop for HeldRepoLock {
    fn drop(&mut self) {
        HELD_REPO_LOCKS.with(|h| {
            let mut h = h.borrow_mut();
            if let Some(i) = h.iter().rposition(|k| k == &self.0) {
                h.remove(i);
            }
        });
    }
}

/// The git subcommand in `args` (past `-c k=v` / `-C dir` and other leading flags).
fn git_subcommand<'a>(args: &[&'a str]) -> &'a str {
    let mut i = 0;
    while i < args.len() {
        let a = args[i];
        if a == "-c" || a == "-C" {
            i += 2;
        } else if a.starts_with('-') {
            i += 1;
        } else {
            return a;
        }
    }
    ""
}

/// Network-only git: no index, no work tree — it never collides with a commit.
fn git_is_network_only(args: &[&str]) -> bool {
    matches!(git_subcommand(args), "fetch" | "push" | "ls-remote")
}

/// How long a git run waits for its repo's lock before going ahead anyway
/// (a holder stuck past this is a bug elsewhere; never wedge the app on it).
const GIT_SERIAL_WAIT: Duration = Duration::from_secs(120);

/// Every git process the app starts in a repo runs one at a time, through the
/// same per-repo lock the writers hold (`with_repo_lock`) — reads too: on
/// Windows a commit cannot swap in its new index while another git has the old
/// one open ("fatal: unable to write new index file"). Network-only commands
/// (fetch, push, ls-remote) stay outside it, so a slow box never holds up a
/// commit. Inside `with_repo_lock` (any repo) it never takes a second lock.
fn git_serialized<T>(cwd: &str, args: &[&str], f: impl FnOnce() -> T) -> T {
    if git_is_network_only(args) || HELD_REPO_LOCKS.with(|h| !h.borrow().is_empty()) {
        return f();
    }
    let lock = repo_lock_for(cwd);
    let start = std::time::Instant::now();
    loop {
        match lock.try_lock() {
            Ok(_g) => {
                let _held = HeldRepoLock::mark(repo_key(cwd));
                return f();
            }
            Err(std::sync::TryLockError::Poisoned(p)) => {
                let _g = p.into_inner();
                let _held = HeldRepoLock::mark(repo_key(cwd));
                return f();
            }
            Err(std::sync::TryLockError::WouldBlock) => {
                if start.elapsed() >= GIT_SERIAL_WAIT {
                    eprintln!("[git] {} waited {}s for its repo lock; running anyway", git_subcommand(args), GIT_SERIAL_WAIT.as_secs());
                    return f();
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        }
    }
}

fn is_index_lock_error(stderr: &str) -> bool {
    // A foreign git (or a virus scanner) holding the index: "index.lock: File
    // exists", or on Windows the swap-in of the new index refused.
    stderr.contains("index.lock") || stderr.contains("unable to write new index file")
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
    if let Ok((st, _, _)) = run_git(sub, &["status", "--porcelain", "--ignore-submodules=dirty"]) {
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

pub(crate) fn run_git(
    cwd: &str,
    args: &[&str],
) -> Result<(String, String, i32), String> {
    run_git_timeout(cwd, args, GIT_TIMEOUT_SECS)
}

// Absolute path to the `gh` CLI, resolved once.
static GH_PATH: OnceLock<Option<PathBuf>> = OnceLock::new();

// GitHub token from `gh auth token`, cached for the app's lifetime.
// Token lifetime is ~8h for gh OAuth; within a single app session this is fine.
static GH_TOKEN: OnceLock<Option<String>> = OnceLock::new();

/// Call `gh auth token` directly in Rust (no shell, no quoting), cache result.
fn get_gh_token() -> Option<String> {
    GH_TOKEN
        .get_or_init(|| {
            let gh = find_gh()?;
            let mut cmd = Command::new(&gh);
            cmd.arg("auth").arg("token");
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW: no console flash
            }
            let out = cmd.output().ok()?;
            if !out.status.success() {
                return None;
            }
            let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if token.is_empty() { None } else { Some(token) }
        })
        .clone()
}

fn find_gh() -> Option<PathBuf> {
    GH_PATH
        .get_or_init(|| {
            #[cfg(windows)]
            {
                let candidates = [
                    std::env::var("ProgramFiles")
                        .ok()
                        .map(|p| PathBuf::from(p).join("GitHub CLI").join("gh.exe")),
                    std::env::var("ProgramFiles(x86)")
                        .ok()
                        .map(|p| PathBuf::from(p).join("GitHub CLI").join("gh.exe")),
                    std::env::var("LocalAppData").ok().map(|p| {
                        PathBuf::from(p)
                            .join("Programs")
                            .join("GitHub CLI")
                            .join("gh.exe")
                    }),
                ];
                for c in candidates.into_iter().flatten() {
                    if c.is_file() {
                        return Some(c);
                    }
                }
                use std::os::windows::process::CommandExt;
                let out = Command::new("where")
                    .arg("gh")
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
                if p.is_file() { Some(p) } else { None }
            }
            #[cfg(not(windows))]
            {
                // Common install locations first (apt/dnf, Homebrew on Intel and
                // Apple Silicon, Linuxbrew), then a PATH lookup via `command -v`.
                let candidates = [
                    "/usr/bin/gh",
                    "/usr/local/bin/gh",
                    "/opt/homebrew/bin/gh",
                    "/home/linuxbrew/.linuxbrew/bin/gh",
                ];
                for c in candidates {
                    let p = PathBuf::from(c);
                    if p.is_file() {
                        return Some(p);
                    }
                }
                let out = Command::new("sh").arg("-c").arg("command -v gh").output().ok()?;
                if !out.status.success() {
                    return None;
                }
                let first = String::from_utf8_lossy(&out.stdout)
                    .lines()
                    .map(str::trim)
                    .find(|l| !l.is_empty())?
                    .to_string();
                let p = PathBuf::from(first);
                if p.is_file() { Some(p) } else { None }
            }
        })
        .clone()
}

// History: auth is injected per-command (not stored config) because the
// headless Linux server never ran `gh auth setup-git`, and per-command config
// survives the global git config being wiped. It uses `gh auth token`, not
// `gh auth git-credential`, because gh's own helper stays silent when gh is
// configured for the ssh git protocol (the box is). It was once a `-c` arg on
// every git command line; it now travels in the environment (below).

/// The git config that authenticates GitHub HTTPS remotes, as (key, value).
///
/// Strategy: call `gh auth token` directly in Rust (no shell subprocess, no
/// quoting) and send the token as an HTTP Authorization header via
/// `http.https://github.com.extraHeader`. This sidesteps the credential-helper
/// system and all the shell-quoting fragility that plagued the `!f()` approach
/// (paths with spaces on Windows, sh implementation differences, GCM fallthrough
/// with stale passwords, etc.).
///
/// The header is NEVER put on git's command line (`-c …`): argv is readable by
/// any program that can list processes and is logged by GIT_TRACE2. It goes
/// through the environment instead (`github_auth_env`), which only the same
/// user can read and which trace2 does not log.
///
/// If gh is unavailable or not authenticated, return empty — git falls back to
/// whatever credential helpers are configured (GCM, netrc, etc.), which still
/// can't prompt interactively because GCM_INTERACTIVE=never is set.
fn github_auth_config(token: &str) -> Vec<(String, String)> {
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD
        .encode(format!("x-access-token:{}", token));
    vec![
        // Clear the host-specific credential-helper chain so GCM/netrc can't
        // race against our header or provide a conflicting Authorization value.
        ("credential.https://github.com.helper".into(), String::new()),
        (
            "http.https://github.com.extraHeader".into(),
            format!("Authorization: Basic {}", b64),
        ),
    ]
}

/// Git subcommands that may talk to a remote. Only these get the GitHub
/// credentials in their environment; a `status` or `commit` never sees them.
fn git_may_use_network(args: &[&str]) -> bool {
    matches!(
        git_subcommand(args),
        "fetch" | "push" | "pull" | "ls-remote" | "clone" | "submodule" | "remote"
    )
}

/// `git --version` as (major, minor), probed once. None if git won't run.
fn git_version() -> Option<(u32, u32)> {
    static V: OnceLock<Option<(u32, u32)>> = OnceLock::new();
    *V.get_or_init(|| {
        let mut cmd = Command::new("git");
        cmd.arg("--version");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }
        let out = cmd.output().ok()?;
        parse_git_version(&String::from_utf8_lossy(&out.stdout))
    })
}

/// "git version 2.46.0.windows.1" → (2, 46).
fn parse_git_version(s: &str) -> Option<(u32, u32)> {
    let v = s.trim().strip_prefix("git version ")?;
    let mut it = v.split('.');
    let major = it.next()?.trim().parse().ok()?;
    let minor = it
        .next()?
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect::<String>()
        .parse()
        .ok()?;
    Some((major, minor))
}

/// The environment variables that hand `entries` to git as config.
///
/// git ≥ 2.31: `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`,
/// numbered after any the app itself inherited. Older git (or an unknown
/// version): `GIT_CONFIG_PARAMETERS` in its original `'key=value'` form, which
/// every git since 1.7 reads — appended to an inherited value. Both are
/// inherited by git's own children (git-remote-https, submodule processes), so
/// nested-repo fetches authenticate too.
fn git_config_env(
    entries: &[(String, String)],
    version: Option<(u32, u32)>,
    inherited_count: Option<&str>,
    inherited_params: Option<&str>,
) -> Vec<(String, String)> {
    if entries.is_empty() {
        return vec![];
    }
    let modern = matches!(version, Some(v) if v >= (2, 31));
    if modern {
        let base: usize = inherited_count
            .and_then(|c| c.trim().parse().ok())
            .unwrap_or(0);
        let mut env = Vec::with_capacity(entries.len() * 2 + 1);
        for (i, (k, v)) in entries.iter().enumerate() {
            env.push((format!("GIT_CONFIG_KEY_{}", base + i), k.clone()));
            env.push((format!("GIT_CONFIG_VALUE_{}", base + i), v.clone()));
        }
        env.push(("GIT_CONFIG_COUNT".into(), (base + entries.len()).to_string()));
        env
    } else {
        // sq_quote: wrap in '…', and each ' inside becomes '\''.
        let quote = |s: &str| format!("'{}'", s.replace('\'', "'\''"));
        let mut parts: Vec<String> = inherited_params
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(|p| vec![p.to_string()])
            .unwrap_or_default();
        for (k, v) in entries {
            parts.push(quote(&format!("{}={}", k, v)));
        }
        vec![("GIT_CONFIG_PARAMETERS".into(), parts.join(" "))]
    }
}

/// Put GitHub credentials (if any) into `cmd`'s environment — never its argv —
/// when `args` is a git command that may reach a remote.
fn apply_github_auth(
    cmd: &mut Command,
    args: &[&str],
    token: Option<&str>,
    version: Option<(u32, u32)>,
) {
    let Some(token) = token.filter(|t| !t.is_empty()) else { return };
    if !git_may_use_network(args) {
        return;
    }
    let count = std::env::var("GIT_CONFIG_COUNT").ok();
    let params = std::env::var("GIT_CONFIG_PARAMETERS").ok();
    for (k, v) in git_config_env(
        &github_auth_config(token),
        version,
        count.as_deref(),
        params.as_deref(),
    ) {
        cmd.env(k, v);
    }
}

/// Kill a process AND every descendant by pid. git launches helper processes
/// (git-remote-https, git-credential-manager, ssh) that outlive a kill of the
/// direct child; on a timeout those orphans keep holding the network/credential
/// state — and, worse, an inherited stdout/stderr pipe write-end — until they
/// wedge every later sync. Taking a raw pid (not a `&mut Child`) lets the caller
/// hand the Child off to the drain worker thread while still being able to kill
/// the tree on timeout. Best-effort. The still-open Child handle keeps the pid
/// reserved (no reuse) until the worker reaps it, so killing by pid is safe.
fn kill_tree_by_pid(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // /T = terminate the whole tree rooted at PID, /F = force.
        let _ = Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .output();
    }
    #[cfg(unix)]
    {
        // We spawned the child as a process-group leader (pgid == pid), so a
        // signal to the negative pgid reaches the whole tree. Shell out to the
        // `kill` binary to avoid pulling in a libc dependency just for this.
        let _ = Command::new("kill")
            .arg("-KILL")
            .arg(format!("-{}", pid))
            .output();
    }
}

/// Like `run_git` but with a caller-chosen timeout. Used for operations that
/// can legitimately run far longer than a normal git command — notably the
/// first `submodule update --init`, which clones whole sub-repos.
fn run_git_timeout(
    cwd: &str,
    args: &[&str],
    timeout_secs: u64,
) -> Result<(String, String, i32), String> {
    git_serialized(cwd, args, || run_git_timeout_now(cwd, args, timeout_secs))
}

/// The git process `run_git` starts: never-prompt env, its own process group,
/// and — for commands that may reach a remote — the GitHub token in the
/// environment (never argv). Separate so tests can inspect argv and env.
fn git_command(
    cwd: &str,
    args: &[&str],
    token: Option<&str>,
    version: Option<(u32, u32)>,
) -> Command {
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
    // Authenticate GitHub HTTPS remotes with the `gh` token — through the
    // environment, never argv (see `github_auth_config`), and only for commands
    // that may reach a remote.
    apply_github_auth(&mut cmd, args, token, version);
    // Belt-and-suspenders: even if some helper is still consulted, forbid it
    // from prompting. A helper that can't satisfy the request non-interactively
    // must return nothing (so git fails fast) rather than block on a UI.
    cmd.arg("-c").arg("credential.interactive=false");
    cmd.args(args);
    // Never block on an interactive credential/passphrase prompt — on the
    // headless server that would hang the whole sync loop forever. Fail fast
    // and let the caller surface the auth error instead.
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    // Same for Git Credential Manager specifically: never let it pop a GUI
    // window (which GIT_TERMINAL_PROMPT does not cover and which hangs headless
    // and leaks an orphaned git-credential-manager process).
    cmd.env("GCM_INTERACTIVE", "never");
    // Don't take the optional index lock. Read-only commands (status, diff,
    // rev-list) otherwise grab `.git/index.lock` to opportunistically refresh
    // the index — which collides with an in-flight autosave commit and is a
    // prime cause of the sync wedge (status piling up, blocked on a lock a
    // commit holds, until both time out at 90s). With this set, reads never
    // contend for the lock; genuine writers (add/commit) still lock normally.
    cmd.env("GIT_OPTIONAL_LOCKS", "0");
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    // Put the child in its own process group (Unix) so a timeout can signal the
    // WHOLE tree. git launches helper processes (git-remote-https, the
    // credential helper, ssh) that survive a kill of the direct child — on a
    // timeout those orphans keep holding the network/credential state and pile
    // up until they wedge every later sync. (Windows uses taskkill /T instead.)
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd
}

fn run_git_timeout_now(
    cwd: &str,
    args: &[&str],
    timeout_secs: u64,
) -> Result<(String, String, i32), String> {
    use std::io::Read;
    let token = if git_may_use_network(args) { get_gh_token() } else { None };
    let version = if token.is_some() { git_version() } else { None };
    let mut cmd = git_command(cwd, args, token.as_deref(), version);
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let child_pid = child.id();
    // Wait for the child AND drain both pipes on a worker thread, the whole
    // thing bounded by a channel recv_timeout. The previous version bounded only
    // `child.try_wait()`; the pipe-reader `join()`s that followed were UNBOUNDED.
    // git spawns transport grandchildren (git-remote-https, the credential
    // helper) that inherit the stdout/stderr pipe write-ends — if one lingers
    // after the direct git process exits, `read_to_string` never sees EOF,
    // `join()` blocks forever, `run_git` never returns, and the sync loop's
    // in-flight guard stays stuck true: every later pull/push is skipped and the
    // whole loop wedges until an app restart. Bounding the entire wait+drain
    // guarantees we return within `timeout_secs` no matter what a grandchild
    // does. Separate threads per pipe so a large stdout can't deadlock against a
    // full stderr pipe (or vice-versa).
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
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
        let code = child.wait().map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
        let stdout = h_out.join().unwrap_or_default();
        let stderr = h_err.join().unwrap_or_default();
        let _ = tx.send((stdout, stderr, code));
    });
    match rx.recv_timeout(Duration::from_secs(timeout_secs)) {
        Ok(result) => Ok(result),
        Err(_) => {
            // Hung (or the worker panicked and dropped the sender). Kill the
            // whole tree so the inherited pipe handles close and the abandoned
            // worker unblocks and reaps the child; then return so the caller's
            // in-flight guard clears and the sync loop keeps going instead of
            // freezing forever.
            kill_tree_by_pid(child_pid);
            Err(format!(
                "git timed out after {}s: git {}",
                timeout_secs,
                args.join(" ")
            ))
        }
    }
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
.vault-chat/firer-heartbeat.json
.vault-chat/*heartbeat*.conflict
.vault-chat/app-log.txt
.vault-chat/app-log.1.txt
.vault-chat/client-events.jsonl
.vault-chat/client-events.1.jsonl
.vault-chat/diag/
.vault-chat/sync-log.jsonl
.vault-chat/pending-wakes.json
.vault-chat/*.bak
.vault-chat/*.tmp
__pycache__/
*.pyc
";

// Every machine-local ignore rule the managed block must carry. A vault seeded
// before a rule existed (e.g. firer-heartbeat.json, rewritten every ~10s and
// otherwise tracked — it kept the tree perpetually dirty, driving nonstop
// autosave commits and index-lock churn) carries the marker but is missing the
// newer line, so the upgrade path checks these one by one rather than bailing
// on the marker alone.
const VAULT_GITIGNORE_REQUIRED: &[&str] = &[
    ".vault-chat/run-heartbeat.json",
    ".vault-chat/firer-heartbeat.json",
    // The merge-conflict sidecar resolve_merge_conflicts used to write for a
    // (then-tracked) heartbeat is pure noise — ignore it so the untrack sweep
    // sheds any that were committed before heartbeats were untracked.
    ".vault-chat/*heartbeat*.conflict",
    ".vault-chat/app-log.txt",
    // The rotated app log, the UI's client events (each machine's own; the diag
    // bundle gathers the box's and the laptop's), and the diag bundles.
    ".vault-chat/app-log.1.txt",
    ".vault-chat/client-events.jsonl",
    ".vault-chat/client-events.1.jsonl",
    ".vault-chat/diag/",
    ".vault-chat/sync-log.jsonl",
    ".vault-chat/pending-wakes.json", // durable mission wake queue: per machine
    ".vault-chat/*.bak",
    ".vault-chat/*.tmp",
    "__pycache__/",
    "*.pyc",
];

/// Ensure `<vault>/.gitignore` exists and carries our managed block.
/// Returns true if it wrote the file (i.e. it was missing or stale).
/// Mirrors `ensure_vault_gitattributes`: prepends our block to preserve
/// any pre-existing user rules, and is idempotent (the marker comment
/// guards against duplicating the block on re-run).
fn ensure_vault_gitignore(vault: &str) -> bool {
    let path = PathBuf::from(vault).join(".gitignore");
    let current = std::fs::read_to_string(&path).unwrap_or_default();
    let has_marker = current.contains("Managed by vault-chat");
    // Append-only upgrade: a vault that already has the managed block but is
    // missing a newer rule (added after it was seeded) still gets that rule,
    // instead of bailing on the marker and shipping a stale ignore set.
    let missing: Vec<&str> = VAULT_GITIGNORE_REQUIRED
        .iter()
        .copied()
        .filter(|line| !current.lines().any(|l| l.trim() == *line))
        .collect();
    if has_marker && missing.is_empty() {
        return false;
    }
    let contents = if !has_marker {
        // Fresh seed — prepend our block to preserve any pre-existing user rules.
        if current.trim().is_empty() {
            VAULT_GITIGNORE.to_string()
        } else {
            format!("{}\n{}", VAULT_GITIGNORE, current)
        }
    } else {
        // Marker present, just missing newer rules — append only those.
        let mut s = current.clone();
        if !s.ends_with('\n') {
            s.push('\n');
        }
        for line in &missing {
            s.push_str(line);
            s.push('\n');
        }
        s
    };
    std::fs::write(&path, contents).is_ok()
}

/// Untrack any file that is currently tracked but matches a gitignore rule —
/// the general fix for the churn engine where an ephemeral file (the per-machine
/// heartbeats, logs, a merge-conflict sidecar) got committed before its ignore
/// rule existed, after which `.gitignore` is moot and the file re-commits on
/// every write, keeping the tree perpetually dirty and forking history across
/// machines. Lists tracked-but-ignored paths in one index-only pass
/// (`ls-files -i -c`) and drops them from the index; the working copy is left in
/// place. Returns how many paths it untracked — the caller's normal autosave
/// commit then captures the removal. Best-effort. Cheap in steady state (finds
/// nothing once a vault is clean).
fn untrack_ignored_files(vault: &str) -> u32 {
    let listed = match run_git(vault, &["ls-files", "-i", "-c", "--exclude-standard"]) {
        Ok((out, _, 0)) => out,
        _ => return 0,
    };
    let paths: Vec<String> = listed
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    if paths.is_empty() {
        return 0;
    }
    // Drop them in bounded chunks so a pathological case (e.g. a whole
    // node_modules committed by hand) can't overflow the OS command-line limit.
    for chunk in paths.chunks(64) {
        let mut args: Vec<&str> = vec!["rm", "--cached", "--quiet", "--ignore-unmatch", "--"];
        args.extend(chunk.iter().map(|s| s.as_str()));
        let _ = run_git_mut(vault, &args);
    }
    paths.len() as u32
}

/// Idempotent per-cycle repo hygiene, run at the top of every local/sync commit
/// so EVERY vault self-heals — not just on first init (the old behavior, which
/// left a vault seeded before a rule existed permanently stale, e.g. school's
/// `.gitignore` missing the heartbeat rule while its heartbeat churned history).
/// Ensures the managed `.gitattributes`/`.gitignore` are current, then sheds any
/// tracked-but-ignored ephemeral files. All three steps are cheap no-ops once a
/// vault is already in good shape (marker-gated writes + an index-only scan).
fn prepare_vault_repo(vault: &str) {
    ensure_vault_gitattributes(vault);
    ensure_vault_gitignore(vault);
    ensure_no_submodule_recurse(vault);
    untrack_ignored_files(vault);
}

/// Disable submodule fetch/checkout recursion on a managed vault. A follower's
/// `git fetch`/`pull` otherwise defaults to on-demand submodule recursion: when
/// an incoming superproject commit references a sub-repo commit that was never
/// pushed to that sub-repo's remote (a "lost" gitlink), the recurse-fetch asks
/// the remote for a commit it doesn't have (`upload-pack: not our ref`) and a
/// strict follower ABORTS the whole pull — so it never receives the superproject
/// commits (conversations, notes, schedules) that ride alongside. All synced data
/// lives in the superproject; real submodules are updated deliberately and
/// tolerantly by `sync_nested_repos`, so on-demand recursion buys us nothing here.
/// Idempotent + cheap: reads the current value and only writes when not already
/// `false`.
fn ensure_no_submodule_recurse(vault: &str) {
    for key in ["fetch.recurseSubmodules", "submodule.recurse"] {
        let already_false = matches!(
            run_git(vault, &["config", "--get", key]),
            Ok((ref v, _, 0)) if v.trim() == "false"
        );
        if !already_false {
            let _ = run_git_mut(vault, &["config", key, "false"]);
        }
    }
}

/// Read recent commits from a git repo at a vault-relative subdirectory
/// (e.g. a nested work repo like `DeepDL/bitnet-repro`). Unlike
/// the history timeline — which reads the vault root — this is a plain read-only `git log` meant
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
                        ".vault-chat/firer-heartbeat.json",
                        ".vault-chat/app-log.txt",
                        ".vault-chat/client-events.jsonl",
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

/// Append the attribution trailers (`Vault-Chat-Actor`, `Vault-Chat-Machine`,
/// optional `Conversation`) as the message's last paragraph.
pub(crate) fn with_actor_trailers(
    vault: &str,
    message: &str,
    agent: bool,
    actor: Option<String>,
    machine: Option<String>,
    conversation: Option<String>,
) -> String {
    let actor = actor.unwrap_or_else(|| if agent { "agent".into() } else { "human".into() });
    let machine = machine.unwrap_or_else(|| if box_sync::box_mode_cached(vault) { "box".into() } else { "laptop".into() });
    let mut t = format!("Vault-Chat-Actor: {}
Vault-Chat-Machine: {}", actor, machine);
    if let Some(c) = conversation.filter(|c| !c.trim().is_empty()) {
        t.push_str(&format!("
Conversation: {}", c.trim()));
    }
    format!("{}

{}", message.trim_end(), t)
}

/// Stage all changes and commit with the given message. Returns the
/// short hash of the new commit, or None if nothing was staged.
#[tauri::command]
async fn git_commit_all(
    vault: String,
    message: String,
    agent: Option<bool>,
    actor: Option<String>,
    machine: Option<String>,
    conversation: Option<String>,
) -> Result<Option<String>, String> {
    // Attribution contract (F-history §2): every commit says who made it and
    // where, so History reads trailers instead of guessing from subjects.
    let message = with_actor_trailers(&vault, &message, agent.unwrap_or(false), actor, machine, conversation);
    tauri::async_runtime::spawn_blocking(move || {
        with_repo_lock(&vault, || {
        // Box mode: never abort a merge someone is resolving by hand, keep the
        // mission zone the box's, and never commit a file over 50 MB.
        if box_sync::box_mode_cached(&vault) {
            if PathBuf::from(&vault).join(".git").join("MERGE_HEAD").exists() {
                return Ok(None);
            }
            let (name, email) = commit_identity(&vault, agent.unwrap_or(false));
            box_sync::box_stage_all(&vault, &name, &email)?;
            if matches!(run_git(&vault, &["diff", "--cached", "--quiet"]), Ok((_, _, 0))) {
                return Ok(None);
            }
            let (o, e, c) = run_git_as(&vault, &name, &email, &["commit", "-q", "-m", &message])?;
            if c != 0 {
                return Err(format!("git commit failed (exit {}):
{}
{}", c, e.trim(), o.trim()));
            }
            let (hash, _, _) = run_git(&vault, &["rev-parse", "--short", "HEAD"])?;
            return Ok(Some(hash.trim().to_string()));
        }
        // A crashed prior auto-sync can leave the repo mid-rebase, where
        // every commit silently no-ops. Clear that first so this commit
        // actually lands instead of vanishing.
        abort_stuck_merge_or_rebase(&vault);
        // `--ignore-submodules=dirty`: don't recurse into submodule working
        // trees to detect dirtiness (on a vault with big submodules — e.g.
        // torchtitan — that scan is what pushed `status` past the 90s timeout).
        // A submodule's own content is committed by the nested-repo pass first,
        // which moves its HEAD; the resulting gitlink/pointer change IS still
        // reported here, so the superproject's pointer-bump commit still fires.
        let (status_out, _, _) =
            run_git(&vault, &["status", "--porcelain", "--ignore-submodules=dirty"])?;
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
        // `--ignore-submodules=dirty`: don't recurse into submodule working
        // trees to detect dirtiness (on a vault with big submodules — e.g.
        // torchtitan — that scan is what pushed `status` past the 90s timeout).
        // A submodule's own content is committed by the nested-repo pass first,
        // which moves its HEAD; the resulting gitlink/pointer change IS still
        // reported here, so the superproject's pointer-bump commit still fires.
        let (status_out, _, _) =
            run_git(&vault, &["status", "--porcelain", "--ignore-submodules=dirty"])?;
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
        let dirty = run_git(&sub, &["status", "--porcelain", "--ignore-submodules=dirty"])
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

/// Commit the vault locally — the root repo only — WITHOUT any remote
/// operation. The always-on counterpart to `vault_sync_commit_local`: it runs
/// for vaults with sync turned off so they still accrue version history and
/// their nested-repo dots clear. No pull, push, fork, or branch.
#[tauri::command]
async fn vault_commit_local(vault: String) -> Result<SyncOpResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_repo_lock(&vault, || {
            abort_stuck_merge_or_rebase(&vault);
            // Self-heal the ignore set + shed tracked ephemerals every cycle, so
            // a vault never gets stuck churning history on a machine-local file.
            prepare_vault_repo(&vault);
            // No nested-repo automation (Carl's call): code repos inside a vault are
            // their own thing — autosave never commits inside them.
            let nested: u32 = 0;
            // `--ignore-submodules=dirty`: don't recurse into submodule working
        // trees to detect dirtiness (on a vault with big submodules — e.g.
        // torchtitan — that scan is what pushed `status` past the 90s timeout).
        // A submodule's own content is committed by the nested-repo pass first,
        // which moves its HEAD; the resulting gitlink/pointer change IS still
        // reported here, so the superproject's pointer-bump commit still fires.
        let (status_out, _, _) =
            run_git(&vault, &["status", "--porcelain", "--ignore-submodules=dirty"])?;
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
        // Self-heal the ignore set + shed tracked ephemerals every cycle, so a
        // vault never gets stuck churning history on a machine-local file.
        prepare_vault_repo(&vault);
        // A follower (content writer) resets the mission zone to origin BEFORE
        // staging, so the commit it's about to make can never carry a
        // mission-state change — the surgical replacement for the old
        // pull-only gate. See is_sync_follower / sanitize_mission_zone.
        if is_sync_follower(&vault) {
            if let Ok((b, _, 0)) = run_git(&vault, &["rev-parse", "--abbrev-ref", "HEAD"]) {
                let b = b.trim().to_string();
                if b != "HEAD" {
                    sanitize_mission_zone(&vault, &b);
                }
            }
        }
        // Sync every nested repo first — each by its own remote and the user's
        // relationship to it (own / shared / foreign / internal). This commits
        // their working trees (clearing the per-repo dots) and advances owned
        // HEADs so the parent's gitlink bumps get staged and committed below.
        sync_nested_repos(&vault, false);
        // `--ignore-submodules=dirty`: don't recurse into submodule working
        // trees to detect dirtiness (on a vault with big submodules — e.g.
        // torchtitan — that scan is what pushed `status` past the 90s timeout).
        // A submodule's own content is committed by the nested-repo pass first,
        // which moves its HEAD; the resulting gitlink/pointer change IS still
        // reported here, so the superproject's pointer-bump commit still fires.
        let (status_out, _, _) =
            run_git(&vault, &["status", "--porcelain", "--ignore-submodules=dirty"])?;
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
        // Don't publish a superproject gitlink that points at a sub-repo commit
        // the sub-repo hasn't pushed yet — that's exactly what strands followers
        // on a lost ref. Hold any such pointer at its last-pushed value; the
        // sub-repo keeps its local commit and the pointer advances on a later
        // cycle once its own push lands.
        let held = hold_unpushed_submodule_gitlinks(&vault);
        if held > 0
            && matches!(
                run_git(&vault, &["diff", "--cached", "--quiet"]),
                Ok((_, _, 0))
            )
        {
            // Holding those pointers left nothing staged this cycle.
            return Ok(SyncOpResult {
                ok: true,
                message: "no changes (held unpushed submodule pointers)".into(),
                error: false,
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

/// After any successful merge (fast-forward or diverged), scan every submodule
/// gitlink in HEAD and advance any that regressed — i.e., the merge resolved the
/// pointer to a commit that is a strict ancestor of the sub-repo's
/// `origin/<branch>` tip. This catches the silent auto-resolution case where git
/// sees "remote changed the gitlink, local didn't → take theirs" and picks a
/// stale box-pushed pointer without ever creating a conflict marker. Returns the
/// relative paths of submodules that were advanced and staged; callers must
/// create a follow-up commit if the list is non-empty.
fn fix_regressed_gitlinks(vault: &str) -> Vec<String> {
    let (out, _, c) = match run_git(
        vault,
        &["config", "-f", ".gitmodules", "--get-regexp", "submodule\\..*\\.path"],
    ) {
        Ok(r) => r,
        Err(_) => return vec![],
    };
    if c != 0 {
        return vec![];
    }
    let mut fixed: Vec<String> = Vec::new();
    for line in out.lines() {
        let mut it = line.splitn(2, char::is_whitespace);
        let key = it.next().unwrap_or("");
        let rel = it.next().unwrap_or("").trim();
        if rel.is_empty() {
            continue;
        }
        // submodule.<name>.path → name
        let name = key
            .strip_prefix("submodule.")
            .and_then(|s| s.strip_suffix(".path"))
            .unwrap_or("");
        if name.is_empty() {
            continue;
        }
        let branch_key = format!("submodule.{}.branch", name);
        let branch = match run_git(vault, &["config", "-f", ".gitmodules", "--get", &branch_key]) {
            Ok((b, _, 0)) if !b.trim().is_empty() => b.trim().to_string(),
            _ => continue,
        };
        let sub = format!("{}/{}", vault, rel);
        // Current gitlink in HEAD
        let current = match run_git(vault, &["rev-parse", &format!("HEAD:{}", rel)]) {
            Ok((s, _, 0)) if !s.trim().is_empty() => s.trim().to_string(),
            _ => continue,
        };
        // Sub-repo's remote branch tip
        let remote_ref = format!("origin/{}", branch);
        let tip = match run_git(&sub, &["rev-parse", &remote_ref]) {
            Ok((s, _, 0)) if !s.trim().is_empty() => s.trim().to_string(),
            _ => continue,
        };
        if current == tip {
            continue;
        }
        // Regression: current is a strict ancestor of tip (tip is newer).
        let regressed = matches!(
            run_git(&sub, &["merge-base", "--is-ancestor", &current, &tip]),
            Ok((_, _, 0))
        );
        if !regressed {
            continue;
        }
        eprintln!(
            "[sync] gitlink regression in '{}': {} → {} (branch {}); advancing",
            rel,
            &current[..8.min(current.len())],
            &tip[..8.min(tip.len())],
            branch
        );
        if matches!(
            run_git_mut(vault, &["update-index", "--cacheinfo", "160000", &tip, rel]),
            Ok((_, _, 0))
        ) {
            // Move the sub-repo's working tree to the tip so it matches the new gitlink.
            let _ = run_git_mut(&sub, &["checkout", "--detach", &tip]);
            fixed.push(rel.to_string());
        }
    }
    fixed
}

/// Before the superproject commits its gitlink bumps, hold back any submodule
/// pointer whose newly-staged commit has NOT yet reached the sub-repo's remote.
/// Publishing a superproject gitlink that points at an un-pushed sub-commit is
/// what strands followers: their recurse-fetch asks the sub-repo's remote for a
/// commit it never received (`upload-pack: not our ref`) and a strict follower
/// aborts the entire pull. We keep the parent pointer at its last-committed
/// (already-pushed) value; the sub-repo keeps its local commit and the pointer
/// advances on a later cycle once its own push lands. Conservative: only rewrites
/// the staged INDEX gitlink, never the sub-repo's working tree.
///
/// "On the remote" is tested against the sub-repo's `origin/<branch>` ref
/// (branch from `.gitmodules`), NOT `@{upstream}` — submodules are normally
/// checked out DETACHED and so have no upstream, which would skip the very repos
/// this guards. A submodule with no tracking branch or no `origin/<branch>` ref
/// is left alone (we can't prove a remote either way). Returns how many pointers
/// were held.
fn hold_unpushed_submodule_gitlinks(vault: &str) -> usize {
    let (out, _, c) = match run_git(
        vault,
        &["config", "-f", ".gitmodules", "--get-regexp", "submodule\\..*\\.path"],
    ) {
        Ok(r) => r,
        Err(_) => return 0,
    };
    if c != 0 {
        return 0;
    }
    let mut held = 0usize;
    for line in out.lines() {
        let mut it = line.splitn(2, char::is_whitespace);
        let key = it.next().unwrap_or("");
        let rel = it.next().unwrap_or("").trim();
        if rel.is_empty() {
            continue;
        }
        // submodule.<name>.path → the configured tracking branch, which is how we
        // resolve the sub-repo's remote tip (same source as fix_regressed_gitlinks).
        let name = match key.strip_prefix("submodule.").and_then(|s| s.strip_suffix(".path")) {
            Some(n) if !n.is_empty() => n,
            _ => continue,
        };
        let branch = match run_git(
            vault,
            &["config", "-f", ".gitmodules", "--get", &format!("submodule.{}.branch", name)],
        ) {
            Ok((b, _, 0)) if !b.trim().is_empty() => b.trim().to_string(),
            _ => continue, // no tracking branch → can't resolve a remote ref
        };
        let sub = format!("{}/{}", vault, rel);
        if !PathBuf::from(&sub).join(".git").exists() {
            continue; // not materialized on this machine
        }
        // What `add -A` just staged for this gitlink (the sub's working HEAD).
        let staged = match run_git(vault, &["rev-parse", &format!(":{}", rel)]) {
            Ok((s, _, 0)) if !s.trim().is_empty() => s.trim().to_string(),
            _ => continue,
        };
        // The pointer already in the superproject HEAD (last known-good = pushed).
        let committed = match run_git(vault, &["rev-parse", &format!("HEAD:{}", rel)]) {
            Ok((s, _, 0)) if !s.trim().is_empty() => s.trim().to_string(),
            _ => continue,
        };
        if staged == committed {
            continue; // pointer didn't move this cycle
        }
        // Is the staged sub-commit on the sub-repo's remote yet? Containment in
        // `origin/<branch>` — the remote-tracking ref, advanced only by a
        // successful fetch/push — is the honest "did this reach the remote" test.
        // Missing ref (never fetched) → can't prove it, leave the bump alone.
        let remote_ref = format!("origin/{}", branch);
        let have_ref = matches!(
            run_git(&sub, &["rev-parse", "--verify", "--quiet", &remote_ref]),
            Ok((_, _, 0))
        );
        if !have_ref {
            continue;
        }
        let pushed = matches!(
            run_git(&sub, &["merge-base", "--is-ancestor", &staged, &remote_ref]),
            Ok((_, _, 0))
        );
        if pushed {
            continue;
        }
        // Hold the parent pointer at the last-pushed commit.
        if matches!(
            run_git_mut(vault, &["update-index", "--cacheinfo", "160000", &committed, rel]),
            Ok((_, _, 0))
        ) {
            held += 1;
            eprintln!(
                "[sync] holding gitlink for '{}' at pushed {} (working {} not yet on {})",
                rel,
                &committed[..8.min(committed.len())],
                &staged[..8.min(staged.len())],
                remote_ref
            );
        }
    }
    held
}

/// Pick which commit a conflicted submodule gitlink should land on when two
/// machines advanced it independently: the descendant if one side's commit
/// contains the other (so no sub-repo work is dropped from the pointer), else
/// None — the caller then converges both machines on "theirs" (the remote tip),
/// and the sub-repo's own push/sync carries any local-ahead commits forward.
fn choose_submodule_commit(sub: &str, ours: &str, theirs: &str) -> Option<String> {
    if ours.is_empty() {
        return if theirs.is_empty() { None } else { Some(theirs.to_string()) };
    }
    if theirs.is_empty() || ours == theirs {
        return Some(ours.to_string());
    }
    let have = |c: &str| matches!(run_git(sub, &["cat-file", "-e", c]), Ok((_, _, 0)));
    if have(ours) && have(theirs) {
        if matches!(run_git(sub, &["merge-base", "--is-ancestor", theirs, ours]), Ok((_, _, 0))) {
            return Some(ours.to_string());
        }
        if matches!(run_git(sub, &["merge-base", "--is-ancestor", ours, theirs]), Ok((_, _, 0))) {
            return Some(theirs.to_string());
        }
    }
    None
}

/// After a `git merge` left conflicts, resolve EVERY conflicted path
/// deterministically so concurrent two-machine sync never wedges and never loses
/// data:
///   - a conflicted submodule gitlink → the descendant commit if one side
///     contains the other, else "theirs" so both machines converge (the
///     sub-repo's own sync carries its content);
///   - any other conflicted file → take "theirs" and write "ours" to a
///     `<path>.conflict` sidecar, so a genuine divergent edit is preserved for
///     the user to reconcile rather than silently dropped.
/// Append-only `*.jsonl` logs never reach here — git's `merge=union` already
/// merged them. Returns true once nothing remains unmerged.
fn resolve_merge_conflicts(vault: &str) -> bool {
    let paths: Vec<String> = match run_git(vault, &["diff", "--name-only", "--diff-filter=U"]) {
        Ok((out, _, 0)) => out.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect(),
        _ => return false,
    };
    for path in &paths {
        let (uf, _, _) = run_git(vault, &["ls-files", "-u", "--", path]).unwrap_or_default();
        let is_submodule = uf.lines().any(|l| l.starts_with("160000"));
        if is_submodule {
            let mut ours = String::new();
            let mut theirs = String::new();
            for l in uf.lines() {
                let parts: Vec<&str> = l.split_whitespace().collect();
                if parts.len() >= 3 {
                    match parts[2] {
                        "2" => ours = parts[1].to_string(),
                        "3" => theirs = parts[1].to_string(),
                        _ => {}
                    }
                }
            }
            let sub = format!("{}/{}", vault, path);
            let sha = choose_submodule_commit(&sub, &ours, &theirs)
                .or(if theirs.is_empty() { None } else { Some(theirs.clone()) })
                .or(if ours.is_empty() { None } else { Some(ours.clone()) });
            if let Some(sha) = sha {
                let _ = run_git_mut(vault, &["update-index", "--cacheinfo", "160000", &sha, path]);
            } else {
                let _ = run_git_mut(vault, &["rm", "--cached", "--", path]);
            }
            continue;
        }
        // Regular file: preserve OURS as a sidecar, take THEIRS into the tree.
        let ours_content = run_git(vault, &["show", &format!(":2:{}", path)])
            .ok()
            .and_then(|(c, _, code)| if code == 0 { Some(c) } else { None });
        let took_theirs = matches!(run_git_mut(vault, &["checkout", "--theirs", "--", path]), Ok((_, _, 0)));
        if !took_theirs {
            // Theirs deleted the file — keep ours so a live edit isn't lost.
            let _ = run_git_mut(vault, &["checkout", "--ours", "--", path]);
        }
        let _ = run_git_mut(vault, &["add", "--", path]);
        // Only preserve a sidecar for a real, synced file. An ephemeral file
        // that's gitignored (a heartbeat tracked before its ignore rule landed)
        // produces only noise sidecars that themselves churn + sync across
        // machines — take theirs and move on.
        let ignored = matches!(
            run_git(vault, &["check-ignore", "-q", "--", path]),
            Ok((_, _, 0))
        );
        if took_theirs && !ignored {
            if let Some(content) = ours_content {
                let sidecar = format!("{}.conflict", path);
                if std::fs::write(format!("{}/{}", vault, sidecar), content).is_ok() {
                    let _ = run_git_mut(vault, &["add", "--", &sidecar]);
                }
            }
        }
    }
    matches!(
        run_git(vault, &["diff", "--name-only", "--diff-filter=U"]),
        Ok((ref rem, _, 0)) if rem.trim().is_empty()
    )
}

/// Reconcile the local branch with an already-fetched `origin/<branch>`: a
/// fast-forward when possible, otherwise a real merge with deterministic
/// conflict resolution (union for append-only logs, descendant/theirs for
/// submodule pointers, a `.conflict` sidecar for a genuine divergent edit).
/// Returns the human-readable outcome on success, or an error `SyncOpResult` the
/// caller surfaces verbatim. The caller MUST already hold the repo lock and have
/// run `git fetch origin <branch>` first.
///
/// Shared by pull and by push-on-rejection so a diverged follower reconciles
/// identically no matter which path first notices the divergence.
fn reconcile_with_upstream(
    vault: &str,
    branch: &str,
) -> Result<Result<String, SyncOpResult>, String> {
    let upstream = format!("origin/{}", branch);
    // Need identity for any regression-fix commits we may add below.
    let (mn, me) = human_identity(vault);
    // Fast-forward first — clean, no merge commit, the common case.
    let (_, _, ff_code) = run_git_mut(vault, &["merge", "--ff-only", &upstream])?;
    if ff_code == 0 {
        // Even on a clean FF the remote may have pushed a stale gitlink
        // (box with a corrupted sub-repo config committing a regressed
        // pointer). Scan and correct before returning so the caller
        // never pushes a step-back.
        let fixed = fix_regressed_gitlinks(vault);
        if !fixed.is_empty() {
            let fix_msg = format!(
                "vault-chat: restore submodule pointers [regression fix: {}]",
                fixed.join(", ")
            );
            let _ = run_git_as(vault, &mn, &me, &["commit", "-m", &fix_msg]);
        }
        return Ok(Ok("pulled".into()));
    }
    // Diverged — both machines committed. We MERGE (never rebase): a merge
    // reconciles the two tips, and the append-only `*.jsonl` logs auto-union via
    // `.gitattributes`. Rebase would replay every local commit and wedge on the
    // first conflict; with an always-on box + an intermittent laptop that
    // divergence is the normal case, so sync must reconcile it, never
    // abort-and-loop. Whatever the union can't handle (submodule pointers, a
    // genuinely divergent file edit) is auto-resolved so sync always makes
    // progress and never drops data.
    let (_, mstderr, mut merge_code) =
        run_git_as(vault, &mn, &me, &["merge", "--no-edit", &upstream])?;
    // A DIRTY working tree makes `git merge` REFUSE TO START ("your local
    // changes would be overwritten") — a failure with NO unmerged paths, which
    // the conflict-resolution path below misreads as "resolved, commit it" and
    // dies on an empty commit (the "merge commit failed:" loop the sync split's
    // first live migration hit: the app autosaves between the cycle's commit
    // and its pull). Commit the drift the way the auto-sync would, retry once.
    if merge_code != 0 {
        let unmerged_empty = matches!(
            run_git(vault, &["ls-files", "-u"]),
            Ok((ref o, _, 0)) if o.trim().is_empty()
        );
        let merge_in_progress = run_git(vault, &["rev-parse", "-q", "--verify", "MERGE_HEAD"])
            .map(|(_, _, c)| c == 0)
            .unwrap_or(false);
        if unmerged_empty && !merge_in_progress {
            let _ = run_git_as(vault, &mn, &me, &["add", "-A"]);
            let _ = run_git_as(vault, &mn, &me, &["commit", "-q", "-m", "vault-chat: auto-sync"]);
            let (_, _, retry_code) =
                run_git_as(vault, &mn, &me, &["merge", "--no-edit", &upstream])?;
            merge_code = retry_code;
        }
    }
    if merge_code == 0 {
        let fixed = fix_regressed_gitlinks(vault);
        if !fixed.is_empty() {
            let fix_msg = format!(
                "vault-chat: restore submodule pointers [regression fix: {}]",
                fixed.join(", ")
            );
            let _ = run_git_as(vault, &mn, &me, &["commit", "-m", &fix_msg]);
            return Ok(Ok(format!("merged origin (regression fixed: {})", fixed.join(", "))));
        }
        return Ok(Ok("merged origin".into()));
    }
    if resolve_merge_conflicts(vault) {
        let (_, cstderr, ccode) = run_git_as(vault, &mn, &me, &["commit", "--no-edit"])?;
        if ccode != 0 {
            let _ = run_git_mut(vault, &["merge", "--abort"]);
            return Ok(Err(SyncOpResult {
                ok: false,
                message: format!("merge commit failed: {}", first_line(&cstderr).trim()),
                error: true,
            }));
        }
        let fixed = fix_regressed_gitlinks(vault);
        if !fixed.is_empty() {
            let fix_msg = format!(
                "vault-chat: restore submodule pointers [regression fix: {}]",
                fixed.join(", ")
            );
            let _ = run_git_as(vault, &mn, &me, &["commit", "-m", &fix_msg]);
            return Ok(Ok(format!(
                "merged origin (auto-resolved, regression fixed: {})",
                fixed.join(", ")
            )));
        }
        return Ok(Ok("merged origin (auto-resolved)".into()));
    }
    // Should be unreachable — every conflict class has a resolution. If
    // something slips through, abort cleanly so the tree is intact and the next
    // tick retries rather than leaving a half-merge.
    let _ = run_git_mut(vault, &["merge", "--abort"]);
    Ok(Err(SyncOpResult {
        ok: false,
        message: format!("unresolved conflict: {}", first_line(&mstderr).trim()),
        error: true,
    }))
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
        // Reconcile with the freshly-fetched upstream: fast-forward when we can,
        // otherwise a real merge. Shared with push-on-rejection so both paths
        // resolve a divergence identically.
        let pulled_msg = match reconcile_with_upstream(&vault, branch)? {
            Ok(msg) => msg,
            Err(e) => return Ok(e),
        };
        // Pull succeeded — bring any registered submodules to the commits the
        // vault now points at (clones them on a fresh machine). Best-effort.
        maybe_update_submodules(&vault);
        // Re-attach any sub-repos that `submodule update` left detached, and
        // advance them to their configured branch tip. This runs on every
        // pull cycle (~30s) so self-healing no longer requires a local edit.
        sync_nested_repos(&vault, false);
        // Commit any gitlink pointer bumps that sync_nested_repos produced.
        let (st, _, _) = run_git(&vault, &["status", "--porcelain", "--ignore-submodules=dirty"])
            .unwrap_or_default();
        if !st.trim().is_empty() {
            let (hn, he) = human_identity(&vault);
            let _ = run_git_as(&vault, &hn, &he, &["add", "-A"]);
            let _ = run_git_as(&vault, &hn, &he, &["commit", "-q", "-m", "vault-chat: auto-sync submodule pointers"]);
        }
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

/// A follower checkout is a CONTENT WRITER, not a mission host. Historically it
/// was pull-only (the blunt gate that stopped the phase-16→15 clobber: a stale
/// follower push forced the writer to reconcile against — and, via
/// `resolve_merge_conflicts`' take-theirs, ADOPT — old mission state). The gate
/// is now surgical instead of total: a follower pushes freely, but
/// `sanitize_mission_zone` first resets every mission-owned path (supervisor
/// state, schedules, notifications, jobs, selftest, and mission/worker/ask
/// conversation files) to origin's version, so its pushes can never introduce a
/// mission-state diff. Docs, notes, and the user's own chats flow both ways;
/// mission interaction happens live against the host (the box) over HTTP, like
/// the phone. The role marker lives in the NON-synced git dir, so it's a
/// property of THIS checkout and never rides git to another machine.
/// Absent / `writer` = mission host, full sync.
fn is_sync_follower(vault: &str) -> bool {
    let git_dir = run_git(vault, &["rev-parse", "--absolute-git-dir"])
        .ok()
        .and_then(|(o, _, c)| if c == 0 { Some(o.trim().to_string()) } else { None })
        .unwrap_or_else(|| format!("{}/.git", vault));
    std::fs::read_to_string(format!("{}/vault-chat-sync-role", git_dir))
        .map(|s| s.trim().eq_ignore_ascii_case("follower"))
        .unwrap_or(false)
}

/// The sync role for the frontend (scheduler + mission-routing gates).
#[tauri::command]
async fn vault_sync_role(vault: String) -> String {
    // A vault whose sync.json names a box is a follower: the box hosts its
    // missions and fires its schedules; this machine relays to it. (A git
    // process: off the main thread.)
    tauri::async_runtime::spawn_blocking(move || vault_sync_role_sync(vault))
        .await
        .unwrap_or_else(|_| "writer".into())
}

fn vault_sync_role_sync(vault: String) -> String {
    if is_sync_follower(&vault) || box_sync::box_config(&vault).is_some() {
        "follower".to_string()
    } else {
        "writer".to_string()
    }
}

/// One box-sync cycle (sync.json mode): commit, fetch `box`, merge gate, push
/// `master`, GitHub backup. `pull`: stop after the merge (the box just
/// published an edit; the next full cycle pushes). See box_sync.rs.
#[tauri::command]
async fn vault_box_sync(vault: String, pull: Option<bool>) -> Result<box_sync::BoxSyncReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if pull.unwrap_or(false) {
            box_sync::box_pull_cycle(&vault)
        } else {
            box_sync::box_sync_cycle(&vault)
        }
    })
        .await
        .map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct BoxConfigOut {
    #[serde(rename = "box")]
    box_url: String,
    vault: String,
    name: Option<String>,
    branch: String,
    project: bool,
}

/// The box this vault syncs with, from `.vault-chat/sync.json` or, for a repo in the vault-chat folder, the
/// folder's own file (None = old mode).
#[tauri::command]
async fn vault_box_config(vault: String) -> Option<BoxConfigOut> {
    tauri::async_runtime::spawn_blocking(move || {
        box_sync::box_config(&vault).map(|c| BoxConfigOut { box_url: c.box_url, vault: c.vault, name: c.name, branch: c.branch, project: c.project })
    })
    .await
    .ok()
    .flatten()
}

/// A repo in the vault-chat folder (master.rs): made here, synced with the box's hub at `remote_url`.
#[tauri::command]
async fn master_repo_init(dest: String, remote_url: String, branch: String, origin_url: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || master::repo_init(&dest, &remote_url, &branch, origin_url.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

/// The migration's copy (master.rs): a repo copied whole into the vault-chat folder, then verified.
#[tauri::command]
async fn master_copy_repo(from: String, to: String) -> Result<master::CopyCheck, String> {
    tauri::async_runtime::spawn_blocking(move || master::copy_repo(&from, &to))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn master_verify_copy(from: String, to: String) -> Result<master::CopyCheck, String> {
    tauri::async_runtime::spawn_blocking(move || master::verify_copy(&from, &to))
        .await
        .map_err(|e| e.to_string())
}

/// Settings → Box: the tailnet machines that answer as a vault-chat server.
#[tauri::command]
async fn box_discover() -> Result<Vec<box_sync::FoundBox>, String> {
    tauri::async_runtime::spawn_blocking(box_sync::discover_boxes)
        .await
        .map_err(|e| e.to_string())?
}

/// After a box request failed: is this machine on the tailnet at all? One
/// `tailscale status --json` run; never on a timer.
#[tauri::command]
async fn tailscale_check() -> Result<box_sync::TailscaleState, String> {
    tauri::async_runtime::spawn_blocking(box_sync::tailscale_check)
        .await
        .map_err(|e| e.to_string())
}

/// The sync chip's "Open Tailscale" (Windows, macOS).
#[tauri::command]
async fn tailscale_open() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(box_sync::open_tailscale)
        .await
        .map_err(|e| e.to_string())?
}

/// Settings → Box: this vault syncs with (and chats on) `box_url` from now on.
/// The frontend restarts its sync loop, whose first cycle pushes master.
#[tauri::command]
async fn vault_box_connect(vault: String, box_url: String, box_vault: String, name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || box_sync::connect_box(&vault, &box_url, &box_vault, &name))
        .await
        .map_err(|e| e.to_string())?
}

/// Settings → Box: back to this laptop (the box keeps its copy).
#[tauri::command]
async fn vault_box_disconnect(vault: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || box_sync::disconnect_box(&vault))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
struct PostResult {
    status: u16,
    body: String,
}

/// POST JSON to the box (relay, alerts). Done natively so the webview's CORS
/// rules never get in the way.
#[tauri::command]
async fn box_post_json(url: String, body: String, token: Option<String>) -> Result<PostResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        box_sync::post_json(&url, &body, token.as_deref()).map(|(status, body)| PostResult { status, body })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// GET from the box (the chat's `/conversations`, `/conversation`, `/poll`,
/// `/status`). Native for the same CORS reason as `box_post_json`; the timeout
/// covers `/poll`'s 25 s long-poll.
#[tauri::command]
async fn box_get_json(url: String, token: Option<String>, timeout_ms: Option<u64>) -> Result<PostResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        box_sync::get_json(&url, token.as_deref(), timeout_ms.unwrap_or(20_000))
            .map(|(status, body)| PostResult { status, body })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The mission zone: paths only the mission host may author. A follower resets
/// these to origin before every commit, so no follower push can carry a
/// mission-state change (proven by the two-checkout scratch test: the box's
/// DONE meta survives, chats union both ways, docs flow).
const MISSION_ZONE_PATHS: &[&str] = &[
    ".vault-chat/supervisor",
    ".vault-chat/selftest",
    ".vault-chat/schedules.jsonl",
    ".vault-chat/notifications.jsonl",
    ".vault-chat/jobs.jsonl",
];

/// Does this conversation file belong to the mission zone? Mission, worker and
/// ask threads are host-owned (their state is live execution state); the user's
/// own chats (phone/manual/voice/scheduled) are content and sync freely. Reads
/// the meta line's `"source"` field from the given file CONTENT.
fn conv_is_mission_zone(head_line: &str) -> bool {
    for tag in ["\"source\":\"mission\"", "\"source\":\"worker\"", "\"source\":\"ask\""] {
        if head_line.contains(tag) {
            return true;
        }
    }
    false
}

/// Reset every mission-zone path to origin/<branch>'s version in a follower's
/// index + working tree. Committed-but-unpushed divergence dies here too: the
/// sanitized commit's TIP matches origin for the zone, so the eventual merge
/// carries no mission-state change from this machine (the 153-commits-ahead
/// migration case). Uses the last-fetched origin ref — no network; the pull
/// loop keeps it fresh. Local-only files (present here, absent on origin) are
/// left alone: with no origin counterpart they can't clobber anything.
fn sanitize_mission_zone(vault: &str, branch: &str) {
    let origin = format!("origin/{}", branch);
    // Origin must exist (a vault with no remote / never-fetched ref: nothing to
    // sanitize against — and nothing to push to either).
    let (_, _, c) = run_git(vault, &["rev-parse", "--verify", "--quiet", &origin]).unwrap_or_default();
    if c != 0 {
        return;
    }
    for p in MISSION_ZONE_PATHS {
        // Only paths origin knows; checkout fails harmlessly otherwise.
        let _ = run_git_mut(vault, &["checkout", &origin, "--", p]);
    }
    // Conversations: classify by the meta line, local version first, origin's
    // as fallback (a file deleted locally still needs restoring if origin says
    // it's a mission thread).
    let (ls, _, lc) = run_git(vault, &["ls-tree", "-r", "--name-only", &origin, ".vault-chat/conversations"]).unwrap_or_default();
    if lc != 0 {
        return;
    }
    for path in ls.lines().map(str::trim).filter(|l| l.ends_with(".jsonl")) {
        let local_head = std::fs::File::open(format!("{}/{}", vault, path))
            .ok()
            .and_then(|f| {
                use std::io::BufRead;
                std::io::BufReader::new(f).lines().next().and_then(|r| r.ok())
            })
            .unwrap_or_default();
        let zone = if !local_head.is_empty() {
            conv_is_mission_zone(&local_head)
        } else {
            run_git(vault, &["show", &format!("{}:{}", origin, path)])
                .ok()
                .map(|(o, _, c)| c == 0 && conv_is_mission_zone(o.lines().next().unwrap_or("")))
                .unwrap_or(false)
        };
        if zone {
            let _ = run_git_mut(vault, &["checkout", &origin, "--", path]);
        }
    }
}

#[tauri::command]
async fn vault_sync_push(vault: String) -> Result<SyncOpResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_repo_lock(&vault, || {
        // A follower is a CONTENT writer now: its commits are sanitized (the
        // mission zone matches origin, see vault_sync_commit_local), so its
        // pushes carry docs/notes/chats and can never re-introduce the stale
        // mission-state clobber the old pull-only gate existed for. Self-heal
        // the disabling push URL that gate installed.
        if is_sync_follower(&vault) {
            if let Ok((purl, _, 0)) = run_git(&vault, &["remote", "get-url", "--push", "origin"]) {
                if purl.trim().starts_with("DISABLED") {
                    if let Ok((furl, _, 0)) = run_git(&vault, &["remote", "get-url", "origin"]) {
                        let furl = furl.trim().to_string();
                        let _ = run_git_mut(&vault, &["remote", "set-url", "--push", "origin", &furl]);
                    }
                }
            }
        }
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
            // The push was rejected — almost always because the remote advanced
            // under us (the always-on box committed while this follower was
            // mid-cycle). Reconcile inline and retry ONCE so a diverged follower
            // self-heals on this same push, instead of looping commit→push-fail
            // until a separate pull tick happens to win the single-flight race —
            // which a busy box can starve indefinitely (the wedge that froze
            // cross-machine sync). If the rejection isn't a divergence
            // (auth/network), the fetch or the retry fails and we surface the
            // original error.
            let (_, _, fcode) = run_git(&vault, &["fetch", "origin", &branch])?;
            if fcode != 0 {
                return Ok(SyncOpResult {
                    ok: false,
                    message: format!("push failed: {}", first_line(&stderr).trim()),
                    error: true,
                });
            }
            match reconcile_with_upstream(&vault, &branch)? {
                Ok(_) => {
                    maybe_update_submodules(&vault);
                    let (_, stderr2, push_code2) =
                        run_git(&vault, &["push", "-u", "origin", &branch])?;
                    if push_code2 != 0 {
                        return Ok(SyncOpResult {
                            ok: false,
                            message: format!(
                                "push failed after merge: {}",
                                first_line(&stderr2).trim()
                            ),
                            error: true,
                        });
                    }
                    return Ok(SyncOpResult {
                        ok: true,
                        message: "merged + pushed".into(),
                        error: false,
                    });
                }
                Err(e) => return Ok(e),
            }
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

// ----- keychain (API key secure storage) -----
//
// API keys and service credentials live in the OS keychain instead of
// localStorage. On Windows this hits Credential Manager, on Mac the
// Keychain, on Linux libsecret (via dbus). The agent's file-op tools
// can't reach these — they live outside any vault.

const KEYCHAIN_SERVICE: &str = "com.vault-chat.app";

/// Whether the OS keyring can actually serve secrets on THIS machine, probed
/// once and cached for the process. The motivating failure: a headless Linux box
/// often has the D-Bus Secret Service either absent OR present-but-LOCKED. A
/// locked collection doesn't error — `set_password` blocks on an unlock prompt
/// that nothing ever answers, hanging the call and any UI awaiting it. That's why
/// the server's "Save" went dead with no message and keys silently vanished:
/// the call never returned, so the error-triggered file fallback never ran.
/// The keyring crate exposes no timeout, so we probe in a throwaway thread with a
/// bounded wait — write+delete a sentinel. A healthy keyring completes instantly;
/// a missing backend errors fast; a locked one blocks past the timeout. Anything
/// but a clean, fast success → treat the keyring as unusable for the rest of the
/// process and route every secret to the encrypted file fallback. Linux-only: the
/// native Windows/macOS backends never block, so they always report usable (no
/// probe, no sentinel write).
fn keyring_usable() -> bool {
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
    #[cfg(target_os = "linux")]
    {
        static STATE: OnceLock<bool> = OnceLock::new();
        *STATE.get_or_init(|| {
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                // Probe with a real write — the op that hangs on a locked keyring.
                // (A read-miss returns NoEntry fast even when locked, so a read
                // wouldn't reveal the block.)
                let ok = keyring::Entry::new(KEYCHAIN_SERVICE, "__vaultchat_probe__")
                    .and_then(|e| e.set_password("probe"))
                    .is_ok();
                if ok {
                    let _ = keyring::Entry::new(KEYCHAIN_SERVICE, "__vaultchat_probe__")
                        .and_then(|e| e.delete_credential());
                }
                let _ = tx.send(ok);
            });
            match rx.recv_timeout(Duration::from_secs(3)) {
                Ok(v) => v,
                Err(_) => false, // blocked past the timeout (locked) or thread died
            }
        })
    }
}

#[tauri::command]
async fn keychain_get(key: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Use the keyring only if it's actually usable on this machine; otherwise
        // (headless/locked) go straight to the file store. On a keyring miss we
        // still consult the file, so a key written to the fallback while the
        // keyring was down is found even if the keyring later comes back.
        if keyring_usable() {
            if let Ok(p) =
                keyring::Entry::new(KEYCHAIN_SERVICE, &key).and_then(|e| e.get_password())
            {
                return Ok(Some(p));
            }
        }
        Ok(fallback_secret_get(&key))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn keychain_set(key: String, value: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if keyring_usable() {
            if keyring::Entry::new(KEYCHAIN_SERVICE, &key)
                .and_then(|e| e.set_password(&value))
                .is_ok()
            {
                // Keyring is the source of truth when it works — drop any stale
                // fallback copy so the two can't diverge.
                let _ = fallback_secret_remove(&key);
                return Ok(());
            }
        }
        // Keyring unavailable (the headless-box case): persist to the encrypted
        // file fallback instead of throwing or hanging — that's the bug where the
        // Settings "save" silently failed and keys vanished on reload.
        fallback_secret_set(&key, &value)
            .map_err(|fe| format!("secret storage unavailable; file fallback also failed: {fe}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn keychain_delete(key: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Best-effort on both stores; absence in either is success.
        if keyring_usable() {
            if let Ok(entry) = keyring::Entry::new(KEYCHAIN_SERVICE, &key) {
                let _ = entry.delete_credential();
            }
        }
        let _ = fallback_secret_remove(&key);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ----- headless-Linux secret fallback -----
//
// The keyring crate uses the D-Bus Secret Service on Linux. A headless box
// (no graphical login, or a locked/absent keyring) has none, so every keychain
// op errors: reads look like "no keys" and writes throw — which is exactly how
// the always-on Linux server lost its API keys and the Settings "save" button
// stopped persisting. `gh` hits the same wall and falls back to a plaintext
// file; we do the same but ENCRYPTED at rest. The OS keyring stays primary on
// every platform — this file is consulted only when the keyring can't serve the
// value. Lives in the machine's OS config dir, OUTSIDE any vault, so it never
// git-syncs to another box and the agent's vault-scoped file tools can't read it.

/// Machine-local directory for app secrets that must not live in a vault.
fn fallback_secret_dir() -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
            .map(|b| b.join("vault-chat"))
    }
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME").map(|h| {
            PathBuf::from(h)
                .join("Library")
                .join("Application Support")
                .join("vault-chat")
        })
    }
    #[cfg(windows)]
    {
        std::env::var_os("APPDATA").map(|b| PathBuf::from(b).join("vault-chat"))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    {
        None
    }
}

/// Tighten a file to owner-only (0600) on Unix; no-op elsewhere. Both the
/// secrets blob and its key file get this so a stray reader on the box can't
/// scoop them.
fn restrict_to_owner(path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

/// The passphrase that encrypts the fallback blob: a 256-bit random value
/// generated once and kept in an adjacent 0600 file — so the blob is encrypted
/// at rest rather than sitting in plaintext like `gh`'s fallback. (Not a defence
/// against someone who can already read the user's files on the box; it stops
/// casual exposure via backups, screen-shares, or an accidental copy.)
fn fallback_secret_passphrase() -> Result<String, String> {
    let dir = fallback_secret_dir().ok_or("no machine config dir for secret fallback")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let key_path = dir.join("fallback.key");
    if let Ok(existing) = std::fs::read_to_string(&key_path) {
        let t = existing.trim();
        if !t.is_empty() {
            return Ok(t.to_string());
        }
    }
    let mut raw = [0u8; 32];
    getrandom::getrandom(&mut raw).map_err(|e| format!("rng: {e}"))?;
    use base64::Engine;
    let pass = base64::engine::general_purpose::STANDARD.encode(raw);
    std::fs::write(&key_path, &pass).map_err(|e| e.to_string())?;
    restrict_to_owner(&key_path);
    Ok(pass)
}

fn fallback_secret_path() -> Option<PathBuf> {
    fallback_secret_dir().map(|d| d.join("secrets.age"))
}

fn fallback_secret_load() -> HashMap<String, String> {
    let Some(path) = fallback_secret_path() else {
        return HashMap::new();
    };
    let Ok(blob) = std::fs::read_to_string(&path) else {
        return HashMap::new();
    };
    let Ok(pass) = fallback_secret_passphrase() else {
        return HashMap::new();
    };
    match keystore_decrypt_bytes(&pass, blob.trim()) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

fn fallback_secret_store(map: &HashMap<String, String>) -> Result<(), String> {
    let dir = fallback_secret_dir().ok_or("no machine config dir for secret fallback")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let pass = fallback_secret_passphrase()?;
    let plaintext = serde_json::to_vec(map).map_err(|e| e.to_string())?;
    let blob = keystore_encrypt_bytes(&pass, &plaintext)?;
    let path = dir.join("secrets.age");
    std::fs::write(&path, blob).map_err(|e| e.to_string())?;
    restrict_to_owner(&path);
    Ok(())
}

fn fallback_secret_get(key: &str) -> Option<String> {
    fallback_secret_load().get(key).cloned()
}

fn fallback_secret_set(key: &str, value: &str) -> Result<(), String> {
    let mut map = fallback_secret_load();
    map.insert(key.to_string(), value.to_string());
    fallback_secret_store(&map)
}

fn fallback_secret_remove(key: &str) -> Result<(), String> {
    let mut map = fallback_secret_load();
    if map.remove(key).is_some() {
        fallback_secret_store(&map)?;
    }
    Ok(())
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
mod git_serial_tests {
    use super::{git_is_network_only, git_subcommand, run_git, with_repo_lock};
    use std::time::{Duration, Instant};

    #[test]
    fn subcommand_skips_config_overrides() {
        assert_eq!(git_subcommand(&["-c", "user.name=x", "-c", "user.email=y", "commit", "-q"]), "commit");
        assert!(git_is_network_only(&["-c", "credential.interactive=false", "fetch", "box"]));
        assert!(git_is_network_only(&["push", "--porcelain", "box", "refs/heads/master:refs/heads/master"]));
        assert!(!git_is_network_only(&["status", "--porcelain"]));
        assert!(!git_is_network_only(&["commit", "-m", "fetch"]));
    }

    /// A read waits for a writer holding the repo lock (never overlaps it); a
    /// git run inside the lock does not deadlock on its own lock.
    #[test]
    fn git_in_a_repo_waits_for_the_repo_lock() {
        let dir = std::env::temp_dir().join(format!("vc-git-serial-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let d = dir.to_string_lossy().to_string();
        assert_eq!(run_git(&d, &["init", "-q"]).unwrap().2, 0);
        let (tx, rx) = std::sync::mpsc::channel();
        let d2 = d.clone();
        let writer = std::thread::spawn(move || {
            with_repo_lock(&d2, || {
                // Inside the lock: git runs (no second lock taken).
                assert_eq!(run_git(&d2, &["status", "--porcelain"]).unwrap().2, 0);
                tx.send(Instant::now()).unwrap();
                std::thread::sleep(Duration::from_millis(400));
                Instant::now()
            })
        });
        let held_at = rx.recv().unwrap();
        assert_eq!(run_git(&d, &["status", "--porcelain"]).unwrap().2, 0);
        let read_done = Instant::now();
        let released = writer.join().unwrap();
        assert!(read_done >= released, "the read ran while the writer held the lock");
        assert!(read_done.duration_since(held_at) >= Duration::from_millis(390));
        let _ = std::fs::remove_dir_all(&dir);
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

#[cfg(test)]
mod sync_role_tests {
    use super::{conv_is_mission_zone, is_sync_follower, run_git, run_git_mut, sanitize_mission_zone};

    // The follower sanitize pass, end to end on real repos: a diverged
    // follower's mission-zone files reset to origin's version (stale mission
    // meta, injected steer, and stale supervisor state all die) while its
    // CONTENT divergence (own chat lines, docs) survives to be pushed. This is
    // the in-code twin of the two-checkout scratch proof.
    #[test]
    fn sanitize_resets_mission_zone_to_origin_and_keeps_content() {
        let base = std::env::temp_dir().join(format!("vc_sanitize_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let origin = base.join("origin.git");
        let a = base.join("A");
        let b = base.join("B");
        std::fs::create_dir_all(&origin).unwrap();
        let og = origin.to_str().unwrap();
        run_git(og, &["init", "-q", "--bare", "-b", "master"]).unwrap();
        for d in [&a, &b] {
            std::fs::create_dir_all(d).unwrap();
            let ds = d.to_str().unwrap();
            run_git(ds, &["init", "-q", "-b", "master"]).unwrap();
            run_git(ds, &["config", "user.email", "t@t"]).unwrap();
            run_git(ds, &["config", "user.name", "t"]).unwrap();
            run_git(ds, &["remote", "add", "origin", og]).unwrap();
        }
        let asr = a.to_str().unwrap();
        let bs = b.to_str().unwrap();
        // Seed from A (the box).
        std::fs::create_dir_all(a.join(".vault-chat/conversations")).unwrap();
        std::fs::create_dir_all(a.join(".vault-chat/supervisor")).unwrap();
        std::fs::write(
            a.join(".vault-chat/conversations/m1.jsonl"),
            "{\"id\":\"m1\",\"source\":\"mission\",\"missionState\":\"DONE\"}\n{\"role\":\"assistant\",\"content\":\"box turn\"}\n",
        )
        .unwrap();
        std::fs::write(
            a.join(".vault-chat/conversations/chat1.jsonl"),
            "{\"id\":\"chat1\",\"source\":\"phone\"}\n{\"role\":\"user\",\"content\":\"hello\"}\n",
        )
        .unwrap();
        std::fs::write(a.join(".vault-chat/supervisor/mind.md"), "epoch 17\n").unwrap();
        std::fs::write(a.join("note.md"), "original\n").unwrap();
        run_git_mut(asr, &["add", "-A"]).unwrap();
        run_git_mut(asr, &["commit", "-q", "-m", "seed"]).unwrap();
        run_git_mut(asr, &["push", "-q", "origin", "master"]).unwrap();
        // B pulls, then diverges: stale mission write + supervisor write
        // (zone) AND a chat append + doc edit (content).
        run_git_mut(bs, &["pull", "-q", "origin", "master"]).unwrap();
        std::fs::write(
            b.join(".vault-chat/conversations/m1.jsonl"),
            "{\"id\":\"m1\",\"source\":\"mission\",\"missionState\":\"RUNNING\",\"surfaced\":true}\n{\"role\":\"assistant\",\"content\":\"box turn\"}\n{\"role\":\"user\",\"content\":\"laptop stale steer\"}\n",
        )
        .unwrap();
        std::fs::write(b.join(".vault-chat/supervisor/mind.md"), "epoch 15 STALE\n").unwrap();
        let mut chat = std::fs::read_to_string(b.join(".vault-chat/conversations/chat1.jsonl")).unwrap();
        chat.push_str("{\"role\":\"user\",\"content\":\"laptop chat line\"}\n");
        std::fs::write(b.join(".vault-chat/conversations/chat1.jsonl"), chat).unwrap();
        std::fs::write(b.join("note.md"), "original\nlaptop edit\n").unwrap();
        run_git_mut(bs, &["add", "-A"]).unwrap();
        run_git_mut(bs, &["commit", "-q", "-m", "laptop divergence"]).unwrap();
        // Sanitize against the last-fetched origin.
        run_git(bs, &["fetch", "-q", "origin", "master"]).unwrap();
        sanitize_mission_zone(bs, "master");
        let m1 = std::fs::read_to_string(b.join(".vault-chat/conversations/m1.jsonl")).unwrap();
        assert!(m1.contains("\"missionState\":\"DONE\""), "mission meta must be origin's");
        assert!(!m1.contains("laptop stale steer"), "laptop mission write must die");
        let mind = std::fs::read_to_string(b.join(".vault-chat/supervisor/mind.md")).unwrap();
        assert!(mind.contains("epoch 17") && !mind.contains("STALE"), "supervisor state must be origin's");
        let chat = std::fs::read_to_string(b.join(".vault-chat/conversations/chat1.jsonl")).unwrap();
        assert!(chat.contains("laptop chat line"), "own chat content must survive");
        let note = std::fs::read_to_string(b.join("note.md")).unwrap();
        assert!(note.contains("laptop edit"), "doc content must survive");
        let _ = std::fs::remove_dir_all(&base);
    }

    // Mission/worker/ask threads are host-owned (execution state); the user's
    // own chats are content and must NOT be sanitized away on a follower.
    #[test]
    fn mission_zone_conversation_classifier() {
        assert!(conv_is_mission_zone(r#"{"id":"m1","source":"mission","missionState":"RUNNING"}"#));
        assert!(conv_is_mission_zone(r#"{"id":"w1","source":"worker"}"#));
        assert!(conv_is_mission_zone(r#"{"id":"a1","source":"ask","askOf":"m1"}"#));
        assert!(!conv_is_mission_zone(r#"{"id":"c1","source":"phone","role":"supervisor"}"#));
        assert!(!conv_is_mission_zone(r#"{"id":"c2","source":"manual"}"#));
        assert!(!conv_is_mission_zone(r#"{"id":"c3","source":"voice"}"#));
    }

    // The role marker: a follower is a CONTENT writer whose commits are
    // sanitized against origin's mission zone before every push (the surgical
    // replacement for the old pull-only gate — the phase-16→15 clobber can't
    // recur because a follower commit's tip never diffs the zone). Default
    // (no marker) MUST stay a writer so the active box is unaffected.
    #[test]
    fn follower_marker_gates_push_and_writer_is_default() {
        let base = std::env::temp_dir().join(format!("vc_sync_role_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let d = base.to_str().unwrap();
        // Real repo so `rev-parse --absolute-git-dir` resolves the marker's home.
        run_git(d, &["init", "-q"]).expect("git init");
        let git_dir = run_git(d, &["rev-parse", "--absolute-git-dir"])
            .unwrap()
            .0
            .trim()
            .to_string();
        let marker = format!("{}/vault-chat-sync-role", git_dir);

        // Absent marker → writer (the box's default; must be unaffected).
        assert!(!is_sync_follower(d), "absent marker must read as writer");
        // Explicit writer → writer.
        std::fs::write(&marker, "writer\n").unwrap();
        assert!(!is_sync_follower(d), "writer marker must read as writer");
        // Follower, tolerant of case + surrounding whitespace → follower.
        std::fs::write(&marker, "  Follower \n").unwrap();
        assert!(is_sync_follower(d), "follower marker must gate the push");

        let _ = std::fs::remove_dir_all(&base);
    }
}

#[cfg(test)]
mod conversation_jsonl_tests {
    use super::reconstruct_conversation;

    #[test]
    fn keeps_every_message_and_picks_fresh_meta() {
        // Two "hi" messages — which is a legitimately repeated message, NOT to be
        // collapsed (we can't tell a real repeat from a union artifact, so we
        // keep both: never lose real data). An older meta line lingers and must
        // lose to the fresher one.
        let body = "{\"id\":\"abc\",\"title\":\"T\",\"lastActivityAt\":100}\n\
                    {\"role\":\"user\",\"content\":\"hi\"}\n\
                    {\"role\":\"assistant\",\"content\":\"hello\"}\n\
                    {\"role\":\"user\",\"content\":\"hi\"}\n\
                    {\"id\":\"abc\",\"title\":\"T-old\",\"lastActivityAt\":50}\n";
        let out = reconstruct_conversation(body).expect("reconstruct");
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v.get("title").and_then(|x| x.as_str()), Some("T")); // fresh meta wins
        let msgs = v.get("messages").unwrap().as_array().unwrap();
        assert_eq!(msgs.len(), 3); // every message kept — no content de-dup
    }

    #[test]
    fn both_machines_messages_survive_a_union() {
        // The whole point: two machines each appended a distinct message to the
        // same conversation. A union keeps both lines; neither is lost.
        let body = "{\"id\":\"x\",\"lastActivityAt\":10}\n\
                    {\"role\":\"user\",\"content\":\"shared\"}\n\
                    {\"role\":\"assistant\",\"content\":\"from-box\"}\n\
                    {\"role\":\"assistant\",\"content\":\"from-laptop\"}\n";
        let out = reconstruct_conversation(body).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v.get("messages").unwrap().as_array().unwrap().len(), 3);
    }

    #[test]
    fn empty_or_metaless_body_is_none() {
        assert!(reconstruct_conversation("").is_none());
        assert!(reconstruct_conversation("{\"role\":\"user\",\"content\":\"orphan\"}\n").is_none());
    }

    #[test]
    fn completed_mission_survives_a_staler_running_line() {
        // Regression: a finished mission (DONE + completedAt) reappeared on the
        // Activity board because a stray post-completion RUNNING wake re-stamped a
        // NEWER lastActivityAt and won the freshness race. Terminal state must win
        // regardless of lastActivityAt — order-independent, both directions.
        let running_first = "{\"id\":\"m\",\"missionState\":\"RUNNING\",\"lastActivityAt\":200}\n\
                             {\"role\":\"user\",\"content\":\"go\"}\n\
                             {\"id\":\"m\",\"missionState\":\"DONE\",\"completedAt\":150,\"lastActivityAt\":150}\n";
        let done_first = "{\"id\":\"m\",\"missionState\":\"DONE\",\"completedAt\":150,\"lastActivityAt\":150}\n\
                          {\"role\":\"user\",\"content\":\"go\"}\n\
                          {\"id\":\"m\",\"missionState\":\"RUNNING\",\"lastActivityAt\":200}\n";
        for body in [running_first, done_first] {
            let out = reconstruct_conversation(body).unwrap();
            let v: serde_json::Value = serde_json::from_str(&out).unwrap();
            assert_eq!(v.get("missionState").and_then(|x| x.as_str()), Some("DONE"));
            assert_eq!(v.get("completedAt").and_then(|x| x.as_i64()), Some(150));
        }
    }

    #[test]
    fn between_two_running_lines_freshest_wins() {
        // Non-terminal vs non-terminal keeps the original freshest-lastActivityAt
        // rule intact.
        let body = "{\"id\":\"m\",\"missionState\":\"RUNNING\",\"lastActivityAt\":100}\n\
                    {\"id\":\"m\",\"missionState\":\"RUNNING\",\"lastActivityAt\":300}\n\
                    {\"id\":\"m\",\"missionState\":\"RUNNING\",\"lastActivityAt\":200}\n";
        let out = reconstruct_conversation(body).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v.get("lastActivityAt").and_then(|x| x.as_i64()), Some(300));
    }

    #[test]
    fn adjacent_same_role_twins_collapse_nonadjacent_survive() {
        // Two ADJACENT identical user lines = a union/double-append artifact ->
        // collapse to one. A later identical "dup" separated by an assistant turn
        // is a legitimate repeat -> kept.
        let body = "{\"id\":\"z\",\"lastActivityAt\":1}\n\
                    {\"role\":\"user\",\"content\":\"dup\"}\n\
                    {\"role\":\"user\",\"content\":\"dup\"}\n\
                    {\"role\":\"assistant\",\"content\":\"ok\"}\n\
                    {\"role\":\"user\",\"content\":\"dup\"}\n";
        let out = reconstruct_conversation(body).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v.get("messages").unwrap().as_array().unwrap().len(), 3);
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

const DEFAULT_VOICE_MD: &str = include_str!("../defaults/voice.md");
/// The bundled default voice-mode prompt. New vaults seed
/// `<vault>/.vault-chat/agent/voice.md` from this.
#[tauri::command]
fn default_voice_prompt() -> String {
    DEFAULT_VOICE_MD.to_string()
}

// ----- run_script -----
//
// Executes a vault-tool script (Python / Node / bash / etc.). The
// script receives its input on stdin as JSON and is expected to write
// its output to stdout (JSON or plain text — caller decides).

#[tauri::command]
async fn path_exists(path: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || std::path::Path::new(&path).exists())
        .await
        .unwrap_or(false)
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

// ----- phone voice mode: embedded HTTP server (see voice_server.rs) -----
// Inert until the frontend opts in by calling voice_server_start with a
// freshly-generated token. Stage 1 surfaces only start/stop/status.

#[tauri::command]
async fn voice_server_start(app: tauri::AppHandle, port: u16, token: String) -> Result<u16, String> {
    // Hand the server the app handle so it can relay phone tool calls to the
    // running app's real handlers (full parity with desktop voice).
    voice_server::set_app(app);
    tauri::async_runtime::spawn_blocking(move || voice_server::start(port, token))
        .await
        .map_err(|e| e.to_string())?
}

/// The desktop app's answer to a relayed phone tool call (voice_server::run_tool).
#[tauri::command]
fn voice_tool_respond(req_id: String, result: String) {
    voice_server::tool_respond(req_id, result);
}

#[tauri::command]
fn voice_server_stop() -> Result<(), String> {
    voice_server::stop();
    Ok(())
}

#[tauri::command]
fn voice_server_status() -> bool {
    voice_server::is_running()
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
fn voice_set_context(
    el_key: String,
    agent_id: String,
    voice_id: String,
    system_prompt: String,
    dynamic_vars: serde_json::Value,
    tool_names: Vec<String>,
    vault: String,
) {
    voice_server::set_context(
        el_key,
        agent_id,
        voice_id,
        system_prompt,
        dynamic_vars,
        tool_names,
        vault,
    );
}

/// Best-effort phone link base for the Settings note. Prefers the secure
/// Tailscale **HTTPS** URL (the one a phone's mic will accept); falls back to the
/// http IP (localhost-only). The frontend appends `/voice?token=…`.
///
/// Two or three `tailscale` CLI runs (`serve --bg`, `status`, maybe `ip`), each
/// 0.7-6 s here, on every launch: on the main thread they were the "Not
/// responding" window.
#[tauri::command]
async fn voice_server_url(port: u16) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        voice_server::https_url(port).or_else(|| voice_server::tailscale_url(port))
    })
    .await
    .ok()
    .flatten()
}

// ----- phone chat PWA: SSE broadcast + Web Push plumbing -----
// The heavy lifting (RFC 8291 payload encryption, VAPID JWT) happens in the
// webview with WebCrypto; Rust only stores subscriptions, fans events out to
// the phone's SSE stream, and performs the raw push POST.

/// Frontend → phone SSE clients: forward one JSON event line.
#[tauri::command]
fn phone_broadcast(json: String) {
    voice_server::broadcast_event(json);
}

/// Frontend hands over its VAPID public key (base64url raw P-256 point) so the
/// phone page can subscribe with it.
#[tauri::command]
fn phone_set_vapid(key: String) {
    voice_server::set_vapid_pub(key);
}

/// Stored Web Push subscriptions (JSON array string).
#[tauri::command]
async fn phone_push_subs() -> String {
    tauri::async_runtime::spawn_blocking(voice_server::push_subs_list)
        .await
        .unwrap_or_else(|_| "[]".into())
}

/// Drop a dead subscription (push endpoint answered 404/410).
#[tauri::command]
async fn phone_push_unsub(endpoint: String) {
    let _ = tauri::async_runtime::spawn_blocking(move || voice_server::push_subs_remove(&endpoint)).await;
}

/// Append one notification line to <vault>/.vault-chat/notifications.jsonl —
/// the agent→you feed behind the phone app's Alerts tab.
#[tauri::command]
async fn notification_add(vault: String, json: String) {
    // One append at a time, as when this ran on the main thread.
    static APPEND: Mutex<()> = Mutex::new(());
    let _ = tauri::async_runtime::spawn_blocking(move || {
        let _g = APPEND.lock().unwrap_or_else(|e| e.into_inner());
        voice_server::notification_append(&vault, &json);
    })
    .await;
}

/// Raw Web Push delivery: POST the webview-encrypted body to the push service.
/// Returns the HTTP status so the caller can prune dead subscriptions.
#[tauri::command]
async fn push_post(
    endpoint: String,
    headers: Vec<(String, String)>,
    body_b64: String,
) -> Result<u16, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine as _;
        let body = base64::engine::general_purpose::STANDARD
            .decode(body_b64)
            .map_err(|e| e.to_string())?;
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .map_err(|e| e.to_string())?;
        let mut r = client.post(&endpoint);
        for (k, v) in &headers {
            r = r.header(k.as_str(), v.as_str());
        }
        let resp = r.body(body).send().map_err(|e| e.to_string())?;
        Ok(resp.status().as_u16())
    })
    .await
    .map_err(|e| e.to_string())?
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

// "Run in background" gate. When on, closing the main window hides it to the
// tray instead of quitting, so the renderer (scheduler loop + supervisor
// wakes) keeps running. Machine-local: the frontend pushes the user's
// localStorage preference here at boot via `set_run_in_background`. Default
// off so the app quits on close exactly as before until the user opts in.
struct RunInBackground(AtomicBool);

#[tauri::command]
fn set_run_in_background(state: tauri::State<'_, RunInBackground>, enabled: bool) {
    state.0.store(enabled, Ordering::Relaxed);
}

// Bring the main window back from the tray: show, unminimize, focus. Used by
// the tray's left-click and "Show" menu item.
fn show_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Startup timing for the app log: process uptime + main-thread stalls (boot_watch.rs).
#[tauri::command]
async fn boot_timing() -> boot_watch::BootTiming {
    boot_watch::timing()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    boot_watch::mark_process_start();
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
        // FIRST plugin, per the single-instance docs: a second launch (user
        // double-click while one sits in the tray, updater overlap, etc.)
        // exits immediately and focuses the existing window instead of racing
        // it for the embedded server port, the scheduler, and git sync. The
        // port race is exactly how "voice broke": the loser's voice/phone
        // server died at bind (os error 10048) and stayed dead all session.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(RunInBackground(AtomicBool::new(false)))
        // A vault HTML page's own files (audio, video, images, fonts, data),
        // relative to its folder, for HtmlView's sandboxed iframe: the open
        // vault only (vault_page.rs).
        .register_asynchronous_uri_scheme_protocol(vault_page::SCHEME, |_ctx, request, responder| {
            std::thread::spawn(move || responder.respond(vault_page::respond(&request)));
        })
        .on_window_event(|window, event| {
            // Close-to-tray: when "run in background" is on, intercept the
            // main window's close and hide it instead of letting the app
            // exit, so the daemon (scheduler + supervisor) keeps running.
            // Only the main window — popouts close normally. The tray "Quit"
            // item calls app.exit(0), which bypasses this entirely.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    use tauri::Manager;
                    let on = window
                        .app_handle()
                        .state::<RunInBackground>()
                        .0
                        .load(Ordering::Relaxed);
                    if on {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
            }
        })
        .setup(|app| {
            use tauri::Manager;

            // Time every main-thread stall in the first minutes (app-log.txt's
            // boot summary) — a blocked main thread is what Windows calls
            // "Not responding".
            {
                let h = app.handle().clone();
                boot_watch::watch_main_thread(move |f| h.run_on_main_thread(f).is_ok());
            }

            // System tray: the daemon's handle when its window is hidden.
            // Left-click reopens the window; the menu offers Show / Quit
            // (Quit is the only path that actually exits when running in
            // the background).
            //
            // Tray creation must NEVER be fatal. On a headless box (no tray
            // host / StatusNotifier on the bus) this can error, and a `?`
            // escaping setup() would brick the whole app at boot — scheduler,
            // phone server, sync and all — on exactly the machine daemon mode
            // is for. Without a tray the only loss is the reopen affordance,
            // and run-in-background is opt-in + machine-local anyway.
            {
                use tauri::menu::{Menu, MenuItem};
                use tauri::tray::{
                    MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent,
                };
                let tray_result = (|| -> Result<(), Box<dyn std::error::Error>> {
                    let show_i =
                        MenuItem::with_id(app, "show", "Show vault-chat", true, None::<&str>)?;
                    let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
                    let menu = Menu::with_items(app, &[&show_i, &quit_i])?;
                    let mut builder = TrayIconBuilder::with_id("main")
                        .tooltip("vault-chat")
                        .menu(&menu)
                        .show_menu_on_left_click(false)
                        .on_menu_event(|app, event| match event.id.as_ref() {
                            "show" => show_main_window(app),
                            "quit" => app.exit(0),
                            _ => {}
                        })
                        .on_tray_icon_event(|tray, event| {
                            if let TrayIconEvent::Click {
                                button: MouseButton::Left,
                                button_state: MouseButtonState::Up,
                                ..
                            } = event
                            {
                                show_main_window(tray.app_handle());
                            }
                        });
                    if let Some(icon) = app.default_window_icon() {
                        builder = builder.icon(icon.clone());
                    }
                    builder.build(app)?;
                    Ok(())
                })();
                if let Err(e) = tray_result {
                    eprintln!("[tray] not available, continuing without one: {e}");
                }
            }

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
            vault_page::vault_page_root,
            list_markdown_files,
            read_text_file,
            read_binary_file,
            write_text_file,
            append_debug_log,
            append_sync_log,
            machine_host,
            write_binary_file_unique,
            cleanup_old_captures,
            copy_into_vault,
            delete_file,
            create_dir,
            rename_path,
            prepare_agent_projects,
            glob_files,
            list_dir,
            read_ignore_lines,
            add_to_ignore,
            rename_in_ignore,
            remove_prefix_from_ignore,
            remove_from_ignore,
            notes_read,
            notes_append,
            client_event_append,
            notes_write_all,
            conversation_delete,
            schedule_tombstone_add,
            schedules_read,
            schedules_write_all,
            open_terminal,
            open_box_terminal,
            git_init_if_needed,
            git_commit_all,
            git_repo_root_for_file,
            git_log_subdir,
            git_file_at,
            vault_sync_status,
            vault_sync_set_remote,
            vault_sync_commit_local,
            vault_commit_local,
            vault_sync_pull,
            vault_sync_push,
            vault_sync_gh_create_repo,
            path_exists,
            default_voice_prompt,
            vault_sync_role,
            vault_box_sync,
            vault_box_config,
            master_repo_init,
            master_copy_repo,
            master_verify_copy,
            box_discover,
            tailscale_check,
            tailscale_open,
            vault_box_connect,
            vault_box_disconnect,
            box_post_json,
            box_get_json,
            keychain_get,
            keychain_set,
            keychain_delete,
            keystore_encrypt,
            keystore_decrypt,
            compile_tex,
            agent_audio_play,
            agent_audio_stop,
            voice_server_start,
            phone_broadcast,
            phone_set_vapid,
            phone_push_subs,
            phone_push_unsub,
            notification_add,
            push_post,
            voice_server_stop,
            voice_server_status,
            voice_set_context,
            voice_server_url,
            voice_tool_respond,
            set_run_in_background,
            boot_timing,
            app_ready
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod box_terminal_tests {
    use super::{box_ssh_argv, sh_quote};

    #[test]
    fn ssh_argv_cds_into_the_vault_and_starts_a_login_shell() {
        let a = box_ssh_argv("thinkbox", "carlwilsn", "/home/carlwilsn/vaults/school2").unwrap();
        assert_eq!(
            a,
            vec!["ssh", "-t", "carlwilsn@thinkbox", "cd '/home/carlwilsn/vaults/school2' && exec $SHELL -l"]
        );
        let ip = box_ssh_argv("100.79.81.14", "carl_w.1", "/v").unwrap();
        assert_eq!(ip[2], "carl_w.1@100.79.81.14");
    }

    #[test]
    fn path_is_single_quoted_for_the_box_shell() {
        let a = box_ssh_argv("box", "u", "/v/it's $HOME; rm -rf /`x`").unwrap();
        assert_eq!(a[3], r"cd '/v/it'\''s $HOME; rm -rf /`x`' && exec $SHELL -l");
    }

    #[test]
    fn bad_inputs_are_refused() {
        for (h, u, p) in [
            ("", "u", "/v"),
            ("-oProxyCommand=x", "u", "/v"),
            ("box host", "u", "/v"),
            ("box;x", "u", "/v"),
            ("box", "", "/v"),
            ("box", "-l", "/v"),
            ("box", "u@x", "/v"),
            ("box", "u", "relative/v"),
            ("box", "u", ""),
            ("box", "u", "/v\nrm -rf /"),
        ] {
            assert!(box_ssh_argv(h, u, p).is_err(), "{:?}", (h, u, p));
        }
    }

    #[test]
    fn sh_quote_words() {
        assert_eq!(sh_quote("carl@box"), "carl@box");
        assert_eq!(sh_quote("cd 'a' && x"), r"'cd '\''a'\'' && x'");
    }
}

#[cfg(test)]
mod github_auth_tests {
    use super::{git_command, git_config_env, github_auth_config, parse_git_version};
    use std::process::Command;

    // A fake token, built at runtime so no key-like string sits in the source.
    fn fake_token() -> String {
        let mut t = String::from("fake");
        t.extend(std::iter::repeat('Q').take(36));
        t
    }

    fn b64_of(token: &str) -> String {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{}", token))
    }

    fn argv(cmd: &Command) -> Vec<String> {
        let mut v = vec![cmd.get_program().to_string_lossy().to_string()];
        v.extend(cmd.get_args().map(|a| a.to_string_lossy().to_string()));
        v
    }

    fn envs(cmd: &Command) -> Vec<(String, String)> {
        cmd.get_envs()
            .filter_map(|(k, v)| Some((k.to_string_lossy().to_string(), v?.to_string_lossy().to_string())))
            .collect()
    }

    fn assert_not_in_argv(cmd: &Command, tok: &str) {
        for a in argv(cmd) {
            assert!(!a.contains(tok), "token on argv");
            assert!(!a.contains(&b64_of(tok)), "encoded token on argv");
            assert!(!a.to_ascii_lowercase().contains("extraheader"), "auth header config on argv");
        }
    }

    #[test]
    fn modern_git_gets_the_token_through_the_environment_only() {
        let tok = fake_token();
        let cmd = git_command(".", &["fetch", "origin"], Some(&tok), Some((2, 46)));
        assert_not_in_argv(&cmd, &tok);
        let env = envs(&cmd);
        let get = |k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
        let n: usize = get("GIT_CONFIG_COUNT").expect("GIT_CONFIG_COUNT").parse().unwrap();
        let hdr = (0..n)
            .find(|i| get(&format!("GIT_CONFIG_KEY_{}", i)).as_deref() == Some("http.https://github.com.extraHeader"))
            .expect("extraHeader key in env");
        assert_eq!(
            get(&format!("GIT_CONFIG_VALUE_{}", hdr)).unwrap(),
            format!("Authorization: Basic {}", b64_of(&tok))
        );
        assert!(get("GIT_CONFIG_PARAMETERS").is_none());
    }

    #[test]
    fn old_git_falls_back_to_config_parameters_in_the_environment() {
        let tok = fake_token();
        for version in [Some((2, 30)), None] {
            let cmd = git_command(".", &["push", "origin", "main"], Some(&tok), version);
            assert_not_in_argv(&cmd, &tok);
            let env = envs(&cmd);
            let p = env.iter().find(|(k, _)| k == "GIT_CONFIG_PARAMETERS").map(|(_, v)| v.clone())
                .expect("GIT_CONFIG_PARAMETERS");
            assert!(p.contains(&b64_of(&tok)));
            assert!(env.iter().all(|(k, _)| k != "GIT_CONFIG_COUNT"));
        }
    }

    #[test]
    fn local_commands_never_carry_the_token() {
        let tok = fake_token();
        for args in [&["status", "--porcelain"][..], &["commit", "-m", "x"], &["-c", "user.name=a", "rev-parse", "HEAD"]] {
            let cmd = git_command(".", args, Some(&tok), Some((2, 46)));
            assert_not_in_argv(&cmd, &tok);
            for (_, v) in envs(&cmd) {
                assert!(!v.contains(&b64_of(&tok)), "token in env of a local command");
            }
        }
        // Network subcommands behind global options are still recognised.
        let cmd = git_command(".", &["-c", "user.name=a", "submodule", "update", "--init"], Some(&tok), Some((2, 46)));
        assert!(envs(&cmd).iter().any(|(_, v)| v.contains(&b64_of(&tok))));
    }

    #[test]
    fn inherited_env_config_is_extended_not_replaced() {
        let entries = github_auth_config(&fake_token());
        let env = git_config_env(&entries, Some((2, 31)), Some("2"), None);
        assert!(env.contains(&("GIT_CONFIG_COUNT".into(), "4".into())));
        assert!(env.iter().any(|(k, _)| k == "GIT_CONFIG_KEY_2"));
        assert!(env.iter().all(|(k, _)| k != "GIT_CONFIG_KEY_0"));
        let env = git_config_env(&entries, Some((2, 20)), None, Some("'a.b=c'"));
        assert!(env[0].1.starts_with("'a.b=c' '"));
    }

    #[test]
    fn parses_git_versions() {
        assert_eq!(parse_git_version("git version 2.46.0.windows.1\n"), Some((2, 46)));
        assert_eq!(parse_git_version("git version 2.30.2"), Some((2, 30)));
        assert_eq!(parse_git_version("git version 2.39.3 (Apple Git-146)"), Some((2, 39)));
        assert_eq!(parse_git_version("nonsense"), None);
    }

    /// The real git reads the header from the environment, in both formats.
    #[test]
    fn real_git_reads_the_header_from_the_environment() {
        let tok = fake_token();
        let entries = github_auth_config(&tok);
        let installed = super::git_version();
        let mut versions = vec![Some((2, 0))]; // GIT_CONFIG_PARAMETERS: every git
        if matches!(installed, Some(v) if v >= (2, 31)) {
            versions.push(installed);
        }
        for version in versions {
            let mut cmd = Command::new("git");
            cmd.args(["config", "--get", "http.https://github.com.extraheader"])
                .env_remove("GIT_CONFIG_COUNT")
                .env_remove("GIT_CONFIG_PARAMETERS");
            for (k, v) in git_config_env(&entries, version, None, None) {
                cmd.env(k, v);
            }
            let out = cmd.output().expect("git runs");
            assert_eq!(
                String::from_utf8_lossy(&out.stdout).trim(),
                format!("Authorization: Basic {}", b64_of(&tok)),
                "version {:?}",
                version
            );
        }
    }
}
