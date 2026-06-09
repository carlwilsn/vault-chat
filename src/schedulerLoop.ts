import { useStore } from "./store";
import {
  type Schedule,
  nextFireAt,
  readSchedules,
  writeSchedules,
} from "./schedules";
import { sendMessage } from "./chat-controller";
import { vlog } from "./debugLog";

// Multi-vault scheduler. Each tracked vault gets its own loop that
// reads its schedules.jsonl every 30s and fires any due schedules.
// Firing runs the agent against the target conversation — same vault
// path either way, just different execution surface:
//   - Vault is the currently-active one in the UI → use the chat-
//     controller send pipeline with targetConvIdOverride so the
//     in-memory store reflects the new turn (user sees it on the
//     next click into that conversation).
//   - Vault is not active → headless run via offVaultRun, writing
//     directly to that vault's conversations.jsonl on disk.
//
// Schedules fire whether or not their vault has UI focus, so a
// `/remind` scheduled at 9pm fires at 9pm even if you're working in
// a different vault at the time.

type ActiveLoop = {
  vault: string;
  cancel: () => void;
};

const active = new Map<string, ActiveLoop>();
const schedulesByVault = new Map<string, Schedule[]>();
const listeners = new Set<(s: Schedule[]) => void>();

function emit() {
  // Subscribers see only the currently-active vault's schedules —
  // the SchedulesPanel UI is per-vault.
  const activeVault = useStore.getState().vaultPath;
  const list = activeVault ? schedulesByVault.get(activeVault) ?? [] : [];
  for (const l of listeners) l(list);
}

export function subscribeSchedules(fn: (s: Schedule[]) => void): () => void {
  listeners.add(fn);
  const activeVault = useStore.getState().vaultPath;
  fn(activeVault ? schedulesByVault.get(activeVault) ?? [] : []);
  return () => listeners.delete(fn);
}

export function getSchedules(): Schedule[] {
  const activeVault = useStore.getState().vaultPath;
  return activeVault ? schedulesByVault.get(activeVault) ?? [] : [];
}

const TRACKED_VAULTS_KEY = "vault_chat_tracked_vaults";

// Single-firer gate (machine-local). The scheduler loop runs on EVERY
// machine that has the app open — there is no server/consumer role. When
// the same vault is open on two machines, both loops independently see a
// schedule as due and fire it, because the optimistic `lastFiredAt` mark
// only propagates between machines via git (pull interval ~30s), far
// slower than the fire window. The result is one daily check-in running
// as two divergent agent turns.
//
// The fix is to let secondary machines opt OUT of firing. The flag is
// deliberately stored in localStorage and NOT in
// <vault>/.vault-chat/config.json: config.json is git-tracked and synced,
// so an opt-out written there would propagate to every machine and turn
// firing off everywhere — the one failure mode we must avoid. localStorage
// is per-install, so each machine owns its own answer.
//
// Default is ON. A fresh install fires; you must explicitly disable on a
// secondary box. That asymmetry is intentional: the worst case of a
// misconfiguration is the pre-existing double-fire, never silence.
const FIRE_ON_THIS_MACHINE_KEY = "vault_chat_fire_schedules_on_this_machine";

export function fireSchedulesOnThisMachine(): boolean {
  try {
    return localStorage.getItem(FIRE_ON_THIS_MACHINE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function setFireSchedulesOnThisMachine(on: boolean): void {
  try {
    // Store only the opt-out; absence means the default (fire).
    if (on) localStorage.removeItem(FIRE_ON_THIS_MACHINE_KEY);
    else localStorage.setItem(FIRE_ON_THIS_MACHINE_KEY, "false");
  } catch {
    // localStorage unavailable — the default (fire) stands.
  }
}

export function getTrackedVaults(): string[] {
  try {
    const raw = localStorage.getItem(TRACKED_VAULTS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
}

function addTrackedVault(vault: string): void {
  const list = getTrackedVaults();
  if (!list.includes(vault)) {
    localStorage.setItem(
      TRACKED_VAULTS_KEY,
      JSON.stringify([...list, vault]),
    );
  }
}

export async function startSchedulerLoop(vault: string): Promise<void> {
  addTrackedVault(vault);
  if (active.has(vault)) return; // idempotent
  const initialSchedules = await readSchedules(vault).catch(() => []);
  schedulesByVault.set(vault, initialSchedules);
  emit();
  let cancelled = false;

  const tick = async () => {
    if (cancelled) return;
    const now = Date.now();
    // Re-read from disk every tick. Cheap (small file, sub-ms IPC)
    // and lets git-synced changes from another machine pick up
    // without an app restart. The in-memory cache stays as a fast
    // path for the SchedulesPanel subscriber.
    const fromDisk = await readSchedules(vault).catch(() => null);
    if (fromDisk) {
      schedulesByVault.set(vault, fromDisk);
      emit();
    }
    // Single-firer gate. We still refresh the in-memory list above (so the
    // SchedulesPanel stays current on every machine), but a machine opted
    // out of firing returns here without touching `lastFiredAt`. Skipping
    // the mark is essential: if a non-firing machine still stamped
    // lastFiredAt and pushed it, the firing machine would read it as
    // "already fired" and skip — silently disabling the schedule.
    if (!fireSchedulesOnThisMachine()) return;
    const list = (schedulesByVault.get(vault) ?? []).slice();
    let changed = false;
    for (const s of list) {
      if (!s.enabled) continue;
      const fireAt = nextFireAt(s, s.lastFiredAt ?? s.createdAt ?? 0);
      if (fireAt === null) continue;
      if (fireAt > now) continue;
      // Optimistic mark so a slow agent run doesn't double-fire.
      const updated = { ...s, lastFiredAt: now };
      const cur = schedulesByVault.get(vault) ?? [];
      const next = cur.map((x) => (x.id === s.id ? updated : x));
      schedulesByVault.set(vault, next);
      changed = true;
      void writeSchedules(vault, next).catch(() => {});
      void fireOnce(vault, updated).catch((e) =>
        console.warn("[scheduler] fire failed:", e),
      );
    }
    if (changed) emit();
  };

  const interval = window.setInterval(() => {
    void tick();
  }, 30_000);
  // Initial tick so opening the app right at fire time doesn't wait
  // 30s.
  void tick();

  active.set(vault, {
    vault,
    cancel: () => {
      cancelled = true;
      window.clearInterval(interval);
    },
  });
}

export function stopSchedulerLoop(vault?: string): void {
  if (vault) {
    const a = active.get(vault);
    if (a) {
      a.cancel();
      active.delete(vault);
    }
    schedulesByVault.delete(vault);
  } else {
    for (const a of active.values()) a.cancel();
    active.clear();
    schedulesByVault.clear();
  }
  emit();
}

async function fireOnce(vault: string, s: Schedule): Promise<void> {
  // Resolve target conversation. Either existing (most common from
  // the Schedule tool, which binds to the current chat) or fresh.
  let conversationId: string;
  if (s.target.kind === "existing") {
    conversationId = s.target.conversationId;
  } else {
    conversationId = await createScheduledConversation(vault, s);
  }

  const store = useStore.getState();
  const isActiveVault = store.vaultPath === vault;

  // Positive "a schedule fired at T" marker — covers both fire paths, so even
  // a wake that produces nothing leaves a trail (the self-scheduled supervisor
  // watch is a chain of these; a missing marker is how I spot a broken relay).
  vlog("sched.fire", {
    name: s.name,
    conv: conversationId.slice(0, 8),
    active: isActiveVault,
  });

  if (isActiveVault) {
    // Active vault: run via chat-controller. targetConvIdOverride
    // routes the agent run to the right conversation without yanking
    // focus from whatever the user has open.
    const prevModel = store.modelId;
    if (s.modelId && s.modelId !== prevModel) {
      store.setModelId(s.modelId);
    }
    await sendMessage(
      s.prompt,
      undefined,
      undefined,
      conversationId,
      s.sendViaTelegram,
      s.quietUnlessAlert,
    ).catch((e) =>
      console.warn("[scheduler] active-vault sendMessage failed:", e),
    );
    if (s.modelId && s.modelId !== prevModel) {
      // Restore. sendMessage above resolves once the run is enqueued;
      // model swap happens inside the run, so restoring the picker
      // selection right away is the right move.
      store.setModelId(prevModel);
    }
    return;
  }

  // Non-active vault: headless run on disk. Pass the schedule's pinned
  // model so a heavy sweep keeps the model it was configured with instead
  // of silently dropping to the cheap Telegram brain.
  const { runScheduledHeadlessTurn } = await import("./offVaultRun");
  await runScheduledHeadlessTurn(vault, conversationId, s.prompt, {
    sendViaTelegram: s.sendViaTelegram,
    modelId: s.modelId,
    quietUnlessAlert: s.quietUnlessAlert,
  });
}

async function createScheduledConversation(vault: string, s: Schedule): Promise<string> {
  const isActiveVault = useStore.getState().vaultPath === vault;
  if (isActiveVault) {
    const id = useStore.getState().newConversation();
    useStore.setState({
      conversations: useStore.getState().conversations.map((c) =>
        c.id === id
          ? { ...c, source: "scheduled" as const, title: scheduleTitle(s) }
          : c,
      ),
    });
    return id;
  }
  // Non-active vault: build directly on disk via offVaultRun.
  const { createScheduledConversationOnDisk } = await import("./offVaultRun");
  return createScheduledConversationOnDisk(vault, scheduleTitle(s));
}

function scheduleTitle(s: Schedule): string {
  if (s.name?.trim()) return s.name.trim();
  return s.prompt.split(/\s+/).slice(0, 5).join(" ") || "Scheduled run";
}

// CRUD ops that keep both memory and disk in sync. These operate on
// the currently-active vault — the SchedulesPanel UI is per-vault.
export async function saveSchedule(
  vault: string,
  s: Schedule,
): Promise<void> {
  const list = schedulesByVault.get(vault) ?? (await readSchedules(vault).catch(() => []));
  const idx = list.findIndex((x) => x.id === s.id);
  const next = idx >= 0 ? list.map((x) => (x.id === s.id ? s : x)) : [...list, s];
  schedulesByVault.set(vault, next);
  emit();
  await writeSchedules(vault, next);
}

export async function deleteSchedule(vault: string, id: string): Promise<void> {
  const list = schedulesByVault.get(vault) ?? [];
  const next = list.filter((x) => x.id !== id);
  schedulesByVault.set(vault, next);
  emit();
  await writeSchedules(vault, next);
}

export async function toggleSchedule(
  vault: string,
  id: string,
  enabled: boolean,
): Promise<void> {
  const list = schedulesByVault.get(vault) ?? [];
  const next = list.map((x) => (x.id === id ? { ...x, enabled } : x));
  schedulesByVault.set(vault, next);
  emit();
  await writeSchedules(vault, next);
}

// Force a reload of the schedules list for a vault. Useful when the
// agent's Schedule tool writes a new schedule and we want the loop
// to see it before the next 30s tick.
export async function reloadSchedulesForVault(vault: string): Promise<void> {
  const list = await readSchedules(vault).catch(() => []);
  schedulesByVault.set(vault, list);
  emit();
}
