// Shared pi tool factories, run in the existing outer sandbox, not an agent loop.
// The host imports definitions from the pinned package; no filesystem schemas or
// implementations are copied here. Policy and authority arrive only over stdin.
import { readFileSync, writeSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { guardToolCall, isUnder, realish, resolveList, scrubEnv, shq } from "./policy.mjs";

export async function execute(input, signal, onUpdate) {
  const { modulePath, cwd, name, args, home, denyRead, denyWrite, root, shell, env, defaultTimeout = 1800 } = input;
  const policy = { cwd, home, denyRead: resolveList(denyRead, home), denyWrite: resolveList(denyWrite, home) };
  const why = guardToolCall(name, args, policy);
  if (why) throw new Error(why);
  if (root) {
    if (name === "bash") throw new Error("External shell access is not authorized.");
    const p = realish(args.path ?? ".", cwd, home);
    if (!isUnder(p, realish(root, cwd, home))) throw new Error("Path is outside the explicitly bound vault.");
  }
  const pi = await import(pathToFileURL(modulePath).href);
  const tools = pi.createAllToolDefinitions(cwd, {
    bash: { spawnHook: ({ command, cwd, env: inherited }) => ({
      command: shell?.length ? `${shell.map(shq).join(" ")} bash -c ${shq(command)}` : command,
      cwd, env: { ...scrubEnv(inherited), ...env },
    }) },
  });
  const tool = tools[name];
  if (!tool || name === "powershell") throw new Error("Tool unavailable.");
  const params = { ...args };
  if (name === "bash") {
    const t = Number(params.timeout);
    params.timeout = Number.isFinite(t) && t > 0 ? Math.min(t, 14400) : Math.min(defaultTimeout, 14400);
  }
  return tool.execute("mcp-filesystem", params, signal, onUpdate);
}

if (process.argv[2] === "--execute") {
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  // Blocking writes backpressure the short-lived executor instead of retaining
  // an unbounded queue of cumulative previews behind a slow MCP consumer.
  const frame = (value) => {
    const data = Buffer.from(JSON.stringify(value) + "\n");
    let offset = 0;
    while (offset < data.length) offset += writeSync(1, data, offset);
  };
  try {
    const input = JSON.parse(readFileSync(0, "utf8"));
    const result = await execute(input, controller.signal, input.progress ? (update) => {
      if (!controller.signal.aborted) frame({ type: "update", text: (update.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n") });
    } : undefined);
    frame({ type: "final", ok: true, result });
  } catch (error) {
    frame({ type: "final", ok: false, error: error instanceof Error ? error.message : "Tool failed" });
  }
}
