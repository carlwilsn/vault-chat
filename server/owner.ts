// One server owns the box's data at a time: the event logs (their single writer), the engine and its turns, sync, the
// scheduler, the voice pipeline. On an update the next server starts beside the one serving (server/deploy/
// vault-chat-update.sh, behind server/deploy/vault-chat-front.mjs) and does everything that needs no ownership first
// (loading the bundle, the keys, reading the logs ahead); then it waits here, on <state>/owner.lock, while the old one
// drains its writes, stops its children and exits. The kernel lock is released only by that exit (or a crash), so two
// servers never write at once. Once it serves, the new one writes its port to <state>/active-backend and the front
// sends every request to it.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let lockFd: number | null = null;

/** Wait until this process owns the box's data (immediately when no other server does). Linux only (flock(1));
 *  elsewhere ownership is not checked, as before. While it waits, <state>/standby names `port`. */
export async function takeOwnership(stateDir: string, port: number, log: (s: string) => void = console.log): Promise<{ waitedMs: number }> {
  if (process.platform !== "linux" || lockFd !== null) return { waitedMs: 0 };
  const fd = openSync(join(stateDir, "owner.lock"), "a");
  // The lock belongs to the open file description, which this process keeps: flock(1) takes it on our fd and exits.
  const flock = (block: boolean) => spawnSync("flock", ["--exclusive", ...(block ? [] : ["--nonblock"]), "3"], { stdio: ["ignore", "ignore", "pipe", fd], timeout: 5000 });
  const probe = flock(false);
  if (probe.error) {
    closeSync(fd);
    log(`[owner] flock is unavailable (${probe.error.message}): ownership is not checked`);
    return { waitedMs: 0 };
  }
  if (probe.status === 0) {
    lockFd = fd;
    return { waitedMs: 0 };
  }
  const since = Date.now();
  const standby = join(stateDir, "standby");
  writeAtomic(standby, String(port));
  log(`[owner] standby on ${port}: waiting for the server that owns the box to let go`);
  const ok = await new Promise<boolean>((resolve) => {
    const p = spawn("flock", ["--exclusive", "3"], { stdio: ["ignore", "ignore", "ignore", fd] });
    p.once("error", () => resolve(false));
    p.once("exit", (code) => resolve(code === 0));
  });
  try {
    if (readFileSync(standby, "utf8").trim() === String(port)) rmSync(standby, { force: true });
  } catch {
    /* gone already */
  }
  if (!ok) {
    closeSync(fd);
    throw new Error("could not take the box's owner lock");
  }
  lockFd = fd;
  const waitedMs = Date.now() - since;
  log(`[owner] took over after ${waitedMs} ms`);
  return { waitedMs };
}

/** Tell the front this server serves now (only a server behind the front has a backend port). */
export function promote(stateDir: string, port: number): void {
  writeAtomic(join(stateDir, "active-backend"), String(port));
}

/**
 * Before letting go: end every other process of this server's own unit (the voice pipeline, Claude Code and its
 * shells), so the next owner never meets a straggler still writing a session file or holding the voice port. Only a
 * backend's own cgroup (vault-chat-server@<port>.service) is touched, never a shared one (a shell, a test).
 */
export async function endOwnProcesses(graceMs = 3000): Promise<number> {
  const procs = ownCgroupProcs();
  if (!procs) return 0;
  const others = () => (readPids(procs) ?? []).filter((p) => p !== process.pid);
  const signal = (sig: NodeJS.Signals) => {
    for (const p of others()) {
      try {
        process.kill(p, sig);
      } catch {
        /* gone */
      }
    }
  };
  const n = others().length;
  if (!n) return 0;
  signal("SIGTERM");
  const deadline = Date.now() + graceMs;
  while (others().length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  if (others().length) signal("SIGKILL");
  const killDeadline = Date.now() + 1000;
  while (others().length && Date.now() < killDeadline) await new Promise((r) => setTimeout(r, 25));
  return n;
}

function ownCgroupProcs(): string | null {
  try {
    const line = readFileSync("/proc/self/cgroup", "utf8").split("\n").find((l) => l.startsWith("0::"));
    const path = line?.slice(3).trim();
    if (!path || !/\/vault-chat-server@\d+\.service$/.test(path)) return null;
    const procs = join("/sys/fs/cgroup", path, "cgroup.procs");
    return existsSync(procs) ? procs : null;
  } catch {
    return null;
  }
}

function readPids(file: string): number[] | null {
  try {
    return readFileSync(file, "utf8").split("\n").map(Number).filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return null;
  }
}

function writeAtomic(file: string, body: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, file);
}

/** Tests: the open lock, released as a process exit would. */
export function _releaseOwnership(): void {
  if (lockFd !== null) closeSync(lockFd);
  lockFd = null;
}
