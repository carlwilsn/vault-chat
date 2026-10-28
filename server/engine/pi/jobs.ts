// Detached jobs for the pi engine (StartJob / JobStatus / JobList / JobStop).
// Inside pi's sandbox a background `&`, setsid or tmux dies with the turn's pid
// namespace, and the user's systemd bus is hidden from the agent (it would
// escape the sandbox). So the SERVER starts the job: `systemd-run --user`
// (survives turns and server restarts) wrapping bubblewrap with the same hiding
// as the agent's shell (no key store, no tokens, scrubbed env), with a time
// limit (RuntimeMaxSec), a memory ceiling and a low CPU/IO share. The server
// keeps a registry (<logDir>/jobs.json): which conversation started which job,
// so a finished job wakes its conversation, and at most `max` run at once.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAtomic } from "../../atomic";
import { asksAllInterfaces, DEV_HOST_ENV } from "../../devProxy";

export type PiJobEnv = {
  logDir: string;
  /** bubblewrap argv ending in "--" (the agent's shell sandbox, minus the pid namespace), or null. */
  wrap: string[] | null;
  /** Env names to keep (everything else is dropped). */
  env: Record<string, string>;
  /** Jobs running at once in this vault (default VC_JOB_MAX, else 4). */
  max?: number;
  /** systemd's MemoryMax for a job (default VC_JOB_MEMORY_MAX, else "75%" of RAM). */
  memoryMax?: string;
  /**
   * Where a starting job's environment file lives (0700 dir, 0600 file, removed
   * once the unit has started): default jobEnvDir(). The values never go on
   * systemd-run's command line, where any process lister would see the keys.
   */
  envDir?: string;
  /** Run a command (tests replace systemd-run / systemctl). */
  exec?: (cmd: string, args: string[]) => { status: number | null; stdout: string; stderr: string };
};

export type JobRec = {
  id: string;
  conv?: string;
  name: string;
  command: string;
  startedAt: number;
  timeoutS: number;
  state: "running" | "finished" | "stopped" | "timeout" | "gone";
  exit?: number;
  endedAt?: number;
  /** Started by a turn Carl started (its finish may buzz his phone, server/pushGate.ts). */
  byCarl?: boolean;
};

const unitOf = (id: string) => `vc-job-${id}`;
export const JOB_DEFAULT_TIMEOUT_S = 24 * 3600;
export const JOB_MAX_TIMEOUT_S = 7 * 24 * 3600;

const exec = (env: PiJobEnv) =>
  env.exec ??
  ((cmd: string, args: string[]) => {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 30_000 });
    return { status: r.status, stdout: r.stdout ?? "", stderr: (r.stderr || r.error?.message) ?? "" };
  });

export function readJobs(env: PiJobEnv): JobRec[] {
  try {
    const v = JSON.parse(readFileSync(join(env.logDir, "jobs.json"), "utf8"));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function writeJobs(env: PiJobEnv, list: JobRec[]): void {
  mkdirSync(env.logDir, { recursive: true });
  // Ended jobs older than a week drop out of the registry (their logs stay).
  const week = Date.now() - 7 * 86_400_000;
  const keep = list.filter((j) => j.state === "running" || (j.endedAt ?? j.startedAt) > week);
  writeAtomic(join(env.logDir, "jobs.json"), JSON.stringify(keep, null, 1), join(env.logDir, `jobs.json.${process.pid}.tmp`));
}

function patchJob(env: PiJobEnv, id: string, patch: Partial<JobRec>): JobRec | null {
  const list = readJobs(env);
  const i = list.findIndex((j) => j.id === id);
  if (i < 0) return null;
  list[i] = { ...list[i]!, ...patch };
  writeJobs(env, list);
  return list[i]!;
}

/** "36h", "90m", "2d" or seconds → seconds, at least a minute, at most 7 days; default 24 h. */
export function jobTimeoutS(v: unknown): number {
  let s = JOB_DEFAULT_TIMEOUT_S;
  if (typeof v === "number" && v > 0) s = v;
  else if (typeof v === "string" && v.trim()) {
    const t = v.trim().toLowerCase();
    if (/^\d+$/.test(t)) s = Number(t);
    else {
      let n = 0;
      for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(d|h|m|s)/g)) n += Number(m[1]) * { d: 86_400, h: 3600, m: 60, s: 1 }[m[2] as "d" | "h" | "m" | "s"];
      if (n > 0) s = n;
    }
  }
  return Math.max(60, Math.min(Math.round(s), JOB_MAX_TIMEOUT_S));
}

/** The private dir for job environment files: $XDG_RUNTIME_DIR/vault-chat/jobs (tmpfs, the user's own), else a per-user dir in tmp. */
export function jobEnvDir(): string {
  const run = process.env.XDG_RUNTIME_DIR;
  if (run) return join(run, "vault-chat", "jobs");
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return join(tmpdir(), `vault-chat-${uid}`, "jobs");
}

const envDirOf = (env: PiJobEnv) => env.envDir ?? jobEnvDir();

/** One value in systemd's EnvironmentFile syntax: single quotes are literal; else double quotes with \ escapes. */
function envFileValue(v: string): string {
  if (!v.includes("'")) return `'${v}'`;
  return `"${v.replace(/[\\"$`]/g, (c) => "\\" + c)}"`;
}

/** Write a job's environment to <dir>/<id>.env (dir 0700, file 0600); returns its path. */
export function writeJobEnvFile(dir: string, id: string, vars: Record<string, string>): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = join(dir, `${id}.env`);
  const body = Object.entries(vars)
    .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
    .map(([k, v]) => `${k}=${envFileValue(String(v))}\n`)
    .join("");
  rmSync(path, { force: true });
  writeFileSync(path, body, { mode: 0o600, flag: "wx" });
  return path;
}

/** Remove job environment files left behind (a crash between write and start): those older than `olderMs`. Returns how many. */
export function sweepJobEnvFiles(dir: string = jobEnvDir(), olderMs = 60_000): number {
  let n = 0;
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - olderMs;
  for (const f of names) {
    if (!f.endsWith(".env")) continue;
    const p = join(dir, f);
    try {
      if (statSync(p).mtimeMs <= cutoff) {
        rmSync(p, { force: true });
        n++;
      }
    } catch {
      /* gone already */
    }
  }
  return n;
}

/**
 * The systemd-run argv for a job (pure; tests read it). The environment comes
 * from `envFile` (EnvironmentFile=: `systemctl show` prints the path, never the
 * values). Type=exec: systemd-run returns only once the job's process has been
 * exec'd, i.e. after systemd read the file, so the caller can delete it then.
 */
export function jobArgv(env: PiJobEnv, cwd: string, id: string, shell: string, timeoutS: number, envFile: string): string[] {
  // The log dir must be writable inside the sandbox even though the state dir is read-only there.
  const wrap = [...env.wrap!.slice(0, -1), "--bind", env.logDir, env.logDir, "--"];
  const memory = env.memoryMax ?? process.env.VC_JOB_MEMORY_MAX ?? "75%";
  return [
    "--user",
    "--quiet",
    "--collect",
    `--unit=${unitOf(id)}`,
    `--working-directory=${cwd}`,
    `--property=RuntimeMaxSec=${timeoutS}`,
    `--property=MemoryMax=${memory}`,
    "--property=CPUWeight=20",
    "--property=IOWeight=20",
    "--property=Type=exec",
    `--property=EnvironmentFile=${envFile}`,
    ...wrap,
    "sh",
    "-c",
    shell,
  ];
}

export function runningJobs(env: PiJobEnv): JobRec[] {
  return readJobs(env).filter((j) => j.state === "running");
}

export function startJob(env: PiJobEnv, cwd: string, a: { command?: string; name?: string; timeout?: unknown }, conv?: string, byCarl = false): string {
  return startJobWith(env, cwd, a, conv, byCarl).text;
}

/** StartJob, with the record of the job it started (none when it did not start). */
export function startJobWith(env: PiJobEnv, cwd: string, a: { command?: string; name?: string; timeout?: unknown }, conv?: string, byCarl = false): { text: string; job?: JobRec } {
  const no = (text: string) => ({ text });
  const cmd = String(a?.command ?? "").trim();
  if (!cmd) return no("StartJob needs a command.");
  if (process.platform !== "linux" && !env.exec) return no("StartJob needs Linux (systemd + bubblewrap).");
  if (!env.wrap) return no("StartJob is unavailable: bubblewrap was not found on the box.");
  const max = env.max ?? (Number(process.env.VC_JOB_MAX) || 4);
  const running = runningJobs(env);
  if (running.length >= max) {
    return no(`Not started: ${running.length} jobs are already running in this vault (the cap is ${max}). Wait for one to finish, or stop one (JobList, JobStop): ${running.map((j) => j.id).join(", ")}.`);
  }
  const name = String(a?.name ?? "job").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24) || "job";
  const id = `${name}-${Date.now().toString(36)}`;
  const timeoutS = jobTimeoutS(a?.timeout);
  mkdirSync(env.logDir, { recursive: true });
  const log = join(env.logDir, `${id}.log`);
  const shell = `(${cmd}) > ${JSON.stringify(log)} 2>&1; echo "[exit $?]" >> ${JSON.stringify(log)}`;
  const dir = envDirOf(env);
  sweepJobEnvFiles(dir);
  let envFile: string;
  try {
    // A dev server that reads HOST binds to loopback (the box serves it to Carl behind his login: server/devProxy.ts).
    envFile = writeJobEnvFile(dir, id, { ...DEV_HOST_ENV, ...env.env });
  } catch (e) {
    return no(`StartJob failed: could not write its environment file (${(e as Error).message.slice(0, 200)}).`);
  }
  let r: ReturnType<ReturnType<typeof exec>>;
  try {
    r = exec(env)("systemd-run", jobArgv(env, cwd, id, shell, timeoutS, envFile));
  } finally {
    // Started (Type=exec: the file was read) or failed: either way it is no longer needed.
    rmSync(envFile, { force: true });
  }
  if (r.status !== 0) return no(`StartJob failed: ${(r.stderr || r.stdout || "").trim().slice(0, 400)}`);
  const job: JobRec = { id, ...(conv ? { conv } : {}), ...(byCarl ? { byCarl } : {}), name, command: cmd.slice(0, 2000), startedAt: Date.now(), timeoutS, state: "running" };
  writeJobs(env, [...readJobs(env), job]);
  const h = Math.round((timeoutS / 3600) * 10) / 10;
  return { job, text: `Started job ${id} (survives this turn and restarts; stopped after ${h} h). Output: ${log}. When it ends you get a wake turn with its exit code and last lines; JobStatus{id:"${id}"} checks it before that. A dev server it starts shows on Carl's devices with Show {url: "http://localhost:<port>"}; JobStop stops it.${asksAllInterfaces(cmd) ? " Warning: this command binds every interface (0.0.0.0 / a bare --host), so on the tailnet its port answers without Carl's login. Stop it (JobStop) and start it again on localhost (--host 127.0.0.1, or no --host): Show reaches it through the box either way." : ""}` };
}

/** A job's state now: from its log's "[exit N]" line, else systemd's view of its unit. */
export function probeJob(env: PiJobEnv, j: JobRec): { state: JobRec["state"]; exit?: number; tail: string } {
  let lines: string[] = [];
  try {
    lines = readFileSync(join(env.logDir, `${j.id}.log`), "utf8").replace(/\s+$/, "").split("\n");
  } catch {
    /* no output yet */
  }
  const exit = /^\[exit (\d+)\]$/.exec(lines.at(-1)?.trim() ?? "");
  const tail = lines.slice(-40).join("\n");
  if (exit) return { state: "finished", exit: Number(exit[1]), tail };
  if (j.state !== "running") return { state: j.state, ...(j.exit !== undefined ? { exit: j.exit } : {}), tail };
  const active = (exec(env)("systemctl", ["--user", "is-active", unitOf(j.id)]).stdout || "").trim();
  if (active === "active" || active === "activating" || active === "reloading") return { state: "running", tail };
  // The unit is gone without an exit line: its time limit, a stop, or a kill (out of memory).
  const timedOut = Date.now() - j.startedAt >= j.timeoutS * 1000 - 5_000;
  return { state: timedOut ? "timeout" : "gone", tail };
}

function describe(state: JobRec["state"], exit: number | undefined, timeoutS: number): string {
  if (state === "finished") return `finished (exit ${exit})`;
  if (state === "timeout") return `stopped by its time limit (${Math.round(timeoutS / 360) / 10} h)`;
  if (state === "stopped") return "stopped";
  if (state === "gone") return "ended without an exit code (stopped, or killed: out of memory?)";
  return "running";
}

export function jobStatus(env: PiJobEnv, a: { id?: string; tail?: number }): string {
  const id = String(a?.id ?? "").trim();
  if (!/^[a-z0-9-]+$/.test(id)) return "JobStatus needs the job id StartJob returned.";
  const rec: JobRec = readJobs(env).find((j) => j.id === id) ?? { id, name: id, command: "", startedAt: 0, timeoutS: JOB_MAX_TIMEOUT_S, state: "running" };
  const p = probeJob(env, rec);
  let tail = "";
  try {
    const lines = readFileSync(join(env.logDir, `${id}.log`), "utf8").split("\n");
    tail = lines.slice(-Math.max(5, Math.min(Number(a?.tail) || 40, 400))).join("\n");
  } catch {
    tail = "(no output yet)";
  }
  return `Job ${id}: ${describe(p.state, p.exit, rec.timeoutS)}\n--- last output ---\n${tail}`;
}

/** JobList: this conversation's jobs (or every job in the vault), newest first. */
export function jobList(env: PiJobEnv, conv: string | undefined, all = false): string {
  const list = readJobs(env)
    .filter((j) => all || !conv || j.conv === conv)
    .sort((a, b) => b.startedAt - a.startedAt);
  if (!list.length) return all ? "No jobs in this vault." : "No jobs from this conversation (all: true lists the vault's).";
  return list
    .slice(0, 40)
    .map((j) => {
      const p = j.state === "running" ? probeJob(env, j) : { state: j.state, exit: j.exit };
      const ago = Math.round((Date.now() - j.startedAt) / 60_000);
      return `- ${j.id}: ${describe(p.state, p.exit, j.timeoutS)}, started ${ago} min ago — ${j.command.slice(0, 120)}`;
    })
    .join("\n");
}

/** JobStop: stop the unit (its whole process tree); the registry says stopped. */
export function jobStop(env: PiJobEnv, id: string, conv?: string): string {
  const j = readJobs(env).find((x) => x.id === id);
  if (!j) return `No job ${id}.`;
  if (conv && j.conv && j.conv !== conv) return `Job ${id} belongs to another conversation; only it (or Carl) stops it.`;
  if (j.state !== "running") return `Job ${id} is not running (${j.state}).`;
  const r = exec(env)("systemctl", ["--user", "stop", unitOf(id)]);
  if (r.status !== 0) return `JobStop failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`;
  patchJob(env, id, { state: "stopped", endedAt: Date.now() });
  return `Stopped job ${id}.`;
}

/** Jobs that ended since the last look: marked in the registry and returned (each once). */
export function reapJobs(env: PiJobEnv): (JobRec & { tail: string })[] {
  const out: (JobRec & { tail: string })[] = [];
  for (const j of runningJobs(env)) {
    const p = probeJob(env, j);
    if (p.state === "running") continue;
    const rec = patchJob(env, j.id, { state: p.state, ...(p.exit !== undefined ? { exit: p.exit } : {}), endedAt: Date.now() });
    if (rec) out.push({ ...rec, tail: p.tail });
  }
  return out;
}
