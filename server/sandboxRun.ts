// The agent's per-command sandbox as a runner (bubblewrap: its own pid namespace, the key store hidden): RecordUI
// runs its browser through it, so the browser sees what the agent's shell sees.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { killTree } from "./commands/proc";

type RunOut = { code: number; out: string; err: string; timedOut: boolean } | { refused: string };

/** Run argv in the engine's per-command sandbox (`shell`: its argv prefix ending in "--"; null: the engine
 * runs without one — not Linux, or VC_PI_UNSAFE; undefined: no engine) with a minimal environment plus `extraEnv`. */
export function runSandboxed(shell: string[] | null | undefined, argv: string[], o: { cwd: string; timeoutMs: number; stdin?: string; extraEnv?: Record<string, string>; signal?: AbortSignal }): Promise<RunOut> {
  o.signal?.throwIfAborted();
  let prog: string;
  let args: string[];
  if (shell && shell.length) {
    prog = shell[0]!;
    args = [...shell.slice(1), ...argv];
  } else if (shell === null || process.platform !== "linux" || process.env.VC_PI_UNSAFE === "1") {
    prog = argv[0]!;
    if (process.platform === "win32" && prog === "bash") {
      prog = ["C:/Program Files/Git/bin/bash.exe", "C:/Program Files (x86)/Git/bin/bash.exe"].find((c) => existsSync(c)) ?? "bash";
    }
    args = argv.slice(1);
  } else {
    return Promise.resolve({ refused: "unavailable right now — the box's sandbox comes with the agent engine, which is still starting or off." });
  }
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/run/current-system/sw/bin",
    HOME: process.env.HOME ?? process.env.USERPROFILE ?? "",
    LANG: process.env.LANG ?? "C.UTF-8",
    ...(process.platform === "win32" ? { SYSTEMROOT: process.env.SYSTEMROOT ?? "", MSYS_NO_PATHCONV: "1" } : {}),
    ...(o.extraEnv ?? {}),
  };
  return new Promise((done) => {
    let out = "";
    let err = "";
    let timedOut = false;
    let child;
    try {
      child = spawn(prog, args, { cwd: o.cwd, env, detached: process.platform !== "win32", windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return done({ refused: (e as Error).message });
    }
    child.stdout!.on("data", (c) => (out += c));
    child.stderr!.on("data", (c) => (err += c));
    child.stdin!.on("error", () => {});
    child.stdin!.end(o.stdin ?? "");
    const abort = () => killTree(child.pid);
    o.signal?.addEventListener("abort", abort, { once: true });
    if (o.signal?.aborted) abort();
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, o.timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", abort);
      done({ refused: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", abort);
      done({ code: timedOut ? -1 : (code ?? -1), out, err, timedOut });
    });
  });
}
