// Carl's input, by surface: when each one last sent something he did (a board save, a typed message or answer,
// a voice line or tool, a note, a steer). The health's busy signal counts a surface used in the last
// INPUT_BUSY_MS, so the self-updater (deploy/vault-chat-update.sh: it waits for busy.runs == 0, at most its 2 h
// cap) never restarts the box under someone at work — on 2026-10-22 it restarted it 5 times in 62 minutes, once
// with a board save in flight. Background traffic (long polls, logs, telemetry, pushes, the laptop's git sync) is
// not input.

/** A surface used this recently keeps the box busy. */
export const INPUT_BUSY_MS = 10 * 60_000;

const lastInput = new Map<string, number>();

/** Carl did something on `surface` (board, typed, voice, phone, notes, …). */
export function noteInput(surface: string, now = Date.now()): void {
  lastInput.set(surface, now);
}

/** The surfaces with input in the last INPUT_BUSY_MS, with how many seconds ago. */
export function recentInput(now = Date.now()): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [s, at] of lastInput) if (now - at < INPUT_BUSY_MS) out[s] = Math.round((now - at) / 1000);
  return out;
}

/**
 * Which surface a request is input from, or null when it is not input (reads, long polls, logs, telemetry, pushes,
 * git). `client`: what the request says it is (an intent's `client`, a `device`).
 */
export function inputSurface(method: string, path: string, client?: string | null): string | null {
  if (method !== "POST") return null;
  if (/^\/api\/v1\/boards(\/|$)/.test(path)) return "board";
  if (path.startsWith("/api/v1/voice/")) return "voice";
  if (path === "/api/v2/intent" || path === "/message" || path === "/answer" || path === "/kill" || path === "/api/v1/side" || /^\/api\/v1\/conversations\/[^/]+\/subagents\//.test(path)) {
    return client && /^[a-z-]{1,20}$/.test(client) ? client : "typed";
  }
  if (path === "/notes" || path.startsWith("/notes/") || path.startsWith("/api/v1/inbox/") || path === "/projects" || path === "/conversation/project") return client && /^[a-z-]{1,20}$/.test(client) ? client : "app";
  return null;
}
