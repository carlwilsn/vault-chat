// vault-chat's extension for pi (loaded with `-e`, through jiti). It is the
// pi side of server/engine/pi: it never sees a conversation file; everything
// that touches vault-chat state is a blocking host call to the server.
//
//  - the OpenRouter key arrives on fd 3 (never env/argv) and is set as a
//    runtime key in-process (a TypeScript-private API: pi is pinned);
//  - `bash` is replaced by one whose env is scrubbed and whose every command
//    runs in bubblewrap with the key store hidden and its own pid namespace,
//    with a default timeout;
//  - a path guard keeps pi's own read/write/edit/grep/find/ls (which run in
//    this process) out of the key store and off the server's state;
//  - vault-chat's tools (AskUser, ScheduleWake, Done, …) are registered from
//    $VC_PI_TOOLS and answered by the host over the extension-UI channel
//    (`editor` titled "vc:host-call", value = JSON);
//  - the ledger: OpenRouter's generation id (x-generation-id) and the cost it
//    reports in the stream go into the session as `vc-cost` entries (the host
//    sees them live as `entry_appended`);
//  - Gemini requests get cache_control markers;
//  - the `subagent` tool (subagent.mjs) for a parent, when the host enables it.
import { closeSync, readFileSync } from "node:fs";
import { Type } from "typebox";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerSubagentTool } from "./subagent.mjs";
import { addCacheMarkers, costFromStreamEvent, guardToolCall, resolveList, scrubEnv, shq, toTypebox } from "./policy.mjs";

const E = process.env;
const HOME = E.HOME || "/";

function readKeyOnce() {
  const g = globalThis;
  if (g.__vcKeyRead) return g.__vcKey ?? null;
  g.__vcKeyRead = true;
  const fd = Number(E.VC_KEY_FD);
  if (!Number.isInteger(fd) || fd < 3) return null;
  let key = null;
  try {
    key = readFileSync(fd, "utf8").trim() || null;
  } catch {
    key = null;
  }
  try {
    closeSync(fd);
  } catch {
    /* already closed */
  }
  g.__vcKey = key;
  return key;
}

const json = (s, d) => {
  try {
    return s ? JSON.parse(s) : d;
  } catch {
    return d;
  }
};

export default function vaultChat(pi) {
  const key = readKeyOnce();
  if (key) {
    pi.on("session_start", async (_e, ctx) => {
      await ctx.modelRegistry.runtime.setRuntimeApiKey("openrouter", key);
    });
  }

  // ---- bash: scrubbed env, bubblewrap, default timeout -------------------------------
  const wrap = json(E.VC_PI_SHELL_WRAP, null); // argv prefix ending in "--", or null
  const defTimeout = Number(E.VC_PI_SHELL_TIMEOUT_S) || 1800;
  const maxTimeout = Number(E.VC_PI_SHELL_MAX_TIMEOUT_S) || 4 * 3600;
  const bash = createBashToolDefinition(process.cwd(), {
    spawnHook: ({ command, cwd, env }) => {
      const clean = scrubEnv(env);
      if (!Array.isArray(wrap) || !wrap.length) return { command, cwd, env: clean };
      return { command: `${wrap.map(shq).join(" ")} bash -c ${shq(command)}`, cwd, env: clean };
    },
  });
  pi.registerTool({
    ...bash,
    async execute(id, params, signal, onUpdate, ctx) {
      const p = { ...params };
      const t = Number(p.timeout);
      p.timeout = Number.isFinite(t) && t > 0 ? Math.min(t, maxTimeout) : defTimeout;
      return bash.execute(id, p, signal, onUpdate, ctx);
    },
  });

  // ---- path guard for the in-process tools ------------------------------------------
  const denyRead = resolveList(json(E.VC_PI_DENY_READ, []), HOME);
  const denyWrite = resolveList(json(E.VC_PI_DENY_WRITE, []), HOME);
  pi.on("tool_call", async (event, ctx) => {
    const why = guardToolCall(event.toolName, event.input, { cwd: ctx?.cwd || process.cwd(), home: HOME, denyRead, denyWrite });
    return why ? { block: true, reason: why } : undefined;
  });

  // ---- vault-chat's tools, answered by the host --------------------------------------
  const specs = json(E.VC_PI_TOOLS ? readFileSync(E.VC_PI_TOOLS, "utf8") : "", []);
  for (const s of specs) {
    if (!s || typeof s.name !== "string") continue;
    pi.registerTool({
      name: s.name,
      label: s.name,
      description: String(s.description ?? s.name),
      parameters: toTypebox(Type, s.inputSchema ?? { type: "object", properties: {} }),
      ...(s.name === "AskUser" ? { executionMode: "sequential" } : {}),
      async execute(toolCallId, params, _signal, _onUpdate, ctx) {
        const v = await ctx.ui.editor("vc:host-call", JSON.stringify({ tool: s.name, args: params ?? {}, toolCallId }));
        if (v === undefined) return { content: [{ type: "text", text: `${s.name}: vault-chat did not answer.` }], details: undefined, isError: true };
        const r = json(v, { text: String(v) });
        return { content: [{ type: "text", text: String(r.text ?? "") }], details: undefined, ...(r.isError ? { isError: true } : {}) };
      },
    });
  }

  // ---- subagents (the parent only; children never get this tool) ----------------------
  if (E.VC_PI_SUBAGENTS === "1") registerSubagentTool(pi);

  // ---- the ledger: OpenRouter's own numbers, per model call ---------------------------
  let pending = null;
  const flush = () => {
    const p = pending;
    pending = null;
    if (!p || (!p.genId && p.cost === null)) return;
    try {
      pi.appendEntry("vc-cost", { genId: p.genId, cost: p.cost, model: p.model, at: Date.now() });
    } catch {
      /* the host falls back to pi's own usage */
    }
  };
  const cacheMode = E.VC_PI_GEMINI_CACHE === "0" ? null : E.VC_PI_GEMINI_CACHE === "last" ? "last" : "system";
  pi.on("before_provider_request", (event) => {
    flush();
    pending = { genId: null, cost: null, model: String(event?.payload?.model ?? "") };
    return cacheMode ? addCacheMarkers(event?.payload, cacheMode) : undefined;
  });
  pi.on("after_provider_response", (event) => {
    const h = event?.headers ?? {};
    const id = h["x-generation-id"] ?? h["X-Generation-Id"];
    if (pending && typeof id === "string" && id) pending.genId = id;
  });
  pi.on("provider_stream_event", (event) => {
    if (!pending) return;
    const c = costFromStreamEvent(event?.data);
    if (!c) return;
    pending.cost = c.cost;
    if (!pending.genId && c.id && c.id.startsWith("gen-")) pending.genId = c.id;
  });
  pi.on("message_end", (event) => {
    if (event?.message?.role === "assistant") flush();
  });
  pi.on("agent_settled", () => flush());
}
