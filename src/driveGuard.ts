// The Drive window's sandbox (src/windowKind.ts isDriveWindow). It is a real copy of the app, so the agent's steps
// exercise the real UI, but nothing it does may reach Carl's state:
//   - storage: localStorage is shared with his main window (same origin), so this window gets an in-memory copy of it,
//     installed before any other module reads it (main.tsx imports this first);
//   - native commands: only reads run (src/tauriCoreGuarded.ts asks driveCommandRefusal before every invoke): no file
//     writes, git, sync, box POSTs (no chat message is ever sent from it), servers, updater, restart, focus;
//   - the box feed: it follows as client=drive and ignores every signal (src/boxChat.ts), so it never answers the agent
//     in Carl's window's place.
import { isDriveWindow } from "./windowKind";

/** Native commands the Drive window may run: reads only. Everything else is refused. */
export const DRIVE_READ_COMMANDS = new Set([
  "read_text_file", "read_binary_file", "list_markdown_files", "list_dir", "glob_files", "path_exists", "read_ignore_lines",
  "notes_read", "schedules_read", "vault_box_config", "vault_sync_status", "vault_sync_role", "vault_page_root",
  "git_repo_root_for_file", "git_log_subdir", "git_file_at", "machine_host", "boot_timing", "box_get_json", "keychain_get",
  "default_voice_prompt", "tailscale_check",
]);
/** Plugin commands it may run (the event bus it talks to the main window on, read-only window/app/path queries). */
const DRIVE_PLUGIN_OK = /^plugin:(event\|(listen|unlisten|emit_to)|app\|(version|name|tauri_version|identifier)|path\|.+|window\|(inner_size|outer_size|inner_position|outer_position|scale_factor|is_.+|title|current_monitor|primary_monitor|available_monitors|theme)|webview\|(get_all_webviews|webview_position|webview_size))$/;

/** Why the Drive window may not run `cmd` (null: it may). */
export function driveCommandRefusal(cmd: string, on = isDriveWindow): string | null {
  if (!on) return null;
  if (DRIVE_READ_COMMANDS.has(cmd) || DRIVE_PLUGIN_OK.test(cmd)) return null;
  return `the Drive window is read-only: "${cmd}" is not run there (no writes, sends, sync or window changes)`;
}

/** An in-memory Storage seeded from the real one. */
export function memoryStorage(seed?: Storage | null): Storage {
  const m = new Map<string, string>();
  try {
    if (seed) for (let i = 0; i < seed.length; i++) { const k = seed.key(i); if (k !== null) m.set(k, seed.getItem(k) ?? ""); }
  } catch { /* unreadable: start empty */ }
  const s = {
    get length() { return m.size; },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => (m.has(String(k)) ? m.get(String(k))! : null),
    setItem: (k: string, v: string) => void m.set(String(k), String(v)),
    removeItem: (k: string) => void m.delete(String(k)),
    clear: () => m.clear(),
  };
  return s as Storage;
}

/** The Drive window's storage is its own copy (it refuses to run steps otherwise). */
export let driveStorageIsolated = false;

if (isDriveWindow && typeof window !== "undefined") {
  try {
    const copy = memoryStorage(window.localStorage);
    Object.defineProperty(window, "localStorage", { value: copy, configurable: true });
    driveStorageIsolated = window.localStorage === copy;
  } catch (e) {
    console.warn("[drive] could not isolate storage:", e);
  }
}

/** The tries a gate run handed this Drive window (`?tries=` JSON, src/driveHost.ts openDriveHost): which drafts it runs
 *  instead of the copies in effect (src/changeReady.ts readTries). Only an app plugin, a vault plugin or the preset, each
 *  at an 8-hex version. Never Carl's tries (his window's storage is not read for them here). */
export function cleanDriveTries(v: unknown): Record<string, string> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 8))
    if ((/^app\/[a-z][a-z0-9-]{0,40}$/.test(k) || /^\.vault-chat\/plugins\/[^/]{1,80}\.m?js$/i.test(k)) && typeof x === "string" && /^[0-9a-f]{8}$/.test(x)) out[k] = x;
  return Object.keys(out).length ? out : null;
}

export const driveTries: Record<string, string> | null = (() => {
  if (!isDriveWindow || typeof location === "undefined") return null;
  try {
    const raw = new URLSearchParams(location.search).get("tries");
    return raw ? cleanDriveTries(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
})();
