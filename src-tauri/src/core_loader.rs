//! The core loader: the small part of the shell that decides which frontend ("core") bundle the app runs, outside any
//! bundle (src/coreBundle.ts says what a bundle is). The box builds a core bundle from each accepted main and serves it;
//! the frontend asks for it and hands it here (`core_install`), and this keeps a checked copy on disk and serves it at
//! the app's own origin (the same storage and IPC as the baked one) through a Tauri asset provider.
//!
//! - Choice at launch: `state.json`'s current bundle when it is installed and the shell has every command and plugin it
//!   needs, else the bundle baked into the installer. A new installer (another shell version) starts from its own.
//! - Ready handshake: every load of a box bundle in the main window must call `core_ready` within READY; an error thrown
//!   before that (the init script below), or no ready in time, or a launch that finds the last load never said ready,
//!   falls back: to the previous bundle, then to the baked one, and reloads. The fallback is remembered (the bundle is
//!   marked bad) and reported to the box by the frontend once it is up (`core_status` events, then `core_events_sent`).
//! - Install: the manifest's bytes must hash to the sha256 the box's record names (whose first 8 digits are the
//!   version), every file to its manifest entry; files already held by another installed bundle are copied, not fetched.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::borrow::Cow;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};
use tauri::{AppHandle, Assets, Manager, Runtime};

/// How long a freshly loaded box bundle has to call `core_ready` (src/coreBundle.ts READY_MS).
pub const READY: Duration = Duration::from_secs(30);
/// The Tauri plugins this shell carries (the `@tauri-apps/plugin-*` packages a bundle may import).
pub const SHELL_PLUGINS: &[&str] = &["autostart", "dialog", "opener", "process", "single-instance", "updater"];
const BUILT_IN: &str = "built-in";
const MAX_EVENTS: usize = 20;

#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
pub struct Fallback {
    pub from: String,
    pub to: String,
    pub reason: String,
    pub at_ms: u64,
}

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct State {
    /// The shell version that wrote this (another one: a new installer, whose own bundle starts).
    #[serde(default)]
    pub shell: String,
    pub current: Option<String>,
    pub previous: Option<String>,
    /// Versions that said ready at least once.
    #[serde(default)]
    pub proven: Vec<String>,
    /// Versions that failed to boot here: never taken again.
    #[serde(default)]
    pub bad: Vec<String>,
    /// The version whose last load has not said ready yet (a launch that finds it set: that load never came up).
    pub booting: Option<String>,
    /// Fallbacks the frontend has not told the box yet.
    #[serde(default)]
    pub events: Vec<Fallback>,
}

#[derive(Deserialize)]
struct ManifestFile {
    path: String,
    sha256: String,
    size: u64,
}
#[derive(Deserialize)]
struct Needs {
    commands: Vec<String>,
    plugins: Vec<String>,
}
#[derive(Deserialize)]
struct Manifest {
    commit: String,
    needs: Needs,
    files: Vec<ManifestFile>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn hex(b: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(b);
    h.finalize().iter().map(|x| format!("{x:02x}")).collect()
}

/// A bundle file's path: relative, forward slashes, no `..`, no odd names (src/coreBundle.ts safeCorePath).
pub fn safe_path(p: &str) -> bool {
    if p.is_empty() || p.len() > 300 || p.starts_with('/') || p.contains('\\') {
        return false;
    }
    p.split('/').all(|s| {
        !s.is_empty()
            && s != "."
            && s != ".."
            && s.chars().next().map_or(false, |c| c.is_ascii_alphanumeric() || "@_+-".contains(c))
            && s.chars().all(|c| c.is_ascii_alphanumeric() || "@_.+-".contains(c))
    })
}

fn version_ok(v: &str) -> bool {
    v.len() == 8 && v.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

/// What this shell lacks for a manifest's needs (empty: it can run the bundle).
fn missing(needs: &Needs, commands: &[&str]) -> Vec<String> {
    let mut out: Vec<String> = needs.commands.iter().filter(|c| !commands.contains(&c.as_str())).map(|c| format!("command {c}")).collect();
    out.extend(needs.plugins.iter().filter(|p| !SHELL_PLUGINS.contains(&p.as_str())).map(|p| format!("plugin {p}")));
    out
}

/// Fetches one URL's bytes from the box (status, body). Tests pass their own.
pub type Fetch<'a> = dyn Fn(&str) -> Result<(u16, Vec<u8>), String> + 'a;

pub struct CoreLoader {
    root: PathBuf,
    shell: String,
    commands: Vec<&'static str>,
    inner: Mutex<Inner>,
    /// The bundle served now (its files folder), read on every asset request.
    active: RwLock<Option<PathBuf>>,
}

struct Inner {
    state: State,
    active: Option<String>,
    /// Counts loads of the main window; a ready or a timeout names the load it is about.
    load: u64,
    ready: bool,
}

impl CoreLoader {
    /// Open the store at `root`, and pick what this launch runs.
    pub fn open(root: PathBuf, shell: &str, commands: Vec<&'static str>) -> Self {
        let mut state: State = std::fs::read(root.join("state.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        if state.shell != shell {
            // A new installer: its own bundle is at least as new as anything held for the last one.
            let events = std::mem::take(&mut state.events);
            state = State { shell: shell.to_string(), events, ..Default::default() };
        }
        let me = CoreLoader { root, shell: shell.to_string(), commands, inner: Mutex::new(Inner { state, active: None, load: 0, ready: false }), active: RwLock::new(None) };
        {
            let mut g = me.inner.lock().unwrap();
            // The last load of this version never said ready (the app crashed or was killed while it booted).
            if let (Some(b), Some(c)) = (g.state.booting.clone(), g.state.current.clone()) {
                if b == c && !g.state.proven.contains(&c) {
                    me.fall_back_locked(&mut g, &format!("{c} did not come up the last time it was loaded"));
                }
            }
            // The chosen one must be here and runnable, else the previous, else the baked one.
            loop {
                let Some(c) = g.state.current.clone() else { break };
                match me.runnable(&c) {
                    Ok(()) => break,
                    Err(why) => me.fall_back_locked(&mut g, &why),
                }
            }
            let cur = g.state.current.clone();
            me.set_active_locked(&mut g, cur);
            me.save(&g.state);
        }
        me
    }

    fn dir(&self, v: &str) -> PathBuf {
        self.root.join(v)
    }

    fn manifest(&self, v: &str) -> Result<Manifest, String> {
        let b = std::fs::read(self.dir(v).join("manifest.json")).map_err(|_| format!("{v} is not installed"))?;
        serde_json::from_slice(&b).map_err(|e| format!("{v}: a bad manifest ({e})"))
    }

    /// Whether `v` is installed, its index is there, and this shell has all it needs.
    fn runnable(&self, v: &str) -> Result<(), String> {
        let m = self.manifest(v)?;
        if !self.dir(v).join("files").join("index.html").is_file() {
            return Err(format!("{v} is incomplete"));
        }
        let lack = missing(&m.needs, &self.commands);
        if lack.is_empty() {
            Ok(())
        } else {
            Err(format!("{v} needs a newer installed app ({})", lack.into_iter().take(4).collect::<Vec<_>>().join(", ")))
        }
    }

    fn save(&self, s: &State) {
        let _ = std::fs::create_dir_all(&self.root);
        let tmp = self.root.join("state.json.tmp");
        if let Ok(b) = serde_json::to_vec_pretty(s) {
            if std::fs::write(&tmp, b).is_ok() {
                let _ = std::fs::rename(&tmp, self.root.join("state.json"));
            }
        }
    }

    fn set_active_locked(&self, g: &mut Inner, v: Option<String>) {
        *self.active.write().unwrap() = v.as_ref().map(|v| self.dir(v).join("files"));
        g.active = v;
        g.ready = false;
    }

    /// Current → previous (when it can run), else the baked one; the failed one is marked bad and the step recorded.
    fn fall_back_locked(&self, g: &mut Inner, reason: &str) {
        let Some(from) = g.state.current.take() else { return };
        if !g.state.bad.contains(&from) {
            g.state.bad.push(from.clone());
        }
        let prev = g.state.previous.take().filter(|p| *p != from && !g.state.bad.contains(p) && self.runnable(p).is_ok());
        g.state.current = prev.clone();
        g.state.booting = None;
        g.state.events.push(Fallback { from, to: prev.unwrap_or_else(|| BUILT_IN.into()), reason: reason.chars().take(300).collect(), at_ms: now_ms() });
        let n = g.state.events.len();
        if n > MAX_EVENTS {
            g.state.events.drain(0..n - MAX_EVENTS);
        }
    }

    /// The files folder served now (None: the baked bundle).
    pub fn active_dir(&self) -> Option<PathBuf> {
        self.active.read().unwrap().clone()
    }

    /// The main window started loading: a box bundle now has READY to say ready. Returns the load's number to watch,
    /// or None (the baked bundle: nothing to fall back to).
    pub fn page_started(&self) -> Option<u64> {
        let mut g = self.inner.lock().unwrap();
        g.load += 1;
        g.ready = false;
        let v = g.active.clone()?;
        g.state.booting = Some(v);
        self.save(&g.state);
        Some(g.load)
    }

    /// The bundle said ready (main window).
    pub fn ready(&self) {
        let mut g = self.inner.lock().unwrap();
        g.ready = true;
        if let Some(v) = g.active.clone() {
            if !g.state.proven.contains(&v) {
                g.state.proven.push(v);
            }
            g.state.booting = None;
            self.save(&g.state);
        }
    }

    /// Load `load` is over its time without ready, or threw before it: fall back. True when it did (reload then).
    pub fn failed(&self, load: Option<u64>, reason: &str) -> bool {
        let mut g = self.inner.lock().unwrap();
        if g.ready || g.active.is_none() || load.map_or(false, |l| l != g.load) {
            return false;
        }
        self.fall_back_locked(&mut g, reason);
        let cur = g.state.current.clone();
        self.set_active_locked(&mut g, cur);
        self.save(&g.state);
        true
    }

    /// Run `v` (None: the baked bundle) from the next load on; what ran becomes the previous one.
    pub fn use_version(&self, v: Option<String>) -> Result<(), String> {
        if let Some(v) = &v {
            if !version_ok(v) {
                return Err("not a core version".into());
            }
            self.runnable(v)?;
        }
        let mut g = self.inner.lock().unwrap();
        if g.state.current != v {
            g.state.previous = g.state.current.take().or(g.state.previous.take());
            g.state.current = v.clone();
        }
        if let Some(v) = &v {
            g.state.bad.retain(|b| b != v);
        }
        self.set_active_locked(&mut g, v);
        self.save(&g.state);
        Ok(())
    }

    pub fn status(&self) -> serde_json::Value {
        let g = self.inner.lock().unwrap();
        let commit = g.active.as_ref().and_then(|v| self.manifest(v).ok()).map(|m| m.commit);
        serde_json::json!({
            "shell": self.shell,
            "active": g.active.clone().unwrap_or_else(|| BUILT_IN.into()),
            "activeCommit": commit,
            "ready": g.ready,
            "current": g.state.current,
            "previous": g.state.previous,
            "proven": g.active.as_ref().map_or(true, |v| g.state.proven.contains(v)),
            "bad": g.state.bad,
            "events": g.state.events,
            "commands": self.commands,
            "plugins": SHELL_PLUGINS,
            "baked": { "commit": option_env!("VC_BAKED_COMMIT").unwrap_or(""), "commitTime": option_env!("VC_BAKED_TIME").and_then(|t| t.parse::<u64>().ok()) },
        })
    }

    /// The first `n` events were told to the box.
    pub fn events_sent(&self, n: usize) {
        let mut g = self.inner.lock().unwrap();
        let n = n.min(g.state.events.len());
        g.state.events.drain(0..n);
        self.save(&g.state);
    }

    /// Fetch, check and keep bundle `version` (`sha256`: its manifest's, from the box's record). Already here: done.
    pub fn install(&self, version: &str, sha256: &str, fetch: &Fetch) -> Result<(), String> {
        if !version_ok(version) || sha256.len() != 64 || !sha256.starts_with(version) {
            return Err("version and sha256 do not match".into());
        }
        let final_dir = self.dir(version);
        if let Ok(b) = std::fs::read(final_dir.join("manifest.json")) {
            if hex(&b) == sha256 && final_dir.join("files").join("index.html").is_file() {
                return Ok(());
            }
        }
        let (status, mbytes) = fetch(&format!("/api/v2/core/{version}/manifest.json"))?;
        if status != 200 {
            return Err(format!("the box answered {status} for {version}'s manifest"));
        }
        if hex(&mbytes) != sha256 {
            return Err(format!("{version}'s manifest does not match its record's hash: refused"));
        }
        let m: Manifest = serde_json::from_slice(&mbytes).map_err(|e| format!("a bad manifest: {e}"))?;
        let lack = missing(&m.needs, &self.commands);
        if !lack.is_empty() {
            return Err(format!("needs a newer installed app ({})", lack.join(", ")));
        }
        if m.files.iter().any(|f| !safe_path(&f.path) || f.sha256.len() != 64) || !m.files.iter().any(|f| f.path == "index.html") {
            return Err("a bad manifest: its file list".into());
        }
        // Files the other installed bundles hold, by hash.
        let mut have: std::collections::HashMap<String, PathBuf> = std::collections::HashMap::new();
        if let Ok(rd) = std::fs::read_dir(&self.root) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if !version_ok(&name) || name == version {
                    continue;
                }
                if let Ok(om) = self.manifest(&name) {
                    for f in om.files {
                        have.entry(f.sha256).or_insert_with(|| e.path().join("files").join(&f.path));
                    }
                }
            }
        }
        let tmp = self.root.join(format!(".{version}.part"));
        let _ = std::fs::remove_dir_all(&tmp);
        for f in &m.files {
            let to = tmp.join("files").join(&f.path);
            std::fs::create_dir_all(to.parent().unwrap()).map_err(|e| e.to_string())?;
            let local = have.get(&f.sha256).and_then(|p| std::fs::read(p).ok()).filter(|b| hex(b) == f.sha256);
            let bytes = match local {
                Some(b) => b,
                None => {
                    let (s, b) = fetch(&format!("/api/v2/core/{version}/files/{}", f.path))?;
                    if s != 200 {
                        return Err(format!("the box answered {s} for {}", f.path));
                    }
                    if hex(&b) != f.sha256 || b.len() as u64 != f.size {
                        let _ = std::fs::remove_dir_all(&tmp);
                        return Err(format!("{} does not match its hash: refused", f.path));
                    }
                    b
                }
            };
            std::fs::write(&to, bytes).map_err(|e| e.to_string())?;
        }
        std::fs::write(tmp.join("manifest.json"), &mbytes).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_dir_all(&final_dir);
        std::fs::rename(&tmp, &final_dir).map_err(|e| e.to_string())?;
        self.prune(version);
        Ok(())
    }

    /// Keep the current, previous, active and just-installed bundles; the rest go.
    fn prune(&self, keep_also: &str) {
        let g = self.inner.lock().unwrap();
        let keep: Vec<String> = [g.state.current.clone(), g.state.previous.clone(), g.active.clone(), Some(keep_also.to_string())].into_iter().flatten().collect();
        drop(g);
        if let Ok(rd) = std::fs::read_dir(&self.root) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if version_ok(&name) && !keep.contains(&name) {
                    let _ = std::fs::remove_dir_all(e.path());
                }
            }
        }
    }
}

/// The app's asset provider: the active box bundle's files, else the baked bundle.
pub struct CoreAssets<R: Runtime> {
    baked: Box<dyn Assets<R>>,
    loader: Arc<CoreLoader>,
}

impl<R: Runtime> Assets<R> for CoreAssets<R> {
    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        if let Some(dir) = self.loader.active_dir() {
            let rel = key.as_ref().trim_start_matches('/');
            if !safe_path(rel) {
                return None;
            }
            return std::fs::read(dir.join(rel)).ok().map(Cow::Owned);
        }
        self.baked.get(key)
    }
    fn iter(&self) -> Box<AssetsIter<'_>> {
        self.baked.iter()
    }
    fn csp_hashes(&self, html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        self.baked.csp_hashes(html_path)
    }
}

static LOADER: OnceLock<Arc<CoreLoader>> = OnceLock::new();
static APP: OnceLock<AppHandle> = OnceLock::new();

/// Where the bundles live: the app's data folder (what Tauri's app_data_dir is), `core/`.
fn store_root(identifier: &str) -> PathBuf {
    #[cfg(windows)]
    let base = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library").join("Application Support"));
    #[cfg(all(unix, not(target_os = "macos")))]
    let base = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local").join("share")));
    base.unwrap_or_else(std::env::temp_dir).join(identifier).join("core")
}

/// Put the loader in front of the baked bundle, before the app is built. `commands`: this shell's command names.
pub fn install(context: &mut tauri::Context<tauri::Wry>, commands: Vec<&'static str>) {
    let root = store_root(&context.config().identifier);
    let shell = context.config().version.clone().unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());
    let loader = Arc::new(CoreLoader::open(root, &shell, commands));
    let _ = LOADER.set(loader.clone());
    struct Placeholder;
    impl Assets<tauri::Wry> for Placeholder {
        fn get(&self, _: &AssetKey) -> Option<Cow<'_, [u8]>> {
            None
        }
        fn iter(&self) -> Box<AssetsIter<'_>> {
            Box::new(std::iter::empty())
        }
        fn csp_hashes(&self, _: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
            Box::new(std::iter::empty())
        }
    }
    let baked = context.set_assets(Box::new(Placeholder));
    context.set_assets(Box::new(CoreAssets { baked, loader }));
}

/// Before any bundle's own code: an error thrown before the bundle said ready is a failed boot.
const INIT_SCRIPT: &str = r#"(function(){try{if(window.top!==window)return;var w=window,sent=false;w.addEventListener('error',function(e){if(w.__vcCoreReady||sent||!(e instanceof ErrorEvent))return;var i=w.__TAURI_INTERNALS__;if(!i||!i.invoke)return;sent=true;i.invoke('core_boot_error',{message:String(e.message||'error').slice(0,300)}).catch(function(){});},true);}catch(_){}})();"#;

fn reload_all(app: &AppHandle) {
    for w in app.webview_windows().values() {
        let _ = w.reload();
    }
}

/// The loader's plugin: the init script, and the ready watch on every load of the main window.
pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::<R>::new("core-loader")
        .js_init_script(INIT_SCRIPT.to_string())
        .on_page_load(|webview, payload| {
            if webview.label() != "main" || payload.event() != tauri::webview::PageLoadEvent::Started {
                return;
            }
            let Some(loader) = LOADER.get().cloned() else { return };
            let Some(load) = loader.page_started() else { return };
            std::thread::spawn(move || {
                std::thread::sleep(READY);
                if loader.failed(Some(load), &format!("did not say ready within {} s", READY.as_secs())) {
                    if let Some(app) = APP.get() {
                        reload_all(app);
                    }
                }
            });
        })
        .build()
}

/// Called from the app's setup: the handle the fallbacks reload windows with.
pub fn setup(app: &AppHandle) {
    let _ = APP.set(app.clone());
}

fn loader() -> Result<Arc<CoreLoader>, String> {
    LOADER.get().cloned().ok_or_else(|| "no core loader".to_string())
}

#[tauri::command]
pub fn core_status() -> Result<serde_json::Value, String> {
    Ok(loader()?.status())
}

#[tauri::command]
pub fn core_ready(window: tauri::Window) -> Result<(), String> {
    if window.label() == "main" {
        loader()?.ready();
    }
    Ok(())
}

#[tauri::command]
pub fn core_boot_error(window: tauri::Window, app: AppHandle, message: String) -> Result<bool, String> {
    if window.label() != "main" {
        return Ok(false);
    }
    let fell = loader()?.failed(None, &format!("threw before it was ready: {message}"));
    if fell {
        reload_all(&app);
    }
    Ok(fell)
}

#[tauri::command]
pub async fn core_install(base_url: String, token: Option<String>, version: String, sha256: String) -> Result<(), String> {
    let l = loader()?;
    tauri::async_runtime::spawn_blocking(move || {
        let base = base_url.trim_end_matches('/').to_string();
        let fetch = |path: &str| crate::box_sync::get_bytes(&format!("{base}{path}"), token.as_deref(), 60_000);
        l.install(&version, &sha256, &fetch)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Run `version` (null: the baked bundle) now: every window reloads.
#[tauri::command]
pub fn core_use(app: AppHandle, version: Option<String>) -> Result<(), String> {
    loader()?.use_version(version.filter(|v| v != BUILT_IN))?;
    reload_all(&app);
    Ok(())
}

/// The native Undo (src-tauri/src/safety.rs): run the core the last switch replaced (else the installer's own) and
/// reload every window. False when there is no loader.
pub fn revert_core(app: &AppHandle) -> bool {
    let Ok(l) = loader() else { return false };
    let prev = l.inner.lock().unwrap().state.previous.clone();
    if l.use_version(prev).is_err() {
        let _ = l.use_version(None);
    }
    reload_all(app);
    true
}

#[tauri::command]
pub fn core_events_sent(n: usize) -> Result<(), String> {
    loader()?.events_sent(n);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    const CMDS: &[&str] = &["read_text_file", "app_ready", "core_ready"];

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("vc-core-loader-{name}-{}-{}", std::process::id(), now_ms()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// A box serving bundles: path -> bytes. Returns (version, sha256) of a bundle with these files and needs.
    fn bundle(server: &mut HashMap<String, Vec<u8>>, files: &[(&str, &str)], commands: &[&str]) -> (String, String) {
        let list: Vec<serde_json::Value> = files.iter().map(|(p, c)| serde_json::json!({"path": p, "sha256": hex(c.as_bytes()), "size": c.len()})).collect();
        let m = serde_json::json!({"schema": 1, "commit": "0".repeat(40), "commitTime": 1, "builtAt": "x", "needs": {"commands": commands, "plugins": ["dialog"], "boxApi": 1}, "files": list});
        let text = serde_json::to_vec(&m).unwrap();
        let sha = hex(&text);
        let v = sha[..8].to_string();
        server.insert(format!("/api/v2/core/{v}/manifest.json"), text);
        for (p, c) in files {
            server.insert(format!("/api/v2/core/{v}/files/{p}"), c.as_bytes().to_vec());
        }
        (v, sha)
    }

    fn fetcher(server: &HashMap<String, Vec<u8>>) -> impl Fn(&str) -> Result<(u16, Vec<u8>), String> + '_ {
        move |p: &str| Ok(server.get(p).map(|b| (200, b.clone())).unwrap_or((404, vec![])))
    }

    #[test]
    fn installs_checked_and_refuses_a_wrong_hash() {
        let root = tmp("install");
        let mut srv = HashMap::new();
        let (v, sha) = bundle(&mut srv, &[("index.html", "<p>one</p>"), ("assets/a.js", "1")], &["app_ready"]);
        let l = CoreLoader::open(root.clone(), "1.0.0", CMDS.to_vec());
        // The record names another hash: refused.
        let wrong = format!("{v}{}", "0".repeat(56));
        assert!(l.install(&v, &wrong, &fetcher(&srv)).is_err());
        // A file changed on the way: refused, nothing kept.
        let mut bad = srv.clone();
        bad.insert(format!("/api/v2/core/{v}/files/assets/a.js"), b"2".to_vec());
        assert!(l.install(&v, &sha, &fetcher(&bad)).unwrap_err().contains("does not match"));
        assert!(!root.join(&v).exists());
        l.install(&v, &sha, &fetcher(&srv)).unwrap();
        assert_eq!(std::fs::read(root.join(&v).join("files/assets/a.js")).unwrap(), b"1");
    }

    #[test]
    fn refuses_a_bundle_needing_commands_the_shell_lacks() {
        let root = tmp("needs");
        let mut srv = HashMap::new();
        let (v, sha) = bundle(&mut srv, &[("index.html", "x")], &["app_ready", "brand_new_command"]);
        let l = CoreLoader::open(root, "1.0.0", CMDS.to_vec());
        assert!(l.install(&v, &sha, &fetcher(&srv)).unwrap_err().contains("brand_new_command"));
    }

    #[test]
    fn a_broken_bundle_falls_back_to_the_previous_then_the_baked_one() {
        let root = tmp("fallback");
        let mut srv = HashMap::new();
        let (good, gsha) = bundle(&mut srv, &[("index.html", "<p>good</p>")], &["app_ready"]);
        // Deliberately broken: its script throws before it can call ready.
        let (broken, bsha) = bundle(&mut srv, &[("index.html", "<script>throw new Error('boom')</script>")], &["app_ready"]);
        let l = CoreLoader::open(root.clone(), "1.0.0", CMDS.to_vec());
        l.install(&good, &gsha, &fetcher(&srv)).unwrap();

        // The good one runs and says ready.
        l.use_version(Some(good.clone())).unwrap();
        l.install(&broken, &bsha, &fetcher(&srv)).unwrap();
        let load = l.page_started();
        assert!(load.is_some());
        l.ready();
        assert!(!l.failed(load, "late"), "a bundle that said ready is never failed afterwards");
        assert_eq!(l.active_dir(), Some(root.join(&good).join("files")));

        // The broken one is taken, loads, throws before ready (the init script's core_boot_error): back to the good one.
        l.use_version(Some(broken.clone())).unwrap();
        let _load = l.page_started();
        assert!(l.failed(None, "threw before it was ready: boom"));
        assert_eq!(l.active_dir(), Some(root.join(&good).join("files")));
        let s = l.status();
        assert_eq!(s["active"], good);
        assert!(s["bad"].as_array().unwrap().iter().any(|b| b == &serde_json::json!(broken)));
        assert_eq!(s["events"][0]["from"], broken);
        assert_eq!(s["events"][0]["to"], good);

        // Now the good one never says ready in time either: nothing left but the baked bundle.
        let load = l.page_started();
        assert!(l.failed(load, "did not say ready within 30 s"));
        assert_eq!(l.active_dir(), None);
        assert_eq!(l.status()["active"], BUILT_IN);
        assert_eq!(l.status()["events"][1]["to"], BUILT_IN);
        // The baked bundle has nothing to fall back to and is never watched.
        assert_eq!(l.page_started(), None);
    }

    #[test]
    fn a_launch_after_a_load_that_never_came_up_starts_on_the_previous_one() {
        let root = tmp("crash");
        let mut srv = HashMap::new();
        let (good, gsha) = bundle(&mut srv, &[("index.html", "good")], &["app_ready"]);
        let (broken, bsha) = bundle(&mut srv, &[("index.html", "broken")], &["app_ready"]);
        {
            let l = CoreLoader::open(root.clone(), "1.0.0", CMDS.to_vec());
            l.install(&good, &gsha, &fetcher(&srv)).unwrap();
            l.use_version(Some(good.clone())).unwrap();
            l.page_started();
            l.ready();
            l.install(&broken, &bsha, &fetcher(&srv)).unwrap();
            l.use_version(Some(broken.clone())).unwrap();
            l.page_started(); // ... and the process dies before ready
        }
        let l = CoreLoader::open(root.clone(), "1.0.0", CMDS.to_vec());
        assert_eq!(l.status()["active"], good);
        // A new installer starts from its own bundle.
        let l = CoreLoader::open(root, "1.0.1", CMDS.to_vec());
        assert_eq!(l.status()["active"], BUILT_IN);
    }

    #[test]
    fn a_missing_or_incompatible_bundle_at_launch_runs_the_baked_one() {
        let root = tmp("missing");
        let mut srv = HashMap::new();
        let (v, sha) = bundle(&mut srv, &[("index.html", "x")], &["app_ready"]);
        {
            let l = CoreLoader::open(root.clone(), "1.0.0", CMDS.to_vec());
            l.install(&v, &sha, &fetcher(&srv)).unwrap();
            l.use_version(Some(v.clone())).unwrap();
            l.page_started();
            l.ready();
        }
        // The next shell build lacks a command it needs (same version string: a dev build): the baked one runs.
        let l = CoreLoader::open(root.clone(), "1.0.0", vec!["read_text_file"]);
        assert_eq!(l.status()["active"], BUILT_IN);
        assert!(l.status()["events"][0]["reason"].as_str().unwrap().contains("app_ready"));
    }

    #[test]
    fn safe_paths_only() {
        assert!(safe_path("assets/index-AbC_1.js"));
        assert!(safe_path("index.html"));
        assert!(!safe_path("../x"));
        assert!(!safe_path("/etc/passwd"));
        assert!(!safe_path("a\\b"));
        assert!(!safe_path("a//b"));
        assert!(!safe_path(".hidden"));
    }
}
