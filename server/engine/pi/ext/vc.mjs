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
//  - vault-chat's tools (AskUser, ScheduleWake, StartJob, …) are registered from
//    $VC_PI_TOOLS and answered by the host over the extension-UI channel
//    (`editor` titled "vc:host-call", value = JSON);
//  - the ledger: OpenRouter's generation id (x-generation-id) and the cost it
//    reports in the stream go into the session as `vc-cost` entries (the host
//    sees them live as `entry_appended`);
//  - the "you" layer (VC_PI_YOU=1: conversations and Ctrl+K / Ctrl+L): before
//    each prompt the host is asked what Carl did since this session last saw
//    it, and pi stores and sends it as a `vc-you` custom message;
//  - Gemini requests get cache_control markers;
//  - the `subagent` tool (subagent.mjs) for a parent, when the host enables it.
import { closeSync, readFileSync } from "node:fs";
import { Type } from "typebox";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerSubagentTool } from "./subagent.mjs";
import { registerPdfParts } from "./pdf.mjs";
import { CLEAR_TYPE, VOICE_TYPE, YOU_TYPE, addCacheMarkers, memoryCapNote, costFromStreamEvent, guardToolCall, resolveList, scrubEnv, shq, toTypebox, voiceLineContent, youSince } from "./policy.mjs";

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
  // The keys Carl added to vault-chat are the agent's: asked of the host before each
  // command (so a key synced since is there), passed only into the command's env.
  let keyEnv = {};
  const bash = createBashToolDefinition(process.cwd(), {
    spawnHook: ({ command, cwd, env }) => {
      const clean = { ...scrubEnv(env), ...keyEnv };
      if (!Array.isArray(wrap) || !wrap.length) return { command, cwd, env: clean };
      return { command: `${wrap.map(shq).join(" ")} bash -c ${shq(command)}`, cwd, env: clean };
    },
  });
  pi.registerTool({
    ...bash,
    async execute(id, params, signal, onUpdate, ctx) {
      try {
        const v = await ctx.ui.editor("vc:host-call", JSON.stringify({ tool: "__env", args: {} }));
        const got = json(v, {});
        keyEnv = got && typeof got.env === "object" && got.env ? got.env : {};
      } catch {
        /* no host answer: the command runs without keys */
      }
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

  // ---- memory near its cap: the write's own result says so (Claude Code's near-cap reminder) ----
  pi.on("tool_result", async (event, ctx) => {
    const note = memoryCapNote(event.toolName, event.input, ctx?.cwd || process.cwd(), (p) => readFileSync(p, "utf8"));
    if (!note || event.isError) return undefined;
    return { content: [...(event.content ?? []), { type: "text", text: note }] };
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

  // ---- PdfPages: the asked pages go to the model as a native PDF part (pdf.mjs) ------
  registerPdfParts(pi);

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
  pi.on("agent_settled", flush);

  // ---- the "you" layer: what Carl just did on his other surfaces ----------------------
  // Each prompt (a conversation's turn, a Ctrl+K / Ctrl+L request): ask the box for the
  // layer since this session last saw it (the `until` of its last vc-you message; a
  // fork carries its parent's), and hand it to pi as before_agent_start's custom
  // message: pi stores it in the session (after the user message, as a custom_message
  // entry the transcript does not show) and sends it to the model with this turn, and
  // its compaction summarises it like any other message. Nothing new: no message.
  if (E.VC_PI_YOU === "1") {
    pi.on("before_agent_start", async (_event, ctx) => {
      let since = null;
      try {
        since = youSince(ctx.sessionManager.getBranch());
      } catch {
        since = null;
      }
      let v;
      try {
        v = await Promise.race([
          ctx.ui.editor("vc:host-call", JSON.stringify({ tool: "__you", args: { since } })),
          new Promise((r) => setTimeout(() => r(undefined), 10_000)),
        ]);
      } catch {
        return undefined;
      }
      const r = json(v, null);
      if (!r || typeof r.text !== "string" || !r.text.trim() || !Number.isFinite(Number(r.until))) return undefined;
      return { message: { customType: YOU_TYPE, content: r.text, display: false, details: { until: Number(r.until), since } } };
    });
  }

  // ---- vault-chat's own lines in the transcript (a notice, a line, a divider) ---------
  // pi's custom entries (not in the model's context), appended by pi itself so the
  // session's tree stays pi's: the host sends `/vc-note {json}` while pi has the session.
  // A line said on a voice call (`voice: true`) is a custom MESSAGE instead: in the model's
  // context, so this conversation's agent hears what was said by voice (pi's sendMessage;
  // never a turn of its own, and held to the end of a running turn by pi itself).
  pi.registerCommand("vc-note", {
    description: "vault-chat: append a vc-note entry (or a voice line) to this session",
    handler: async (args) => {
      const d = json(String(args ?? "").trim(), null);
      if (!d || typeof d !== "object" || typeof d.kind !== "string") return;
      // Clear: the agent is told (in its context, never shown); no turn of its own.
      if (d.kind === "clear") pi.sendMessage({ customType: CLEAR_TYPE, content: String(d.text ?? ""), display: false, details: { at: d.at } }, { triggerTurn: false });
      else if (d.voice === true && d.kind === "line") pi.sendMessage({ customType: VOICE_TYPE, content: voiceLineContent(d), display: true, details: d }, { triggerTurn: false });
      else pi.appendEntry("vc-note", d);
    },
  });
}
