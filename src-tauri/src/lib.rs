use serde::Serialize;
use std::collections::HashSet;
use std::path::PathBuf;
use std::process::Command;
use walkdir::WalkDir;

mod server;

const IGNORE_FILE: &str = ".vaultchatignore";
const NOTES_DIR: &str = ".vault-chat";
const NOTES_FILE: &str = "notes.jsonl";

#[derive(Serialize)]
struct FileEntry {
    path: String,
    name: String,
    is_dir: bool,
    depth: usize,
    hidden: bool,
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

fn load_ignore_set(vault: &std::path::Path) -> HashSet<String> {
    let path = vault.join(IGNORE_FILE);
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

fn is_hidden_path(rel_path: &str, ignored: &HashSet<String>) -> bool {
    if ignored.contains(rel_path) {
        return true;
    }
    for (i, _) in rel_path.match_indices('/') {
        if ignored.contains(&rel_path[..i]) {
            return true;
        }
    }
    false
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
        entries.push(FileEntry {
            path: path.to_string_lossy().replace('\\', "/"),
            name: path.file_name().unwrap_or_default().to_string_lossy().to_string(),
            is_dir,
            depth: rel.components().count().saturating_sub(1),
            hidden,
        });
    }
    Ok(entries)
}

#[tauri::command]
async fn read_ignore_lines(vault: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = std::path::Path::new(&vault).join(IGNORE_FILE);
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
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn add_to_ignore(vault: String, relative_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let normalized = relative_path
            .trim_start_matches('/')
            .trim_end_matches('/')
            .replace('\\', "/");
        if normalized.is_empty() {
            return Err("cannot hide vault root".to_string());
        }
        let path = std::path::Path::new(&vault).join(IGNORE_FILE);
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
        let path = std::path::Path::new(&vault).join(IGNORE_FILE);
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
        let prefixes: Vec<String> = relative_prefixes
            .into_iter()
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
        let path = std::path::Path::new(&vault).join(IGNORE_FILE);
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
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn remove_from_ignore(vault: String, relative_paths: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let targets: HashSet<String> = relative_paths
            .into_iter()
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
        let path = std::path::Path::new(&vault).join(IGNORE_FILE);
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
        for term in ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"] {
            if Command::new(term).current_dir(&dir).spawn().is_ok() {
                return Ok(());
            }
        }
        Err("no terminal emulator found".to_string())
    }
}

#[tauri::command]
async fn read_text_file(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::read_to_string(&path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn write_text_file(path: String, contents: String) -> Result<(), String> {
    git_guard(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(parent) = std::path::Path::new(&path).parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, contents).map_err(|e| e.to_string())
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
        let mut c = Command::new("cmd");
        c.arg("/C").arg(&command);
        c.creation_flags(0x08000000);
        c
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

// ---------- GitHub feedback issues ----------
//
// Files an issue on the vault-chat repo when the user hits Ctrl+G or
// the Settings "Send feedback" button. Images attached to the
// feedback get committed to the target repo at
// `.feedback-images/<uuid>.<ext>` so they render inline in the issue
// and the cloud agent can fetch them. The agent processes these
// issues nightly and lands fixes (see /schedule routine).

const GH_API: &str = "https://api.github.com";
const GH_UA: &str = "vault-chat/0.1 (feedback)";

fn gh_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent(GH_UA)
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn gh_test_token(token: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let client = gh_client()?;
        let resp = client
            .get(format!("{}/user", GH_API))
            .header("Authorization", format!("Bearer {}", token))
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .send()
            .map_err(|e| e.to_string())?;
        let status = resp.status();
        let body = resp.text().map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!(
                "GitHub {}: {}",
                status,
                body.chars().take(200).collect::<String>()
            ));
        }
        let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
        let login = v
            .get("login")
            .and_then(|x| x.as_str())
            .unwrap_or("(unknown)")
            .to_string();
        Ok(login)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(serde::Deserialize)]
struct FeedbackImage {
    /// data: URL like "data:image/png;base64,iVBORw0KG..."
    data_url: String,
}

#[derive(Serialize)]
struct CreatedIssue {
    number: u64,
    url: String,
}

fn parse_data_url(s: &str) -> Option<(String, String)> {
    // Returns (mime, base64-payload). Format: "data:<mime>;base64,<payload>"
    let rest = s.strip_prefix("data:")?;
    let (header, payload) = rest.split_once(',')?;
    if !header.ends_with(";base64") {
        return None;
    }
    let mime = header.trim_end_matches(";base64").to_string();
    Some((mime, payload.to_string()))
}

fn mime_to_ext(mime: &str) -> Option<&'static str> {
    match mime {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/svg+xml" => Some("svg"),
        _ => None,
    }
}

#[tauri::command]
async fn gh_create_feedback_issue(
    token: String,
    owner: String,
    repo: String,
    title: String,
    body: String,
    labels: Vec<String>,
    images: Vec<FeedbackImage>,
) -> Result<CreatedIssue, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<CreatedIssue, String> {
        let client = gh_client()?;

        // Step 1: upload each image via the Contents API. PUT to
        // /repos/:owner/:repo/contents/.feedback-images/<uuid>.<ext>
        // with base64 payload. Each upload is its own atomic commit
        // on main; the response gives us a stable raw URL.
        let mut image_urls: Vec<String> = Vec::new();
        for (idx, img) in images.iter().enumerate() {
            let (mime, b64) = parse_data_url(&img.data_url)
                .ok_or_else(|| format!("image {}: not a base64 data URL", idx))?;
            let ext = mime_to_ext(&mime).unwrap_or("bin");
            let id = uuid::Uuid::new_v4();
            let path = format!(".feedback-images/{}.{}", id, ext);
            let payload = serde_json::json!({
                "message": format!("feedback-image: {}", id),
                "content": b64,
            });
            let url = format!(
                "{}/repos/{}/{}/contents/{}",
                GH_API, owner, repo, path
            );
            let resp = client
                .put(&url)
                .header("Authorization", format!("Bearer {}", token))
                .header("Accept", "application/vnd.github+json")
                .header("X-GitHub-Api-Version", "2022-11-28")
                .header("Content-Type", "application/json")
                .body(serde_json::to_string(&payload).map_err(|e| e.to_string())?)
                .send()
                .map_err(|e| e.to_string())?;
            let status = resp.status();
            let text = resp.text().map_err(|e| e.to_string())?;
            if !status.is_success() {
                return Err(format!(
                    "image {} upload failed ({}): {}",
                    idx,
                    status,
                    text.chars().take(200).collect::<String>()
                ));
            }
            let v: serde_json::Value =
                serde_json::from_str(&text).map_err(|e| e.to_string())?;
            let dl = v
                .get("content")
                .and_then(|c| c.get("download_url"))
                .and_then(|x| x.as_str())
                .ok_or_else(|| format!("image {}: no download_url", idx))?;
            image_urls.push(dl.to_string());
        }

        // Step 2: append image references to the issue body so they
        // render inline. Empty image list = no appended block.
        let mut full_body = body;
        if !image_urls.is_empty() {
            full_body.push_str("\n\n---\n\n**Attached images:**\n\n");
            for url in &image_urls {
                full_body.push_str(&format!("![attachment]({})\n\n", url));
            }
        }

        // Step 3: create the issue.
        let issue_payload = serde_json::json!({
            "title": title,
            "body": full_body,
            "labels": labels,
        });
        let url = format!("{}/repos/{}/{}/issues", GH_API, owner, repo);
        let resp = client
            .post(&url)
            .header("Authorization", format!("Bearer {}", token))
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .header("Content-Type", "application/json")
            .body(serde_json::to_string(&issue_payload).map_err(|e| e.to_string())?)
            .send()
            .map_err(|e| e.to_string())?;
        let status = resp.status();
        let text = resp.text().map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!(
                "issue create failed ({}): {}",
                status,
                text.chars().take(400).collect::<String>()
            ));
        }
        let v: serde_json::Value =
            serde_json::from_str(&text).map_err(|e| e.to_string())?;
        let number = v
            .get("number")
            .and_then(|x| x.as_u64())
            .ok_or("response missing issue number")?;
        let html = v
            .get("html_url")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        Ok(CreatedIssue { number, url: html })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
struct IssueLabel {
    name: String,
    color: String,
}

#[derive(Serialize)]
struct IssueSummary {
    number: u64,
    title: String,
    body: Option<String>,
    state: String,
    labels: Vec<IssueLabel>,
    html_url: String,
    created_at: String,
    updated_at: String,
    comments: u64,
}

#[derive(Serialize)]
struct IssueCommentOut {
    id: u64,
    body: String,
    author: String,
    created_at: String,
}

fn gh_get(token: &str, url: &str, client: &reqwest::blocking::Client) -> Result<String, String> {
    let resp = client
        .get(url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!(
            "GitHub {}: {}",
            status,
            text.chars().take(300).collect::<String>()
        ));
    }
    Ok(text)
}

#[tauri::command]
async fn gh_list_feedback_issues(
    token: String,
    owner: String,
    repo: String,
) -> Result<Vec<IssueSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<IssueSummary>, String> {
        let client = gh_client()?;
        // Only open issues — once the user closes an issue they want it
        // gone from the in-app list.
        let url = format!(
            "{}/repos/{}/{}/issues?state=open&per_page=100&sort=updated&direction=desc",
            GH_API, owner, repo
        );
        let text = gh_get(&token, &url, &client)?;
        let arr: Vec<serde_json::Value> =
            serde_json::from_str(&text).map_err(|e| e.to_string())?;

        let mut out: Vec<IssueSummary> = Vec::new();
        for v in arr {
            // Skip pull requests — GitHub returns them in the issues
            // endpoint by default, but they have a `pull_request` key.
            if v.get("pull_request").is_some() {
                continue;
            }
            let labels_arr = v
                .get("labels")
                .and_then(|x| x.as_array())
                .cloned()
                .unwrap_or_default();
            let mut labels = Vec::new();
            let mut has_auto_fix_label = false;
            for l in &labels_arr {
                let name = l
                    .get("name")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                if name.starts_with("auto-fix") {
                    has_auto_fix_label = true;
                }
                let color = l
                    .get("color")
                    .and_then(|x| x.as_str())
                    .unwrap_or("888888")
                    .to_string();
                labels.push(IssueLabel { name, color });
            }
            // Only show issues this feature filed.
            if !has_auto_fix_label {
                continue;
            }
            out.push(IssueSummary {
                number: v.get("number").and_then(|x| x.as_u64()).unwrap_or(0),
                title: v
                    .get("title")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string(),
                body: v
                    .get("body")
                    .and_then(|x| x.as_str())
                    .map(String::from),
                state: v
                    .get("state")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string(),
                labels,
                html_url: v
                    .get("html_url")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string(),
                created_at: v
                    .get("created_at")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string(),
                updated_at: v
                    .get("updated_at")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string(),
                comments: v.get("comments").and_then(|x| x.as_u64()).unwrap_or(0),
            });
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn gh_get_issue_comments(
    token: String,
    owner: String,
    repo: String,
    number: u64,
) -> Result<Vec<IssueCommentOut>, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<IssueCommentOut>, String> {
        let client = gh_client()?;
        let url = format!(
            "{}/repos/{}/{}/issues/{}/comments?per_page=100",
            GH_API, owner, repo, number
        );
        let text = gh_get(&token, &url, &client)?;
        let arr: Vec<serde_json::Value> =
            serde_json::from_str(&text).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for v in arr {
            out.push(IssueCommentOut {
                id: v.get("id").and_then(|x| x.as_u64()).unwrap_or(0),
                body: v
                    .get("body")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string(),
                author: v
                    .get("user")
                    .and_then(|u| u.get("login"))
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string(),
                created_at: v
                    .get("created_at")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string(),
            });
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn gh_close_issue(
    token: String,
    owner: String,
    repo: String,
    number: u64,
    state_reason: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let client = gh_client()?;
        let mut body = serde_json::json!({ "state": "closed" });
        // state_reason: "completed" (default), "not_planned", "reopened" - skip
        if let Some(r) = state_reason {
            body["state_reason"] = serde_json::Value::String(r);
        }
        let url = format!("{}/repos/{}/{}/issues/{}", GH_API, owner, repo, number);
        let resp = client
            .patch(&url)
            .header("Authorization", format!("Bearer {}", token))
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .header("Content-Type", "application/json")
            .body(serde_json::to_string(&body).map_err(|e| e.to_string())?)
            .send()
            .map_err(|e| e.to_string())?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().unwrap_or_default();
            return Err(format!(
                "GitHub {}: {}",
                status,
                text.chars().take(300).collect::<String>()
            ));
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn gh_reopen_issue(
    token: String,
    owner: String,
    repo: String,
    number: u64,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let client = gh_client()?;
        let body = serde_json::json!({ "state": "open" });
        let url = format!("{}/repos/{}/{}/issues/{}", GH_API, owner, repo, number);
        let resp = client
            .patch(&url)
            .header("Authorization", format!("Bearer {}", token))
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .header("Content-Type", "application/json")
            .body(serde_json::to_string(&body).map_err(|e| e.to_string())?)
            .send()
            .map_err(|e| e.to_string())?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().unwrap_or_default();
            return Err(format!(
                "GitHub {}: {}",
                status,
                text.chars().take(300).collect::<String>()
            ));
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn gh_relabel_issue(
    token: String,
    owner: String,
    repo: String,
    number: u64,
    add: Vec<String>,
    remove: Vec<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let client = gh_client()?;
        // Two-step: DELETE each removed label individually (the
        // bulk-set endpoint replaces, which would clobber unrelated
        // labels), then POST to add. Both endpoints are forgiving of
        // missing labels — DELETE returns 404 we treat as ok.
        for label in &remove {
            let url = format!(
                "{}/repos/{}/{}/issues/{}/labels/{}",
                GH_API,
                owner,
                repo,
                number,
                urlencoding::encode_path(label)
            );
            let resp = client
                .delete(&url)
                .header("Authorization", format!("Bearer {}", token))
                .header("Accept", "application/vnd.github+json")
                .header("X-GitHub-Api-Version", "2022-11-28")
                .send()
                .map_err(|e| e.to_string())?;
            // 404 means the label wasn't applied; ignore. 200 means removed.
            // Anything else is a real error.
            let status = resp.status();
            if !status.is_success() && status.as_u16() != 404 {
                let text = resp.text().unwrap_or_default();
                return Err(format!(
                    "GitHub remove-label {}: {}",
                    status,
                    text.chars().take(200).collect::<String>()
                ));
            }
        }
        if !add.is_empty() {
            let url = format!(
                "{}/repos/{}/{}/issues/{}/labels",
                GH_API, owner, repo, number
            );
            let body = serde_json::json!({ "labels": add });
            let resp = client
                .post(&url)
                .header("Authorization", format!("Bearer {}", token))
                .header("Accept", "application/vnd.github+json")
                .header("X-GitHub-Api-Version", "2022-11-28")
                .header("Content-Type", "application/json")
                .body(serde_json::to_string(&body).map_err(|e| e.to_string())?)
                .send()
                .map_err(|e| e.to_string())?;
            let status = resp.status();
            if !status.is_success() {
                let text = resp.text().unwrap_or_default();
                return Err(format!(
                    "GitHub add-label {}: {}",
                    status,
                    text.chars().take(200).collect::<String>()
                ));
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn gh_comment_issue(
    token: String,
    owner: String,
    repo: String,
    number: u64,
    body: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let client = gh_client()?;
        let payload = serde_json::json!({ "body": body });
        let url = format!(
            "{}/repos/{}/{}/issues/{}/comments",
            GH_API, owner, repo, number
        );
        let resp = client
            .post(&url)
            .header("Authorization", format!("Bearer {}", token))
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .header("Content-Type", "application/json")
            .body(serde_json::to_string(&payload).map_err(|e| e.to_string())?)
            .send()
            .map_err(|e| e.to_string())?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().unwrap_or_default();
            return Err(format!(
                "GitHub {}: {}",
                status,
                text.chars().take(300).collect::<String>()
            ));
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// Tiny helper — reqwest doesn't ship a path-encoder. This handles the
// few special characters that show up in our label names (colon,
// space). Good enough for our limited label set; not a general
// percent-encoder.
mod urlencoding {
    pub fn encode_path(s: &str) -> String {
        let mut out = String::with_capacity(s.len());
        for ch in s.chars() {
            match ch {
                'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => out.push(ch),
                ' ' => out.push_str("%20"),
                ':' => out.push_str("%3A"),
                '/' => out.push_str("%2F"),
                '?' => out.push_str("%3F"),
                '#' => out.push_str("%23"),
                _ => out.push_str(&format!("%{:02X}", ch as u32 & 0xFF)),
            }
        }
        out
    }
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

fn run_git(
    cwd: &str,
    args: &[&str],
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
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let mut stdout = String::new();
    let mut stderr = String::new();
    if let Some(mut o) = child.stdout.take() {
        let _ = o.read_to_string(&mut stdout);
    }
    if let Some(mut e) = child.stderr.take() {
        let _ = e.read_to_string(&mut stderr);
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    Ok((stdout, stderr, status.code().unwrap_or(-1)))
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
        let git_dir = PathBuf::from(&vault).join(".git");
        let mut did_work = false;

        if !git_dir.is_dir() {
            run_git(&vault, &["init", "-q"])?;
            run_git(
                &vault,
                &[
                    "-c",
                    "user.email=vault-chat@local",
                    "-c",
                    "user.name=vault-chat",
                    "add",
                    "-A",
                ],
            )?;
            run_git(
                &vault,
                &[
                    "-c",
                    "user.email=vault-chat@local",
                    "-c",
                    "user.name=vault-chat",
                    "commit",
                    "--allow-empty",
                    "-q",
                    "-m",
                    "vault-chat: pre-existing vault state",
                ],
            )?;
            did_work = true;
        }

        // Create the vault-chat-start tag if it doesn't already exist.
        // The tag marks "vault as it was when vault-chat first opened
        // it." Never moves once placed.
        let (_, _, tag_check) =
            run_git(&vault, &["rev-parse", "--verify", "vault-chat-start"])?;
        if tag_check != 0 {
            // Tag absent — create it at current HEAD.
            run_git(&vault, &["tag", "vault-chat-start"])?;
            did_work = true;
        }

        Ok(did_work)
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
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (status_out, _, _) = run_git(&vault, &["status", "--porcelain"])?;
        if status_out.trim().is_empty() {
            return Ok(None);
        }
        run_git(
            &vault,
            &[
                "-c",
                "user.email=vault-chat@local",
                "-c",
                "user.name=vault-chat",
                "add",
                "-A",
            ],
        )?;
        run_git(
            &vault,
            &[
                "-c",
                "user.email=vault-chat@local",
                "-c",
                "user.name=vault-chat",
                "commit",
                "-q",
                "-m",
                &message,
            ],
        )?;
        let (hash, _, _) = run_git(&vault, &["rev-parse", "--short", "HEAD"])?;
        Ok(Some(hash.trim().to_string()))
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

/// Revert the most recent commit (leaves a new commit that undoes it
/// — safer than reset, keeps history). Errors if HEAD is the initial
/// commit.
#[tauri::command]
async fn git_revert_head(vault: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (count_out, _, _) = run_git(&vault, &["rev-list", "--count", "HEAD"])?;
        let count: usize = count_out.trim().parse().unwrap_or(0);
        if count < 2 {
            return Err("nothing to undo yet".to_string());
        }
        let (_, stderr, code) = run_git(
            &vault,
            &[
                "-c",
                "user.email=vault-chat@local",
                "-c",
                "user.name=vault-chat",
                "revert",
                "--no-edit",
                "HEAD",
            ],
        )?;
        if code != 0 {
            return Err(format!("revert failed: {}", stderr.trim()));
        }
        let (hash, _, _) = run_git(&vault, &["rev-parse", "--short", "HEAD"])?;
        Ok(hash.trim().to_string())
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
            run_git(&vault, &["read-tree", "--reset", "-u", &hash])?;
        if code != 0 {
            return Err(format!("read-tree failed: {}", stderr.trim()));
        }

        let short = hash.chars().take(8).collect::<String>();
        let msg = if subject.is_empty() {
            format!("Restore to {}", short)
        } else {
            format!("Restore: {} ({})", subject, short)
        };
        let (_, stderr2, code2) = run_git(
            &vault,
            &[
                "-c",
                "user.email=vault-chat@local",
                "-c",
                "user.name=vault-chat",
                "commit",
                "--allow-empty",
                "-q",
                "-m",
                &msg,
            ],
        )?;
        if code2 != 0 {
            return Err(format!("commit failed: {}", stderr2.trim()));
        }
        let (new_hash, _, _) = run_git(&vault, &["rev-parse", "--short", "HEAD"])?;
        Ok(new_hash.trim().to_string())
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
        // Did this path exist in the target commit?
        let spec = format!("{}:{}", hash, relative_path);
        let (_, _, ls_code) = run_git(&vault, &["cat-file", "-e", &spec])?;
        if ls_code == 0 {
            // Yes — checkout that version into both index and worktree.
            let (_, stderr, code) = run_git(
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
            let (_, _, _) = run_git(&vault, &["rm", "-f", "--", &relative_path])?;
        }
        let short = hash.chars().take(8).collect::<String>();
        let leaf = relative_path
            .rsplit('/')
            .next()
            .unwrap_or(&relative_path);
        let msg = format!("Restore {} to {}", leaf, short);
        let (_, stderr, code) = run_git(
            &vault,
            &[
                "-c",
                "user.email=vault-chat@local",
                "-c",
                "user.name=vault-chat",
                "commit",
                "--allow-empty",
                "-q",
                "-m",
                &msg,
            ],
        )?;
        if code != 0 {
            return Err(format!("commit failed: {}", stderr.trim()));
        }
        let (new_hash, _, _) = run_git(&vault, &["rev-parse", "--short", "HEAD"])?;
        Ok(new_hash.trim().to_string())
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
const DEFAULT_META_README: &str = include_str!("../defaults/README.md");

#[derive(Serialize)]
struct MetaInit {
    path: String,
    fresh: bool,
}

fn meta_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {}", e))?;
    Ok(base.join("meta"))
}

/// Create the meta vault on disk with bundled defaults if it doesn't
/// exist yet. Returns the path and whether this call was the one that
/// created it.
#[tauri::command]
fn meta_vault_init(app: tauri::AppHandle) -> Result<MetaInit, String> {
    let dir = meta_dir(&app)?;
    let fresh = !dir.exists();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let system_path = dir.join("system.md");
    if !system_path.exists() {
        std::fs::write(&system_path, DEFAULT_SYSTEM_MD).map_err(|e| e.to_string())?;
    }
    let readme_path = dir.join("README.md");
    if !readme_path.exists() {
        std::fs::write(&readme_path, DEFAULT_META_README).map_err(|e| e.to_string())?;
    }
    let skills_dir = dir.join("skills");
    std::fs::create_dir_all(&skills_dir).map_err(|e| e.to_string())?;
    let tools_dir = dir.join("tools");
    std::fs::create_dir_all(&tools_dir).map_err(|e| e.to_string())?;

    let path_str = dir.to_string_lossy().replace('\\', "/");
    Ok(MetaInit {
        path: path_str,
        fresh,
    })
}

/// Return the meta vault path (does not create if absent).
#[tauri::command]
fn meta_vault_path(app: tauri::AppHandle) -> Result<String, String> {
    let dir = meta_dir(&app)?;
    Ok(dir.to_string_lossy().replace('\\', "/"))
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
        Some(("python", vec![path.to_string()]))
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

#[tauri::command]
async fn phone_send_chunk(
    state: tauri::State<'_, server::ServerState>,
    chunk: String,
) -> Result<(), String> {
    server::push_chunk(&state, chunk).await;
    Ok(())
}

#[tauri::command]
fn phone_server_info(
    state: tauri::State<'_, server::ServerState>,
) -> Result<serde_json::Value, String> {
    // Prefer the MagicDNS hostname so the HTTPS cert (which is issued
    // for the hostname, not the raw IP) matches. Fall back to the IP
    // for plain-HTTP LAN use if tailscale isn't available.
    let dns_name = std::process::Command::new("tailscale")
        .args(["status", "--json"])
        .output()
        .ok()
        .and_then(|out| {
            if !out.status.success() { return None; }
            let json: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
            let raw = json["Self"]["DNSName"].as_str()?.to_string();
            Some(raw.trim_end_matches('.').to_string())
        });

    let tailscale_ip = std::process::Command::new("tailscale")
        .args(["ip", "--4"])
        .output()
        .ok()
        .and_then(|out| {
            if out.status.success() {
                String::from_utf8(out.stdout)
                    .ok()
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
            } else {
                None
            }
        });

    Ok(serde_json::json!({
        "port": 8787,
        "token": state.token,
        "tailscale_ip": tailscale_ip,
        "dns_name": dns_name,
    }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            use tauri::Manager;

            // Pre-React auto-update safety net (release builds only).
            // Runs before the WebView is shown so a broken React bundle in
            // the installed version can still self-heal — if JS throws on
            // mount, the in-app `UpdateBanner` never gets a chance to fire.
            // Bounded by a short timeout so a slow/offline network can't
            // hang the app at launch; failures fall through to normal boot.
            #[cfg(not(debug_assertions))]
            {
                use tauri_plugin_updater::UpdaterExt;
                let handle = app.handle().clone();
                let outcome = tauri::async_runtime::block_on(async {
                    tokio::time::timeout(
                        std::time::Duration::from_secs(30),
                        async {
                            let updater = handle.updater()?;
                            let Some(update) = updater.check().await? else {
                                return Ok::<bool, tauri_plugin_updater::Error>(false);
                            };
                            update
                                .download_and_install(|_, _| {}, || {})
                                .await?;
                            Ok(true)
                        },
                    )
                    .await
                });
                match outcome {
                    Ok(Ok(true)) => {
                        // Diverges — process exits and the new version launches.
                        handle.restart();
                    }
                    Ok(Ok(false)) => {}
                    Ok(Err(e)) => eprintln!("[updater] pre-react check failed: {e}"),
                    Err(_) => eprintln!("[updater] pre-react check timed out"),
                }
            }

            // Start the main window hidden so the OS doesn't show an
            // unpainted frame while the WebView is still loading. The
            // frontend calls `app_ready` once React has mounted and the
            // splash starts fading — see src/main.tsx.
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.hide();
                #[cfg(windows)]
                apply_titlebar_color(&w);
            }

            // Phone bridge: load or generate a stable token, then spin
            // up the HTTP + WebSocket server on a Tauri async task.
            let app_data = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("app_data_dir: {}", e))?;
            std::fs::create_dir_all(&app_data).ok();
            let token_path = app_data.join("phone_token.txt");
            let token = match std::fs::read_to_string(&token_path) {
                Ok(s) if !s.trim().is_empty() => s.trim().to_string(),
                _ => {
                    let fresh = uuid::Uuid::new_v4().simple().to_string();
                    let _ = std::fs::write(&token_path, &fresh);
                    fresh
                }
            };

            let state = server::ServerState {
                app: app.handle().clone(),
                token,
                outbound: std::sync::Arc::new(tokio::sync::Mutex::new(None)),
            };
            app.manage(state.clone());
            tauri::async_runtime::spawn(server::serve(state, 8787));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_markdown_files,
            read_text_file,
            read_binary_file,
            write_text_file,
            write_binary_file_unique,
            copy_into_vault,
            delete_file,
            create_dir,
            rename_path,
            edit_text_file,
            glob_files,
            grep_files,
            bash_exec,
            list_dir,
            http_fetch,
            tavily_search,
            read_ignore_lines,
            add_to_ignore,
            rename_in_ignore,
            remove_prefix_from_ignore,
            remove_from_ignore,
            notes_read,
            notes_append,
            notes_write_all,
            open_terminal,
            git_init_if_needed,
            git_commit_all,
            git_recent_commits,
            git_revert_head,
            git_show_commit,
            git_restore_to_commit,
            git_all_touched_files,
            git_commit_files,
            git_file_history,
            git_file_at,
            git_diff_vs_current,
            git_restore_file_to,
            meta_vault_init,
            meta_vault_path,
            run_script,
            keychain_get,
            keychain_set,
            keychain_delete,
            phone_send_chunk,
            phone_server_info,
            gh_test_token,
            gh_create_feedback_issue,
            gh_list_feedback_issues,
            gh_get_issue_comments,
            gh_close_issue,
            gh_reopen_issue,
            gh_relabel_issue,
            gh_comment_issue,
            app_ready
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
