// A terminal or a file opened outside the app, kept track of until it closes (report 28, second pass): the app knew
// it had opened one, never whether it was still open. On Windows each opens through `cmd /C start "" /wait …`: the
// outer cmd waits for what `start` launched (the new console's cmd; the file's own program when it starts a new
// process), so its exit is that window closing. A thread waits on it and the app hears "tracked-exited" {id, kind, ms}.
// A program that hands the file to an instance already running returns at once (ms small): the app says so.
// tracked_close ends it (taskkill /T), as closing its window does. Elsewhere: not tracked (the callers fall back).
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tauri::AppHandle;

#[derive(Clone, serde::Serialize)]
pub struct TrackedOpen {
    pub id: String,
    pub kind: String,
    pub pid: u32,
}

#[derive(Clone, serde::Serialize)]
struct TrackedExited {
    id: String,
    kind: String,
    ms: u64,
}

fn pids() -> &'static Mutex<HashMap<String, u32>> {
    static P: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command]
pub async fn tracked_open(app: AppHandle, kind: String, target: String) -> Result<TrackedOpen, String> {
    tauri::async_runtime::spawn_blocking(move || open_sync(app, kind, target))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(windows)]
fn open_sync(app: AppHandle, kind: String, target: String) -> Result<TrackedOpen, String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    use tauri::Emitter;
    let win = target.replace('/', "\\");
    let mut cmd = Command::new("cmd");
    match kind.as_str() {
        // A console at the folder (the title bar's laptop terminal).
        "terminal" => {
            cmd.args(["/C", "start", "", "/wait", "cmd"]).current_dir(&win);
        }
        // The file with its default program (the viewer's Open with…).
        "open" => {
            if win.contains(['&', '|', '<', '>', '^', '%', '"']) {
                return Err("a path with a character cmd treats as an operator is not tracked".into());
            }
            cmd.args(["/C", "start", "", "/wait", &win]);
        }
        _ => return Err(format!("unknown kind {kind}")),
    }
    // CREATE_NO_WINDOW: the waiting cmd shows nothing; what it starts has its own window.
    let mut child = cmd.creation_flags(0x08000000).spawn().map_err(|e| e.to_string())?;
    let pid = child.id();
    let id = format!("{kind}-{pid}");
    pids().lock().map_err(|e| e.to_string())?.insert(id.clone(), pid);
    let (tid, tkind) = (id.clone(), kind.clone());
    std::thread::spawn(move || {
        let t0 = std::time::Instant::now();
        let _ = child.wait();
        if let Ok(mut m) = pids().lock() {
            m.remove(&tid);
        }
        let _ = app.emit("tracked-exited", TrackedExited { id: tid, kind: tkind, ms: t0.elapsed().as_millis() as u64 });
    });
    Ok(TrackedOpen { id, kind, pid })
}

#[cfg(not(windows))]
fn open_sync(_app: AppHandle, _kind: String, _target: String) -> Result<TrackedOpen, String> {
    Err("not tracked on this system".into())
}

#[tauri::command]
pub async fn tracked_close(id: String) -> Result<(), String> {
    let pid = pids().lock().map_err(|e| e.to_string())?.get(&id).copied().ok_or_else(|| format!("{id} is not open"))?;
    close_pid(pid)
}

#[cfg(windows)]
fn close_pid(pid: u32) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let out = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(0x08000000)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&out.stderr).trim().to_string()) }
}

#[cfg(not(windows))]
fn close_pid(_pid: u32) -> Result<(), String> {
    Err("not tracked on this system".into())
}
