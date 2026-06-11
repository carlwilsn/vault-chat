import { invoke } from "@tauri-apps/api/core";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";

// "Run in background" turns vault-chat into an always-on personal daemon:
// closing the window hides it to the system tray instead of quitting, and
// the app is registered to start at login. The renderer keeps running while
// hidden, so the scheduler loop and the supervisor's self-scheduled wakes
// keep firing — that's what lets a long-horizon task make progress and
// surface check-ins while the window is shut.
//
// This is machine-local (localStorage, NOT git-synced config.json). A vault
// can be open on a laptop and an always-on box; only the box should run in
// the background and start at login. Same reasoning as the single-firer gate
// in schedulerLoop.ts: a synced flag would turn the daemon on everywhere.
//
// Default is OFF. Existing behaviour (close window = quit) is preserved until
// the user opts in from Settings, so we never surprise anyone with a process
// that refuses to die.

const RUN_IN_BG_KEY = "vault_chat_run_in_background";

export function isRunInBackground(): boolean {
  try {
    return localStorage.getItem(RUN_IN_BG_KEY) === "true";
  } catch {
    return false;
  }
}

// Push the current preference to the Rust side (which gates the
// close-to-tray behaviour) and keep the OS login-item registration in sync.
// Best-effort on both: a failure to toggle autostart must not leave the
// in-app setting lying about its state, so we still persist the flag.
async function apply(on: boolean): Promise<void> {
  await invoke("set_run_in_background", { enabled: on }).catch((e) =>
    console.warn("[background] set_run_in_background failed:", e),
  );
  try {
    const already = await isEnabled();
    if (on && !already) await enable();
    else if (!on && already) await disable();
  } catch (e) {
    console.warn("[background] autostart sync failed:", e);
  }
}

export async function setRunInBackground(on: boolean): Promise<void> {
  try {
    if (on) localStorage.setItem(RUN_IN_BG_KEY, "true");
    else localStorage.removeItem(RUN_IN_BG_KEY);
  } catch {
    // localStorage unavailable — the default (off) stands; still try to
    // apply so the current session behaves as asked.
  }
  await apply(on);
}

// Called once at boot to reconcile the persisted preference with the Rust
// gate and the OS login item (e.g. a setting changed on another launch, or
// the login item was removed by the user out-of-band).
export async function initBackgroundMode(): Promise<void> {
  await apply(isRunInBackground());
}
