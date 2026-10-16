//! Startup timing: how long the process has been up, and every time the main
//! (UI) thread stopped answering during the first minutes.
//!
//! On Windows a synchronous `#[tauri::command]` runs on the main thread; while
//! it runs the window pumps no messages, and after ~5 s Windows paints "Not
//! responding". A watcher thread posts a no-op to the main thread every 100 ms
//! and times how long it takes to run; anything ≥ 250 ms is recorded. The
//! frontend reads the record (`boot_timing`) once startup settles and writes it
//! to the vault's app-log.txt with its own boot marks, so a slow launch says
//! where the time went.

use serde::Serialize;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const WATCH_FOR: Duration = Duration::from_secs(180);
const TICK: Duration = Duration::from_millis(100);
const STALL_MS: u64 = 250;
const MAX_STALLS: usize = 200;

static START: OnceLock<Instant> = OnceLock::new();
static STALLS: Mutex<Vec<Stall>> = Mutex::new(Vec::new());

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
pub struct Stall {
    /// When the stall began, in ms since the process started.
    pub at_ms: u64,
    /// How long the main thread did not answer.
    pub ms: u64,
}

#[derive(Serialize, Debug)]
pub struct BootTiming {
    /// ms since the process started (the Rust entry point), now.
    pub uptime_ms: u64,
    /// Main-thread stalls ≥ 250 ms seen so far (first 3 minutes only).
    pub stalls: Vec<Stall>,
}

/// Call first thing in `run()`.
pub fn mark_process_start() {
    let _ = START.get_or_init(Instant::now);
}

fn since_start(t: Instant) -> u64 {
    let s = *START.get_or_init(Instant::now);
    t.saturating_duration_since(s).as_millis() as u64
}

fn record(stall: Stall) {
    let mut v = STALLS.lock().unwrap_or_else(|e| e.into_inner());
    if v.len() < MAX_STALLS {
        v.push(stall);
    }
}

/// Start the watcher. `post` must run its closure on the main thread
/// (`AppHandle::run_on_main_thread`) and return false once it can't.
pub fn watch_main_thread<F>(post: F)
where
    F: Fn(Box<dyn FnOnce() + Send + 'static>) -> bool + Send + 'static,
{
    let _ = std::thread::Builder::new()
        .name("boot-watch".into())
        .spawn(move || {
            let began = Instant::now();
            while began.elapsed() < WATCH_FOR {
                let sent = Instant::now();
                let (tx, rx) = std::sync::mpsc::channel::<()>();
                if !post(Box::new(move || {
                    let _ = tx.send(());
                })) {
                    return;
                }
                if rx.recv().is_err() {
                    return; // event loop gone
                }
                let ms = sent.elapsed().as_millis() as u64;
                if ms >= STALL_MS {
                    record(Stall { at_ms: since_start(sent), ms });
                }
                std::thread::sleep(TICK);
            }
        });
}

pub fn timing() -> BootTiming {
    BootTiming {
        uptime_ms: since_start(Instant::now()),
        stalls: STALLS.lock().unwrap_or_else(|e| e.into_inner()).clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_blocked_main_thread_is_recorded_and_a_quick_one_is_not() {
        mark_process_start();
        // A fake "main thread": runs posted closures after a delay the test picks.
        let (tx, rx) = std::sync::mpsc::channel::<(Box<dyn FnOnce() + Send>, u64)>();
        let delays = std::sync::Arc::new(Mutex::new(vec![0u64, 400, 0]));
        std::thread::spawn(move || {
            while let Ok((f, d)) = rx.recv() {
                std::thread::sleep(Duration::from_millis(d));
                f();
            }
        });
        let d2 = delays.clone();
        let tx = Mutex::new(tx);
        watch_main_thread(move |f| {
            let mut d = d2.lock().unwrap();
            if d.is_empty() {
                return false;
            }
            let delay = d.remove(0);
            tx.lock().unwrap().send((f, delay)).is_ok()
        });
        std::thread::sleep(Duration::from_millis(900));
        let t = timing();
        assert_eq!(t.stalls.len(), 1, "{:?}", t.stalls);
        assert!(t.stalls[0].ms >= 400 && t.stalls[0].ms < 800, "{:?}", t.stalls);
        assert!(t.uptime_ms >= 900);
    }
}
