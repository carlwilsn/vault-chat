import { invoke } from "@tauri-apps/api/core";
import { useStore } from "./store";
import { vlog } from "./debugLog";

// ---------------------------------------------------------------------------
// Run-watcher: durable, deterministic supervision of LONG EXTERNAL jobs that
// outlive a single agent turn — a training run on rented GPU, a batch eval, an
// overnight sweep. The agent launches the job itself (detached, over ssh) and
// hands the watcher a `checkCmd` that reports the job's state. From then on the
// watcher — NOT the agent's memory — guarantees the recheck:
//
//   #1  Guaranteed recheck.   A persisted job row with its own nextCheckAt is
//       polled by the scheduler tick. The recheck happens in CODE; it does not
//       depend on the agent remembering to self-schedule a wake.
//   #2  failed / stalled.     The check's status token (or its absence) is
//       turned into a real, queryable status — done | failed | stalled — and a
//       terminal transition fires a phone alert (✓ for done, ⚠️ for the rest).
//   #3  Remote job state modeled.  jobs.jsonl IS the durable handle: title,
//       host, checkCmd, pullCmd, cwd, last progress. Survives app restart, so a
//       reboot re-arms the watch from disk on the next tick.
//   #4  Artifact durability.  An optional pullCmd (an rsync off the rented box)
//       runs every cycle, so a spot reclaim costs at most one cadence interval
//       of progress instead of the whole run.
//
// Persisted per-vault to `<vault>/.vault-chat/jobs.jsonl`. Acted on only by the
// firing machine (the scheduler gate), so a vault open on two boxes is checked
// once, not twice.
// ---------------------------------------------------------------------------

export type RunJobStatus = "running" | "done" | "failed" | "stalled";

export type RunJob = {
  id: string;
  title: string;
  // The mission/worker thread to wake when the job reaches a terminal state, so
  // the supervisor reviews the result and continues (or brings the user in).
  ownerConvId: string;
  // Mission grouping key, for the alert card.
  mission?: string;
  // Informational: which rented box this run lives on.
  host?: string;
  // Shell command the watcher runs on a timer. Its FIRST word is the status
  // token (RUNNING | DONE | FAILED); the rest is a short progress note.
  checkCmd: string;
  // Optional: run every cycle to sync artifacts off the remote box.
  pullCmd?: string;
  // Working directory for check/pull commands. Defaults to the vault root.
  cwd?: string;
  cadenceMs: number;
  // If RUNNING but the progress note hasn't changed for this long → stalled.
  stallMs: number;
  status: RunJobStatus;
  // Last progress note seen, and when it last CHANGED (the stall clock).
  lastProgress?: string;
  lastProgressAt: number;
  // When the most recent terminal reason was computed (failed/stalled detail).
  terminalReason?: string;
  nextCheckAt: number;
  startedAt: number;
  lastCheckedAt?: number;
  endedAt?: number;
  // Consecutive times the check command itself couldn't run (host unreachable).
  checkErrors: number;
};

const DEFAULT_CADENCE_MS = 10 * 60_000;
const DEFAULT_STALL_MS = 45 * 60_000;
// How many consecutive unreachable checks (ssh down / network) before we call
// the run stalled — a rented box that vanished should surface, not hang silent.
const MAX_CHECK_ERRORS = 3;
// Terminal rows linger this long so ListRuns can still show "failed 20m ago",
// then get pruned.
const TERMINAL_TTL_MS = 24 * 60 * 60_000;

function jobsPath(vault: string): string {
  const v = vault.replace(/\\/g, "/").replace(/\/+$/, "");
  return `${v}/.vault-chat/jobs.jsonl`;
}

function newJobId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return "run_" + crypto.randomUUID().slice(0, 10);
  }
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeJob(j: Partial<RunJob>): RunJob {
  const now = Date.now();
  return {
    id: j.id!,
    title: j.title ?? "Run",
    ownerConvId: j.ownerConvId ?? "",
    mission: j.mission,
    host: j.host,
    checkCmd: j.checkCmd ?? "",
    pullCmd: j.pullCmd,
    cwd: j.cwd,
    cadenceMs: j.cadenceMs && j.cadenceMs > 0 ? j.cadenceMs : DEFAULT_CADENCE_MS,
    stallMs: j.stallMs && j.stallMs > 0 ? j.stallMs : DEFAULT_STALL_MS,
    status: j.status ?? "running",
    lastProgress: j.lastProgress,
    lastProgressAt: j.lastProgressAt ?? now,
    terminalReason: j.terminalReason,
    nextCheckAt: j.nextCheckAt ?? now,
    startedAt: j.startedAt ?? now,
    lastCheckedAt: j.lastCheckedAt,
    endedAt: j.endedAt,
    checkErrors: j.checkErrors ?? 0,
  };
}

export async function readJobs(vault: string): Promise<RunJob[]> {
  let text = "";
  try {
    text = await invoke<string>("read_text_file", { path: jobsPath(vault) });
  } catch {
    return []; // no file yet
  }
  const byId = new Map<string, RunJob>();
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const parsed = JSON.parse(t) as RunJob;
      if (!parsed || typeof parsed.id !== "string") continue;
      const j = normalizeJob(parsed);
      // jsonl can hold duplicate rows for one id after a git union-merge; keep
      // the most-recently-checked survivor.
      const prev = byId.get(j.id);
      if (!prev || (j.lastCheckedAt ?? 0) >= (prev.lastCheckedAt ?? 0)) byId.set(j.id, j);
    } catch {
      // skip a bad line
    }
  }
  return Array.from(byId.values());
}

async function writeJobs(vault: string, list: RunJob[]): Promise<void> {
  const text = list.map((j) => JSON.stringify(j)).join("\n");
  await invoke("write_text_file", {
    path: jobsPath(vault),
    contents: list.length ? text + "\n" : "",
  });
}

// Per-vault async mutex — register, check-persist, cancel, and prune all touch
// the same file from the single app runtime; serialize so a read→modify→write
// can't be clobbered.
const locks = new Map<string, Promise<unknown>>();
async function withJobsLock<T>(vault: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(vault) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  locks.set(vault, prev.then(() => gate));
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
  }
}

export type RegisterJobInput = {
  title: string;
  ownerConvId: string;
  checkCmd: string;
  pullCmd?: string;
  cwd?: string;
  host?: string;
  mission?: string;
  cadenceMs?: number;
  stallMs?: number;
};

export async function registerJob(vault: string, input: RegisterJobInput): Promise<RunJob> {
  return withJobsLock(vault, async () => {
    const list = await readJobs(vault);
    // Idempotency: re-registering the SAME run (same owner thread + same check
    // command) returns the existing job instead of minting a duplicate. This is
    // the structural backstop under agent honesty — a supervisor that loses track
    // and calls WatchRun twice (the smoke-test double-register) can't watch, or
    // bill, one run twice. Identity is (ownerConvId, checkCmd): the check command
    // names the run, and we only dedup live ones so a genuinely new run with a
    // reused command after the first ended still registers.
    const dup = list.find(
      (x) => x.status === "running" && x.ownerConvId === input.ownerConvId && x.checkCmd === input.checkCmd,
    );
    if (dup) {
      vlog("runwatch.register.dedup", { id: dup.id, title: dup.title });
      return dup;
    }
    const now = Date.now();
    const job = normalizeJob({
      id: newJobId(),
      ...input,
      status: "running",
      startedAt: now,
      lastProgressAt: now,
      nextCheckAt: now + (input.cadenceMs ?? DEFAULT_CADENCE_MS),
      checkErrors: 0,
    });
    await writeJobs(vault, [...list.filter((x) => x.id !== job.id), job]);
    vlog("runwatch.register", { id: job.id, title: job.title, conv: job.ownerConvId.slice(0, 8) });
    return job;
  });
}

export async function removeJob(vault: string, id: string): Promise<void> {
  await withJobsLock(vault, async () => {
    const list = await readJobs(vault);
    await writeJobs(vault, list.filter((j) => j.id !== id));
  });
}

// ---- the watcher tick ------------------------------------------------------

const ticking = new Set<string>();

// Called from the scheduler loop on the firing machine, every 30s. Cheap: it
// reads the (small) jobs file and only execs a check for rows whose nextCheckAt
// has arrived.
export async function tickRunWatcher(vault: string): Promise<void> {
  if (ticking.has(vault)) return; // don't overlap a slow sweep
  ticking.add(vault);
  try {
    const now = Date.now();
    const list = await readJobs(vault);
    const due = list.filter((j) => j.status === "running" && j.nextCheckAt <= now);
    for (const job of due) {
      await checkOneJob(vault, job).catch((e) =>
        console.warn("[run-watcher] check failed:", e),
      );
    }
    // Prune terminal rows past their TTL.
    const stale = list.some(
      (j) => j.status !== "running" && (j.endedAt ?? 0) < now - TERMINAL_TTL_MS,
    );
    if (stale) {
      await withJobsLock(vault, async () => {
        const fresh = await readJobs(vault);
        await writeJobs(
          vault,
          fresh.filter((j) => !(j.status !== "running" && (j.endedAt ?? 0) < now - TERMINAL_TTL_MS)),
        );
      });
    }
  } finally {
    ticking.delete(vault);
  }
}

async function execCheck(
  command: string,
  cwd: string,
  tag: string,
): Promise<{ out: string; ok: boolean }> {
  try {
    const r = await invoke<{ stdout: string; stderr: string; code: number; timed_out: boolean }>(
      "bash_exec",
      {
        command,
        cwd,
        timeoutMs: 60_000,
        cancelId: `${tag}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      },
    );
    if (r.timed_out) return { out: "", ok: false };
    return { out: (r.stdout || "").trim(), ok: true };
  } catch {
    return { out: "", ok: false }; // couldn't run the command at all
  }
}

async function checkOneJob(vault: string, job: RunJob): Promise<void> {
  const now = Date.now();
  const cwd = job.cwd || vault;

  // 1) Run the check command (slow — outside the lock).
  const { out, ok } = await execCheck(job.checkCmd, cwd, `runwatch_${job.id}`);

  // 2) Interpret into a new state.
  let status: RunJobStatus = "running";
  let progress = job.lastProgress;
  let progressChanged = false;
  let terminalReason = job.terminalReason;
  let checkErrors = job.checkErrors;

  if (!ok) {
    checkErrors = job.checkErrors + 1;
    if (checkErrors >= MAX_CHECK_ERRORS) {
      status = "stalled";
      terminalReason = `check command unreachable ${checkErrors}× — rented box down or network gone?`;
    }
  } else {
    checkErrors = 0;
    const m = out.match(/^(\S+)([\s\S]*)$/);
    const token = (m?.[1] ?? "").toUpperCase();
    const rest = (m?.[2] ?? "").trim();
    if (token === "DONE" || token === "COMPLETE" || token === "FINISHED") {
      status = "done";
      progress = rest || "done";
    } else if (token === "FAILED" || token === "FAIL" || token === "ERROR" || token === "DEAD") {
      status = "failed";
      progress = rest || out || "failed";
      terminalReason = rest || "run reported failure";
    } else {
      // RUNNING or anything unrecognized — still alive; track for stall.
      status = "running";
      const note = out || job.lastProgress || "";
      progressChanged = note !== (job.lastProgress ?? "");
      progress = note;
      const lastChange = progressChanged ? now : job.lastProgressAt;
      if (!progressChanged && now - lastChange >= job.stallMs) {
        status = "stalled";
        terminalReason = `no progress for ${Math.round((now - lastChange) / 60_000)}m (last: ${(job.lastProgress || "—").slice(0, 80)})`;
      }
    }
  }

  // 3) Best-effort artifact pull every cycle (and a final pull on terminal),
  //    so a spot reclaim never costs more than one interval of results.
  if (job.pullCmd) {
    await execCheck(job.pullCmd, cwd, `runpull_${job.id}`);
  }

  const isTerminal = status !== "running";
  const updated: RunJob = {
    ...job,
    status,
    lastProgress: progress,
    lastProgressAt: progressChanged ? now : job.lastProgressAt,
    terminalReason,
    checkErrors,
    lastCheckedAt: now,
    nextCheckAt: now + job.cadenceMs,
    endedAt: isTerminal ? now : job.endedAt,
  };

  // 4) Persist under the lock; re-read so we don't clobber a concurrent
  //    register/cancel, and so a terminal transition fires exactly once.
  let didTransition = false;
  await withJobsLock(vault, async () => {
    const fresh = await readJobs(vault);
    const cur = fresh.find((x) => x.id === job.id);
    if (!cur) return; // cancelled out from under us
    if (cur.status !== "running") return; // someone else already retired it
    didTransition = isTerminal;
    await writeJobs(vault, fresh.map((x) => (x.id === job.id ? updated : x)));
  });

  if (didTransition) {
    vlog("runwatch.terminal", { id: job.id, status, reason: terminalReason });
    await announceTerminal(vault, updated).catch((e) =>
      console.warn("[run-watcher] announce failed:", e),
    );
  }
}

async function announceTerminal(vault: string, job: RunJob): Promise<void> {
  const human = job.title || "Run";
  const reason = job.terminalReason || job.lastProgress || "";
  const { notify } = await import("./phoneApp");

  if (job.status === "done") {
    await notify("info", `Run done — ${human}`, job.lastProgress || "completed", job.ownerConvId, {
      intention: `Run finished${job.mission ? " · " + job.mission : ""}`,
      summary: (job.lastProgress || "completed").slice(0, 200),
      icon: "✓",
      cls: "g",
    });
  } else {
    const label = job.status === "failed" ? "FAILED" : "STALLED";
    await notify("info", `Run ${label} — ${human}`, reason || label, job.ownerConvId, {
      intention: `Run needs you${job.mission ? " · " + job.mission : ""}`,
      summary: (reason || label).slice(0, 200),
      icon: "⚠️",
      cls: "r",
    });
  }

  // Wake the owning mission/worker so its supervisor reviews the result and
  // decides what's next — same channel a finished worker uses to report up.
  if (!job.ownerConvId) return;
  const wake =
    job.status === "done"
      ? `Watched run "${job.title}" FINISHED. Last status: ${job.lastProgress || "done"}.\n` +
        `Artifacts ${job.pullCmd ? "were synced off the box this cycle" : "are still on the remote box — pull them before teardown"}.\n` +
        `Review the results: verify a Done-when criterion if it's met, kick off the next experiment, or report up to the user.`
      : `Watched run "${job.title}" ${job.status.toUpperCase()} — ${reason}.\n` +
        `Decide: relaunch (fix the cause, restart), pull diagnostics for me, or bring the user in if it needs their call. ` +
        `The rented box may still be billing — stop it if the run is truly dead.`;
  const { runWorkerTurn } = await import("./offVaultRun");
  await runWorkerTurn(vault, job.ownerConvId, wake, {
    modelId: useStore.getState().supervisorModelId,
  }).catch((e) => console.warn("[run-watcher] wake failed:", e));
}
