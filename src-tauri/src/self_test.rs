//! Self-test mode: the real built app drives itself, with no box, so CI on a
//! fresh machine (a macOS runner) can check the exact artifact that ships.
//!
//! `VC_SELFTEST=<steps.json>` (and optionally `VC_SELFTEST_OUT=<results.json>`,
//! `VC_SELFTEST_TIMEOUT=<seconds>`) in the environment of the launch: the main
//! window opens the vault the steps file names (or a fresh temp one), which
//! starts the app's own local server as any vault with no box does, runs the
//! steps with the Drive step engine (src/selfTest.ts, src/driveSteps.ts), hands
//! the outcome back here, and the app writes it as JSON and exits 0 (every step
//! passed) or 1.
//!
//! Only the environment turns it on: nothing a vault, a page or the box can say
//! reaches it, and only the main window may ask for the steps or finish a run.
//! Without the variable every command here answers "not in self-test" and the
//! app is exactly as before.
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

pub const STEPS_VAR: &str = "VC_SELFTEST";
pub const OUT_VAR: &str = "VC_SELFTEST_OUT";
pub const TIMEOUT_VAR: &str = "VC_SELFTEST_TIMEOUT";
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(600);

/// What the environment asked for.
#[derive(Clone, Debug, PartialEq)]
pub struct Plan {
    pub steps: PathBuf,
    pub out: PathBuf,
    /// The whole run, after which the app writes a timeout result and exits 1.
    pub timeout: Duration,
}

/// The plan from an environment lookup; None when VC_SELFTEST is unset or blank.
pub fn plan_from(get: impl Fn(&str) -> Option<String>) -> Option<Plan> {
    let steps = get(STEPS_VAR).map(|s| s.trim().to_string()).filter(|s| !s.is_empty())?;
    let steps = PathBuf::from(steps);
    let out = get(OUT_VAR)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let mut o = steps.clone().into_os_string();
            o.push(".result.json");
            PathBuf::from(o)
        });
    let timeout = get(TIMEOUT_VAR)
        .and_then(|s| s.trim().parse::<u64>().ok())
        .map(|s| Duration::from_secs(s.clamp(10, 3600)))
        .unwrap_or(DEFAULT_TIMEOUT);
    Some(Plan { steps, out, timeout })
}

static PLAN: OnceLock<Option<Plan>> = OnceLock::new();
static CONFIG: OnceLock<Config> = OnceLock::new();
static FINISHED: AtomicBool = AtomicBool::new(false);
/// The steps reported so far (`selftest_progress`): every finished step's outcome and the one in flight, so a run the
/// watchdog ends still says which steps passed and where it hung.
static PROGRESS: Mutex<Progress> = Mutex::new(Progress { done: Vec::new(), current: None });

struct Progress {
    done: Vec<serde_json::Value>,
    current: Option<(u64, String)>,
}

/// The timeout result: the steps that finished, and the step that never did.
pub fn timeout_result(why: &str, done: &[serde_json::Value], current: Option<&(u64, String)>) -> serde_json::Value {
    let mut r = failure(&match current {
        Some((i, action)) => format!("{why}; stuck at step {i} ({action})"),
        None => why.to_string(),
    });
    r["steps"] = serde_json::Value::Array(done.to_vec());
    r
}

/// The code the process ends with once a run finished (-1: not finished).
static EXIT_CODE: AtomicI32 = AtomicI32::new(-1);

/// Set when a self-test finished: the process must end with it. `app.exit(code)`
/// alone does not carry the code out of the event loop, so the app's Exit
/// handler ends the process with this one (lib.rs).
pub fn exit_code() -> Option<i32> {
    let c = EXIT_CODE.load(Ordering::SeqCst);
    (c >= 0).then_some(c)
}

fn end(app: &tauri::AppHandle, code: i32) {
    EXIT_CODE.store(code, Ordering::SeqCst);
    app.exit(code);
}

/// This launch's plan (read once from the process environment).
pub fn plan() -> Option<&'static Plan> {
    PLAN.get_or_init(|| plan_from(|k| std::env::var(k).ok())).as_ref()
}

/// Whether this self-test asked for the first-run path (`"firstRun": true` in its steps file): only then does a
/// self-test launch seed the tutorial into its new vault (src-tauri/src/first_run_tutorial.rs).
pub fn wants_first_run() -> bool {
    CONFIG.get().map(|c| c.steps.get("firstRun").and_then(|v| v.as_bool()) == Some(true)).unwrap_or(false)
}

/// What the main window gets: the steps file as written, where the results go
/// and the vault to open.
#[derive(serde::Serialize, Clone, Debug)]
pub struct Config {
    pub steps: serde_json::Value,
    pub out: String,
    pub vault: String,
    #[serde(rename = "tempVault")]
    pub temp_vault: bool,
}

/// Read the steps file and settle the vault: the file's `vault` (made if it is
/// not there yet), else a fresh directory under the temp dir.
pub fn load(plan: &Plan) -> Result<Config, String> {
    let text = std::fs::read_to_string(&plan.steps).map_err(|e| format!("could not read the steps file {}: {e}", plan.steps.display()))?;
    let steps: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("the steps file {} is not JSON: {e}", plan.steps.display()))?;
    let named = steps.get("vault").and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()).map(PathBuf::from);
    let temp_vault = named.is_none();
    let vault = match named {
        Some(v) => v,
        None => {
            let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
            std::env::temp_dir().join(format!("vc-selftest-{}-{nanos}", std::process::id()))
        }
    };
    std::fs::create_dir_all(&vault).map_err(|e| format!("could not make the vault {}: {e}", vault.display()))?;
    let vault = vault.canonicalize().unwrap_or(vault);
    Ok(Config { steps, out: plan.out.to_string_lossy().to_string(), vault: vault.to_string_lossy().replace('\\', "/"), temp_vault })
}

/// Write the results (pretty JSON) whole: a temp file renamed over the target,
/// so a reader never sees half of it.
pub fn write_result(out: &Path, result: &serde_json::Value) -> Result<(), String> {
    if let Some(dir) = out.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir).map_err(|e| format!("could not make {}: {e}", dir.display()))?;
    }
    let mut tmp = out.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    let body = serde_json::to_string_pretty(result).map_err(|e| e.to_string())? + "\n";
    std::fs::write(&tmp, body).map_err(|e| format!("could not write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, out).map_err(|e| format!("could not write {}: {e}", out.display()))
}

/// A result that is only a failure (the steps file was unreadable, the run timed out).
pub fn failure(error: &str) -> serde_json::Value {
    serde_json::json!({ "schema": 1, "ok": false, "error": error, "steps": [], "errors": [], "text": "" })
}

/// At launch, before any window runs: load the steps (a bad file ends the run
/// at once with a result saying why) and start the watchdog that ends a run
/// whose window never finishes.
pub fn start(app: &tauri::AppHandle) {
    let Some(plan) = plan() else { return };
    println!("[selftest] steps {} -> {}", plan.steps.display(), plan.out.display());
    match load(plan) {
        Ok(cfg) => {
            let _ = CONFIG.set(cfg);
        }
        Err(e) => {
            eprintln!("[selftest] {e}");
            let _ = write_result(&plan.out, &failure(&e));
            std::process::exit(1);
        }
    }
    let app = app.clone();
    let (out, timeout) = (plan.out.clone(), plan.timeout);
    std::thread::spawn(move || {
        std::thread::sleep(timeout);
        if FINISHED.swap(true, Ordering::SeqCst) {
            return;
        }
        let why = format!("timed out after {} s: the app never finished its steps", timeout.as_secs());
        let result = match PROGRESS.lock() {
            Ok(p) => timeout_result(&why, &p.done, p.current.as_ref()),
            Err(_) => failure(&why),
        };
        eprintln!("[selftest] {}", result["error"].as_str().unwrap_or(&why));
        let _ = write_result(&out, &result);
        end(&app, 1);
        // The event loop may be the thing that hung (a modal, a native dialog): never wait on it to exit.
        std::thread::sleep(Duration::from_secs(10));
        std::process::exit(1);
    });
}

/// The steps for the main window; None when this launch is not a self-test.
#[tauri::command]
pub fn selftest_config(window: tauri::WebviewWindow) -> Option<Config> {
    if window.label() != "main" || plan().is_none() {
        return None;
    }
    CONFIG.get().cloned()
}

/// The main window says a step started (`outcome` null) or ended: logged on stdout (the CI job's app.log shows the run
/// step by step) and kept for the watchdog's result. Ignored outside a self-test.
#[tauri::command]
pub fn selftest_progress(window: tauri::WebviewWindow, i: u64, action: String, outcome: Option<serde_json::Value>) {
    if window.label() != "main" || plan().is_none() {
        return;
    }
    let action: String = action.chars().take(200).collect();
    let Ok(mut p) = PROGRESS.lock() else { return };
    match outcome {
        None => {
            println!("[selftest] step {i} {action} ...");
            p.current = Some((i, action));
        }
        Some(o) => {
            let ok = o.get("ok").and_then(|v| v.as_bool()) == Some(true);
            let ms = o.get("ms").and_then(|v| v.as_u64()).unwrap_or(0);
            let err = o.get("error").and_then(|v| v.as_str()).unwrap_or("");
            println!("[selftest] step {i} {action} {} {ms} ms {err}", if ok { "ok" } else { "FAILED" });
            p.current = None;
            if p.done.len() < 1000 {
                p.done.push(o);
            }
        }
    }
}

/// The main window's outcome: written to the results file, then the app exits
/// 0 when it says ok, 1 otherwise. Refused outside a self-test.
#[tauri::command]
pub fn selftest_finish(app: tauri::AppHandle, window: tauri::WebviewWindow, result: serde_json::Value) -> Result<(), String> {
    if window.label() != "main" {
        return Err("only the main window finishes a self-test".into());
    }
    let plan = plan().ok_or("not in self-test mode")?;
    if FINISHED.swap(true, Ordering::SeqCst) {
        return Err("the self-test already finished".into());
    }
    let ok = result.get("ok").and_then(|v| v.as_bool()) == Some(true);
    let written = write_result(&plan.out, &result);
    println!("[selftest] {} -> {}", if ok { "passed" } else { "FAILED" }, plan.out.display());
    if let Err(e) = &written {
        eprintln!("[selftest] {e}");
    }
    end(&app, if ok && written.is_ok() { 0 } else { 1 });
    written
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let m: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |k| m.get(k).cloned()
    }

    #[test]
    fn a_timeout_says_where_it_hung_and_keeps_the_steps_done() {
        let done = vec![serde_json::json!({"i": 1, "action": "waitFor", "ok": true, "ms": 5})];
        let r = timeout_result("timed out after 840 s", &done, Some(&(2, "click: pop out the chat".to_string())));
        assert_eq!(r["ok"], false);
        assert_eq!(r["error"], "timed out after 840 s; stuck at step 2 (click: pop out the chat)");
        assert_eq!(r["steps"].as_array().unwrap().len(), 1);
        assert_eq!(timeout_result("t", &[], None)["error"], "t");
    }

    #[test]
    fn nothing_without_the_variable() {
        assert_eq!(plan_from(env(&[])), None);
        assert_eq!(plan_from(env(&[(STEPS_VAR, "  ")])), None);
        // The other variables alone do nothing.
        assert_eq!(plan_from(env(&[(OUT_VAR, "/tmp/r.json"), (TIMEOUT_VAR, "30")])), None);
    }

    #[test]
    fn the_results_go_next_to_the_steps_unless_named() {
        let p = plan_from(env(&[(STEPS_VAR, "/ci/smoke.json")])).unwrap();
        assert_eq!(p.steps, PathBuf::from("/ci/smoke.json"));
        assert_eq!(p.out, PathBuf::from("/ci/smoke.json.result.json"));
        assert_eq!(p.timeout, DEFAULT_TIMEOUT);
        let p = plan_from(env(&[(STEPS_VAR, "/ci/smoke.json"), (OUT_VAR, "/out/r.json"), (TIMEOUT_VAR, "120")])).unwrap();
        assert_eq!(p.out, PathBuf::from("/out/r.json"));
        assert_eq!(p.timeout, Duration::from_secs(120));
    }

    #[test]
    fn the_timeout_is_kept_sane() {
        let t = |v: &str| plan_from(env(&[(STEPS_VAR, "s.json"), (TIMEOUT_VAR, v)])).unwrap().timeout;
        assert_eq!(t("1"), Duration::from_secs(10));
        assert_eq!(t("999999"), Duration::from_secs(3600));
        assert_eq!(t("soon"), DEFAULT_TIMEOUT);
    }

    #[test]
    fn load_makes_a_temp_vault_or_the_named_one() {
        let dir = std::env::temp_dir().join(format!("vc-selftest-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let steps = dir.join("steps.json");
        std::fs::write(&steps, r#"{"steps":[{"wait":1}]}"#).unwrap();
        let plan = Plan { steps: steps.clone(), out: dir.join("r.json"), timeout: DEFAULT_TIMEOUT };
        let c = load(&plan).unwrap();
        assert!(c.temp_vault);
        assert!(Path::new(&c.vault).is_dir(), "{}", c.vault);
        assert_eq!(c.steps["steps"][0]["wait"], 1);
        std::fs::remove_dir_all(&c.vault).ok();

        let named = dir.join("my vault");
        std::fs::write(&steps, serde_json::json!({ "vault": named, "steps": [] }).to_string()).unwrap();
        let c = load(&plan).unwrap();
        assert!(!c.temp_vault);
        assert!(named.is_dir());

        std::fs::write(&steps, "not json").unwrap();
        assert!(load(&plan).unwrap_err().contains("not JSON"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn results_are_written_whole() {
        let dir = std::env::temp_dir().join(format!("vc-selftest-out-{}", std::process::id()));
        let out = dir.join("nested/r.json");
        write_result(&out, &failure("bad")).unwrap();
        let back: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&out).unwrap()).unwrap();
        assert_eq!(back["ok"], false);
        assert_eq!(back["error"], "bad");
        assert!(!dir.join("nested/r.json.tmp").exists());
        std::fs::remove_dir_all(&dir).ok();
    }
}
