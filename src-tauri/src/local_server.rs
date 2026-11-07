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
use std::collections::HashMap;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long to let a cold server finish booting before giving up on it.
const READY_WAIT: Duration = Duration::from_secs(90);

#[derive(serde::Serialize, Clone)]
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
        let p = dir.join("vault-chat-server.mjs");
        if p.is_file() {
            return Some(p);
        }
    }
    let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()?
        .join("dist-server")
        .join("vault-chat-server.mjs");
    dev.is_file().then_some(dev)
}

fn health_ok(url: &str) -> bool {
    // A plain blocking GET: this runs on a blocking task, and the only thing
    // being asked is whether the server answers yet.
    match std::process::Command::new("curl")
        .args(["-fsS", "--max-time", "3", &format!("{url}/api/v1/health")])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
    {
        Ok(s) => s.success(),
        Err(_) => false,
    }
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

    let bundle = bundle(resource_dir).ok_or_else(|| {
        "this build carries no vault-chat server to run; connect a box instead".to_string()
    })?;
    let port = free_port()?;
    // The voice pipeline insists on an explicit port off the box's default, and
    // the app owns voice itself, so it is left off here.
    let voice_port = free_port()?;
    let own = state_dir.join("local-server");
    std::fs::create_dir_all(&own).map_err(|e| format!("could not make {}: {e}", own.display()))?;

    let child = Command::new(node)
        .arg(&bundle)
        .env("VC_PORT", port.to_string())
        .env("VC_VOICE_PORT", voice_port.to_string())
        .env("VC_VOICE_PIPELINE", "off")
        .env("VC_VAULT", vault)
        .env("VC_STATE_DIR", &own)
        .env("VC_LOCALSTORAGE", own.join("settings.json"))
        .env("VC_TOKEN_FILE", own.join("token"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("could not start the server with {node}: {e}"))?;

    let url = format!("http://127.0.0.1:{port}");
    let started = Instant::now();
    let mut child = child;
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("the server stopped while starting ({status})"));
        }
        if health_ok(&url) {
            break;
        }
        if started.elapsed() > READY_WAIT {
            let _ = child.kill();
            return Err("the server did not answer in time".to_string());
        }
        std::thread::sleep(Duration::from_millis(250));
    }

    let mut guard = LIVE.lock().map_err(|_| "local server registry is poisoned".to_string())?;
    guard
        .get_or_insert_with(HashMap::new)
        .insert(vault.to_string(), Live { url: url.clone(), child });
    Ok(LocalServer { url, vault: vault.to_string() })
}

/// Stop every server this app started. Called when the app exits, so a run does
/// not leave a server behind holding the vault.
pub fn stop_all() {
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
        std::fs::remove_dir_all(&root).ok();
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
        std::fs::remove_dir_all(&dir).ok();
    }
}
