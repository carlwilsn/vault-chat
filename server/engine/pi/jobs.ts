// Detached jobs for the pi engine (StartJob / JobStatus). Inside pi's sandbox
// a background `&`, setsid or tmux dies with the turn's pid namespace, and the
// user's systemd bus is hidden from the agent (it would escape the sandbox).
// So the SERVER starts the job: `systemd-run --user` (survives turns and
// server restarts) wrapping bubblewrap with the same hiding as the agent's
// shell (no key store, no tokens, scrubbed env).
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type PiJobEnv = {
  logDir: string;
  /** bubblewrap argv ending in "--" (the agent's shell sandbox, minus the pid namespace), or null. */
  wrap: string[] | null;
  /** Env names to keep (everything else is dropped). */
  env: Record<string, string>;
};

const unitOf = (id: string) => `vc-job-${id}`;

export function startJob(env: PiJobEnv, cwd: string, a: { command?: string; name?: string }): string {
  const cmd = String(a?.command ?? "").trim();
  if (!cmd) return "StartJob needs a command.";
  if (process.platform !== "linux") return "StartJob needs Linux (systemd + bubblewrap).";
  if (!env.wrap) return "StartJob is unavailable: bubblewrap was not found on the box.";
  const id = `${String(a?.name ?? "job").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24) || "job"}-${Date.now().toString(36)}`;
  mkdirSync(env.logDir, { recursive: true });
  const log = join(env.logDir, `${id}.log`);
  const shell = `(${cmd}) > ${JSON.stringify(log)} 2>&1; echo "[exit $?]" >> ${JSON.stringify(log)}`;
  // The log dir must be writable inside the sandbox even though the state dir is read-only there.
  const wrap = [...env.wrap.slice(0, -1), "--bind", env.logDir, env.logDir, "--"];
  const setenv = Object.entries(env.env).flatMap(([k, v]) => ["-E", `${k}=${v}`]);
  const r = spawnSync(
    "systemd-run",
    ["--user", "--quiet", "--collect", `--unit=${unitOf(id)}`, `--working-directory=${cwd}`, ...setenv, ...wrap, "sh", "-c", shell],
    { encoding: "utf8", timeout: 30_000 },
  );
  if (r.status !== 0) return `StartJob failed: ${(r.stderr || r.stdout || r.error?.message || "").trim().slice(0, 400)}`;
  return `Started job ${id} (survives this turn and restarts). Output: ${log}. Check it with JobStatus{id:"${id}"}; schedule a wake to come back to it.`;
}

export function jobStatus(env: PiJobEnv, a: { id?: string; tail?: number }): string {
  const id = String(a?.id ?? "").trim();
  if (!/^[a-z0-9-]+$/.test(id)) return "JobStatus needs the job id StartJob returned.";
  const r = spawnSync("systemctl", ["--user", "is-active", unitOf(id)], { encoding: "utf8", timeout: 10_000 });
  const active = (r.stdout || "").trim() || "unknown";
  let tail = "";
  try {
    const lines = readFileSync(join(env.logDir, `${id}.log`), "utf8").split("\n");
    tail = lines.slice(-Math.max(5, Math.min(Number(a?.tail) || 40, 400))).join("\n");
  } catch {
    tail = "(no output yet)";
  }
  const exit = /\[exit (\d+)\]\s*$/.exec(tail.trim());
  const state = exit ? `finished (exit ${exit[1]})` : active === "active" ? "running" : active;
  return `Job ${id}: ${state}\n--- last output ---\n${tail}`;
}
