import { invoke } from "@tauri-apps/api/core";

// A tiny per-vault file recording, per conversation, when an in-flight run
// last made progress (a tool fired) and whether it's still running. A
// supervisor schedule reads this to tell a healthy long run from a hung
// one: the conversation's own `lastActivityAt` only advances when a message
// is appended, so during a single long multi-step turn it looks frozen even
// when the agent is working hard. The heartbeat is the missing signal.
//
// Shape: { [conversationId]: { lastProgressAt, lastTool, running } }.
// Stored at <vault>/.vault-chat/run-heartbeat.json. Best-effort and
// advisory — every write swallows errors, and a rare lost update from two
// parallel runs self-corrects on the next bump.

export type Heartbeat = { lastProgressAt: number; lastTool?: string; running: boolean };
type HeartbeatFile = Record<string, Heartbeat>;

// Throttle disk writes per conversation so a tool-heavy turn doesn't hammer
// the file. A supervisor polling every few minutes doesn't need finer.
const MIN_WRITE_GAP_MS = 10_000;
const lastWriteAt = new Map<string, number>();

function hbPath(vault: string): string {
  return `${vault}/.vault-chat/run-heartbeat.json`;
}

async function load(vault: string): Promise<HeartbeatFile> {
  try {
    const raw = await invoke<string>("read_text_file", { path: hbPath(vault) });
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as HeartbeatFile) : {};
  } catch {
    return {};
  }
}

async function save(vault: string, file: HeartbeatFile): Promise<void> {
  try {
    await invoke("write_text_file", {
      path: hbPath(vault),
      contents: JSON.stringify(file, null, 2),
    });
  } catch {
    // best-effort
  }
}

// Mark progress for a running conversation. Throttled unless `force`.
export async function bumpHeartbeat(
  vault: string,
  convId: string,
  lastTool?: string,
  force = false,
): Promise<void> {
  const now = Date.now();
  if (!force && now - (lastWriteAt.get(convId) ?? 0) < MIN_WRITE_GAP_MS) return;
  lastWriteAt.set(convId, now);
  const file = await load(vault);
  file[convId] = { lastProgressAt: now, lastTool, running: true };
  await save(vault, file);
}

// Mark a run finished so the supervisor doesn't read a stale "running".
export async function endHeartbeat(vault: string, convId: string): Promise<void> {
  lastWriteAt.delete(convId);
  const file = await load(vault);
  if (file[convId]) {
    file[convId] = { ...file[convId]!, running: false, lastProgressAt: Date.now() };
    await save(vault, file);
  }
}
