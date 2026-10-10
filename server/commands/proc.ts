// Process commands: Bash, its cancel, vault-tool scripts. Every child runs in
// its own process group so a cancel/timeout kills the WHOLE tree (lib.rs:3503
// kill_tree_by_pid), not just the shell.
import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import type { CommandFn } from "./registry";

const AGENT_GIT_NAME = "vault-chat-agent"; // lib.rs:2480
const AGENT_GIT_EMAIL = "agent@vault-chat.local"; // lib.rs:2481
const MAX_OUT = 50_000; // lib.rs:2251

export function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { windowsHide: true });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  }
}

function truncate(s: string): string {
  if (Buffer.byteLength(s) <= MAX_OUT) return s;
  const b = Buffer.from(s);
  return `${b.subarray(0, MAX_OUT).toString("utf8")}\n…[truncated ${b.length - MAX_OUT} bytes]`;
}

type RunResult = { stdout: string; stderr: string; code: number; timed_out: boolean };

const cancels = new Map<string, () => void>();

/** Spawn, collect output, enforce a timeout and an optional cancel id. */
function runChild(
  program: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number; cancelId?: string; stdin?: string },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const so: SpawnOptions = {
      cwd: opts.cwd,
      env: opts.env,
      detached: process.platform !== "win32", // own process group on unix
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    };
    let child;
    try {
      child = spawn(program, args, so);
    } catch (e) {
      reject((e as Error).message);
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killed = false;
    child.stdout!.on("data", (d) => (stdout += d));
    child.stderr!.on("data", (d) => (stderr += d));
    child.on("error", (e) => reject(e.message));
    if (opts.stdin !== undefined) child.stdin!.end(opts.stdin);
    else child.stdin!.end();
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, opts.timeoutMs);
    if (opts.cancelId) {
      cancels.set(opts.cancelId, () => {
        killed = true;
        killTree(child.pid);
      });
    }
    child.on("close", (code) => {
      clearTimeout(timer);
      if (opts.cancelId) cancels.delete(opts.cancelId);
      resolve({
        stdout: truncate(stdout),
        stderr: truncate(stderr),
        code: timedOut || killed ? -1 : (code ?? -1),
        timed_out: timedOut,
      });
    });
  });
}

function isDir(p: unknown): p is string {
  if (typeof p !== "string" || !p) return false;
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** lib.rs:6600 strip_polluting_env. */
function cleanEnv(extra?: Record<string, string> | null): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.PYTHONHOME;
  delete env.PYTHONPATH;
  if (extra) Object.assign(env, extra);
  return env;
}

let gitBash: string | null | undefined;
/** lib.rs:28 find_git_bash (Windows only). */
function findGitBash(): string | null {
  if (gitBash !== undefined) return gitBash;
  const cands = [
    "C:/Program Files/Git/bin/bash.exe",
    "C:/Program Files (x86)/Git/bin/bash.exe",
    `${process.env.LOCALAPPDATA ?? ""}/Programs/Git/bin/bash.exe`,
  ];
  gitBash = cands.find((c) => existsSync(c)) ?? null;
  return gitBash;
}

/** lib.rs:6562 interpreter_for. */
function interpreterFor(path: string): [string, string[]] | null {
  const l = path.toLowerCase();
  if (l.endsWith(".py")) return [process.platform === "win32" ? "python" : "python3", [path]];
  if (l.endsWith(".mjs") || l.endsWith(".js")) return ["node", [path]];
  if (l.endsWith(".ts")) return [process.platform === "win32" ? "npx.cmd" : "npx", ["tsx", path]];
  if (l.endsWith(".sh") || l.endsWith(".bash")) return ["bash", [path]];
  return null;
}

export const procCommands: Record<string, CommandFn> = {
  // lib.rs:86
  bash_shell_kind: () => {
    if (process.platform === "win32") {
      const p = findGitBash();
      return p ? { kind: "git-bash", path: p } : { kind: "cmd", path: null };
    }
    return { kind: "bash", path: null };
  },

  // lib.rs:2102 — sets the cancel flag; here: kill the tree now.
  bash_cancel: ({ cancelId }) => {
    cancels.get(String(cancelId))?.();
    return null;
  },

  // lib.rs:2111 bash_exec / 2125 bash_exec_sync
  bash_exec: ({ command, cwd, timeoutMs, cancelId, env }) => {
    const e = cleanEnv(env);
    // lib.rs:2488 stamp_agent_git_identity
    e.GIT_AUTHOR_NAME = AGENT_GIT_NAME;
    e.GIT_AUTHOR_EMAIL = AGENT_GIT_EMAIL;
    e.GIT_COMMITTER_NAME = AGENT_GIT_NAME;
    e.GIT_COMMITTER_EMAIL = AGENT_GIT_EMAIL;
    let program = "bash";
    let args = ["-lc", String(command)];
    if (process.platform === "win32") {
      const gb = findGitBash();
      if (gb) {
        program = gb;
        args = ["-c", String(command)];
        e.MSYS_NO_PATHCONV = "1";
        e.MSYS2_ARG_CONV_EXCL = "*";
      } else {
        program = "cmd";
        args = ["/C", String(command)];
      }
    }
    return runChild(program, args, {
      cwd: isDir(cwd) ? cwd : undefined,
      env: e,
      timeoutMs: timeoutMs ?? 120_000,
      cancelId: cancelId ?? undefined,
    });
  },

  // lib.rs:6606 run_script / 6620 run_script_sync
  run_script: ({ scriptPath, stdinJson, cwd, timeoutMs, env }) => {
    const it = interpreterFor(String(scriptPath));
    if (!it) throw `no known interpreter for ${scriptPath} (supported: .py .js .mjs .ts .sh .bash)`;
    return runChild(it[0], it[1], {
      cwd: isDir(cwd) ? cwd : undefined,
      env: cleanEnv(env),
      timeoutMs: timeoutMs ?? 60_000,
      stdin: stdinJson ?? undefined,
    });
  },
};
