// Schedules (`.vault-chat/schedules.jsonl`), fired on the box only: the server
// starts this loop for its vault and hands it `fire`, which gives the prompt to
// the box's engine (pi) — the same as a message from any client. Every 30 s the
// loop re-reads the file (git sync brings edits made elsewhere) and fires what
// is due; a fired one-off is spent and removed.
import { invoke } from "@tauri-apps/api/core";
import { type Schedule, nextFireAt, readSchedules, writeSchedules } from "./schedules";
import { vlog } from "./debugLog";

/** Give a due schedule's prompt to the engine: into its conversation, or a new one (null). */
export type ScheduleFire = (convId: string | null, prompt: string) => Promise<void>;

const loops = new Set<string>();

export async function startSchedulerLoop(vault: string, fire: ScheduleFire): Promise<void> {
  if (loops.has(vault)) return;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      let list = await readSchedules(vault).catch(() => null);
      if (!list) return;
      const now = Date.now();
      // A fired one-off is spent (its result is in the conversation it ran in).
      let changed = list.some((s) => s.recurrence.kind === "once" && s.lastFiredAt);
      list = list.filter((s) => !(s.recurrence.kind === "once" && s.lastFiredAt));
      const due: Schedule[] = [];
      list = list.map((s) => {
        if (!s.enabled) return s;
        const at = nextFireAt(s, s.lastFiredAt ?? s.createdAt ?? 0);
        if (at === null || at > now) return s;
        due.push(s);
        changed = true;
        return { ...s, lastFiredAt: now, enabled: s.recurrence.kind === "once" ? false : s.enabled };
      });
      // Marked fired before firing, so a slow turn never fires twice.
      if (changed) await writeSchedules(vault, list).catch(() => {});
      for (const s of due) {
        vlog("sched.fire", { name: s.name, target: s.target.kind });
        const convId = s.target.kind === "existing" ? s.target.conversationId : null;
        await fire(convId, s.prompt).catch((e) => console.warn("[scheduler] fire failed:", e));
      }
    } finally {
      busy = false;
    }
  };
  loops.add(vault);
  setInterval(() => void tick(), 30_000);
  void tick();
}

async function update(vault: string, f: (list: Schedule[]) => Schedule[]): Promise<void> {
  await writeSchedules(vault, f(await readSchedules(vault)));
}

export async function deleteSchedule(vault: string, id: string): Promise<void> {
  // Tombstone first: schedules.jsonl is merge=union, so an omission alone comes
  // back when another copy that still holds the row syncs.
  await invoke("schedule_tombstone_add", { vault, id }).catch((e) => console.warn("[scheduler] tombstone write failed:", e));
  await update(vault, (l) => l.filter((x) => x.id !== id));
}

export async function toggleSchedule(vault: string, id: string, enabled: boolean): Promise<void> {
  await update(vault, (l) => l.map((x) => (x.id === id ? { ...x, enabled } : x)));
}
