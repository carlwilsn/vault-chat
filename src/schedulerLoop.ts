import { useStore } from "./store";
import {
  type Schedule,
  nextFireAt,
  readSchedules,
  writeSchedules,
} from "./schedules";
import { sendMessage } from "./chat-controller";
import { readConversations } from "./conversations";
import { tickRunWatcher } from "./runWatcher";
import { vlog } from "./debugLog";
import { invoke } from "@tauri-apps/api/core";

// Resume sweep runs at most once per vault per app session.
const resumedVaults = new Set<string>();

// Recover missions interrupted by a crash, OS restart, or update relaunch. A
// mission turn flips its thread to "running" before the model call and only
// resets it in a `finally`; a hard process kill skips that, so the mission
// comes back (status reset to idle on load) with an UNANSWERED brief — no
// assistant turn, no workers, wedged forever. On boot we re-run any mission
// whose last message is still a user turn so the supervisor actually starts
// (and ends up with at least one worker, as it always should). Server box only
// — gated by fireSchedulesOnThisMachine, same as schedule firing, so a client
// machine viewing the same vault never double-runs it.
async function resumeInterruptedMissions(vault: string): Promise<void> {
  if (!fireSchedulesOnThisMachine()) return;
  const convs = await readConversations(vault).catch(() => []);
  const cutoff = Date.now() - 72 * 60 * 60 * 1000; // don't resurrect ancient threads
  for (const c of convs) {
    if (c.source !== "mission") continue;
    if ((c.lastActivityAt ?? 0) < cutoff) continue;
    const msgs = (c.messages ?? []).filter((m) => !m.hidden);
    const last = msgs[msgs.length - 1];
    if (!last || last.role !== "user") continue; // completed turns end on an assistant message
    vlog(`[mission-resume] ${c.id} (${c.title}) — re-running interrupted turn`);
    const { runWorkerTurn } = await import("./offVaultRun");
    void runWorkerTurn(vault, c.id, last.content, {
      modelId: useStore.getState().supervisorModelId,
      resume: true,
    }).catch((e) => console.warn("[mission-resume] failed:", e));
  }
}

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

// ---- Firer heartbeat -------------------------------------------------------
// The single-firer gate means exactly ONE machine runs schedules + the
// run-watcher. If that machine goes dark (laptop shut, box powered off) and no
// other machine has firing on, EVERYTHING silently stops — no wakes, no daily
// coach, no run-watching — with nothing to tell you. That's how the summer
// vault's firing died unnoticed for ~4 days. So the firer stamps a heartbeat
// each tick, and any machine that ISN'T firing watches it: if it goes stale,
// alarm the user ONCE instead of failing in silence.
const FIRER_STALE_MS = 12 * 60_000; // no firer tick for this long → it's dark
const FIRER_GRACE_MS = 6 * 60_000; // let a just-opened app wait this long before alarming
const MACHINE_ID_KEY = "vault_chat_machine_id";

function machineId(): string {
  try {
    let id = localStorage.getItem(MACHINE_ID_KEY);
    if (!id) {
      id = "m_" + Math.random().toString(36).slice(2, 10);
      localStorage.setItem(MACHINE_ID_KEY, id);
    }
    return id;
  } catch {
    return "m_unknown";
  }
}

function heartbeatPath(vault: string): string {
  const v = vault.replace(/\\/g, "/").replace(/\/+$/, "");
  return `${v}/.vault-chat/firer-heartbeat.json`;
}

// Throttle the stamp to ~every 2 min (not every 30s tick): the file syncs via
// git, so a per-tick write would churn the repo. 2 min still leaves 6 stamps of
// margin under the 12-min stale threshold.
const lastStamp = new Map<string, number>();
async function stampFirerHeartbeat(vault: string): Promise<void> {
  const now = Date.now();
  if (now - (lastStamp.get(vault) ?? 0) < 110_000) return;
  try {
    await invoke("write_text_file", {
      path: heartbeatPath(vault),
      contents: JSON.stringify({ machineId: machineId(), at: now }),
    });
    lastStamp.set(vault, now); // only on success, so a failed write retries next tick
  } catch {
    // best-effort; a missed stamp just risks a (debounced) false "dark" alarm
  }
}

async function readFirerHeartbeat(vault: string): Promise<{ machineId: string; at: number } | null> {
  try {
    const text = await invoke<string>("read_text_file", { path: heartbeatPath(vault) });
    const o = JSON.parse(text);
    return typeof o?.at === "number" ? o : null;
  } catch {
    return null;
  }
}

// When this (non-firing) machine first started watching each vault — so a
// freshly-opened app doesn't alarm before the real firer has had a chance to
// stamp. And a debounce so we alarm at most once per outage.
const firerWatchStart = new Map<string, number>();
const firerAlarmed = new Set<string>();

async function checkFirerHeartbeat(vault: string): Promise<void> {
  // The firer never alarms — it IS the heartbeat. (Reset the debounce so it can
  // warn again if this machine later stops firing and the next firer dies.)
  if (fireSchedulesOnThisMachine()) {
    firerAlarmed.delete(vault);
    return;
  }
  const now = Date.now();
  if (!firerWatchStart.has(vault)) firerWatchStart.set(vault, now);
  const hb = await readFirerHeartbeat(vault);
  if (hb && now - hb.at < FIRER_STALE_MS) {
    firerAlarmed.delete(vault); // a firer is alive elsewhere — all good
    return;
  }
  if (now - (firerWatchStart.get(vault) ?? now) < FIRER_GRACE_MS) return; // give a real firer time
  if (firerAlarmed.has(vault)) return; // already warned this outage
  firerAlarmed.add(vault);
  const darkMin = hb ? Math.round((now - hb.at) / 60_000) : null;
  vlog("firer.dark", { vault: vault.slice(-12), darkMin });
  try {
    const { notify } = await import("./phoneApp");
    const how = darkMin ? `${darkMin} min` : "a while";
    await notify(
      "info",
      "Scheduled firing is dark",
      `No machine has run a scheduled tick for ${how}. Your wakes, the daily coach, and the run-watcher are all paused. Turn on "fire schedules on this machine" in Settings, or bring your always-on box back up.`,
      "",
      {
        intention: "Reliability · scheduler",
        summary: `Firing dark ${how} — nothing is firing wakes or watching runs.`,
        icon: "⚠️",
        cls: "r",
      },
    );
  } catch (e) {
    console.warn("[firer-heartbeat] alarm failed:", e);
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
  // One-shot on the server box: resume any mission left mid-turn by a
  // crash/restart, so an approved mission never just sits there unworked.
  if (!resumedVaults.has(vault)) {
    resumedVaults.add(vault);
    void resumeInterruptedMissions(vault).catch((e) =>
      console.warn("[mission-resume] sweep failed:", e),
    );
  }
  let cancelled = false;

  const tick = async () => {
    if (cancelled) return;
    const now = Date.now();
    // Re-read from disk every tick. Cheap (small file, sub-ms IPC)
    // and lets git-synced changes from another machine pick up
    // without an app restart. The in-memory cache stays as a fast
    // path for the SchedulesPanel subscriber.
    let fromDisk = await readSchedules(vault).catch(() => null);
    if (fromDisk) {
      // Lifecycle hygiene: a fired one-off is SPENT — delete it. Its result
      // lives in the conversation it ran in (and any Notify it sent); keeping
      // the row around just accumulates dead entries the user has to clean by
      // hand. Covers rows fired (or merely disabled) by old builds too.
      const swept = fromDisk.filter(
        (s) => !(s.recurrence.kind === "once" && s.lastFiredAt),
      );
      if (swept.length !== fromDisk.length) {
        fromDisk = swept;
        void writeSchedules(vault, swept).catch(() => {});
      }
      schedulesByVault.set(vault, fromDisk);
      emit();
    }
    // Watch the firer's heartbeat from EVERY machine (before the gate below): if
    // the machine that's supposed to fire has gone dark and we're not it, alarm —
    // don't let firing die in silence the way it did for ~4 days.
    void checkFirerHeartbeat(vault).catch(() => {});
    // Single-firer gate. We still refresh the in-memory list above (so the
    // SchedulesPanel stays current on every machine), but a machine opted
    // out of firing returns here without touching `lastFiredAt`. Skipping
    // the mark is essential: if a non-firing machine still stamped
    // lastFiredAt and pushed it, the firing machine would read it as
    // "already fired" and skip — silently disabling the schedule.
    if (!fireSchedulesOnThisMachine()) return;
    // We ARE the firer this tick — stamp the heartbeat so other machines can see
    // firing is alive (and don't alarm).
    void stampFirerHeartbeat(vault).catch(() => {});
    // Poll any long external jobs (training runs etc.) handed to the run-watcher.
    // Deterministic recheck in code — independent of whether the agent
    // remembered to self-schedule a wake. Same firing-machine gate as schedules.
    void tickRunWatcher(vault).catch((e) =>
      console.warn("[run-watcher] tick failed:", e),
    );
    const list = (schedulesByVault.get(vault) ?? []).slice();
    let changed = false;
    for (const s of list) {
      if (!s.enabled) continue;
      const fireAt = nextFireAt(s, s.lastFiredAt ?? s.createdAt ?? 0);
      if (fireAt === null) continue;
      if (fireAt > now) continue;
      // Optimistic mark so a slow agent run doesn't double-fire. A one-off
      // that's firing right now is spent — it self-destructs in the same
      // write (fireOnce already holds its own copy of the schedule).
      const updated = {
        ...s,
        lastFiredAt: now,
        enabled: s.recurrence.kind === "once" ? false : s.enabled,
      };
      const cur = schedulesByVault.get(vault) ?? [];
      const next =
        s.recurrence.kind === "once"
          ? cur.filter((x) => x.id !== s.id)
          : cur.map((x) => (x.id === s.id ? updated : x));
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
