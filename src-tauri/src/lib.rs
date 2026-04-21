use serde::Serialize;
use std::collections::HashSet;
use std::path::PathBuf;
use std::process::Command;
use walkdir::WalkDir;

const IGNORE_FILE: &str = ".vaultchatignore";

#[derive(Serialize)]
struct FileEntry {
    path: String,
    name: String,
    is_dir: bool,
    depth: usize,
    hidden: bool,
}

fn is_viewable_ext(ext: &str) -> bool {
    matches!(
        ext,
        "md"
            | "markdown"
            | "txt"
            | "log"
            | "py"
            | "ipynb"
            | "pdf"
            | "json"
            | "jsonl"
            | "yaml"
            | "yml"
            | "toml"
            | "xml"
            | "ts"
            | "tsx"
            | "js"
            | "jsx"
            | "mjs"
            | "cjs"
            | "rs"
            | "go"
            | "java"
            | "c"
            | "h"
            | "cpp"
            | "hpp"
            | "cs"
            | "rb"
            | "php"
            | "swift"
            | "kt"
            | "sh"
            | "bash"
            | "zsh"
            | "ps1"
            | "bat"
            | "cmd"
            | "css"
            | "scss"
            | "sass"
            | "less"
            | "html"
            | "htm"
            | "svg"
            | "tex"
            | "bib"
            | "sql"
            | "r"
            | "jl"
            | "lua"
            | "ini"
            | "cfg"
            | "env"
            | "dockerfile"
            | "makefile"
            | "lark"
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
            if !ext.map(|e| is_viewable_ext(&e)).unwrap_or(false) {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            #[cfg(windows)]
            {
                use tauri::Manager;
                if let Some(w) = app.get_webview_window("main") {
                    apply_titlebar_color(&w);
                }
            }
            #[cfg(not(windows))]
            { let _ = app; }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_markdown_files,
            read_text_file,
            read_binary_file,
            write_text_file,
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
            remove_from_ignore,
            open_terminal,
            git_init_if_needed,
            git_commit_all,
            git_recent_commits,
            git_revert_head,
            git_show_commit,
            git_restore_to_commit,
            meta_vault_init,
            meta_vault_path,
            run_script,
            keychain_get,
            keychain_set,
            keychain_delete
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
