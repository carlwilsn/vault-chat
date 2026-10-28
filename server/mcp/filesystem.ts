// Adapt the installed, pinned pi factories. The same definitions serve native
// pi and independent MCP clients; execution stays inside pi's existing sandbox.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ToolSpec } from "../engine/pi/backend";
import type { BoundTools } from "./tools";

export const FILE_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls"];
export const CALL_WRITE_REASON = "Not on a live call: you don't edit files yourself while a voice call is live. Call Delegate {title, task, expect} now with this change — the worker makes it and checks it.";
export type FilesystemOptions = {
  cli: string; node: string; script: string; cwd: string; home: string;
  outer: string[] | null; shell: string[] | null;
  denyRead: string[]; denyWrite: string[];
  allowed: string[]; root?: string;
  env: () => Record<string, string>;
  fileWrite: () => Promise<boolean>;
};

export async function filesystemBinding(o: FilesystemOptions): Promise<BoundTools> {
  if (o.root && !o.outer) throw new Error("External filesystem requires the installed sandbox; unsafe mode is not external authority.");
  const modulePath = join(dirname(o.cli), "../core/tools/index.js");
  // Runtime import: pi is installed independently of the single-file server.
  const pi = await import(/* @vite-ignore */ pathToFileURL(modulePath).href);
  const definitions = pi.createAllToolDefinitions(o.cwd);
  const policy = await import(/* @vite-ignore */ pathToFileURL(join(dirname(o.script), "policy.mjs")).href);
  const allowed = o.allowed.filter((n) => FILE_TOOLS.includes(n) && !(o.root && n === "bash"));
  const specs: ToolSpec[] = allowed.map((name) => ({
    type: "function", name, description: definitions[name].description,
    inputSchema: definitions[name].parameters,
    readOnly: !["write", "edit", "bash"].includes(name),
  }));
  return { specs, call: async (name, args, context) => {
    if (!allowed.includes(name)) return { ok: false, text: `Tool unavailable in this loadout: ${name}` };
    // Bash is also denied to the talker: otherwise it could write around Delegate.
    if (["write", "edit", "bash"].includes(name) && !await o.fileWrite()) return { ok: false, text: CALL_WRITE_REASON };
    context.signal.throwIfAborted();
    const argv = [o.node, o.script, "--execute"];
    const command = o.outer ? [...o.outer, ...argv] : argv;
    const run = () => new Promise<any>((resolve, reject) => {
      context.signal.throwIfAborted();
      const child = spawn(command[0]!, command.slice(1), {
        cwd: o.cwd, detached: true, stdio: ["pipe", "pipe", "pipe"],
        // No server credentials/config reach the process. Authorized command
        // keys, if any, are sent only on stdin and only for bash.
        env: { PATH: process.env.PATH, HOME: o.home },
      });
      let output = "";
      const kill = () => { try { if (process.platform === "win32") child.kill("SIGKILL"); else process.kill(-child.pid!, "SIGKILL"); } catch { /* exited */ } };
      const stop = () => {
        // Let pi's mature bash operations cancel their own detached command
        // group too (important in explicitly unsafe native test mode).
        child.kill("SIGTERM");
        const fallback = setTimeout(kill, 2000); fallback.unref();
        child.once("close", () => clearTimeout(fallback));
      };
      const abort = () => { stop(); reject(new Error("Operation aborted")); };
      context.signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => { stop(); reject(new Error("Filesystem tool timed out")); }, 14_410_000);
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
        if (output.length > 32 * 1024 * 1024) { stop(); reject(new Error("Tool result exceeds transport budget")); }
      });
      child.stderr.resume(); // Never return process diagnostics containing ambient data.
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer); context.signal.removeEventListener("abort", abort);
        try { if (code !== 0) throw new Error("Sandboxed filesystem process failed"); resolve(JSON.parse(output)); }
        catch (error) { reject(error); }
      });
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify({
        modulePath, cwd: o.cwd, name, args, home: o.home,
        denyRead: o.denyRead, denyWrite: o.denyWrite, root: o.root,
        shell: o.shell, defaultTimeout: Number(process.env.VC_PI_SHELL_TIMEOUT_S) || 1800,
        env: name === "bash" ? o.env() : {},
      }));
    });
    // Keep pi's mature per-file mutation queue across MCP clients/processes,
    // not one short-lived queue per sandbox executor.
    const result: any = ["write", "edit"].includes(name)
      ? await pi.withFileMutationQueue(policy.realish(args.path, o.cwd, o.home), run)
      : await run();
    if (!result.ok) return { ok: false, text: result.error };
    const content = result.result.content ?? [];
    return {
      ok: !result.result.isError,
      text: content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n"),
      images: content.filter((c: any) => c.type === "image").map((c: any) => ({ data: c.data, mimeType: c.mimeType })),
    };
  } };
}
