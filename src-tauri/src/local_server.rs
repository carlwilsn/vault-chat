//! The server the app runs itself, for a machine with no box.
//!
//! vault-chat's chat has always needed a box: the clients talk HTTP to one, and
//! with none configured the app shows "Connect your box to chat" and stops. The
//! server is the same program either way, so the app can simply run one on
//! loopback and talk to it exactly as it talks to a box — same routes, same
//! feed, same engine.
//!
//! Loopback needs no token: the server authorises a direct 127.0.0.1 caller by
//! that alone (server/auth.ts isDirectLoopback), so there is no secret to mint,
//! store or leak here.
//!
//! One server per vault, as a box serves one vault. It is started on demand and
//! stopped with the app.
//!
//! Which server runs is a swappable part, not the installer's: a server build kept in a versioned slot under the
//! app's state dir runs before the one the installer carries, and falls back to it. The shell only picks, checks and
//! starts; what fills a slot is the server's business (it is told where the slots are, VC_SERVER_SLOTS).
//!   <state>/server-slots/current.json   {"version": "<8 hex>", "sha256": "<64 hex>"}: the slot to run
//!   <state>/server-slots/<version>/vault-chat-server.mjs   its bundle; the file must hash to sha256
//!   <state>/server-slots/bad.json       versions that failed to start here: never run again
//! A slot whose file is missing or hashes otherwise is skipped; one that exits or does not answer health within
//! READY_WAIT is marked bad and the installer's own server is started instead, in the same call.

use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long to let a cold server finish booting before giving up on it.
const READY_WAIT: Duration = Duration::from_secs(90);

#[derive(serde::Serialize, Clone, Debug)]
pub struct LocalServer {
    /// What the clients use as the box url.
    pub url: String,
    /// The vault it serves, so a caller can tell which one answered.
    pub vault: String,
}

struct Live {
    url: String,
    child: Child,
}

static LIVE: Mutex<Option<HashMap<String, Live>>> = Mutex::new(None);
/// Servers still booting, by process id: stop_all takes these too, so an app
/// that quits while one starts (a short self-test, a quick close) leaves none behind.
static STARTING: Mutex<Option<HashMap<u32, Child>>> = Mutex::new(None);

/// A port nobody is on. Bound and dropped: the server races nothing else here,
/// because it is started immediately after.
fn free_port() -> Result<u16, String> {
    let l = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("no free port: {e}"))?;
    l.local_addr().map(|a| a.port()).map_err(|e| format!("no free port: {e}"))
}

/// The server bundle to run: what a packaged app carries, else the repo's build
/// (so the app runs from source in development without extra setup).
fn bundle(resource_dir: Option<&Path>) -> Option<PathBuf> {
    if let Ok(p) = std::env::var("VC_LOCAL_SERVER_BUNDLE") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    if let Some(dir) = resource_dir {
        // binaries/ is where the build puts it (scripts/pack-server-into-app.mjs,
        // tauri.conf.json resources); the bare name is kept for a resource dir
        // laid out by hand.
        for rel in ["binaries/vault-chat-server.mjs", "vault-chat-server.mjs"] {
            let p = dir.join(rel);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()?
        .join("dist-server")
        .join("vault-chat-server.mjs");
    dev.is_file().then_some(dev)
}

/// The Node to run the bundle with.
///
/// A packaged app carries its own (scripts/download-node.mjs puts it in
/// src-tauri/binaries/, tauri.conf.json ships it), because a fresh Windows or
/// Linux machine has none — and without one the app could only say "connect a
/// box instead". VC_LOCAL_SERVER_NODE still wins, so a development run can
/// point at another; failing both, whatever is on PATH, which is how the server
/// is run from source anyway.
pub fn node_bin(resource_dir: Option<&Path>) -> String {
    if let Ok(p) = std::env::var("VC_LOCAL_SERVER_NODE") {
        if !p.trim().is_empty() {
            return p;
        }
    }
    if let Some(dir) = resource_dir {
        let carried = dir.join("binaries").join(if cfg!(windows) { "node.exe" } else { "node" });
        if carried.is_file() {
            return carried.to_string_lossy().to_string();
        }
    }
    "node".to_string()
}

/// No console window for a console program started from this GUI app (Windows
/// flashes one up otherwise).
fn no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

fn health_ok(url: &str) -> bool {
    // A plain blocking GET: this runs on a blocking task, and the only thing
    // being asked is whether the server answers yet.
    //
    // Asked in-process, not by running `curl`. This is the machine with no box
    // — a fresh laptop, whatever it happens to have — and the one that found it
    // had no curl: the server booted, every probe failed because the program
    // was missing, and after 90 s the app told its owner to connect a box while
    // its own server sat there answering. Nothing about "is it up yet" needs a
    // second program.
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .ok()
        .and_then(|c| c.get(format!("{url}/api/v1/health")).send().ok())
        .is_some_and(|r| r.status().is_success())
}

/// Start a server for `vault` if one is not already answering, and say where it
/// is. Idempotent: a second call while one is live returns the same url.
pub fn ensure(vault: &str, state_dir: &Path, resource_dir: Option<&Path>, node: &str) -> Result<LocalServer, String> {
    {
        let mut guard = LIVE.lock().map_err(|_| "local server registry is poisoned".to_string())?;
        let map = guard.get_or_insert_with(HashMap::new);
        if let Some(live) = map.get_mut(vault) {
            // Still answering: the same server, not a second one.
            if matches!(live.child.try_wait(), Ok(None)) && health_ok(&live.url) {
                return Ok(LocalServer { url: live.url.clone(), vault: vault.to_string() });
            }
            // It died or stopped answering: forget it and start again.
            let _ = live.child.kill();
            map.remove(vault);
        }
    }

    // A slot's server first (unless a development run names its own bundle), then the installer's own.
    let named = std::env::var("VC_LOCAL_SERVER_BUNDLE").map(|p| Path::new(&p).is_file()).unwrap_or(false);
    let mut candidates: Vec<(Option<String>, PathBuf)> = Vec::new();
    if !named {
        if let Some(slot) = slot_bundle(state_dir) {
            candidates.push((Some(slot.version), slot.path));
        }
    }
    if let Some(b) = bundle(resource_dir) {
        candidates.push((None, b));
    }
    if candidates.is_empty() {
        return Err("this build carries no vault-chat server to run; connect a box instead".to_string());
    }
    run_first(vault, state_dir, candidates, node)
}

/// Start the first candidate that comes up; a slot's (`Some(version)`) that does not is marked bad on the way.
fn run_first(vault: &str, state_dir: &Path, candidates: Vec<(Option<String>, PathBuf)>, node: &str) -> Result<LocalServer, String> {
    let mut last = String::new();
    for (version, path) in candidates {
        match start(vault, state_dir, &path, node) {
            Ok(s) => return Ok(s),
            Err(e) if e == STOPPED => return Err(e),
            Err(e) => {
                if let Some(v) = version {
                    eprintln!("local server: slot {v} did not start ({e}); running the installer's own");
                    mark_bad(state_dir, &v);
                }
                last = e;
            }
        }
    }
    Err(last)
}

const STOPPED: &str = "the app stopped while the server was starting";

/// A server build kept in a slot (see the module doc).
#[derive(Debug, PartialEq)]
pub struct Slot {
    pub version: String,
    pub path: PathBuf,
}

fn slots_dir(state_dir: &Path) -> PathBuf {
    state_dir.join("server-slots")
}

fn read_bad(state_dir: &Path) -> Vec<String> {
    std::fs::read(slots_dir(state_dir).join("bad.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

/// Never run `version` here again.
fn mark_bad(state_dir: &Path, version: &str) {
    let mut bad = read_bad(state_dir);
    if !bad.iter().any(|b| b == version) {
        bad.push(version.to_string());
    }
    let dir = slots_dir(state_dir);
    let _ = std::fs::create_dir_all(&dir);
    let tmp = dir.join("bad.json.tmp");
    if std::fs::write(&tmp, serde_json::to_vec(&bad).unwrap_or_default()).is_ok() {
        let _ = std::fs::rename(&tmp, dir.join("bad.json"));
    }
}

/// The slot to run: set in current.json, its file there and hashing to the sha256 named, not marked bad. Else None
/// (the installer's own server runs).
pub fn slot_bundle(state_dir: &Path) -> Option<Slot> {
    #[derive(serde::Deserialize)]
    struct Current {
        version: String,
        sha256: String,
    }
    let dir = slots_dir(state_dir);
    let cur: Current = serde_json::from_slice(&std::fs::read(dir.join("current.json")).ok()?).ok()?;
    let hex_ok = |s: &str, n: usize| s.len() == n && s.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c));
    if !hex_ok(&cur.version, 8) || !hex_ok(&cur.sha256, 64) || !cur.sha256.starts_with(&cur.version) {
        return None;
    }
    if read_bad(state_dir).contains(&cur.version) {
        return None;
    }
    let path = dir.join(&cur.version).join("vault-chat-server.mjs");
    let bytes = std::fs::read(&path).ok()?;
    let sha: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
    (sha == cur.sha256).then_some(Slot { version: cur.version, path })
}

/// Start the server bundle at `bundle` for `vault` and wait until it answers health (READY_WAIT).
fn start(vault: &str, state_dir: &Path, bundle: &Path, node: &str) -> Result<LocalServer, String> {
    let port = free_port()?;
    // The voice pipeline insists on an explicit port off the box's default, and
    // the app owns voice itself, so it is left off here.
    let voice_port = free_port()?;
    let own = state_dir.join("local-server");
    std::fs::create_dir_all(&own).map_err(|e| format!("could not make {}: {e}", own.display()))?;

    let mut cmd = Command::new(node);
    no_window(&mut cmd);
    let child = cmd
        .arg(bundle)
        .env("VC_PORT", port.to_string())
        .env("VC_VOICE_PORT", voice_port.to_string())
        .env("VC_VOICE_PIPELINE", "off")
        .env("VC_VAULT", vault)
        .env("VC_STATE_DIR", &own)
        .env("VC_LOCALSTORAGE", own.join("settings.json"))
        .env("VC_TOKEN_FILE", own.join("token"))
        .env("VC_SERVER_SLOTS", slots_dir(state_dir))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("could not start the server with {node}: {e}"))?;

    let url = format!("http://127.0.0.1:{port}");
    let started = Instant::now();
    let pid = child.id();
    STARTING.lock().map_err(|_| "local server registry is poisoned".to_string())?.get_or_insert_with(HashMap::new).insert(pid, child);
    // The booting child, out of STARTING (None: stop_all already took and killed it).
    let take = || STARTING.lock().ok().and_then(|mut g| g.as_mut().and_then(|m| m.remove(&pid)));
    loop {
        {
            let mut guard = STARTING.lock().map_err(|_| "local server registry is poisoned".to_string())?;
            let Some(c) = guard.as_mut().and_then(|m| m.get_mut(&pid)) else {
                return Err(STOPPED.to_string());
            };
            if let Ok(Some(status)) = c.try_wait() {
                if let Some(m) = guard.as_mut() {
                    m.remove(&pid);
                }
                return Err(format!("the server stopped while starting ({status})"));
            }
        }
        if health_ok(&url) {
            break;
        }
        if started.elapsed() > READY_WAIT {
            if let Some(mut c) = take() {
                let _ = c.kill();
            }
            return Err("the server did not answer in time".to_string());
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    let child = take().ok_or_else(|| STOPPED.to_string())?;

    let mut guard = LIVE.lock().map_err(|_| "local server registry is poisoned".to_string())?;
    guard
        .get_or_insert_with(HashMap::new)
        .insert(vault.to_string(), Live { url: url.clone(), child });
    Ok(LocalServer { url, vault: vault.to_string() })
}

/// Stop every server this app started. Called when the app exits, so a run does
/// not leave a server behind holding the vault.
pub fn stop_all() {
    if let Ok(mut guard) = STARTING.lock() {
        if let Some(map) = guard.as_mut() {
            for (_, mut child) in map.drain() {
                let _ = child.kill();
            }
        }
    }
    if let Ok(mut guard) = LIVE.lock() {
        if let Some(map) = guard.as_mut() {
            for (_, mut live) in map.drain() {
                let _ = live.child.kill();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_free_port_is_actually_free() {
        let p = free_port().expect("a port");
        assert!(p > 0);
        // Nothing is listening on it, which is the whole claim.
        assert!(TcpListener::bind(("127.0.0.1", p)).is_ok());
    }

    #[test]
    fn health_is_false_when_nothing_answers() {
        let p = free_port().expect("a port");
        assert!(!health_ok(&format!("http://127.0.0.1:{p}")));
    }

    /// The whole claim, against a real server: no box, so the app runs one and
    /// it answers on loopback. Ignored by default because it starts a process
    /// and needs the server bundle built (`node server/build.mjs`).
    #[test]
    #[ignore = "starts a real vault-chat server (needs dist-server built)"]
    fn a_vault_with_no_box_gets_a_server_that_answers() {
        let root = std::env::temp_dir().join(format!("vc-local-{}", std::process::id()));
        let vault = root.join("vault");
        std::fs::create_dir_all(vault.join("notes")).unwrap();
        let state = root.join("state");
        std::fs::create_dir_all(&state).unwrap();

        let started = Instant::now();
        let s = ensure(vault.to_str().unwrap(), &state, None, "node").expect("a server");
        let took = started.elapsed();
        assert!(s.url.starts_with("http://127.0.0.1:"), "{}", s.url);
        // It is answering, which is what the caller is told.
        assert!(health_ok(&s.url), "health did not answer at {}", s.url);
        eprintln!("local server up at {} in {:?}", s.url, took);

        // Asked again, the same server — not a second one on another port.
        let again = ensure(vault.to_str().unwrap(), &state, None, "node").expect("the same server");
        assert_eq!(again.url, s.url);

        // And the app stopping takes it with it.
        stop_all();
        let gone = Instant::now();
        while health_ok(&s.url) && gone.elapsed() < Duration::from_secs(10) {
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(!health_ok(&s.url), "the server outlived stop_all()");

        // The same server build kept in a slot runs from there, and is not marked bad.
        let built = bundle(None).expect("dist-server built");
        let v = slot(&state, &std::fs::read(&built).unwrap());
        assert!(slot_bundle(&state).is_some());
        let s = ensure(vault.to_str().unwrap(), &state, None, "node").expect("a server from the slot");
        assert!(health_ok(&s.url));
        assert!(!read_bad(&state).contains(&v));
        stop_all();
        std::fs::remove_dir_all(&root).ok();
    }

    fn slot(state: &Path, body: &[u8]) -> String {
        let sha: String = Sha256::digest(body).iter().map(|b| format!("{b:02x}")).collect();
        let v = sha[..8].to_string();
        let d = state.join("server-slots").join(&v);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("vault-chat-server.mjs"), body).unwrap();
        std::fs::write(state.join("server-slots/current.json"), format!(r#"{{"version":"{v}","sha256":"{sha}"}}"#)).unwrap();
        v
    }

    #[test]
    fn a_slot_runs_only_when_intact_and_not_marked_bad() {
        let state = std::env::temp_dir().join(format!("vc-slots-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&state);
        assert_eq!(slot_bundle(&state), None, "no slot: the installer's own");
        let v = slot(&state, b"// a newer server\n");
        assert_eq!(slot_bundle(&state), Some(Slot { version: v.clone(), path: state.join("server-slots").join(&v).join("vault-chat-server.mjs") }));
        // Changed on disk: not the build the pointer names.
        std::fs::write(state.join("server-slots").join(&v).join("vault-chat-server.mjs"), b"// tampered\n").unwrap();
        assert_eq!(slot_bundle(&state), None);
        let v = slot(&state, b"// another\n");
        assert!(slot_bundle(&state).is_some());
        mark_bad(&state, &v);
        assert_eq!(slot_bundle(&state), None, "a slot that failed here is never run again");
        std::fs::write(state.join("server-slots/current.json"), r#"{"version":"../../x","sha256":"0"}"#).unwrap();
        assert_eq!(slot_bundle(&state), None);
        std::fs::remove_dir_all(&state).ok();
    }

    /// A slot whose server dies at start is marked bad and the installer's own is started in the same call.
    #[cfg(unix)]
    #[test]
    fn a_slot_that_does_not_start_falls_back_to_the_installers_own() {
        let root = std::env::temp_dir().join(format!("vc-slot-fallback-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let state = root.join("state");
        std::fs::create_dir_all(&state).unwrap();
        let ran = root.join("baked-ran");
        let v = slot(&state, b"exit 3\n");
        let baked = root.join("baked.sh");
        std::fs::write(&baked, format!("touch '{}'\nexit 4\n", ran.display())).unwrap();
        let s = slot_bundle(&state).unwrap();
        // "/bin/sh" stands in for node: each bundle is a script that exits at once.
        let err = run_first(root.to_str().unwrap(), &state, vec![(Some(s.version), s.path), (None, baked)], "/bin/sh").unwrap_err();
        assert!(err.contains("stopped while starting"), "{err}");
        assert!(ran.is_file(), "the installer's own server was started after the slot's failed");
        assert_eq!(read_bad(&state), vec![v]);
        assert_eq!(slot_bundle(&state), None);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn the_app_runs_the_node_it_carries_unless_told_otherwise() {
        let dir = std::env::temp_dir().join(format!("vc-node-{}", std::process::id()));
        let bins = dir.join("binaries");
        std::fs::create_dir_all(&bins).unwrap();
        let name = if cfg!(windows) { "node.exe" } else { "node" };
        // Nothing carried: whatever is on PATH, as a development run does.
        std::env::remove_var("VC_LOCAL_SERVER_NODE");
        assert_eq!(node_bin(Some(&dir)), "node");
        assert_eq!(node_bin(None), "node");

        // Carried: that one, by its full path — the whole point on a machine
        // that has no Node at all.
        let carried = bins.join(name);
        std::fs::write(&carried, "#!/bin/sh\n").unwrap();
        assert_eq!(node_bin(Some(&dir)), carried.to_string_lossy());

        // Asked for explicitly: that one, over the carried one.
        std::env::set_var("VC_LOCAL_SERVER_NODE", "/usr/bin/node");
        assert_eq!(node_bin(Some(&dir)), "/usr/bin/node");
        std::env::remove_var("VC_LOCAL_SERVER_NODE");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_explicit_bundle_path_wins_and_a_missing_one_is_ignored() {
        let dir = std::env::temp_dir().join(format!("vc-bundle-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let real = dir.join("vault-chat-server.mjs");
        std::fs::write(&real, "// a stand-in\n").unwrap();

        std::env::set_var("VC_LOCAL_SERVER_BUNDLE", &real);
        assert_eq!(bundle(None).as_deref(), Some(real.as_path()));
        // A path that names nothing is not a bundle: fall through to the others
        // rather than trying to run a file that is not there.
        std::env::set_var("VC_LOCAL_SERVER_BUNDLE", dir.join("absent.mjs"));
        let fallback = bundle(Some(&dir));
        assert_eq!(fallback.as_deref(), Some(real.as_path()));
        std::env::remove_var("VC_LOCAL_SERVER_BUNDLE");

        // And with nothing named in the environment: binaries/, which is where
        // the build puts it (scripts/pack-server-into-app.mjs) and where a
        // packaged app therefore carries it.
        let bins = dir.join("binaries");
        std::fs::create_dir_all(&bins).unwrap();
        let packed = bins.join("vault-chat-server.mjs");
        std::fs::write(&packed, "// the packed server\n").unwrap();
        assert_eq!(bundle(Some(&dir)).as_deref(), Some(packed.as_path()));
        std::fs::remove_dir_all(&dir).ok();
    }
}
