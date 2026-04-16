use serde::Serialize;
use std::path::PathBuf;
use std::process::Command;
use walkdir::WalkDir;

#[derive(Serialize)]
struct FileEntry {
    path: String,
    name: String,
    is_dir: bool,
    depth: usize,
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
            if path.extension().and_then(|s| s.to_str()) != Some("md") {
                continue;
            }
        }
        let rel = path.strip_prefix(&root).unwrap_or(path);
        if rel.as_os_str().is_empty() {
            continue;
        }
        entries.push(FileEntry {
            path: path.to_string_lossy().replace('\\', "/"),
            name: path.file_name().unwrap_or_default().to_string_lossy().to_string(),
            is_dir,
            depth: rel.components().count().saturating_sub(1),
        });
    }
    Ok(entries)
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
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn delete_file(path: String) -> Result<(), String> {
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
fn edit_text_file(
    path: String,
    old_string: String,
    new_string: String,
    replace_all: Option<bool>,
) -> Result<String, String> {
    let contents = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let all = replace_all.unwrap_or(false);
    if all {
        let count = contents.matches(&old_string).count();
        if count == 0 {
            return Err(format!("old_string not found in {}", path));
        }
        let new_contents = contents.replace(&old_string, &new_string);
        std::fs::write(&path, new_contents).map_err(|e| e.to_string())?;
        Ok(format!("replaced {} occurrence(s) in {}", count, path))
    } else {
        let count = contents.matches(&old_string).count();
        if count == 0 {
            return Err(format!("old_string not found in {}", path));
        }
        if count > 1 {
            return Err(format!(
                "old_string matches {} times in {} — provide more context to make it unique, or set replace_all=true",
                count, path
            ));
        }
        let new_contents = contents.replacen(&old_string, &new_string, 1);
        std::fs::write(&path, new_contents).map_err(|e| e.to_string())?;
        Ok(format!("edited {}", path))
    }
}

#[tauri::command]
fn glob_files(pattern: String, cwd: Option<String>) -> Result<Vec<String>, String> {
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
fn bash_exec(
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
fn list_dir(path: String) -> Result<Vec<FileEntry>, String> {
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
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
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
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
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
            tavily_search
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
