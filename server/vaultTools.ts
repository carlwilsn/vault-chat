// The vault's own tools (.vault-chat/tools/<name>/TOOL.md + run.*), run on the
// box for the conversation's agent (pi: they are registered with every new
// thread, server/engine/engine.ts). One runner, every surface: voice reaches
// them through the agent (its Ask), never on its own (D3, one brain).
//
// A tool runs like the laptop ran it (stdin = the args as JSON, cwd = its
// folder, stdout = the result), in the engine's per-command sandbox (bubblewrap:
// its own pid namespace, the key store hidden), with the agent's keys as
// environment variables plus each key its TOOL.md requires under its own name.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { killTree } from "./commands/proc";
import { agentKeyEnv, keychainCommands } from "./keys";
import type { ToolSpec } from "./engine/pi/backend";

const READ_CAP = 24_000;
const OUT_CAP = 8_000;
const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n) + "\n…[truncated]" : t);

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

/** The interpreter for a tool's run file (server/commands/proc.ts interpreterFor). */
function interpreter(path: string): string[] | null {
  const l = path.toLowerCase();
  if (l.endsWith(".py")) return [process.platform === "win32" ? "python" : "python3", path];
  if (l.endsWith(".mjs") || l.endsWith(".js")) return ["node", path];
  if (l.endsWith(".ts")) return ["npx", "tsx", path];
  if (l.endsWith(".sh") || l.endsWith(".bash")) return ["bash", path];
  return null;
}

/** The vault's tools as the agent's tool specs (none that would shadow one of `taken`). Never throws. */
export async function vaultToolSpecsFor(vault: string, taken: Iterable<string> = []): Promise<ToolSpec[]> {
  const skip = new Set(taken);
  try {
    const { loadVaultToolSchemas } = await import("../src/meta");
    return (await loadVaultToolSchemas(vault))
      .filter((t) => !skip.has(t.name))
      .map((t) => ({ type: "function" as const, name: t.name, description: `${t.description} (Carl's own tool for this vault, .vault-chat/tools/.)`, inputSchema: t.parameters as Record<string, unknown> }));
  } catch {
    return [];
  }
}

/** Run the vault tool `name` with `args`; null when the vault has no such tool. */
export async function runVaultTool(vault: string, shell: string[] | null | undefined, name: string, args: unknown): Promise<string | null> {
  const { vaultToolSpecs } = await import("../src/meta");
  const hit = (await vaultToolSpecs(vault)).find((x) => x.spec.name === name);
  if (!hit) return null;
  const argv = interpreter(hit.runPath);
  if (!argv) return `Error: no interpreter for ${hit.runPath}`;
  // Every key (as the agent's commands get them), plus each declared one under its own name.
  const keys: Record<string, string> = { ...agentKeyEnv() };
  for (const k of hit.spec.requires_keys ?? []) {
    const v = keychainCommands.keychain_get({ key: `user.${k}` });
    if (typeof v === "string" && v) keys[k] = v;
  }
  const r = await runSandboxed(shell, argv, { cwd: hit.toolDir, stdin: JSON.stringify(args ?? {}), timeoutMs: Math.min(hit.spec.timeout_ms ?? 60_000, 10 * 60_000), extraEnv: keys });
  if ("refused" in r) return `Error: ${name} is ${r.refused}`;
  if (r.timedOut) return `(timed out)\n${clip(r.err, OUT_CAP)}`;
  if (r.code !== 0) return `exit ${r.code}\nstderr:\n${clip(r.err, OUT_CAP)}\nstdout:\n${clip(r.out, OUT_CAP)}`;
  return clip(r.out.trim(), READ_CAP) || "(no output)";
}
