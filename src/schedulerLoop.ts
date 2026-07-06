import { useStore } from "./store";
import {
  type Schedule,
  type Recurrence,
  nextFireAt,
  readSchedules,
  writeSchedules,
} from "./schedules";
import { sendMessage } from "./chat-controller";
import { readConversations } from "./conversations";
import { tickRunWatcher } from "./runWatcher";
import { vlog } from "./debugLog";
import { harnessV2Enabled } from "./harness";
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
  // Enabled, not-yet-fired wakes bound to a conversation — used below to avoid
  // re-waking a mission that already has a scheduled tick coming.
  const schedules = await (await import("./schedules")).readSchedules(vault).catch(() => []);
  const hasPendingWake = (id: string) =>
    schedules.some((sc) => {
      const t = sc.target as { kind?: string; conversationId?: string };
      return (
        sc.enabled &&
        t?.kind === "existing" &&
        t.conversationId === id &&
        (sc.recurrence?.kind !== "once" || !sc.lastFiredAt)
      );
    });
  for (const c of convs) {
    if (c.source !== "mission") continue;
    if ((c.lastActivityAt ?? 0) < cutoff) continue;
    if (c.completedAt || c.missionState === "DONE" || c.missionState === "KILLED") continue;
    const msgs = (c.messages ?? []).filter((m) => !m.hidden);
    const last = msgs[msgs.length - 1];
    if (!last) continue;
    if (last.role === "user") {
      // Interrupted mid-brief: the last message is still an unanswered user turn
      // (a hard kill skipped the status reset), so the supervisor never started.
      vlog(`[mission-resume] ${c.id} (${c.title}) — re-running interrupted turn`);
      const { runWorkerTurn } = await import("./offVaultRun");
      void runWorkerTurn(vault, c.id, last.content, {
        modelId: useStore.getState().supervisorModelId,
        resume: true,
      }).catch((e) => console.warn("[mission-resume] failed:", e));
      continue;
    }
    // [restart-durable worker wake] A mission parked after spawning a worker; the
    // worker then FINISHED, but its finish wake lived only in phoneApp's IN-MEMORY
    // queue, which a restart (the auto-update a multi-day run WILL hit) drops — so
    // the supervisor never woke to review/recover and the mission stalls silently.
    // On boot, re-post a review wake when a worker finished AFTER the mission's
    // last turn (i.e. unreviewed), no worker is still live, and no wake is already
    // scheduled. Skip AWAITING_USER — that's a legitimate wait on the user.
    if (!harnessV2Enabled()) continue;
    if (c.missionState === "AWAITING_USER") continue;
    if (hasPendingWake(c.id)) continue;
    const key = (c.mission ?? c.title ?? "").trim();
    const workers = convs.filter(
      (w) => w.source === "worker" && (w.mission ?? w.title ?? "").trim() === key,
    );
    if (workers.some((w) => w.status === "running")) continue; // a live worker's finish will wake it
    const finishedUnreviewed = workers.filter(
      (w) =>
        w.status !== "running" &&
        (w.messages ?? []).some((m) => m.role === "assistant" && !m.hidden) &&
        (w.lastActivityAt ?? 0) > (c.lastActivityAt ?? 0),
    );
    if (!finishedUnreviewed.length) continue;
    const names = finishedUnreviewed.map((w) => `"${w.title}" (id ${w.id})`).join(", ");
    vlog("mission-resume.worker-wake", { conv: c.id.slice(0, 8), workers: finishedUnreviewed.length });
    const { runWorkerTurn } = await import("./offVaultRun");
    void runWorkerTurn(
      vault,
      c.id,
      `Your worker(s) ${names} finished while the app was restarting — the finish wake was not delivered. Review their thread(s) now: a worker may have FAILED and written a failure doc. Then continue the mission — verify a real deliverable exists on disk, reseed a fresh worker if one failed, or CompleteMission if the goal is genuinely met. Do not assume success without reading the files.`,
      { modelId: useStore.getState().supervisorModelId },
    ).catch((e) => console.warn("[mission-resume] worker-wake failed:", e));
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

// Process-global guard against firing the same schedule SLOT twice. The
// optimistic `lastFiredAt` mark dedups within a single loop, but the same
// physical vault can be driven by MORE THAN ONE loop in this process — it gets
// tracked under path-variant keys (slash direction / case / trailing slash) and
// every map here is keyed on the raw string, so each variant spins its own loop
// with its own in-memory schedule state. Both then fire the same slot a few ms
// apart (the duplicate 7am coach: two `scheduled` threads 20ms apart, one box,
// the laptop's firing off). A claim on canonical(vault)|scheduleId|fireAt, taken
// SYNCHRONOUSLY at the fire decision, lets only the first loop win — JS is
// single-threaded, so the second loop's tick callback always sees the claim.
// (In-process only: this does not coordinate across machines — that's the
// accepted, far-rarer git-sync race.)
const firedSlots = new Set<string>();
function canonicalVault(v: string): string {
  return v.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

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

// ---- Firing-dark detection -------------------------------------------------
// The single-firer gate means exactly ONE machine runs schedules + the
// run-watcher. If that machine goes dark (laptop shut, box powered off) and no
// other machine has firing on, EVERYTHING silently stops — no wakes, no daily
// coach, no run-watching — with nothing to tell you. That's how the summer
// vault's firing died unnoticed for ~4 days.
//
// We detect this WITHOUT a heartbeat file. An earlier design had the firer
// stamp `firer-heartbeat.json` each tick and non-firers watch it — but that
// file is gitignored (it churned git history), so it never syncs between
// machines. A non-firer reads only its OWN stale local copy and false-alarms
// "dark" forever, even while the real firer fires fine on another box. (That
// false alarm is exactly what this replaces.)
//
// Instead, derive liveness from data that DOES sync: each schedule's
// `lastFiredAt` lives in schedules.jsonl and merges carrying the MAX across
// machines. If the firer is alive, every recurring schedule fires on its
// cadence and stays fresh; a recurring schedule overdue past its own interval +
// grace means firing is genuinely dark. The tightest-cadence schedule drives
// detection speed, and the check no longer cares which machine is firing.
const FIRER_GRACE_MS = 6 * 60_000; // let a just-opened app wait this long before alarming

// Expected interval between fires for a recurring schedule, or null if the
// recurrence has no ongoing cadence we can check (once) or can't compute
// generically (cron). weekdays/weekly use generous windows so a legitimate
// weekend/week gap never reads as dark.
function recurringIntervalMs(r: Recurrence): number | null {
  const D = 24 * 3_600_000;
  switch (r.kind) {
    case "every":
      return Math.max(1, r.minutes) * 60_000;
    case "daily":
      return D;
    case "weekdays":
      return Math.round(3.4 * D); // covers a Fri→Mon gap
    case "weekly":
      return Math.round(7.5 * D);
    case "once":
    case "cron":
      return null;
    default:
      return null;
  }
}

// Firing is "dark" if any enabled, recurring schedule is overdue past its own
// interval + grace, measured against the synced lastFiredAt (or createdAt if it
// has never fired). Returns the worst overdue age in minutes, or 0 if healthy
// (or if there's nothing checkable to judge by).
function firingDarkMinutes(schedules: Schedule[], now: number): number {
  let worst = 0;
  for (const s of schedules) {
    if (!s.enabled) continue;
    const interval = recurringIntervalMs(s.recurrence);
    if (interval == null) continue;
    // Grace scales with cadence but is bounded: snappy for frequent schedules,
    // tolerant of sync lag for a daily/weekly. 5 min floor, 90 min ceiling.
    const grace = Math.min(90 * 60_000, Math.max(5 * 60_000, interval * 0.5));
    const base = s.lastFiredAt ?? s.createdAt ?? now;
    const age = now - base;
    if (age > interval + grace) worst = Math.max(worst, Math.round(age / 60_000));
  }
  return worst;
}

// When this (non-firing) machine first started watching each vault — so a
// freshly-opened app doesn't alarm before the real firer has had a chance to
// stamp.
const firerWatchStart = new Map<string, number>();
// "Firing is dark" is a MACHINE-global condition, NOT per-vault: one always-on
// box fires every tracked vault, so when it goes down all vaults detect dark in
// the same tick and each used to emit its own identical "Scheduled firing is
// dark" card (the duplicate spam in the Alerts feed). Debounce GLOBALLY so a
// single outage produces ONE alarm regardless of how many vaults are tracked;
// re-armed only once a live firer is seen again. (All vaults move dark→live
// together under the single-box model, so this never thrashes in practice.)
let firingDarkAlarmed = false;

async function checkFirerHeartbeat(vault: string): Promise<void> {
  // The firer never alarms about itself. (Reset the debounce so it can warn
  // again if this machine later stops firing and the next firer dies.)
  if (fireSchedulesOnThisMachine()) {
    firingDarkAlarmed = false;
    return;
  }
  const now = Date.now();
  if (!firerWatchStart.has(vault)) firerWatchStart.set(vault, now);
  if (now - (firerWatchStart.get(vault) ?? now) < FIRER_GRACE_MS) return; // give a real firer time
  const darkMin = firingDarkMinutes(schedulesByVault.get(vault) ?? [], now);
  if (darkMin === 0) {
    firingDarkAlarmed = false; // a firer is alive elsewhere — all good
    return;
  }
  if (firingDarkAlarmed) return; // already warned this outage (across all vaults)
  // Before alarming, cross-check a signal that ACTUALLY syncs across machines.
  // `lastFiredAt` can read stale on a follower that's behind on its git pull —
  // that's what fired a "dark for 3698 min" alarm at the user while the daily
  // coach had in fact fired that very morning (two threads, even). Recent
  // scheduled/mission activity is hard proof a firer is alive: if any such turn
  // landed more recently than the overdue age we're about to report, the report
  // is stale — suppress it rather than cry wolf.
  try {
    const convs = await readConversations(vault).catch(() => []);
    const freshestAuto = convs
      .filter((c) => c.source === "scheduled" || c.source === "mission")
      .reduce((mx, c) => Math.max(mx, c.lastActivityAt ?? 0), 0);
    if (freshestAuto && now - freshestAuto < darkMin * 60_000) {
      firingDarkAlarmed = false; // something fired recently — not actually dark
      vlog("firer.dark.suppressed", {
        vault: vault.slice(-12),
        darkMin,
        lastAutoMinAgo: Math.round((now - freshestAuto) / 60_000),
      });
      return;
    }
  } catch {
    // Can't read conversations — fall through and alarm (better a false warn
    // than silent death, the failure mode this whole check exists to prevent).
  }
  firingDarkAlarmed = true;
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
    // Watch for dark firing from EVERY machine (before the gate below): if the
    // machine that's supposed to fire has gone dark and we're not it, alarm —
    // don't let firing die in silence the way it did for ~4 days. Judged off the
    // synced schedule lastFiredAt, so a non-firer sees the real firer's activity.
    void checkFirerHeartbeat(vault).catch(() => {});
    // Single-firer gate. We still refresh the in-memory list above (so the
    // SchedulesPanel stays current on every machine), but a machine opted
    // out of firing returns here without touching `lastFiredAt`. Skipping
    // the mark is essential: if a non-firing machine still stamped
    // lastFiredAt and pushed it, the firing machine would read it as
    // "already fired" and skip — silently disabling the schedule.
    if (!fireSchedulesOnThisMachine()) return;
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
      // Cross-loop claim on this exact slot (see firedSlots above). If another
      // loop for this same vault already took it this slot, don't fire it again.
      const slotKey = `${canonicalVault(vault)}|${s.id}|${fireAt}`;
      // Day-level claim for once-a-day-or-rarer recurrences: a same-machine
      // double-fire (two loops, path-variant vault keys, or a slot-time drift
      // of a few minutes) computes a DIFFERENT slotKey but the SAME calendar
      // day — that's how the 7am coach shipped two contradictory briefings 20ms
      // apart. Interval ("every") schedules are meant to fire many times a day,
      // so they keep only the exact-slot guard.
      const oncePerDay =
        s.recurrence.kind === "daily" ||
        s.recurrence.kind === "weekdays" ||
        s.recurrence.kind === "weekly" ||
        s.recurrence.kind === "cron";
      const dayKey = oncePerDay
        ? `${canonicalVault(vault)}|${s.id}|day:${new Date(fireAt).toLocaleDateString("en-CA")}`
        : null;
      if (firedSlots.has(slotKey) || (dayKey && firedSlots.has(dayKey))) continue;
      firedSlots.add(slotKey);
      if (dayKey) firedSlots.add(dayKey);
      if (firedSlots.size > 2000) firedSlots.clear(); // bound; daily slots are tiny
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

  // [harness v2] Never fire a self-check into a mission that is WAITING ON THE
  // USER. A pending unanswered AskUser means the mission asked a question and is
  // holding for the reply; firing a self-check keeps the thread "running", which
  // (a) reads as busy/idle instead of "needs you" and (b) makes the app REJECT
  // the user's answer as "a run is in progress" — exactly the dropped-$5-answer
  // bug. Detect it structurally (last non-system message is an assistant turn
  // that called AskUser, with no user reply after), stamp AWAITING_USER for the
  // board, and skip — the user's reply is the wake.
  if (s.target.kind === "existing" && harnessV2Enabled()) {
    try {
      const conv =
        useStore.getState().conversations.find((c) => c.id === conversationId) ??
        (await readConversations(vault)).find((c) => c.id === conversationId);
      if (conv && conv.source === "mission" && conv.completedAt) {
        // A completed mission must never be re-run. A stray schedule that outlived
        // CompleteMission's cleanup (a double-fire slot, or a heartbeat armed in
        // the very turn that completed) would start a fresh turn on a finished
        // mission — wasting a run and, worse, re-stamping missionState:RUNNING with
        // a newer lastActivityAt that RESURRECTS the mission onto the Activity
        // board (the reconstruct freshness tie-break). Skip and sweep the dead row.
        vlog("sched.skip.completed", { conv: conversationId.slice(0, 8), name: s.name });
        await deleteSchedule(vault, s.id).catch(() => {});
        return;
      }
      if (conv && conv.source === "mission" && !conv.completedAt) {
        const msgs = conv.messages.filter((m) => !m.system);
        const last = msgs[msgs.length - 1];
        // Two independent signals that the mission is parked on the user's reply:
        //  (1) the harness-stamped state — AUTHORITATIVE. offVaultRun stamps
        //      missionState:"AWAITING_USER" the instant an ask turn ends, and
        //      that survives even when a later line (a summary/system row, or a
        //      trailing non-AskUser assistant turn) makes the message tail no
        //      longer *look* like a bare trailing AskUser.
        //  (2) the message-tail heuristic — belt-and-suspenders for a pre-v2
        //      thread, or a race where the state stamp hasn't landed yet.
        // Keying ONLY off (2) let a stale schedule fire into an AWAITING_USER
        // mission whose tail wasn't a clean AskUser turn → a DUPLICATE parked
        // ask (or a stale non-reply turn eating the wait). Skip on either.
        const awaitingUserState = conv.missionState === "AWAITING_USER";
        const trailingAsk =
          !!last && last.role === "assistant" && (last.toolCalls ?? []).some((t) => t.name === "AskUser");
        if (awaitingUserState || trailingAsk) {
          vlog("sched.skip.awaitinguser", {
            conv: conversationId.slice(0, 8),
            name: s.name,
            via: awaitingUserState ? "state" : "tail",
          });
          const { stampMissionAwaitingUser } = await import("./offVaultRun");
          await stampMissionAwaitingUser(vault, conversationId).catch(() => {});
          return; // hold — do not run a turn; the user's answer resumes it
        }
      }
    } catch {
      // If the check itself fails, fall through and fire (fail toward liveness).
    }
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
      s.quietUnlessAlert,
      true, // scheduledBriefing — surface the result in the Alerts feed
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
  // Seed from disk when the in-memory map is cold (e.g. the CancelSchedule tool
  // deletes before the scheduler loop populated this vault). An empty map would
  // otherwise write an empty schedules.jsonl and drop every row.
  const list =
    schedulesByVault.get(vault) ?? (await readSchedules(vault).catch(() => []));
  const next = list.filter((x) => x.id !== id);
  schedulesByVault.set(vault, next);
  emit();
  // Tombstone FIRST, then write the row out. schedules.jsonl is merge=union, so
  // an omission alone is resurrected the moment another machine that still holds
  // the row syncs back (the "cancelled watchdog keeps firing" bug). The tombstone
  // unions cleanly and every reader filters against it, so the delete is durable.
  await invoke("schedule_tombstone_add", { vault, id }).catch((e) =>
    console.warn("[scheduler] tombstone write failed:", e),
  );
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
